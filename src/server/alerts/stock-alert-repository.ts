import type { Database } from "bun:sqlite";
import type { StockAlert } from "@/lib/types";
import { isSessionId } from "@/server/session/session-id";

/**
 * Stock alert persistence (server-only): a thin SQL layer over `stock_alerts`.
 * Bound parameters only. No business rules live here (stock, limits,
 * idempotency): those belong to the stock alert service.
 *
 * Every statement is scoped by `session_id` (the owner key). Session ids are
 * checked with `isSessionId` before any query: reads with an invalid id
 * return empty results, writes throw a `TypeError` (a programmer error,
 * because the service validates first). Rows returned to callers never carry
 * the session id.
 */

export interface NewStockAlertRow {
  readonly id: string;
  readonly productId: string;
  readonly createdAt: string;
}

export interface StockAlertRepository {
  /** The session's alerts, newest first (`created_at DESC`, then insertion order DESC). */
  listForSession(sessionId: string): StockAlert[];
  /** The session's alert for this product, or `null`. */
  findByProduct(sessionId: string, productId: string): StockAlert | null;
  /** The alert with this id if it belongs to the session, else `null` (foreign ids look absent). */
  findById(sessionId: string, alertId: string): StockAlert | null;
  /** Number of alerts the session holds. */
  countForSession(sessionId: string): number;
  /** Inserts the row; returns false (and writes nothing) when the (product, session) pair already exists. */
  insert(sessionId: string, row: NewStockAlertRow): boolean;
  /** Deletes the session's alert; returns false when no such row belongs to the session. */
  delete(sessionId: string, alertId: string): boolean;
  /**
   * Sets `acknowledged_at` to `at` unless already set (the first acknowledgement
   * wins). Returns false when no such row belongs to the session.
   */
  acknowledge(sessionId: string, alertId: string, at: string): boolean;
}

interface StockAlertDbRow {
  id: string;
  product_id: string;
  created_at: string;
  acknowledged_at: string | null;
}

const COLUMNS = "id, product_id, created_at, acknowledged_at";

function toAlert(row: StockAlertDbRow): StockAlert {
  return {
    id: row.id,
    productId: row.product_id,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) {
    throw new TypeError("StockAlertRepository: invalid session id");
  }
}

export class SqliteStockAlertRepository implements StockAlertRepository {
  constructor(private readonly db: Database) {}

  listForSession(sessionId: string): StockAlert[] {
    if (!isSessionId(sessionId)) return [];
    return this.db
      .query<StockAlertDbRow, [string]>(
        `SELECT ${COLUMNS} FROM stock_alerts
          WHERE session_id = ?
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(sessionId)
      .map(toAlert);
  }

  findByProduct(sessionId: string, productId: string): StockAlert | null {
    if (!isSessionId(sessionId)) return null;
    const row = this.db
      .query<StockAlertDbRow, [string, string]>(
        `SELECT ${COLUMNS} FROM stock_alerts WHERE session_id = ? AND product_id = ?`,
      )
      .get(sessionId, productId);
    return row === null ? null : toAlert(row);
  }

  findById(sessionId: string, alertId: string): StockAlert | null {
    if (!isSessionId(sessionId)) return null;
    const row = this.db
      .query<StockAlertDbRow, [string, string]>(
        `SELECT ${COLUMNS} FROM stock_alerts WHERE session_id = ? AND id = ?`,
      )
      .get(sessionId, alertId);
    return row === null ? null : toAlert(row);
  }

  countForSession(sessionId: string): number {
    if (!isSessionId(sessionId)) return 0;
    const row = this.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?")
      .get(sessionId);
    return row?.n ?? 0;
  }

  insert(sessionId: string, row: NewStockAlertRow): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<unknown, [string, string, string, string]>(
        `INSERT INTO stock_alerts (id, product_id, session_id, created_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (product_id, session_id) DO NOTHING`,
      )
      .run(row.id, row.productId, sessionId, row.createdAt);
    return result.changes > 0;
  }

  delete(sessionId: string, alertId: string): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<unknown, [string, string]>("DELETE FROM stock_alerts WHERE session_id = ? AND id = ?")
      .run(sessionId, alertId);
    return result.changes > 0;
  }

  acknowledge(sessionId: string, alertId: string, at: string): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<unknown, [string, string, string]>(
        `UPDATE stock_alerts
            SET acknowledged_at = COALESCE(acknowledged_at, ?3)
          WHERE session_id = ?1 AND id = ?2`,
      )
      .run(sessionId, alertId, at);
    return result.changes > 0;
  }
}
