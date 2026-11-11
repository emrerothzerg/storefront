import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase, withTransaction } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { COUPON_INVALID_MESSAGE, createCouponService, describeCoupon, type CouponService } from "./coupon-service";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";

let db: Database;
let svc: CouponService;

function addCoupon(d: Database, code: string, fields: Partial<{ kind: string; value: number; min: number; maxUses: number | null; used: number; starts: string | null; expires: string | null; active: number; promoted: number }> = {}): void {
  d.query(
    "INSERT INTO coupons (code, kind, value, min_subtotal_cents, max_uses, used_count, starts_at, expires_at, is_active, promoted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    code, fields.kind ?? "fixed", fields.value ?? 100, fields.min ?? 0, fields.maxUses ?? null, fields.used ?? 0,
    fields.starts ?? null, fields.expires ?? null, fields.active ?? 1, fields.promoted ?? 0,
  );
}

function usedCount(d: Database, code: string): number {
  return d.query<{ used_count: number }, [string]>("SELECT used_count FROM coupons WHERE code = ?").get(code)?.used_count ?? -1;
}
function redemptions(d: Database, code: string): number {
  return d.query<{ n: number }, [string]>("SELECT count(*) AS n FROM coupon_redemptions WHERE coupon_code = ?").get(code)?.n ?? -1;
}

function codeOf(r: ReturnType<CouponService["validate"]>): string {
  return r.ok ? "OK" : r.error.code;
}

beforeEach(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  svc = createCouponService({ db, now: () => NOW });
});

