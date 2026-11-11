import type { Database } from "bun:sqlite";
import type {
  Address,
  CurrencyCode,
  FulfillmentStatus,
  IsoDateTimeString,
  Order,
  OrderEvent,
  OrderItem,
  PaymentFailureCode,
  Product,
  ShippingMethod,
} from "@/lib/types";
import { err, fail, ok, type AppError, type Result } from "@/lib/result";
import { multiplyCents, sumCents } from "@/lib/money";
import { validateAddress, validateCard, type FieldError, type ValidatedCard } from "@/lib/validation";
import { PHONE_MAX, validatePhone } from "@/server/addresses/address-service";
import { getDatabase, withTransaction } from "@/server/db/client";
import { SqliteProductRepository, type ProductRepository } from "@/server/catalog/product-repository";
import {
  CartTotalOverflowError,
  createCartService,
  type CartLineView,
  type CartService,
  type CartServiceV2,
  type CartView,
  type CartViewV2,
} from "@/server/cart/cart-service";
import { SqliteCartRepository, type CartSettings } from "@/server/cart/cart-repository";
import {
  createCouponService,
  recordRedemption,
  releaseRedemptionForOrder,
  type CouponService,
  type ValidatedCoupon,
} from "@/server/pricing/coupon-service";
import {
  createShippingService,
  estimateDelivery,
  type ShippingQuote,
  type ShippingService,
} from "@/server/pricing/shipping-service";
import { computeTotals, type Totals } from "@/server/pricing/totals";
import {
  SIMULATED_TRACKING_NOTICE,
  cancellableUntil,
  deriveStatus,
  estimatedDelivery,
  isCancellable,
  nextEvents,
  sequenceIndex,
  type FulfillmentDeps,
  type FulfillmentInput,
} from "@/server/fulfillment/fulfillment";
import { timeline, type TimelineStep } from "@/server/fulfillment/timeline";
import { cleanText } from "@/server/security/text-guard";
import { isSessionId } from "@/server/session/session-id";
import { DELETED_OWNER_KEY } from "@/server/auth/account-repository";
import type { PaymentProvider, PaymentResult } from "@/server/payments/payment-provider";
import {
  createMockPaymentProvider,
  PAYMENT_FAILURE_MESSAGES,
  type MockPaymentProvider,
} from "@/server/payments/mock-payment-provider";
import {
  DuplicateIdempotencyKeyError,
  SqliteOrderRepository,
  type OrderRecord,
  type OrderRepository,
  type OrderRepositoryV2,
  type OrderSnapshotItem,
  type StockLine,
} from "./order-repository";

/**
 * Checkout core (server-only). Reserve-then-charge:
 *
 * 1. validate key, session, cart emptiness (plain read), address and card
 *    (sync, no transaction: untrusted input is never validated while the
 *    write lock is held)
 * 2. in ONE IMMEDIATE transaction (sync): re-check the idempotency key, re-read
 *    the cart, reserve stock with `decrementStock` per line and CLAIM the key
 *    by inserting the order row in a pending state (`payment_ref =
 *    PENDING_PAYMENT_REF`, UNIQUE on `idempotency_key`)
 * 3. `await` the provider charge
 * 4. success: finalize the pending row as `paid` and clear the cart in one
 *    transaction; failure: restore the reserved stock and finalize the row as
 *    `payment_failed` in one transaction, leaving the cart intact.
 *
 * A same-key attempt on another connection/process sees the claim (step 2 runs
 * under the write lock) and waits for the finalized row instead of charging
 * (D-T71-2). Every pre-charge failure re-checks the key first, so a racing
 * retry replays the order instead of reporting EMPTY_CART (D-T71-3).
 *
 * See README.md in this folder for error codes and the crash window between
 * steps 2 and 4.
 */

export interface PlaceOrderInput {
  readonly sessionId: string | null;
  readonly address: unknown;
  readonly card: unknown;
  readonly idempotencyKey: unknown;
}

/** One line of a `STOCK_CHANGED` error's `details.lines`. */
export interface StockChangedLine {
  readonly productId: string;
  readonly name: string;
  readonly requested: number;
  readonly available: number;
}

export interface OrderServiceDeps {
  readonly db: Database;
  readonly carts: CartService;
  readonly products: ProductRepository;
  readonly orders: OrderRepository;
  readonly payments: PaymentProvider;
  readonly now?: () => Date;
  /** Order id generator. Default `crypto.randomUUID` (ids must be unguessable). */
  readonly idGenerator?: () => string;
  /**
   * Registry of in-flight `placeOrder` calls by idempotency key. Defaults to
   * a per-instance map; `createOrderService` passes a process-wide one so
   * duplicates arriving on different requests still share one attempt.
   */
  readonly inFlight?: InFlightRegistry;
  /**
   * How long a same-key attempt waits for another connection's pending claim
   * to be finalized before giving up with INTERNAL_ERROR (key kept by the
   * form). Default `PENDING_CLAIM_WAIT_MS`.
   */
  readonly claimWaitMs?: number;
}

export interface InFlightEntry {
  readonly sessionId: string;
  readonly promise: Promise<Result<Order>>;
}

export type InFlightRegistry = Map<string, InFlightEntry>;

/** Longest accepted idempotency key (matches the payment provider's limit). */
export const MAX_ORDER_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * `payment_ref` of an order row that claims its idempotency key while the
 * charge is in flight (D-T71-2/3). Never a real provider reference (mock refs
 * are `mock_<uuid>`; zero-total orders store NULL). Readers that ignore
 * `payment_ref` see a pending row as a `payment_failed` PROCESSING_ERROR order,
 * which is also what a crash between charge and finalize leaves behind.
 */
export const PENDING_PAYMENT_REF = "pending:claim";

/** Default wait for a pending same-key claim held by another connection. */
export const PENDING_CLAIM_WAIT_MS = 5_000;

/** Poll interval while waiting for a pending claim. */
const PENDING_CLAIM_POLL_MS = 10;

/** Printable ASCII (space through tilde). */
const PRINTABLE_KEY = /^[\x20-\x7E]+$/;

/** Canonical lowercase UUID v4, the format `crypto.randomUUID()` produces. */
const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isOrderId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && ORDER_ID_RE.test(value);
}

/**
 * A usable owner key: a UUID (`isSessionId`) that is not the tombstone key of
 * deleted accounts (ruling R-1: anonymised orders are never returned).
 */
export function isOwnerKey(value: unknown): value is string {
  return isSessionId(value) && value !== DELETED_OWNER_KEY;
}

export function isIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ORDER_IDEMPOTENCY_KEY_LENGTH &&
    PRINTABLE_KEY.test(value) &&
    value.trim() !== ""
  );
}

/** Thrown inside a transaction to roll it back; converted to `Err` outside. */
class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

/** What a successful reservation hands to the charge/finalize steps. */
interface Reservation {
  /** Id of the pending order row that claims the key. */
  readonly orderId: string;
  readonly createdAt: IsoDateTimeString;
  readonly address: Address;
  readonly card: ValidatedCard;
  readonly items: readonly OrderItem[];
  readonly stockLines: readonly StockLine[];
  readonly subtotalCents: number;
  readonly currency: CurrencyCode;
}

function stockChanged(lines: readonly StockChangedLine[]): AppError {
  return {
    code: "STOCK_CHANGED",
    message: "Some items in your cart are no longer available in the requested quantity.",
    details: { lines },
  };
}

function paymentFailed(orderId: string, failureCode: PaymentFailureCode, message?: string): AppError {
  return {
    code: "PAYMENT_FAILED",
    message: message ?? PAYMENT_FAILURE_MESSAGES[failureCode],
    details: { orderId, failureCode },
  };
}

