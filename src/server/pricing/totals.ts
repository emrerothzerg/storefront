import { addCents } from "@/lib/money";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import type { ShippingMethod } from "@/lib/types";
import type { ValidatedCoupon } from "./coupon-service";
import type { ShippingQuote } from "./shipping-service";

/**
 * Pure order-totals arithmetic (no DB, no clock). Integer cents only; no tax
 * (BACKLOG-phase2 D3).
 *
 * Rules (fixed by the orchestrator):
 * - percent: discount = floor(subtotal * pct / 100), capped at subtotal (exact
 *   for every safe integer: computed with BigInt).
 * - fixed: discount = min(value, subtotal).
 * - free_shipping: discount 0, shipping 0.
 * - shipping is re-derived from `shipping.method` and THIS subtotal
 *   (`subtotal >= freeOverCents` -> 0, equality counts), so a quote computed
 *   for an older subtotal cannot leak a stale price.
 * - total = subtotal - discount + shipping, never negative.
 */

export interface TotalsInput {
  readonly subtotalCents: number;
  readonly coupon?: ValidatedCoupon | null;
  readonly shipping?: ShippingQuote | null;
}

export interface Totals {
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly shippingCents: number;
  readonly totalCents: number;
  /** Amount still needed for free shipping on the chosen method; 0 at/above the threshold or with a free-shipping coupon; null when no method or the method has no threshold. */
  readonly amountToFreeShippingCents: number | null;
}

/**
 * Validates an amount in cents: INVALID_INPUT for non-numbers, NaN, floats
 * and negatives; MONEY_OVERFLOW for integers (or +Infinity) beyond
 * Number.MAX_SAFE_INTEGER.
 */
export function checkCents(name: string, value: unknown): Result<number, AppError> {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fail("INVALID_INPUT", `${name} must be a non-negative integer`, { field: name });
  }
  if (value === Number.POSITIVE_INFINITY) {
    return fail("MONEY_OVERFLOW", `${name} exceeds the maximum safe amount`, { field: name, max: Number.MAX_SAFE_INTEGER });
  }
  if (!Number.isInteger(value) || value < 0) {
    return fail("INVALID_INPUT", `${name} must be a non-negative integer`, { field: name });
  }
  if (!Number.isSafeInteger(value)) {
    return fail("MONEY_OVERFLOW", `${name} exceeds the maximum safe amount`, { field: name, max: Number.MAX_SAFE_INTEGER });
  }
  return ok(Object.is(value, -0) ? 0 : value);
}

/** Shipping price for a method at a subtotal: 0 when `subtotal >= freeOverCents`. Inputs must already be valid cents. */
export function shippingPriceFor(method: Pick<ShippingMethod, "priceCents" | "freeOverCents">, subtotalCents: number): number {
  if (method.freeOverCents !== null && subtotalCents >= method.freeOverCents) return 0;
  return method.priceCents;
}

/** `max(0, threshold - subtotal)`, null when there is no threshold. */
export function amountToFreeFor(method: Pick<ShippingMethod, "freeOverCents">, subtotalCents: number): number | null {
  if (method.freeOverCents === null) return null;
  return Math.max(0, method.freeOverCents - subtotalCents);
}

/** Discount for a coupon at a subtotal (both already validated). */
export function discountFor(coupon: Pick<ValidatedCoupon, "kind" | "value">, subtotalCents: number): number {
  switch (coupon.kind) {
    case "percent": {
      const raw = Number((BigInt(subtotalCents) * BigInt(coupon.value)) / BigInt(100));
      return Math.min(raw, subtotalCents);
    }
    case "fixed":
      return Math.min(coupon.value, subtotalCents);
    case "free_shipping":
      return 0;
  }
}

function checkCoupon(coupon: unknown): Result<ValidatedCoupon | null, AppError> {
  if (coupon === undefined || coupon === null) return ok(null);
  if (typeof coupon !== "object") return fail("INVALID_INPUT", "coupon is malformed", { field: "coupon" });
  const c = coupon as Partial<Record<keyof ValidatedCoupon, unknown>>;
  const value = c.value;
  const isInt = typeof value === "number" && Number.isSafeInteger(value);
  const valid =
    (c.kind === "percent" && isInt && value >= 1 && value <= 100) ||
    (c.kind === "fixed" && isInt && value > 0) ||
    (c.kind === "free_shipping" && value === 0);
  if (!valid) return fail("INVALID_INPUT", "coupon is malformed", { field: "coupon" });
  return ok(coupon as ValidatedCoupon);
}

function checkMethod(shipping: unknown): Result<ShippingMethod | null, AppError> {
  if (shipping === undefined || shipping === null) return ok(null);
  const method = typeof shipping === "object" ? (shipping as { method?: unknown }).method : undefined;
  if (typeof method !== "object" || method === null) {
    return fail("INVALID_INPUT", "shipping is malformed", { field: "shipping" });
  }
  const m = method as Partial<Record<keyof ShippingMethod, unknown>>;
  const price = checkCents("shipping.method.priceCents", m.priceCents);
  if (!price.ok) return price;
  if (m.freeOverCents !== null) {
    const threshold = checkCents("shipping.method.freeOverCents", m.freeOverCents);
    if (!threshold.ok) return threshold;
  }
  return ok(method as ShippingMethod);
}

/** Computes totals. Never throws; see module doc for the rules. */
export function computeTotals(input: TotalsInput): Result<Totals, AppError> {
  if (typeof input !== "object" || input === null) {
    return fail("INVALID_INPUT", "totals input is malformed");
  }
  const subtotal = checkCents("subtotalCents", input.subtotalCents);
  if (!subtotal.ok) return subtotal;
  const coupon = checkCoupon(input.coupon);
  if (!coupon.ok) return coupon;
  const method = checkMethod(input.shipping);
  if (!method.ok) return method;

  const subtotalCents = subtotal.value;
  const discountCents = coupon.value === null ? 0 : discountFor(coupon.value, subtotalCents);
  const freeShippingCoupon = coupon.value?.kind === "free_shipping";

  let shippingCents = 0;
  let amountToFreeShippingCents: number | null = null;
  if (method.value !== null) {
    shippingCents = freeShippingCoupon ? 0 : shippingPriceFor(method.value, subtotalCents);
    amountToFreeShippingCents = freeShippingCoupon ? 0 : amountToFreeFor(method.value, subtotalCents);
  }

  const total = addCents(subtotalCents - discountCents, shippingCents);
  if (!total.ok) return total;

  return ok({
    subtotalCents,
    discountCents,
    shippingCents,
    totalCents: total.value,
    amountToFreeShippingCents,
  });
}
