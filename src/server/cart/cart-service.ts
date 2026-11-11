import type { Database } from "bun:sqlite";
import type { Cart, CartItem, CartItemStatus, CurrencyCode, IsoDateTimeString, Product } from "@/lib/types";
import { err, fail, ok, type AppError, type Result } from "@/lib/result";
import { formatMoney, multiplyCents, sumCents } from "@/lib/money";
import { DEFAULT_MAX_QUANTITY, validateQuantity } from "@/lib/validation";
import { getDatabase, withTransaction } from "@/server/db/client";
import {
  SqliteProductRepository,
  type ProductPublicationLookup,
  type ProductRepository,
} from "@/server/catalog/product-repository";
import { isSessionId } from "@/server/session/session-id";
import { createListService, MAX_QUANTITY_DESIRED, type ListService } from "@/server/lists/list-service";
import { createCouponService, type CouponService, type ValidatedCoupon } from "@/server/pricing/coupon-service";
import { createShippingService, type ShippingQuote, type ShippingService } from "@/server/pricing/shipping-service";
import { computeTotals, type Totals } from "@/server/pricing/totals";
import { SqliteCartRepository, type CartRepository, type CartRow } from "./cart-repository";

/**
 * Cart rules (server-only). All methods are synchronous: bun:sqlite is sync
 * and `withTransaction` needs a sync callback. Server actions wrap them.
 *
 * Prices are never stored in the cart; every view is re-derived from the
 * current catalogue. See README.md in this folder for the full rules.
 */

/** A cart line joined with its current product. */
export interface CartLineView extends CartItem {
  readonly name: string;
  readonly slug: string;
  readonly imageUrl: string;
  /** Current product stock (0 when the product is gone). */
  readonly availableStock: number;
  /** `unitPriceCents * min(quantity, availableStock)`; 0 when unavailable. */
  readonly lineTotalCents: number;
}

export interface CartView extends Omit<Cart, "items"> {
  readonly items: readonly CartLineView[];
  /** Sum of stored quantities over all lines (what the shopper put in the cart). */
  readonly itemCount: number;
  /** False when the cart is empty or any line is `unavailable`. */
  readonly canCheckout: boolean;
}

export interface CartTotals {
  readonly subtotalCents: number;
  readonly itemCount: number;
}

export interface CartServiceDeps {
  readonly db: Database;
  readonly carts: CartRepository;
  readonly products: ProductRepository;
  /** Per-line quantity limit; defaults to `DEFAULT_MAX_QUANTITY` (99). */
  readonly maxQuantity?: number;
  /**
   * Publication check (R-CART-1). Defaults to a `SqliteProductRepository`
   * over `db`. A product not published at the clock's `now` cannot be added
   * (PRODUCT_NOT_FOUND) and its existing lines read as `unavailable`.
   */
  readonly publication?: ProductPublicationLookup;
  /**
   * Epoch-ms clock: publication checks, and (v2) coupon validation when a
   * call passes no `now`. Defaults to `Date.now`.
   */
  readonly now?: () => number;
}

/** Currency of an empty cart (matches the `carts.currency` column default). */
export const DEFAULT_CART_CURRENCY: CurrencyCode = "USD";

/** Shown for a line whose product no longer exists in the catalogue. */
export const UNAVAILABLE_PRODUCT_NAME = "Unavailable product";

/** ISO cut-off for `published_at <= now`. A non-finite clock value is a wiring bug: throw (rolls back). */
function toIsoCutoff(nowMs: number): string {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new TypeError("CartService: the clock must return finite epoch milliseconds");
  }
  return new Date(nowMs).toISOString();
}

/** Marks a mutation that takes no quantity (removeItem, clear). Never reachable from callers. */
const NO_QUANTITY: unique symbol = Symbol("NO_QUANTITY");

/** Thrown inside a transaction to roll it back; converted to `Err` outside. */
class CartAbort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

/** The one PRODUCT_NOT_FOUND shape: unknown and unpublished ids must be indistinguishable. */
function productNotFound(productId: string): CartAbort {
  return new CartAbort({ code: "PRODUCT_NOT_FOUND", message: "Product not found", details: { productId } });
}

