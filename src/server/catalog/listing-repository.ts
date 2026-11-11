import type { Database } from "bun:sqlite";

/**
 * Listing SQL (server-only, owned by T33). Works on product ids and counts
 * only; the listing service hydrates ids into `Product` through the product
 * repository, so no raw row (rating_sum, cost, session ids) ever leaves here.
 *
 * Every SQL fragment below is a compile-time constant of this module; all
 * input travels as bound parameters (`IN` lists as one JSON parameter read
 * with `json_each(?)`).
 */

type Param = string | number;

/** Internal sort keys: the public `ListingSort` values plus collection orders. */
export type RepoSort =
  | "relevance"
  | "featured"
  | "price_asc"
  | "price_desc"
  | "rating"
  | "newest"
  | "best_selling"
  | "deal_saving";

/** Already-validated filters. Every field is optional except the publish cut-off. */
export interface RepoFilters {
  /** ISO timestamp; only rows with `published_at <= nowIso` are visible. */
  readonly nowIso: string;
  /** Category id; a department also matches its children. */
  readonly categoryId?: string;
  readonly brandIds?: readonly string[];
  readonly minPriceCents?: number;
  readonly maxPriceCents?: number;
  /** Exact average (rating_sum / rating_count) >= this; unreviewed products never match. */
  readonly minRating?: number;
  readonly inStockOnly?: boolean;
  readonly dealsOnly?: boolean;
  /** Restricts to these ids; their order is the `relevance` order. */
  readonly ids?: readonly string[];
  /** Only products with at least this many published reviews. */
  readonly minReviewCount?: number;
  /** Only products with at least one unit sold (paid, not cancelled). */
  readonly soldOnly?: boolean;
}

/** Facet dimensions that can be left out of a filter set (disjunctive counts). */
export type FacetDimension = "category" | "brand" | "price" | "rating" | "inStock";

export interface BrandCount {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly count: number;
}

export interface PriceRange {
  readonly minCents: number;
  readonly maxCents: number | null;
}

const AVG = "(CASE WHEN p.rating_count > 0 THEN CAST(p.rating_sum AS REAL) / p.rating_count ELSE 0 END)";

/** Units sold per product: paid orders that were not cancelled. */
const SALES_JOIN = `LEFT JOIN (
    SELECT oi.product_id AS product_id, SUM(oi.quantity) AS units
      FROM order_items AS oi
      JOIN orders AS o ON o.id = oi.order_id
     WHERE o.status = 'paid' AND o.fulfillment_status <> 'cancelled'
     GROUP BY oi.product_id
  ) AS s ON s.product_id = p.id`;

/** First position of each id in the bound JSON array. */
const IDS_JOIN = `JOIN (
    SELECT value AS id, MIN(key) AS pos FROM json_each(?) GROUP BY value
  ) AS r ON r.id = p.id`;

const ORDER_BY: Readonly<Record<Exclude<RepoSort, "relevance">, string>> = {
  featured: `p.is_featured DESC, ${AVG} DESC, p.id`,
  price_asc: "p.price_cents ASC, p.id",
  price_desc: "p.price_cents DESC, p.id",
  rating: `${AVG} DESC, p.rating_count DESC, p.id`,
  newest: "p.published_at DESC, p.id",
  best_selling: "coalesce(s.units, 0) DESC, p.id",
  // Only used together with `dealsOnly`, so list_price_cents > price_cents >= 0.
  deal_saving: "CAST(p.list_price_cents - p.price_cents AS REAL) / p.list_price_cents DESC, p.id",
};

interface Built {
  readonly from: string;
  readonly params: Param[];
}

/**
 * Builds `FROM ... WHERE ...` for the filters, leaving out `omit` (the facet
 * whose own counts are being computed). `withSales` adds the `s.units` join,
 * `withBrand` an inner join to `brands AS b`.
 */