describe("validate", () => {
  test("seed coupons", () => {
    expect(svc.validate("WELCOME10", 1000, null)).toEqual({
      ok: true,
      value: { code: "WELCOME10", kind: "percent", value: 10, promoted: true, description: "10% off" },
    });
    expect(svc.validate("SAVE5", 2500, null)).toEqual({
      ok: true,
      value: { code: "SAVE5", kind: "fixed", value: 500, promoted: false, description: "$5 off orders of $25 or more" },
    });
    const fs = svc.validate("FREESHIP", 2000, S1);
    expect(fs.ok && fs.value.description).toBe("Free shipping on orders of $20 or more");
  });

  test("case-insensitive and trimmed", () => {
    for (const raw of ["welcome10", "  WeLcOmE10 ", "\tWELCOME10\n"]) {
      const r = svc.validate(raw, 1000, null);
      expect(r.ok && r.value.code).toBe("WELCOME10");
    }
  });

  test("bad charset/length -> COUPON_INVALID without a DB lookup", () => {
    let queries = 0;
    const spyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query" || prop === "prepare") queries++;
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const spySvc = createCouponService({ db: spyDb, now: () => NOW });
    for (const bad of ["", "   ", "WEL COME", "SAVE5;DROP", "x".repeat(33), "ÄBC", "﻿WELCOME10", 42, null, undefined, {}]) {
      const r = spySvc.validate(bad, 1000, null);
      expect(r).toEqual({ ok: false, error: { code: "COUPON_INVALID", message: COUPON_INVALID_MESSAGE } });
    }
    expect(queries).toBe(0);
  });

  test("unknown and inactive codes: identical COUPON_INVALID (no enumeration)", () => {
    addCoupon(db, "OFF1", { active: 0 });
    const expected = { ok: false as const, error: { code: "COUPON_INVALID" as const, message: COUPON_INVALID_MESSAGE } };
    expect(svc.validate("NOPE123", 1000, null)).toEqual(expected);
    expect(svc.validate("OFF1", 1000, null)).toEqual(expected);
    expect(svc.validate("WEL%", 1000, null)).toEqual(expected);
  });

  test("date window: before starts_at / after expires_at -> COUPON_EXPIRED; boundaries inclusive", () => {
    expect(codeOf(svc.validate("EXPIRED10", 1000, null))).toBe("COUPON_EXPIRED");
    addCoupon(db, "SOON", { starts: "2026-11-08T00:00:00.000Z" });
    expect(codeOf(svc.validate("SOON", 1000, null))).toBe("COUPON_EXPIRED");
    expect(codeOf(svc.validate("SOON", 1000, null, Date.parse("2026-11-08T00:00:00.000Z")))).toBe("OK");
    addCoupon(db, "ENDS", { expires: "2026-11-07T12:00:00.000Z" });
    expect(codeOf(svc.validate("ENDS", 1000, null))).toBe("OK");
    expect(codeOf(svc.validate("ENDS", 1000, null, NOW + 1))).toBe("COUPON_EXPIRED");
    // Injected clock per call overrides the service clock.
    expect(codeOf(svc.validate("EXPIRED10", 1000, null, Date.parse("2025-06-01T00:00:00.000Z")))).toBe("OK");
  });

  test("corrupt dates are COUPON_INVALID", () => {
    addCoupon(db, "BADDATE", { expires: "soon-ish" });
    expect(codeOf(svc.validate("BADDATE", 1000, null))).toBe("COUPON_INVALID");
  });

  test("min subtotal -> COUPON_MIN_SUBTOTAL with shortfall", () => {
    const r = svc.validate("SAVE5", 2499, null);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("COUPON_MIN_SUBTOTAL");
      expect(r.error.details).toEqual({ shortfallCents: 1, minSubtotalCents: 2500 });
    }
    const zero = svc.validate("FREESHIP", 0, null);
    expect(!zero.ok && zero.error.details?.shortfallCents).toBe(2000);
  });

  test("exhausted -> COUPON_EXHAUSTED", () => {
    expect(codeOf(svc.validate("MAXED5", 1000, null))).toBe("COUPON_EXHAUSTED");
    expect(codeOf(svc.validate("MAXED5", 1000, S1))).toBe("COUPON_EXHAUSTED");
  });

  test("session already redeemed -> COUPON_USED; other sessions and null are fine", () => {
    expect(svc.recordRedemption(db, "WELCOME10", S1, "order-1")).toEqual({ ok: true, value: undefined });
    expect(codeOf(svc.validate("welcome10", 1000, S1))).toBe("COUPON_USED");
    expect(codeOf(svc.validate("WELCOME10", 1000, S2))).toBe("OK");
    expect(codeOf(svc.validate("WELCOME10", 1000, null))).toBe("OK");
    // Invalid session strings are treated as null (no per-session check, no error).
    expect(codeOf(svc.validate("WELCOME10", 1000, "not-a-uuid"))).toBe("OK");
    expect(codeOf(svc.validate("WELCOME10", 1000, `${S1} `))).toBe("OK");
  });

  test("error precedence: expired before exhausted before used before min subtotal", () => {
    addCoupon(db, "ALLBAD", { min: 5000, maxUses: 1, used: 1, expires: "2026-01-01T00:00:00.000Z" });
    expect(codeOf(svc.validate("ALLBAD", 10, S1))).toBe("COUPON_EXPIRED");
    addCoupon(db, "USEDMIN", { min: 5000, maxUses: 5 });
    expect(svc.recordRedemption(db, "USEDMIN", S1, "o").ok).toBe(true);
    expect(codeOf(svc.validate("USEDMIN", 10, S1))).toBe("COUPON_USED");
    expect(codeOf(svc.validate("USEDMIN", 10, S2))).toBe("COUPON_MIN_SUBTOTAL");
  });

  test("invalid subtotal -> INVALID_INPUT / MONEY_OVERFLOW", () => {
    expect(codeOf(svc.validate("WELCOME10", -1, null))).toBe("INVALID_INPUT");
    expect(codeOf(svc.validate("WELCOME10", 10.5, null))).toBe("INVALID_INPUT");
    expect(codeOf(svc.validate("WELCOME10", Number.MAX_SAFE_INTEGER + 1, null))).toBe("MONEY_OVERFLOW");
    expect(codeOf(svc.validate("WELCOME10", Number.MAX_SAFE_INTEGER, null))).toBe("OK");
  });

  test("default clock is Date.now when no now is injected", () => {
    const real = createCouponService({ db });
    expect(codeOf(real.validate("EXPIRED10", 1000, null))).toBe(Date.now() > Date.parse("2025-12-31T23:59:59.000Z") ? "COUPON_EXPIRED" : "OK");
  });
});

describe("listPromoted", () => {
  test("seed: WELCOME10 and FREESHIP, ordered by code", () => {
    expect(svc.listPromoted().map((c) => c.code)).toEqual(["FREESHIP", "WELCOME10"]);
  });

  test("excludes inactive, out-of-window and exhausted promoted coupons", () => {
    addCoupon(db, "P_OFF", { promoted: 1, active: 0 });
    addCoupon(db, "P_LATER", { promoted: 1, starts: "2027-01-01T00:00:00.000Z" });
    addCoupon(db, "P_FULL", { promoted: 1, maxUses: 2, used: 2 });
    addCoupon(db, "P_OK", { promoted: 1, kind: "percent", value: 15 });
    expect(svc.listPromoted().map((c) => c.code)).toEqual(["FREESHIP", "P_OK", "WELCOME10"]);
    expect(svc.listPromoted(Date.parse("2027-02-01T00:00:00.000Z")).map((c) => c.code)).toContain("P_LATER");
  });
});

