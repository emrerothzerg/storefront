import type { Database } from "bun:sqlite";
import type { ContactMessage } from "@/lib/types";
import { isSessionId } from "@/server/session/session-id";

/**
 * Contact message persistence (server-only): thin SQL over `contact_messages`
 * plus the two ownership/existence lookups the service needs (`orders`,
 * `products`). Bound parameters only; no business rules (limits, duplicate
 * window, reference format) live here.
 *
 * Session ids are owner keys. Reads with a non-UUID id return empty results;
 * `insert` accepts `null` (guest without a cookie) and throws a `TypeError`
 * for any other non-UUID value (a programmer error: the service validates).
 */

export interface NewContactMessageRow {
  readonly id: string;
  readonly reference: string;
  readonly sessionId: string | null;
  readonly name: string;
  readonly email: string;
  readonly topic: string;
  readonly orderId: string | null;
  readonly productSlug: string | null;
  readonly message: string;
  readonly createdAt: string;
}

export interface ContactSummaryRow {
  readonly reference: string;
  readonly topic: string;
  readonly createdAt: string;
  readonly orderId: string | null;
  readonly productSlug: string | null;
  readonly message: string;
}

export interface ContactRepository {
  insert(row: NewContactMessageRow): void;
  referenceExists(reference: string): boolean;
  /** True when the same session stored exactly `message` at or after `sinceIso`. */
  hasRecentDuplicate(sessionId: string, message: string, sinceIso: string): boolean;
  /** Own messages, newest first, at most `limit`. */
  listForSession(sessionId: string, limit: number): ContactSummaryRow[];
  /** The message with `reference` only when it belongs to `sessionId`; otherwise null. */
  getOwnedByReference(sessionId: string, reference: string): ContactMessage | null;
  /** True when `orderId` is an order of `sessionId` (same answer for "missing" and "foreign"). */
  isOrderOwnedBy(sessionId: string, orderId: string): boolean;
  /** True when a product with this slug exists and is published at `nowIso` (`published_at <= nowIso`). */
  productSlugExists(slug: string, nowIso: string): boolean;
}

interface MessageRow {
  id: string;
  reference: string;
  name: string;
  email: string;
  topic: string;
  order_id: string | null;
  product_slug: string | null;
  message: string;
  created_at: string;
}

interface SummaryRow {
  reference: string;
  topic: string;
  created_at: string;
  order_id: string | null;
  product_slug: string | null;
  message: string;
}

export class SqliteContactRepository implements ContactRepository {
  constructor(private readonly db: Database) {}

  insert(row: NewContactMessageRow): void {
    if (row.sessionId !== null && !isSessionId(row.sessionId)) {
      throw new TypeError("ContactRepository: invalid session id");
    }
    this.db
      .query(
        `INSERT INTO contact_messages
           (id, reference, session_id, name, email, topic, order_id, product_slug, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.reference,
        row.sessionId,
        row.name,
        row.email,
        row.topic,
        row.orderId,
        row.productSlug,
        row.message,
        row.createdAt,
      );
  }

  referenceExists(reference: string): boolean {
    return this.db.query("SELECT 1 AS x FROM contact_messages WHERE reference = ?").get(reference) !== null;
  }

  hasRecentDuplicate(sessionId: string, message: string, sinceIso: string): boolean {
    if (!isSessionId(sessionId)) return false;
    return (
      this.db
        .query("SELECT 1 AS x FROM contact_messages WHERE session_id = ? AND message = ? AND created_at >= ? LIMIT 1")
        .get(sessionId, message, sinceIso) !== null
    );
  }

  listForSession(sessionId: string, limit: number): ContactSummaryRow[] {
    if (!isSessionId(sessionId)) return [];
    return this.db
      .query<SummaryRow, [string, number]>(
        `SELECT reference, topic, created_at, order_id, product_slug, message
           FROM contact_messages
          WHERE session_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
      )
      .all(sessionId, limit)
      .map((r) => ({
        reference: r.reference,
        topic: r.topic,
        createdAt: r.created_at,
        orderId: r.order_id,
        productSlug: r.product_slug,
        message: r.message,
      }));
  }

  getOwnedByReference(sessionId: string, reference: string): ContactMessage | null {
    if (!isSessionId(sessionId)) return null;
    const r = this.db
      .query<MessageRow, [string, string]>(
        `SELECT id, reference, name, email, topic, order_id, product_slug, message, created_at
           FROM contact_messages
          WHERE reference = ? AND session_id = ?`,
      )
      .get(reference, sessionId);
    if (r === null) return null;
    return {
      id: r.id,
      reference: r.reference,
      name: r.name,
      email: r.email,
      topic: r.topic,
      orderId: r.order_id,
      productSlug: r.product_slug,
      message: r.message,
      createdAt: r.created_at,
    };
  }

  isOrderOwnedBy(sessionId: string, orderId: string): boolean {
    if (!isSessionId(sessionId)) return false;
    return this.db.query("SELECT 1 AS x FROM orders WHERE id = ? AND session_id = ?").get(orderId, sessionId) !== null;
  }

  productSlugExists(slug: string, nowIso: string): boolean {
    return this.db.query("SELECT 1 AS x FROM products WHERE slug = ? AND published_at <= ?").get(slug, nowIso) !== null;
  }
}
