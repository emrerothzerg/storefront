import type { Database } from "bun:sqlite";
import type {
  Address,
  FulfillmentStatus,
  IsoDateTimeString,
  Order,
  OrderEvent,
  OrderItem,
  OrderStatus,
  PaymentFailureCode,
  ShippingMethod,
} from "@/lib/types";
import { PAYMENT_FAILURE_MESSAGES } from "@/server/payments/mock-payment-provider";

/**
 * Order persistence (server-only): a thin SQL layer over `orders` and
 * `order_items`, plus the stock restore used when a reserved checkout fails.
 * Bound parameters only. No business rules live here; `OrderService` owns
 * them. All methods are synchronous so they compose inside `withTransaction`.
 *
 * Card data: only `cardLast4` is ever written. There is no column for the
 * full number, expiry or CVC, and nothing here accepts them.
 */

/** A product/quantity pair whose reserved stock should be put back. */
export interface StockLine {
  readonly productId: string;
  readonly quantity: number;
}

export interface OrderRepository {
  /**
   * Inserts the order row and one `order_items` row per item. Call inside
   * `withTransaction` so the order and its items land together.
   * `paymentRef` is the provider reference (successful orders only).
   * @throws DuplicateIdempotencyKeyError when an order with the same
   *   `idempotencyKey` already exists (the UNIQUE constraint fired).
   */
  insertOrder(order: Order, paymentRef: string | null): void;
  /** `null` when no order has this id. */
  findById(id: string): Order | null;
  /** `null` when no order has this idempotency key. */
  findByIdempotencyKey(key: string): Order | null;
  /**
   * Adds each line's quantity back to `products.stock`. Used to release a
   * reservation when payment fails. Lines whose product no longer exists are
   * skipped. Call inside `withTransaction` to combine with other writes.
   */
  restoreStock(lines: readonly StockLine[]): void;
}

/** An order line with its phase-2 snapshot columns (NULL on pre-v2 rows). */
export interface OrderSnapshotItem extends OrderItem {
  readonly productSlug: string | null;
  readonly imageUrl: string | null;
}

/** What `insertOrderV2` writes: an `Order` (v2 optional fields honoured) with snapshot lines. */
export interface NewOrderV2 extends Omit<Order, "items" | "events"> {
  readonly items: readonly OrderSnapshotItem[];
}

/**
 * Full persisted order (v1 + v2 columns), internal to the order service. The
 * nullable v2 columns are `null` (never `undefined`) here; the service maps
 * them onto the public view.
 */
export interface OrderRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly status: OrderStatus;
  readonly failureCode: PaymentFailureCode | null;
  readonly items: readonly OrderSnapshotItem[];
  readonly subtotalCents: number;
  readonly shippingCents: number;
  readonly discountCents: number;
  readonly totalCents: number;
  readonly currency: string;
  readonly address: Address;
  readonly cardLast4: string;
  readonly idempotencyKey: string;
  readonly createdAt: IsoDateTimeString;
  /** Persisted fulfilment status (DB default 'processing'). */
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly couponCode: string | null;
  readonly shippingMethodId: string | null;
  readonly shippingMethodName: string | null;
  readonly estimatedDeliveryStart: IsoDateTimeString | null;
  readonly estimatedDeliveryEnd: IsoDateTimeString | null;
  readonly cancelledAt: IsoDateTimeString | null;
  readonly shippedAt: IsoDateTimeString | null;
  readonly deliveredAt: IsoDateTimeString | null;
  readonly phone: string | null;
  readonly deliveryNote: string | null;
}

/** Current availability facts for one product (for buy-again lines). */
export interface ProductAvailabilityRow {
  readonly productId: string;
  readonly stock: number;
  readonly publishedAt: IsoDateTimeString;
}

/** One purchased line of a paid, non-cancelled order, newest order first. */
export interface PurchasedLineRow {
  readonly productId: string;
  readonly name: string;
  readonly productSlug: string | null;
  readonly imageUrl: string | null;
  readonly orderedAt: IsoDateTimeString;
}