describe("listPromoted conditions (T96 additive fields)", () => {
  test("seed: FREESHIP surfaces its minimum, WELCOME10 has none; neither expires", () => {
    const [freeship, welcome] = svc.listPromoted();
    expect(freeship).toEqual({
      code: "FREESHIP",
      kind: "free_shipping",
      value: 0,
      promoted: true,
      description: "Free shipping on orders of $20 or more",
      minSubtotalCents: 2000,
      expiresAt: null,
    });
    expect(welcome?.minSubtotalCents).toBeNull();
    expect(welcome?.expiresAt).toBeNull();
  });

  test("expiry is surfaced as ISO UTC; a zoned offset is normalised to Z", () => {
    addCoupon(db, "P_EXP", { promoted: 1, min: 1500, expires: "2026-11-30T23:59:59.000Z" });
    addCoupon(db, "P_OFFSET", { promoted: 1, expires: "2026-12-01T10:00:00+10:00" });
    const byCode = new Map(svc.listPromoted().map((c) => [c.code, c]));
    expect(byCode.get("P_EXP")).toMatchObject({ minSubtotalCents: 1500, expiresAt: "2026-11-30T23:59:59.000Z" });
    expect(byCode.get("P_OFFSET")).toMatchObject({ minSubtotalCents: null, expiresAt: "2026-12-01T00:00:00.000Z" });
  });

  test("validate() keeps the plain ValidatedCoupon shape", () => {
    addCoupon(db, "P_EXP", { promoted: 1, min: 1500, expires: "2026-11-30T23:59:59.000Z" });
    const r = svc.validate("P_EXP", 2000, null);
    expect(r.ok && Object.keys(r.value).sort()).toEqual(["code", "description", "kind", "promoted", "value"]);
  });
});

describe("recordRedemption / releaseRedemption", () => {
  test("records once per session and increments used_count", () => {
    addCoupon(db, "TWICE", { maxUses: 2 });
    expect(svc.recordRedemption(db, " twice ", S1, "o1").ok).toBe(true);
    expect(usedCount(db, "TWICE")).toBe(1);
    const again = svc.recordRedemption(db, "TWICE", S1, "o2");
    expect(!again.ok && again.error.code).toBe("COUPON_USED");
    expect(usedCount(db, "TWICE")).toBe(1);
    expect(svc.recordRedemption(db, "TWICE", S2, "o3").ok).toBe(true);
    expect(usedCount(db, "TWICE")).toBe(2);
    const row = db.query<{ order_id: string }, [string]>("SELECT order_id FROM coupon_redemptions WHERE session_id = ?").get(S2);
    expect(row?.order_id).toBe("o3");
  });

  test("exhausted -> COUPON_EXHAUSTED and nothing written", () => {
    const r = svc.recordRedemption(db, "MAXED5", S1, "o1");
    expect(!r.ok && r.error.code).toBe("COUPON_EXHAUSTED");
    expect(redemptions(db, "MAXED5")).toBe(0);
    expect(usedCount(db, "MAXED5")).toBe(1);
  });

  test("input validation", () => {
    expect(svc.recordRedemption(db, "NOPE", S1, "o").ok ? "OK" : "ERR").toBe("ERR");
    const unknown = svc.recordRedemption(db, "NOPE", S1, "o");
    expect(!unknown.ok && unknown.error.code).toBe("COUPON_INVALID");
    const badCode = svc.recordRedemption(db, "BAD CODE", S1, "o");
    expect(!badCode.ok && badCode.error.code).toBe("COUPON_INVALID");
    addCoupon(db, "INACTIVE", { active: 0 });
    const inactive = svc.recordRedemption(db, "INACTIVE", S1, "o");
    expect(!inactive.ok && inactive.error.code).toBe("COUPON_INVALID");
    const badSession = svc.recordRedemption(db, "WELCOME10", "nope", "o");
    expect(!badSession.ok && badSession.error.code).toBe("INVALID_INPUT");
    const badOrder = svc.recordRedemption(db, "WELCOME10", S1, "");
    expect(!badOrder.ok && badOrder.error.code).toBe("INVALID_INPUT");
    expect(redemptions(db, "WELCOME10")).toBe(0);
  });

  test("participates in the caller's transaction: caller rollback undoes it", () => {
    addCoupon(db, "ROLL", { maxUses: 1 });
    expect(() =>
      withTransaction(db, (tx) => {
        expect(svc.recordRedemption(tx, "ROLL", S1, "o1").ok).toBe(true);
        throw new Error("payment failed");
      }),
    ).toThrow("payment failed");
    expect(usedCount(db, "ROLL")).toBe(0);
    expect(redemptions(db, "ROLL")).toBe(0);
  });

  test("a failed redemption inside a caller transaction leaves the caller's other writes intact", () => {
    withTransaction(db, (tx) => {
      tx.run("UPDATE coupons SET promoted = 1 WHERE code = 'SAVE5'");
      expect(svc.recordRedemption(tx, "MAXED5", S1, "o1").ok).toBe(false);
    });
    expect(db.query<{ promoted: number }, []>("SELECT promoted FROM coupons WHERE code = 'SAVE5'").get()?.promoted).toBe(1);
  });

  test("release deletes the redemption and decrements, never below 0; idempotent", () => {
    addCoupon(db, "REL", { maxUses: 1 });
    expect(svc.recordRedemption(db, "REL", S1, "o1").ok).toBe(true);
    expect(codeOf(svc.validate("REL", 100, S2))).toBe("COUPON_EXHAUSTED");
    svc.releaseRedemption(db, "rel", S1);
    expect(usedCount(db, "REL")).toBe(0);
    expect(redemptions(db, "REL")).toBe(0);
    svc.releaseRedemption(db, "REL", S1);
    expect(usedCount(db, "REL")).toBe(0);
    expect(codeOf(svc.validate("REL", 100, S1))).toBe("OK");
    expect(codeOf(svc.validate("REL", 100, S2))).toBe("OK");
  });

  test("release with no redemption does not decrement; invalid inputs are no-ops", () => {
    svc.releaseRedemption(db, "MAXED5", S1);
    expect(usedCount(db, "MAXED5")).toBe(1);
    // A redemption row exists but used_count is already 0 (manual data fix): stays 0.
    addCoupon(db, "ZERO", {});
    db.query("INSERT INTO coupon_redemptions (coupon_code, session_id) VALUES ('ZERO', ?)").run(S1);
    svc.releaseRedemption(db, "ZERO", S1);
    expect(usedCount(db, "ZERO")).toBe(0);
    expect(redemptions(db, "ZERO")).toBe(0);
    expect(() => svc.releaseRedemption(db, "BAD CODE", S1)).not.toThrow();
    expect(() => svc.releaseRedemption(db, "WELCOME10", "nope")).not.toThrow();
  });
});

