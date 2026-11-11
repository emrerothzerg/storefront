import type { Database } from "bun:sqlite";
import { DEFAULT_MAX_QUANTITY } from "@/lib/validation";
import { SqliteProductRepository } from "@/server/catalog/product-repository";

/**
 * Guest-to-account merge persistence (T117, server-only). Every SQL statement
 * the merge runs lives here; bound parameters only. Each `merge*` step moves
 * one table family from `guest` to `owner` and returns what it did. Steps do
 * NOT open transactions and do NOT validate ids: the merge service validates
 * both keys and runs every step inside ONE `withTransaction`, so any throw
 * here rolls the whole merge back. This module never logs.
 *
 * Rules (see README.md, "merge-service.ts (T117)"):
 * - Rows the user already has a UNIQUE/PK twin of are DELETED from the guest
 *   (ruling R-5), never left behind under the guest id.
 * - Rows dropped by a cap are deleted and counted.
 * - `carts.session_id` is never UPDATEd (K-7: `cart_items` FK has no
 *   ON UPDATE CASCADE): lines are upserted into the user's cart and the guest
 *   cart is deleted (its items cascade).
 * - Re-keying keeps row ids, timestamps and child rows; `updated_at` is set to
 *   `now` only where a row's own content changes (quantity, name, default flag,
 *   coupon/shipping selection).
 */

export interface MergeLimits {
  /** Wishlists per owner (save_for_later is not counted). */
  readonly maxWishlists: number;
  readonly maxItemsPerList: number;
  readonly maxListNameLength: number;
  readonly maxViews: number;
  readonly maxAlerts: number;
  readonly maxAddresses: number;
}

export interface DroppedCartLine {
  readonly productId: string;
  readonly reason: "out_of_stock" | "unknown_product";
}

export interface CartMergeResult {
  readonly movedCartLines: number;
  readonly droppedCartLines: readonly DroppedCartLine[];
}

export interface ListMergeResult {
  readonly movedLists: number;
  readonly droppedLists: number;
  readonly mergedListItems: number;
  readonly droppedListItems: number;
}

export interface MovedDropped {
  readonly moved: number;
  readonly dropped: number;
}

export interface ReviewMergeResult {
  readonly movedReviews: number;
  readonly droppedReviews: number;
  readonly movedQuestions: number;
  readonly movedAnswers: number;
  readonly droppedVotes: number;
}

export interface MergeRepository {
  mergeCart(guest: string, owner: string, nowIso: string): CartMergeResult;
  mergeLists(guest: string, owner: string, nowIso: string, limits: MergeLimits): ListMergeResult;
  mergeViews(guest: string, owner: string, limits: MergeLimits): MovedDropped;
  mergeReviewsAndQa(guest: string, owner: string): ReviewMergeResult;
  mergeStockAlerts(guest: string, owner: string, limits: MergeLimits): MovedDropped;
  mergeContactMessages(guest: string, owner: string): number;
  mergeAddresses(guest: string, owner: string, nowIso: string, limits: MergeLimits): MovedDropped;
  mergeOrders(guest: string, owner: string): number;
  mergeCouponRedemptions(guest: string, owner: string): MovedDropped;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Cuts `value` to at most `max` code points (never splits a surrogate pair), trailing whitespace removed. */
export function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  if (points.length <= max) return value;
  return points.slice(0, Math.max(0, max)).join("").trimEnd();
}

function nameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

const DEDUPE_SUFFIX_RE = /\s\((\d+)\)$/u;

/**
 * Returns a list name that is not in `taken` (compared case-insensitively,
 * NFC) and is at most `max` code points (ruling R-4). A free name is kept
 * (cut to `max`); otherwise an existing " (n)" suffix is stripped and
 * " (2)", " (3)" … tried, truncating the base so the result still fits.
 */
export function dedupeListName(name: string, taken: ReadonlySet<string>, max: number): string {
  const trimmed = truncateCodePoints(name.trim(), max);
  const first = trimmed === "" ? "List" : trimmed;
  if (!taken.has(nameKey(first))) return first;
  const base = first.replace(DEDUPE_SUFFIX_RE, "").trimEnd() || "List";
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${truncateCodePoints(base, max - suffix.length)}${suffix}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
}

/**
 * Address duplicate key: NFKC, lower-cased, whitespace collapsed and trimmed,
 * over full_name + line1 + postal_code + country.
 */
