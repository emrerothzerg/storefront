import type { Database } from "bun:sqlite";
import { isSessionId } from "@/server/session/session-id";

/**
 * Account lifecycle persistence (T118, server-only): the SQL that removes or
 * anonymises everything a deleted account owned in the owner-keyed tables.
 * Users and auth sessions themselves stay in `auth-repository.ts` (T115).
 *
 * Every method is synchronous and is meant to run INSIDE the caller's
 * `withTransaction` (the account service opens exactly one). Bound parameters
 * only. This module never logs and never returns an owner key.
 */

/**
 * Tombstone owner key (ruling R-1). Anonymised orders, questions, answers and
 * coupon redemptions of deleted accounts are re-keyed to it. It is a valid
 * v4-shaped UUID (`isSessionId` accepts it), but no cookie ever holds it: the
 * resolver would treat it as a guest id that owns only anonymised rows, and
 * order pages must never return anonymised orders (enforced by T55 / order
 * pages, not here).
 */
export const DELETED_OWNER_KEY = "00000000-0000-4000-8000-000000000000";

/** Replacement text for anonymised personal fields and user content. */
export const DELETED_MARKER = "[deleted]";

/**
 * Every table with an owner column (`session_id`, or `cart_session_id` for
 * `cart_items`) and what deletion does to it. A colocated test compares this
 * list with `sqlite_master`, so a migration that adds an owner-keyed table
 * fails until it gets a rule here. `rate_limits` has no owner column (its key
 * is opaque) and is deliberately untouched.
 */
export const OWNER_KEYED_TABLES = {
  carts: "delete",
  cart_items: "delete",
  lists: "delete",
  product_views: "delete",
  review_votes: "delete",
  question_votes: "delete",
  answer_votes: "delete",
  reviews: "delete",
  stock_alerts: "delete",
  contact_messages: "delete",
  addresses: "delete",
  questions: "anonymise",
  answers: "anonymise",
  orders: "anonymise",
  coupon_redemptions: "rekey",
} as const satisfies Readonly<Record<string, "delete" | "anonymise" | "rekey">>;

export type OwnerKeyedTable = keyof typeof OWNER_KEYED_TABLES;

/** Row counts from `purgeOwnerData`. Never contains the owner key. */
export interface OwnerPurgeResult {
  /**
   * Rows hard-deleted per table. Keys: every `"delete"` table above, plus
   * `list_items` (items of the deleted lists), `review_votes_cascaded`
   * (other shoppers' votes on the deleted reviews) and `coupon_redemptions`
   * (redemptions that could not be re-keyed because the tombstone already
   * holds one for that code, see `purgeOwnerData`).
   */
  readonly deletedRows: Readonly<Record<string, number>>;
  readonly anonymisedOrders: number;
  readonly anonymisedQuestions: number;
  readonly anonymisedAnswers: number;
  readonly rekeyedCouponRedemptions: number;
  /** Distinct products whose reviews were deleted (rating aggregates need a recompute). */
  readonly affectedProductIds: readonly string[];
}

export interface AccountRepository {
  /**
   * Deletes / anonymises every row owned by `ownerKey` (rules in
   * `OWNER_KEYED_TABLES` and the T118 README section). Call inside a
   * transaction. Throws `RangeError` for a malformed owner key or the
   * tombstone itself (programming errors; nothing is touched).
   */
  purgeOwnerData(ownerKey: string): OwnerPurgeResult;
  /** Number of `auth_sessions` rows (any state) for a user; 0 for a malformed id. */
  countAuthSessions(userId: string): number;
  /** Rows per owner-keyed table that still carry `ownerKey` (diagnostics and tests). */
  countOwnedRows(ownerKey: string): Readonly<Record<OwnerKeyedTable, number>>;
}

interface CountRow {
  n: number;
}

