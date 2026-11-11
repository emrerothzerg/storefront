import type {
  CartActionFn,
  CartActionFnV2,
  CartActionKind,
  CartActionState,
  CartActionStateV2,
  CartPerItemResult,
  CartTotalsSummary,
} from "@/components/molecules/_contracts/cart-actions";
import { ADD_MANY_MAX_ITEMS, CART_FIELD, CART_FIELD_V2 } from "@/components/molecules/_contracts/cart-actions";
import { formatMoney } from "@/lib/money";
import { appError, err, fail, ok, type AppError, type Result } from "@/lib/result";
import { DEFAULT_MAX_QUANTITY } from "@/lib/validation";
import {
  CartTotalOverflowError,
  DEFAULT_CART_CURRENCY,
  type CartService,
  type CartServiceV2,
  type CartView,
  type CartViewV2,
} from "@/server/cart/cart-service";
import { limitAction, type RateLimiter } from "@/server/security/rate-limiter";
import { normalizeCouponCode } from "@/server/security/text-guard";

/**
 * Framework-free cart action logic (T12). `cart.ts` wires these to Next.js
 * (`getOrCreateSessionId`, `createCartService()`, `revalidatePath`); tests
 * inject fakes. See README.md in this folder.
 *
 * Rules:
 * - Only `CART_FIELD.productId` / `CART_FIELD.quantity` are read from the form.
 *   Price, subtotal and session id are never read from the client.
 * - Expected failures (bad input, stock, validation) are returned as `Err`
 *   with a user-safe message; nothing is written and nothing is revalidated.
 * - Unexpected exceptions (DB down, cookies unavailable) are rethrown so the
 *   nearest error boundary renders. Actions always settle.
 */

export interface CartActionDeps {
  /** Returns (creating if needed) the guest session id. Called at most once per action. */
  readonly getSessionId: () => Promise<string>;
  readonly cart: CartService;
  readonly revalidate: (path: string, type?: "page" | "layout") => void;
}

export interface CartActions {
  readonly addToCart: CartActionFn;
  readonly updateCartQuantity: CartActionFn;
  readonly removeFromCart: CartActionFn;
}

export const PRODUCT_ID_MAX_LENGTH = 128;

const QUANTITY_PATTERN = /^\d{1,3}$/;

export const MESSAGES = {
  invalidRequest: "Something was wrong with that request.",
  invalidQuantityFormat: "Please enter a whole number quantity.",
  outOfStock: "This item is out of stock.",
  productNotFound: "This product is no longer available.",
  noMoreAvailable: "No more of this item is available.",
  quantityUpdated: "Quantity updated.",
  itemRemoved: "Item removed.",
} as const;

/** Reads `productId`: a string, trimmed, 1..128 chars. Anything else is INVALID_INPUT. */
export function parseProductId(formData: FormData): Result<string> {
  const raw = formData.get(CART_FIELD.productId);
  if (typeof raw !== "string") return fail("INVALID_INPUT", MESSAGES.invalidRequest, { field: CART_FIELD.productId });
  const value = raw.trim();
  if (value.length < 1 || value.length > PRODUCT_ID_MAX_LENGTH) {
    return fail("INVALID_INPUT", MESSAGES.invalidRequest, { field: CART_FIELD.productId });
  }
  return ok(value);
}

/**
 * Reads `quantity`: a string of 1-3 ASCII digits, converted to a number.
 * Range checks (>= 1, <= max) are left to the service's `validateQuantity`.
 */
export function parseQuantity(formData: FormData): Result<number> {
  const raw = formData.get(CART_FIELD.quantity);
  if (typeof raw !== "string" || !QUANTITY_PATTERN.test(raw)) {
    return fail("INVALID_INPUT", MESSAGES.invalidQuantityFormat, { field: CART_FIELD.quantity });
  }
  return ok(Number(raw));
}