/** Phase-2 order persistence (T55). All methods are synchronous. */
export interface OrderRepositoryV2 extends OrderRepository {
  /** Like `insertOrder`, plus every v2 column and the line snapshots. @throws DuplicateIdempotencyKeyError */
  insertOrderV2(order: NewOrderV2, paymentRef: string | null): void;
  findRecordById(id: string): OrderRecord | null;
  /** The owner's PAID orders created at or after `sinceIso` (all when null), newest first. */
  listPaidRecords(sessionId: string, sinceIso: IsoDateTimeString | null): readonly OrderRecord[];
  /** The order's events, oldest first (by id). */
  listEvents(orderId: string): readonly OrderEvent[];
  /** `INSERT OR IGNORE` on UNIQUE(order_id, status): true when a row was written. */
  insertEventIfAbsent(orderId: string, status: FulfillmentStatus, at: IsoDateTimeString, note: string | null): boolean;
  /**
   * Moves `fulfillment_status` from `from` to `to` (compare-and-set) and fills
   * `shipped_at` / `delivered_at` when given and still NULL. False when the
   * persisted status was no longer `from`.
   */
  advanceFulfillment(
    orderId: string,
    from: FulfillmentStatus,
    to: FulfillmentStatus,
    shippedAt: IsoDateTimeString | null,
    deliveredAt: IsoDateTimeString | null,
  ): boolean;
  /** Compare-and-set: paid + 'processing' -> 'cancelled' with `cancelled_at`. False when not applicable. */
  markCancelled(orderId: string, cancelledAt: IsoDateTimeString): boolean;
  /** A shipping method by id INCLUDING inactive ones (timing for orders placed with it). */
  findShippingMethodTiming(id: string): Pick<ShippingMethod, "id" | "minDays" | "maxDays"> | null;
  /** Current stock and published_at for the given product ids (missing ids omitted). */
  getProductAvailability(ids: readonly string[]): readonly ProductAvailabilityRow[];
  /** Lines of the owner's paid, non-cancelled orders, newest order first, then line order. */
  listPurchasedLines(sessionId: string): readonly PurchasedLineRow[];
}

/** The UNIQUE constraint on `orders.idempotency_key` rejected an insert. */
export class DuplicateIdempotencyKeyError extends Error {
  constructor(readonly idempotencyKey: string) {
    super("An order with this idempotency key already exists");
    this.name = "DuplicateIdempotencyKeyError";
  }
}

export interface SqliteOrderRepositoryOptions {
  /** Clock for `products.updated_at` in `restoreStock`. Default `new Date()`. */
  readonly now?: () => Date;
}

/** Shape of an `orders` row as selected below. Internal: never returned. */
interface OrderRow {
  id: string;
  session_id: string;
  status: string;
  failure_code: string | null;
  subtotal_cents: number;
  total_cents: number;
  currency: string;
  full_name: string;
  email: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  card_last4: string;
  idempotency_key: string;
  created_at: string;
  shipping_cents: number;
  fulfillment_status: string;
  coupon_code: string | null;
  discount_cents: number;
  shipping_method_id: string | null;
  shipping_method_name: string | null;
  estimated_delivery_start: string | null;
  estimated_delivery_end: string | null;
  cancelled_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  phone: string | null;
  delivery_note: string | null;
}

interface OrderItemRow {
  product_id: string;
  name: string;
  unit_price_cents: number;
  quantity: number;
}

// payment_ref is deliberately not selected: it is not part of the domain `Order`.
const ORDER_COLUMNS = `id, session_id, status, failure_code, subtotal_cents, total_cents,
  currency, full_name, email, line1, line2, city, region, postal_code, country,
  card_last4, idempotency_key, created_at, shipping_cents, fulfillment_status,
  coupon_code, discount_cents, shipping_method_id, shipping_method_name,
  estimated_delivery_start, estimated_delivery_end, cancelled_at, shipped_at,
  delivered_at, phone, delivery_note`;

function isPaymentFailureCode(value: string): value is PaymentFailureCode {
  return Object.hasOwn(PAYMENT_FAILURE_MESSAGES, value);
}

const FULFILLMENT_STATUSES: readonly FulfillmentStatus[] = [
  "processing",
  "packed",
  "shipped",
  "out_for_delivery",
  "delivered",
  "cancelled",
];

function toFulfillmentStatus(value: string): FulfillmentStatus {
  const found = FULFILLMENT_STATUSES.find((status) => status === value);
  // The CHECK constraint makes the fallback unreachable unless the schema changes.
  if (found === undefined) throw new Error("Unknown fulfillment status in database");
  return found;
}

