import { describe, expect, test } from "bun:test";
import {
  checkOrderSummaryTotal,
  computeOrderSummaryTotal,
  formatPlacedDate,
  formatStatus,
  nonEmpty,
  normaliseLast4,
  toDisplayAmount,
  toDisplayQuantity,
} from "./order-summary-helpers";

const MAX = Number.MAX_SAFE_INTEGER;

describe("toDisplayAmount", () => {
  test.each([
    [0, 0],
    [-0, 0],
    [1999, 1999],
    [MAX, MAX],
  ])("valid %p -> %p", (input, cents) => {
    expect(toDisplayAmount(input)).toEqual({ kind: "ok", cents });
    expect(Object.is((toDisplayAmount(input) as { cents: number }).cents, -0)).toBe(false);
  });

  test.each([Number.NaN, -1, 12.5, Number.NEGATIVE_INFINITY, "100", null, undefined, {}])(
    "invalid %p -> 0",
    (input) => {
      expect(toDisplayAmount(input)).toEqual({ kind: "ok", cents: 0 });
    },
  );

  test.each([Number.POSITIVE_INFINITY, MAX + 1, 2 ** 60])("overflow %p -> unavailable", (input) => {
    expect(toDisplayAmount(input)).toEqual({ kind: "unavailable" });
  });
});

test("toDisplayQuantity", () => {
  expect(toDisplayQuantity(3)).toBe(3);
  for (const bad of [Number.NaN, -2, 1.5, "2", undefined, Number.POSITIVE_INFINITY]) {
    expect(toDisplayQuantity(bad)).toBe(0);
  }
});

describe("computeOrderSummaryTotal (exact integer math)", () => {
  test("items + shipping − discount", () => {
    const r = computeOrderSummaryTotal({
      items: [
        { unitPriceCents: 1250, quantity: 2 },
        { unitPriceCents: 999, quantity: 3 },
      ],
      shippingCents: 599,
      discountCents: 550,
    });
    expect(r).toEqual({ ok: true, value: 2500 + 2997 + 599 - 550 });
  });

  test("large integers stay exact (no float drift)", () => {
    // 2^52 + 1 style values that a float sum would round.
    const unit = 2 ** 51 + 1;
    const r = computeOrderSummaryTotal({
      items: [
        { unitPriceCents: unit, quantity: 2 },
        { unitPriceCents: 1, quantity: 1 },
      ],
      shippingCents: 2,
      discountCents: 3,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(BigInt(r.value)).toBe(BigInt(unit) * 2n + 1n + 2n - 3n);
      expect(Number.isSafeInteger(r.value)).toBe(true);
    }
  });

  test("exactly MAX_SAFE_INTEGER is fine; one more overflows", () => {
    expect(computeOrderSummaryTotal({ items: [{ unitPriceCents: MAX - 1, quantity: 1 }], shippingCents: 1 })).toEqual(
      { ok: true, value: MAX },
    );
    const over = computeOrderSummaryTotal({ items: [{ unitPriceCents: MAX, quantity: 1 }], shippingCents: 1 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe("MONEY_OVERFLOW");
  });

  test("line overflow and invalid inputs are errors, never throw", () => {
    const line = computeOrderSummaryTotal({ items: [{ unitPriceCents: MAX, quantity: 3 }], shippingCents: 0 });
    expect(!line.ok && line.error.code).toBe("MONEY_OVERFLOW");
    const bad = computeOrderSummaryTotal({ items: [{ unitPriceCents: Number.NaN, quantity: 1 }], shippingCents: 0 });
    expect(!bad.ok && bad.error.code).toBe("INVALID_INPUT");
    const badDiscount = computeOrderSummaryTotal({ items: [], shippingCents: 0, discountCents: -5 });
    expect(!badDiscount.ok && badDiscount.error.code).toBe("INVALID_INPUT");
  });

  test("discount larger than items + shipping clamps to 0; no items -> shipping", () => {
    expect(computeOrderSummaryTotal({ items: [{ unitPriceCents: 100, quantity: 1 }], shippingCents: 0, discountCents: 500 })).toEqual({ ok: true, value: 0 });
    expect(computeOrderSummaryTotal({ items: [], shippingCents: 499 })).toEqual({ ok: true, value: 499 });
  });

  test("checkOrderSummaryTotal", () => {
    const input = { items: [{ unitPriceCents: 1000, quantity: 1 }], shippingCents: 0, discountCents: 100 };
    expect(checkOrderSummaryTotal(input, 900)).toBe("match");
    expect(checkOrderSummaryTotal(input, 1000)).toBe("mismatch");
    expect(checkOrderSummaryTotal({ ...input, shippingCents: Number.NaN }, 900)).toBe("unavailable");
  });
});

describe("formatting helpers", () => {
  test("formatPlacedDate en-US UTC", () => {
    expect(formatPlacedDate("2026-11-07T23:30:00-05:00")).toBe("November 8, 2026");
    expect(formatPlacedDate("2026-11-07T00:00:00Z")).toBe("November 7, 2026");
    for (const bad of ["", "nope", 5, null]) expect(formatPlacedDate(bad)).toBeNull();
  });

  test("formatStatus, normaliseLast4, nonEmpty", () => {
    expect(formatStatus("payment_failed")).toBe("Payment failed");
    expect(formatStatus("paid")).toBe("Paid");
    expect(formatStatus("  _ ")).toBeNull();
    expect(formatStatus(3)).toBeNull();
    expect(normaliseLast4("4242")).toBe("4242");
    for (const bad of ["424", "42424", "abcd", null, undefined, 4242]) expect(normaliseLast4(bad)).toBeNull();
    expect(nonEmpty("  x ")).toBe("x");
    expect(nonEmpty("   ")).toBeNull();
    expect(nonEmpty(undefined)).toBeNull();
  });
});
