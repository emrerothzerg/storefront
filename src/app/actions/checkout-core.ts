import {
  CHECKOUT_FIELD,
  CHECKOUT_FIELD_V2,
  CHECKOUT_MAX_LENGTH_V2,
  CHECKOUT_NOTICE,
  CHECKOUT_NOTICE_PARAM,
  type CheckoutActionFn,
  type CheckoutActionFnV2,
  type CheckoutActionFailureV2,
  type CheckoutActionState,
  type CheckoutAddressMode,
  type CheckoutNotice,
  type CheckoutRetainedValues,
  type CheckoutRetainedValuesV2,
} from "@/components/organisms/_contracts/checkout-actions";
import { ADDRESS_MAX_LENGTH } from "@/components/molecules/_contracts/address-actions";
import { appError, fail, ok, type AppError, type Result } from "@/lib/result";
import type { Address, SavedAddress } from "@/lib/types";
import type { AddressField, CardField } from "@/lib/validation";
import { AddressStorageError, parseAddressInput, type AddressService } from "@/server/addresses/address-service";
import type { OrderService, OrderServiceV2 } from "@/server/orders/order-service";
import { limitAction, type RateLimiter } from "@/server/security/rate-limiter";
import { cleanText } from "@/server/security/text-guard";

/**
 * Framework-free checkout action logic (T13). `checkout.ts` wires it to
 * Next.js (`readSessionId`, `createOrderService()`, `redirect`,
 * `revalidatePath`); tests inject fakes. See README.md in this folder.
 *
 * Rules:
 * - Only the idempotency key, the `Address` keys and the `CardInput` keys are
 *   read from the form. Price, totals and session id are never read.
 * - Expected failures are RETURNED as `CheckoutActionFailure` with a
 *   user-safe message; unexpected exceptions propagate.
 * - Card number, expiry and CVC never appear in the returned state and are
 *   never logged.
 */

export interface CheckoutActionDeps {
  /** Reads (never creates) the guest session id. `null` = no session. */
  readonly getSessionId: () => Promise<string | null>;
  readonly orders: Pick<OrderService, "placeOrder">;
  /** Must throw (Next's `redirect`), never return. */
  readonly redirect: (url: string) => never;
  readonly revalidate: (path: string, type?: "page" | "layout") => void;
}

export interface CheckoutActions {
  readonly placeOrder: CheckoutActionFn;
}

export interface ParsedCheckoutForm {
  readonly idempotencyKey: string;
  readonly address: Record<AddressField, string>;
  readonly card: Record<CardField, string>;
}

/** Address fields in form order (the `Address` keys rendered by `AddressFields`). */
export const ADDRESS_FIELDS: readonly AddressField[] = [
  "fullName",
  "email",
  "line1",
  "line2",
  "city",
  "region",
  "postalCode",
  "country",
];

/** Card fields (the `CardInput` keys rendered by `PaymentFields`). */
export const CARD_FIELDS: readonly CardField[] = ["nameOnCard", "number", "expMonth", "expYear", "cvc"];

/** Card fields passed to the validator exactly as posted (no trimming). */
const UNTRIMMED_CARD_FIELDS: ReadonlySet<CardField> = new Set<CardField>(["number", "cvc"]);

export const CHECKOUT_MESSAGES = {
  invalidRequest: "Something was wrong with that request.",
  emptyCart: "Your cart is empty.",
  stockChanged: "Some items in your cart are no longer available in the requested quantity.",
  moneyOverflow: "This order total is too large to process.",
  validationFailed: "Please correct the highlighted fields.",
  paymentFailed: "We couldn't process your payment. Please try again.",
} as const;

function invalidRequest(): Result<never> {
  return fail("INVALID_INPUT", CHECKOUT_MESSAGES.invalidRequest);
}

/** Reads the address and card fields. Every key must be a string (`File`/missing = INVALID_INPUT). */
function parseFields(formData: FormData): Result<Pick<ParsedCheckoutForm, "address" | "card">> {
  const address: Partial<Record<AddressField, string>> = {};
  for (const field of ADDRESS_FIELDS) {
    const raw = formData.get(field);
    if (typeof raw !== "string") return invalidRequest();
    address[field] = raw.trim();
  }
  const card: Partial<Record<CardField, string>> = {};
  for (const field of CARD_FIELDS) {
    const raw = formData.get(field);
    if (typeof raw !== "string") return invalidRequest();
    card[field] = UNTRIMMED_CARD_FIELDS.has(field) ? raw : raw.trim();
  }
  return ok({
    address: address as Record<AddressField, string>,
    card: card as Record<CardField, string>,
  });
}