interface SnapshotItemRow extends OrderItemRow {
  order_id: string;
  product_slug: string | null;
  image_url: string | null;
}

interface EventRow {
  id: number;
  order_id: string;
  status: string;
  at: string;
  note: string | null;
}

function toStatus(value: string): OrderStatus {
  if (value === "paid" || value === "payment_failed") return value;
  // The CHECK constraint makes this unreachable unless the schema changes.
  throw new Error(`Unknown order status in database: ${value}`);
}

function isUniqueIdempotencyViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return (
    code === "SQLITE_CONSTRAINT_UNIQUE" &&
    error.message.includes("orders.idempotency_key")
  );
}

export class SqliteOrderRepository implements OrderRepositoryV2 {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: SqliteOrderRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  insertOrder(order: Order, paymentRef: string | null): void {
    const { address } = order;
    try {
      this.db
        .query(
          `INSERT INTO orders (
             id, session_id, status, failure_code, subtotal_cents, shipping_cents,
             total_cents, currency, full_name, email, line1, line2, city, region,
             postal_code, country, card_last4, payment_ref, idempotency_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          order.id,
          order.sessionId,
          order.status,
          order.status === "payment_failed" ? (order.failureCode ?? null) : null,
          order.subtotalCents,
          order.shippingCents,
          order.totalCents,
          order.currency,
          address.fullName,
          address.email,
          address.line1,
          address.line2 ?? null,
          address.city,
          address.region,
          address.postalCode,
          address.country,
          order.cardLast4,
          paymentRef,
          order.idempotencyKey,
          order.createdAt,
        );
    } catch (error) {
      if (isUniqueIdempotencyViolation(error)) {
        throw new DuplicateIdempotencyKeyError(order.idempotencyKey);
      }
      throw error;
    }

    const insertItem = this.db.query(
      `INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const item of order.items) {
      insertItem.run(order.id, item.productId, item.name, item.unitPriceCents, item.quantity);
    }
  }

  findById(id: string): Order | null {
    const row = this.db
      .query<OrderRow, [string]>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`)
      .get(id);
    return row === null ? null : this.toOrder(row);
  }

  findByIdempotencyKey(key: string): Order | null {
    const row = this.db
      .query<OrderRow, [string]>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE idempotency_key = ?`)
      .get(key);
    return row === null ? null : this.toOrder(row);
  }

