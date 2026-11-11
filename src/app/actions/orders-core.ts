import type {
  OrderActionFn,
  OrderActionState,
  OrderLineResult,
  OrderPerLineResult,
} from "@/components/molecules/_contracts/order-actions";
import { ORDER_CONFIRM_VALUE, ORDER_FIELD } from "@/components/molecules/_contracts/order-actions";
import { appError, type AppError } from "@/lib/result";
import { DEFAULT_MAX_QUANTITY } from "@/lib/validation";
import type { CartService } from "@/server/cart/cart-service";
import type { OrderRepositoryV2 } from "@/server/orders/order-repository";
import { isOrderId, isOwnerKey, type OrderServiceV2, type OrderViewItem } from "@/server/orders/order-service";
import type { RateLimiter, RateLimitRule } from "@/server/security/rate-limiter";

/**
 * Framework-free order action logic (T72). `orders.ts` wires it to Next.js
 * (`readSessionId`, `getOrderService()`, `getCartService()`,
 * `getRateLimiter()`, `revalidatePath`); tests inject fakes or real services
 * over an in-memory DB.
 *
 * Flow (both actions):
 * 1. Parse only the `ORDER_FIELD` strings (`orderId` via `isOrderId`; cancel
 *    needs `confirm === "yes"`; buy again accepts an optional `productId`).
 *    Bad input returns INVALID_INPUT with `details.field`, before any cookie
 *    read, limiter token or service call.
 * 2. `readSessionId()`; null (or not a usable owner key) -> ORDER_NOT_FOUND.
 *    A session is NEVER created here (T72 criterion 4).
 * 3. `limiter.check("orders.mutate:<owner>", 60 / hour)`.
 * 4. Service call. Prices and quantities are never read from the form.
 *
 * Buy again, per line: a product that is missing or not yet published
 * (`published_at > now`, the rule `getBuyAgainLines` uses) is reported
 * `unavailable` without touching the cart (D-T72-1). Otherwise the request is
 * `min(snapshot quantity, 99 - quantity already in the cart)` (D-T72-2), with
 * one INSUFFICIENT_STOCK retry at `details.available`.
 *
 * Every outcome is a state; unexpected exceptions become INTERNAL_ERROR and
 * are logged as an error code plus action name only (no ids, no PII).
 */

export interface OrderActionDeps {
  readonly orders: Pick<OrderServiceV2, "cancelOrder" | "getOrderView">;
  /** `getCart` is read once per buy-again to find the per-line headroom under the 99 cap. */
  readonly cart: Pick<CartService, "addItem" | "getCart">;
  /** Current `published_at` (and stock) per product id; missing ids are omitted. */
  readonly catalog: Pick<OrderRepositoryV2, "getProductAvailability">;
  readonly limiter: RateLimiter;
  readonly readSessionId: () => Promise<string | null>;
  readonly revalidatePath: (path: string, type?: "page" | "layout") => void;
  /** Epoch milliseconds passed to the order service; service clock when absent. */
  readonly now?: () => number;
  /** Receives only `ORDER_ACTION_FAILED action=<name>`; defaults to `console`. */
  readonly logger?: Pick<Console, "error">;
}

export interface OrderActions {
  readonly cancelOrder: OrderActionFn;
  readonly buyAgain: OrderActionFn;
}

export const ORDERS_PATH = "/orders";
export const CART_PATH = "/cart";
export const PRODUCT_ID_MAX_LENGTH = 128;

/** Limiter key prefix; the full key is `orders.mutate:<ownerKey>`. */
export const ORDERS_MUTATE_LIMIT_PREFIX = "orders.mutate";
export const ORDERS_MUTATE_RATE_LIMIT: RateLimitRule = Object.freeze({ limit: 60, windowSeconds: 3600 });

/** Logged when an action hits an unexpected exception. */
export const ORDER_ACTION_FAILED = "ORDER_ACTION_FAILED";

export const ORDER_MESSAGES = {
  cancelled: "Your order was cancelled. Stock has been released and a refund is pending.",
  notFound: "We couldn't find that order.",
  notCancellable: "This order can no longer be cancelled.",
  confirmRequired: "Please confirm that you want to cancel this order.",
  lineNotFound: "That item is not part of this order.",
  rateLimitedFallback: "You have made several order changes recently. Please try again later.",
  unexpected: "Something went wrong. Please try again.",
} as const;

export function orderPath(orderId: string): string {
  return `${ORDERS_PATH}/${orderId}`;
}

export function buyAgainMessage(added: number, total: number): string {
  return `Added ${added} of ${total} ${total === 1 ? "item" : "items"} to your cart.`;
}