/** Reads the idempotency key: a string, trimmed, non-empty. Format is checked by the order service. */
function parseIdempotencyKey(formData: FormData): Result<string> {
  const raw = formData.get(CHECKOUT_FIELD.idempotencyKey);
  if (typeof raw !== "string") return invalidRequest();
  const key = raw.trim();
  return key === "" ? invalidRequest() : ok(key);
}

/**
 * Parses a checkout post into the idempotency key plus address and card
 * strings. Extra fields are ignored; `price`, `total` and `sessionId` are
 * never read.
 */
export function parseCheckoutForm(formData: FormData): Result<ParsedCheckoutForm> {
  const fields = parseFields(formData);
  if (!fields.ok) return fields;
  const key = parseIdempotencyKey(formData);
  if (!key.ok) return key;
  return ok({ idempotencyKey: key.value, address: fields.value.address, card: fields.value.card });
}

/** Values the form re-fills after a failure: the address fields and `nameOnCard` ONLY. */
export function toRetainedValues(
  address: Readonly<Record<AddressField, string>>,
  card: Readonly<Record<CardField, string>>,
): CheckoutRetainedValues {
  return {
    fullName: address.fullName,
    email: address.email,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country,
    nameOnCard: card.nameOnCard,
  };
}

function nonEmpty(message: string, fallback: string): string {
  return message.trim() === "" ? fallback : message;
}

/**
 * Keeps `code` and `details`, and ensures a non-empty shopper-facing message.
 * Validation and payment messages from the service are already user-safe.
 */
export function toUserSafeCheckoutError(error: AppError): AppError {
  const message = ((): string => {
    switch (error.code) {
      case "VALIDATION_FAILED":
        return nonEmpty(error.message, CHECKOUT_MESSAGES.validationFailed);
      case "PAYMENT_FAILED":
        return nonEmpty(error.message, CHECKOUT_MESSAGES.paymentFailed);
      case "EMPTY_CART":
        return CHECKOUT_MESSAGES.emptyCart;
      case "STOCK_CHANGED":
        return CHECKOUT_MESSAGES.stockChanged;
      case "MONEY_OVERFLOW":
        return CHECKOUT_MESSAGES.moneyOverflow;
      default:
        return CHECKOUT_MESSAGES.invalidRequest;
    }
  })();
  return appError(error.code, message, error.details);
}

export function createCheckoutActions(deps: CheckoutActionDeps): CheckoutActions {
  const { getSessionId, orders, redirect, revalidate } = deps;

  const placeOrder: CheckoutActionFn = async (_prevState, formData): Promise<CheckoutActionState> => {
    const fields = parseFields(formData);
    if (!fields.ok) return { ok: false, error: fields.error };
    const { address, card } = fields.value;
    const values = toRetainedValues(address, card);

    const key = parseIdempotencyKey(formData);
    if (!key.ok) return { ok: false, error: key.error, values };

    const sessionId = await getSessionId();
    const result = await orders.placeOrder({ sessionId, address, card, idempotencyKey: key.value });
    if (!result.ok) return { ok: false, error: toUserSafeCheckoutError(result.error), values };

    revalidate("/cart");
    revalidate("/", "layout");
    return redirect(`/orders/${encodeURIComponent(result.value.id)}`);
  };

  return { placeOrder };
}

// ===========================================================================
// Checkout v2 (T71): saved or new address (+ optional save to the address
// book), shipping method, delivery note, coupon from the cart. Wired by
// `checkout-v2.ts`. The MVP `createCheckoutActions` above is unchanged.
// ===========================================================================

export interface CheckoutActionDepsV2 {
  /** Reads (never creates) the owner key. `null` = no session. */
  readonly getSessionId: () => Promise<string | null>;
  readonly orders: Pick<OrderServiceV2, "placeOrderV2">;
  readonly addresses: Pick<AddressService, "get" | "create">;
  /** Applied (`address.write`) before saving the address to the book. */
  readonly limiter: RateLimiter;
  /** Must throw (Next's `redirect`), never return. */
  readonly redirect: (url: string) => never;
  readonly revalidate: (path: string, type?: "page" | "layout") => void;
  /** Rethrows framework control-flow errors (the wrapper passes `unstable_rethrow`). */
  readonly rethrow?: (error: unknown) => void;
  /** PII-free log sink (one line per unexpected failure); defaults to `console.error`. */
  readonly logError?: (line: string) => void;
  /** Epoch-ms clock passed to `placeOrderV2`; the service clock when absent. */
  readonly now?: () => number;
}

