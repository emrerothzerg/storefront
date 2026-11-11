import { formatMoney } from "@/lib/money";
import { isAllowedInternalHref } from "@/content/routes";
import type { CartLineView, CartViewV2 } from "@/server/cart/cart-service";
import type { ValidatedCoupon } from "@/server/pricing/coupon-service";
import {
  computeOrderSummaryTotal,
  toDisplayQuantity,
  type OrderSummaryTotalInput,
  type TotalCheck,
} from "../OrderSummary/order-summary-helpers";

/**
 * Pure helpers for CartSummary (T92). No server runtime imports: the cart
 * view types are type-only.
 */

/** Line fields CartSummary reads. A full `CartLineView` fits. */
export type CartSummaryLine = Pick<CartLineView, "productId" | "quantity" | "unitPriceCents" | "status" | "availableStock">;

/**
 * The slice of `CartViewV2` CartSummary reads. The full view returned by
 * `getCartView` fits as is; a page may also pass a trimmed copy (no
 * `sessionId`). `saved` is only counted.
 */
export interface CartSummaryCart {
  readonly items: readonly CartSummaryLine[];
  readonly itemCount: number;
  readonly canCheckout: boolean;
  readonly currency?: string;
  readonly saved: readonly unknown[];
  readonly coupon: Pick<ValidatedCoupon, "code" | "description"> | null;
  readonly couponNotice: string | null;
  readonly shipping: CartViewV2["shipping"];
  readonly shippingOptions: CartViewV2["shippingOptions"];
  readonly totals: CartViewV2["totals"];
}

export const DEFAULT_CHECKOUT_HREF = "/checkout";
export const DEFAULT_CURRENCY = "USD";

/** Reasons shown (as text, instead of the checkout link) when checkout is blocked. */
export const CHECKOUT_BLOCKED_TEXT = {
  empty: "Your cart is empty",
  allUnavailable: "All items in your cart are out of stock — remove them to continue",
  someUnavailable: "Some items are out of stock — remove them to continue",
  reduced: "Some quantities are more than we have in stock — update them to continue",
  unknown: "Checkout is not available right now",
} as const;

export type CheckoutBlockedReason = keyof typeof CHECKOUT_BLOCKED_TEXT;

/** "1 item", "0 items", "3 items". Invalid counts read as 0. */
export function itemCountLabel(count: unknown): string {
  const n = toDisplayQuantity(count);
  return `${n} ${n === 1 ? "item" : "items"}`;
}

/** "Subtotal (1 item)". */
export function subtotalLabel(count: unknown): string {
  return `Subtotal (${itemCountLabel(count)})`;
}

function safeItems(cart: CartSummaryCart): readonly CartSummaryLine[] {
  return Array.isArray(cart.items) ? cart.items : [];
}

function savedCount(cart: CartSummaryCart): number {
  return Array.isArray(cart.saved) ? cart.saved.length : 0;
}

/** Nothing in the cart and nothing saved: the organism renders nothing. */
export function isCartSummaryEmpty(cart: CartSummaryCart): boolean {
  return safeItems(cart).length === 0 && savedCount(cart) === 0;
}

export type CheckoutState =
  | { readonly canCheckout: true }
  | { readonly canCheckout: false; readonly reason: CheckoutBlockedReason; readonly text: string };

function blocked(reason: CheckoutBlockedReason): CheckoutState {
  return { canCheckout: false, reason, text: CHECKOUT_BLOCKED_TEXT[reason] };
}

/**
 * Checkout is offered only when the service says so AND every line is "ok"
 * (the UI's stricter rule, same as CartTable: a reduced line would fail at
 * checkout with STOCK_CHANGED). Otherwise the reason is derived from the
 * cart state (the view carries no reason field).
 */
export function checkoutState(cart: CartSummaryCart): CheckoutState {
  const items = safeItems(cart);
  if (items.length === 0) return blocked("empty");
  const unavailable = items.filter((line) => line.status === "unavailable").length;
  if (unavailable === items.length) return blocked("allUnavailable");
  if (unavailable > 0) return blocked("someUnavailable");
  if (items.some((line) => line.status !== "ok")) return blocked("reduced");
  if (cart.canCheckout !== true) return blocked("unknown");
  return { canCheckout: true };
}

function normaliseStock(stock: unknown): number {
  return typeof stock === "number" && Number.isSafeInteger(stock) ? Math.max(0, stock) : 0;
}

/** Quantity the shopper is charged for: min(quantity, stock); 0 for unavailable lines (mirrors the service's `lineTotalCents`). */
export function billableLineQuantity(line: CartSummaryLine): number {
  if (line.status === "unavailable") return 0;
  return Math.min(toDisplayQuantity(line.quantity), normaliseStock(line.availableStock));
}

/**
 * Lines as OrderSummary sees them (billable quantities), so both organisms
 * total the same input. Additive (D-T92-1): every line field is kept (so a
 * `CartLineView` keeps `name` and fits `OrderSummaryLine` as is); only
 * `quantity` is replaced by `billableLineQuantity`.
 */
export function toOrderSummaryItems<L extends CartSummaryLine>(cart: {
  readonly items: readonly L[];
}): Array<Omit<L, "quantity"> & { readonly quantity: number }> {
  const items: readonly L[] = Array.isArray(cart.items) ? cart.items : [];
  return items.map((line) => ({ ...line, quantity: billableLineQuantity(line) }));
}

/** The exact `computeOrderSummaryTotal` input for this cart. */
export function toOrderSummaryTotalInput(cart: CartSummaryCart): OrderSummaryTotalInput {
  return {
    items: toOrderSummaryItems(cart),
    shippingCents: cart.totals.shippingCents,
    discountCents: cart.totals.discountCents,
  };
}

/** "match" when the server total equals the OrderSummary recomputation. */
export function cartSummaryTotalCheck(cart: CartSummaryCart): TotalCheck {
  const computed = computeOrderSummaryTotal(toOrderSummaryTotalInput(cart));
  if (!computed.ok) return "unavailable";
  return computed.value === cart.totals.totalCents ? "match" : "mismatch";
}

/** Prop currency, else the cart's, else USD; an unknown ISO code falls back to USD. */
export function resolveCurrency(prop: string | undefined, cartCurrency: string | undefined): string {
  for (const candidate of [prop, cartCurrency]) {
    if (typeof candidate !== "string" || candidate.trim() === "") continue;
    try {
      formatMoney(0, candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return DEFAULT_CURRENCY;
}

/** `href` when it passes `isAllowedInternalHref`, else "/checkout". */
export function resolveCheckoutHref(href: string | undefined): string {
  return typeof href === "string" && isAllowedInternalHref(href) ? href : DEFAULT_CHECKOUT_HREF;
}

/** Trimmed non-empty string, else null. */
export function nonBlank(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}
