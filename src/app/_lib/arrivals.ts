import type { ShippingArrival } from "@/components/molecules/ShippingMethodPicker";
import type { CartViewV2 } from "@/server/cart/cart-service";
import { estimateDelivery } from "@/server/pricing/shipping-service";

/** Quoted shipping options as returned on the v2 cart view. */
export type QuotedShippingOptions = CartViewV2["shippingOptions"];

/**
 * Arrival windows for every quoted shipping method, keyed by method id, all
 * computed from the same `now` (epoch ms; the caller reads the clock once per
 * request). A method whose day counts are impossible (`estimateDelivery`
 * throws a RangeError) is skipped, so the picker shows it without an arrival
 * instead of breaking the page. Shared by the `/cart` (T108) and `/checkout`
 * (T109) loaders (CONS-B4 aq).
 */
export function computeArrivals(
  options: QuotedShippingOptions,
  now: number,
): Readonly<Record<string, ShippingArrival>> {
  const out: Record<string, ShippingArrival> = {};
  for (const option of options) {
    try {
      const estimate = estimateDelivery(option.method, now, now);
      out[option.method.id] = { start: estimate.start, end: estimate.end };
    } catch {
      // RangeError for impossible minDays/maxDays: show the method without an arrival.
    }
  }
  return out;
}
