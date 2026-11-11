import { describe, expect, test } from "bun:test";
import type { ShippingMethod } from "@/lib/types";
import type { ValidatedCoupon } from "./coupon-service";
import type { ShippingQuote } from "./shipping-service";
import { computeTotals, discountFor } from "./totals";

const STANDARD: ShippingMethod = {
  id: "standard", name: "Standard", description: "", priceCents: 499, freeOverCents: 3500, minDays: 5, maxDays: 8, sortOrder: 1, isActive: true,
};
const EXPRESS: ShippingMethod = { ...STANDARD, id: "express", priceCents: 999, freeOverCents: null };

function quote(method: ShippingMethod, priceCents = method.priceCents): ShippingQuote {
  return { method, priceCents, isFree: priceCents === 0, amountToFreeCents: null };
}
function coupon(kind: ValidatedCoupon["kind"], value: number): ValidatedCoupon {
  return { code: "X", kind, value, promoted: false, description: "" };
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

/** Deterministic PRNG (mulberry32) so the property test is reproducible. */
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

describe("computeTotals", () => {
  test("subtotal only", () => {
    expect(unwrap(computeTotals({ subtotalCents: 1234 }))).toEqual({
      subtotalCents: 1234, discountCents: 0, shippingCents: 0, totalCents: 1234, amountToFreeShippingCents: null,
    });
  });

  test("percent discount floors and caps", () => {
    expect(unwrap(computeTotals({ subtotalCents: 999, coupon: coupon("percent", 10) })).discountCents).toBe(99);
    expect(unwrap(computeTotals({ subtotalCents: 1, coupon: coupon("percent", 99) })).discountCents).toBe(0);
    const full = unwrap(computeTotals({ subtotalCents: 5000, coupon: coupon("percent", 100) }));
    expect(full.discountCents).toBe(5000);
    expect(full.totalCents).toBe(0);
  });

  test("percent exact at MAX_SAFE_INTEGER (BigInt arithmetic)", () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(discountFor(coupon("percent", 33), max)).toBe(Number((BigInt(max) * 33n) / 100n));
  });

  test("fixed is capped at subtotal; total never negative", () => {
    const r = unwrap(computeTotals({ subtotalCents: 300, coupon: coupon("fixed", 500), shipping: quote(EXPRESS) }));
    expect(r.discountCents).toBe(300);
    expect(r.totalCents).toBe(999);
    expect(unwrap(computeTotals({ subtotalCents: 0, coupon: coupon("fixed", 500) })).totalCents).toBe(0);
  });

  test("free_shipping: discount 0, shipping 0", () => {
    const r = unwrap(computeTotals({ subtotalCents: 2000, coupon: coupon("free_shipping", 0), shipping: quote(EXPRESS) }));
    expect(r).toEqual({ subtotalCents: 2000, discountCents: 0, shippingCents: 0, totalCents: 2000, amountToFreeShippingCents: 0 });
  });

  test("free threshold: equality counts, amountToFree", () => {
    expect(unwrap(computeTotals({ subtotalCents: 3499, shipping: quote(STANDARD) }))).toMatchObject({ shippingCents: 499, amountToFreeShippingCents: 1, totalCents: 3998 });
    expect(unwrap(computeTotals({ subtotalCents: 3500, shipping: quote(STANDARD) }))).toMatchObject({ shippingCents: 0, amountToFreeShippingCents: 0, totalCents: 3500 });
    expect(unwrap(computeTotals({ subtotalCents: 9000, shipping: quote(STANDARD) }))).toMatchObject({ shippingCents: 0, amountToFreeShippingCents: 0 });
    expect(unwrap(computeTotals({ subtotalCents: 100, shipping: quote(EXPRESS) })).amountToFreeShippingCents).toBeNull();
  });

  test("threshold uses the pre-discount subtotal", () => {
    const r = unwrap(computeTotals({ subtotalCents: 3500, coupon: coupon("percent", 10), shipping: quote(STANDARD) }));
    expect(r).toMatchObject({ discountCents: 350, shippingCents: 0, totalCents: 3150 });
  });

  test("shipping price is re-derived from the method, not a stale quote price", () => {
    const stale = quote(STANDARD, 0);
    expect(unwrap(computeTotals({ subtotalCents: 1000, shipping: stale })).shippingCents).toBe(499);
  });

  test("invalid integers -> INVALID_INPUT", () => {
    for (const bad of [-1, 1.5, Number.NaN, "100" as unknown as number, null as unknown as number]) {
      const r = computeTotals({ subtotalCents: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
    expect(computeTotals(null as unknown as { subtotalCents: number }).ok).toBe(false);
  });

  test("malformed coupon / shipping -> INVALID_INPUT", () => {
    const cases = [
      computeTotals({ subtotalCents: 100, coupon: coupon("percent", 0) }),
      computeTotals({ subtotalCents: 100, coupon: coupon("percent", 101) }),
      computeTotals({ subtotalCents: 100, coupon: coupon("percent", 10.5) }),
      computeTotals({ subtotalCents: 100, coupon: coupon("fixed", -5) }),
      computeTotals({ subtotalCents: 100, coupon: coupon("free_shipping", 5) }),
      computeTotals({ subtotalCents: 100, coupon: { ...coupon("fixed", 1), kind: "bogus" as "fixed" } }),
      computeTotals({ subtotalCents: 100, shipping: quote({ ...STANDARD, priceCents: -1 }) }),
      computeTotals({ subtotalCents: 100, shipping: { method: null } as unknown as ShippingQuote }),
    ];
    for (const r of cases) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
  });

  test("overflow beyond MAX_SAFE_INTEGER -> MONEY_OVERFLOW", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const over = computeTotals({ subtotalCents: max, shipping: quote(EXPRESS) });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe("MONEY_OVERFLOW");
    for (const bad of [max + 1, 2 ** 60, Number.POSITIVE_INFINITY]) {
      const r = computeTotals({ subtotalCents: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("MONEY_OVERFLOW");
    }
    const unsafeShip = computeTotals({ subtotalCents: 1, shipping: quote({ ...EXPRESS, priceCents: max + 2 }) });
    expect(unsafeShip.ok).toBe(false);
    if (!unsafeShip.ok) expect(unsafeShip.error.code).toBe("MONEY_OVERFLOW");
    expect(unwrap(computeTotals({ subtotalCents: max })).totalCents).toBe(max);
    // A discount brings it back into range.
    expect(unwrap(computeTotals({ subtotalCents: max, coupon: coupon("fixed", 999), shipping: quote(EXPRESS) })).totalCents).toBe(max);
  });

  test("property: 1000 random cases keep total = subtotal - discount + shipping, all integers", () => {
    const next = rng(38);
    const methods = [STANDARD, EXPRESS, { ...STANDARD, id: "free", priceCents: 0, freeOverCents: null }];
    for (let i = 0; i < 1000; i++) {
      const big = next() < 0.1;
      const subtotalCents = Math.floor(next() * (big ? Number.MAX_SAFE_INTEGER / 2 : 200_000));
      const pct = 1 + Math.floor(next() * 100);
      const pick = next();
      const c = pick < 0.6 ? coupon("percent", pct) : pick < 0.8 ? coupon("fixed", 1 + Math.floor(next() * 10_000)) : pick < 0.9 ? coupon("free_shipping", 0) : null;
      const m = next() < 0.8 ? methods[Math.floor(next() * methods.length)] : undefined;
      const r = unwrap(computeTotals({ subtotalCents, coupon: c, shipping: m === undefined ? null : quote(m) }));
      for (const v of [r.subtotalCents, r.discountCents, r.shippingCents, r.totalCents]) {
        expect(Number.isSafeInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(r.totalCents).toBe(r.subtotalCents - r.discountCents + r.shippingCents);
      expect(r.discountCents).toBeLessThanOrEqual(subtotalCents);
      if (c?.kind === "percent") {
        expect(BigInt(r.discountCents)).toBe((BigInt(subtotalCents) * BigInt(pct)) / 100n);
      }
      if (c?.kind === "free_shipping") expect(r.shippingCents).toBe(0);
    }
  });
});