export function addressDedupeKey(a: {
  readonly full_name: string;
  readonly line1: string;
  readonly postal_code: string;
  readonly country: string;
}): string {
  const norm = (v: string): string => v.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return [norm(a.full_name), norm(a.line1), norm(a.postal_code), norm(a.country)].join("\u0000");
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface CartRow {
  currency: string;
  coupon_code: string | null;
  shipping_method_id: string | null;
  created_at: string;
}

interface GuestLineRow {
  product_id: string;
  quantity: number;
  created_at: string;
  stock: number | null;
  user_quantity: number | null;
}

interface ListRow {
  id: string;
  name: string;
  kind: "wishlist" | "save_for_later";
  is_default: number;
}

interface ListItemRow {
  product_id: string;
  quantity_desired: number;
  priority: number;
  price_at_add_cents: number;
  note: string | null;
  added_at: string;
}

interface AddressRow {
  id: string;
  full_name: string;
  line1: string;
  postal_code: string;
  country: string;
  is_default: number;
}

interface CountRow {
  n: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export function createMergeRepository(db: Database): MergeRepository {
  const publication = new SqliteProductRepository(db);
  const count = (sql: string, ...params: string[]): number =>
    db.query<CountRow, string[]>(sql).get(...params)?.n ?? 0;

  const run = (sql: string, ...params: (string | number | null)[]): number =>
    db.query<unknown, (string | number | null)[]>(sql).run(...params).changes;

  const itemCount = (listId: string): number => count("SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", listId);

  /**
   * Copies the items of `fromListId` into `toListId` (newest first) until the
   * target holds `maxItems`. Items already on the target are skipped (the
   * target's row wins). Returns { merged, dropped } where dropped = conflicts +
   * overflow. The source list is not modified.
   */
  const copyItems = (fromListId: string, toListId: string, maxItems: number): { merged: number; dropped: number } => {
    const items = db
      .query<ListItemRow, [string]>(
        `SELECT product_id, quantity_desired, priority, price_at_add_cents, note, added_at
           FROM list_items WHERE list_id = ? ORDER BY added_at DESC, product_id`,
      )
      .all(fromListId);
    let size = itemCount(toListId);
    let merged = 0;
    let dropped = 0;
    for (const item of items) {
      const exists =
        db
          .query<{ one: number }, [string, string]>("SELECT 1 AS one FROM list_items WHERE list_id = ? AND product_id = ?")
          .get(toListId, item.product_id) !== null;
      if (exists || size >= maxItems) {
        dropped++;
        continue;
      }
      run(
        `INSERT INTO list_items (list_id, product_id, quantity_desired, priority, price_at_add_cents, note, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        toListId,
        item.product_id,
        item.quantity_desired,
        item.priority,
        item.price_at_add_cents,
        item.note,
        item.added_at,
      );
      size++;
      merged++;
    }
    return { merged, dropped };
  };

  /** Deletes the oldest items beyond `maxItems` on a list; returns rows deleted. */
  const trimItems = (listId: string, maxItems: number): number =>
    run(
      `DELETE FROM list_items
        WHERE list_id = ?1
          AND product_id NOT IN (
            SELECT product_id FROM list_items WHERE list_id = ?1
             ORDER BY added_at DESC, product_id LIMIT ?2)`,
      listId,
      maxItems,
    );

  /** Re-keys one guest list to the owner (keeps id, items, share token). */
  const rekeyList = (listId: string, owner: string, name: string, isDefault: boolean, renamed: boolean, nowIso: string): void => {
    run(
      `UPDATE lists SET session_id = ?2, name = ?3, is_default = ?4,
              updated_at = CASE WHEN ?5 = 1 OR is_default <> ?4 THEN ?6 ELSE updated_at END
        WHERE id = ?1`,
      listId,
      owner,
      name,
      isDefault ? 1 : 0,
      renamed ? 1 : 0,
      nowIso,
    );
  };

  /** Deletes a list (items cascade); returns how many items went with it. */
  const deleteList = (listId: string): number => {
    const items = itemCount(listId);
    run("DELETE FROM lists WHERE id = ?", listId);
    return items;
  };

  /**
   * Deletes `guest` vote rows the owner already has a twin of, then re-keys the
   * rest, then deletes every vote of `owner` on a target `owner` now authors
   * (self-votes are forbidden by the review and Q&A services: a guest vote on
   * the user's own content, or a user's earlier vote on content the guest
   * wrote, would otherwise become one). Must run AFTER the parent table was
   * re-keyed. Plain DELETEs, so the `AFTER DELETE` triggers keep
   * `helpful_count` equal to the vote-row count. Returns rows deleted.
   */
  const mergeVotes = (
    table: "review_votes" | "question_votes" | "answer_votes",
    target: "review_id" | "question_id" | "answer_id",
    parent: "reviews" | "questions" | "answers",
    guest: string,
    owner: string,
  ): number => {
    const duplicates = run(
      `DELETE FROM ${table}
        WHERE session_id = ?1
          AND ${target} IN (SELECT ${target} FROM ${table} WHERE session_id = ?2)`,
      guest,
      owner,
    );
    run(`UPDATE ${table} SET session_id = ?2 WHERE session_id = ?1`, guest, owner);
    const selfVotes = run(
      `DELETE FROM ${table}
        WHERE session_id = ?1
          AND ${target} IN (SELECT id FROM ${parent} WHERE session_id = ?1)`,
      owner,
    );
    return duplicates + selfVotes;
  };

  return {
    mergeCart(guest, owner, nowIso) {
      const guestCart = db
        .query<CartRow, [string]>("SELECT currency, coupon_code, shipping_method_id, created_at FROM carts WHERE session_id = ?")
        .get(guest);
      if (guestCart === null) return { movedCartLines: 0, droppedCartLines: [] };

      const userCart = db
        .query<CartRow, [string]>("SELECT currency, coupon_code, shipping_method_id, created_at FROM carts WHERE session_id = ?")
        .get(owner);
      if (userCart === null) {
        run(
          `INSERT INTO carts (session_id, currency, coupon_code, shipping_method_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          owner,
          guestCart.currency,
          guestCart.coupon_code,
          guestCart.shipping_method_id,
          guestCart.created_at,
          nowIso,
        );
      } else if (
        (userCart.coupon_code === null && guestCart.coupon_code !== null) ||
        (userCart.shipping_method_id === null && guestCart.shipping_method_id !== null)
      ) {
        run(
          `UPDATE carts SET coupon_code = COALESCE(coupon_code, ?2),
                            shipping_method_id = COALESCE(shipping_method_id, ?3),
                            updated_at = ?4
            WHERE session_id = ?1`,
          owner,
          guestCart.coupon_code,
          guestCart.shipping_method_id,
          nowIso,
        );
      }

      const lines = db
        .query<GuestLineRow, [string, string]>(
          `SELECT g.product_id, g.quantity, g.created_at, p.stock AS stock, u.quantity AS user_quantity
             FROM cart_items AS g
             LEFT JOIN products AS p ON p.id = g.product_id
             LEFT JOIN cart_items AS u ON u.cart_session_id = ?2 AND u.product_id = g.product_id
            WHERE g.cart_session_id = ?1
            ORDER BY g.created_at, g.product_id`,
        )
        .all(guest, owner);

      // R-CART-1: a guest line whose product is unpublished at `nowIso`
      // (published_at '' or in the future) is dropped like an unknown product,
      // using the cart service's own lookup (ProductPublicationLookup).
      const published = publication.filterPublishedIds(
        lines.map((l) => l.product_id),
        nowIso,
      );
      let moved = 0;
      const dropped: DroppedCartLine[] = [];
      for (const line of lines) {
        if (line.stock === null || !published.has(line.product_id)) {
          dropped.push({ productId: line.product_id, reason: "unknown_product" });
          continue;
        }
        if (line.stock <= 0) {
          dropped.push({ productId: line.product_id, reason: "out_of_stock" });
          continue;
        }
        // Sum, capped by stock AND the cart's per-line maximum (D-T117-1).
        const quantity = Math.min((line.user_quantity ?? 0) + line.quantity, line.stock, DEFAULT_MAX_QUANTITY);
        if (line.user_quantity === null) {
          run(
            `INSERT INTO cart_items (cart_session_id, product_id, quantity, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
            owner,
            line.product_id,
            quantity,
            line.created_at,
            nowIso,
          );
        } else if (quantity !== line.user_quantity) {
          run(
            "UPDATE cart_items SET quantity = ?3, updated_at = ?4 WHERE cart_session_id = ?1 AND product_id = ?2",
            owner,
            line.product_id,
            quantity,
            nowIso,
          );
        }
        moved++;
      }

      // Never UPDATE carts.session_id (K-7): delete the guest cart, items cascade.
      run("DELETE FROM carts WHERE session_id = ?", guest);
      return { movedCartLines: moved, droppedCartLines: dropped };
    },

    mergeLists(guest, owner, nowIso, limits) {
      const listsOf = (key: string): ListRow[] =>
        db
          .query<ListRow, [string]>(
            `SELECT id, name, kind, is_default FROM lists WHERE session_id = ?
              ORDER BY is_default DESC, created_at, rowid`,
          )
          .all(key);
      const guestLists = listsOf(guest);
      if (guestLists.length === 0) {
        return { movedLists: 0, droppedLists: 0, mergedListItems: 0, droppedListItems: 0 };
      }
      const userLists = listsOf(owner);
      const taken = new Set(userLists.map((l) => nameKey(l.name)));
      let wishlistCount = userLists.filter((l) => l.kind === "wishlist").length;
      const userDefault = userLists.find((l) => l.kind === "wishlist" && l.is_default === 1) ?? null;
      const userSfl = userLists.find((l) => l.kind === "save_for_later") ?? null;

      let movedLists = 0;
      let droppedLists = 0;
      let mergedListItems = 0;
      let droppedListItems = 0;

      const guestDefault = guestLists.find((l) => l.kind === "wishlist" && l.is_default === 1) ?? null;
      const guestSfl = guestLists.find((l) => l.kind === "save_for_later") ?? null;

      const rekeyWishlist = (list: ListRow, isDefault: boolean): void => {
        if (wishlistCount >= limits.maxWishlists) {
          droppedListItems += deleteList(list.id);
          droppedLists++;
          return;
        }
        const name = dedupeListName(list.name, taken, limits.maxListNameLength);
        taken.add(nameKey(name));
        rekeyList(list.id, owner, name, isDefault, name !== list.name, nowIso);
        droppedListItems += trimItems(list.id, limits.maxItemsPerList);
        wishlistCount++;
        movedLists++;
      };

      // 1. Default wishlist: items into the user's default, or re-key as the default.
      if (guestDefault !== null) {
        if (userDefault !== null) {
          const r = copyItems(guestDefault.id, userDefault.id, limits.maxItemsPerList);
          mergedListItems += r.merged;
          droppedListItems += r.dropped;
          run("DELETE FROM lists WHERE id = ?", guestDefault.id);
        } else {
          rekeyWishlist(guestDefault, true);
        }
      }

      // 2. Save for later: one per owner (ux_lists_save_for_later).
      if (guestSfl !== null) {
        if (userSfl !== null) {
          const r = copyItems(guestSfl.id, userSfl.id, limits.maxItemsPerList);
          mergedListItems += r.merged;
          droppedListItems += r.dropped;
          run("DELETE FROM lists WHERE id = ?", guestSfl.id);
        } else {
          rekeyList(guestSfl.id, owner, guestSfl.name, false, false, nowIso);
          droppedListItems += trimItems(guestSfl.id, limits.maxItemsPerList);
          movedLists++;
        }
      }

      // 3. Other wishlists, oldest first, re-keyed with deduped names while under the cap.
      for (const list of guestLists) {
        if (list === guestDefault || list === guestSfl) continue;
        rekeyWishlist(list, false);
      }

      return { movedLists, droppedLists, mergedListItems, droppedListItems };
    },

    mergeViews(guest, owner, limits) {
      const moved = count("SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?", guest);
      if (moved === 0) return { moved: 0, dropped: 0 };
      run(
        `INSERT INTO product_views (session_id, product_id, viewed_at)
         SELECT ?2, product_id, viewed_at FROM product_views WHERE session_id = ?1
         ON CONFLICT (session_id, product_id) DO UPDATE SET viewed_at = MAX(viewed_at, excluded.viewed_at)`,
        guest,
        owner,
      );
      run("DELETE FROM product_views WHERE session_id = ?", guest);
      const dropped = run(
        `DELETE FROM product_views
          WHERE session_id = ?1
            AND product_id NOT IN (
              SELECT product_id FROM product_views WHERE session_id = ?1
               ORDER BY viewed_at DESC, product_id DESC LIMIT ?2)`,
        owner,
        limits.maxViews,
      );
      return { moved, dropped };
    },

    mergeReviewsAndQa(guest, owner) {
      // Reviews: a guest review for a product the user already reviewed is
      // deleted (R-5); rating triggers subtract it, votes on it cascade.
      const droppedReviews = run(
        `DELETE FROM reviews
          WHERE session_id = ?1
            AND product_id IN (SELECT product_id FROM reviews WHERE session_id = ?2)`,
        guest,
        owner,
      );
      // UPDATE OF session_id fires no rating trigger: aggregates stay exact.
      const movedReviews = run("UPDATE reviews SET session_id = ?2 WHERE session_id = ?1", guest, owner);
      const movedQuestions = run("UPDATE questions SET session_id = ?2 WHERE session_id = ?1", guest, owner);
      const movedAnswers = run("UPDATE answers SET session_id = ?2 WHERE session_id = ?1", guest, owner);
      // Votes: duplicate guest votes deleted, rest re-keyed, resulting
      // self-votes deleted (helpful_count triggers decrement each delete).
      const droppedVotes =
        mergeVotes("review_votes", "review_id", "reviews", guest, owner) +
        mergeVotes("question_votes", "question_id", "questions", guest, owner) +
        mergeVotes("answer_votes", "answer_id", "answers", guest, owner);
      return { movedReviews, droppedReviews, movedQuestions, movedAnswers, droppedVotes };
    },

    mergeStockAlerts(guest, owner, limits) {
      const conflicts = run(
        `DELETE FROM stock_alerts
          WHERE session_id = ?1
            AND product_id IN (SELECT product_id FROM stock_alerts WHERE session_id = ?2)`,
        guest,
        owner,
      );
      const room = Math.max(0, limits.maxAlerts - count("SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?", owner));
      // Keep the newest guest alerts that fit; delete the oldest overflow (R-5).
      const overflow = run(
        `DELETE FROM stock_alerts
          WHERE session_id = ?1
            AND id NOT IN (
              SELECT id FROM stock_alerts WHERE session_id = ?1
               ORDER BY created_at DESC, id DESC LIMIT ?2)`,
        guest,
        room,
      );
      const moved = run("UPDATE stock_alerts SET session_id = ?2 WHERE session_id = ?1", guest, owner);
      return { moved, dropped: conflicts + overflow };
    },

    mergeContactMessages(guest, owner) {
      return run("UPDATE contact_messages SET session_id = ?2 WHERE session_id = ?1", guest, owner);
    },

    mergeAddresses(guest, owner, nowIso, limits) {
      const addressesOf = (key: string, order: string): AddressRow[] =>
        db
          .query<AddressRow, [string]>(
            `SELECT id, full_name, line1, postal_code, country, is_default FROM addresses
              WHERE session_id = ? ORDER BY ${order}`,
          )
          .all(key);
      // Guest default first, then newest: those survive the cap.
      const guestRows = addressesOf(guest, "is_default DESC, created_at DESC, rowid DESC");
      if (guestRows.length === 0) return { moved: 0, dropped: 0 };
      const userRows = addressesOf(owner, "created_at, rowid");
      const keys = new Set(userRows.map(addressDedupeKey));
      const userHadDefault = userRows.some((r) => r.is_default === 1);
      let size = userRows.length;
      let moved = 0;
      let dropped = 0;
      let guestDefaultId: string | null = null;

      for (const row of guestRows) {
        const key = addressDedupeKey(row);
        if (keys.has(key) || size >= limits.maxAddresses) {
          run("DELETE FROM addresses WHERE id = ?", row.id);
          dropped++;
          continue;
        }
        run(
          `UPDATE addresses SET session_id = ?2, is_default = 0,
                  updated_at = CASE WHEN is_default = 1 THEN ?3 ELSE updated_at END
            WHERE id = ?1`,
          row.id,
          owner,
          nowIso,
        );
        if (row.is_default === 1 && guestDefaultId === null) guestDefaultId = row.id;
        keys.add(key);
        size++;
        moved++;
      }

      // Exactly one default: the user's if present, else the guest's, else the newest.
      if (!userHadDefault && size > 0) {
        const chosen =
          guestDefaultId ??
          db
            .query<{ id: string }, [string]>(
              "SELECT id FROM addresses WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
            )
            .get(owner)?.id ??
          null;
        if (chosen !== null) {
          run("UPDATE addresses SET is_default = 1, updated_at = ?2 WHERE id = ?1", chosen, nowIso);
        }
      }
      return { moved, dropped };
    },

    mergeOrders(guest, owner) {
      // orders.session_id has no FK; order_items / order_events follow via order_id.
      return run("UPDATE orders SET session_id = ?2 WHERE session_id = ?1", guest, owner);
    },

    mergeCouponRedemptions(guest, owner) {
      // coupons.used_count is not trigger-maintained: deleting a duplicate leaves it unchanged.
      const dropped = run(
        `DELETE FROM coupon_redemptions
          WHERE session_id = ?1
            AND coupon_code IN (SELECT coupon_code FROM coupon_redemptions WHERE session_id = ?2)`,
        guest,
        owner,
      );
      const moved = run("UPDATE coupon_redemptions SET session_id = ?2 WHERE session_id = ?1", guest, owner);
      return { moved, dropped };
    },
  };
}
