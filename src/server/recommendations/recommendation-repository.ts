import type { Database } from "bun:sqlite";

/**
 * Recommendation SQL (server-only, read-only). Every method returns ranked
 * product ids; the service hydrates them with `getManyByIds`.
 *
 * Shared rules, applied inside every candidate query:
 * - availability: `p.stock > 0 AND p.published_at <= $now` (ISO 8601 UTC
 *   strings compare lexicographically);
 * - exclusion: `p.id NOT IN (SELECT value FROM json_each($exclude))`, a JSON
 *   array bound as ONE parameter (no SQL built from input, no variable limit);
 * - "paid": `o.status = 'paid' AND o.fulfillment_status <> 'cancelled'`;
 * - ties on the score are broken by product id ascending.
 *
 * Callers validate ids (UUID session ids, product id strings) before calling.
 */

/** A ranked candidate. `score` meaning depends on the query (co-purchase count, units, ...). */
export interface ScoredId {
  readonly id: string;
  readonly score: number;
}

/** What the service needs to know about a source product. */
export interface ProductFacts {
  readonly id: string;
  readonly categoryId: string | null;
  readonly brandId: string | null;
  readonly currency: string;
  /** In stock and published at `now`. */
  readonly available: boolean;
}

/** Common candidate-query arguments. `exclude` is a list of product ids. */
export interface CandidateQuery {
  readonly nowIso: string;
  readonly exclude: readonly string[];
  readonly limit: number;
}

export interface RecommendationRepository {
  productFacts(productId: string, nowIso: string): ProductFacts | null;
  categoryExists(categoryId: string): boolean;
  /** Distinct category ids of the given products (unknown ids skipped). */
  categoryIdsOf(productIds: readonly string[]): string[];
  /**
   * Products bought in the same paid orders as any of `sources` (sources
   * themselves never returned). Score = number of (source, order) pairs, which
   * for one source is the number of distinct paid orders containing both.
   * Only candidates with score >= `minScore`.
   */
  coPurchased(sources: readonly string[], minScore: number, q: CandidateQuery): ScoredId[];
  /** Products viewed by the sessions that viewed `productId`; score = number of such sessions. */
  coViewed(productId: string, q: CandidateQuery): ScoredId[];
  /**
   * Same category first (tier 0), then same brand in another category
   * (tier 1); inside a tier by Bayesian rating desc, then id.
   */
  related(categoryId: string | null, brandId: string | null, q: CandidateQuery): string[];
  /** Ids the session has viewed (any availability), newest first. */
  viewedIds(sessionId: string): string[];
  /**
   * Products sharing a category or brand with the session's views; score =
   * 2 x views in its category + views of its brand. Viewed products excluded.
   */
  inspiredBy(sessionId: string, q: CandidateQuery): ScoredId[];
  /** Distinct products from the session's paid orders, latest order first. */
  buyAgain(sessionId: string, q: CandidateQuery): string[];
  /** Product ids in the session's cart, oldest line first. */
  cartProductIds(sessionId: string): string[];
  /**
   * Products in the categories (a department includes its children) ordered by
   * paid units desc (unsold products included, units 0), then id.
   */
  categoryBestSellers(categoryIds: readonly string[], q: CandidateQuery): string[];
  /** Products with at least one paid unit, units desc, then id. */
  globalBestSellers(q: CandidateQuery): string[];
  /** Most recently published first, then id. */
  newest(q: CandidateQuery): string[];
  /** Paid units of the product in orders created in [sinceIso, untilIso]. */
  unitsSold(productId: string, sinceIso: string, untilIso: string): number;
}

type Params = Record<string, string | number>;

const AVAILABLE = "p.stock > 0 AND p.published_at <= $now";
const NOT_EXCLUDED = "p.id NOT IN (SELECT value FROM json_each($exclude))";
const PAID = "o.status = 'paid' AND o.fulfillment_status <> 'cancelled'";
/** Bayesian average: prior mean 3 stars with a weight of 3 reviews (unreviewed = 3.0). */
const RATING_SCORE = "(p.rating_sum + 9.0) / (p.rating_count + 3)";
/** How many of the newest views shape `inspiredBy`. */
const INSPIRED_WINDOW = 50;

interface IdRow {
  id: string;
}

interface ScoredRow {
  id: string;
  score: number;
}

function base(q: CandidateQuery): Params {
  return { now: q.nowIso, exclude: JSON.stringify(q.exclude), limit: q.limit };
}