function readNumber(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Replaces a service error's message with a user-safe one, keeping `code` and `details`. */
export function toUserSafeError(error: AppError): AppError {
  const message = ((): string => {
    switch (error.code) {
      case "INSUFFICIENT_STOCK": {
        const available = readNumber(error.details, "available");
        if (available === undefined) return MESSAGES.noMoreAvailable;
        return available > 0 ? `Only ${available} left in stock.` : MESSAGES.noMoreAvailable;
      }
      case "OUT_OF_STOCK":
        return MESSAGES.outOfStock;
      case "PRODUCT_NOT_FOUND":
        return MESSAGES.productNotFound;
      case "INVALID_QUANTITY": {
        const max = readNumber(error.details, "max") ?? DEFAULT_MAX_QUANTITY;
        return `Please choose a quantity between 1 and ${max}.`;
      }
      default:
        return MESSAGES.invalidRequest;
    }
  })();
  return appError(error.code, message, error.details);
}

/** The cart service methods the v1 actions call (a `CartService` satisfies it). */
type CartPortV1 = Pick<CartService, "addItem" | "setQuantity" | "removeItem">;

function createCartActionsV1(deps: {
  readonly getSessionId: () => Promise<string>;
  readonly cart: CartPortV1;
  readonly revalidate: (path: string, type?: "page" | "layout") => void;
}): CartActions {
  const { getSessionId, cart, revalidate } = deps;

  function settle(result: Result<CartView>, message: (view: CartView) => string): CartActionState {
    if (!result.ok) return err(toUserSafeError(result.error));
    const view = result.value;
    revalidate("/cart");
    revalidate("/", "layout");
    return ok({ itemCount: view.itemCount, subtotalCents: view.subtotalCents, message: message(view) });
  }

  const addToCart: CartActionFn = async (_prevState, formData) => {
    const productId = parseProductId(formData);
    if (!productId.ok) return productId;
    const quantity = parseQuantity(formData);
    if (!quantity.ok) return quantity;
    const sessionId = await getSessionId();
    return settle(cart.addItem(sessionId, productId.value, quantity.value), () => `Added ${quantity.value} to your cart.`);
  };

  const updateCartQuantity: CartActionFn = async (_prevState, formData) => {
    const productId = parseProductId(formData);
    if (!productId.ok) return productId;
    const quantity = parseQuantity(formData);
    if (!quantity.ok) return quantity;
    const sessionId = await getSessionId();
    return settle(cart.setQuantity(sessionId, productId.value, quantity.value), () => MESSAGES.quantityUpdated);
  };

  const removeFromCart: CartActionFn = async (_prevState, formData) => {
    const productId = parseProductId(formData);
    if (!productId.ok) return productId;
    const sessionId = await getSessionId();
    return settle(cart.removeItem(sessionId, productId.value), () => MESSAGES.itemRemoved);
  };

  return { addToCart, updateCartQuantity, removeFromCart };
}

// ===========================================================================
// Cart actions v2 (T56): save for later, promo codes, shipping method, Buy Now.
//
// Rules (in addition to the v1 rules above):
// - Only `CART_FIELD_V2` fields are read. Session id, prices, discount,
//   shipping and totals posted by the client are ignored.
// - Owner key: `buyNow` uses `getSessionId` (may create the cookie, like
//   addToCart). Every other v2 action uses `readSessionId` and never creates a
//   session: no cookie -> empty success (`applyCoupon`: generic invalid code).
// - applyCoupon: parse -> readSessionId -> rate limit ("coupon.apply") ->
//   service. Invalid charset, unknown code and missing session all return the
//   identical COUPON_INVALID error.
// - Expected failures are returned with user-safe messages; nothing is
//   revalidated. Unexpected exceptions are logged as an error code plus the
//   action name only (no ids, no input) and return INTERNAL_ERROR, so v2
//   actions always resolve. The only throw is buyNow's intentional redirect,
//   which runs last and outside any try/catch.
// - Success revalidates `/cart` and the root layout; coupon and shipping
//   changes also revalidate `/checkout`.
// ===========================================================================

/** The cart service methods the v2 actions call. `createCartService(db)` / `getCartService()` satisfy it. */
export type CartServicePortV2 = Pick<
  CartServiceV2,
  | "addItem"
  | "setQuantity"
  | "removeItem"
  | "getCartView"
  | "saveForLater"
  | "moveToCart"
  | "applyCoupon"
  | "removeCoupon"
  | "selectShippingMethod"
>;

export interface CartActionDepsV2 {
  /** Returns (creating if needed) the owner key. Used by addToCart, updateCartQuantity, removeFromCart and buyNow. */
  readonly getSessionId: () => Promise<string>;
  /** Reads (never creates) the owner key; `null` = no session. Used by every other v2 action. */
  readonly readSessionId: () => Promise<string | null>;
  readonly cart: CartServicePortV2;
  readonly limiter: RateLimiter;
  readonly revalidate: (path: string, type?: "page" | "layout") => void;
  /** Must throw (Next's `redirect`), never return. Called by buyNow on success only. */
  readonly redirect: (path: string) => never;
  /** Epoch-ms clock passed to coupon validation; the service clock when absent. */
  readonly now?: () => number;
  /** Rethrows framework control-flow errors (wrapper passes `unstable_rethrow`). */
  readonly rethrow?: (error: unknown) => void;
  /** PII-free error log line sink; defaults to `console.error`. */
  readonly logError?: (line: string) => void;
}

export interface CartActionsV2 extends CartActions {
  readonly saveForLater: CartActionFnV2;
  readonly moveToCart: CartActionFnV2;
  readonly applyCoupon: CartActionFnV2;
  readonly removeCoupon: CartActionFnV2;
  readonly selectShippingMethod: CartActionFnV2;
  readonly buyNow: CartActionFnV2;
  readonly addManyToCart: CartActionFnV2;
}

export const CHECKOUT_PATH = "/checkout";

/** Logged (with the action name) when a v2 action hits an unexpected exception. */
export const CART_ACTION_FAILED = "CART_ACTION_FAILED";

export const SHIPPING_METHOD_ID_MAX_LENGTH = 64;

export const MESSAGES_V2 = {
  savedForLater: "Saved for later.",
  movedToCart: "Moved to your cart.",
  couponRemoved: "Promo code removed.",
  couponInvalid: "That promo code is not valid.",
  couponExpired: "This promo code has expired.",
  couponExhausted: "This promo code is no longer available.",
  couponUsed: "You have already used this promo code.",
  couponMinSubtotal: "Your subtotal is below the minimum for this promo code.",
  couponRateLimited: "Too many promo code attempts. Please try again later.",
  shippingInvalid: "Choose a valid shipping method.",
  notSaved: "This item is no longer in Saved for later.",
  savedListFull: "Your Saved for later list is full. Remove an item to save another.",
  emptyCart: "Your cart is empty.",
  noneAdded: "None of the selected items could be added to your cart.",
  moneyOverflow: "This cart total is too large to process.",
  unexpected: "Something went wrong. Please try again.",
} as const;

export const EMPTY_CART_TOTALS: CartTotalsSummary = Object.freeze({
  itemCount: 0,
  subtotalCents: 0,
  discountCents: 0,
  shippingCents: 0,
  totalCents: 0,
  couponCode: null,
  shippingMethodId: null,
});

function couponInvalid(): Result<never> {
  return fail("COUPON_INVALID", MESSAGES_V2.couponInvalid, { field: CART_FIELD_V2.couponCode });
}

function shippingInvalid(): Result<never> {
  return fail("INVALID_INPUT", MESSAGES_V2.shippingInvalid, { field: CART_FIELD_V2.shippingMethodId });
}

/**
 * Reads `couponCode` through `normalizeCouponCode` (trim, `[A-Za-z0-9_-]{1,32}`,
 * upper-case). Anything else is the generic COUPON_INVALID error.
 */
export function parseCouponCode(formData: FormData): Result<string> {
  const normalized = normalizeCouponCode(formData.get(CART_FIELD_V2.couponCode));
  return normalized.ok ? normalized : couponInvalid();
}

/** Reads `shippingMethodId`: a string, trimmed, 1..64 chars. Existence is the service's job. */
export function parseShippingMethodId(formData: FormData): Result<string> {
  const raw = formData.get(CART_FIELD_V2.shippingMethodId);
  if (typeof raw !== "string" || raw.length > SHIPPING_METHOD_ID_MAX_LENGTH * 4) return shippingInvalid();
  const value = raw.trim();
  if (value.length < 1 || value.length > SHIPPING_METHOD_ID_MAX_LENGTH) return shippingInvalid();
  return ok(value);
}

/**
 * Reads every `productId` (repeated key), each validated like `parseProductId`
 * (string, trimmed, 1..128). Invalid values are dropped, duplicates removed
 * (first occurrence wins), at most `ADD_MANY_MAX_ITEMS` kept. None valid -> INVALID_INPUT.
 */
export function parseProductIds(formData: FormData): Result<readonly string[]> {
  const ids: string[] = [];
  for (const raw of formData.getAll(CART_FIELD.productId)) {
    if (typeof raw !== "string" || raw.length > PRODUCT_ID_MAX_LENGTH * 4) continue;
    const value = raw.trim();
    if (value.length < 1 || value.length > PRODUCT_ID_MAX_LENGTH || ids.includes(value)) continue;
    ids.push(value);
    if (ids.length === ADD_MANY_MAX_ITEMS) break;
  }
  return ids.length === 0 ? fail("INVALID_INPUT", MESSAGES.invalidRequest, { field: CART_FIELD.productId }) : ok(ids);
}

/** Maps an `addItem` error to the per-item outcome. */
export function perItemOutcome(error: AppError): CartPerItemResult["result"] {
  switch (error.code) {
    case "OUT_OF_STOCK":
      return "out_of_stock";
    case "INSUFFICIENT_STOCK":
    case "INVALID_QUANTITY":
      return "capped";
    default:
      return "unavailable";
  }
}

export function addManyMessage(added: number, requested: number): string {
  if (added === 0) return MESSAGES_V2.noneAdded;
  if (added === requested) return `Added ${added} ${added === 1 ? "item" : "items"} to your cart.`;
  return `Added ${added} of ${requested} items to your cart.`;
}

function readSafeInt(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function couponRateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return MESSAGES_V2.couponRateLimited;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many promo code attempts. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/**
 * User-safe mapping for v2 errors. Coupon, limiter, list and shipping codes
 * get their own messages with whitelisted `details`; stock/product/quantity
 * codes fall back to the v1 `toUserSafeError`.
 */
export function toUserSafeErrorV2(error: AppError): AppError {
  switch (error.code) {
    case "RATE_LIMITED": {
      const raw = error.details?.retryAfterSeconds;
      const retryAfterSeconds =
        typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : undefined;
      const message = couponRateLimitedMessage(retryAfterSeconds);
      return retryAfterSeconds === undefined
        ? appError("RATE_LIMITED", message)
        : appError("RATE_LIMITED", message, { retryAfterSeconds });
    }
    case "COUPON_INVALID":
      return appError("COUPON_INVALID", MESSAGES_V2.couponInvalid, { field: CART_FIELD_V2.couponCode });
    case "COUPON_EXPIRED":
      return appError("COUPON_EXPIRED", MESSAGES_V2.couponExpired);
    case "COUPON_EXHAUSTED":
      return appError("COUPON_EXHAUSTED", MESSAGES_V2.couponExhausted);
    case "COUPON_USED":
      return appError("COUPON_USED", MESSAGES_V2.couponUsed);
    case "COUPON_MIN_SUBTOTAL": {
      const shortfallCents = readSafeInt(error.details, "shortfallCents");
      const minSubtotalCents = readSafeInt(error.details, "minSubtotalCents");
      if (shortfallCents === undefined || shortfallCents === 0) {
        return appError("COUPON_MIN_SUBTOTAL", MESSAGES_V2.couponMinSubtotal);
      }
      const details: Record<string, number> = { shortfallCents };
      if (minSubtotalCents !== undefined) details.minSubtotalCents = minSubtotalCents;
      return appError(
        "COUPON_MIN_SUBTOTAL",
        `Add ${formatMoney(shortfallCents, DEFAULT_CART_CURRENCY)} more to use this promo code.`,
        details,
      );
    }
    case "NOT_FOUND":
      return appError("NOT_FOUND", MESSAGES_V2.notSaved);
    case "LIMIT_REACHED":
      return appError("LIMIT_REACHED", MESSAGES_V2.savedListFull);
    case "INVALID_INPUT":
      return error.details?.field === CART_FIELD_V2.shippingMethodId
        ? appError("INVALID_INPUT", MESSAGES_V2.shippingInvalid, { field: CART_FIELD_V2.shippingMethodId })
        : appError("INVALID_INPUT", MESSAGES.invalidRequest);
    case "MONEY_OVERFLOW":
      return appError("MONEY_OVERFLOW", MESSAGES_V2.moneyOverflow);
    case "INTERNAL_ERROR":
      return appError("INTERNAL_ERROR", MESSAGES_V2.unexpected);
    default:
      return toUserSafeError(error);
  }
}

/** Totals summary of a v2 view (all values server-computed). */
export function summarizeCartView(view: CartViewV2): CartTotalsSummary {
  return {
    itemCount: view.itemCount,
    subtotalCents: view.totals.subtotalCents,
    discountCents: view.totals.discountCents,
    shippingCents: view.totals.shippingCents,
    totalCents: view.totals.totalCents,
    couponCode: view.coupon?.code ?? null,
    shippingMethodId: view.shipping?.method.id ?? null,
  };
}

function emptySuccess(): CartActionStateV2 {
  return ok({ itemCount: 0, subtotalCents: 0, message: MESSAGES_V2.emptyCart, totals: EMPTY_CART_TOTALS });
}

/** Marker returned by the guarded part of buyNow when the redirect should run. */
const REDIRECT_TO_CHECKOUT: unique symbol = Symbol("REDIRECT_TO_CHECKOUT");

function isV2Deps(deps: CartActionDeps | CartActionDepsV2): deps is CartActionDepsV2 {
  return "limiter" in deps && "readSessionId" in deps && "redirect" in deps;
}

function createCartActionsV2Only(deps: CartActionDepsV2): Omit<CartActionsV2, keyof CartActions> {
  const { getSessionId, readSessionId, cart, limiter, revalidate, redirect, now, rethrow } = deps;
  const logError = deps.logError ?? ((line: string): void => console.error(line));

  /** Runs `body`; any exception (except framework control flow) becomes a typed error state. */
  async function guarded<T>(name: string, body: () => Promise<T>): Promise<T | CartActionStateV2> {
    try {
      return await body();
    } catch (error) {
      rethrow?.(error);
      if (error instanceof CartTotalOverflowError) return err(appError("MONEY_OVERFLOW", MESSAGES_V2.moneyOverflow));
      try {
        // Error code + action name only: the exception may carry ids or input.
        logError(`[cart] ${CART_ACTION_FAILED} action=${name}`);
      } catch {
        // Logging must never change the outcome.
      }
      return err(appError("INTERNAL_ERROR", MESSAGES_V2.unexpected));
    }
  }

  function action(name: string, body: (formData: FormData) => Promise<CartActionStateV2>): CartActionFnV2 {
    return async (_prevState, formData) => guarded(name, () => body(formData));
  }

  /** Revalidates, then reads the fresh totals. */
  function succeed(
    sessionId: string,
    kind: CartActionKind,
    message: string,
    alsoCheckout: boolean,
  ): CartActionStateV2 {
    revalidate("/cart");
    if (alsoCheckout) revalidate(CHECKOUT_PATH);
    revalidate("/", "layout");
    const view = cart.getCartView(sessionId, now?.());
    if (!view.ok) return err(toUserSafeErrorV2(view.error));
    const totals = summarizeCartView(view.value);
    return ok({ itemCount: totals.itemCount, subtotalCents: totals.subtotalCents, message, totals, kind });
  }

  const saveForLater = action("saveForLater", async (formData) => {
    const productId = parseProductId(formData);
    if (!productId.ok) return productId;
    const sessionId = await readSessionId();
    if (sessionId === null) return emptySuccess();
    const result = cart.saveForLater(sessionId, productId.value);
    if (!result.ok) return err(toUserSafeErrorV2(result.error));
    return succeed(sessionId, "saved", MESSAGES_V2.savedForLater, false);
  });

  const moveToCart = action("moveToCart", async (formData) => {
    const productId = parseProductId(formData);
    if (!productId.ok) return productId;
    const sessionId = await readSessionId();
    if (sessionId === null) return emptySuccess();
    const result = cart.moveToCart(sessionId, productId.value);
    if (!result.ok) return err(toUserSafeErrorV2(result.error));
    return succeed(sessionId, "moved", MESSAGES_V2.movedToCart, false);
  });

  const applyCoupon = action("applyCoupon", async (formData) => {
    const code = parseCouponCode(formData);
    if (!code.ok) return code;
    const sessionId = await readSessionId();
    if (sessionId === null) return couponInvalid();
    const limited = limitAction(limiter, "coupon.apply", sessionId);
    if (!limited.ok) return err(toUserSafeErrorV2(limited.error));
    const result = cart.applyCoupon(sessionId, code.value, now?.());
    if (!result.ok) return err(toUserSafeErrorV2(result.error));
    const coupon = result.value;
    return succeed(sessionId, "coupon_applied", `Promo code ${coupon.code} applied: ${coupon.description}.`, true);
  });

  const removeCoupon = action("removeCoupon", async () => {
    const sessionId = await readSessionId();
    if (sessionId === null) return emptySuccess();
    const result = cart.removeCoupon(sessionId);
    if (!result.ok) return err(toUserSafeErrorV2(result.error));
    return succeed(sessionId, "coupon_removed", MESSAGES_V2.couponRemoved, true);
  });

  const selectShippingMethod = action("selectShippingMethod", async (formData) => {
    const methodId = parseShippingMethodId(formData);
    if (!methodId.ok) return methodId;
    const sessionId = await readSessionId();
    if (sessionId === null) return emptySuccess();
    const result = cart.selectShippingMethod(sessionId, methodId.value);
    if (!result.ok) return err(toUserSafeErrorV2(result.error));
    return succeed(sessionId, "shipping_selected", `Shipping method set to ${result.value.method.name}.`, true);
  });

  const buyNow: CartActionFnV2 = async (_prevState, formData) => {
    const outcome = await guarded("buyNow", async (): Promise<CartActionStateV2 | typeof REDIRECT_TO_CHECKOUT> => {
      const productId = parseProductId(formData);
      if (!productId.ok) return productId;
      const quantity = parseQuantity(formData);
      if (!quantity.ok) return quantity;
      const sessionId = await getSessionId();
      const result = cart.addItem(sessionId, productId.value, quantity.value);
      if (!result.ok) return err(toUserSafeErrorV2(result.error));
      revalidate("/cart");
      revalidate("/", "layout");
      return REDIRECT_TO_CHECKOUT;
    });
    if (outcome !== REDIRECT_TO_CHECKOUT) return outcome;
    // Outside every try/catch: Next's redirect throws by design.
    return redirect(CHECKOUT_PATH);
  };

  const addManyToCart = action("addManyToCart", async (formData) => {
    const ids = parseProductIds(formData);
    if (!ids.ok) return ids;
    const sessionId = await getSessionId();
    // One addItem per id: each is its own transaction with the service's stock checks (never oversells).
    const perItem: CartPerItemResult[] = ids.value.map((productId) => {
      const result = cart.addItem(sessionId, productId, 1);
      return { productId, result: result.ok ? "added" : perItemOutcome(result.error) };
    });
    const added = perItem.filter((p) => p.result === "added").length;
    if (added > 0) {
      revalidate("/cart");
      revalidate("/", "layout");
    }
    const view = cart.getCartView(sessionId, now?.());
    if (!view.ok) return err(toUserSafeErrorV2(view.error));
    const totals = summarizeCartView(view.value);
    return ok({
      itemCount: totals.itemCount,
      subtotalCents: totals.subtotalCents,
      message: addManyMessage(added, perItem.length),
      totals,
      kind: "added_many",
      perItem,
    });
  });

  return { saveForLater, moveToCart, applyCoupon, removeCoupon, selectShippingMethod, buyNow, addManyToCart };
}

/**
 * Builds the cart actions. With v1 deps (MVP shape) returns the three v1
 * actions; with v2 deps (`limiter`, `readSessionId`, `redirect`, ...) returns
 * the v1 actions plus the v2 ones. v1 behaviour is identical either way.
 */
export function createCartActions(deps: CartActionDepsV2): CartActionsV2;
export function createCartActions(deps: CartActionDeps): CartActions;
export function createCartActions(deps: CartActionDeps | CartActionDepsV2): CartActions | CartActionsV2 {
  const v1 = createCartActionsV1(deps);
  if (!isV2Deps(deps)) return v1;
  return { ...v1, ...createCartActionsV2Only(deps) };
}
