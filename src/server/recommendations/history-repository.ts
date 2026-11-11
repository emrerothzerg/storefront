import type { Database } from "bun:sqlite";
import type { ProductView } from "@/lib/types";
import { withTransaction } from "@/server/db/client";

/**
 * Browsing history SQL (`product_views`), server-only. Callers (the
 * recommendation service) validate the session id with `isSessionId` and the
 * product id shape BEFORE calling; this layer only runs bound statements.
 *
 * Availability ("can be shown") = `stock > 0 AND published_at <= now`, where
 * `now` is an ISO 8601 UTC string compared lexicographically (all timestamps
 * share the `YYYY-MM-DDTHH:MM:SS.sssZ` format).
 */
export interface HistoryRepository {
  /** True when a product row with this id exists (published or not). */
  productExists(productId: string): boolean;
  /**
   * Upserts the (session, product) view with `viewedAt`, then deletes the
   * session's oldest rows beyond `cap`. The row just written is always kept.
   * One transaction.
   */
  recordView(sessionId: string, productId: string, viewedAt: string, cap: number): void;
  removeView(sessionId: string, productId: string): void;
  clearViews(sessionId: string): void;
  /** Newest first (ties: product id), available products only, at most `limit`. */
  listAvailableViews(sessionId: string, nowIso: string, limit: number): ProductView[];
  /** Number of view rows stored for the session (tests, diagnostics). */
  countViews(sessionId: string): number;
}

interface ViewRow {
  product_id: string;
  viewed_at: string;
}

export class SqliteHistoryRepository implements HistoryRepository {
  constructor(private readonly db: Database) {}

  productExists(productId: string): boolean {
    return (
      this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM products WHERE id = ?").get(productId) !== null
    );
  }

  recordView(sessionId: string, productId: string, viewedAt: string, cap: number): void {
    withTransaction(this.db, () => {
      this.db
        .query<never, [string, string, string]>(
          `INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?1, ?2, ?3)
           ON CONFLICT (session_id, product_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
        )
        .run(sessionId, productId, viewedAt);
      this.db
        .query<never, [string, string, number]>(
          `DELETE FROM product_views
            WHERE session_id = ?1
              AND product_id NOT IN (
                SELECT product_id FROM product_views
                 WHERE session_id = ?1
                 ORDER BY (product_id = ?2) DESC, viewed_at DESC, product_id DESC
                 LIMIT ?3)`,
        )
        .run(sessionId, productId, cap);
    });
  }

  removeView(sessionId: string, productId: string): void {
    this.db
      .query<never, [string, string]>("DELETE FROM product_views WHERE session_id = ? AND product_id = ?")
      .run(sessionId, productId);
  }

  clearViews(sessionId: string): void {
    this.db.query<never, [string]>("DELETE FROM product_views WHERE session_id = ?").run(sessionId);
  }

  listAvailableViews(sessionId: string, nowIso: string, limit: number): ProductView[] {
    return this.db
      .query<ViewRow, [string, string, number]>(
        `SELECT v.product_id, v.viewed_at
           FROM product_views AS v
           JOIN products AS p ON p.id = v.product_id
          WHERE v.session_id = ?1 AND p.stock > 0 AND p.published_at <= ?2
          ORDER BY v.viewed_at DESC, v.product_id
          LIMIT ?3`,
      )
      .all(sessionId, nowIso, limit)
      .map((row) => ({ productId: row.product_id, viewedAt: row.viewed_at }));
  }

  countViews(sessionId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?")
      .get(sessionId);
    return row?.n ?? 0;
  }
}