export function rateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return ORDER_MESSAGES.rateLimitedFallback;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `You have made several order changes recently. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

type ErrorState = Extract<OrderActionState, { ok: false }>;

function errorState(error: AppError, retryAfterSeconds?: number): ErrorState {
  const base = { ok: false as const, error, message: error.message };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

function invalid(field: string, message: string): ErrorState {
  return errorState(appError("INVALID_INPUT", message, { field }));
}

export function notFoundState(): ErrorState {
  return errorState(appError("ORDER_NOT_FOUND", ORDER_MESSAGES.notFound));
}

export function notCancellableState(): ErrorState {
  return errorState(appError("ORDER_NOT_CANCELLABLE", ORDER_MESSAGES.notCancellable));
}

/** Generic state for unexpected failures. No internal detail leaves the server. */
export function unexpectedErrorState(): ErrorState {
  return errorState(appError("INTERNAL_ERROR", ORDER_MESSAGES.unexpected));
}

function readPositiveInt(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}

/** Maps a limiter / service error to a user-safe state; `details` never echoes service data. */
export function toErrorState(error: AppError): ErrorState {
  switch (error.code) {
    case "RATE_LIMITED": {
      const retryAfterSeconds = readPositiveInt(error.details, "retryAfterSeconds");
      const message = rateLimitedMessage(retryAfterSeconds);
      return retryAfterSeconds === undefined
        ? errorState(appError("RATE_LIMITED", message))
        : errorState(appError("RATE_LIMITED", message, { retryAfterSeconds }), retryAfterSeconds);
    }
    case "ORDER_NOT_FOUND":
      return notFoundState();
    case "ORDER_NOT_CANCELLABLE":
      return notCancellableState();
    default:
      return unexpectedErrorState();
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function readString(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly state: ErrorState };

/** `orderId`: trimmed, must pass `isOrderId` (canonical lowercase UUID v4). */
export function parseOrderId(formData: FormData): Parsed<string> {
  const raw = readString(formData, ORDER_FIELD.orderId);
  const value = raw === undefined || raw.length > 200 ? undefined : raw.trim();
  if (!isOrderId(value)) return { ok: false, state: invalid(ORDER_FIELD.orderId, ORDER_MESSAGES.notFound) };
  return { ok: true, value };
}

/** `confirm` must be exactly `"yes"` (no trimming, no case folding). */
export function parseConfirm(formData: FormData): Parsed<true> {
  if (readString(formData, ORDER_FIELD.confirm) !== ORDER_CONFIRM_VALUE) {
    return { ok: false, state: invalid(ORDER_FIELD.confirm, ORDER_MESSAGES.confirmRequired) };
  }
  return { ok: true, value: true };
}

/**
 * Optional `productId`: absent or blank -> null (every line); otherwise a
 * trimmed string of 1..128 chars. Whether it is a line of the order is
 * checked after the order is loaded.
 */
export function parseOptionalProductId(formData: FormData): Parsed<string | null> {
  const raw = formData.get(ORDER_FIELD.productId);
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string" || raw.length > PRODUCT_ID_MAX_LENGTH * 4) {
    return { ok: false, state: invalid(ORDER_FIELD.productId, ORDER_MESSAGES.lineNotFound) };
  }
  const value = raw.trim();
  if (value.length === 0) return { ok: true, value: null };
  if (value.length > PRODUCT_ID_MAX_LENGTH) {
    return { ok: false, state: invalid(ORDER_FIELD.productId, ORDER_MESSAGES.lineNotFound) };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Buy again per line
// ---------------------------------------------------------------------------

export interface LineOutcome {
  readonly result: OrderLineResult;
  /** Units written to the cart by this line (0 when nothing was added). */
  readonly addedQuantity: number;
}

function availableOf(error: AppError): number {
  const value = error.details?.available;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function failureOutcome(error: AppError): LineOutcome {
  switch (error.code) {
    case "OUT_OF_STOCK":
      return { result: "out_of_stock", addedQuantity: 0 };
    case "INSUFFICIENT_STOCK":
    case "INVALID_QUANTITY":
      // Cart already holds what stock (or the per-line cap) allows.
      return { result: "capped", addedQuantity: 0 };
    default:
      // PRODUCT_NOT_FOUND, MONEY_OVERFLOW, anything else: not purchasable now.
      return { result: "unavailable", addedQuantity: 0 };
  }
}

/**
 * Product ids that exist and are published at `nowMs` (`published_at <= now`,
 * ISO string comparison, the same rule as `getBuyAgainLines`).
 */
export function publishedProductIds(
  catalog: Pick<OrderRepositoryV2, "getProductAvailability">,
  productIds: readonly string[],
  nowMs: number,
): ReadonlySet<string> {
  const nowIso = new Date(nowMs).toISOString();
  const published = new Set<string>();
  for (const row of catalog.getProductAvailability(productIds)) {
    if (row.publishedAt <= nowIso) published.add(row.productId);
  }
  return published;
}

/**
 * Adds one order line. Requests `min(snapshot quantity, max - inCart)`; no
 * headroom -> `capped` without a write. On INSUFFICIENT_STOCK retries once with
 * `details.available` (the service re-checks stock in its own transaction, so
 * the cart never exceeds stock even if it changed in between). `added` only
 * when the full snapshot quantity was written.
 */
export function addLine(
  cart: Pick<CartService, "addItem">,
  sessionId: string,
  item: OrderViewItem,
  inCart: number = 0,
  max: number = DEFAULT_MAX_QUANTITY,
): LineOutcome {
  const headroom = max - Math.max(0, inCart);
  if (headroom < 1) return { result: "capped", addedQuantity: 0 };
  const request = Math.min(item.quantity, headroom);
  const capped = request < item.quantity;

  const first = cart.addItem(sessionId, item.productId, request);
  if (first.ok) return { result: capped ? "capped" : "added", addedQuantity: request };
  if (first.error.code !== "INSUFFICIENT_STOCK") return failureOutcome(first.error);
  const available = Math.min(availableOf(first.error), request - 1);
  if (available < 1) return { result: "capped", addedQuantity: 0 };
  const retry = cart.addItem(sessionId, item.productId, available);
  return retry.ok ? { result: "capped", addedQuantity: available } : failureOutcome(retry.error);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function createOrderActions(deps: OrderActionDeps): OrderActions {
  const { orders, cart, catalog, limiter, readSessionId, revalidatePath, now } = deps;
  const logger = deps.logger ?? console;

  function fail(action: string): ErrorState {
    // Error code + action name only: exceptions may carry ids or SQL.
    logger.error(`[orders] ${ORDER_ACTION_FAILED} action=${action}`);
    return unexpectedErrorState();
  }

  /** Owner key or null; never creates a session. */
  async function owner(): Promise<string | null> {
    const id = await readSessionId();
    return isOwnerKey(id) ? id : null;
  }

  function limit(sessionId: string): ErrorState | null {
    const limited = limiter.check(`${ORDERS_MUTATE_LIMIT_PREFIX}:${sessionId}`, ORDERS_MUTATE_RATE_LIMIT);
    return limited.ok ? null : toErrorState(limited.error);
  }

  const cancelOrder: OrderActionFn = async (_prev, formData) => {
    try {
      const orderId = parseOrderId(formData);
      if (!orderId.ok) return orderId.state;
      const confirm = parseConfirm(formData);
      if (!confirm.ok) return confirm.state;

      const sessionId = await owner();
      if (sessionId === null) return notFoundState();
      const limited = limit(sessionId);
      if (limited !== null) return limited;

      const result = orders.cancelOrder(orderId.value, sessionId, now?.());
      if (!result.ok) return toErrorState(result.error);

      revalidatePath(ORDERS_PATH);
      revalidatePath(orderPath(orderId.value));
      revalidatePath("/", "layout");
      return { ok: true, kind: "cancelled", message: ORDER_MESSAGES.cancelled };
    } catch {
      return fail("cancelOrder");
    }
  };

  const buyAgain: OrderActionFn = async (_prev, formData) => {
    let addedAny = false;
    try {
      const orderId = parseOrderId(formData);
      if (!orderId.ok) return orderId.state;
      const productId = parseOptionalProductId(formData);
      if (!productId.ok) return productId.state;

      const sessionId = await owner();
      if (sessionId === null) return notFoundState();
      const limited = limit(sessionId);
      if (limited !== null) return limited;

      const view = orders.getOrderView(orderId.value, sessionId, now?.());
      if (view === null) return notFoundState();

      const wanted = productId.value;
      const items = wanted === null ? view.items : view.items.filter((item) => item.productId === wanted);
      if (items.length === 0) {
        return invalid(ORDER_FIELD.productId, ORDER_MESSAGES.lineNotFound);
      }

      const nowMs = now?.() ?? Date.now();
      const published = publishedProductIds(catalog, [...new Set(items.map((item) => item.productId))], nowMs);
      const inCart = new Map<string, number>();
      for (const line of cart.getCart(sessionId).items) inCart.set(line.productId, line.quantity);

      const perLine: OrderPerLineResult[] = [];
      let addedLines = 0;
      for (const item of items) {
        // D-T72-1: never add a product that is missing or not (yet) published.
        const outcome: LineOutcome = published.has(item.productId)
          ? addLine(cart, sessionId, item, inCart.get(item.productId) ?? 0)
          : { result: "unavailable", addedQuantity: 0 };
        if (outcome.addedQuantity > 0) {
          addedAny = true;
          addedLines += 1;
          inCart.set(item.productId, (inCart.get(item.productId) ?? 0) + outcome.addedQuantity);
        }
        perLine.push({ productId: item.productId, name: item.name, result: outcome.result });
      }

      if (addedAny) {
        revalidatePath(CART_PATH);
        revalidatePath("/", "layout");
      }
      return { ok: true, kind: "buy_again", message: buyAgainMessage(addedLines, items.length), perLine };
    } catch {
      if (addedAny) {
        // Some lines reached the cart before the fault; keep the badge honest.
        try {
          revalidatePath(CART_PATH);
          revalidatePath("/", "layout");
        } catch {
          // ignore: the action must still settle
        }
      }
      return fail("buyAgain");
    }
  };

  return { cancelOrder, buyAgain };
}