/**
 * Another attempt holds the key but its outcome is not known (still pending
 * after the wait, or its claim was withdrawn). INTERNAL_ERROR so the checkout
 * form keeps the key: a later retry replays the final outcome.
 */
function claimUnresolved(): AppError {
  return { code: "INTERNAL_ERROR", message: "We could not confirm this order yet. Please try again in a moment." };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function moneyOverflow(): AppError {
  return { code: "MONEY_OVERFLOW", message: "This order total is too large to process." };
}

function availableFrom(error: AppError): number {
  const available = error.details?.available;
  return typeof available === "number" ? available : 0;
}

export class OrderService {
  protected readonly db: Database;
  protected readonly carts: CartService;
  protected readonly products: ProductRepository;
  protected readonly orders: OrderRepository;
  protected readonly payments: PaymentProvider;
  protected readonly now: () => Date;
  protected readonly idGenerator: () => string;
  protected readonly inFlight: InFlightRegistry;
  protected readonly claimWaitMs: number;

  constructor(deps: OrderServiceDeps) {
    this.db = deps.db;
    this.carts = deps.carts;
    this.products = deps.products;
    this.orders = deps.orders;
    this.payments = deps.payments;
    this.now = deps.now ?? (() => new Date());
    this.idGenerator = deps.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.inFlight = deps.inFlight ?? new Map();
    this.claimWaitMs =
      typeof deps.claimWaitMs === "number" && Number.isFinite(deps.claimWaitMs) && deps.claimWaitMs >= 0
        ? deps.claimWaitMs
        : PENDING_CLAIM_WAIT_MS;
  }

  /**
   * Places an order for the session's cart. Never trusts client totals:
   * amounts come from the server-side cart view only.
   *
   * Errors: INVALID_INPUT (bad idempotency key, or key used by another
   * session), EMPTY_CART (no session or no lines), VALIDATION_FAILED
   * (`details.fields`), STOCK_CHANGED (`details.lines`), MONEY_OVERFLOW,
   * PAYMENT_FAILED (`details: { orderId, failureCode }`).
   */
  placeOrder(input: PlaceOrderInput): Promise<Result<Order>> {
    return this.dedupe(input.sessionId, input.idempotencyKey, (sessionId, idempotencyKey) =>
      this.execute(sessionId, idempotencyKey, input.address, input.card),
    );
  }

  /**
   * Shared front door of `placeOrder` / `placeOrderV2`: key and session
   * checks, then the in-flight registry, so a duplicate submit (same key)
   * shares one attempt whichever entry point it used.
   */
  protected dedupe(
    sessionId: string | null,
    idempotencyKey: unknown,
    run: (sessionId: string, idempotencyKey: string) => Promise<Result<Order>>,
  ): Promise<Result<Order>> {
    if (!isIdempotencyKey(idempotencyKey)) {
      return Promise.resolve(keyConflict());
    }
    if (sessionId === null || !isOwnerKey(sessionId)) {
      return Promise.resolve(fail("EMPTY_CART", "Your cart is empty."));
    }

    const existing = this.inFlight.get(idempotencyKey);
    if (existing !== undefined) {
      return existing.sessionId === sessionId
        ? existing.promise
        : Promise.resolve(keyConflict());
    }

    // `run` executes synchronously up to its first `await` (the charge), so
    // the entry is registered before any other call can observe the key.
    const promise = run(sessionId, idempotencyKey);
    const entry: InFlightEntry = { sessionId, promise };
    this.inFlight.set(idempotencyKey, entry);
    const forget = () => {
      if (this.inFlight.get(idempotencyKey) === entry) this.inFlight.delete(idempotencyKey);
    };
    promise.then(forget, forget);
    return promise;
  }

  /**
   * The session's order, or `null` for a malformed id, an unknown id, a
   * missing/invalid session or another session's order (indistinguishable).
   * The tombstone owner key (`DELETED_OWNER_KEY`, ruling R-1) never matches.
   * A pending claim (`payment_ref = PENDING_PAYMENT_REF`: charge in flight,
   * stored as `payment_failed` / `PROCESSING_ERROR`) is not an outcome yet and
   * is never returned either (D-T110-2): only finalized orders are readable.
   */
  getOrder(orderId: unknown, sessionId: string | null): Order | null {
    if (!isOrderId(orderId) || sessionId === null || !isOwnerKey(sessionId)) return null;
    const order = this.orders.findById(orderId);
    if (order === null || order.sessionId !== sessionId) return null;
    return this.isPendingClaim(order.id) ? null : order;
  }

  // -------------------------------------------------------------------------

  protected async execute(
    sessionId: string,
    idempotencyKey: string,
    rawAddress: unknown,
    rawCard: unknown,
  ): Promise<Result<Order>> {
    const stored = this.orders.findByIdempotencyKey(idempotencyKey);
    if (stored !== null) return this.settle(stored, sessionId);

    // Emptiness check on a plain read (no write lock), so an empty cart is
    // reported before field errors. The reservation re-reads the cart.
    const cart = this.readCart(sessionId);
    if (!cart.ok) return this.preChargeFailure(sessionId, idempotencyKey, cart.error);
    if (cart.value.items.length === 0) {
      return this.preChargeFailure(sessionId, idempotencyKey, { code: "EMPTY_CART", message: "Your cart is empty." });
    }

    const address = validateAddress(rawAddress);
    const card = validateCard(rawCard, this.now());
    if (!address.ok || !card.ok) {
      return this.preChargeFailure(sessionId, idempotencyKey, {
        code: "VALIDATION_FAILED",
        message: "Some fields are invalid.",
        details: {
          fields: {
            ...(address.ok ? {} : address.error.details.fields),
            ...(card.ok ? {} : card.error.details.fields),
          },
        },
      });
    }

    const reserved = this.reserve(sessionId, idempotencyKey, address.value, card.value);
    if (!reserved.ok) return this.preChargeFailure(sessionId, idempotencyKey, reserved.error);
    const reservation = reserved.value;

    let payment: PaymentResult;
    try {
      payment = await this.payments.charge({
        amountCents: reservation.subtotalCents,
        currency: reservation.currency,
        card: reservation.card,
        idempotencyKey,
      });
    } catch {
      // A throwing provider is treated as a processing error: never leave
      // stock reserved. The thrown value is not logged (it may echo input).
      payment = err({
        code: "PROCESSING_ERROR",
        message: PAYMENT_FAILURE_MESSAGES.PROCESSING_ERROR,
      });
    }

    return this.finalize(sessionId, idempotencyKey, reservation, payment);
  }

  /** `getCart`, with a total overflow turned into a `MONEY_OVERFLOW` result. */
  protected readCart(sessionId: string): Result<CartView> {
    try {
      return ok(this.carts.getCart(sessionId));
    } catch (e) {
      if (e instanceof CartTotalOverflowError) return err(moneyOverflow());
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Idempotency-key claim (D-T71-2/3). The claim is the order row itself,
  // inserted by the reservation transaction with `payment_ref =
  // PENDING_PAYMENT_REF` and finalized in place after the charge.

  /** True when the order row exists and still carries the pending marker. */
  protected isPendingClaim(orderId: string): boolean {
    const row = this.db
      .query<{ payment_ref: string | null }, [string]>("SELECT payment_ref FROM orders WHERE id = ?")
      .get(orderId);
    return row !== null && row.payment_ref === PENDING_PAYMENT_REF;
  }

  /**
   * Finalizes this attempt's pending row (status, failure code, provider ref).
   * Call inside the finalize transaction. Throws when the row is no longer
   * pending (never expected: only the claimant finalizes its row).
   */
  protected finalizeClaim(
    orderId: string,
    status: Order["status"],
    failureCode: PaymentFailureCode | null,
    paymentRef: string | null,
  ): void {
    const result = this.db
      .query<unknown, [string, string | null, string | null, string, string]>(
        "UPDATE orders SET status = ?, failure_code = ?, payment_ref = ? WHERE id = ? AND payment_ref = ?",
      )
      .run(status, failureCode, paymentRef, orderId, PENDING_PAYMENT_REF);
    if (result.changes !== 1) throw new Error("order claim is no longer pending");
  }

  /**
   * Withdraws this attempt's pending row (and its lines) so the key is free
   * again, e.g. when finalize failed and the action keeps the key for a retry.
   * Call inside a transaction. False when the row is not pending (nothing to
   * release then: the reservation is no longer this attempt's).
   */
  protected withdrawClaim(orderId: string): boolean {
    if (!this.isPendingClaim(orderId)) return false;
    this.db.query<unknown, [string]>("DELETE FROM order_events WHERE order_id = ?").run(orderId);
    this.db.query<unknown, [string]>("DELETE FROM order_items WHERE order_id = ?").run(orderId);
    this.db
      .query<unknown, [string, string]>("DELETE FROM orders WHERE id = ? AND payment_ref = ?")
      .run(orderId, PENDING_PAYMENT_REF);
    return true;
  }

  /**
   * Outcome for a key that is already held: another owner -> INVALID_INPUT at
   * once; a finalized row -> its replay; a pending row -> poll until it is
   * finalized (then replay) or the wait runs out / the claim is withdrawn
   * (INTERNAL_ERROR, never a second charge).
   */
  protected async settle(stored: Order, sessionId: string): Promise<Result<Order>> {
    if (stored.sessionId !== sessionId) return keyConflict();
    const deadline = Date.now() + this.claimWaitMs;
    for (;;) {
      if (!this.isPendingClaim(stored.id)) {
        const final = this.orders.findById(stored.id);
        return final === null ? err(claimUnresolved()) : replay(final, sessionId);
      }
      if (Date.now() >= deadline) return err(claimUnresolved());
      await sleep(PENDING_CLAIM_POLL_MS);
    }
  }

  /**
   * Every failure reported before a charge goes through here: when the key is
   * held by now (a racing attempt claimed it, possibly emptying the cart),
   * the held order's outcome wins over `error` (D-T71-3).
   */
  protected async preChargeFailure(sessionId: string, idempotencyKey: string, error: AppError): Promise<Result<Order>> {
    const stored = this.orders.findByIdempotencyKey(idempotencyKey);
    return stored === null ? err(error) : this.settle(stored, sessionId);
  }

  /**
   * Step 2: in one synchronous IMMEDIATE transaction, re-check the key, re-read
   * the cart, reserve stock and claim the key with a pending order row.
   */
  protected reserve(sessionId: string, idempotencyKey: string, address: Address, card: ValidatedCard): Result<Reservation> {
    try {
      return withTransaction(this.db, () => {
        // Under the write lock: a claim committed by any connection is visible
        // here, so a same-key attempt never reserves or charges twice.
        if (this.orders.findByIdempotencyKey(idempotencyKey) !== null) throw new Abort(claimUnresolved());
        const read = this.readCart(sessionId);
        if (!read.ok) throw new Abort(read.error);
        const cart = read.value;
        if (cart.items.length === 0) throw new Abort({ code: "EMPTY_CART", message: "Your cart is empty." });

        const changed = cart.items.filter((line) => line.status !== "ok").map(toStockChangedLine);
        if (changed.length > 0) throw new Abort(stockChanged(changed));

        const lineTotals: number[] = [];
        for (const line of cart.items) {
          const total = multiplyCents(line.unitPriceCents, line.quantity);
          if (!total.ok) throw new Abort(total.error.code === "MONEY_OVERFLOW" ? moneyOverflow() : total.error);
          lineTotals.push(total.value);
        }
        const subtotal = sumCents(lineTotals);
        if (!subtotal.ok) throw new Abort(subtotal.error.code === "MONEY_OVERFLOW" ? moneyOverflow() : subtotal.error);

        const failures: StockChangedLine[] = [];
        for (const line of cart.items) {
          const result = this.products.decrementStock(line.productId, line.quantity);
          if (!result.ok) {
            failures.push({
              productId: line.productId,
              name: line.name,
              requested: line.quantity,
              available: availableFrom(result.error),
            });
          }
        }
        // Throwing rolls back every decrement made above.
        if (failures.length > 0) throw new Abort(stockChanged(failures));

        const reservation: Reservation = {
          orderId: this.idGenerator(),
          createdAt: this.now().toISOString(),
          address,
          card,
          items: cart.items.map((line) => ({
            productId: line.productId,
            name: line.name,
            unitPriceCents: line.unitPriceCents,
            quantity: line.quantity,
          })),
          stockLines: cart.items.map((line) => ({ productId: line.productId, quantity: line.quantity })),
          subtotalCents: subtotal.value,
          currency: cart.currency,
        };
        // The claim: UNIQUE(idempotency_key) makes this the single winner.
        this.orders.insertOrder(
          { ...orderBase(sessionId, idempotencyKey, reservation), status: "payment_failed", failureCode: "PROCESSING_ERROR" },
          PENDING_PAYMENT_REF,
        );
        return ok(reservation);
      });
    } catch (e) {
      if (e instanceof Abort) return err(e.error);
      // Defensive: the key check above runs under the write lock, so only a
      // writer bypassing it could win the UNIQUE race; treat it as held.
      if (e instanceof DuplicateIdempotencyKeyError) return err(claimUnresolved());
      throw e;
    }
  }

  /** Step 4: persist the outcome; release the reservation unless paid. */
  protected finalize(
    sessionId: string,
    idempotencyKey: string,
    reservation: Reservation,
    payment: PaymentResult,
  ): Result<Order> {
    const base = orderBase(sessionId, idempotencyKey, reservation);

    try {
      if (payment.ok) {
        const order: Order = { ...base, status: "paid" };
        withTransaction(this.db, () => {
          this.finalizeClaim(order.id, "paid", null, payment.value.providerRef);
          const cleared = this.carts.clear(sessionId);
          if (!cleared.ok) throw new Abort(cleared.error);
        });
        return ok(order);
      }

      const failureCode = payment.error.code;
      const order: Order = { ...base, status: "payment_failed", failureCode };
      withTransaction(this.db, () => {
        this.orders.restoreStock(reservation.stockLines);
        this.finalizeClaim(order.id, "payment_failed", failureCode, null);
      });
      return err(paymentFailed(order.id, failureCode, payment.error.message));
    } catch (e) {
      // The finalize transaction rolled back, so this attempt's reservation
      // and pending claim are still held: withdraw the claim (the key is free
      // for the retry the form allows) and release the stock together.
      withTransaction(this.db, () => {
        if (this.withdrawClaim(base.id)) this.orders.restoreStock(reservation.stockLines);
      });
      if (e instanceof Abort) return err(e.error);
      throw e;
    }
  }
}

/** The MVP order fields shared by the pending claim and the finalized order. */
function orderBase(sessionId: string, idempotencyKey: string, reservation: Reservation) {
  return {
    id: reservation.orderId,
    sessionId,
    items: reservation.items,
    subtotalCents: reservation.subtotalCents,
    shippingCents: 0,
    totalCents: reservation.subtotalCents,
    currency: reservation.currency,
    address: reservation.address,
    cardLast4: reservation.card.last4,
    idempotencyKey,
    createdAt: reservation.createdAt,
  } as const;
}

/** Malformed idempotency key, or one already used by another session. */
function keyConflict(): Result<Order> {
  return fail("INVALID_INPUT", "The checkout request is invalid. Please reload the page and try again.", {
    field: "idempotencyKey",
  });
}

/** The stored outcome of an earlier attempt with the same key. */
function replay(order: Order, sessionId: string): Result<Order> {
  if (order.sessionId !== sessionId) return keyConflict();
  if (order.status === "paid") return ok(order);
  return err(paymentFailed(order.id, order.failureCode ?? "PROCESSING_ERROR"));
}

function toStockChangedLine(line: CartLineView): StockChangedLine {
  return {
    productId: line.productId,
    name: line.name,
    requested: line.quantity,
    available: line.availableStock,
  };
}

// ===========================================================================
// Orders v2 (T55): totals with discount + shipping, coupon redemption,
// snapshots, lazily persisted fulfilment events, history, cancel, buy again.
// See README.md "Orders v2 (T55)".
// ===========================================================================

/** Longest accepted delivery note (characters after cleaning). */
export const MAX_DELIVERY_NOTE_LENGTH = 200;
/** Longest accepted order-history search query (characters after cleaning). */
export const MAX_ORDERS_QUERY_LENGTH = 100;
/** Orders per history page. */
export const ORDERS_PAGE_SIZE = 10;
/** Default and maximum number of buy-again lines. */
export const DEFAULT_BUY_AGAIN_LIMIT = 20;
export const MAX_BUY_AGAIN_LIMIT = 50;
/**
 * Note stored on the `cancelled` order event. The mock payment provider has
 * no refund method, so the refund is recorded here only (criterion 6: the
 * "refund_pending" option).
 */
export const REFUND_PENDING_NOTE = "refund_pending";

export const ORDERS_TABS = ["all", "not_shipped", "cancelled"] as const;
export type OrdersTab = (typeof ORDERS_TABS)[number];
export const ORDERS_RANGES = ["30d", "3m", "6m", "1y", "all"] as const;
export type OrdersRange = (typeof ORDERS_RANGES)[number];
export const DEFAULT_ORDERS_TAB: OrdersTab = "all";
export const DEFAULT_ORDERS_RANGE: OrdersRange = "3m";

export interface PlaceOrderInputV2 {
  readonly sessionId: string;
  readonly address: Address;
  /** Untrusted (form input); `validateCard` decides, like MVP `PlaceOrderInput.card`. */
  readonly card: unknown;
  readonly idempotencyKey: string;
  /**
   * Optional contact phone, the address book's rule: `cleanText` max 20,
   * only digits, spaces and + - ( ), at least 7 digits. Absent/empty -> none.
   * Stored in `orders.phone`; surfaced as `OrderView.phone`.
   */
  readonly phone?: string | null;
  /** Default: the cart's selection, else the cheapest active method. */
  readonly shippingMethodId?: string | null;
  /** `cleanText`, at most 200 characters; empty -> none. */
  readonly deliveryNote?: unknown;
  /** Handled by the checkout action; ignored here. */
  readonly saveAddress?: boolean;
}

export interface OrderViewItem extends OrderItem {
  readonly productSlug: string | null;
  readonly imageUrl: string | null;
}

/**
 * An order as pages and components show it. `sessionId` (an owner key, a
 * bearer credential: ruling R-1) is deliberately omitted so a view can be
 * serialised to a client component; `idempotencyKey` is omitted too (never
 * rendered; the replay logic reads it from `Order` / `OrderRecord`).
 * `couponCode`, `shippingMethodName` and
 * `deliveryNote` are `string | null` here (optional on `Order`).
 */
export interface OrderView
  extends Omit<Order, "sessionId" | "idempotencyKey" | "couponCode" | "shippingMethodName" | "deliveryNote"> {
  /** Derived from time + persisted state (never regresses). */
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly timeline: readonly TimelineStep[];
  readonly cancellable: boolean;
  /** Last instant cancellation is allowed; null when the order is not cancellable now. */
  readonly cancellableUntil: IsoDateTimeString | null;
  readonly estimatedDelivery: { start: IsoDateTimeString; end: IsoDateTimeString } | null;
  readonly items: readonly OrderViewItem[];
  readonly couponCode: string | null;
  readonly discountCents: number;
  readonly shippingCents: number;
  readonly shippingMethodName: string | null;
  readonly deliveryNote: string | null;
  readonly simulatedTrackingNotice: string;
}

export interface ListOrdersQuery {
  readonly tab?: OrdersTab | string;
  readonly range?: OrdersRange | string;
  /** At most 100 characters; matches snapshot product names (case-insensitive substring). */
  readonly query?: unknown;
  /** 1-based; page size 10. */
  readonly page?: number;
}

export interface OrdersPage {
  readonly items: readonly OrderView[];
  readonly total: number;
  readonly page: number;
  /** ceil(total / 10); 0 when there are no matching orders. */
  readonly pageCount: number;
  readonly tab: OrdersTab;
  readonly range: OrdersRange;
}

export interface BuyAgainLine {
  readonly productId: string;
  readonly productSlug: string | null;
  readonly name: string;
  readonly imageUrl: string | null;
  readonly lastOrderedAt: IsoDateTimeString;
  /** Product exists, is published and has stock. */
  readonly available: boolean;
  /** The current product; null when deleted or unpublished. */
  readonly product: Product | null;
}

export interface OrderServiceV2 extends OrderService {
  placeOrderV2(input: PlaceOrderInputV2, now?: number): Promise<Result<OrderView, AppError>>;
  getOrderView(orderId: string, sessionId: string, now?: number): OrderView | null;
  listOrders(sessionId: string, query?: ListOrdersQuery, now?: number): OrdersPage;
  cancelOrder(orderId: string, sessionId: string, now?: number): Result<OrderView, AppError>;
  getBuyAgainLines(sessionId: string, limit?: number): readonly BuyAgainLine[];
}

export interface OrderServiceV2Deps extends OrderServiceDeps {
  readonly carts: CartServiceV2;
  readonly orders: OrderRepositoryV2;
  readonly coupons: CouponService;
  readonly shipping: ShippingService;
  /** Reads the cart's stored coupon code / shipping selection (bound to `db`). */
  readonly cartSettings: { getSettings(sessionId: string): CartSettings | null };
  /** Epoch-ms clock for v2 methods called without `now`. Default: `now().getTime()`. */
  readonly clock?: () => number;
}

/** What a successful v2 reservation hands to the charge/finalize steps. */
interface ReservationV2 {
  readonly orderId: string;
  readonly createdAt: IsoDateTimeString;
  readonly address: Address;
  readonly card: ValidatedCard;
  readonly items: readonly OrderSnapshotItem[];
  readonly stockLines: readonly StockLine[];
  readonly currency: CurrencyCode;
  readonly totals: Totals;
  readonly coupon: ValidatedCoupon | null;
  readonly method: ShippingMethod;
  readonly estimate: { readonly start: IsoDateTimeString; readonly end: IsoDateTimeString };
  readonly deliveryNote: string | null;
  readonly phone: string | null;
}

function orderNotFound(): AppError {
  return { code: "ORDER_NOT_FOUND", message: "We could not find that order." };
}

function notCancellable(): AppError {
  return { code: "ORDER_NOT_CANCELLABLE", message: "This order can no longer be cancelled." };
}

function invalidShippingMethod(): AppError {
  return {
    code: "INVALID_INPUT",
    message: "Choose a valid shipping method.",
    details: { field: "shippingMethodId" },
  };
}

function withField(error: AppError, field: string): AppError {
  return { ...error, details: { ...(error.details ?? {}), field } };
}

/** `cleanText` for the delivery note: absent/empty -> null. */
function parseDeliveryNote(raw: unknown): Result<string | null> {
  if (raw === undefined || raw === null) return ok(null);
  const cleaned = cleanText(raw, { max: MAX_DELIVERY_NOTE_LENGTH });
  if (!cleaned.ok) return err(withField(cleaned.error, "deliveryNote"));
  return ok(cleaned.value === "" ? null : cleaned.value);
}

/**
 * The address book's phone rule (`parseAddressInput`): absent/null/blank -> null;
 * non-string -> INVALID_TYPE; longer than PHONE_MAX after `cleanText` -> TOO_LONG;
 * then the address service's own `validatePhone` (INVALID_CHARACTERS /
 * INVALID_LENGTH), imported so the two rules cannot drift (consistency af).
 */
export function parseOrderPhone(raw: unknown): { ok: true; value: string | null } | { ok: false; error: FieldError } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const cleaned = cleanText(raw, { max: PHONE_MAX });
  if (!cleaned.ok) {
    return cleaned.error.code === "TOO_LONG"
      ? { ok: false, error: { code: "TOO_LONG", message: "Phone must be at most " + String(PHONE_MAX) + " characters." } }
      : { ok: false, error: { code: "INVALID_TYPE", message: "Phone must be text." } };
  }
  const value = cleaned.value;
  if (value === "") return { ok: true, value: null };
  const problem = validatePhone(value);
  return problem === null ? { ok: true, value } : { ok: false, error: problem };
}

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

function parsePage(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) return value;
  if (typeof value === "string" && /^[0-9]{1,9}$/.test(value)) {
    const n = Number(value);
    if (n >= 1) return n;
  }
  return 1;
}

/** Cleaned, lower-cased search text, or null (absent, empty, hostile or too long). */
function parseQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = cleanText(value, { max: MAX_ORDERS_QUERY_LENGTH });
  if (!cleaned.ok || cleaned.value === "") return null;
  return cleaned.value.toLowerCase();
}

