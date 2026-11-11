import type { Database } from "bun:sqlite";
import type { ListItem, ListItemPriority, ListKind, ProductList } from "@/lib/types";
import { isSessionId } from "@/server/session/session-id";

/**
 * Lists persistence (server-only): a thin SQL layer over `lists` and
 * `list_items`. Bound parameters only; no business rules (limits, default
 * promotion, validation) live here, those belong to the list service.
 *
 * Ownership: every read or write that takes a list id also takes the owner
 * key (`session_id`) and filters on BOTH, so a foreign list id behaves exactly
 * like an unknown one. Reads with an invalid session id return empty results;
 * writes throw a `TypeError` (programmer error: the service validates first).
 *
 * Share tokens are bearer credentials: `findByShareToken` is the only query
 * that takes one, and nothing here logs.
 */

export interface ListRowFull extends ProductList {
  readonly sessionId: string;
}

interface ListDbRow {
  id: string;
  session_id: string;
  name: string;
  kind: string;
  is_default: number;
  is_public: number;
  share_token: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemDbRow {
  list_id: string;
  product_id: string;
  quantity_desired: number;
  priority: number;
  price_at_add_cents: number;
  note: string | null;
  added_at: string;
}

const LIST_COLUMNS = "id, session_id, name, kind, is_default, is_public, share_token, created_at, updated_at";
const ITEM_COLUMNS = "list_id, product_id, quantity_desired, priority, price_at_add_cents, note, added_at";

function toKind(value: string): ListKind {
  return value === "save_for_later" ? "save_for_later" : "wishlist";
}

function toPriority(value: number): ListItemPriority {
  return value === 2 ? 2 : value === 1 ? 1 : 0;
}

function toList(row: ListDbRow): ListRowFull {
  return {
    id: row.id,
    sessionId: row.session_id,
    name: row.name,
    kind: toKind(row.kind),
    isDefault: row.is_default === 1,
    isPublic: row.is_public === 1,
    shareToken: row.share_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row: ItemDbRow): ListItem {
  return {
    listId: row.list_id,
    productId: row.product_id,
    quantityDesired: row.quantity_desired,
    priority: toPriority(row.priority),
    priceAtAddCents: row.price_at_add_cents,
    note: row.note,
    addedAt: row.added_at,
  };
}

/** Strips the owner key so it can never leak into a returned domain object. */
export function toPublicList(row: ListRowFull): ProductList {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    isDefault: row.isDefault,
    isPublic: row.isPublic,
    shareToken: row.shareToken,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) throw new TypeError("ListRepository: invalid session id");
}

export interface NewItem {
  readonly productId: string;
  readonly quantityDesired: number;
  readonly priority: ListItemPriority;
  readonly priceAtAddCents: number;
  readonly note: string | null;
  readonly addedAt: string;
}

export interface ItemPatch {
  readonly quantityDesired?: number;
  readonly priority?: ListItemPriority;
  readonly note?: string | null;
}

export class ListRepository {
  constructor(private readonly db: Database) {}

  /** The session's lists: default first, then wishlists by age, save-for-later last. */
  listBySession(sessionId: string): (ListRowFull & { itemCount: number })[] {
    if (!isSessionId(sessionId)) return [];
    return this.db
      .query<ListDbRow & { item_count: number }, [string]>(
        `SELECT ${LIST_COLUMNS.split(", ").map((c) => `l.${c}`).join(", ")},
                (SELECT COUNT(*) FROM list_items li WHERE li.list_id = l.id) AS item_count
           FROM lists l
          WHERE l.session_id = ?
          ORDER BY l.is_default DESC, (l.kind = 'save_for_later') ASC, l.created_at, l.rowid`,
      )
      .all(sessionId)
      .map((row) => ({ ...toList(row), itemCount: row.item_count }));
  }

  /** The list when it exists AND belongs to `sessionId`; otherwise null. */
  findOwned(sessionId: string, listId: string): ListRowFull | null {
    if (!isSessionId(sessionId)) return null;
    const row = this.db
      .query<ListDbRow, [string, string]>(`SELECT ${LIST_COLUMNS} FROM lists WHERE id = ? AND session_id = ?`)
      .get(listId, sessionId);
    return row === null ? null : toList(row);
  }