  /*
   * Writes to `products`, whose schema is owned by T07 (src/server/db). The
   * inverse of `ProductRepository.decrementStock`; kept here because only
   * checkout releases reservations.
   */
  restoreStock(lines: readonly StockLine[]): void {
    const update = this.db.query<unknown, [number, string, string]>(
      "UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?",
    );
    const updatedAt = this.now().toISOString();
    for (const line of lines) {
      if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
        throw new RangeError("restoreStock: quantity must be a positive integer");
      }
      update.run(line.quantity, updatedAt, line.productId);
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2 (T55)

  insertOrderV2(order: NewOrderV2, paymentRef: string | null): void {
    const { address } = order;
    try {
      this.db
        .query(
          `INSERT INTO orders (
             id, session_id, status, failure_code, subtotal_cents, shipping_cents,
             total_cents, currency, full_name, email, line1, line2, city, region,
             postal_code, country, card_last4, payment_ref, idempotency_key, created_at,
             fulfillment_status, coupon_code, discount_cents, shipping_method_id,
             shipping_method_name, estimated_delivery_start, estimated_delivery_end,
             phone, delivery_note
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          order.id,
          order.sessionId,
          order.status,
          order.status === "payment_failed" ? (order.failureCode ?? null) : null,
          order.subtotalCents,
          order.shippingCents,
          order.totalCents,
          order.currency,
          address.fullName,
          address.email,
          address.line1,
          address.line2 ?? null,
          address.city,
          address.region,
          address.postalCode,
          address.country,
          order.cardLast4,
          paymentRef,
          order.idempotencyKey,
          order.createdAt,
          order.fulfillmentStatus ?? "processing",
          order.couponCode ?? null,
          order.discountCents ?? 0,
          order.shippingMethodId ?? null,
          order.shippingMethodName ?? null,
          order.estimatedDeliveryStart ?? null,
          order.estimatedDeliveryEnd ?? null,
          order.phone ?? null,
          order.deliveryNote ?? null,
        );
    } catch (error) {
      if (isUniqueIdempotencyViolation(error)) {
        throw new DuplicateIdempotencyKeyError(order.idempotencyKey);
      }
      throw error;
    }

    const insertItem = this.db.query(
      `INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity, product_slug, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of order.items) {
      insertItem.run(
        order.id,
        item.productId,
        item.name,
        item.unitPriceCents,
        item.quantity,
        item.productSlug,
        item.imageUrl,
      );
    }
  }

  findRecordById(id: string): OrderRecord | null {
    const row = this.db
      .query<OrderRow, [string]>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`)
      .get(id);
    if (row === null) return null;
    return toRecord(row, this.snapshotItems([row.id]).get(row.id) ?? []);
  }

  listPaidRecords(sessionId: string, sinceIso: IsoDateTimeString | null): readonly OrderRecord[] {
    const since = sinceIso ?? "";
    const rows = this.db
      .query<OrderRow, [string, string]>(
        `SELECT ${ORDER_COLUMNS} FROM orders
          WHERE session_id = ? AND status = 'paid' AND created_at >= ?
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(sessionId, since);
    if (rows.length === 0) return [];
    const items = this.snapshotItems(rows.map((row) => row.id));
    return rows.map((row) => toRecord(row, items.get(row.id) ?? []));
  }

  listEvents(orderId: string): readonly OrderEvent[] {
    return this.db
      .query<EventRow, [string]>(
        "SELECT id, order_id, status, at, note FROM order_events WHERE order_id = ? ORDER BY id",
      )
      .all(orderId)
      .map((row) => ({
        id: row.id,
        orderId: row.order_id,
        status: toFulfillmentStatus(row.status),
        at: row.at,
        note: row.note,
      }));
  }

  insertEventIfAbsent(
    orderId: string,
    status: FulfillmentStatus,
    at: IsoDateTimeString,
    note: string | null,
  ): boolean {
    const result = this.db
      .query<unknown, [string, string, string, string | null]>(
        "INSERT OR IGNORE INTO order_events (order_id, status, at, note) VALUES (?, ?, ?, ?)",
      )
      .run(orderId, status, at, note);
    return result.changes === 1;
  }

  advanceFulfillment(
    orderId: string,
    from: FulfillmentStatus,
    to: FulfillmentStatus,
    shippedAt: IsoDateTimeString | null,
    deliveredAt: IsoDateTimeString | null,
  ): boolean {
    const result = this.db
      .query<unknown, [string, string | null, string | null, string, string]>(
        `UPDATE orders
            SET fulfillment_status = ?,
                shipped_at = COALESCE(shipped_at, ?),
                delivered_at = COALESCE(delivered_at, ?)
          WHERE id = ? AND fulfillment_status = ? AND status = 'paid'`,
      )
      .run(to, shippedAt, deliveredAt, orderId, from);
    return result.changes === 1;
  }

  markCancelled(orderId: string, cancelledAt: IsoDateTimeString): boolean {
    const result = this.db
      .query<unknown, [string, string]>(
        `UPDATE orders SET fulfillment_status = 'cancelled', cancelled_at = ?
          WHERE id = ? AND status = 'paid' AND fulfillment_status = 'processing' AND cancelled_at IS NULL`,
      )
      .run(cancelledAt, orderId);
    return result.changes === 1;
  }

  findShippingMethodTiming(id: string): Pick<ShippingMethod, "id" | "minDays" | "maxDays"> | null {
    const row = this.db
      .query<{ id: string; min_days: number; max_days: number }, [string]>(
        "SELECT id, min_days, max_days FROM shipping_methods WHERE id = ?",
      )
      .get(id);
    return row === null ? null : { id: row.id, minDays: row.min_days, maxDays: row.max_days };
  }

  getProductAvailability(ids: readonly string[]): readonly ProductAvailabilityRow[] {
    if (ids.length === 0) return [];
    return this.db
      .query<{ id: string; stock: number; published_at: string }, [string]>(
        "SELECT id, stock, published_at FROM products WHERE id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(ids))
      .map((row) => ({ productId: row.id, stock: row.stock, publishedAt: row.published_at }));
  }

  listPurchasedLines(sessionId: string): readonly PurchasedLineRow[] {
    return this.db
      .query<
        { product_id: string; name: string; product_slug: string | null; image_url: string | null; created_at: string },
        [string]
      >(
        `SELECT oi.product_id, oi.name, oi.product_slug, oi.image_url, o.created_at
           FROM order_items oi JOIN orders o ON o.id = oi.order_id
          WHERE o.session_id = ? AND o.status = 'paid' AND o.fulfillment_status <> 'cancelled'
          ORDER BY o.created_at DESC, o.rowid DESC, oi.rowid`,
      )
      .all(sessionId)
      .map((row) => ({
        productId: row.product_id,
        name: row.name,
        productSlug: row.product_slug,
        imageUrl: row.image_url,
        orderedAt: row.created_at,
      }));
  }

  /** Snapshot lines for the given orders, grouped by order id, in insertion order. */
  private snapshotItems(orderIds: readonly string[]): Map<string, OrderSnapshotItem[]> {
    const rows = this.db
      .query<SnapshotItemRow, [string]>(
        `SELECT order_id, product_id, name, unit_price_cents, quantity, product_slug, image_url
           FROM order_items WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY rowid`,
      )
      .all(JSON.stringify(orderIds));
    const byOrder = new Map<string, OrderSnapshotItem[]>();
    for (const row of rows) {
      const list = byOrder.get(row.order_id) ?? [];
      list.push({
        productId: row.product_id,
        name: row.name,
        unitPriceCents: row.unit_price_cents,
        quantity: row.quantity,
        productSlug: row.product_slug,
        imageUrl: row.image_url,
      });
      byOrder.set(row.order_id, list);
    }
    return byOrder;
  }

  private toOrder(row: OrderRow): Order {
    const items: OrderItem[] = this.db
      .query<OrderItemRow, [string]>(
        `SELECT product_id, name, unit_price_cents, quantity
           FROM order_items WHERE order_id = ? ORDER BY rowid`,
      )
      .all(row.id)
      .map((item) => ({
        productId: item.product_id,
        name: item.name,
        unitPriceCents: item.unit_price_cents,
        quantity: item.quantity,
      }));

    const address = toAddress(row);
    const status = toStatus(row.status);
    const failureCode = toFailureCode(row, status) ?? undefined;

    return {
      id: row.id,
      sessionId: row.session_id,
      status,
      items,
      subtotalCents: row.subtotal_cents,
      shippingCents: row.shipping_cents,
      totalCents: row.total_cents,
      currency: row.currency,
      address,
      cardLast4: row.card_last4,
      ...(failureCode === undefined ? {} : { failureCode }),
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    };
  }
}

function toAddress(row: OrderRow): Address {
  return {
    fullName: row.full_name,
    email: row.email,
    line1: row.line1,
    ...(row.line2 !== null && row.line2 !== "" ? { line2: row.line2 } : {}),
    city: row.city,
    region: row.region,
    postalCode: row.postal_code,
    country: row.country,
  };
}

function toFailureCode(row: OrderRow, status: OrderStatus): PaymentFailureCode | null {
  if (status !== "payment_failed") return null;
  return row.failure_code !== null && isPaymentFailureCode(row.failure_code)
    ? row.failure_code
    : "PROCESSING_ERROR";
}

function toRecord(row: OrderRow, items: readonly OrderSnapshotItem[]): OrderRecord {
  const status = toStatus(row.status);
  return {
    id: row.id,
    sessionId: row.session_id,
    status,
    failureCode: toFailureCode(row, status),
    items,
    subtotalCents: row.subtotal_cents,
    shippingCents: row.shipping_cents,
    discountCents: row.discount_cents,
    totalCents: row.total_cents,
    currency: row.currency,
    address: toAddress(row),
    cardLast4: row.card_last4,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    fulfillmentStatus: toFulfillmentStatus(row.fulfillment_status),
    couponCode: row.coupon_code,
    shippingMethodId: row.shipping_method_id,
    shippingMethodName: row.shipping_method_name,
    estimatedDeliveryStart: row.estimated_delivery_start,
    estimatedDeliveryEnd: row.estimated_delivery_end,
    cancelledAt: row.cancelled_at,
    shippedAt: row.shipped_at,
    deliveredAt: row.delivered_at,
    phone: row.phone,
    deliveryNote: row.delivery_note,
  };
}