/**
 * Thrown by `getCart`/`getTotals` when a line or subtotal exceeds
 * `Number.MAX_SAFE_INTEGER`, i.e. an absurd catalogue price. Callers map it
 * to `MONEY_OVERFLOW`. Mutations never throw it: they roll back and return
 * `err({ code: "MONEY_OVERFLOW", ... })` instead.
 */
export class CartTotalOverflowError extends Error {
  readonly code = "MONEY_OVERFLOW" as const;

  constructor(message: string) {
    super(message);
    this.name = "CartTotalOverflowError";
  }
}

/** Money helpers only fail on overflow (or invalid data, a corrupted-DB invariant violation). */
function unwrapCents(result: Result<number>): number {
  if (!result.ok) throw new CartTotalOverflowError(`Cart total could not be computed: ${result.error.message}`);
  return result.value;
}

function emptyView(sessionId: string): CartView {
  return {
    sessionId,
    items: [],
    subtotalCents: 0,
    currency: DEFAULT_CART_CURRENCY,
    itemCount: 0,
    canCheckout: false,
  };
}

/**
 * `published` = the product is published at the view's `now` (R-CART-1). An
 * unpublished product reads like an out-of-stock one with no product link:
 * `unavailable`, `availableStock` 0, `lineTotalCents` 0, `slug` "".
 */
function toLineView(row: CartRow, product: Product | undefined, published: boolean): CartLineView {
  if (product !== undefined && !published) {
    return {
      productId: row.productId,
      quantity: row.quantity,
      unitPriceCents: product.priceCents,
      status: "unavailable",
      name: product.name,
      slug: "",
      imageUrl: product.imageUrl,
      availableStock: 0,
      lineTotalCents: 0,
    };
  }
  if (product === undefined) {
    return {
      productId: row.productId,
      quantity: row.quantity,
      unitPriceCents: 0,
      status: "unavailable",
      name: UNAVAILABLE_PRODUCT_NAME,
      slug: "",
      imageUrl: "",
      availableStock: 0,
      lineTotalCents: 0,
    };
  }
  const status: CartItemStatus =
    product.stock === 0 ? "unavailable" : row.quantity > product.stock ? "reduced" : "ok";
  const billable = Math.min(row.quantity, product.stock);
  return {
    productId: row.productId,
    quantity: row.quantity,
    unitPriceCents: product.priceCents,
    status,
    name: product.name,
    slug: product.slug,
    imageUrl: product.imageUrl,
    availableStock: product.stock,
    lineTotalCents: unwrapCents(multiplyCents(product.priceCents, billable)),
  };
}

export class CartService {
  protected readonly db: Database;
  protected readonly carts: CartRepository;
  protected readonly products: ProductRepository;
  protected readonly maxQuantity: number;
  protected readonly publication: ProductPublicationLookup;
  protected readonly now: () => number;

  constructor(deps: CartServiceDeps) {
    this.db = deps.db;
    this.carts = deps.carts;
    this.products = deps.products;
    this.publication = deps.publication ?? new SqliteProductRepository(deps.db);
    this.now = deps.now ?? Date.now;
    const max: unknown = deps.maxQuantity ?? DEFAULT_MAX_QUANTITY;
    if (typeof max !== "number" || !Number.isSafeInteger(max) || max <= 0) {
      throw new TypeError("CartService: maxQuantity must be a positive safe integer");
    }
    this.maxQuantity = max;
  }

  /**
   * Current cart joined with the live catalogue. A null or invalid session
   * id yields an empty cart without touching the DB. Never throws for
   * changed prices, changed stock, missing or unpublished products (lines
   * are flagged). Publication is judged at the service clock's `now`.
   */
  getCart(sessionId: string | null): CartView {
    return this.cartAt(sessionId, this.now());
  }