export interface CheckoutActionsV2 {
  readonly placeOrderV2: CheckoutActionFnV2;
}

/** Logged (with a step name and an error code only) on an unexpected failure. */
export const CHECKOUT_ACTION_FAILED = "CHECKOUT_ACTION_FAILED";

/** Longest `addressId` / `shippingMethodId` forwarded to the services. */
export const CHECKOUT_ID_MAX_LENGTH = 64;

/** Longest email echoed back in `values`. */
const EMAIL_ECHO_MAX = 254;

export const CHECKOUT_MESSAGES_V2 = {
  chooseSavedAddress: "Choose a saved address.",
  savedAddressIncomplete: "This saved address is incomplete. Edit it or enter a new address.",
  shippingInvalid: "Choose a valid shipping method.",
  deliveryNoteTooLong: `Delivery note must be at most ${CHECKOUT_MAX_LENGTH_V2.deliveryNote} characters.`,
  deliveryNoteInvalid: "Enter a valid delivery note.",
  correctFields: "Please correct the highlighted fields.",
  couponFallback: "This promo code can no longer be applied.",
  unexpected: "Something went wrong. Please try again.",
} as const;

/** Every checkout v2 field as read from the form (the idempotency key is parsed separately). */
export interface CheckoutFieldsV2 {
  readonly mode: CheckoutAddressMode;
  /** Trimmed; "" in "new" mode. */
  readonly addressId: string;
  /** "new": every address field (trimmed). "saved": only `email`; the rest are "". */
  readonly address: Readonly<Record<AddressField, string>>;
  readonly card: Readonly<Record<CardField, string>>;
  readonly phone: string;
  readonly addressLabel: string;
  readonly saveAddress: boolean;
  /** Trimmed; "" = use the cart's selection. */
  readonly shippingMethodId: string;
  /** As posted; cleaned by the order service. "" = none. */
  readonly deliveryNote: string;
}

interface CheckoutFieldProblem {
  readonly field: string;
  readonly code: AppError["code"];
  readonly message: string;
}

const COUPON_ERROR_CODES: ReadonlySet<string> = new Set([
  "COUPON_INVALID",
  "COUPON_EXPIRED",
  "COUPON_EXHAUSTED",
  "COUPON_USED",
  "COUPON_MIN_SUBTOTAL",
]);

const CARD_FIELD_SET: ReadonlySet<string> = new Set<string>(CARD_FIELDS);

/** Optional string field: missing = "", a `File` = INVALID_INPUT. */
function optionalString(formData: FormData, name: string): Result<string> {
  const raw = formData.get(name);
  if (raw === null) return ok("");
  return typeof raw === "string" ? ok(raw) : invalidRequest();
}

/**
 * Parses a v2 checkout post (everything except the idempotency key).
 * `addressMode` absent/"" = "new" (MVP shape: every address key required
 * except `line2`, which reads as "" when missing);
 * "saved" reads `addressId` and `email` only. Card fields follow the MVP rules.
 * Unknown `addressMode` or any `File` value = INVALID_INPUT. Price, totals,
 * discount, coupon and session id are never read.
 */
