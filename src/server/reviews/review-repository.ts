import type { Database } from "bun:sqlite";
import type { ContentStatus, Review, StarRating } from "@/lib/types";
import { isSessionId } from "@/server/session/session-id";

/**
 * Review persistence (server-only): a thin SQL layer over `reviews` and
 * `review_votes`. Bound parameters only; no business rules (validation,
 * ownership, verified-purchase policy) live here, they belong to the service.
 *
 * Owner keys (`session_id`) are checked with `isSessionId` before any query:
 * reads with an invalid key return empty results, writes throw a `TypeError`
 * (a programmer error, because the service validates first). Rows mapped to
 * the domain `Review` never carry the author's `session_id`.
 */

export type ReviewSortKey = "helpful" | "recent";

export interface ReviewFilter {
  readonly stars?: StarRating;
  readonly verifiedOnly?: boolean;
}

export interface ReviewPageQuery extends ReviewFilter {
  readonly sort: ReviewSortKey;
  readonly limit: number;
  readonly offset: number;
  /** Valid owner key of the viewer, or null to skip the per-viewer flags. */
  readonly viewer: string | null;
}

export interface ReviewRowWithViewer {
  readonly review: Review;
  /** Present only when `viewer` was given. */
  readonly votedByViewer?: boolean;
  readonly isOwn?: boolean;
}

export interface NewReviewRow {
  readonly id: string;
  readonly productId: string;
  readonly sessionId: string;
  readonly displayName: string;
  readonly rating: StarRating;
  readonly title: string;
  readonly body: string;
  readonly verifiedPurchase: boolean;
  readonly createdAt: string;
}

export interface RatingAggregate {
  readonly count: number;
  readonly sum: number;
}

export interface VoteTarget {
  readonly authorSessionId: string;
  readonly status: ContentStatus;
}

export interface ReviewRepository {
  productExists(productId: string): boolean;
  /** Inserts a published review. Returns false (nothing written) when the owner already reviewed the product. */
  insert(row: NewReviewRow): boolean;
  getById(id: string): Review | null;
  /** True when the owner key has a paid, non-cancelled order containing the product. */
  hasPurchased(sessionId: string, productId: string): boolean;
  /** Fresh aggregate over PUBLISHED reviews. */
  aggregate(productId: string): RatingAggregate;
  /** `products.rating_count/rating_sum` as stored (trigger-maintained); null for unknown product. */
  storedAggregate(productId: string): RatingAggregate | null;
  /** Published review counts per star value (missing stars are absent). */
  histogram(productId: string): ReadonlyMap<number, number>;
  countPublished(productId: string, filter: ReviewFilter): number;
  listPublished(productId: string, query: ReviewPageQuery): ReviewRowWithViewer[];
  /** All reviews (any status) by the owner, newest first. */
  listBySession(sessionId: string): Review[];
  existsForSession(sessionId: string, productId: string): boolean;
  /** Author and status for vote checks; null when the review does not exist. Server-side only. */
  getVoteTarget(reviewId: string): VoteTarget | null;
  /** Records a helpful vote. Returns false (nothing written) when the owner already voted. */
  insertVote(reviewId: string, sessionId: string): boolean;
  helpfulCount(reviewId: string): number | null;
}

interface ReviewDbRow {
  id: string;
  product_id: string;
  display_name: string;
  rating: number;
  title: string;
  body: string;
  verified_purchase: number;
  helpful_count: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface ReviewDbRowWithViewer extends ReviewDbRow {
  is_own: number;
  voted: number;
}

const REVIEW_COLUMNS = `r.id, r.product_id, r.display_name, r.rating, r.title, r.body,
  r.verified_purchase, r.helpful_count, r.status, r.created_at, r.updated_at`;

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) throw new TypeError("ReviewRepository: invalid owner key");
}

function toStarRating(value: number): StarRating {
  if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5) return value;
  // The CHECK constraint makes this unreachable; fail loudly instead of returning a bad type.
  throw new RangeError("ReviewRepository: rating out of range in stored row");
}

function toStatus(value: string): ContentStatus {
  return value === "hidden" ? "hidden" : "published";
}

