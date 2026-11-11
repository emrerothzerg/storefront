import { describe, expect, test } from "bun:test";

import { computeArrivals as cartComputeArrivals } from "@/app/cart/_lib/load-cart-page";
import { computeCheckoutArrivals } from "@/app/checkout/_lib/load-checkout-page";
import type { ShippingMethod } from "@/lib/types";
import { estimateDelivery, type ShippingQuote } from "@/server/pricing/shipping-service";

import { computeArrivals } from "./arrivals";

// Wednesday 2026-11-04 10:00 UTC.
const NOW = Date.UTC(2026, 10, 4, 10, 0, 0);

function quote(id: string, minDays: number, maxDays: number): ShippingQuote {
  const method: ShippingMethod = {
    id,
    name: `Method ${id}`,
    description: "",
    priceCents: 499,
    freeOverCents: null,
    minDays,
    maxDays,
    sortOrder: 0,
    isActive: true,
  };
  return { method, priceCents: 499, isFree: false, amountToFreeCents: null };
}

describe("computeArrivals (shared by /cart and /checkout)", () => {
  test("empty options -> empty record", () => {
    expect(computeArrivals([], NOW)).toEqual({});
  });

  test("one window per method id, equal to estimateDelivery(method, now, now)", () => {
    const options = [quote("standard", 3, 5), quote("express", 1, 2)];
    const arrivals = computeArrivals(options, NOW);
    expect(Object.keys(arrivals).sort()).toEqual(["express", "standard"]);
    for (const option of options) {
      const expected = estimateDelivery(option.method, NOW, NOW);
      expect(arrivals[option.method.id]).toEqual({ start: expected.start, end: expected.end });
    }
  });

  test("methods with impossible day counts are skipped, the rest kept", () => {
    const arrivals = computeArrivals(
      [quote("ok", 1, 3), quote("inverted", 5, 1), quote("fraction", 1.5, 3), quote("huge", 0, 9999), quote("negative", -1, 2)],
      NOW,
    );
    expect(Object.keys(arrivals)).toEqual(["ok"]);
  });

  test("deterministic for the same now", () => {
    const options = [quote("standard", 3, 5)];
    expect(computeArrivals(options, NOW)).toEqual(computeArrivals(options, NOW));
  });

  test("both loaders expose the same function (behaviour identical by construction)", () => {
    expect(cartComputeArrivals).toBe(computeArrivals);
    expect(computeCheckoutArrivals).toBe(computeArrivals);
  });
});