export function parseCheckoutFieldsV2(formData: FormData): Result<CheckoutFieldsV2> {
  const modeRaw = optionalString(formData, CHECKOUT_FIELD_V2.addressMode);
  if (!modeRaw.ok) return modeRaw;
  const modeText = modeRaw.value.trim();
  let mode: CheckoutAddressMode;
  if (modeText === "" || modeText === "new") mode = "new";
  else if (modeText === "saved") mode = "saved";
  else return invalidRequest();

  const address: Record<AddressField, string> = {
    fullName: "",
    email: "",
    line1: "",
    line2: "",
    city: "",
    region: "",
    postalCode: "",
    country: "",
  };
  if (mode === "new") {
    for (const field of ADDRESS_FIELDS) {
      const raw = formData.get(field);
      // line2 is optional: a missing part reads as "" (a File is still rejected).
      if (raw === null && field === "line2") continue;
      if (typeof raw !== "string") return invalidRequest();
      address[field] = raw.trim();
    }
  } else {
    const email = optionalString(formData, "email");
    if (!email.ok) return email;
    address.email = email.value.trim();
  }

  const card: Partial<Record<CardField, string>> = {};
  for (const field of CARD_FIELDS) {
    const raw = formData.get(field);
    if (typeof raw !== "string") return invalidRequest();
    card[field] = UNTRIMMED_CARD_FIELDS.has(field) ? raw : raw.trim();
  }

  const extras: Record<
    "addressId" | "phone" | "addressLabel" | "shippingMethodId" | "deliveryNote" | "saveAddress",
    string
  > = { addressId: "", phone: "", addressLabel: "", shippingMethodId: "", deliveryNote: "", saveAddress: "" };
  for (const name of Object.keys(extras) as (keyof typeof extras)[]) {
    const value = optionalString(formData, CHECKOUT_FIELD_V2[name]);
    if (!value.ok) return value;
    extras[name] = value.value;
  }

  return ok({
    mode,
    addressId: mode === "saved" ? extras.addressId.trim() : "",
    address,
    card: card as Record<CardField, string>,
    phone: extras.phone.trim(),
    addressLabel: extras.addressLabel.trim(),
    saveAddress: mode === "new" && extras.saveAddress === "on",
    shippingMethodId: extras.shippingMethodId.trim(),
    deliveryNote: extras.deliveryNote,
  });
}

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Values the v2 form re-fills after a failure. Never card number, expiry or
 * CVC. Each value is truncated to its input cap.
 */
export function toRetainedValuesV2(fields: CheckoutFieldsV2): CheckoutRetainedValuesV2 {
  const common = {
    addressMode: fields.mode,
    nameOnCard: clip(fields.card.nameOnCard, ADDRESS_MAX_LENGTH.fullName),
    shippingMethodId: clip(fields.shippingMethodId, CHECKOUT_ID_MAX_LENGTH),
    deliveryNote: clip(fields.deliveryNote, CHECKOUT_MAX_LENGTH_V2.deliveryNote),
  };
  const a = fields.address;
  if (fields.mode === "saved") {
    return { ...common, addressId: clip(fields.addressId, CHECKOUT_ID_MAX_LENGTH), email: clip(a.email, EMAIL_ECHO_MAX) };
  }
  return {
    ...common,
    fullName: clip(a.fullName, ADDRESS_MAX_LENGTH.fullName),
    email: clip(a.email, EMAIL_ECHO_MAX),
    line1: clip(a.line1, ADDRESS_MAX_LENGTH.line1),
    line2: clip(a.line2, ADDRESS_MAX_LENGTH.line2),
    city: clip(a.city, ADDRESS_MAX_LENGTH.city),
    region: clip(a.region, ADDRESS_MAX_LENGTH.region),
    postalCode: clip(a.postalCode, ADDRESS_MAX_LENGTH.postalCode),
    country: clip(a.country, ADDRESS_MAX_LENGTH.country),
    phone: clip(fields.phone, CHECKOUT_MAX_LENGTH_V2.phone),
    addressLabel: clip(fields.addressLabel, CHECKOUT_MAX_LENGTH_V2.addressLabel),
    saveAddress: fields.saveAddress,
  };
}

const ADDRESS_NOT_FOUND: CheckoutFieldProblem = {
  field: CHECKOUT_FIELD_V2.addressId,
  code: "NOT_FOUND",
  message: CHECKOUT_MESSAGES_V2.chooseSavedAddress,
};

const SHIPPING_INVALID: CheckoutFieldProblem = {
  field: CHECKOUT_FIELD_V2.shippingMethodId,
  code: "INVALID_INPUT",
  message: CHECKOUT_MESSAGES_V2.shippingInvalid,
};

function deliveryNoteProblem(code: AppError["code"]): CheckoutFieldProblem {
  return code === "TOO_LONG"
    ? { field: CHECKOUT_FIELD_V2.deliveryNote, code: "TOO_LONG", message: CHECKOUT_MESSAGES_V2.deliveryNoteTooLong }
    : { field: CHECKOUT_FIELD_V2.deliveryNote, code: "INVALID_INPUT", message: CHECKOUT_MESSAGES_V2.deliveryNoteInvalid };
}