  findDefault(sessionId: string): ListRowFull | null {
    if (!isSessionId(sessionId)) return null;
    const row = this.db
      .query<ListDbRow, [string]>(
        `SELECT ${LIST_COLUMNS} FROM lists
          WHERE session_id = ? AND kind = 'wishlist' AND is_default = 1
          ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(sessionId);
    return row === null ? null : toList(row);
  }

  /** Oldest wishlist of the session, optionally excluding one id. */
  findOldestWishlist(sessionId: string, excludeId: string | null = null): ListRowFull | null {
    if (!isSessionId(sessionId)) return null;
    const row = this.db
      .query<ListDbRow, [string, string | null]>(
        `SELECT ${LIST_COLUMNS} FROM lists
          WHERE session_id = ?1 AND kind = 'wishlist' AND (?2 IS NULL OR id <> ?2)
          ORDER BY created_at, rowid LIMIT 1`,
      )
      .get(sessionId, excludeId);
    return row === null ? null : toList(row);
  }

  findSaveForLater(sessionId: string): ListRowFull | null {
    if (!isSessionId(sessionId)) return null;
    const row = this.db
      .query<ListDbRow, [string]>(`SELECT ${LIST_COLUMNS} FROM lists WHERE session_id = ? AND kind = 'save_for_later'`)
      .get(sessionId);
    return row === null ? null : toList(row);
  }

  /** Public, read-only lookup. Only matches lists that are currently shared. */
  findByShareToken(token: string): ListRowFull | null {
    const row = this.db
      .query<ListDbRow, [string]>(`SELECT ${LIST_COLUMNS} FROM lists WHERE share_token = ? AND is_public = 1`)
      .get(token);
    return row === null ? null : toList(row);
  }

  /** True when any list (shared or not) holds this token. Used only to avoid UNIQUE collisions. */
  findByShareTokenAny(token: string): boolean {
    return this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM lists WHERE share_token = ?").get(token) !== null;
  }

  countWishlists(sessionId: string): number {
    if (!isSessionId(sessionId)) return 0;
    const row = this.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'wishlist'")
      .get(sessionId);
    return row?.n ?? 0;
  }

  insertWishlist(sessionId: string, id: string, name: string, isDefault: boolean, now: string): void {
    assertSessionId(sessionId);
    this.db
      .query<unknown, [string, string, string, number, string]>(
        `INSERT INTO lists (id, session_id, name, kind, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'wishlist', ?4, ?5, ?5)`,
      )
      .run(id, sessionId, name, isDefault ? 1 : 0, now);
  }

  /**
   * Race-safe: relies on the partial unique index `ux_lists_save_for_later`.
   * Returns true when this call created the row.
   */
  insertSaveForLater(sessionId: string, id: string, name: string, now: string): boolean {
    assertSessionId(sessionId);
    const res = this.db
      .query<unknown, [string, string, string, string]>(
        `INSERT INTO lists (id, session_id, name, kind, is_default, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'save_for_later', 0, ?4, ?4)
         ON CONFLICT (session_id) WHERE kind = 'save_for_later' DO NOTHING`,
      )
      .run(id, sessionId, name, now);
    return res.changes > 0;
  }

  rename(sessionId: string, listId: string, name: string, now: string): void {
    assertSessionId(sessionId);
    this.db
      .query<unknown, [string, string, string, string]>(
        "UPDATE lists SET name = ?3, updated_at = ?4 WHERE id = ?1 AND session_id = ?2",
      )
      .run(listId, sessionId, name, now);
  }

  setDefault(sessionId: string, listId: string, now: string): void {
    assertSessionId(sessionId);
    this.db
      .query<unknown, [string, string, string]>(
        `UPDATE lists SET is_default = (id = ?1), updated_at = CASE WHEN (id = ?1) <> is_default THEN ?3 ELSE updated_at END
          WHERE session_id = ?2 AND kind = 'wishlist'`,
      )
      .run(listId, sessionId, now);
  }

  /** Deletes the list; its items go with it (ON DELETE CASCADE). */
  delete(sessionId: string, listId: string): void {
    assertSessionId(sessionId);
    this.db.query<unknown, [string, string]>("DELETE FROM lists WHERE id = ? AND session_id = ?").run(listId, sessionId);
  }

  setShare(sessionId: string, listId: string, token: string | null, now: string): void {
    assertSessionId(sessionId);
    this.db
      .query<unknown, [string, string, string | null, number, string]>(
        "UPDATE lists SET share_token = ?3, is_public = ?4, updated_at = ?5 WHERE id = ?1 AND session_id = ?2",
      )
      .run(listId, sessionId, token, token === null ? 0 : 1, now);
  }

  touch(listId: string, now: string): void {
    this.db.query<unknown, [string, string]>("UPDATE lists SET updated_at = ?2 WHERE id = ?1").run(listId, now);
  }

  // ---- items (callers must have checked list ownership) -------------------

  getItems(listId: string): ListItem[] {
    return this.db
      .query<ItemDbRow, [string]>(
        `SELECT ${ITEM_COLUMNS} FROM list_items WHERE list_id = ? ORDER BY added_at DESC, rowid DESC`,
      )
      .all(listId)
      .map(toItem);
  }

  getItem(listId: string, productId: string): ListItem | null {
    const row = this.db
      .query<ItemDbRow, [string, string]>(`SELECT ${ITEM_COLUMNS} FROM list_items WHERE list_id = ? AND product_id = ?`)
      .get(listId, productId);
    return row === null ? null : toItem(row);
  }

  countItems(listId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?")
      .get(listId);
    return row?.n ?? 0;
  }

  /** Inserts unless present. Returns true when a row was created. */
  insertItem(listId: string, item: NewItem): boolean {
    const res = this.db
      .query<unknown, [string, string, number, number, number, string | null, string]>(
        `INSERT INTO list_items (list_id, product_id, quantity_desired, priority, price_at_add_cents, note, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (list_id, product_id) DO NOTHING`,
      )
      .run(listId, item.productId, item.quantityDesired, item.priority, item.priceAtAddCents, item.note, item.addedAt);
    return res.changes > 0;
  }

  updateItem(listId: string, productId: string, patch: ItemPatch): void {
    const hasNote = patch.note !== undefined;
    this.db
      .query<unknown, [string, string, number | null, number | null, number, string | null]>(
        `UPDATE list_items SET
           quantity_desired = COALESCE(?3, quantity_desired),
           priority         = COALESCE(?4, priority),
           note             = CASE WHEN ?5 = 1 THEN ?6 ELSE note END
         WHERE list_id = ?1 AND product_id = ?2`,
      )
      .run(
        listId,
        productId,
        patch.quantityDesired ?? null,
        patch.priority ?? null,
        hasNote ? 1 : 0,
        hasNote ? (patch.note ?? null) : null,
      );
  }

  deleteItem(listId: string, productId: string): void {
    this.db
      .query<unknown, [string, string]>("DELETE FROM list_items WHERE list_id = ? AND product_id = ?")
      .run(listId, productId);
  }

  isInDefaultList(sessionId: string, productId: string): boolean {
    if (!isSessionId(sessionId)) return false;
    const row = this.db
      .query<{ one: number }, [string, string]>(
        `SELECT 1 AS one FROM list_items li JOIN lists l ON l.id = li.list_id
          WHERE l.session_id = ? AND l.kind = 'wishlist' AND l.is_default = 1 AND li.product_id = ?
          LIMIT 1`,
      )
      .get(sessionId, productId);
    return row !== null;
  }

  // ---- catalogue / orders lookups (read-only) -----------------------------

  /** Current price of a product visible in the store (published), or null. */
  getPublishedPrice(productId: string, nowIso: string): number | null {
    const row = this.db
      .query<{ price_cents: number }, [string, string]>(
        "SELECT price_cents FROM products WHERE id = ? AND published_at <= ?",
      )
      .get(productId, nowIso);
    return row?.price_cents ?? null;
  }

  /**
   * Product ids of `listId` that the owner bought (paid, not cancelled) in an
   * order created at or after the item's `added_at`.
   */
  purchasedSinceAdded(sessionId: string, listId: string): Set<string> {
    if (!isSessionId(sessionId)) return new Set();
    const rows = this.db
      .query<{ product_id: string }, [string, string]>(
        `SELECT li.product_id FROM list_items li
          WHERE li.list_id = ?1
            AND EXISTS (
              SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id
               WHERE o.session_id = ?2
                 AND o.status = 'paid'
                 AND o.fulfillment_status <> 'cancelled'
                 AND oi.product_id = li.product_id
                 AND o.created_at >= li.added_at)`,
      )
      .all(listId, sessionId);
    return new Set(rows.map((r) => r.product_id));
  }
}