export class SqliteRecommendationRepository implements RecommendationRepository {
  constructor(private readonly db: Database) {}

  private ids(sql: string, params: Params): string[] {
    return this.db.query<IdRow, [Params]>(sql).all(params).map((row) => row.id);
  }

  private scored(sql: string, params: Params): ScoredId[] {
    return this.db
      .query<ScoredRow, [Params]>(sql)
      .all(params)
      .map((row) => ({ id: row.id, score: row.score }));
  }

  productFacts(productId: string, nowIso: string): ProductFacts | null {
    const row = this.db
      .query<
        { id: string; category_id: string | null; brand_id: string | null; currency: string; available: number },
        [Params]
      >(
        `SELECT p.id, p.category_id, p.brand_id, p.currency, (${AVAILABLE}) AS available
           FROM products AS p WHERE p.id = $id`,
      )
      .get({ id: productId, now: nowIso });
    if (row === null) return null;
    return {
      id: row.id,
      categoryId: row.category_id,
      brandId: row.brand_id,
      currency: row.currency,
      available: row.available === 1,
    };
  }

  categoryExists(categoryId: string): boolean {
    return (
      this.db.query<{ one: number }, [string]>("SELECT 1 AS one FROM categories WHERE id = ?").get(categoryId) !== null
    );
  }

  categoryIdsOf(productIds: readonly string[]): string[] {
    if (productIds.length === 0) return [];
    return this.ids(
      `SELECT DISTINCT p.category_id AS id FROM products AS p
        WHERE p.id IN (SELECT value FROM json_each($ids)) AND p.category_id IS NOT NULL
        ORDER BY p.category_id`,
      { ids: JSON.stringify(productIds) },
    );
  }

  coPurchased(sources: readonly string[], minScore: number, q: CandidateQuery): ScoredId[] {
    if (sources.length === 0) return [];
    return this.scored(
      `SELECT b.product_id AS id, COUNT(*) AS score
         FROM order_items AS a
         JOIN orders AS o ON o.id = a.order_id
         JOIN order_items AS b ON b.order_id = a.order_id AND b.product_id <> a.product_id
         JOIN products AS p ON p.id = b.product_id
        WHERE a.product_id IN (SELECT value FROM json_each($sources))
          AND b.product_id NOT IN (SELECT value FROM json_each($sources))
          AND ${PAID} AND ${AVAILABLE} AND ${NOT_EXCLUDED}
        GROUP BY b.product_id
       HAVING COUNT(*) >= $min
        ORDER BY score DESC, id
        LIMIT $limit`,
      { ...base(q), sources: JSON.stringify(sources), min: minScore },
    );
  }

  coViewed(productId: string, q: CandidateQuery): ScoredId[] {
    return this.scored(
      `SELECT b.product_id AS id, COUNT(*) AS score
         FROM product_views AS a
         JOIN product_views AS b ON b.session_id = a.session_id AND b.product_id <> a.product_id
         JOIN products AS p ON p.id = b.product_id
        WHERE a.product_id = $source AND ${AVAILABLE} AND ${NOT_EXCLUDED}
        GROUP BY b.product_id
        ORDER BY score DESC, id
        LIMIT $limit`,
      { ...base(q), source: productId },
    );
  }

  related(categoryId: string | null, brandId: string | null, q: CandidateQuery): string[] {
    if (categoryId === null && brandId === null) return [];
    return this.ids(
      `SELECT p.id FROM products AS p
        WHERE (p.category_id = $category OR p.brand_id = $brand)
          AND ${AVAILABLE} AND ${NOT_EXCLUDED}
        ORDER BY CASE WHEN p.category_id = $category THEN 0 ELSE 1 END, ${RATING_SCORE} DESC, p.id
        LIMIT $limit`,
      // '' never matches a real id, so a missing category/brand matches nothing.
      { ...base(q), category: categoryId ?? "", brand: brandId ?? "" },
    );
  }

  viewedIds(sessionId: string): string[] {
    return this.ids(
      "SELECT product_id AS id FROM product_views WHERE session_id = $session ORDER BY viewed_at DESC, product_id",
      { session: sessionId },
    );
  }

