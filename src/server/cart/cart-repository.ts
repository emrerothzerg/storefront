import type { Database } from "bun:sqlite";
import { isSessionId } from "@/server/session/session-id";

/**
 * Cart persistence (server-only): a thin SQL layer over `carts` and
 * `cart_items`. Bound parameters only. No business rules live here (stock,
 * limits, prices): those belong to `CartService`. Prices are never stored.
 *
 * Session ids are checked with `isSessionId` before any query: reads with an
 * invalid id return `[]`, writes throw a `TypeError` (a programmer error,
 * because the service validates first).
 */

export interface CartRow {
  readonly productId: string;
  readonly quantity: number;
}

export interface CartRepository {
  /** Lines of the session's cart, oldest first; `[]` when there is no cart. */
  getItems(sessionId: string): CartRow[];
  /** Inserts the line or replaces its quantity (absolute, not additive). Requires `ensureCart` first (FK). */
  upsertItem(sessionId: string, productId: string, quantity: number): void;
  /** Deletes the line; no-op when absent. */
  removeItem(sessionId: string, productId: string): void;
  /** Deletes the cart and (by cascade) all its lines; no-op when absent. */
  clear(sessionId: string): void;
  /** Creates the cart row if missing (currency is kept when it exists) and touches `updated_at`. */
  ensureCart(sessionId: string, currency: string): void;
  /** Stored cart-level selections (T45); null when the session has no cart row or the id is invalid. */
  getSettings(sessionId: string): CartSettings | null;
  /** Stores (or clears with null) the applied coupon code. Requires `ensureCart` first; no-op without a cart row. */
  setCouponCode(sessionId: string, code: string | null): void;
  /**
   * Clears the stored coupon only if it still equals `code` (so a concurrent
   * `applyCoupon` of another code is never clobbered). Returns true when a row changed.
   */
  clearCouponIf(sessionId: string, code: string): boolean;
  /** Stores (or clears with null) the selected shipping method id. Requires `ensureCart` first. */
  setShippingMethodId(sessionId: string, methodId: string | null): void;
  /**
   * Clears the stored shipping method only if it still equals `methodId` (a
   * concurrent selection of another method is never clobbered). Returns true
   * when a row changed (D-T55-2: the caller shows its notice exactly once).
   */
  clearShippingMethodIf(sessionId: string, methodId: string): boolean;
}

/** Cart-level selections stored on `carts` (migration 2). */
export interface CartSettings {
  readonly couponCode: string | null;
  readonly shippingMethodId: string | null;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) {
    throw new TypeError("CartRepository: invalid session id");
  }
}

interface CartSettingsRow {
  coupon_code: string | null;
  shipping_method_id: string | null;
}

interface CartItemRow {
  product_id: string;
  quantity: number;
}

export class SqliteCartRepository implements CartRepository {
  constructor(private readonly db: Database) {}

  getItems(sessionId: string): CartRow[] {
    if (!isSessionId(sessionId)) return [];
    return this.db
      .query<CartItemRow, [string]>(
        `SELECT product_id, quantity FROM cart_items
          WHERE cart_session_id = ?
          ORDER BY created_at, rowid`,
      )
      .all(sessionId)
      .map((row) => ({ productId: row.product_id, quantity: row.quantity }));
  }

  upsertItem(sessionId: string, productId: string, quantity: number): void {
    assertSessionId(sessionId);
    this.db
      .query<unknown, [string, string, number]>(
        `INSERT INTO cart_items (cart_session_id, product_id, quantity)
         VALUES (?1, ?2, ?3)
         ON CONFLICT (cart_session_id, product_id) DO UPDATE SET
           quantity   = excluded.quantity,
           updated_at = ${NOW}`,
      )
      .run(sessionId, productId, quantity);
  }

  removeItem(sessionId: string, productId: string): void {
    assertSessionId(sessionId);
    this.db
      .query<unknown, [string, string]>(
        "DELETE FROM cart_items WHERE cart_session_id = ? AND product_id = ?",
      )
      .run(sessionId, productId);
  }

  clear(sessionId: string): void {
    assertSessionId(sessionId);
    this.db.query<unknown, [string]>("DELETE FROM carts WHERE session_id = ?").run(sessionId);
  }

  ensureCart(sessionId: string, currency: string): void {
    assertSessionId(sessionId);
    this.db
      .query<unknown, [string, string]>(
        `INSERT INTO carts (session_id, currency) VALUES (?, ?)
         ON CONFLICT (session_id) DO UPDATE SET updated_at = ${NOW}`,
      )
      .run(sessionId, currency);
  }

  getSettings(sessionId: string): CartSettings | null {
    if (!isSessionId(sessionId)) return null;
    const row = this.db
      .query<CartSettingsRow, [string]>("SELECT coupon_code, shipping_method_id FROM carts WHERE session_id = ?")
      .get(sessionId);
    return row === null ? null : { couponCode: row.coupon_code, shippingMethodId: row.shipping_method_id };
  }

  setCouponCode(sessionId: string, code: string | null): void {
    assertSessionId(sessionId);
    this.db
      .query<unknown, [string | null, string]>(
        `UPDATE carts SET coupon_code = ?, updated_at = ${NOW} WHERE session_id = ?`,
      )
      .run(code, sessionId);
  }

  clearCouponIf(sessionId: string, code: string): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<unknown, [string, string]>(
        `UPDATE carts SET coupon_code = NULL, updated_at = ${NOW} WHERE session_id = ? AND coupon_code = ?`,
      )
      .run(sessionId, code);
    return result.changes > 0;
  }

  setShippingMethodId(sessionId: string, methodId: string | null): void {
    assertSessionId(sessionId);
    this.db
      .query<unknown, [string | null, string]>(
        `UPDATE carts SET shipping_method_id = ?, updated_at = ${NOW} WHERE session_id = ?`,
      )
      .run(methodId, sessionId);
  }

  clearShippingMethodIf(sessionId: string, methodId: string): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<unknown, [string, string]>(
        `UPDATE carts SET shipping_method_id = NULL, updated_at = ${NOW} WHERE session_id = ? AND shipping_method_id = ?`,
      )
      .run(sessionId, methodId);
    return result.changes > 0;
  }
}
