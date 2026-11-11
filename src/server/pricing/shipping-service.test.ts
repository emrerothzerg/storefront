import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createShippingService, estimateDelivery, type ShippingService } from "./shipping-service";

let db: Database;
let svc: ShippingService;

beforeEach(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  svc = createShippingService({ db });
});

describe("listMethods / getMethod", () => {
  test("active methods by sort_order with quotes", () => {
    const quotes = svc.listMethods(1000);
    expect(quotes.map((q) => q.method.id)).toEqual(["standard", "express", "next_day"]);
    expect(quotes[0]).toEqual({
      method: { id: "standard", name: "Standard", description: expect.any(String), priceCents: 499, freeOverCents: 3500, minDays: 5, maxDays: 8, sortOrder: 1, isActive: true },
      priceCents: 499,
      isFree: false,
      amountToFreeCents: 2500,
    });
    expect(quotes[1]).toMatchObject({ priceCents: 999, isFree: false, amountToFreeCents: null });
  });

  test("free threshold: 3499 pays, 3500 (equal) and above are free", () => {
    expect(svc.listMethods(3499)[0]).toMatchObject({ priceCents: 499, isFree: false, amountToFreeCents: 1 });
    expect(svc.listMethods(3500)[0]).toMatchObject({ priceCents: 0, isFree: true, amountToFreeCents: 0 });
    expect(svc.listMethods(10_000)[0]).toMatchObject({ priceCents: 0, isFree: true, amountToFreeCents: 0 });
  });

  test("inactive methods are hidden everywhere", () => {
    db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    expect(svc.listMethods(0).map((q) => q.method.id)).toEqual(["standard", "next_day"]);
    expect(svc.getMethod("express")).toBeNull();
    const r = svc.quote("express", 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });

  test("getMethod rejects non-strings, empty, overlong and unknown ids", () => {
    expect(svc.getMethod("next_day")?.priceCents).toBe(1999);
    for (const bad of [undefined, null, 1, {}, "", "x".repeat(65), "nope", "standard' OR 1=1 --"]) {
      expect(svc.getMethod(bad)).toBeNull();
    }
  });

  test("listMethods throws RangeError on an invalid subtotal", () => {
    expect(() => svc.listMethods(-1)).toThrow(RangeError);
    expect(() => svc.listMethods(1.5)).toThrow(RangeError);
    expect(() => svc.cheapest(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe("cheapest / quote", () => {
  test("cheapest picks the lowest price, free standard above threshold", () => {
    expect(svc.cheapest(100)?.method.id).toBe("standard");
    expect(svc.cheapest(5000)).toMatchObject({ priceCents: 0, isFree: true });
  });

  test("cheapest ties go to sort_order; null with no active method", () => {
    db.run("UPDATE shipping_methods SET price_cents = 499 WHERE id = 'express'");
    db.run("UPDATE shipping_methods SET sort_order = 0 WHERE id = 'express'");
    expect(svc.cheapest(100)?.method.id).toBe("express");
    db.run("UPDATE shipping_methods SET is_active = 0");
    expect(svc.cheapest(100)).toBeNull();
    expect(svc.listMethods(100)).toEqual([]);
  });

  test("quote: ok, unknown id, invalid and overflowing subtotal", () => {
    const ok = svc.quote("standard", 3500);
    expect(ok.ok && ok.value.priceCents).toBe(0);
    const unknown = svc.quote("teleport", 100);
    expect(!unknown.ok && unknown.error.code).toBe("INVALID_INPUT");
    const neg = svc.quote("standard", -5);
    expect(!neg.ok && neg.error.code).toBe("INVALID_INPUT");
    const over = svc.quote("standard", Number.MAX_SAFE_INTEGER + 1);
    expect(!over.ok && over.error.code).toBe("MONEY_OVERFLOW");
  });
});

describe("estimateDelivery (business days, UTC)", () => {
  const NEXT_DAY = { minDays: 1, maxDays: 1 };
  const EXPRESS = { minDays: 2, maxDays: 3 };
  const STANDARD = { minDays: 5, maxDays: 8 };
  const day = (d: string) => `${d}T00:00:00.000Z`;

  test("mid-week next day", () => {
    expect(estimateDelivery(NEXT_DAY, "2026-11-04T15:30:00.000Z")).toEqual({ start: day("2026-11-05"), end: day("2026-11-05") });
  });

  test("Friday order skips the weekend", () => {
    expect(estimateDelivery(NEXT_DAY, "2026-11-06T23:59:59.999Z")).toEqual({ start: day("2026-11-09"), end: day("2026-11-09") });
    expect(estimateDelivery(STANDARD, "2026-11-06T10:00:00.000Z")).toEqual({ start: day("2026-11-13"), end: day("2026-11-18") });
  });

  test("Saturday and Sunday orders start counting on Monday", () => {
    expect(estimateDelivery(NEXT_DAY, "2026-11-07T00:00:00.000Z")).toEqual({ start: day("2026-11-10"), end: day("2026-11-10") });
    expect(estimateDelivery(NEXT_DAY, "2026-11-08T12:00:00.000Z")).toEqual({ start: day("2026-11-10"), end: day("2026-11-10") });
    expect(estimateDelivery(EXPRESS, "2026-11-07T09:00:00.000Z")).toEqual({ start: day("2026-11-11"), end: day("2026-11-12") });
  });

  test("Thursday express crosses the weekend", () => {
    expect(estimateDelivery(EXPRESS, "2026-11-05T08:00:00.000Z")).toEqual({ start: day("2026-11-09"), end: day("2026-11-10") });
  });

  test("zero days: same business day, weekend rolls to Monday", () => {
    expect(estimateDelivery({ minDays: 0, maxDays: 0 }, "2026-11-04T08:00:00.000Z").start).toBe(day("2026-11-04"));
    expect(estimateDelivery({ minDays: 0, maxDays: 1 }, "2026-11-07T08:00:00.000Z")).toEqual({ start: day("2026-11-09"), end: day("2026-11-10") });
  });

  test("results never land on a weekend", () => {
    const base = Date.UTC(2026, 10, 1);
    for (let i = 0; i < 28; i++) {
      for (const m of [NEXT_DAY, EXPRESS, STANDARD, { minDays: 0, maxDays: 20 }]) {
        const r = estimateDelivery(m, base + i * 86_400_000 + 3_600_000);
        for (const iso of [r.start, r.end]) {
          const wd = new Date(iso).getUTCDay();
          expect(wd === 0 || wd === 6).toBe(false);
          expect(iso.endsWith("T00:00:00.000Z")).toBe(true);
        }
        expect(Date.parse(r.end)).toBeGreaterThanOrEqual(Date.parse(r.start));
      }
    }
  });

  test("epoch ms equals ISO input; deterministic; now only used as fallback", () => {
    const iso = "2026-11-06T10:00:00.000Z";
    const a = estimateDelivery(STANDARD, iso, 0);
    expect(estimateDelivery(STANDARD, Date.parse(iso), 123)).toEqual(a);
    expect(estimateDelivery(STANDARD, iso)).toEqual(a);
    expect(estimateDelivery(STANDARD, "not a date", Date.parse(iso))).toEqual(a);
    expect(estimateDelivery(STANDARD, Number.NaN, Date.parse(iso))).toEqual(a);
  });

  test("zone-less ISO and SQLite date-times are read as UTC (D-T38-1)", () => {
    const utc = estimateDelivery(NEXT_DAY, "2026-11-06T23:59:00.000Z");
    expect(estimateDelivery(NEXT_DAY, "2026-11-06T23:59:00")).toEqual(utc);
    expect(estimateDelivery(NEXT_DAY, "2026-11-06 23:59:00")).toEqual(utc);
    expect(estimateDelivery(NEXT_DAY, "2026-11-06T23:59")).toEqual(utc);
    expect(estimateDelivery(NEXT_DAY, "2026-11-06T23:59:00.123456")).toEqual(utc);
    // Explicit offsets are honoured: 23:59 at -08:00 is Saturday 07:59 UTC.
    expect(estimateDelivery(NEXT_DAY, "2026-11-06T23:59:00-08:00")).toEqual({ start: day("2026-11-10"), end: day("2026-11-10") });
  });

  test("same zone-less input gives identical output under different server TZ (separate processes)", () => {
    const script =
      'import { estimateDelivery } from "./src/server/pricing/shipping-service";' +
      'console.log(JSON.stringify([estimateDelivery({ minDays: 1, maxDays: 1 }, "2026-11-06T23:59:00"), estimateDelivery({ minDays: 1, maxDays: 1 }, "2026-11-09 05:00:00")]));';
    const run = (tz: string): string => {
      const proc = Bun.spawnSync(["bun", "-e", script], { cwd: process.cwd(), env: { ...process.env, TZ: tz } });
      expect(proc.exitCode).toBe(0);
      return proc.stdout.toString().trim();
    };
    const utc = run("UTC");
    expect(JSON.parse(utc)).toEqual([{ start: day("2026-11-09"), end: day("2026-11-09") }, { start: day("2026-11-10"), end: day("2026-11-10") }]);
    expect(run("America/Los_Angeles")).toBe(utc);
    expect(run("Pacific/Kiritimati")).toBe(utc);
  });

  test("total near the Date limits; invalid placedAt and now fall back to Date.now (D-T38-2)", () => {
    const max = "+275760-09-13T00:00:00.000Z";
    expect(estimateDelivery(NEXT_DAY, 8.64e15)).toEqual({ start: max, end: max });
    expect(estimateDelivery(STANDARD, 8.64e15 - 86_400_000 * 3)).toEqual({ start: max, end: max });
    expect(estimateDelivery(NEXT_DAY, -8.64e15).start).toMatch(/T00:00:00\.000Z$/);
    const fromNow = estimateDelivery(STANDARD, Date.now());
    for (const badNow of [Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1, undefined]) {
      expect(estimateDelivery(STANDARD, "garbage", badNow)).toEqual(fromNow);
    }
    expect(estimateDelivery(STANDARD, 8.64e15 + 1, Date.parse("2026-11-06T10:00:00.000Z"))).toEqual({ start: day("2026-11-13"), end: day("2026-11-18") });
  });

  test("invalid day counts throw RangeError", () => {
    expect(() => estimateDelivery({ minDays: -1, maxDays: 1 }, 0)).toThrow(RangeError);
    expect(() => estimateDelivery({ minDays: 3, maxDays: 2 }, 0)).toThrow(RangeError);
    expect(() => estimateDelivery({ minDays: 1.5, maxDays: 2 }, 0)).toThrow(RangeError);
    expect(() => estimateDelivery({ minDays: 0, maxDays: 366 }, 0)).toThrow(RangeError);
  });

  test("works with a seeded method", () => {
    const m = svc.getMethod("standard");
    expect(m).not.toBeNull();
    if (m !== null) expect(estimateDelivery(m, "2026-11-04T00:00:00.000Z")).toEqual({ start: day("2026-11-11"), end: day("2026-11-16") });
  });
});