/** `now` minus whole UTC calendar months, clamping the day (e.g. May 31 - 3m = Feb 28/29). */
function subtractMonthsUtc(nowMs: number, months: number): number {
  const d = new Date(nowMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() - months;
  const target = new Date(0);
  target.setUTCFullYear(year, month, 1);
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(target.getUTCFullYear(), target.getUTCMonth() + 1, 0);
  const day = Math.min(d.getUTCDate(), lastDay.getUTCDate());
  target.setUTCFullYear(target.getUTCFullYear(), target.getUTCMonth(), day);
  target.setUTCHours(d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  return target.getTime();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Inclusive lower bound (`created_at >= cutoff`) for a range, or null for
 * "all". 30d = 30 x 24 h; 3m/6m/1y = 3/6/12 UTC calendar months.
 */
export function rangeCutoff(range: OrdersRange, nowMs: number): IsoDateTimeString | null {
  let cutoff: number;
  switch (range) {
    case "all":
      return null;
    case "30d":
      cutoff = nowMs - 30 * DAY_MS;
      break;
    case "3m":
      cutoff = subtractMonthsUtc(nowMs, 3);
      break;
    case "6m":
      cutoff = subtractMonthsUtc(nowMs, 6);
      break;
    case "1y":
      cutoff = subtractMonthsUtc(nowMs, 12);
      break;
  }
  // Outside the Date range (absurd clocks): no lower bound.
  return Number.isFinite(cutoff) && Math.abs(cutoff) <= 8.64e15 ? new Date(cutoff).toISOString() : null;
}

function toFulfillmentInput(record: OrderRecord, method: FulfillmentInput["method"]): FulfillmentInput {
  return {
    createdAt: record.createdAt,
    status: record.status,
    fulfillmentStatus: record.fulfillmentStatus,
    cancelledAt: record.cancelledAt,
    method,
  };
}

/** `undefined`-free optional spread helper. */
function opt<K extends string, V>(key: K, value: V | null): { [P in K]?: V } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: V };
}

export class DefaultOrderServiceV2 extends OrderService implements OrderServiceV2 {
  private readonly cartsV2: CartServiceV2;
  private readonly ordersV2: OrderRepositoryV2;
  private readonly coupons: CouponService;
  private readonly shipping: ShippingService;
  private readonly cartSettings: { getSettings(sessionId: string): CartSettings | null };
  private readonly clock: () => number;

  constructor(deps: OrderServiceV2Deps) {
    super(deps);
    this.cartsV2 = deps.carts;
    this.ordersV2 = deps.orders;
    this.coupons = deps.coupons;
    this.shipping = deps.shipping;
    this.cartSettings = deps.cartSettings;
    this.clock = deps.clock ?? (() => this.now().getTime());
  }

  /**
   * Places an order with server-computed totals (discount + shipping).
   * Same front door, idempotency and reserve-then-charge order as
   * `placeOrder`; see README.md "Orders v2 (T55)" for the error table.
   */
  placeOrderV2(input: PlaceOrderInputV2, now?: number): Promise<Result<OrderView, AppError>> {
    const nowMs = this.resolveNow(now);
    const placed = this.dedupe(input.sessionId, input.idempotencyKey, (sessionId, idempotencyKey) =>
      this.executeV2(sessionId, idempotencyKey, input, nowMs),
    );
    return placed.then((result) => {
      if (!result.ok) return result;
      const view = this.viewOf(result.value.id, nowMs);
      return view === null ? err(orderNotFound()) : ok(view);
    });
  }

  getOrderView(orderId: string, sessionId: string, now?: number): OrderView | null {
    const record = this.ownedRecord(orderId, sessionId);
    if (record === null) return null;
    return this.viewOf(record.id, this.resolveNow(now));
  }

  listOrders(sessionId: string, query: ListOrdersQuery = {}, now?: number): OrdersPage {
    const safe: ListOrdersQuery = typeof query === "object" && query !== null ? query : {};
    const tab = pick(ORDERS_TABS, safe.tab, DEFAULT_ORDERS_TAB);
    const range = pick(ORDERS_RANGES, safe.range, DEFAULT_ORDERS_RANGE);
    const requestedPage = parsePage(safe.page);
    const empty: OrdersPage = { items: [], total: 0, page: 1, pageCount: 0, tab, range };
    if (!isOwnerKey(sessionId)) return empty;

    const nowMs = this.resolveNow(now);
    const text = parseQuery(safe.query);
    const records = this.ordersV2.listPaidRecords(sessionId, rangeCutoff(range, nowMs));
    const matching = records.filter((record) => {
      if (text !== null && !record.items.some((item) => item.name.toLowerCase().includes(text))) {
        return false;
      }
      if (tab === "all") return true;
      const status = deriveStatus(this.inputOf(record), nowMs, this.depsOf(record));
      return tab === "cancelled" ? status === "cancelled" : status === "processing" || status === "packed";
    });

    const total = matching.length;
    const pageCount = Math.ceil(total / ORDERS_PAGE_SIZE);
    const page = Math.min(requestedPage, Math.max(1, pageCount));
    const start = (page - 1) * ORDERS_PAGE_SIZE;
    const items: OrderView[] = [];
    for (const record of matching.slice(start, start + ORDERS_PAGE_SIZE)) {
      const view = this.viewOf(record.id, nowMs);
      if (view !== null) items.push(view);
    }
    return { items, total, page, pageCount, tab, range };
  }

  cancelOrder(orderId: string, sessionId: string, now?: number): Result<OrderView, AppError> {
    const owned = this.ownedRecord(orderId, sessionId);
    if (owned === null) return err(orderNotFound());
    const nowMs = this.resolveNow(now);
    const cancelledAt = new Date(nowMs).toISOString();

    try {
      withTransaction(this.db, (tx) => {
        // Re-read under the write lock: a concurrent cancel cannot slip in.
        const record = this.ordersV2.findRecordById(owned.id);
        if (record === null || record.status !== "paid") throw new Abort(orderNotFound());
        if (record.fulfillmentStatus === "cancelled" || record.cancelledAt !== null) {
          throw new Abort(notCancellable());
        }
        if (!isCancellable(this.inputOf(record), nowMs)) throw new Abort(notCancellable());

        this.persistEvents(record, nowMs);
        if (!this.ordersV2.markCancelled(record.id, cancelledAt)) throw new Abort(notCancellable());
        this.ordersV2.insertEventIfAbsent(record.id, "cancelled", cancelledAt, REFUND_PENDING_NOTE);
        if (record.items.length > 0) {
          this.ordersV2.restoreStock(
            record.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
          );
        }
        // Only THIS order's redemption (D-T55-1): after a guest merge the owner may
        // hold a row recorded for another live order under the same code.
        if (record.couponCode !== null) releaseRedemptionForOrder(tx, record.couponCode, record.sessionId, record.id);
      });
    } catch (e) {
      if (e instanceof Abort) return err(e.error);
      throw e;
    }

    const view = this.viewOf(owned.id, nowMs);
    return view === null ? err(orderNotFound()) : ok(view);
  }

  getBuyAgainLines(sessionId: string, limit: number = DEFAULT_BUY_AGAIN_LIMIT): readonly BuyAgainLine[] {
    if (!isOwnerKey(sessionId)) return [];
    const max =
      typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1
        ? Math.min(limit, MAX_BUY_AGAIN_LIMIT)
        : DEFAULT_BUY_AGAIN_LIMIT;

    const seen = new Set<string>();
    const lines: { productId: string; name: string; productSlug: string | null; imageUrl: string | null; orderedAt: string }[] = [];
    for (const row of this.ordersV2.listPurchasedLines(sessionId)) {
      if (seen.has(row.productId)) continue;
      seen.add(row.productId);
      lines.push(row);
      if (lines.length >= max) break;
    }
    if (lines.length === 0) return [];

    const ids = lines.map((line) => line.productId);
    const nowIso = new Date(this.clock()).toISOString();
    const published = new Map<string, boolean>();
    for (const row of this.ordersV2.getProductAvailability(ids)) {
      published.set(row.productId, row.publishedAt <= nowIso);
    }
    const products = new Map(this.products.getManyByIds(ids).map((p) => [p.id, p]));

    return lines.map((line) => {
      const current = published.get(line.productId) === true ? (products.get(line.productId) ?? null) : null;
      return {
        productId: line.productId,
        productSlug: line.productSlug ?? current?.slug ?? null,
        name: line.name,
        imageUrl: line.imageUrl ?? current?.imageUrl ?? null,
        lastOrderedAt: line.orderedAt,
        available: current !== null && current.stock > 0,
        product: current,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Placement

  private resolveNow(now: number | undefined): number {
    return typeof now === "number" && Number.isFinite(now) ? now : this.clock();
  }

  private async executeV2(
    sessionId: string,
    idempotencyKey: string,
    input: PlaceOrderInputV2,
    nowMs: number,
  ): Promise<Result<Order>> {
    const stored = this.orders.findByIdempotencyKey(idempotencyKey);
    if (stored !== null) return this.settle(stored, sessionId);
    const failure = (error: AppError) => this.preChargeFailure(sessionId, idempotencyKey, error);

    const cart = this.readCart(sessionId);
    if (!cart.ok) return failure(cart.error);
    if (cart.value.items.length === 0) return failure({ code: "EMPTY_CART", message: "Your cart is empty." });

    const address = validateAddress(input.address);
    const card = validateCard(input.card, new Date(nowMs));
    const phone = parseOrderPhone(input.phone);
    if (!address.ok || !card.ok || !phone.ok) {
      return failure({
        code: "VALIDATION_FAILED",
        message: "Some fields are invalid.",
        details: {
          fields: {
            ...(address.ok ? {} : address.error.details.fields),
            ...(card.ok ? {} : card.error.details.fields),
            ...(phone.ok ? {} : { phone: phone.error }),
          },
        },
      });
    }

    const note = parseDeliveryNote(input.deliveryNote);
    if (!note.ok) return failure(note.error);

    const rawMethod: unknown = input.shippingMethodId;
    let requestedMethod: string | null = null;
    if (typeof rawMethod === "string") requestedMethod = rawMethod;
    else if (rawMethod !== undefined && rawMethod !== null) return failure(invalidShippingMethod());

    const reserved = this.reserveV2(
      sessionId,
      idempotencyKey,
      address.value,
      card.value,
      note.value,
      phone.value,
      requestedMethod,
      nowMs,
    );
    if (!reserved.ok) return failure(reserved.error);
    const reservation = reserved.value;

    let payment: PaymentResult;
    if (reservation.totals.totalCents === 0) {
      // Fully discounted with free shipping: nothing to charge (the provider
      // rejects a zero amount). Recorded as paid with no payment_ref.
      payment = ok({ providerRef: "", last4: reservation.card.last4 });
    } else {
      try {
        payment = await this.payments.charge({
          amountCents: reservation.totals.totalCents,
          currency: reservation.currency,
          card: reservation.card,
          idempotencyKey,
        });
      } catch {
        payment = err({ code: "PROCESSING_ERROR", message: PAYMENT_FAILURE_MESSAGES.PROCESSING_ERROR });
      }
    }

    return this.finalizeV2(sessionId, idempotencyKey, reservation, payment);
  }

  /** `getCartView`, with a total overflow turned into a `MONEY_OVERFLOW` result. */
  private readCartView(sessionId: string, nowMs: number): Result<CartViewV2> {
    try {
      return this.cartsV2.getCartView(sessionId, nowMs);
    } catch (e) {
      if (e instanceof CartTotalOverflowError) return err(moneyOverflow());
      throw e;
    }
  }

  /**
   * One synchronous IMMEDIATE transaction: idempotency-key re-check, cart
   * view, coupon re-validation, shipping method, server-side totals, stock
   * decrements, the coupon redemption and the key claim (pending order row).
   * Any failure rolls all of it back; nothing has been charged yet.
   */
  private reserveV2(
    sessionId: string,
    idempotencyKey: string,
    address: Address,
    card: ValidatedCard,
    deliveryNote: string | null,
    phone: string | null,
    requestedMethodId: string | null,
    nowMs: number,
  ): Result<ReservationV2> {
    try {
      return withTransaction(this.db, (tx) => {
        // Under the write lock: a claim committed by any connection is visible
        // here, so a same-key attempt never reserves or charges twice.
        if (this.orders.findByIdempotencyKey(idempotencyKey) !== null) throw new Abort(claimUnresolved());
        // Read the stored code BEFORE the view: the view silently drops an
        // invalid coupon, but an order must fail with the coupon's error.
        const settings = this.cartSettings.getSettings(sessionId);
        const read = this.readCartView(sessionId, nowMs);
        if (!read.ok) throw new Abort(read.error);
        const view = read.value;
        if (view.items.length === 0) throw new Abort({ code: "EMPTY_CART", message: "Your cart is empty." });

        const changed = view.items.filter((line) => line.status !== "ok").map(toStockChangedLine);
        if (changed.length > 0) throw new Abort(stockChanged(changed));

        const lineTotals: number[] = [];
        for (const line of view.items) {
          const total = multiplyCents(line.unitPriceCents, line.quantity);
          if (!total.ok) throw new Abort(total.error.code === "MONEY_OVERFLOW" ? moneyOverflow() : total.error);
          lineTotals.push(total.value);
        }
        const subtotal = sumCents(lineTotals);
        if (!subtotal.ok) throw new Abort(subtotal.error.code === "MONEY_OVERFLOW" ? moneyOverflow() : subtotal.error);

        let coupon: ValidatedCoupon | null = null;
        const storedCode = settings?.couponCode ?? null;
        if (storedCode !== null) {
          const validated = this.coupons.validate(storedCode, subtotal.value, sessionId, nowMs);
          if (!validated.ok) {
            throw new Abort(validated.error.code === "MONEY_OVERFLOW" ? moneyOverflow() : validated.error);
          }
          coupon = validated.value;
        }

        const quote = this.resolveShipping(requestedMethodId ?? settings?.shippingMethodId ?? null, subtotal.value);
        if (!quote.ok) throw new Abort(quote.error);

        const totals = computeTotals({ subtotalCents: subtotal.value, coupon, shipping: quote.value });
        if (!totals.ok) throw new Abort(totals.error.code === "MONEY_OVERFLOW" ? moneyOverflow() : totals.error);

        const failures: StockChangedLine[] = [];
        for (const line of view.items) {
          const result = this.products.decrementStock(line.productId, line.quantity);
          if (!result.ok) {
            failures.push({
              productId: line.productId,
              name: line.name,
              requested: line.quantity,
              available: availableFrom(result.error),
            });
          }
        }
        if (failures.length > 0) throw new Abort(stockChanged(failures));

        const orderId = this.idGenerator();
        if (coupon !== null) {
          // Savepoint inside this transaction; the conditional UPDATE plus the
          // IMMEDIATE write lock make the last redemption race-safe.
          const redeemed = recordRedemption(tx, coupon.code, sessionId, orderId);
          if (!redeemed.ok) throw new Abort(redeemed.error);
        }

        const method = quote.value.method;
        const reservation: ReservationV2 = {
          orderId,
          createdAt: new Date(nowMs).toISOString(),
          address,
          card,
          items: view.items.map((line) => ({
            productId: line.productId,
            name: line.name,
            unitPriceCents: line.unitPriceCents,
            quantity: line.quantity,
            productSlug: line.slug === "" ? null : line.slug,
            imageUrl: line.imageUrl === "" ? null : line.imageUrl,
          })),
          stockLines: view.items.map((line) => ({ productId: line.productId, quantity: line.quantity })),
          currency: view.currency,
          totals: totals.value,
          coupon,
          method,
          estimate: estimateDelivery(method, nowMs, nowMs),
          deliveryNote,
          phone,
        };
        // The claim: UNIQUE(idempotency_key) makes this the single winner.
        this.ordersV2.insertOrderV2(
          { ...orderBaseV2(sessionId, idempotencyKey, reservation), status: "payment_failed", failureCode: "PROCESSING_ERROR" },
          PENDING_PAYMENT_REF,
        );
        return ok(reservation);
      });
    } catch (e) {
      if (e instanceof Abort) return err(e.error);
      // Defensive (see `reserve`): a lost UNIQUE race means the key is held.
      if (e instanceof DuplicateIdempotencyKeyError) return err(claimUnresolved());
      throw e;
    }
  }

  /** Explicit id or the cart's selection must be active; none -> cheapest. */
  private resolveShipping(methodId: string | null, subtotalCents: number): Result<ShippingQuote> {
    if (methodId === null) {
      const cheapest = this.shipping.cheapest(subtotalCents);
      return cheapest === null
        ? fail("INVALID_INPUT", "No shipping method is available.", { field: "shippingMethodId" })
        : ok(cheapest);
    }
    if (this.shipping.getMethod(methodId) === null) return err(invalidShippingMethod());
    const quote = this.shipping.quote(methodId, subtotalCents);
    return quote.ok ? quote : err(quote.error.code === "INVALID_INPUT" ? invalidShippingMethod() : quote.error);
  }

  /** Persist the outcome; release the reservation (stock + coupon) unless paid. */
  private finalizeV2(
    sessionId: string,
    idempotencyKey: string,
    r: ReservationV2,
    payment: PaymentResult,
  ): Result<Order> {
    const base = orderBaseV2(sessionId, idempotencyKey, r);
    const release = () => {
      this.orders.restoreStock(r.stockLines);
      if (r.coupon !== null) releaseRedemptionForOrder(this.db, r.coupon.code, sessionId, r.orderId);
    };

    try {
      if (payment.ok) {
        const order = { ...base, status: "paid" } as const;
        withTransaction(this.db, () => {
          this.finalizeClaim(order.id, "paid", null, payment.value.providerRef === "" ? null : payment.value.providerRef);
          this.ordersV2.insertEventIfAbsent(order.id, "processing", order.createdAt, null);
          const cleared = this.carts.clear(sessionId);
          if (!cleared.ok) throw new Abort(cleared.error);
        });
        return ok(toPlainOrder(order));
      }

      const failureCode = payment.error.code;
      const order = { ...base, status: "payment_failed", failureCode } as const;
      withTransaction(this.db, () => {
        release();
        this.finalizeClaim(order.id, "payment_failed", failureCode, null);
      });
      return err(paymentFailed(order.id, failureCode, payment.error.message));
    } catch (e) {
      // The finalize transaction rolled back, so the reservation (stock and
      // redemption) and the pending claim are still held: withdraw the claim
      // (the form keeps the key for a retry) and release them together.
      withTransaction(this.db, () => {
        if (this.withdrawClaim(r.orderId)) release();
      });
      if (e instanceof Abort) return err(e.error);
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Views and fulfilment events

  /** The owner's paid order record, or null (malformed/unknown/foreign/tombstone/payment_failed). */
  private ownedRecord(orderId: unknown, sessionId: unknown): OrderRecord | null {
    if (!isOrderId(orderId) || !isOwnerKey(sessionId)) return null;
    const record = this.ordersV2.findRecordById(orderId);
    if (record === null || record.sessionId !== sessionId) return null;
    if (record.sessionId === DELETED_OWNER_KEY || record.status !== "paid") return null;
    return record;
  }

  /** Method timing for fulfilment: the order's method row (even if inactive now). */
  private methodOf(record: OrderRecord): FulfillmentInput["method"] {
    if (record.shippingMethodId === null) return null;
    return (
      this.ordersV2.findShippingMethodTiming(record.shippingMethodId) ?? {
        id: record.shippingMethodId,
        minDays: 5,
        maxDays: 8,
      }
    );
  }

  private inputOf(record: OrderRecord): FulfillmentInput {
    return toFulfillmentInput(record, this.methodOf(record));
  }

  /**
   * One deps object per order, passed to every fulfilment call so they
   * agree. It returns the order's persisted delivery window when present
   * (snapshot, immune to later shipping-method edits), else T38's
   * `estimateDelivery` (identical for orders placed by `placeOrderV2`).
   */
  private depsOf(record: OrderRecord): FulfillmentDeps {
    const start = record.estimatedDeliveryStart;
    const end = record.estimatedDeliveryEnd;
    if (start !== null && end !== null && Number.isFinite(Date.parse(start)) && Number.isFinite(Date.parse(end))) {
      return { estimateDelivery: () => ({ start, end }) };
    }
    return { estimateDelivery };
  }

  /**
   * Writes the events reached by `nowMs` that are not persisted yet
   * (`INSERT OR IGNORE`, at most once per status, stamped with the derived
   * offsets) and moves `fulfillment_status` forward (never back). Must run
   * inside a transaction.
   */
  private persistEvents(record: OrderRecord, nowMs: number): void {
    const input = this.inputOf(record);
    const deps = this.depsOf(record);
    const persisted = this.ordersV2.listEvents(record.id);
    const missing = nextEvents(input, nowMs, deps, persisted.map((e) => e.status));
    for (const event of missing) {
      this.ordersV2.insertEventIfAbsent(record.id, event.status, event.at, null);
    }
    if (record.fulfillmentStatus === "cancelled") return;
    const derived = deriveStatus(input, nowMs, deps);
    if (derived === "cancelled" || sequenceIndex(derived) <= sequenceIndex(record.fulfillmentStatus)) return;
    const all = missing.length === 0 ? persisted : this.ordersV2.listEvents(record.id);
    const at = (status: FulfillmentStatus) => all.find((e) => e.status === status)?.at ?? null;
    this.ordersV2.advanceFulfillment(record.id, record.fulfillmentStatus, derived, at("shipped"), at("delivered"));
  }

  /** True when `persistEvents` would write anything (cheap read-only pre-check). */
  private needsSync(record: OrderRecord, nowMs: number): boolean {
    if (record.status !== "paid") return false;
    const input = this.inputOf(record);
    const deps = this.depsOf(record);
    const persisted = this.ordersV2.listEvents(record.id).map((e) => e.status);
    if (nextEvents(input, nowMs, deps, persisted).length > 0) return true;
    if (record.fulfillmentStatus === "cancelled") return false;
    const derived = deriveStatus(input, nowMs, deps);
    return derived !== "cancelled" && sequenceIndex(derived) > sequenceIndex(record.fulfillmentStatus);
  }

  /** Syncs events (in a write transaction only when needed) and builds the view. */
  private viewOf(orderId: string, nowMs: number): OrderView | null {
    let record = this.ordersV2.findRecordById(orderId);
    if (record === null || record.status !== "paid" || record.sessionId === DELETED_OWNER_KEY) return null;
    if (this.needsSync(record, nowMs)) {
      record = withTransaction(this.db, () => {
        const fresh = this.ordersV2.findRecordById(orderId);
        if (fresh !== null && fresh.status === "paid") this.persistEvents(fresh, nowMs);
        return this.ordersV2.findRecordById(orderId);
      });
      if (record === null) return null;
    }
    return this.toView(record, this.ordersV2.listEvents(record.id), nowMs);
  }

  private toView(record: OrderRecord, events: readonly OrderEvent[], nowMs: number): OrderView {
    const input = this.inputOf(record);
    const deps = this.depsOf(record);
    const cancellable = isCancellable(input, nowMs);
    return {
      id: record.id,
      status: record.status,
      items: record.items.map((item) => ({ ...item })),
      subtotalCents: record.subtotalCents,
      shippingCents: record.shippingCents,
      totalCents: record.totalCents,
      currency: record.currency,
      address: record.address,
      cardLast4: record.cardLast4,
      ...opt("failureCode", record.failureCode),
      createdAt: record.createdAt,
      ...opt("shippingMethodId", record.shippingMethodId),
      ...opt("estimatedDeliveryStart", record.estimatedDeliveryStart),
      ...opt("estimatedDeliveryEnd", record.estimatedDeliveryEnd),
      ...opt("cancelledAt", record.cancelledAt),
      ...opt("shippedAt", record.shippedAt),
      ...opt("deliveredAt", record.deliveredAt),
      ...opt("phone", record.phone),
      events,
      fulfillmentStatus: deriveStatus(input, nowMs, deps),
      timeline: timeline(input, nowMs, deps, events),
      cancellable,
      cancellableUntil: cancellable ? cancellableUntil(input) : null,
      estimatedDelivery: estimatedDelivery(input, deps),
      couponCode: record.couponCode,
      discountCents: record.discountCents,
      shippingMethodName: record.shippingMethodName,
      deliveryNote: record.deliveryNote,
      simulatedTrackingNotice: SIMULATED_TRACKING_NOTICE,
    };
  }
}

/** The v2 order fields shared by the pending claim and the finalized order. */
function orderBaseV2(sessionId: string, idempotencyKey: string, r: ReservationV2) {
  return {
    id: r.orderId,
    sessionId,
    items: r.items,
    subtotalCents: r.totals.subtotalCents,
    shippingCents: r.totals.shippingCents,
    discountCents: r.totals.discountCents,
    totalCents: r.totals.totalCents,
    currency: r.currency,
    address: r.address,
    cardLast4: r.card.last4,
    idempotencyKey,
    createdAt: r.createdAt,
    fulfillmentStatus: "processing",
    ...opt("couponCode", r.coupon?.code ?? null),
    shippingMethodId: r.method.id,
    shippingMethodName: r.method.name,
    estimatedDeliveryStart: r.estimate.start,
    estimatedDeliveryEnd: r.estimate.end,
    ...opt("deliveryNote", r.deliveryNote),
    ...opt("phone", r.phone),
  } as const;
}

/** The MVP-shaped `Order` (plain `OrderItem` lines) for the shared in-flight registry. */
function toPlainOrder(order: Order & { readonly items: readonly OrderSnapshotItem[] }): Order {
  return {
    ...order,
    items: order.items.map(({ productId, name, unitPriceCents, quantity }) => ({
      productId,
      name,
      unitPriceCents,
      quantity,
    })),
  };
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

const globalForOrders = globalThis as typeof globalThis & {
  __storefrontPaymentProvider?: MockPaymentProvider;
  __storefrontOrderInFlight?: InFlightRegistry;
  __storefrontOrderService?: { readonly db: Database; readonly service: OrderServiceV2 };
};

/**
 * The app-wide mock payment provider, cached on `globalThis` (like
 * `getDatabase`) so its idempotency cache survives requests and dev HMR.
 */
export function getPaymentProvider(): MockPaymentProvider {
  globalForOrders.__storefrontPaymentProvider ??= createMockPaymentProvider();
  return globalForOrders.__storefrontPaymentProvider;
}

function getInFlightRegistry(): InFlightRegistry {
  globalForOrders.__storefrontOrderInFlight ??= new Map();
  return globalForOrders.__storefrontOrderInFlight;
}

export interface CreateOrderServiceOptions {
  /** Epoch-ms clock (placement time, card expiry, coupons, fulfilment). Default `Date.now`. */
  readonly now?: () => number;
  /** Default: the shared `getPaymentProvider()`. */
  readonly payments?: PaymentProvider;
  /** Default: the process-wide registry on `globalThis`. */
  readonly inFlight?: InFlightRegistry;
  /** Order id generator. Default `crypto.randomUUID`. */
  readonly idGenerator?: () => string;
  /** Wait for another connection's pending same-key claim. Default `PENDING_CLAIM_WAIT_MS`. */
  readonly claimWaitMs?: number;
}

/**
 * App wiring: the shared DB (or `db`), SQLite repositories, cart v2, coupon
 * and shipping services bound to the same DB, the shared provider and the
 * process-wide in-flight registry.
 */
export function createOrderService(
  db: Database = getDatabase(),
  deps: CreateOrderServiceOptions = {},
): OrderServiceV2 {
  const clock = deps.now;
  const dateClock = clock === undefined ? undefined : () => new Date(clock());
  return new DefaultOrderServiceV2({
    db,
    carts: createCartService(db, clock === undefined ? {} : { now: clock }),
    products: new SqliteProductRepository(db),
    orders: new SqliteOrderRepository(db, dateClock === undefined ? {} : { now: dateClock }),
    payments: deps.payments ?? getPaymentProvider(),
    inFlight: deps.inFlight ?? getInFlightRegistry(),
    coupons: createCouponService(clock === undefined ? { db } : { db, now: clock }),
    shipping: createShippingService({ db }),
    cartSettings: new SqliteCartRepository(db),
    ...(dateClock === undefined ? {} : { now: dateClock }),
    ...(clock === undefined ? {} : { clock }),
    ...(deps.idGenerator === undefined ? {} : { idGenerator: deps.idGenerator }),
    ...(deps.claimWaitMs === undefined ? {} : { claimWaitMs: deps.claimWaitMs }),
  });
}

/** App-wide singleton over `getDatabase()` (rebuilt if the shared DB changes). */
export function getOrderService(): OrderServiceV2 {
  const db = getDatabase();
  const cached = globalForOrders.__storefrontOrderService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createOrderService(db);
  globalForOrders.__storefrontOrderService = { db, service };
  return service;
}