  /** `getCart` with publication judged at `nowMs`. */
  protected cartAt(sessionId: string | null, nowMs: number): CartView {
    if (sessionId === null || !isSessionId(sessionId)) return emptyView(sessionId ?? "");
    const rows = this.carts.getItems(sessionId);
    if (rows.length === 0) return emptyView(sessionId);

    const ids = rows.map((r) => r.productId);
    const products = this.products.getManyByIds(ids);
    const byId = new Map(products.map((p) => [p.id, p]));
    const published = this.publication.filterPublishedIds(ids, toIsoCutoff(nowMs));
    const items = rows.map((row) => toLineView(row, byId.get(row.productId), published.has(row.productId)));
    const currency = products[0]?.currency ?? DEFAULT_CART_CURRENCY;

    return {
      sessionId,
      items,
      subtotalCents: unwrapCents(sumCents(items.map((i) => i.lineTotalCents))),
      currency,
      itemCount: items.reduce((n, i) => n + i.quantity, 0),
      canCheckout: !items.some((i) => i.status === "unavailable"),
    };
  }

  /** Subtotal and item count only (header badge). Same rules as `getCart`. */
  getTotals(sessionId: string | null): CartTotals {
    const view = this.getCart(sessionId);
    return { subtotalCents: view.subtotalCents, itemCount: view.itemCount };
  }

  /**
   * Adds `quantity` units to the line (creating it if needed). The new line
   * total may never exceed stock or `maxQuantity`; on any error nothing is
   * written. Errors: INVALID_INPUT (session), INVALID_QUANTITY,
   * PRODUCT_NOT_FOUND, OUT_OF_STOCK, INSUFFICIENT_STOCK
   * (`details: { productId, available: stock - existing, requested }`).
   */
  addItem(sessionId: string, productId: string, quantity: number): Result<CartView> {
    return this.mutate(sessionId, quantity, (qty) => {
      const product = this.requireInStock(productId, qty);
      const existing = this.existingQuantity(sessionId, productId);
      const next = existing + qty;
      if (next > product.stock) {
        const available = Math.max(0, product.stock - existing);
        throw new CartAbort({
          code: "INSUFFICIENT_STOCK",
          message: `Only ${available} more of ${product.name} available`,
          details: { productId, available, requested: qty },
        });
      }
      const total = validateQuantity(next, this.maxQuantity);
      if (!total.ok) throw new CartAbort(total.error);
      this.write(sessionId, product, next);
    });
  }

  /**
   * Sets the line to exactly `quantity` (1..maxQuantity, <= stock). A product
   * that is not yet in the cart is added (upsert), provided it exists and is
   * published; an existing line is updated without the publication check
   * (R-CART-1: only add paths are gated; the view keeps it unavailable). 0 is
   * rejected with INVALID_QUANTITY: use `removeItem` to delete a line.
   * Errors: INVALID_INPUT, INVALID_QUANTITY, PRODUCT_NOT_FOUND, OUT_OF_STOCK,
   * INSUFFICIENT_STOCK (`details: { productId, available: stock, requested }`).
   */
  setQuantity(sessionId: string, productId: string, quantity: number): Result<CartView> {
    return this.mutate(sessionId, quantity, (qty) => {
      const isNewLine = this.existingQuantity(sessionId, productId) === 0;
      const product = this.requireInStock(productId, qty, isNewLine);
      if (qty > product.stock) {
        throw new CartAbort({
          code: "INSUFFICIENT_STOCK",
          message: `Only ${product.stock} of ${product.name} available`,
          details: { productId, available: product.stock, requested: qty },
        });
      }
      this.write(sessionId, product, qty);
    });
  }

  /** Removes the line. Idempotent: an absent line or unknown product is a success. */
  removeItem(sessionId: string, productId: string): Result<CartView> {
    return this.mutate(sessionId, NO_QUANTITY, () => {
      this.carts.removeItem(sessionId, productId);
    });
  }