export function createAccountRepository(db: Database): AccountRepository {
  const run = (sql: string, ...params: string[]): number =>
    db.query<unknown, string[]>(sql).run(...params).changes;

  const count = (sql: string, ...params: string[]): number =>
    db.query<CountRow, string[]>(sql).get(...params)?.n ?? 0;

  return {
    purgeOwnerData(ownerKey) {
      if (!isSessionId(ownerKey) || ownerKey === DELETED_OWNER_KEY) {
        throw new RangeError("purgeOwnerData: invalid owner key");
      }
      const k = ownerKey;
      const deleted: Record<string, number> = {};

      // Carts: delete the lines explicitly (exact count), then the cart row.
      deleted.cart_items = run("DELETE FROM cart_items WHERE cart_session_id = ?", k);
      deleted.carts = run("DELETE FROM carts WHERE session_id = ?", k);

      // Lists: items first (they would cascade anyway; this gives the count).
      deleted.list_items = run(
        "DELETE FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE session_id = ?)",
        k,
      );
      deleted.lists = run("DELETE FROM lists WHERE session_id = ?", k);

      deleted.product_views = run("DELETE FROM product_views WHERE session_id = ?", k);

      // Votes cast BY the user: the AFTER DELETE triggers decrement the
      // target's helpful_count. Must run before reviews are deleted so a vote
      // on the user's own review is counted here, not as a cascade.
      deleted.review_votes = run("DELETE FROM review_votes WHERE session_id = ?", k);
      deleted.question_votes = run("DELETE FROM question_votes WHERE session_id = ?", k);
      deleted.answer_votes = run("DELETE FROM answer_votes WHERE session_id = ?", k);

      // Reviews: hard delete (rating triggers adjust products); other
      // shoppers' votes on them go too (explicit, for the count).
      const affectedProductIds = db
        .query<{ product_id: string }, [string]>(
          "SELECT DISTINCT product_id FROM reviews WHERE session_id = ? ORDER BY product_id",
        )
        .all(k)
        .map((row) => row.product_id);
      deleted.review_votes_cascaded = run(
        "DELETE FROM review_votes WHERE review_id IN (SELECT id FROM reviews WHERE session_id = ?)",
        k,
      );
      deleted.reviews = run("DELETE FROM reviews WHERE session_id = ?", k);

      deleted.stock_alerts = run("DELETE FROM stock_alerts WHERE session_id = ?", k);
      deleted.contact_messages = run("DELETE FROM contact_messages WHERE session_id = ?", k);
      deleted.addresses = run("DELETE FROM addresses WHERE session_id = ?", k);

      // Questions / answers (ruling R-7): kept visible with "[deleted]" so
      // other shoppers' answers survive; status and helpful_count unchanged.
      const anonymisedQuestions = run(
        "UPDATE questions SET session_id = ?2, display_name = ?3, body = ?3 WHERE session_id = ?1",
        k,
        DELETED_OWNER_KEY,
        DELETED_MARKER,
      );
      const anonymisedAnswers = run(
        "UPDATE answers SET session_id = ?2, display_name = ?3, body = ?3 WHERE session_id = ?1",
        k,
        DELETED_OWNER_KEY,
        DELETED_MARKER,
      );

      // Orders (rulings R-1, R-6): re-keyed to the tombstone, personal fields
      // replaced; amounts, card_last4, payment_ref, statuses, timestamps,
      // order_items and order_events are not touched.
      const anonymisedOrders = run(
        `UPDATE orders SET
           session_id = ?2,
           full_name = ?3, email = ?3, line1 = ?3, city = ?3, region = ?3, postal_code = ?3, country = ?3,
           line2 = NULL, phone = NULL, delivery_note = NULL
         WHERE session_id = ?1`,
        k,
        DELETED_OWNER_KEY,
        DELETED_MARKER,
      );

      // Coupon redemptions follow their order to the tombstone. PK is
      // (coupon_code, session_id), so the tombstone can hold one redemption
      // per code: a second deleted account's redemption of the same code is
      // skipped by OR IGNORE and then deleted. coupons.used_count is never
      // changed (the redemption still happened; orders keep coupon_code).
      const rekeyedCouponRedemptions = run(
        "UPDATE OR IGNORE coupon_redemptions SET session_id = ?2 WHERE session_id = ?1",
        k,
        DELETED_OWNER_KEY,
      );
      deleted.coupon_redemptions = run("DELETE FROM coupon_redemptions WHERE session_id = ?", k);

      return {
        deletedRows: deleted,
        anonymisedOrders,
        anonymisedQuestions,
        anonymisedAnswers,
        rekeyedCouponRedemptions,
        affectedProductIds,
      };
    },

    countAuthSessions(userId) {
      if (!isSessionId(userId)) return 0;
      return count("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?", userId);
    },

    countOwnedRows(ownerKey) {
      const out = {} as Record<OwnerKeyedTable, number>;
      for (const table of Object.keys(OWNER_KEYED_TABLES) as OwnerKeyedTable[]) {
        const column = table === "cart_items" ? "cart_session_id" : "session_id";
        // Table and column names come from the constant above, never from input.
        out[table] = isSessionId(ownerKey)
          ? count(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, ownerKey)
          : 0;
      }
      return out;
    },
  };
}