/**
 * Label and phone rules of the address book, checked before the order when
 * "save address" is ticked (phone only, in "new" mode, when it is not; the
 * rest of the address is validated by the
 * order service). Uses the service's own pure `parseAddressInput` over a
 * placeholder address so only label/phone problems can surface.
 */
function addressBookExtrasProblems(fields: CheckoutFieldsV2): CheckoutFieldProblem[] {
  const probe = parseAddressInput({
    fullName: "x",
    email: undefined,
    line1: "x",
    line2: undefined,
    city: "x",
    region: "x",
    postalCode: "x",
    country: "US",
    label: fields.addressLabel,
    phone: fields.phone,
  });
  if (probe.ok) return [];
  const toField = (key: string): string | null =>
    key === "label" ? CHECKOUT_FIELD_V2.addressLabel : key === "phone" ? CHECKOUT_FIELD_V2.phone : null;
  if (probe.error.code === "TOO_LONG") {
    const field = typeof probe.error.details?.field === "string" ? toField(probe.error.details.field) : null;
    return field === null ? [] : [{ field, code: "TOO_LONG", message: probe.error.message }];
  }
  const problems: CheckoutFieldProblem[] = [];
  for (const [key, message] of Object.entries(fieldMessages(probe.error.details?.fields))) {
    const field = toField(key);
    if (field !== null) problems.push({ field, code: "VALIDATION_FAILED", message });
  }
  return problems;
}

/** Checks that need no session or database. */
export function localCheckoutProblemsV2(fields: CheckoutFieldsV2): readonly CheckoutFieldProblem[] {
  const problems: CheckoutFieldProblem[] = [];
  if (fields.mode === "saved" && (fields.addressId === "" || fields.addressId.length > CHECKOUT_ID_MAX_LENGTH)) {
    problems.push(ADDRESS_NOT_FOUND);
  }
  if (fields.shippingMethodId.length > CHECKOUT_ID_MAX_LENGTH) problems.push(SHIPPING_INVALID);
  if (fields.deliveryNote !== "") {
    const note = cleanText(fields.deliveryNote, { max: CHECKOUT_MAX_LENGTH_V2.deliveryNote });
    if (!note.ok) problems.push(deliveryNoteProblem(note.error.code));
  }
  if (fields.saveAddress) {
    problems.push(...addressBookExtrasProblems(fields));
  } else if (fields.mode === "new" && fields.phone !== "") {
    // The phone goes on the order even when the address is not saved
    // (D-T71-1 ruling): same rule and messages, label ignored.
    problems.push(...addressBookExtrasProblems({ ...fields, addressLabel: "" }));
  }
  return problems;
}

/** `{ field: { message } }` -> `{ field: message }` (non-string messages skipped). */
function fieldMessages(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "object" || value === null) continue;
    const message: unknown = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") out[key] = message;
  }
  return out;
}

function problemsState(
  problems: readonly CheckoutFieldProblem[],
  values: CheckoutRetainedValuesV2,
): CheckoutActionFailureV2 {
  const [first] = problems;
  if (first === undefined) return { ok: false, error: appError("INVALID_INPUT", CHECKOUT_MESSAGES.invalidRequest), values };
  const fieldErrors: Record<string, string> = {};
  for (const problem of problems) fieldErrors[problem.field] ??= problem.message;
  const message = Object.keys(fieldErrors).length === 1 ? first.message : CHECKOUT_MESSAGES_V2.correctFields;
  return { ok: false, error: appError(first.code, message, { field: first.field }), values, fieldErrors };
}