  /** Empties the cart. Idempotent. */
  clear(sessionId: string): Result<CartView> {
    return this.mutate(sessionId, NO_QUANTITY, () => {
      this.carts.clear(sessionId);
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Shared mutation wrapper: validates the session and, unless `quantity` is
   * the private `NO_QUANTITY` sentinel, the quantity (as `unknown`: callers
   * across the server-action boundary may pass null, strings, ...). Then runs
   * `fn` with the validated quantity in a transaction, and returns the fresh view read inside that
   * transaction. An `Abort` thrown by `fn` rolls back and becomes `Err`; a
   * `CartTotalOverflowError` while building the view rolls back and becomes
   * `Err` with code MONEY_OVERFLOW.
   */
  private mutate(
    sessionId: string,
    quantity: unknown,
    fn: (validatedQuantity: number) => void,
  ): Result<CartView> {
    if (!isSessionId(sessionId)) {
      return fail("INVALID_INPUT", "A valid session is required to change the cart");
    }
    let validated = 0;
    if (quantity !== NO_QUANTITY) {
      const q = validateQuantity(quantity, this.maxQuantity);
      if (!q.ok) return err(q.error);
      validated = q.value;
    }
    return this.transact(() => {
      fn(validated);
      return this.getCart(sessionId);
    });
  }

  /**
   * Runs `fn` in one transaction. An `Abort` rolls back and becomes `Err`; a
   * `CartTotalOverflowError` rolls back and becomes `Err` MONEY_OVERFLOW; any
   * other error rolls back and is rethrown.
   */
  protected transact<T>(fn: () => T): Result<T> {
    try {
      return ok(withTransaction(this.db, fn));
    } catch (e) {
      if (e instanceof CartAbort) return err(e.error);
      if (e instanceof CartTotalOverflowError) {
        return fail("MONEY_OVERFLOW", "This cart total is too large to process.");
      }
      throw e;
    }
  }

  /**
   * The product, or abort. Unknown and (when `checkPublished`) unpublished
   * products abort with the identical PRODUCT_NOT_FOUND error, before the
   * stock check, so an unpublished product's existence or stock never leaks.
   */
  protected requireInStock(productId: string, requested: number, checkPublished = true): Product {
    const product = this.products.getById(productId);
    if (product === null) throw productNotFound(productId);
    if (checkPublished && !this.publication.filterPublishedIds([productId], toIsoCutoff(this.now())).has(productId)) {
      throw productNotFound(productId);
    }
    if (product.stock === 0) {
      throw new CartAbort({
        code: "OUT_OF_STOCK",
        message: `${product.name} is out of stock`,
        details: { productId, available: 0, requested },
      });
    }
    return product;
  }

  protected existingQuantity(sessionId: string, productId: string): number {
    return this.carts.getItems(sessionId).find((r) => r.productId === productId)?.quantity ?? 0;
  }

  protected write(sessionId: string, product: Product, quantity: number): void {
    this.carts.ensureCart(sessionId, product.currency);
    this.carts.upsertItem(sessionId, product.id, quantity);
  }
}

// ===========================================================================
// Cart v2 (T45): save for later, coupon, shipping selection, full cart view.
// ===========================================================================

/** One item of the session's save-for-later list, joined with its current product. */
export interface SavedForLaterLine {
  readonly productId: string;
  /** null when the product vanished from the catalogue. */
  readonly product: Product | null;
  readonly quantityDesired: number;
  /** Product exists and has stock. */
  readonly available: boolean;
  /** Current price; null when the product vanished. */
  readonly priceCents: number | null;
  /** Price at save time minus current price when it dropped, else null. */
  readonly priceDroppedByCents: number | null;
  readonly addedAt: IsoDateTimeString;
  /**
   * D-T82-4: "unavailable" when the product is no longer offered: it vanished
   * from the catalogue (`product` null) or is not published at the view's
   * `now` (R-CART-1). Then `available` is false, `priceDroppedByCents` is
   * null and an unpublished product's `slug` is "" (no dead product link,
   * like an unpublished cart line). null otherwise (in stock or merely out
   * of stock). `getCartView` always sets it; optional in the type only so
   * existing hand-built `SavedForLaterLine` literals stay valid.
   */
  readonly reason?: SavedForLaterUnavailableReason | null;
}

/** Why a saved item can no longer be bought at all (D-T82-4). */
export type SavedForLaterUnavailableReason = "unavailable";

/** Options for {@link CartServiceV2.getCartView} (D-T108-3). */
export interface CartViewOptions {
  /**
   * Epoch ms for the WHOLE read: publication of cart lines and saved items
   * (R-CART-1) and coupon validation. Lets a page loader judge everything at
   * the one `now` it read. Defaults to the service clock (read once). Must
   * be finite, else the view is `INVALID_INPUT`.
   */
  readonly now?: number;
}

export interface CartViewV2 extends CartView {
  readonly saved: readonly SavedForLaterLine[];
  /** The stored coupon, re-validated against the current subtotal on this read; null when none or dropped. */
  readonly coupon: ValidatedCoupon | null;
  /** Set when a stored code was dropped on this read: why, user-safe. */
  readonly couponNotice: string | null;
  /**
   * D-T55-2: set (to `SHIPPING_METHOD_DROPPED_NOTICE`) on the one read that
   * cleared a stored shipping method which is no longer active; else null.
   * `getCartView` always sets it; optional in the type only so existing
   * hand-built `CartViewV2` literals stay valid.
   */
  readonly shippingNotice?: string | null;
  /**
   * Selected method, or the cheapest for the current subtotal; null when no
   * line is available with a billable quantity (no lines, or every line
   * unavailable: D-T45-1) or no method is active.
   */
  readonly shipping: ShippingQuote | null;
  /** Active methods quoted at the current subtotal; [] when no line is billable (D-T45-1). */
  readonly shippingOptions: readonly ShippingQuote[];
  /** `computeTotals({ subtotalCents, coupon, shipping })`: total = subtotal - discount + shipping. */
  readonly totals: Totals;
}

export interface CartServiceV2 extends CartService {
  /**
   * Cart + saved items + coupon + shipping + totals. Re-validates the stored
   * coupon on every read: an invalid one is not applied, `couponNotice`
   * explains why and the stored code is cleared. Invalid or unknown session
   * -> empty view. Throws only `CartTotalOverflowError` (like `getCart`).
   *
   * Clock (D-T108-3): a NUMBER is the coupon clock only and publication is
   * judged at the service clock (order placement passes historical clocks and
   * must not re-judge publication). An OPTIONS object's `now` is used for the
   * whole read (publication + coupon), so a page judges everything at its own
   * `now`; with `{}` or no argument the service clock is read once.
   */
  getCartView(sessionId: string, now?: number | CartViewOptions): Result<CartViewV2, AppError>;
  /** Moves the line into the save-for-later list (quantityDesired = line quantity, capped 99). Absent line -> no-op success. One transaction. */
  saveForLater(sessionId: string, productId: string): Result<void, AppError>;
  /** Adds min(quantityDesired, room left by stock and the line max) >= 1 and removes it from saved. On any error it stays saved. */
  moveToCart(sessionId: string, productId: string): Result<CartLineView, AppError>;
  /** Validates against the current subtotal and stores the code. On error any previously applied coupon is untouched. */
  applyCoupon(sessionId: string, code: unknown, now?: number): Result<ValidatedCoupon, AppError>;
  /** Clears the stored coupon. Idempotent. */
  removeCoupon(sessionId: string): Result<void, AppError>;
  /** Active method ids only, else INVALID_INPUT (`details.field = "shippingMethodId"`). Stored on `carts.shipping_method_id`. */
  selectShippingMethod(sessionId: string, methodId: unknown): Result<ShippingQuote, AppError>;
}

export interface CartServiceV2Deps extends CartServiceDeps {
  /** Must be bound to the same `db` (saveForLater/moveToCart nest its writes in the cart transaction). */
  readonly lists: ListService;
  readonly coupons: CouponService;
  readonly shipping: ShippingService;
  // `now` (inherited from CartServiceDeps): coupon validation when a call passes no `now`, and publication checks.
}

const ZERO_TOTALS: Totals = {
  subtotalCents: 0,
  discountCents: 0,
  shippingCents: 0,
  totalCents: 0,
  amountToFreeShippingCents: null,
};

function emptyViewV2(sessionId: string): CartViewV2 {
  return {
    ...emptyView(sessionId),
    saved: [],
    coupon: null,
    couponNotice: null,
    shippingNotice: null,
    shipping: null,
    shippingOptions: [],
    totals: ZERO_TOTALS,
  };
}

/** D-T45-1: some line is available with billable quantity `min(quantity, availableStock) > 0`. */
function hasBillableLine(items: readonly CartLineView[]): boolean {
  return items.some((i) => i.status !== "unavailable" && Math.min(i.quantity, i.availableStock) > 0);
}

function overflow(error: AppError): CartTotalOverflowError {
  return new CartTotalOverflowError(`Cart total could not be computed: ${error.message}`);
}

/** User-safe notice for a stored shipping method that is no longer offered (D-T55-2). */
export const SHIPPING_METHOD_DROPPED_NOTICE =
  "Your selected shipping method is no longer available and was removed. We are showing the cheapest available option.";

/** User-safe explanation for a stored coupon dropped on read. `code` is the stored, already-normalised code. */
export function couponDroppedNotice(code: string, error: AppError): string {
  switch (error.code) {
    case "COUPON_EXPIRED":
      return `Promo code ${code} has expired and was removed from your cart.`;
    case "COUPON_MIN_SUBTOTAL": {
      const min = error.details?.minSubtotalCents;
      const amount =
        typeof min === "number" && Number.isSafeInteger(min) && min >= 0 ? ` of ${formatMoney(min, DEFAULT_CART_CURRENCY)}` : "";
      return `Promo code ${code} was removed because your subtotal is below its minimum${amount}.`;
    }
    case "COUPON_EXHAUSTED":
      return `Promo code ${code} is no longer available and was removed from your cart.`;
    case "COUPON_USED":
      return `Promo code ${code} has already been used and was removed from your cart.`;
    default:
      return `Promo code ${code} is no longer valid and was removed from your cart.`;
  }
}

function notSaved(productId: string): CartAbort {
  return new CartAbort({ code: "NOT_FOUND", message: "This item is not in Saved for later", details: { productId } });
}

/**
 * `CartService` plus the v2 features. The MVP methods are inherited
 * unchanged. Lists/coupons/shipping are injected services bound to the same DB.
 */
export class DefaultCartServiceV2 extends CartService implements CartServiceV2 {
  private readonly lists: ListService;
  private readonly coupons: CouponService;
  private readonly shipping: ShippingService;

  constructor(deps: CartServiceV2Deps) {
    super(deps);
    this.lists = deps.lists;
    this.coupons = deps.coupons;
    this.shipping = deps.shipping;
  }

  getCartView(sessionId: string, now?: number | CartViewOptions): Result<CartViewV2, AppError> {
    if (!isSessionId(sessionId)) return ok(emptyViewV2(typeof sessionId === "string" ? sessionId : ""));
    // A numeric `now` stays coupon-only: publication (R-CART-1) is judged at
    // the service clock, like addItem (order placement passes historical
    // clocks for backdated orders and must not re-judge publication). An
    // options object's `now` is the clock for the whole read (D-T108-3).
    const options = typeof now === "object" && now !== null ? now : null;
    const optionNow = options?.now;
    if (optionNow !== undefined && (typeof optionNow !== "number" || !Number.isFinite(optionNow))) {
      return fail("INVALID_INPUT", "The cart view clock must be finite epoch milliseconds", { field: "now" });
    }
    const at = optionNow ?? this.now();
    const couponAt = typeof now === "number" ? now : at;
    const cart = this.cartAt(sessionId, at);
    const settings = this.carts.getSettings(sessionId);

    let coupon: ValidatedCoupon | null = null;
    let couponNotice: string | null = null;
    const storedCode = settings?.couponCode ?? null;
    if (storedCode !== null) {
      const validated = this.coupons.validate(storedCode, cart.subtotalCents, sessionId, couponAt);
      if (validated.ok) {
        coupon = validated.value;
      } else {
        if (validated.error.code === "MONEY_OVERFLOW") throw overflow(validated.error);
        this.carts.clearCouponIf(sessionId, storedCode);
        couponNotice = couponDroppedNotice(storedCode, validated.error);
      }
    }

    // D-T55-2: a stored method that is no longer active (or no longer exists)
    // is cleared with a conditional UPDATE and a one-time notice, so the view
    // and order placement (which falls back to the cheapest when none is
    // stored) agree. Judged whether or not the cart has lines.
    let selectedId = settings?.shippingMethodId ?? null;
    let shippingNotice: string | null = null;
    if (selectedId !== null && this.shipping.getMethod(selectedId) === null) {
      if (this.carts.clearShippingMethodIf(sessionId, selectedId)) shippingNotice = SHIPPING_METHOD_DROPPED_NOTICE;
      selectedId = null;
    }

    // D-T45-1: shipping (and so the free-shipping progress) is quoted only
    // when at least one line is available with a billable quantity, whatever
    // the (discounted or zero-priced) amount, so the view matches order
    // placement; a cart whose every line is unavailable has zero totals.
    let shippingOptions: readonly ShippingQuote[] = [];
    let shipping: ShippingQuote | null = null;
    if (hasBillableLine(cart.items)) {
      shippingOptions = this.shipping.listMethods(cart.subtotalCents);
      shipping =
        (selectedId === null ? undefined : shippingOptions.find((q) => q.method.id === selectedId)) ??
        this.shipping.cheapest(cart.subtotalCents);
    }

    const totals = computeTotals({ subtotalCents: cart.subtotalCents, coupon, shipping });
    if (!totals.ok) {
      if (totals.error.code === "MONEY_OVERFLOW") throw overflow(totals.error);
      return err(totals.error);
    }

    return ok({
      ...cart,
      saved: this.savedLines(sessionId, at),
      coupon,
      couponNotice,
      shippingNotice,
      shipping,
      shippingOptions,
      totals: totals.value,
    });
  }

  saveForLater(sessionId: string, productId: string): Result<void, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", "A valid session is required to change the cart");
    if (typeof productId !== "string") return ok(undefined);
    return this.transact(() => {
      const line = this.carts.getItems(sessionId).find((r) => r.productId === productId);
      if (line === undefined) return;
      const desired = Math.min(line.quantity, MAX_QUANTITY_DESIRED);
      const list = this.lists.ensureSaveForLater(sessionId);
      if (!list.ok) throw new CartAbort(list.error);
      const added = this.lists.addItem(sessionId, list.value.id, productId, { quantityDesired: desired });
      if (!added.ok) throw new CartAbort(added.error);
      if (added.value.alreadyPresent && added.value.item.quantityDesired < desired) {
        const updated = this.lists.updateItem(sessionId, list.value.id, productId, { quantityDesired: desired });
        if (!updated.ok) throw new CartAbort(updated.error);
      }
      this.carts.removeItem(sessionId, productId);
    });
  }

  moveToCart(sessionId: string, productId: string): Result<CartLineView, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", "A valid session is required to change the cart");
    if (typeof productId !== "string" || productId.length === 0) {
      return fail("NOT_FOUND", "This item is not in Saved for later");
    }
    return this.transact(() => {
      const listId = this.savedListId(sessionId);
      if (listId === null) throw notSaved(productId);
      const list = this.lists.getList(sessionId, listId);
      if (!list.ok) throw new CartAbort(list.error);
      const item = list.value.items.find((i) => i.productId === productId);
      if (item === undefined) throw notSaved(productId);

      // Same stock rules as addItem: never exceed stock or maxQuantity.
      const product = this.requireInStock(productId, item.quantityDesired);
      const existing = this.existingQuantity(sessionId, productId);
      const stockRoom = product.stock - existing;
      if (stockRoom <= 0) {
        throw new CartAbort({
          code: "INSUFFICIENT_STOCK",
          message: `Only 0 more of ${product.name} available`,
          details: { productId, available: 0, requested: item.quantityDesired },
        });
      }
      const maxRoom = this.maxQuantity - existing;
      if (maxRoom <= 0) {
        const tooMany = validateQuantity(existing + 1, this.maxQuantity);
        throw new CartAbort(
          tooMany.ok ? { code: "INVALID_QUANTITY", message: "Quantity limit reached" } : tooMany.error,
        );
      }
      const next = existing + Math.min(item.quantityDesired, stockRoom, maxRoom);
      this.write(sessionId, product, next);
      const removed = this.lists.removeItem(sessionId, listId, productId);
      if (!removed.ok) throw new CartAbort(removed.error);
      return toLineView({ productId, quantity: next }, product, true);
    });
  }

  applyCoupon(sessionId: string, code: unknown, now?: number): Result<ValidatedCoupon, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", "A valid session is required to change the cart");
    const at = now ?? this.now();
    return this.transact(() => {
      const cart = this.getCart(sessionId);
      const validated = this.coupons.validate(code, cart.subtotalCents, sessionId, at);
      if (!validated.ok) throw new CartAbort(validated.error);
      this.carts.ensureCart(sessionId, cart.currency);
      this.carts.setCouponCode(sessionId, validated.value.code);
      return validated.value;
    });
  }