function build(f: RepoFilters, omit: FacetDimension | null, withSales: boolean, withBrand = false): Built {
  const joins: string[] = withBrand ? ["JOIN brands AS b ON b.id = p.brand_id"] : [];
  const joinParams: Param[] = [];
  const where: string[] = ["p.published_at <= ?"];
  const params: Param[] = [f.nowIso];

  if (f.ids !== undefined) {
    joins.push(IDS_JOIN);
    joinParams.push(JSON.stringify(f.ids));
  }
  if (withSales || f.soldOnly === true) joins.push(SALES_JOIN);
  if (f.soldOnly === true) where.push("coalesce(s.units, 0) > 0");

  if (omit !== "category" && f.categoryId !== undefined) {
    where.push("(p.category_id = ? OR p.category_id IN (SELECT id FROM categories WHERE parent_id = ?))");
    params.push(f.categoryId, f.categoryId);
  }
  if (omit !== "brand" && f.brandIds !== undefined) {
    where.push("p.brand_id IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(f.brandIds));
  }
  if (omit !== "price") {
    if (f.minPriceCents !== undefined) {
      where.push("p.price_cents >= ?");
      params.push(f.minPriceCents);
    }
    if (f.maxPriceCents !== undefined) {
      where.push("p.price_cents <= ?");
      params.push(f.maxPriceCents);
    }
  }
  if (omit !== "rating" && f.minRating !== undefined) {
    // Integer arithmetic: avg >= N  <=>  sum >= N * count (count > 0).
    where.push("p.rating_count > 0 AND p.rating_sum >= ? * p.rating_count");
    params.push(f.minRating);
  }
  if (omit !== "inStock" && f.inStockOnly === true) where.push("p.stock > 0");
  if (f.dealsOnly === true) where.push("p.list_price_cents IS NOT NULL AND p.list_price_cents > p.price_cents");
  if (f.minReviewCount !== undefined) {
    where.push("p.rating_count >= ?");
    params.push(f.minReviewCount);
  }

  return {
    from: `FROM products AS p ${joins.join(" ")} WHERE ${where.join(" AND ")}`,
    params: [...joinParams, ...params],
  };
}

export class SqliteListingRepository {
  constructor(private readonly db: Database) {}

  /** Ids of one page in a deterministic total order (id is always the last key). */
  findIds(filters: RepoFilters, sort: RepoSort, limit: number, offset: number): string[] {
    const effective: RepoSort = sort === "relevance" && filters.ids === undefined ? "featured" : sort;
    const orderBy = effective === "relevance" ? "r.pos ASC, p.id" : ORDER_BY[effective];
    const { from, params } = build(filters, null, effective === "best_selling");
    return this.db
      .query<{ id: string }, Param[]>(`SELECT p.id AS id ${from} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map((row) => row.id);
  }

  /** Number of products matching every filter except `omit`. */
  count(filters: RepoFilters, omit: FacetDimension | null = null): number {
    const { from, params } = build(filters, omit, false);
    const row = this.db.query<{ n: number }, Param[]>(`SELECT COUNT(*) AS n ${from}`).get(...params);
    return row?.n ?? 0;
  }

  /** Matching products per `category_id` (category filter left out); null category omitted. */
  categoryCounts(filters: RepoFilters): Map<string, number> {
    const { from, params } = build(filters, "category", false);
    const rows = this.db
      .query<{ category_id: string; n: number }, Param[]>(
        `SELECT p.category_id AS category_id, COUNT(*) AS n ${from} AND p.category_id IS NOT NULL GROUP BY p.category_id`,
      )
      .all(...params);
    return new Map(rows.map((row) => [row.category_id, row.n]));
  }

  /** Matching products per brand (brand filter left out), ordered by brand name then id. */
  brandCounts(filters: RepoFilters): BrandCount[] {
    const { from, params } = build(filters, "brand", false, true);
    return this.db
      .query<{ id: string; slug: string; name: string; n: number }, Param[]>(
        `SELECT b.id AS id, b.slug AS slug, b.name AS name, COUNT(*) AS n
           ${from}
          GROUP BY b.id ORDER BY b.name, b.id`,
      )
      .all(...params)
      .map((row) => ({ id: row.id, slug: row.slug, name: row.name, count: row.n }));
  }

  /** Matching products per price range (price filter left out), one count per range in order. */
  priceCounts(filters: RepoFilters, ranges: readonly PriceRange[]): number[] {
    const { from, params } = build(filters, "price", false);
    const rows = this.db
      .query<{ price_cents: number; n: number }, Param[]>(
        `SELECT p.price_cents AS price_cents, COUNT(*) AS n ${from} GROUP BY p.price_cents`,
      )
      .all(...params);
    return ranges.map((range) =>
      rows
        .filter((row) => row.price_cents >= range.minCents && (range.maxCents === null || row.price_cents <= range.maxCents))
        .reduce((sum, row) => sum + row.n, 0),
    );
  }

  /** Counts for "N stars & up", N = 1..4 (rating filter left out). */
  ratingCounts(filters: RepoFilters): [number, number, number, number] {
    const { from, params } = build(filters, "rating", false);
    const row = this.db
      .query<{ r1: number | null; r2: number | null; r3: number | null; r4: number | null }, Param[]>(
        `SELECT SUM(p.rating_count > 0 AND p.rating_sum >= 1 * p.rating_count) AS r1,
                SUM(p.rating_count > 0 AND p.rating_sum >= 2 * p.rating_count) AS r2,
                SUM(p.rating_count > 0 AND p.rating_sum >= 3 * p.rating_count) AS r3,
                SUM(p.rating_count > 0 AND p.rating_sum >= 4 * p.rating_count) AS r4
           ${from}`,
      )
      .get(...params);
    return [row?.r1 ?? 0, row?.r2 ?? 0, row?.r3 ?? 0, row?.r4 ?? 0];
  }

  /** Matching in-stock products (in-stock filter left out, then applied). */
  inStockCount(filters: RepoFilters): number {
    return this.count({ ...filters, inStockOnly: true }, null);
  }

  /**
   * `published_at` of the given product ids (T167, (bx)): the listing service
   * adds it to listing summaries so cards can show the "New" badge. Ids that
   * do not exist (or have a blank / non-string date) are absent from the map.
   * Never filters by publication: the caller passes ids it already listed.
   */
  publishedAtByIds(ids: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const rows = this.db
      .query<{ id: string; published_at: unknown }, [string]>(
        "SELECT p.id AS id, p.published_at AS published_at FROM products AS p WHERE p.id IN (SELECT value FROM json_each(?))",
      )
      .all(JSON.stringify(ids));
    for (const row of rows) {
      if (typeof row.published_at === "string" && row.published_at !== "") out.set(row.id, row.published_at);
    }
    return out;
  }

  /** Published products per `category_id` (direct membership only). */
  publishedCountsByCategory(nowIso: string): Map<string, number> {
    return this.categoryCounts({ nowIso });
  }

  /**
   * Best Sellers Rank of a published product within its own (leaf) category:
   * 1-based position by units sold desc, id asc, among products with sales.
   * `null` when the product is unknown, unpublished, uncategorised or has no sales.
   */
  rankInCategory(productId: string, nowIso: string): { rank: number; categoryId: string } | null {
    const row = this.db
      .query<{ rank: number; category_id: string }, [string, string, string]>(
        `WITH sales AS (
           SELECT oi.product_id AS product_id, SUM(oi.quantity) AS units
             FROM order_items AS oi
             JOIN orders AS o ON o.id = oi.order_id
            WHERE o.status = 'paid' AND o.fulfillment_status <> 'cancelled'
            GROUP BY oi.product_id
         ),
         target AS (
           SELECT p.id, p.category_id, s.units
             FROM products AS p JOIN sales AS s ON s.product_id = p.id
            WHERE p.id = ? AND p.published_at <= ? AND p.category_id IS NOT NULL AND s.units > 0
         )
         SELECT 1 + (
                  SELECT COUNT(*)
                    FROM products AS p JOIN sales AS s ON s.product_id = p.id
                   WHERE p.category_id = t.category_id AND p.published_at <= ? AND s.units > 0
                     AND (s.units > t.units OR (s.units = t.units AND p.id < t.id))
                ) AS rank,
                t.category_id AS category_id
           FROM target AS t`,
      )
      .get(productId, nowIso, nowIso);
    return row === null ? null : { rank: row.rank, categoryId: row.category_id };
  }
}
