import type { AppError, Result } from "@/lib/result";

/**
 * Contract between cart molecules (client) and cart server actions (T12).
 *
 * Server actions implementing `CartActionFn` MUST:
 * - Read fields by the `CART_FIELD` names. `FormData` values are strings (or
 *   `File`/null): parse them explicitly (e.g. digits-only -> integer) BEFORE
 *   calling `validateQuantity`, which accepts numbers only. Reject anything
 *   that is not a string with `INVALID_INPUT`.
 * - NEVER accept a price, subtotal or session id from the client. Prices come
 *   from the catalogue; the session comes from the server-side cookie.
 * - Return plain, JSON-serializable data (`Result` of `CartActionSuccess` or
 *   `AppError`) and never throw for expected failures (stock, validation).
 *   `AppError.message` is shown verbatim to the shopper.
 * - Revalidate the cart-dependent paths themselves on success.
 *
 * Field usage per server action (molecule prop name in brackets):
 * - addToCart          [AddToCartForm.addToCart]:     productId, quantity (quantity to ADD, >= 1)
 * - updateCartQuantity [CartLineItem.updateQuantity]: productId, quantity (new absolute quantity, >= 1)
 * - removeFromCart     [CartLineItem.removeItem]:     productId
 *
 * Announcements: `CartActionSuccess.message` is announced in a polite live
 * region by AddToCartForm (add) and CartLineItem (update). A successful remove
 * unmounts the line, so the cart organism (CartTable) announces that change in
 * its own live region.
 */

/** Summary returned on success; `message` is announced in a polite live region. */
export type CartActionSuccess = {
  readonly itemCount: number;
  readonly subtotalCents: number;
  readonly message: string;
};

/** `null` = not yet submitted. */
export type CartActionState = Result<CartActionSuccess, AppError> | null;

/** Signature for `useActionState`. */
export type CartActionFn = (
  prevState: CartActionState,
  formData: FormData,
) => Promise<CartActionState>;

/** Form field names posted by the cart molecules. */
export const CART_FIELD = {
  productId: "productId",
  quantity: "quantity",
} as const;

export type CartFieldName = (typeof CART_FIELD)[keyof typeof CART_FIELD];

export const initialCartActionState: CartActionState = null;

/**
 * Normalises a stock count from props: NaN, +/-Infinity, non-integers and
 * negatives all become 0 (out of stock), matching StockBadge.
 */
export function normalizeStock(stock: number): number {
  return Number.isFinite(stock) && Number.isInteger(stock) ? Math.max(0, stock) : 0;
}

// ===========================================================================
// Cart actions v2 (T56): save for later, promo codes, shipping method, Buy Now.
// Consumed by BuyBox (T78), CouponForm / ShippingMethodPicker (T73),
// CartTable v2 (T82) and CartSummary (T92). Additive only: every MVP export
// above keeps its name and shape.
//
// Field usage per server action (all in `src/app/actions/cart.ts`):
// - saveForLater         : productId (moves the cart line to Saved for later)
// - moveToCart           : productId (moves a saved item back into the cart)
// - applyCoupon          : couponCode (1-32 of [A-Za-z0-9_-], case-insensitive)
// - removeCoupon         : (no fields)
// - selectShippingMethod : shippingMethodId
// - buyNow               : productId, quantity (adds, then redirects to /checkout)
// - addManyToCart        : productId repeated (one per checked item; 1 unit each;
//                          deduped, first 10 valid ids). Success carries `perItem`.
//
// Rules (same as v1 plus):
// - The owner key comes from the server-side cookie. Only the add actions
//   (`buyNow`, `addManyToCart`) may create the session cookie; the other v2
//   actions never do. With no cookie they return an empty success
//   (`itemCount: 0`, no `kind`) and write nothing,
//   except `applyCoupon`, which returns the generic invalid-code error.
// - `sessionId`, prices, `discount`, `shipping` and `total` fields are never read.
// - `applyCoupon` is rate limited (10 per 10 minutes per session, 1000 per
//   10 minutes overall): RATE_LIMITED carries `details.retryAfterSeconds`.
//   Every invalid or unknown code yields the SAME error (COUPON_INVALID,
//   "That promo code is not valid.", `details.field = "couponCode"`).
//   COUPON_EXPIRED / COUPON_EXHAUSTED / COUPON_USED / COUPON_MIN_SUBTOTAL
//   (`details.shortfallCents`, `details.minSubtotalCents`) have their own
//   user-safe messages. On any error the applied coupon is unchanged.
// - `buyNow` never redirects on error: it returns the typed error state. On
//   success it throws Next's redirect to `/checkout` (never resolves).
// - Unexpected server faults return INTERNAL_ERROR with a generic message.
// - Successful v2 mutations return `totals` (recomputed server-side) and `kind`.
// ===========================================================================

/** Form field names posted by v2 cart forms (superset of `CART_FIELD`). */
export const CART_FIELD_V2 = {
  ...CART_FIELD,
  couponCode: "couponCode",
  shippingMethodId: "shippingMethodId",
} as const;

export type CartFieldNameV2 = (typeof CART_FIELD_V2)[keyof typeof CART_FIELD_V2];

/** Server-computed totals after a v2 mutation. `shippingMethodId` is the method in effect (selected, else the cheapest). */
export interface CartTotalsSummary {
  readonly itemCount: number;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly shippingCents: number;
  readonly totalCents: number;
  readonly couponCode: string | null;
  readonly shippingMethodId: string | null;
}

export type CartActionKind =
  | "saved"
  | "moved"
  | "coupon_applied"
  | "coupon_removed"
  | "shipping_selected"
  | "added_many";

/** Outcome per posted product for `addManyToCart` ("capped" = the cart already holds the stock or quantity limit). */
export interface CartPerItemResult {
  readonly productId: string;
  readonly result: "added" | "out_of_stock" | "capped" | "unavailable";
}

/** Maximum distinct product ids `addManyToCart` processes per post. */
export const ADD_MANY_MAX_ITEMS = 10;

/** Superset of `CartActionState`, so v1 consumers compile against v2 actions. `null` = not yet submitted. */
export type CartActionStateV2 = Result<
  CartActionSuccess & {
    readonly totals?: CartTotalsSummary;
    readonly kind?: CartActionKind;
    /** `addManyToCart` only, in posted order. */
    readonly perItem?: readonly CartPerItemResult[];
  },
  AppError
> | null;

/** Signature for `useActionState` with the v2 actions. */
export type CartActionFnV2 = (prev: CartActionStateV2, formData: FormData) => Promise<CartActionStateV2>;

export const initialCartActionStateV2: CartActionStateV2 = null;

/** Maximum promo code length (mirror as `maxLength` on the input). */
export const COUPON_CODE_MAX_LENGTH = 32;