  removeCoupon(sessionId: string): Result<void, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", "A valid session is required to change the cart");
    return this.transact(() => {
      this.carts.setCouponCode(sessionId, null);
    });
  }

  selectShippingMethod(sessionId: string, methodId: unknown): Result<ShippingQuote, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", "A valid session is required to change the cart");
    return this.transact(() => {
      const method = this.shipping.getMethod(methodId);
      if (method === null) {
        throw new CartAbort({
          code: "INVALID_INPUT",
          message: "Choose a valid shipping method.",
          details: { field: "shippingMethodId" },
        });
      }
      const cart = this.getCart(sessionId);
      const quote = this.shipping.quote(method.id, cart.subtotalCents);
      if (!quote.ok) throw new CartAbort(quote.error);
      this.carts.ensureCart(sessionId, cart.currency);
      this.carts.setShippingMethodId(sessionId, method.id);
      return quote.value;
    });
  }

  // -------------------------------------------------------------------------

  /** Id of the session's save-for-later list without creating it. */
  private savedListId(sessionId: string): string | null {
    return this.lists.listLists(sessionId).find((l) => l.kind === "save_for_later")?.id ?? null;
  }

  /**
   * Saved items; `available` also requires publication at `nowMs` (R-CART-1:
   * moveToCart would refuse it). A vanished or unpublished product gets
   * `reason: "unavailable"` and no price drop; an unpublished one keeps its
   * name/image/price but `slug: ""` (D-T82-4, parity with cart lines).
   */
  private savedLines(sessionId: string, nowMs: number): readonly SavedForLaterLine[] {
    const listId = this.savedListId(sessionId);
    if (listId === null) return [];
    const list = this.lists.getList(sessionId, listId);
    if (!list.ok) {
      if (list.error.code === "MONEY_OVERFLOW") throw overflow(list.error);
      return [];
    }
    const published = this.publication.filterPublishedIds(
      list.value.items.map((item) => item.productId),
      toIsoCutoff(nowMs),
    );
    return list.value.items.map((item): SavedForLaterLine => {
      const product = item.product;
      if (product === null || !published.has(item.productId)) {
        return {
          productId: item.productId,
          product: product === null ? null : { ...product, slug: "" },
          quantityDesired: item.quantityDesired,
          available: false,
          priceCents: product?.priceCents ?? null,
          priceDroppedByCents: null,
          addedAt: item.addedAt,
          reason: "unavailable",
        };
      }
      return {
        productId: item.productId,
        product,
        quantityDesired: item.quantityDesired,
        available: item.available,
        priceCents: product.priceCents,
        priceDroppedByCents: item.priceDroppedByCents,
        addedAt: item.addedAt,
        reason: null,
      };
    });
  }
}

