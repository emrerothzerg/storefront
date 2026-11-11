/**
 * QA adversarial tests for T38 (pricing service), src/server/pricing/**.
 * Owned by QA (QA-W1-T38). In-memory DBs only (`:memory:` or shared-cache
 * in-memory URIs); never touches ./data/.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, createDatabase, getDatabase, withTransaction } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import {
  COUPON_DESCRIPTION_CURRENCY,
  COUPON_INVALID_MESSAGE,
  createCouponService,
  describeCoupon,
  getCouponService,
  recordRedemption,
  releaseRedemption,
  type CouponService,
  type ValidatedCoupon,
} from "@/server/pricing/coupon-service";
import {
  MAX_DELIVERY_BUSINESS_DAYS,
  createShippingService,
  estimateDelivery,
  getShippingService,
  quoteFor,
  type ShippingQuote,
} from "@/server/pricing/shipping-service";
import { computeTotals, type TotalsInput } from "@/server/pricing/totals";
import type { ShippingMethod } from "@/lib/types";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const S1 = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const S2 = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
const MAX = Number.MAX_SAFE_INTEGER;
const PRICING_DIR = join(import.meta.dir, "../../../src/server/pricing");

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

function freshDb(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  open.push(db);
  return db;
}

function harness(): { db: Database; svc: CouponService } {
  const db = freshDb();
  return { db, svc: createCouponService({ db, now: () => NOW }) };
}

interface CouponFields {
  kind: string;
  value: number;
  min: number;
  maxUses: number | null;
  used: number;
  starts: string | null;
  expires: string | null;
  active: number;
  promoted: number;
}

function addCoupon(db: Database, code: string, f: Partial<CouponFields> = {}): void {
  db.query(
    "INSERT INTO coupons (code, kind, value, min_subtotal_cents, max_uses, used_count, starts_at, expires_at, is_active, promoted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    code,
    f.kind ?? "fixed",
    f.value ?? 100,
    f.min ?? 0,
    f.maxUses ?? null,
    f.used ?? 0,
    f.starts ?? null,
    f.expires ?? null,
    f.active ?? 1,
    f.promoted ?? 0,
  );
}

function usedCount(db: Database, code: string): number {
  return db.query<{ u: number }, [string]>("SELECT used_count AS u FROM coupons WHERE code = ?").get(code)?.u ?? -1;
}

function redemptionCount(db: Database, code: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_code = ?").get(code)?.n ?? -1;
}

function codeOf(r: { ok: true } | { ok: false; error: { code: string } }): string {
  return r.ok ? "OK" : r.error.code;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function coupon(kind: ValidatedCoupon["kind"], value: number): ValidatedCoupon {
  return { code: "X", kind, value, promoted: false, description: "" };
}

const STANDARD: ShippingMethod = {
  id: "standard",
  name: "Standard",
  description: "",
  priceCents: 499,
  freeOverCents: 3500,
  minDays: 5,
  maxDays: 8,
  sortOrder: 1,
  isActive: true,
};
const EXPRESS: ShippingMethod = { ...STANDARD, id: "express", priceCents: 999, freeOverCents: null, minDays: 2, maxDays: 3 };

/** Proxy over a Database that records every property touched (query, prepare, run, ...). */
function spyDb(target: Database): { db: Database; touched: string[] } {
  const touched: string[] = [];
  const db = new Proxy(target, {
    get(t, prop, receiver) {
      touched.push(String(prop));
      const v: unknown = Reflect.get(t, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { db, touched };
}

const HOSTILE_CODES: readonly unknown[] = [
  "",
  "   ",
  "x".repeat(10_000),
  "A".repeat(33),
  "WELCOME10".repeat(4),
  "' OR 1=1 --",
  "WELCOME10' --",
  "WELCOME10'; DROP TABLE coupons; --",
  "%",
  "WELCOME%",
  "WELCOME10\u0000",
  "WELCOME​10",
  "​WELCOME10",
  "WELCOME10﻿",
  "WELCOME10‮",
  "WELCOMEı0",
  "WELCOME1Ȯ",
  "ＷＥＬＣＯＭＥ１０",
  "WΕLCOME10", // Greek capital epsilon
  "WЕLCOME10", // Cyrillic Ie
  "wеlcome10",
  "ſave5",
  "SAVE 5",
  "SAVE\t5",
  "\u{1F600}",
  null,
  undefined,
  42,
  {},
  ["WELCOME10"],
  { toString: () => "WELCOME10" },
];

// ---------------------------------------------------------------------------
describe("criterion 1/5: discount math, BigInt oracle and integer exactness", () => {
  test("percent = floor(subtotal * pct / 100) over 2000 random cases (incl. huge subtotals); capped; total identity", () => {
    const rand = rng(0x7438);
    for (let i = 0; i < 2000; i++) {
      const bucket = i % 4;
      const subtotal =
        bucket === 0
          ? Math.floor(rand() * 10_000)
          : bucket === 1
            ? Math.floor(rand() * 10_000_000)
            : bucket === 2
              ? Math.floor(rand() * MAX)
              : MAX - Math.floor(rand() * 1000);
      const pct = 1 + Math.floor(rand() * 100);
      const withShipping = i % 2 === 0;
      const r = computeTotals({
        subtotalCents: subtotal,
        coupon: coupon("percent", pct),
        shipping: withShipping ? quoteFor(STANDARD, subtotal) : null,
      });
      const expectedDiscount = (BigInt(subtotal) * BigInt(pct)) / 100n;
      const expectedShipping = withShipping && subtotal < 3500 ? 499n : 0n;
      const expectedTotal = BigInt(subtotal) - expectedDiscount + expectedShipping;
      if (expectedTotal > BigInt(MAX)) {
        expect(codeOf(r)).toBe("MONEY_OVERFLOW");
        continue;
      }
      if (!r.ok) throw new Error(`case ${i}: ${subtotal} ${pct}% -> ${r.error.code}`);
      expect(BigInt(r.value.discountCents)).toBe(expectedDiscount);
      expect(r.value.discountCents).toBeLessThanOrEqual(subtotal);
      expect(BigInt(r.value.shippingCents)).toBe(expectedShipping);
      expect(BigInt(r.value.totalCents)).toBe(expectedTotal);
      expect(r.value.totalCents).toBe(r.value.subtotalCents - r.value.discountCents + r.value.shippingCents);
      expect(r.value.totalCents).toBeGreaterThanOrEqual(0);
      expect(Number.isSafeInteger(r.value.totalCents)).toBe(true);
    }
  });

  test("percent 100 at MAX_SAFE subtotal is exact (no float rounding); 1% of 99 floors to 0", () => {
    const full = computeTotals({ subtotalCents: MAX, coupon: coupon("percent", 100) });
    expect(full.ok && full.value).toMatchObject({ discountCents: MAX, totalCents: 0 });
    const tiny = computeTotals({ subtotalCents: 99, coupon: coupon("percent", 1) });
    expect(tiny.ok && tiny.value.discountCents).toBe(0);
    // Float math would give 9007199254740991 * 33 / 100 rounded; oracle is exact.
    const odd = computeTotals({ subtotalCents: MAX, coupon: coupon("percent", 33) });
    expect(odd.ok && BigInt(odd.value.discountCents)).toBe((BigInt(MAX) * 33n) / 100n);
  });

  test("fixed is capped at subtotal; total never negative (2000 random cases)", () => {
    const rand = rng(99);
    for (let i = 0; i < 2000; i++) {
      const subtotal = Math.floor(rand() * 20_000);
      const value = 1 + Math.floor(rand() * 40_000);
      const r = computeTotals({ subtotalCents: subtotal, coupon: coupon("fixed", value), shipping: quoteFor(EXPRESS, subtotal) });
      if (!r.ok) throw new Error(r.error.code);
      expect(r.value.discountCents).toBe(Math.min(value, subtotal));
      expect(r.value.totalCents).toBe(subtotal - Math.min(value, subtotal) + 999);
      expect(r.value.totalCents).toBeGreaterThanOrEqual(999);
    }
    const zero = computeTotals({ subtotalCents: 0, coupon: coupon("fixed", 500) });
    expect(zero.ok && zero.value).toEqual({ subtotalCents: 0, discountCents: 0, shippingCents: 0, totalCents: 0, amountToFreeShippingCents: null });
    expect(zero.ok && Object.is(zero.value.totalCents, -0)).toBe(false);
  });

  test("free_shipping: shipping 0, discount 0, amountToFree 0, on every method", () => {
    for (const m of [STANDARD, EXPRESS, { ...EXPRESS, id: "next_day", priceCents: 1999 }]) {
      for (const subtotal of [0, 1999, 2000, 3499, 3500, 100_000]) {
        const r = computeTotals({ subtotalCents: subtotal, coupon: coupon("free_shipping", 0), shipping: quoteFor(m, subtotal) });
        expect(r.ok && r.value).toEqual({
          subtotalCents: subtotal,
          discountCents: 0,
          shippingCents: 0,
          totalCents: subtotal,
          amountToFreeShippingCents: 0,
        });
      }
    }
  });

  test("end-to-end: validate() result feeds computeTotals for all seeded coupons", () => {
    const { db } = harness();
    const svc = createCouponService({ db, now: () => NOW });
    const ship = createShippingService({ db });
    const sub = 3000;
    const std = ship.quote("standard", sub);
    if (!std.ok) throw new Error("standard missing");
    const welcome = svc.validate("welcome10", sub, S1);
    const save = svc.validate(" save5 ", sub, S1);
    const free = svc.validate("FreeShip", sub, S1);
    if (!welcome.ok || !save.ok || !free.ok) throw new Error("seed coupons must validate");
    expect(computeTotals({ subtotalCents: sub, coupon: welcome.value, shipping: std.value })).toEqual({
      ok: true,
      value: { subtotalCents: 3000, discountCents: 300, shippingCents: 499, totalCents: 3199, amountToFreeShippingCents: 500 },
    });
    expect(computeTotals({ subtotalCents: sub, coupon: save.value, shipping: std.value })).toEqual({
      ok: true,
      value: { subtotalCents: 3000, discountCents: 500, shippingCents: 499, totalCents: 2999, amountToFreeShippingCents: 500 },
    });
    expect(computeTotals({ subtotalCents: sub, coupon: free.value, shipping: std.value })).toEqual({
      ok: true,
      value: { subtotalCents: 3000, discountCents: 0, shippingCents: 0, totalCents: 3000, amountToFreeShippingCents: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
describe("criterion 2: code normalisation, no-DB rejection, no enumeration", () => {
  test("trimmed and case-insensitive (incl. tabs/newlines/NBSP)", () => {
    const { svc } = harness();
    for (const raw of ["welcome10", "WeLcOmE10", "  WELCOME10  ", "\tWELCOME10\r\n", " welcome10 "]) {
      const r = svc.validate(raw, 1000, null);
      expect(r.ok && r.value.code).toBe("WELCOME10");
    }
  });

  test("invalid charset/length/type -> COUPON_INVALID with ZERO database property access (Proxy)", () => {
    const { db } = harness();
    const spy = spyDb(db);
    const svc = createCouponService({ db: spy.db, now: () => NOW });
    for (const raw of HOSTILE_CODES) {
      const r = svc.validate(raw, 1000, S1);
      expect(r).toEqual({ ok: false, error: { code: "COUPON_INVALID", message: COUPON_INVALID_MESSAGE } });
    }
    expect(spy.touched).toEqual([]);
    // Sanity: the spy does see a lookup for a well-formed code.
    expect(svc.validate("NOPE", 1000, S1).ok).toBe(false);
    expect(spy.touched).toContain("query");
    // LIKE wildcards are legal charset but never pattern-match (equality lookup).
    for (const raw of ["WELCOME_0", "WELCOM__0", "____"]) {
      expect(svc.validate(raw, 1000, S1)).toEqual({ ok: false, error: { code: "COUPON_INVALID", message: COUPON_INVALID_MESSAGE } });
    }
  });

  test("invalid subtotal is rejected before any DB access too", () => {
    const { db } = harness();
    const spy = spyDb(db);
    const svc = createCouponService({ db: spy.db, now: () => NOW });
    expect(codeOf(svc.validate("WELCOME10", -1, S1))).toBe("INVALID_INPUT");
    expect(codeOf(svc.validate("WELCOME10", 1.5, S1))).toBe("INVALID_INPUT");
    expect(codeOf(svc.validate("WELCOME10", Number.NaN, S1))).toBe("INVALID_INPUT");
    expect(codeOf(svc.validate("WELCOME10", "1000" as unknown as number, S1))).toBe("INVALID_INPUT");
    expect(codeOf(svc.validate("WELCOME10", MAX + 1, S1))).toBe("MONEY_OVERFLOW");
    expect(codeOf(svc.validate("WELCOME10", Infinity, S1))).toBe("MONEY_OVERFLOW");
    expect(spy.touched).toEqual([]);
  });

  test("unknown, inactive, malformed, corrupt-date and wrong-kind coupons give byte-identical errors", () => {
    const { db, svc } = harness();
    addCoupon(db, "INACTIVE1", { active: 0 });
    addCoupon(db, "BADDATE", { starts: "not a date" });
    addCoupon(db, "BADEND", { expires: "garbage" });
    const samples = [
      svc.validate("DOESNOTEXIST", 1000, S1),
      svc.validate("inactive1", 1000, S1),
      svc.validate("BADDATE", 1000, S1),
      svc.validate("BADEND", 1000, S1),
      svc.validate("bad code!", 1000, S1),
      svc.validate("x".repeat(10_000), 1000, S1),
      // inactive AND expired AND exhausted AND below min: still just INVALID
      (() => {
        addCoupon(db, "DEADALL", { active: 0, maxUses: 1, used: 1, min: 99_999, expires: "2020-01-01T00:00:00.000Z" });
        return svc.validate("DEADALL", 1, S1);
      })(),
    ];
    const serialised = samples.map((s) => JSON.stringify(s));
    expect(new Set(serialised).size).toBe(1);
    expect(samples[0]).toEqual({ ok: false, error: { code: "COUPON_INVALID", message: COUPON_INVALID_MESSAGE } });
    for (const s of samples) expect(!s.ok && "details" in s.error).toBe(false);
  });

  test("recordRedemption's COUPON_INVALID (bad charset, unknown, inactive) is byte-identical to validate's", () => {
    const { db, svc } = harness();
    addCoupon(db, "OFF", { active: 0 });
    const ref = JSON.stringify(svc.validate("NOPE", 1000, S1));
    for (const code of ["bad code", "NOPE", "off"]) {
      expect(JSON.stringify(recordRedemption(db, code, S1, "o-1"))).toBe(ref);
    }
  });
});

// ---------------------------------------------------------------------------
describe("criterion 3: window, min subtotal, exhausted vs used, ordering", () => {
  const START = "2026-11-01T00:00:00.000Z";
  const END = "2026-11-30T23:59:59.999Z";

  test("before starts_at and after expires_at -> EXPIRED; exact boundary instants are valid", () => {
    const { db, svc } = harness();
    addCoupon(db, "WIN", { starts: START, expires: END });
    const s = Date.parse(START);
    const e = Date.parse(END);
    expect(codeOf(svc.validate("WIN", 1000, S1, s - 1))).toBe("COUPON_EXPIRED");
    expect(codeOf(svc.validate("WIN", 1000, S1, s))).toBe("OK");
    expect(codeOf(svc.validate("WIN", 1000, S1, e))).toBe("OK");
    expect(codeOf(svc.validate("WIN", 1000, S1, e + 1))).toBe("COUPON_EXPIRED");
    // Seeded EXPIRED10 at the default injected clock.
    expect(codeOf(svc.validate("expired10", 1000, S1))).toBe("COUPON_EXPIRED");
  });

  test("open-ended windows: only starts_at / only expires_at", () => {
    const { db, svc } = harness();
    addCoupon(db, "FUTURE", { starts: "2027-01-01T00:00:00.000Z" });
    addCoupon(db, "PAST", { expires: "2026-01-01T00:00:00.000Z" });
    expect(codeOf(svc.validate("FUTURE", 1000, S1))).toBe("COUPON_EXPIRED");
    expect(codeOf(svc.validate("PAST", 1000, S1))).toBe("COUPON_EXPIRED");
    expect(codeOf(svc.validate("FUTURE", 1000, S1, Date.parse("2027-01-01T00:00:00.000Z")))).toBe("OK");
  });

  test("the service clock is used when no per-call now is given; per-call now overrides", () => {
    const db = freshDb();
    addCoupon(db, "WIN", { starts: START, expires: END });
    let clock = Date.parse(END) + 1;
    const svc = createCouponService({ db, now: () => clock });
    expect(codeOf(svc.validate("WIN", 1000, null))).toBe("COUPON_EXPIRED");
    clock = Date.parse(END);
    expect(codeOf(svc.validate("WIN", 1000, null))).toBe("OK");
    expect(codeOf(svc.validate("WIN", 1000, null, Date.parse(START) - 1))).toBe("COUPON_EXPIRED");
  });

  test("MIN_SUBTOTAL carries shortfallCents + minSubtotalCents; equality passes", () => {
    const { svc } = harness();
    const r = svc.validate("SAVE5", 2499, S1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("COUPON_MIN_SUBTOTAL");
    expect(r.error.details).toEqual({ shortfallCents: 1, minSubtotalCents: 2500 });
    expect(r.error.message).toContain("$0.01");
    const zero = svc.validate("SAVE5", 0, S1);
    expect(!zero.ok && zero.error.details).toEqual({ shortfallCents: 2500, minSubtotalCents: 2500 });
    expect(codeOf(svc.validate("SAVE5", 2500, S1))).toBe("OK");
  });

  test("MIN_SUBTOTAL is checked LAST: expired / exhausted / used codes below min report those instead", () => {
    const { db, svc } = harness();
    addCoupon(db, "EXPMIN", { min: 5000, expires: "2026-01-01T00:00:00.000Z" });
    addCoupon(db, "FUTMIN", { min: 5000, starts: "2027-01-01T00:00:00.000Z" });
    addCoupon(db, "EXHMIN", { min: 5000, maxUses: 2, used: 2 });
    addCoupon(db, "USEDMIN", { min: 5000 });
    db.query("INSERT INTO coupon_redemptions (coupon_code, session_id, order_id) VALUES ('USEDMIN', ?, 'o')").run(S1);
    expect(codeOf(svc.validate("EXPMIN", 1, S1))).toBe("COUPON_EXPIRED");
    expect(codeOf(svc.validate("FUTMIN", 1, S1))).toBe("COUPON_EXPIRED");
    expect(codeOf(svc.validate("EXHMIN", 1, S1))).toBe("COUPON_EXHAUSTED");
    expect(codeOf(svc.validate("USEDMIN", 1, S1))).toBe("COUPON_USED");
    expect(codeOf(svc.validate("USEDMIN", 1, S2))).toBe("COUPON_MIN_SUBTOTAL");
  });

  test("full order: EXPIRED beats EXHAUSTED beats USED", () => {
    const { db, svc } = harness();
    addCoupon(db, "ALLBAD", { maxUses: 1, used: 1, expires: "2026-01-01T00:00:00.000Z" });
    db.query("INSERT INTO coupon_redemptions (coupon_code, session_id) VALUES ('ALLBAD', ?)").run(S1);
    expect(codeOf(svc.validate("ALLBAD", 1000, S1))).toBe("COUPON_EXPIRED");
    addCoupon(db, "EXUSED", { maxUses: 1, used: 1 });
    db.query("INSERT INTO coupon_redemptions (coupon_code, session_id) VALUES ('EXUSED', ?)").run(S1);
    expect(codeOf(svc.validate("EXUSED", 1000, S1))).toBe("COUPON_EXHAUSTED");
  });

  test("EXHAUSTED when used_count >= max_uses (seeded MAXED5); USED only for the redeeming session", () => {
    const { db, svc } = harness();
    expect(codeOf(svc.validate("maxed5", 1000, S1))).toBe("COUPON_EXHAUSTED");
    expect(codeOf(svc.validate("MAXED5", 1000, null))).toBe("COUPON_EXHAUSTED");
    expect(recordRedemption(db, "WELCOME10", S1, "o-1").ok).toBe(true);
    expect(codeOf(svc.validate("WELCOME10", 1000, S1))).toBe("COUPON_USED");
    expect(codeOf(svc.validate("WELCOME10", 1000, S2))).toBe("OK");
    // null / non-UUID session ids skip the per-session check (no query with garbage ids).
    expect(codeOf(svc.validate("WELCOME10", 1000, null))).toBe("OK");
    expect(codeOf(svc.validate("WELCOME10", 1000, S1.toUpperCase()))).toBe("OK");
    expect(codeOf(svc.validate("WELCOME10", 1000, "' OR 1=1 --"))).toBe("OK");
  });

  test("hostile session ids never throw and never match another session's redemption", () => {
    const { db, svc } = harness();
    expect(recordRedemption(db, "WELCOME10", S1, "o-1").ok).toBe(true);
    for (const sid of ["%", "_", `${S1} `, ` ${S1}`, `${S1}\u0000`, "x".repeat(10_000), "' OR '1'='1"]) {
      expect(codeOf(svc.validate("WELCOME10", 1000, sid))).toBe("OK");
    }
  });
});

// ---------------------------------------------------------------------------
describe("recordRedemption / releaseRedemption", () => {
  test("success writes exactly one row and increments once; code normalised", () => {
    const { db } = harness();
    addCoupon(db, "ONE", { maxUses: 3 });
    expect(recordRedemption(db, "  one ", S1, "order-1")).toEqual({ ok: true, value: undefined });
    expect(usedCount(db, "ONE")).toBe(1);
    const row = db.query<{ coupon_code: string; session_id: string; order_id: string }, []>(
      "SELECT coupon_code, session_id, order_id FROM coupon_redemptions WHERE coupon_code = 'ONE'",
    ).get();
    expect(row).toEqual({ coupon_code: "ONE", session_id: S1, order_id: "order-1" });
  });

  test("second redemption by the same session -> COUPON_USED, nothing changes", () => {
    const { db } = harness();
    addCoupon(db, "TWICE");
    expect(recordRedemption(db, "TWICE", S1, "o1").ok).toBe(true);
    expect(codeOf(recordRedemption(db, "twice", S1, "o2"))).toBe("COUPON_USED");
    expect(usedCount(db, "TWICE")).toBe(1);
    expect(redemptionCount(db, "TWICE")).toBe(1);
  });

  test("exhausted -> COUPON_EXHAUSTED and the INSERT is rolled back (no orphan row)", () => {
    const { db } = harness();
    expect(codeOf(recordRedemption(db, "MAXED5", S1, "o1"))).toBe("COUPON_EXHAUSTED");
    expect(redemptionCount(db, "MAXED5")).toBe(0);
    expect(usedCount(db, "MAXED5")).toBe(1);
  });

  test("inactive coupon -> COUPON_INVALID; nothing written", () => {
    const { db } = harness();
    addCoupon(db, "OFF", { active: 0 });
    expect(codeOf(recordRedemption(db, "OFF", S1, "o1"))).toBe("COUPON_INVALID");
    expect(redemptionCount(db, "OFF")).toBe(0);
    expect(usedCount(db, "OFF")).toBe(0);
  });

  test("bad session / order ids -> INVALID_INPUT; hostile codes -> COUPON_INVALID; nothing written, no throw", () => {
    const { db } = harness();
    const badSessions: unknown[] = ["", "nope", S1.toUpperCase(), `${S1} `, null, undefined, 1, "00000000-0000-0000-0000-000000000000"];
    for (const sid of badSessions) {
      expect(codeOf(recordRedemption(db, "WELCOME10", sid as string, "o1"))).toBe("INVALID_INPUT");
    }
    const badOrders: unknown[] = ["", "x".repeat(129), null, undefined, 7, {}];
    for (const oid of badOrders) {
      expect(codeOf(recordRedemption(db, "WELCOME10", S1, oid as string))).toBe("INVALID_INPUT");
    }
    expect(recordRedemption(db, "WELCOME10", S1, "x".repeat(128)).ok).toBe(true);
    db.run("DELETE FROM coupon_redemptions");
    db.run("UPDATE coupons SET used_count = 0 WHERE code = 'WELCOME10'");
    for (const code of HOSTILE_CODES) {
      expect(codeOf(recordRedemption(db, code as string, S1, "o1"))).toBe("COUPON_INVALID");
    }
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM coupon_redemptions").get()?.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM coupons").get()?.n).toBe(5);
  });

  test("savepoint inside a caller transaction: caller rollback undoes it; caller commit keeps it", () => {
    const { db } = harness();
    addCoupon(db, "TX", { maxUses: 1 });
    expect(() =>
      withTransaction(db, (tx) => {
        tx.run("UPDATE coupons SET promoted = 1 WHERE code = 'SAVE5'");
        expect(recordRedemption(tx, "TX", S1, "o1").ok).toBe(true);
        expect(usedCount(tx, "TX")).toBe(1);
        throw new Error("payment declined");
      }),
    ).toThrow("payment declined");
    expect(usedCount(db, "TX")).toBe(0);
    expect(redemptionCount(db, "TX")).toBe(0);
    expect(db.query<{ p: number }, []>("SELECT promoted AS p FROM coupons WHERE code = 'SAVE5'").get()?.p).toBe(0);

    withTransaction(db, (tx) => {
      expect(recordRedemption(tx, "TX", S1, "o1").ok).toBe(true);
    });
    expect(usedCount(db, "TX")).toBe(1);
    expect(redemptionCount(db, "TX")).toBe(1);
  });

  test("a failed redemption inside a caller transaction keeps the transaction usable and the caller's writes", () => {
    const { db } = harness();
    const result = withTransaction(db, (tx) => {
      tx.run("UPDATE coupons SET promoted = 1 WHERE code = 'SAVE5'");
      const r1 = recordRedemption(tx, "MAXED5", S1, "o1");
      const r2 = recordRedemption(tx, "WELCOME10", S1, "o1");
      return [codeOf(r1), codeOf(r2)];
    });
    expect(result).toEqual(["COUPON_EXHAUSTED", "OK"]);
    expect(db.query<{ p: number }, []>("SELECT promoted AS p FROM coupons WHERE code = 'SAVE5'").get()?.p).toBe(1);
    expect(redemptionCount(db, "MAXED5")).toBe(0);
    expect(usedCount(db, "WELCOME10")).toBe(1);
  });

  test("same-connection race: two sessions that both validated -> exactly one success", () => {
    const { db, svc } = harness();
    addCoupon(db, "LAST", { maxUses: 1 });
    expect(codeOf(svc.validate("LAST", 1000, S1))).toBe("OK");
    expect(codeOf(svc.validate("LAST", 1000, S2))).toBe("OK");
    const r = [S1, S2].map((s, i) => withTransaction(db, (tx) => recordRedemption(tx, "LAST", s, `o${i}`)));
    expect(r.map(codeOf).sort()).toEqual(["COUPON_EXHAUSTED", "OK"]);
    expect(usedCount(db, "LAST")).toBe(1);
    expect(redemptionCount(db, "LAST")).toBe(1);
  });

  test("two separate connections on a shared-cache in-memory URI: interleaved validate, sequential commit -> one success", () => {
    const uri = `file:qa-pricing-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const a = new Database(uri, { strict: true });
    const b = new Database(uri, { strict: true });
    open.push(a, b);
    runMigrations(a);
    seedDatabase(a);
    addCoupon(a, "LAST", { maxUses: 1 });
    const svcA = createCouponService({ db: a, now: () => NOW });
    const svcB = createCouponService({ db: b, now: () => NOW });
    expect(codeOf(svcA.validate("LAST", 1000, S1))).toBe("OK");
    expect(codeOf(svcB.validate("LAST", 1000, S2))).toBe("OK");
    const ra = withTransaction(a, (tx) => recordRedemption(tx, "LAST", S1, "oa"));
    const rb = withTransaction(b, (tx) => recordRedemption(tx, "LAST", S2, "ob"));
    expect([codeOf(ra), codeOf(rb)]).toEqual(["OK", "COUPON_EXHAUSTED"]);
    expect(usedCount(b, "LAST")).toBe(1);
    expect(redemptionCount(a, "LAST")).toBe(1);
    // B now sees EXHAUSTED via validate too.
    expect(codeOf(svcB.validate("LAST", 1000, S2))).toBe("COUPON_EXHAUSTED");
  });

  test("8 worker threads, each on its own shared-cache connection, race for the last use -> exactly one success", async () => {
    const uri = `file:qa-pricing-race-${crypto.randomUUID()}?mode=memory&cache=shared`;
    const keeper = new Database(uri, { strict: true });
    open.push(keeper);
    runMigrations(keeper);
    seedDatabase(keeper);
    addCoupon(keeper, "LASTW", { maxUses: 1 });
    const sessions = Array.from({ length: 8 }, () => crypto.randomUUID());
    const start = new Int32Array(new SharedArrayBuffer(4));
    const workers = sessions.map(() => new Worker(new URL("./pricing-race.qa.worker.ts", import.meta.url).href));
    const results = await Promise.all(
      workers.map(
        (w, i) =>
          new Promise<{ ok: boolean; code: string }>((resolve, reject) => {
            w.onmessage = (e: MessageEvent<{ ok: boolean; code: string }>) => resolve(e.data);
            w.onerror = (e) => reject(e);
            w.postMessage({ uri, code: "lastw", sessionId: sessions[i], orderId: `o${i}`, start });
            if (i === workers.length - 1) {
              setTimeout(() => {
                Atomics.store(start, 0, 1);
                Atomics.notify(start, 0);
              }, 200);
            }
          }),
      ),
    );
    for (const w of workers) w.terminate();
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => r.code)).toEqual(Array(7).fill("COUPON_EXHAUSTED"));
    expect(usedCount(keeper, "LASTW")).toBe(1);
    expect(redemptionCount(keeper, "LASTW")).toBe(1);
  }, 30_000);

  test("releaseRedemption: decrements only when a row was deleted, idempotent, never below 0", () => {
    const { db, svc } = harness();
    addCoupon(db, "REL", { maxUses: 2 });
    expect(recordRedemption(db, "REL", S1, "o1").ok).toBe(true);
    expect(recordRedemption(db, "REL", S2, "o2").ok).toBe(true);
    expect(usedCount(db, "REL")).toBe(2);
    releaseRedemption(db, " rel ", S1);
    expect(usedCount(db, "REL")).toBe(1);
    releaseRedemption(db, "REL", S1);
    releaseRedemption(db, "REL", S1);
    expect(usedCount(db, "REL")).toBe(1);
    expect(redemptionCount(db, "REL")).toBe(1);
    // A session with no redemption cannot decrement someone else's use.
    const S3 = crypto.randomUUID();
    releaseRedemption(db, "REL", S3);
    expect(usedCount(db, "REL")).toBe(1);
    // Row exists but used_count already 0 -> stays 0.
    db.run("UPDATE coupons SET used_count = 0 WHERE code = 'REL'");
    releaseRedemption(db, "REL", S2);
    expect(usedCount(db, "REL")).toBe(0);
    expect(redemptionCount(db, "REL")).toBe(0);
    // Released session may redeem again.
    expect(codeOf(svc.validate("REL", 1000, S1))).toBe("OK");
    expect(recordRedemption(db, "REL", S1, "o3").ok).toBe(true);
  });

  test("releaseRedemption: hostile/invalid inputs are silent no-ops and never touch the DB", () => {
    const { db } = harness();
    expect(recordRedemption(db, "WELCOME10", S1, "o1").ok).toBe(true);
    const spy = spyDb(db);
    for (const code of HOSTILE_CODES) expect(() => releaseRedemption(spy.db, code as string, S1)).not.toThrow();
    for (const sid of ["", "nope", S1.toUpperCase(), "' OR 1=1 --", "x".repeat(10_000)]) {
      expect(() => releaseRedemption(spy.db, "WELCOME10", sid)).not.toThrow();
    }
    expect(spy.touched).toEqual([]);
    expect(usedCount(db, "WELCOME10")).toBe(1);
    // Unknown well-formed code: no throw, no change.
    expect(() => releaseRedemption(db, "NOSUCH", S1)).not.toThrow();
  });

  test("release inside a caller transaction rolls back with it", () => {
    const { db } = harness();
    expect(recordRedemption(db, "WELCOME10", S1, "o1").ok).toBe(true);
    expect(() =>
      withTransaction(db, (tx) => {
        releaseRedemption(tx, "WELCOME10", S1);
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(usedCount(db, "WELCOME10")).toBe(1);
    expect(redemptionCount(db, "WELCOME10")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 4: shipping methods and free threshold", () => {
  test("standard: 3499 pays 499, 3500 and above free; amountToFree exact; express/next_day null threshold", () => {
    const db = freshDb();
    const ship = createShippingService({ db });
    const at = (sub: number) => Object.fromEntries(ship.listMethods(sub).map((q) => [q.method.id, q]));
    const a = at(3499);
    expect(a.standard).toMatchObject({ priceCents: 499, isFree: false, amountToFreeCents: 1 });
    expect(a.express).toMatchObject({ priceCents: 999, isFree: false, amountToFreeCents: null });
    expect(a.next_day).toMatchObject({ priceCents: 1999, isFree: false, amountToFreeCents: null });
    expect(at(3500).standard).toMatchObject({ priceCents: 0, isFree: true, amountToFreeCents: 0 });
    expect(at(3501).standard).toMatchObject({ priceCents: 0, isFree: true, amountToFreeCents: 0 });
    expect(at(MAX).standard).toMatchObject({ priceCents: 0, amountToFreeCents: 0 });
    expect(at(0).standard).toMatchObject({ priceCents: 499, amountToFreeCents: 3500 });
    expect(ship.listMethods(0).map((q) => q.method.id)).toEqual(["standard", "express", "next_day"]);
  });

  test("cheapest: standard below threshold, free standard above; null when no active methods", () => {
    const db = freshDb();
    const ship = createShippingService({ db });
    expect(ship.cheapest(100)?.method.id).toBe("standard");
    expect(ship.cheapest(3500)?.priceCents).toBe(0);
    db.run("UPDATE shipping_methods SET is_active = 0");
    expect(ship.cheapest(100)).toBeNull();
    expect(ship.listMethods(100)).toEqual([]);
  });

  test("inactive methods are hidden from listMethods, getMethod, quote, cheapest", () => {
    const db = freshDb();
    const ship = createShippingService({ db });
    db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'standard'");
    expect(ship.listMethods(100).map((q) => q.method.id)).toEqual(["express", "next_day"]);
    expect(ship.getMethod("standard")).toBeNull();
    const q = ship.quote("standard", 100);
    expect(!q.ok && q.error).toMatchObject({ code: "INVALID_INPUT", details: { field: "shippingMethodId" } });
    expect(ship.cheapest(100)?.method.id).toBe("express");
  });

  test("quote: unknown/hostile ids -> INVALID_INPUT; invalid subtotal -> INVALID_INPUT; unsafe -> MONEY_OVERFLOW", () => {
    const db = freshDb();
    const ship = createShippingService({ db });
    const ids: unknown[] = ["", "nope", "STANDARD", " standard", "' OR 1=1 --", "x".repeat(10_000), "standard\u0000", null, 5, {}];
    for (const id of ids) {
      expect(codeOf(ship.quote(id as string, 100))).toBe("INVALID_INPUT");
      expect(ship.getMethod(id)).toBeNull();
    }
    for (const sub of [-1, 1.5, Number.NaN, -Infinity, "100" as unknown as number]) {
      expect(codeOf(ship.quote("standard", sub))).toBe("INVALID_INPUT");
    }
    expect(codeOf(ship.quote("standard", MAX + 1))).toBe("MONEY_OVERFLOW");
    expect(codeOf(ship.quote("standard", Infinity))).toBe("MONEY_OVERFLOW");
    expect(ship.quote("standard", 3500)).toMatchObject({ ok: true, value: { priceCents: 0, isFree: true } });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shipping_methods").get()?.n).toBe(3);
  });

  test("listMethods / cheapest throw RangeError on invalid subtotal", () => {
    const db = freshDb();
    const ship = createShippingService({ db });
    for (const sub of [-1, 1.5, Number.NaN, Infinity, -Infinity, MAX + 1, "100" as unknown as number, null as unknown as number]) {
      expect(() => ship.listMethods(sub)).toThrow(RangeError);
      expect(() => ship.cheapest(sub)).toThrow(RangeError);
    }
  });

  test("a threshold of 0 makes the method always free; amountToFree 0", () => {
    const m = { ...STANDARD, freeOverCents: 0 };
    expect(quoteFor(m, 0)).toMatchObject({ priceCents: 0, isFree: true, amountToFreeCents: 0 });
  });
});

// ---------------------------------------------------------------------------
describe("criterion 6: estimateDelivery", () => {
  const ND = { minDays: 1, maxDays: 1 };
  const STD = { minDays: 5, maxDays: 8 };
  const EXP = { minDays: 2, maxDays: 3 };
  const day = (iso: string) => `${iso}T00:00:00.000Z`;

  test("README table + weekend edges", () => {
    expect(estimateDelivery(ND, "2026-11-04T10:00:00.000Z")).toEqual({ start: day("2026-11-05"), end: day("2026-11-05") });
    expect(estimateDelivery(ND, "2026-11-06T23:59:59.999Z")).toEqual({ start: day("2026-11-09"), end: day("2026-11-09") });
    expect(estimateDelivery(ND, "2026-11-07T00:00:00.000Z")).toEqual({ start: day("2026-11-10"), end: day("2026-11-10") });
    expect(estimateDelivery(ND, "2026-11-07T18:00:00.000Z")).toEqual({ start: day("2026-11-10"), end: day("2026-11-10") });
    expect(estimateDelivery(ND, "2026-11-08T23:59:59.999Z")).toEqual({ start: day("2026-11-10"), end: day("2026-11-10") });
    expect(estimateDelivery(STD, "2026-11-06T09:00:00.000Z")).toEqual({ start: day("2026-11-13"), end: day("2026-11-18") });
    expect(estimateDelivery(EXP, "2026-11-05T09:00:00.000Z")).toEqual({ start: day("2026-11-09"), end: day("2026-11-10") });
    // 0/0 on a weekend rolls to Monday.
    expect(estimateDelivery({ minDays: 0, maxDays: 0 }, "2026-11-07T09:00:00.000Z")).toEqual({ start: day("2026-11-09"), end: day("2026-11-09") });
  });

  test("ISO and epoch-ms inputs agree; result is deterministic and ignores now when placedAt is valid", () => {
    const rand = rng(2026);
    for (let i = 0; i < 500; i++) {
      const ms = Date.parse("2026-01-01T00:00:00.000Z") + Math.floor(rand() * 400 * 86_400_000);
      const m = [ND, STD, EXP][i % 3] as typeof ND;
      const a = estimateDelivery(m, ms, 0);
      const b = estimateDelivery(m, new Date(ms).toISOString(), 1e12);
      expect(a).toEqual(b);
      expect(estimateDelivery(m, ms)).toEqual(a);
    }
  });

  test("invalid placedAt falls back to the injected now (deterministic)", () => {
    const now = Date.parse("2026-11-04T10:00:00.000Z");
    for (const bad of ["", "garbage", "2026-13-45", Number.NaN, Infinity]) {
      expect(estimateDelivery(ND, bad as string, now)).toEqual({ start: day("2026-11-05"), end: day("2026-11-05") });
    }
  });

  test("28-day hourly sweep x min/max 0..10: never a weekend, start<=end, end-start covers (max-min) business days", () => {
    const base = Date.parse("2026-11-01T00:00:00.000Z");
    for (let h = 0; h < 28 * 24; h++) {
      const placed = base + h * 3_600_000;
      for (let min = 0; min <= 10; min++) {
        for (const extra of [0, 1, 3]) {
          const r = estimateDelivery({ minDays: min, maxDays: min + extra }, placed);
          const s = new Date(r.start);
          const e = new Date(r.end);
          expect([0, 6]).not.toContain(s.getUTCDay());
          expect([0, 6]).not.toContain(e.getUTCDay());
          expect(s.getTime()).toBeLessThanOrEqual(e.getTime());
          expect(s.getTime()).toBeGreaterThanOrEqual(Math.floor(placed / 86_400_000) * 86_400_000);
          expect(r.start.endsWith("T00:00:00.000Z")).toBe(true);
          // Count weekdays strictly after start up to end.
          let biz = 0;
          for (let d = s.getTime() + 86_400_000; d <= e.getTime(); d += 86_400_000) {
            const wd = new Date(d).getUTCDay();
            if (wd !== 0 && wd !== 6) biz++;
          }
          expect(biz).toBe(extra);
        }
      }
    }
  });

  test("RangeError for non-integer, negative, > 365 days, or max < min", () => {
    const bad: { minDays: unknown; maxDays: unknown }[] = [
      { minDays: 1.5, maxDays: 2 },
      { minDays: 1, maxDays: 2.5 },
      { minDays: -1, maxDays: 2 },
      { minDays: 0, maxDays: MAX_DELIVERY_BUSINESS_DAYS + 1 },
      { minDays: 366, maxDays: 366 },
      { minDays: 3, maxDays: 2 },
      { minDays: Number.NaN, maxDays: 1 },
      { minDays: Infinity, maxDays: Infinity },
      { minDays: "1", maxDays: 2 },
      { minDays: null, maxDays: 2 },
    ];
    for (const m of bad) {
      expect(() => estimateDelivery(m as typeof ND, "2026-11-04T10:00:00.000Z", NOW)).toThrow(RangeError);
    }
    expect(() => estimateDelivery({ minDays: 365, maxDays: 365 }, "2026-11-04T10:00:00.000Z")).not.toThrow();
  });

  test("offset-less ISO placedAt gives the same estimate regardless of server TZ (D-T38-1)", () => {
    const prev = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const utc = estimateDelivery(ND, "2026-11-06T23:59:00");
      process.env.TZ = "America/Los_Angeles";
      const la = estimateDelivery(ND, "2026-11-06T23:59:00");
      process.env.TZ = "Pacific/Kiritimati";
      const kir = estimateDelivery(ND, "2026-11-09T05:00:00");
      process.env.TZ = "UTC";
      const kirUtc = estimateDelivery(ND, "2026-11-09T05:00:00");
      expect(la).toEqual(utc);
      expect(kir).toEqual(kirUtc);
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  test("never throws for an in-range placedAt near the Date limits (D-T38-2)", () => {
    // Documented as total ("the function is total"): only bad min/max days may throw.
    expect(() => estimateDelivery(ND, 8.64e15)).not.toThrow();
    expect(() => estimateDelivery(ND, "garbage", Number.NaN)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("criterion 7 + computeTotals input handling", () => {
  test("stale quote cannot leak a price: shipping is recomputed from shipping.method at THIS subtotal", () => {
    const freeQuote = quoteFor(STANDARD, 5000); // priceCents 0 at 5000
    const r = computeTotals({ subtotalCents: 1000, shipping: freeQuote });
    expect(r.ok && r.value).toEqual({ subtotalCents: 1000, discountCents: 0, shippingCents: 499, totalCents: 1499, amountToFreeShippingCents: 2500 });
    // A forged quote object with priceCents 0 / isFree true is ignored as well.
    const forged = { ...quoteFor(STANDARD, 1000), priceCents: 0, isFree: true, amountToFreeCents: 0 } as ShippingQuote;
    const f = computeTotals({ subtotalCents: 1000, shipping: forged });
    expect(f.ok && f.value.shippingCents).toBe(499);
    // And the reverse: a paid quote at a now-free subtotal becomes free.
    const paid = quoteFor(STANDARD, 100);
    const p = computeTotals({ subtotalCents: 3500, shipping: paid });
    expect(p.ok && p.value).toMatchObject({ shippingCents: 0, totalCents: 3500, amountToFreeShippingCents: 0 });
  });

  test("free threshold uses the pre-discount subtotal", () => {
    const r = computeTotals({ subtotalCents: 3500, coupon: coupon("fixed", 3000), shipping: quoteFor(STANDARD, 3500) });
    expect(r.ok && r.value).toEqual({ subtotalCents: 3500, discountCents: 3000, shippingCents: 0, totalCents: 500, amountToFreeShippingCents: 0 });
  });

  test("MONEY_OVERFLOW: MAX_SAFE+1, Infinity, unsafe shipping price/threshold, sum overflow", () => {
    const cases: TotalsInput[] = [
      { subtotalCents: MAX + 1 },
      { subtotalCents: Infinity },
      { subtotalCents: 2 ** 60 },
      { subtotalCents: 100, shipping: { ...quoteFor(EXPRESS, 0), method: { ...EXPRESS, priceCents: MAX + 1 } } },
      { subtotalCents: 100, shipping: { ...quoteFor(EXPRESS, 0), method: { ...EXPRESS, priceCents: Infinity } } },
      { subtotalCents: 100, shipping: { ...quoteFor(STANDARD, 0), method: { ...STANDARD, freeOverCents: MAX + 2 } } },
      { subtotalCents: MAX, shipping: quoteFor(EXPRESS, 0) },
      { subtotalCents: MAX - 998, shipping: quoteFor(EXPRESS, 0) },
    ];
    for (const c of cases) expect(codeOf(computeTotals(c))).toBe("MONEY_OVERFLOW");
    expect(computeTotals({ subtotalCents: MAX - 999, shipping: quoteFor(EXPRESS, 0) })).toMatchObject({ ok: true, value: { totalCents: MAX } });
  });

  test("INVALID_INPUT for non-integers, negatives, NaN, strings, malformed coupon/method; never throws", () => {
    const cases: unknown[] = [
      null,
      undefined,
      42,
      "x",
      {},
      { subtotalCents: 1.5 },
      { subtotalCents: -1 },
      { subtotalCents: -Infinity },
      { subtotalCents: Number.NaN },
      { subtotalCents: "1000" },
      { subtotalCents: 1000n },
      { subtotalCents: 1000, coupon: { kind: "percent", value: 0 } },
      { subtotalCents: 1000, coupon: { kind: "percent", value: 101 } },
      { subtotalCents: 1000, coupon: { kind: "percent", value: 10.5 } },
      { subtotalCents: 1000, coupon: { kind: "fixed", value: -5 } },
      { subtotalCents: 1000, coupon: { kind: "fixed", value: 0 } },
      { subtotalCents: 1000, coupon: { kind: "free_shipping", value: 5 } },
      { subtotalCents: 1000, coupon: { kind: "bogus", value: 5 } },
      { subtotalCents: 1000, coupon: "WELCOME10" },
      { subtotalCents: 1000, shipping: { method: null } },
      { subtotalCents: 1000, shipping: "standard" },
      { subtotalCents: 1000, shipping: { method: { ...STANDARD, priceCents: 4.99 } } },
      { subtotalCents: 1000, shipping: { method: { ...STANDARD, priceCents: -1 } } },
      { subtotalCents: 1000, shipping: { method: { ...STANDARD, freeOverCents: 35.5 } } },
    ];
    for (const c of cases) {
      let r: ReturnType<typeof computeTotals> | undefined;
      expect(() => {
        r = computeTotals(c as TotalsInput);
      }).not.toThrow();
      expect(r !== undefined && codeOf(r)).toBe("INVALID_INPUT");
    }
  });

  test("no coupon, no method: total = subtotal; -0 normalised", () => {
    expect(computeTotals({ subtotalCents: 1234 })).toEqual({
      ok: true,
      value: { subtotalCents: 1234, discountCents: 0, shippingCents: 0, totalCents: 1234, amountToFreeShippingCents: null },
    });
    const z = computeTotals({ subtotalCents: -0 });
    expect(z.ok && Object.is(z.value.subtotalCents, 0) && Object.is(z.value.totalCents, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("listPromoted, descriptions, singletons, SQL hygiene", () => {
  test("listPromoted returns only active, in-window, promoted (and not exhausted) coupons, ordered by code", () => {
    const { db, svc } = harness();
    addCoupon(db, "AAPROMO", { promoted: 1 });
    addCoupon(db, "PROMOOFF", { promoted: 1, active: 0 });
    addCoupon(db, "PROMOPAST", { promoted: 1, expires: "2026-01-01T00:00:00.000Z" });
    addCoupon(db, "PROMOFUT", { promoted: 1, starts: "2027-01-01T00:00:00.000Z" });
    addCoupon(db, "PROMOMAX", { promoted: 1, maxUses: 1, used: 1 });
    addCoupon(db, "PROMOBAD", { promoted: 1, starts: "nope" });
    addCoupon(db, "NOTPROMO", { promoted: 0 });
    addCoupon(db, "ZEDGE", { promoted: 1, starts: "2026-11-07T12:00:00.000Z", expires: "2026-11-07T12:00:00.000Z" });
    expect(svc.listPromoted().map((c) => c.code)).toEqual(["AAPROMO", "FREESHIP", "WELCOME10", "ZEDGE"]);
    expect(svc.listPromoted(NOW + 1).map((c) => c.code)).toEqual(["AAPROMO", "FREESHIP", "WELCOME10"]);
    expect(svc.listPromoted(Date.parse("2027-06-01T00:00:00.000Z")).map((c) => c.code)).toEqual(["AAPROMO", "FREESHIP", "PROMOFUT", "WELCOME10"]);
    for (const c of svc.listPromoted()) expect(c.promoted).toBe(true);
  });

  test("descriptions are in USD for every kind, including large amounts", () => {
    expect(COUPON_DESCRIPTION_CURRENCY).toBe("USD");
    expect(describeCoupon("fixed", 123456, 0)).toBe("$1,234.56 off");
    expect(describeCoupon("fixed", 1, 0)).toBe("$0.01 off");
    expect(describeCoupon("free_shipping", 0, 2000)).toBe("Free shipping on orders of $20 or more");
    expect(describeCoupon("percent", 100, 0)).toBe("100% off");
    const { db, svc } = harness();
    addCoupon(db, "BIG", { kind: "fixed", value: 10_000_00, min: 50_000_00 });
    const r = svc.validate("BIG", 50_000_00, null);
    expect(r.ok && r.value.description).toBe("$10,000 off orders of $50,000 or more");
    for (const c of svc.listPromoted()) expect(c.description).not.toMatch(/[€£¥]|EUR|GBP/);
  });

  test("getCouponService / getShippingService reuse one instance per DB handle and rebuild on a new handle", () => {
    const prev = process.env.DATABASE_PATH;
    try {
      process.env.DATABASE_PATH = ":memory:";
      closeDatabase();
      const c1 = getCouponService();
      const s1 = getShippingService();
      expect(getCouponService()).toBe(c1);
      expect(getShippingService()).toBe(s1);
      const db1 = getDatabase();
      seedDatabase(db1);
      expect(c1.listPromoted(NOW).map((c) => c.code)).toEqual(["FREESHIP", "WELCOME10"]);
      expect(s1.listMethods(0)).toHaveLength(3);
      closeDatabase();
      const c2 = getCouponService();
      expect(c2).not.toBe(c1);
      expect(getShippingService()).not.toBe(s1);
      expect(getCouponService()).toBe(c2);
      expect(c2.listPromoted(NOW)).toEqual([]);
    } finally {
      closeDatabase();
      if (prev === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = prev;
    }
  });

  test("hostile inputs never alter the schema or data", () => {
    const { db, svc } = harness();
    const ship = createShippingService({ db });
    const before = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master ORDER BY name").all();
    const coupons = db.query("SELECT * FROM coupons ORDER BY code").all();
    for (const code of HOSTILE_CODES) {
      svc.validate(code, 1000, S1);
      recordRedemption(db, code as string, S1, "o1");
      releaseRedemption(db, code as string, S1);
      ship.quote(code as string, 1000);
      ship.getMethod(code);
    }
    expect(db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(db.query("SELECT * FROM coupons ORDER BY code").all()).toEqual(coupons);
  });

  test("static: every SQL string in pricing sources is parameterised (only *_COLUMNS constants interpolated)", () => {
    for (const file of ["coupon-service.ts", "shipping-service.ts", "totals.ts"]) {
      const src = readFileSync(join(PRICING_DIR, file), "utf8");
      const interpolations = [...src.matchAll(/`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*`/g)].flatMap((m) =>
        [...m[0].matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]),
      );
      for (const name of interpolations) expect(name).toMatch(/^[A-Z_]+_COLUMNS$/);
      expect(src).not.toMatch(/\.(run|query|prepare|exec)\(\s*["'][^"']*["']\s*\+/);
    }
  });
});