function readSafeCents(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Coupon errors keep code and the pricing service's message; details are whitelisted. */
function toUserSafeCouponError(error: AppError): AppError {
  const message = nonEmpty(error.message, CHECKOUT_MESSAGES_V2.couponFallback);
  if (error.code !== "COUPON_MIN_SUBTOTAL") return appError(error.code, message);
  const details: Record<string, number> = {};
  const shortfallCents = readSafeCents(error.details, "shortfallCents");
  const minSubtotalCents = readSafeCents(error.details, "minSubtotalCents");
  if (shortfallCents !== undefined) details.shortfallCents = shortfallCents;
  if (minSubtotalCents !== undefined) details.minSubtotalCents = minSubtotalCents;
  return Object.keys(details).length === 0 ? appError(error.code, message) : appError(error.code, message, details);
}

/**
 * Maps an order-service error to the v2 failure state: shipping/delivery-note
 * errors become field errors, coupon errors stay form-level with the service
 * message, everything else uses the MVP mapping. VALIDATION_FAILED keeps
 * `details.fields` (MVP shape) and mirrors address problems in `fieldErrors`
 * (card problems stay in `details.fields` only, so no card key ever carries a
 * string in the state).
 */
export function toCheckoutFailureV2(
  error: AppError,
  mode: CheckoutAddressMode,
  values: CheckoutRetainedValuesV2,
): CheckoutActionFailureV2 {
  const field = error.details?.field;
  if (error.code === "INVALID_INPUT" && field === CHECKOUT_FIELD_V2.shippingMethodId) {
    return problemsState([SHIPPING_INVALID], values);
  }
  if ((error.code === "TOO_LONG" || error.code === "INVALID_INPUT") && field === CHECKOUT_FIELD_V2.deliveryNote) {
    return problemsState([deliveryNoteProblem(error.code)], values);
  }
  if (COUPON_ERROR_CODES.has(error.code)) return { ok: false, error: toUserSafeCouponError(error), values };
  // Outcome unknown (e.g. a same-key attempt elsewhere is still pending): the
  // form keeps the idempotency key on INTERNAL_ERROR, so a retry replays it.
  if (error.code === "INTERNAL_ERROR") {
    return { ok: false, error: appError("INTERNAL_ERROR", CHECKOUT_MESSAGES_V2.unexpected), values };
  }

  const safe = toUserSafeCheckoutError(error);
  if (safe.code !== "VALIDATION_FAILED") return { ok: false, error: safe, values };

  const fieldErrors: Record<string, string> = {};
  for (const [key, message] of Object.entries(fieldMessages(safe.details?.fields))) {
    if (CARD_FIELD_SET.has(key)) continue;
    if (mode === "saved" && key !== "email") {
      fieldErrors[CHECKOUT_FIELD_V2.addressId] = CHECKOUT_MESSAGES_V2.savedAddressIncomplete;
    } else {
      fieldErrors[key] = message;
    }
  }
  return Object.keys(fieldErrors).length === 0
    ? { ok: false, error: safe, values }
    : { ok: false, error: safe, values, fieldErrors };
}

/** A saved address plus the posted email becomes the order address. */
function orderAddressFromSaved(saved: SavedAddress, email: string): Address {
  return {
    fullName: saved.fullName,
    email,
    line1: saved.line1,
    ...(saved.line2 === undefined ? {} : { line2: saved.line2 }),
    city: saved.city,
    region: saved.region,
    postalCode: saved.postalCode,
    country: saved.country,
  };
}

/**
 * Expiry month/year as numbers with exactly the string rules of
 * `validateCard` (month: 1-2 digits; year: 2 digits = 20YY, or 4 digits);
 * anything else becomes NaN, which `validateCard` rejects with the same
 * field code. Needed because `PlaceOrderInputV2.card` is typed `CardInput`.
 */
export function toCardInput(card: Readonly<Record<CardField, string>>): {
  readonly number: string;
  readonly expMonth: number;
  readonly expYear: number;
  readonly cvc: string;
  readonly nameOnCard: string;
} {
  const month = card.expMonth.trim();
  const year = card.expYear.trim();
  let expYear = Number.NaN;
  if (/^\d{2}$/.test(year)) expYear = 2000 + Number(year);
  else if (/^\d{4}$/.test(year) && Number(year) >= 1000) expYear = Number(year);
  return {
    number: card.number,
    expMonth: /^\d{1,2}$/.test(month) ? Number(month) : Number.NaN,
    expYear,
    cvc: card.cvc,
    nameOnCard: card.nameOnCard,
  };
}

const LOG_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;

/** Only a code-shaped string from an `AddressStorageError`; never a message. */
function logCode(error: unknown): string {
  return error instanceof AddressStorageError && LOG_CODE_PATTERN.test(error.code) ? error.code : "UNEXPECTED";
}

/** Query flag the order page reads (strictly `placed=1`) to show the confirmation variant. */
export const ORDER_PLACED_PARAM = "placed";

/**
 * Success target of the v2 checkout (FIX-checkout-placed):
 * `/orders/<id>?placed=1`, plus `&notice=<token>` when a notice is set.
 */
export function orderPlacedHref(orderId: string, notice: CheckoutNotice | null): string {
  const query = notice === null ? "" : `&${CHECKOUT_NOTICE_PARAM}=${encodeURIComponent(notice)}`;
  return `/orders/${encodeURIComponent(orderId)}?${ORDER_PLACED_PARAM}=1${query}`;
}

export function createCheckoutActionsV2(deps: CheckoutActionDepsV2): CheckoutActionsV2 {
  const { getSessionId, orders, addresses, limiter, redirect, revalidate } = deps;
  const rethrow = deps.rethrow ?? ((): void => undefined);
  const logError = deps.logError ?? ((line: string): void => console.error(line));

  /** Saves the new address after a successful order. Never throws; returns a notice token or null. */
  function saveToAddressBook(sessionId: string, fields: CheckoutFieldsV2): CheckoutNotice | null {
    try {
      const limited = limitAction(limiter, "address.write", sessionId);
      if (!limited.ok) return CHECKOUT_NOTICE.addressNotSaved;
      const a = fields.address;
      const created = addresses.create(sessionId, {
        fullName: a.fullName,
        email: undefined,
        line1: a.line1,
        line2: a.line2,
        city: a.city,
        region: a.region,
        postalCode: a.postalCode,
        country: a.country,
        label: fields.addressLabel,
        phone: fields.phone,
      });
      if (created.ok) {
        revalidate("/account/addresses");
        return null;
      }
      // Already in the book: what the shopper asked for (also keeps a replay quiet).
      if (created.error.code === "DUPLICATE") return null;
      if (created.error.code === "LIMIT_REACHED") return CHECKOUT_NOTICE.addressFull;
      return CHECKOUT_NOTICE.addressNotSaved;
    } catch (error) {
      rethrow(error);
      logError(`[checkout] ${CHECKOUT_ACTION_FAILED} step=save_address code=${logCode(error)}`);
      return CHECKOUT_NOTICE.addressNotSaved;
    }
  }

  const placeOrderV2: CheckoutActionFnV2 = async (_prevState, formData) => {
    const parsed = parseCheckoutFieldsV2(formData);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    const fields = parsed.value;
    const values = toRetainedValuesV2(fields);

    const key = parseIdempotencyKey(formData);
    if (!key.ok) return { ok: false, error: key.error, values };

    const problems = localCheckoutProblemsV2(fields);
    if (problems.length > 0) return problemsState(problems, values);

    let target: string;
    let step = "session";
    try {
      const sessionId = await getSessionId();

      let address: Address;
      // Order contact phone (D-T71-1): the saved address's phone, or the
      // posted one in "new" mode (blank = none; validated locally above).
      let phone: string | null;
      if (fields.mode === "saved") {
        step = "address";
        if (sessionId === null) return problemsState([ADDRESS_NOT_FOUND], values);
        const saved = addresses.get(sessionId, fields.addressId);
        if (!saved.ok) return problemsState([ADDRESS_NOT_FOUND], values);
        address = orderAddressFromSaved(saved.value, fields.address.email);
        phone = saved.value.phone ?? null;
      } else {
        address = fields.address;
        phone = fields.phone === "" ? null : fields.phone;
      }

      if (sessionId === null) {
        return { ok: false, error: appError("EMPTY_CART", CHECKOUT_MESSAGES.emptyCart), values };
      }

      step = "order";
      const result = await orders.placeOrderV2(
        {
          sessionId,
          address,
          card: toCardInput(fields.card),
          idempotencyKey: key.value,
          ...(phone === null ? {} : { phone }),
          ...(fields.shippingMethodId === "" ? {} : { shippingMethodId: fields.shippingMethodId }),
          ...(fields.deliveryNote === "" ? {} : { deliveryNote: fields.deliveryNote }),
        },
        deps.now?.(),
      );
      if (!result.ok) return toCheckoutFailureV2(result.error, fields.mode, values);

      step = "revalidate";
      revalidate("/cart");
      revalidate("/", "layout");
      revalidate("/orders");

      const notice = fields.saveAddress ? saveToAddressBook(sessionId, fields) : null;
      target = orderPlacedHref(result.value.id, notice);
    } catch (error) {
      rethrow(error);
      logError(`[checkout] ${CHECKOUT_ACTION_FAILED} step=${step} code=${logCode(error)}`);
      return { ok: false, error: appError("INTERNAL_ERROR", CHECKOUT_MESSAGES_V2.unexpected), values };
    }
    return redirect(target);
  };

  return { placeOrderV2 };
}