  inspiredBy(sessionId: string, q: CandidateQuery): ScoredId[] {
    return this.scored(
      `WITH seen AS (
              SELECT sp.category_id, sp.brand_id
                FROM product_views AS v JOIN products AS sp ON sp.id = v.product_id
               WHERE v.session_id = $session
               ORDER BY v.viewed_at DESC
               LIMIT $window),
            cat AS (SELECT category_id AS cid, COUNT(*) AS w FROM seen WHERE category_id IS NOT NULL GROUP BY category_id),
            brand AS (SELECT brand_id AS bid, COUNT(*) AS w FROM seen WHERE brand_id IS NOT NULL GROUP BY brand_id)
       SELECT p.id, 2 * coalesce(cat.w, 0) + coalesce(brand.w, 0) AS score
         FROM products AS p
         LEFT JOIN cat ON cat.cid = p.category_id
         LEFT JOIN brand ON brand.bid = p.brand_id
        WHERE (cat.cid IS NOT NULL OR brand.bid IS NOT NULL)
          AND p.id NOT IN (SELECT product_id FROM product_views WHERE session_id = $session)
          AND ${AVAILABLE} AND ${NOT_EXCLUDED}
        ORDER BY score DESC, p.id
        LIMIT $limit`,
      { ...base(q), session: sessionId, window: INSPIRED_WINDOW },
    );
  }

  buyAgain(sessionId: string, q: CandidateQuery): string[] {
    return this.ids(
      `SELECT oi.product_id AS id, MAX(o.created_at) AS last_ordered_at
         FROM orders AS o
         JOIN order_items AS oi ON oi.order_id = o.id
         JOIN products AS p ON p.id = oi.product_id
        WHERE o.session_id = $session AND ${PAID} AND ${AVAILABLE} AND ${NOT_EXCLUDED}
        GROUP BY oi.product_id
        ORDER BY last_ordered_at DESC, id
        LIMIT $limit`,
      { ...base(q), session: sessionId },
    );
  }

  cartProductIds(sessionId: string): string[] {
    return this.ids(
      "SELECT product_id AS id FROM cart_items WHERE cart_session_id = $session ORDER BY created_at, product_id",
      { session: sessionId },
    );
  }

  categoryBestSellers(categoryIds: readonly string[], q: CandidateQuery): string[] {
    if (categoryIds.length === 0) return [];
    return this.ids(
      `WITH cats AS (
              SELECT value AS cid FROM json_each($categories)
              UNION
              SELECT c.id FROM categories AS c WHERE c.parent_id IN (SELECT value FROM json_each($categories))),
            sold AS (
              SELECT oi.product_id, SUM(oi.quantity) AS units
                FROM order_items AS oi JOIN orders AS o ON o.id = oi.order_id
               WHERE ${PAID}
               GROUP BY oi.product_id)
       SELECT p.id FROM products AS p
         LEFT JOIN sold ON sold.product_id = p.id
        WHERE p.category_id IN (SELECT cid FROM cats) AND ${AVAILABLE} AND ${NOT_EXCLUDED}
        ORDER BY coalesce(sold.units, 0) DESC, p.id
        LIMIT $limit`,
      { ...base(q), categories: JSON.stringify(categoryIds) },
    );
  }

  globalBestSellers(q: CandidateQuery): string[] {
    return this.ids(
      `WITH sold AS (
              SELECT oi.product_id, SUM(oi.quantity) AS units
                FROM order_items AS oi JOIN orders AS o ON o.id = oi.order_id
               WHERE ${PAID}
               GROUP BY oi.product_id)
       SELECT p.id FROM sold JOIN products AS p ON p.id = sold.product_id
        WHERE ${AVAILABLE} AND ${NOT_EXCLUDED}
        ORDER BY sold.units DESC, p.id
        LIMIT $limit`,
      base(q),
    );
  }

  newest(q: CandidateQuery): string[] {
    return this.ids(
      `SELECT p.id FROM products AS p
        WHERE ${AVAILABLE} AND ${NOT_EXCLUDED}
        ORDER BY p.published_at DESC, p.id
        LIMIT $limit`,
      base(q),
    );
  }

  unitsSold(productId: string, sinceIso: string, untilIso: string): number {
    const row = this.db
      .query<{ units: number }, [Params]>(
        `SELECT coalesce(SUM(oi.quantity), 0) AS units
           FROM order_items AS oi JOIN orders AS o ON o.id = oi.order_id
          WHERE oi.product_id = $id AND ${PAID} AND o.created_at >= $since AND o.created_at <= $until`,
      )
      .get({ id: productId, since: sinceIso, until: untilIso });
    return row?.units ?? 0;
  }
}