describe("concurrency: last use of a max_uses coupon", () => {
  test("validate-then-record race in separate transactions: exactly one success", () => {
    addCoupon(db, "LAST1", { maxUses: 1 });
    // Both shoppers pass validation before either places the order (TOCTOU window).
    expect(codeOf(svc.validate("LAST1", 1000, S1))).toBe("OK");
    expect(codeOf(svc.validate("LAST1", 1000, S2))).toBe("OK");
    const results = [S1, S2].map((session, i) =>
      withTransaction(db, (tx) => svc.recordRedemption(tx, "LAST1", session, `order-${i}`)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    expect(loser !== undefined && !loser.ok && loser.error.code).toBe("COUPON_EXHAUSTED");
    expect(usedCount(db, "LAST1")).toBe(1);
    expect(redemptions(db, "LAST1")).toBe(1);
  });

  describe("two connections to one shared in-memory database", () => {
    let a: Database;
    let b: Database;
    afterEach(() => {
      a.close();
      b.close();
    });

    test("the second writer is blocked while the first holds the order transaction, then gets COUPON_EXHAUSTED", () => {
      const uri = `file:pricing-race-${crypto.randomUUID()}?mode=memory&cache=shared`;
      a = new Database(uri, { strict: true });
      b = new Database(uri, { strict: true });
      runMigrations(a);
      seedDatabase(a);
      addCoupon(a, "LAST1", { maxUses: 1 });
      const svcA = createCouponService({ db: a, now: () => NOW });
      const svcB = createCouponService({ db: b, now: () => NOW });

      a.run("BEGIN IMMEDIATE");
      expect(svcA.recordRedemption(a, "LAST1", S1, "order-a").ok).toBe(true);
      // B cannot interleave a write while A's transaction is open.
      expect(() => withTransaction(b, (tx) => svcB.recordRedemption(tx, "LAST1", S2, "order-b"))).toThrow();
      a.run("COMMIT");

      const late = withTransaction(b, (tx) => svcB.recordRedemption(tx, "LAST1", S2, "order-b"));
      expect(!late.ok && late.error.code).toBe("COUPON_EXHAUSTED");
      expect(usedCount(b, "LAST1")).toBe(1);
      expect(redemptions(b, "LAST1")).toBe(1);
    });
  });
});

test("describeCoupon", () => {
  expect(describeCoupon("percent", 25, 0)).toBe("25% off");
  expect(describeCoupon("fixed", 1999, 0)).toBe("$19.99 off");
  expect(describeCoupon("free_shipping", 0, 0)).toBe("Free shipping");
  expect(describeCoupon("percent", 10, 5000)).toBe("10% off orders of $50 or more");
  // U15: whole dollars drop the cents; other amounts keep them.
  expect(describeCoupon("fixed", 500, 2550)).toBe("$5 off orders of $25.50 or more");
  expect(describeCoupon("fixed", 450, 2000)).toBe("$4.50 off orders of $20 or more");
  expect(describeCoupon("fixed", 100_000_00, 0)).toBe("$100,000 off");
});

describe("releaseRedemptionForOrder (D-T55-1)", () => {
  test("deletes only the row recorded for that order id; decrements only when a row was deleted", () => {
    addCoupon(db, "ONEORD", { maxUses: 10 });
    expect(svc.recordRedemption(db, "ONEORD", S1, "order-b").ok).toBe(true);
    expect(usedCount(db, "ONEORD")).toBe(1);
    // Another order of the same owner (e.g. a merged guest order whose row was dropped): no-op.
    svc.releaseRedemptionForOrder(db, "ONEORD", S1, "order-a");
    expect(redemptions(db, "ONEORD")).toBe(1);
    expect(usedCount(db, "ONEORD")).toBe(1);
    expect(codeOf(svc.validate("ONEORD", 100, S1))).toBe("COUPON_USED");
    // Right order but another owner: no-op.
    svc.releaseRedemptionForOrder(db, "ONEORD", S2, "order-b");
    expect(redemptions(db, "ONEORD")).toBe(1);
    expect(usedCount(db, "ONEORD")).toBe(1);
    // The matching order (code normalised): released once, idempotent.
    svc.releaseRedemptionForOrder(db, " oneord ", S1, "order-b");
    expect(redemptions(db, "ONEORD")).toBe(0);
    expect(usedCount(db, "ONEORD")).toBe(0);
    svc.releaseRedemptionForOrder(db, "ONEORD", S1, "order-b");
    expect(usedCount(db, "ONEORD")).toBe(0);
    expect(codeOf(svc.validate("ONEORD", 100, S1))).toBe("OK");
  });

  test("a legacy row with NULL order_id is never matched; used_count never below 0", () => {
    addCoupon(db, "NULLORD", {});
    db.query("INSERT INTO coupon_redemptions (coupon_code, session_id) VALUES ('NULLORD', ?)").run(S1);
    svc.releaseRedemptionForOrder(db, "NULLORD", S1, "order-x");
    expect(redemptions(db, "NULLORD")).toBe(1);
    addCoupon(db, "ZERO2", {});
    db.query("INSERT INTO coupon_redemptions (coupon_code, session_id, order_id) VALUES ('ZERO2', ?, 'o1')").run(S1);
    svc.releaseRedemptionForOrder(db, "ZERO2", S1, "o1");
    expect(redemptions(db, "ZERO2")).toBe(0);
    expect(usedCount(db, "ZERO2")).toBe(0);
  });

  test("invalid inputs are silent no-ops", () => {
    expect(svc.recordRedemption(db, "WELCOME10", S1, "o1").ok).toBe(true);
    for (const [code, owner, orderId] of [
      ["BAD CODE", S1, "o1"],
      ["WELCOME10", "nope", "o1"],
      ["WELCOME10", S1, ""],
      ["WELCOME10", S1, "x".repeat(129)],
      ["WELCOME10", S1, 42 as unknown as string],
    ] as const) {
      expect(() => svc.releaseRedemptionForOrder(db, code, owner, orderId)).not.toThrow();
    }
    expect(redemptions(db, "WELCOME10")).toBe(1);
    expect(usedCount(db, "WELCOME10")).toBe(1);
  });

  test("rolls back with the enclosing transaction", () => {
    expect(svc.recordRedemption(db, "WELCOME10", S1, "o1").ok).toBe(true);
    expect(() =>
      withTransaction(db, (tx) => {
        svc.releaseRedemptionForOrder(tx, "WELCOME10", S1, "o1");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(redemptions(db, "WELCOME10")).toBe(1);
    expect(usedCount(db, "WELCOME10")).toBe(1);
  });
});
