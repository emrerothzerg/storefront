import type { Database } from "bun:sqlite";

/**
 * Search persistence (server-only, T32): the SQL behind `SearchService`.
 * Synchronous, bound parameters only. The FTS5 MATCH string is always a
 * bound parameter built by `buildMatchExpression` from sanitised terms; it is
 * never interpolated into SQL.
 *
 * "Published" means `published_at <= nowIso` (ISO string compare). Every query
 * that returns product data applies it.
 */

/** bm25 column weights: name, brand_name, category_name, description, bullets, department_name. */
export const BM25_RANK = "bm25(products_fts, 10, 6, 4, 1, 1, 3)";

export interface MatchFilter {
  /** FTS5 MATCH expression (bound). */
  readonly match: string;
  /** ISO timestamp; products with `published_at > nowIso` are excluded. */
  readonly nowIso: string;
  readonly inStockOnly: boolean;
}

export interface BrowseFilter {
  readonly nowIso: string;
  readonly inStockOnly: boolean;
}

export interface SlugLabelRow {
  readonly slug: string;
  readonly name: string;
}

export interface VocabRow {
  readonly term: string;
  readonly doc: number;
}

/** Indexed text of one published product (as stored in the `products_search` view). */
export interface SearchTextRow {
  readonly name: string;
  readonly brand_name: string;
  readonly category_name: string;
  readonly description: string;
  readonly bullets: string;
  readonly department_name: string;
}

export interface SearchRepository {
  /** Number of published products matching the expression. */
  countMatches(filter: MatchFilter): number;
  /** Matching product ids, bm25 rank first (weights in `BM25_RANK`), then product id. */
  findMatchIds(filter: MatchFilter, limit: number, offset: number): string[];
  /** Number of published products (browse all). */
  countPublished(filter: BrowseFilter): number;
  /** Published product ids ordered by id (browse all). */
  listPublishedIds(filter: BrowseFilter, limit: number, offset: number): string[];
  /** Top published products for a suggestion prefix, best rank first. */
  suggestProducts(match: string, nowIso: string, limit: number): SlugLabelRow[];
  /** Categories (departments included) with at least one published product, directly or via a child. */
  listCategoriesWithPublished(nowIso: string): SlugLabelRow[];
  /** Brands with at least one published product. */
  listBrandsWithPublished(nowIso: string): SlugLabelRow[];
  /** All rows of `products_fts_vocab` (porter stems with document counts). */
  listVocabulary(): VocabRow[];
  /** Indexed text of every published product. */
  listPublishedText(nowIso: string): SearchTextRow[];
}

const STOCK_CLAUSE = "AND (? = 0 OR p.stock > 0)";

export class SqliteSearchRepository implements SearchRepository {
  constructor(private readonly db: Database) {}

  countMatches(filter: MatchFilter): number {
    const row = this.db
      .query<{ n: number }, [string, string, number]>(
        `SELECT COUNT(*) AS n
           FROM products_fts
           JOIN products AS p ON p.rowid = products_fts.rowid
          WHERE products_fts MATCH ?
            AND p.published_at <= ?
            ${STOCK_CLAUSE}`,
      )
      .get(filter.match, filter.nowIso, filter.inStockOnly ? 1 : 0);
    return row?.n ?? 0;
  }

  findMatchIds(filter: MatchFilter, limit: number, offset: number): string[] {
    return this.db
      .query<{ id: string }, [string, string, number, number, number]>(
        `SELECT p.id AS id
           FROM products_fts
           JOIN products AS p ON p.rowid = products_fts.rowid
          WHERE products_fts MATCH ?
            AND p.published_at <= ?
            ${STOCK_CLAUSE}
          ORDER BY ${BM25_RANK}, p.id
          LIMIT ? OFFSET ?`,
      )
      .all(filter.match, filter.nowIso, filter.inStockOnly ? 1 : 0, limit, offset)
      .map((r) => r.id);
  }

  countPublished(filter: BrowseFilter): number {
    const row = this.db
      .query<{ n: number }, [string, number]>(
        `SELECT COUNT(*) AS n FROM products AS p WHERE p.published_at <= ? ${STOCK_CLAUSE}`,
      )
      .get(filter.nowIso, filter.inStockOnly ? 1 : 0);
    return row?.n ?? 0;
  }

  listPublishedIds(filter: BrowseFilter, limit: number, offset: number): string[] {
    return this.db
      .query<{ id: string }, [string, number, number, number]>(
        `SELECT p.id AS id FROM products AS p
          WHERE p.published_at <= ? ${STOCK_CLAUSE}
          ORDER BY p.id
          LIMIT ? OFFSET ?`,
      )
      .all(filter.nowIso, filter.inStockOnly ? 1 : 0, limit, offset)
      .map((r) => r.id);
  }

  suggestProducts(match: string, nowIso: string, limit: number): SlugLabelRow[] {
    return this.db
      .query<SlugLabelRow, [string, string, number]>(
        `SELECT p.slug AS slug, p.name AS name
           FROM products_fts
           JOIN products AS p ON p.rowid = products_fts.rowid
          WHERE products_fts MATCH ?
            AND p.published_at <= ?
          ORDER BY ${BM25_RANK}, p.id
          LIMIT ?`,
      )
      .all(match, nowIso, limit);
  }

  listCategoriesWithPublished(nowIso: string): SlugLabelRow[] {
    return this.db
      .query<SlugLabelRow, [string]>(
        `SELECT c.slug AS slug, c.name AS name
           FROM categories AS c
          WHERE EXISTS (
                  SELECT 1 FROM products AS p
                   WHERE p.published_at <= ?1
                     AND (p.category_id = c.id
                          OR p.category_id IN (SELECT k.id FROM categories AS k WHERE k.parent_id = c.id))
                )
          ORDER BY c.sort_order, c.name, c.id`,
      )
      .all(nowIso);
  }

  listBrandsWithPublished(nowIso: string): SlugLabelRow[] {
    return this.db
      .query<SlugLabelRow, [string]>(
        `SELECT b.slug AS slug, b.name AS name
           FROM brands AS b
          WHERE EXISTS (SELECT 1 FROM products AS p WHERE p.brand_id = b.id AND p.published_at <= ?)
          ORDER BY b.name, b.id`,
      )
      .all(nowIso);
  }

  listVocabulary(): VocabRow[] {
    return this.db
      .query<VocabRow, []>("SELECT term, doc FROM products_fts_vocab")
      .all();
  }

  listPublishedText(nowIso: string): SearchTextRow[] {
    return this.db
      .query<SearchTextRow, [string]>(
        `SELECT s.name, s.brand_name, s.category_name, s.description, s.bullets, s.department_name
           FROM products_search AS s
           JOIN products AS p ON p.rowid = s.product_rowid
          WHERE p.published_at <= ?
          ORDER BY p.id`,
      )
      .all(nowIso);
  }
}