/**
 * App wiring: the shared DB (or `db` when given) with the SQLite repositories
 * and the lists/coupon/shipping services bound to the same DB. `deps.now` is
 * the epoch-ms clock (coupon validation, list timestamps, publication checks).
 */
export function createCartService(db: Database = getDatabase(), deps: { readonly now?: () => number } = {}): CartServiceV2 {
  const clock = deps.now;
  const products = new SqliteProductRepository(db);
  return new DefaultCartServiceV2({
    db,
    carts: new SqliteCartRepository(db),
    products,
    publication: products,
    lists: createListService(clock === undefined ? { db } : { db, now: () => new Date(clock()) }),
    coupons: createCouponService(clock === undefined ? { db } : { db, now: clock }),
    shipping: createShippingService({ db }),
    ...(clock === undefined ? {} : { now: clock }),
  });
}

const globalForCart = globalThis as typeof globalThis & {
  __storefrontCartService?: { readonly db: Database; readonly service: CartServiceV2 };
};

/** App-wide singleton over `getDatabase()` (rebuilt if the shared DB changes). */
export function getCartService(): CartServiceV2 {
  const db = getDatabase();
  const cached = globalForCart.__storefrontCartService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createCartService(db);
  globalForCart.__storefrontCartService = { db, service };
  return service;
}
