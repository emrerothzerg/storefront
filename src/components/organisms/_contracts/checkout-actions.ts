import type { AppError } from "@/lib/result";
import type { Address } from "@/lib/types";

/**
 * Contract between the CheckoutForm organism (client) and the checkout server
 * action `placeOrder` (T13).
 *
 * Fields posted (all `FormData` strings):
 * - `CHECKOUT_FIELD.idempotencyKey`: opaque key, one per checkout ATTEMPT. The
 *   client keeps it across network-error retries and replaces it after every
 *   completed attempt. The action MUST treat a repeated key as a replay of the
 *   same attempt (return the same outcome / redirect to the same order) and
 *   never charge twice. Reject a missing/blank key with `INVALID_INPUT`.
 * - Address fields, named by the `Address` keys (rendered by `AddressFields`):
 *   fullName, email, line1, line2, city, region, postalCode, country.
 * - Card fields, named by the `CardInput` keys (rendered by `PaymentFields`):
 *   nameOnCard, number, expMonth, expYear, cvc. `expMonth`/`expYear` arrive as
 *   strings; `validateCard` accepts digit strings.
 * Reject any value that is not a string (e.g. a `File`) with `INVALID_INPUT`.
 *
 * Outcomes:
 * - Success: the action calls `redirect()` to the confirmation page and never
 *   returns, so there is no success state.
 * - Expected failures are RETURNED (never thrown) as `CheckoutActionFailure`,
 *   JSON-serializable. `error.message` is shown verbatim to the shopper.
 *   Return `values` (trimmed address + nameOnCard as submitted) so the form can
 *   re-fill them; React resets uncontrolled fields after every completed
 *   submission and re-applies these as `defaultValue`s.
 *
 * Error codes and their `details` shapes:
 * - `VALIDATION_FAILED`: `details.fields: Partial<Record<AddressField | CardField, FieldError>>`
 *   (merge `validateAddress` and `validateCard` failures so every invalid field
 *   is reported at once).
 * - `PAYMENT_FAILED`: `details: { orderId: string, failureCode: PaymentFailureCode }`;
 *   `message` is the provider's shopper-safe message.
 * - `STOCK_CHANGED`: `details.lines: Array<{ productId: string, name: string,
 *   requested: number, available: number }>` (`available` 0 = no longer sold).
 * - `EMPTY_CART`: no details.
 * - `INVALID_INPUT`: no details (malformed post, missing idempotency key...).
 *
 * SECURITY: never echo the card number, expiry or CVC in `values`, `details`
 * or `message`, and never log them. `CheckoutRetainedValues` has no slot for
 * them on purpose. Never accept prices, totals or the session id from the form.
 */

/** Values the form re-fills after a failed attempt. Never card number/expiry/CVC. */
export type CheckoutRetainedValues = Partial<Address> & { readonly nameOnCard?: string };

export type CheckoutActionFailure = {
  readonly ok: false;
  readonly error: AppError;
  readonly values?: CheckoutRetainedValues;
};

/** `null` = not yet submitted. Success redirects, so there is no success state. */
export type CheckoutActionState = CheckoutActionFailure | null;

/** Signature for `useActionState`. */
export type CheckoutActionFn = (
  prevState: CheckoutActionState,
  formData: FormData,
) => Promise<CheckoutActionState>;

/** Form field names owned by the checkout form. Address/card names come from the molecules. */
export const CHECKOUT_FIELD = { idempotencyKey: "idempotencyKey" } as const;

export type CheckoutFieldName = (typeof CHECKOUT_FIELD)[keyof typeof CHECKOUT_FIELD];

export const initialCheckoutActionState: CheckoutActionState = null;

// ---------------------------------------------------------------------------
// Checkout v2 (T71): saved/new address, save to address book, shipping
// method, delivery note. Consumed by CheckoutForm v2 (T93) and the checkout
// page (T109). Action: `placeOrderV2` from `@/app/actions/checkout-v2`.
//
// Fields posted IN ADDITION to the MVP fields above (all optional strings; a
// `File` in any checkout field = INVALID_INPUT):
// - `addressMode`: "saved" | "new"; absent or "" = "new" (the MVP shape).
//   Any other value = INVALID_INPUT.
// - "saved": `addressId` (an id from the shopper's own address book) and
//   `email` (saved addresses carry no email). The other address fields and
//   `saveAddress` are ignored. A blank, malformed, unknown or another
//   session's id = `fieldErrors.addressId` ("Choose a saved address."),
//   `error.code` NOT_FOUND, no order.
// - "new": the MVP `AddressFields` (every key required as a string, like the
//   MVP, except `line2`: missing = "") plus optional `phone`. A non-blank
//   `phone` is written to the order and validated up front with the address
//   book's rule whether or not the address is saved (`fieldErrors.phone`,
//   VALIDATION_FAILED); in "saved" mode the order takes the saved address's
//   phone. `saveAddress` = "on" stores the address (with `addressLabel` and
//   `phone`) in the address book AFTER the order succeeded; the label is then
//   validated up front too (`fieldErrors.addressLabel`, VALIDATION_FAILED).
//   A full book / storage failure / rate limit never fails the order: the
//   redirect carries `?notice=<CHECKOUT_NOTICE token>` (fixed tokens only,
//   never user data). An address already in the book is not an error and
//   gives no notice (this also keeps a same-key replay quiet).
// - `shippingMethodId`: absent or "" = the cart's selection (cheapest active
//   method only when the cart has none). Unknown/inactive/malformed =
//   `fieldErrors.shippingMethodId`, `error.code` INVALID_INPUT.
// - `deliveryNote`: at most 200 characters after cleaning (single line,
//   control characters stripped by the order service). Longer =
//   `fieldErrors.deliveryNote`, `error.code` TOO_LONG.
//
// Coupon: taken from the cart, never from the form. A coupon that no longer
// applies FAILS the order (nothing reserved, redeemed or charged) with a
// form-level error: COUPON_INVALID / COUPON_EXPIRED / COUPON_EXHAUSTED /
// COUPON_USED / COUPON_MIN_SUBTOTAL (`details: { shortfallCents,
// minSubtotalCents }` when known) and the pricing service's message.
//
// Everything else is as in the MVP contract: the idempotency-key rule, the
// success redirect to `/orders/<id>` (plus the optional notice param),
// VALIDATION_FAILED (`details.fields`, now mirrored in `fieldErrors`),
// PAYMENT_FAILED, STOCK_CHANGED, EMPTY_CART, MONEY_OVERFLOW.
//
// INTERNAL_ERROR: an unexpected server fault (e.g. the database failed). The
// action still settles, but the attempt's outcome is unknown, so the form
// should KEEP its idempotency key for the retry (same as a network error);
// the retry replays the stored outcome if the first attempt completed.
// ---------------------------------------------------------------------------