function toReview(row: ReviewDbRow): Review {
  return {
    id: row.id,
    productId: row.product_id,
    displayName: row.display_name,
    rating: toStarRating(row.rating),
    title: row.title,
    body: row.body,
    verifiedPurchase: row.verified_purchase === 1,
    helpfulCount: row.helpful_count,
    status: toStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Builds the WHERE clause for published reviews of a product plus optional filters. */
function filterClause(productId: string, filter: ReviewFilter): { sql: string; params: (string | number)[] } {
  let sql = "r.product_id = ? AND r.status = 'published'";
  const params: (string | number)[] = [productId];
  if (filter.stars !== undefined) {
    sql += " AND r.rating = ?";
    params.push(filter.stars);
  }
  if (filter.verifiedOnly === true) sql += " AND r.verified_purchase = 1";
  return { sql, params };
}

const ORDER_BY: Record<ReviewSortKey, string> = {
  helpful: "r.helpful_count DESC, r.created_at DESC, r.rowid DESC",
  recent: "r.created_at DESC, r.rowid DESC",
};

export class SqliteReviewRepository implements ReviewRepository {
  constructor(private readonly db: Database) {}

  productExists(productId: string): boolean {
    return this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM products WHERE id = ?").get(productId) !== null;
  }

  insert(row: NewReviewRow): boolean {
    assertSessionId(row.sessionId);
    const result = this.db
      .query<unknown, [string, string, string, string, number, string, string, number, string, string]>(
        `INSERT INTO reviews (id, product_id, session_id, display_name, rating, title, body,
                              verified_purchase, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)
         ON CONFLICT (product_id, session_id) DO NOTHING`,
      )
      .run(
        row.id,
        row.productId,
        row.sessionId,
        row.displayName,
        row.rating,
        row.title,
        row.body,
        row.verifiedPurchase ? 1 : 0,
        row.createdAt,
        row.createdAt,
      );
    return result.changes === 1;
  }

  getById(id: string): Review | null {
    const row = this.db.query<ReviewDbRow, [string]>(`SELECT ${REVIEW_COLUMNS} FROM reviews r WHERE r.id = ?`).get(id);
    return row === null ? null : toReview(row);
  }

  hasPurchased(sessionId: string, productId: string): boolean {
    if (!isSessionId(sessionId)) return false;
    const row = this.db
      .query<{ found: number }, [string, string]>(
        `SELECT EXISTS (
           SELECT 1 FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
            WHERE o.session_id = ?
              AND o.status = 'paid'
              AND o.fulfillment_status <> 'cancelled'
              AND oi.product_id = ?
         ) AS found`,
      )
      .get(sessionId, productId);
    return row !== null && row.found === 1;
  }

  aggregate(productId: string): RatingAggregate {
    const row = this.db
      .query<{ count: number; sum: number }, [string]>(
        `SELECT COUNT(*) AS count, coalesce(SUM(rating), 0) AS sum
           FROM reviews WHERE product_id = ? AND status = 'published'`,
      )
      .get(productId);
    return row === null ? { count: 0, sum: 0 } : { count: row.count, sum: row.sum };
  }

  storedAggregate(productId: string): RatingAggregate | null {
    const row = this.db
      .query<{ rating_count: number; rating_sum: number }, [string]>(
        "SELECT rating_count, rating_sum FROM products WHERE id = ?",
      )
      .get(productId);
    return row === null ? null : { count: row.rating_count, sum: row.rating_sum };
  }

  histogram(productId: string): ReadonlyMap<number, number> {
    const rows = this.db
      .query<{ rating: number; n: number }, [string]>(
        `SELECT rating, COUNT(*) AS n FROM reviews
          WHERE product_id = ? AND status = 'published'
          GROUP BY rating`,
      )
      .all(productId);
    return new Map(rows.map((r) => [r.rating, r.n]));
  }

  countPublished(productId: string, filter: ReviewFilter): number {
    const where = filterClause(productId, filter);
    const row = this.db
      .query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM reviews r WHERE ${where.sql}`)
      .get(...where.params);
    return row === null ? 0 : row.n;
  }

  listPublished(productId: string, query: ReviewPageQuery): ReviewRowWithViewer[] {
    const where = filterClause(productId, query);
    const order = ORDER_BY[query.sort];
    if (query.viewer !== null && isSessionId(query.viewer)) {
      const viewer = query.viewer;
      return this.db
        .query<ReviewDbRowWithViewer, (string | number)[]>(
          `SELECT ${REVIEW_COLUMNS},
                  (r.session_id = ?) AS is_own,
                  EXISTS (SELECT 1 FROM review_votes v WHERE v.review_id = r.id AND v.session_id = ?) AS voted
             FROM reviews r
            WHERE ${where.sql}
            ORDER BY ${order}
            LIMIT ? OFFSET ?`,
        )
        .all(viewer, viewer, ...where.params, query.limit, query.offset)
        .map((row) => ({ review: toReview(row), isOwn: row.is_own === 1, votedByViewer: row.voted === 1 }));
    }
    return this.db
      .query<ReviewDbRow, (string | number)[]>(
        `SELECT ${REVIEW_COLUMNS} FROM reviews r
          WHERE ${where.sql}
          ORDER BY ${order}
          LIMIT ? OFFSET ?`,
      )
      .all(...where.params, query.limit, query.offset)
      .map((row) => ({ review: toReview(row) }));
  }

  listBySession(sessionId: string): Review[] {
    if (!isSessionId(sessionId)) return [];
    return this.db
      .query<ReviewDbRow, [string]>(
        `SELECT ${REVIEW_COLUMNS} FROM reviews r WHERE r.session_id = ? ORDER BY r.created_at DESC, r.rowid DESC`,
      )
      .all(sessionId)
      .map(toReview);
  }

  existsForSession(sessionId: string, productId: string): boolean {
    if (!isSessionId(sessionId)) return false;
    return (
      this.db
        .query<{ one: number }, [string, string]>("SELECT 1 AS one FROM reviews WHERE session_id = ? AND product_id = ?")
        .get(sessionId, productId) !== null
    );
  }

  getVoteTarget(reviewId: string): VoteTarget | null {
    const row = this.db
      .query<{ session_id: string; status: string }, [string]>("SELECT session_id, status FROM reviews WHERE id = ?")
      .get(reviewId);
    return row === null ? null : { authorSessionId: row.session_id, status: toStatus(row.status) };
  }

  insertVote(reviewId: string, sessionId: string): boolean {
    assertSessionId(sessionId);
    const result = this.db
      .query<unknown, [string, string]>(
        "INSERT INTO review_votes (review_id, session_id) VALUES (?, ?) ON CONFLICT (review_id, session_id) DO NOTHING",
      )
      .run(reviewId, sessionId);
    return result.changes === 1;
  }

  helpfulCount(reviewId: string): number | null {
    const row = this.db
      .query<{ helpful_count: number }, [string]>("SELECT helpful_count FROM reviews WHERE id = ?")
      .get(reviewId);
    return row === null ? null : row.helpful_count;
  }
}