export const CHECKOUT_FIELD_V2 = {
  ...CHECKOUT_FIELD,
  /** "saved" | "new" */
  addressMode: "addressMode",
  addressId: "addressId",
  /** Checkbox; value "on". */
  saveAddress: "saveAddress",
  addressLabel: "addressLabel",
  phone: "phone",
  shippingMethodId: "shippingMethodId",
  deliveryNote: "deliveryNote",
} as const;

export type CheckoutFieldNameV2 = (typeof CHECKOUT_FIELD_V2)[keyof typeof CHECKOUT_FIELD_V2];

export const CHECKOUT_ADDRESS_MODES = ["saved", "new"] as const;
export type CheckoutAddressMode = (typeof CHECKOUT_ADDRESS_MODES)[number];

/** `maxLength` values for the v2 inputs (address keys: see `ADDRESS_MAX_LENGTH`). */
export const CHECKOUT_MAX_LENGTH_V2 = {
  deliveryNote: 200,
  addressLabel: 40,
  phone: 20,
} as const;

/** Values the form re-fills after a failed attempt. Never card number/expiry/CVC. */
export interface CheckoutRetainedValuesV2 extends CheckoutRetainedValues {
  readonly addressMode?: CheckoutAddressMode;
  readonly addressId?: string;
  readonly addressLabel?: string;
  readonly phone?: string;
  readonly shippingMethodId?: string;
  readonly deliveryNote?: string;
  readonly saveAddress?: boolean;
}

export interface CheckoutActionFailureV2 {
  readonly ok: false;
  readonly error: AppError;
  readonly values?: CheckoutRetainedValuesV2;
  /** Field name (`CHECKOUT_FIELD_V2` / address / card key) -> user-safe message. */
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /**
   * Non-blocking notices. Reserved: success redirects, so the action
   * currently carries notices in the redirect URL (`CHECKOUT_NOTICE_PARAM`)
   * and never sets this field.
   */
  readonly notices?: readonly string[];
}

/** `null` = not yet submitted. Success redirects, so there is no success state. */
export type CheckoutActionStateV2 = CheckoutActionFailureV2 | null;

export type CheckoutActionFnV2 = (
  prevState: CheckoutActionStateV2,
  formData: FormData,
) => Promise<CheckoutActionStateV2>;

export const initialCheckoutActionStateV2: CheckoutActionStateV2 = null;

/** Query parameter on the success redirect (`/orders/<id>?notice=<token>`). */
export const CHECKOUT_NOTICE_PARAM = "notice";

/** Fixed notice tokens (never user data). */
export const CHECKOUT_NOTICE = {
  /** "Save address" was ticked but the book already holds 10 addresses. */
  addressFull: "address_full",
  /**
   * "Save address" failed for another reason after the order succeeded
   * (storage error, rate limit). Invalid label/phone never get here: they are
   * field errors raised before the order is placed.
   */
  addressNotSaved: "address_not_saved",
} as const;

export type CheckoutNotice = (typeof CHECKOUT_NOTICE)[keyof typeof CHECKOUT_NOTICE];

export const CHECKOUT_NOTICE_MESSAGES: Readonly<Record<CheckoutNotice, string>> = {
  address_full: "Your address book is full, so the address was not saved. Your order was placed.",
  address_not_saved: "We couldn't save the address to your address book. Your order was placed.",
};

/** Reads a `notice` search param; anything that is not a known token is `null`. */
export function parseCheckoutNotice(value: unknown): CheckoutNotice | null {
  const raw = Array.isArray(value) ? (value as readonly unknown[])[0] : value;
  return raw === CHECKOUT_NOTICE.addressFull || raw === CHECKOUT_NOTICE.addressNotSaved ? raw : null;
}
