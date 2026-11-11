import type { Database } from "bun:sqlite";
import type { Brand, Category, Product, ProductDetail, ProductImage, ProductSpec } from "@/lib/types";
import { fail, ok, type Result } from "@/lib/result";

/**
 * Product catalog data access (server-only). All methods are synchronous
 * (bun:sqlite is synchronous), return domain objects only, and use bound
 * parameters exclusively.
 *
 * `Product` results carry the sparse summary fields (brand/category names
 * and slugs, list price, rating, featured flag, SKU) only when they hold a
 * value; see `Product` in `@/lib/types`. Search and facets live in
 * `src/server/search/`, not here.
 */
export interface ProductRepository {
  /** All products ordered by name then id; `[]` when the table is empty. */
  list(): Product[];
  /** `null` when no product has this slug (never throws for odd input). */
  getBySlug(slug: string): Product | null;
  /** `null` when no product has this id. */
  getById(id: string): Product | null;
  /**
   * Products for the given ids, in the order of first appearance in `ids`.
   * Unknown ids are skipped and duplicates collapsed; `[]` for no ids.
   */
  getManyByIds(ids: readonly string[]): Product[];
  /**
   * Atomically removes `quantity` units from stock with one conditional
   * UPDATE, so stock can never go negative even under concurrent callers.
   * Errors: INVALID_QUANTITY (not a positive safe integer), PRODUCT_NOT_FOUND,
   * OUT_OF_STOCK (stock is 0), INSUFFICIENT_STOCK (0 < stock < quantity;
   * `details.available` and `details.requested`).
   * Call inside `withTransaction` to combine with other writes.
   */
  decrementStock(productId: string, quantity: number): Result<Product>;
}

/**
 * Phase 2 read methods. Kept off `ProductRepository` so the cart/checkout
 * services (and their test fakes) depend only on the core contract.
 */
export interface CatalogProductRepository extends ProductRepository {
  /**
   * Full product page data, or `null` for an unknown slug. JSON columns are
   * parsed defensively: malformed data yields empty arrays, never a throw.
   */
  getDetailBySlug(slug: string): ProductDetail | null;
  /**
   * Products in a category ordered by name. For a department, includes the
   * products of its child categories. `[]` for an unknown id.
   * `limit` (optional) caps the result; see `limit` rules below.
   */
  listByCategory(categoryId: string, limit?: number): Product[];
  /** Featured products, newest first. */
  listFeatured(limit: number): Product[];
  /** Most recently published first. */
  listNewest(limit: number): Product[];
  /** Products whose list price is above the price, biggest percentage saving first. */
  listDeals(limit: number): Product[];
  /** Reviewed products, highest average rating first (ties: more reviews first). */
  listTopRated(limit: number): Product[];
  /** Every product's slug and `updated_at`, ordered by slug (sitemaps). */
  listSlugsWithUpdatedAt(): { slug: string; updatedAt: string }[];
}

/**
 * Publication lookup (R-CART-1), kept off `ProductRepository` so existing
 * fakes of the core contract stay valid. "Published at `nowIso`" means
 * `published_at <> '' AND published_at <= nowIso` (ISO 8601 UTC string
 * compare, bound parameters). The empty string is the column's pre-trigger
 * default and is treated like a missing date (not published).
 */
export interface ProductPublicationLookup {
  /**
   * The subset of `ids` that exist and are published at `nowIso`. Unknown
   * and unpublished ids are both simply absent (indistinguishable).
   */
  filterPublishedIds(ids: readonly string[], nowIso: string): ReadonlySet<string>;
}

/** Largest |epoch ms| a JS Date accepts. */
const MAX_DATE_MS = 8.64e15;

/**
 * The publication predicate in JS form, for rows already loaded: exactly the
 * SQL rule `published_at <> '' AND published_at <= nowIso` (ISO 8601 UTC
 * strings compared as text). Non-strings are unpublished.
 */
export function isPublishedAtIso(publishedAt: unknown, nowIso: string): boolean {
  return typeof publishedAt === "string" && publishedAt !== "" && publishedAt <= nowIso;
}

/**
 * Shared publication-aware single-product read (consistency av) for the PDP
 * and `/compare`. Kept off `CatalogProductRepository` so existing fakes of
 * that contract stay valid.
 */
export interface PublishedProductReader {
  /**
   * `getDetailBySlug(slug)` when the product is published at `now` (epoch
   * ms; {@link isPublishedAtIso}), else `null`. Unknown and unpublished slugs
   * are indistinguishable. A non-finite or out-of-range `now` publishes
   * nothing (`null`, no SQL).
   */
  getPublishedDetailBySlug(slug: string, now: number): ProductDetail | null;
}

/**
 * Sitemap lastmod source for products (CONS-B4 bm). Kept off
 * `CatalogProductRepository` so existing fakes of that contract stay valid.
 */
export interface PublishedSlugLister {
  /**
   * Slug and `updated_at` of every product published at `nowIso` (the
   * `filterPublishedIds` / {@link isPublishedAtIso} rule:
   * `published_at <> '' AND published_at <= nowIso`), ordered by slug. A
   * non-string or empty `nowIso` publishes nothing (`[]`, no SQL).
   */
  listPublishedSlugsWithUpdatedAt(nowIso: string): { slug: string; updatedAt: string }[];
}

/**
 * Upper bound for any `limit` argument. A `limit` that is not a positive
 * safe integer returns `[]`; larger values are capped to this.
 */
export const MAX_LIST_LIMIT = 200;

/** Shape of a joined `products` row as selected below. Internal: never returned. */
interface ProductRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  price_cents: number;
  currency: string;
  image_url: string;
  stock: number;
  list_price_cents: number | null;
  sku: string | null;
  rating_count: number;
  rating_sum: number;
  is_featured: number;
  /** ISO publish time; '' when never published (D-T170-1: summaries carry it so cards can show "New"). */
  published_at: string;
  brand_name: string | null;
  brand_slug: string | null;
  category_name: string | null;
  category_slug: string | null;
}

interface DetailRow extends ProductRow {
  bullets: string;
  specs: string;
  images: string;
  updated_at: string;
  brand_id: string | null;
  brand_description: string | null;
  category_id: string | null;
  category_description: string | null;
  category_parent_id: string | null;
  category_sort_order: number | null;
  category_image_url: string | null;
}

const SUMMARY_COLUMNS = `p.id, p.slug, p.name, p.description, p.price_cents, p.currency, p.image_url, p.stock,
  p.list_price_cents, p.sku, p.rating_count, p.rating_sum, p.is_featured, p.published_at,
  b.name AS brand_name, b.slug AS brand_slug, c.name AS category_name, c.slug AS category_slug`;

const FROM_JOINED = `products AS p
  LEFT JOIN brands AS b ON b.id = p.brand_id
  LEFT JOIN categories AS c ON c.id = p.category_id`;

const SELECT_SUMMARY = `SELECT ${SUMMARY_COLUMNS} FROM ${FROM_JOINED}`;

/**
 * Recomputes `products.rating_count` / `rating_sum` for one product from its
 * PUBLISHED reviews. The review triggers already keep these in step; this is
 * a safety net (call it inside the reviews service's transaction if needed).
 * Returns the new values, or `null` when the product does not exist.
 */
export function recomputeProductRating(
  db: Database,
  productId: string,
): { ratingCount: number; ratingSum: number } | null {
  const row = db
    .query<{ rating_count: number; rating_sum: number }, [string]>(
      `UPDATE products
          SET rating_count = (SELECT COUNT(*) FROM reviews WHERE product_id = products.id AND status = 'published'),
              rating_sum = (SELECT coalesce(SUM(rating), 0) FROM reviews WHERE product_id = products.id AND status = 'published')
        WHERE id = ?
    RETURNING rating_count, rating_sum`,
    )
    .get(productId);
  return row === null ? null : { ratingCount: row.rating_count, ratingSum: row.rating_sum };
}

/** Mean of `sum / count` rounded to one decimal; 0 when count is 0. */
export function ratingAverage(sum: number, count: number): number {
  if (!(count > 0)) return 0;
  return Math.round((sum / count) * 10) / 10;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    currency: row.currency,
    imageUrl: row.image_url,
    stock: row.stock,
    ...(row.list_price_cents !== null ? { listPriceCents: row.list_price_cents } : {}),
    ...(row.rating_count > 0
      ? { ratingCount: row.rating_count, ratingAvg: ratingAverage(row.rating_sum, row.rating_count) }
      : {}),
    ...(row.brand_name !== null && row.brand_slug !== null
      ? { brandName: row.brand_name, brandSlug: row.brand_slug }
      : {}),
    ...(row.category_name !== null && row.category_slug !== null
      ? { categoryName: row.category_name, categorySlug: row.category_slug }
      : {}),
    ...(row.is_featured === 1 ? { isFeatured: true } : {}),
    ...(row.sku !== null && row.sku !== "" ? { sku: row.sku } : {}),
    // D-T170-1: sparse like the fields above; rails hydrated through `getManyByIds` need it for "New".
    ...(typeof row.published_at === "string" && row.published_at !== "" ? { publishedAt: row.published_at } : {}),
  };
}

function parseJsonArray(text: string): unknown[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses the `bullets` column: non-empty strings only; malformed JSON → `[]`. */
export function parseBullets(text: string): string[] {
  return parseJsonArray(text).filter((v): v is string => typeof v === "string" && v.trim() !== "");
}

/** Parses the `specs` column: `{label, value}` string pairs only; malformed → `[]`. */
export function parseSpecs(text: string): ProductSpec[] {
  const specs: ProductSpec[] = [];
  for (const entry of parseJsonArray(text)) {
    if (isRecord(entry) && typeof entry.label === "string" && typeof entry.value === "string") {
      specs.push({ label: entry.label, value: entry.value });
    }
  }
  return specs;
}

/** Parses the `images` column: `{url, alt}` with a site-relative url only; malformed → `[]`. */
export function parseImages(text: string): ProductImage[] {
  const images: ProductImage[] = [];
  for (const entry of parseJsonArray(text)) {
    if (
      isRecord(entry) &&
      typeof entry.url === "string" &&
      entry.url.startsWith("/") &&
      !entry.url.startsWith("//")
    ) {
      images.push({ url: entry.url, alt: typeof entry.alt === "string" ? entry.alt : "" });
    }
  }
  return images;
}

function normaliseLimit(limit: number | undefined): number | null {
  if (limit === undefined) return MAX_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) return null;
  return Math.min(limit, MAX_LIST_LIMIT);
}

function toDetail(row: DetailRow): ProductDetail {
  const summary = toProduct(row);
  const brand: Brand | null =
    row.brand_id !== null && row.brand_name !== null && row.brand_slug !== null
      ? { id: row.brand_id, slug: row.brand_slug, name: row.brand_name, description: row.brand_description ?? "" }
      : null;
  const category: Category | null =
    row.category_id !== null && row.category_name !== null && row.category_slug !== null
      ? {
          id: row.category_id,
          slug: row.category_slug,
          name: row.category_name,
          description: row.category_description ?? "",
          parentId: row.category_parent_id,
          sortOrder: row.category_sort_order ?? 0,
          imageUrl: row.category_image_url,
        }
      : null;
  const gallery = parseImages(row.images);
  return {
    ...summary,
    bullets: parseBullets(row.bullets),
    specs: parseSpecs(row.specs),
    images: gallery.length > 0 ? gallery : [{ url: row.image_url, alt: row.name }],
    listPriceCents: row.list_price_cents,
    ratingCount: row.rating_count,
    ratingAvg: ratingAverage(row.rating_sum, row.rating_count),
    brand,
    category,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteProductRepository
  implements CatalogProductRepository, ProductPublicationLookup, PublishedProductReader, PublishedSlugLister
{
  constructor(private readonly db: Database) {}

  list(): Product[] {
    return this.db
      .query<ProductRow, []>(`${SELECT_SUMMARY} ORDER BY p.name, p.id`)
      .all()
      .map(toProduct);
  }

  getBySlug(slug: string): Product | null {
    const row = this.db.query<ProductRow, [string]>(`${SELECT_SUMMARY} WHERE p.slug = ?`).get(slug);
    return row === null ? null : toProduct(row);
  }

  getById(id: string): Product | null {
    const row = this.db.query<ProductRow, [string]>(`${SELECT_SUMMARY} WHERE p.id = ?`).get(id);
    return row === null ? null : toProduct(row);
  }

  getManyByIds(ids: readonly string[]): Product[] {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    // One bound JSON parameter instead of N placeholders: no variable limit,
    // no SQL built from input.
    const rows = this.db
      .query<ProductRow, [string]>(
        `${SELECT_SUMMARY} WHERE p.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(unique));
    const byId = new Map(rows.map((row) => [row.id, toProduct(row)]));
    const result: Product[] = [];
    for (const id of unique) {
      const product = byId.get(id);
      if (product !== undefined) result.push(product);
    }
    return result;
  }

  filterPublishedIds(ids: readonly string[], nowIso: string): ReadonlySet<string> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Set();
    const rows = this.db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM products
          WHERE id IN (SELECT value FROM json_each(?)) AND published_at <> '' AND published_at <= ?`,
      )
      .all(JSON.stringify(unique), nowIso);
    return new Set(rows.map((row) => row.id));
  }

  getDetailBySlug(slug: string): ProductDetail | null {
    const row = this.db
      .query<DetailRow, [string]>(
        `SELECT ${SUMMARY_COLUMNS},
                p.bullets, p.specs, p.images, p.updated_at,
                b.id AS brand_id, b.description AS brand_description,
                c.id AS category_id, c.description AS category_description,
                c.parent_id AS category_parent_id, c.sort_order AS category_sort_order,
                c.image_url AS category_image_url
           FROM ${FROM_JOINED}
          WHERE p.slug = ?`,
      )
      .get(slug);
    return row === null ? null : toDetail(row);
  }

  getPublishedDetailBySlug(slug: string, now: number): ProductDetail | null {
    if (!Number.isFinite(now) || Math.abs(now) > MAX_DATE_MS) return null;
    // Through getDetailBySlug (one SELECT) so the detail shape stays single-sourced.
    const detail = this.getDetailBySlug(slug);
    if (detail === null) return null;
    return isPublishedAtIso(detail.publishedAt, new Date(now).toISOString()) ? detail : null;
  }

  listByCategory(categoryId: string, limit?: number): Product[] {
    const n = normaliseLimit(limit);
    if (n === null) return [];
    return this.db
      .query<ProductRow, [string, string, number]>(
        `${SELECT_SUMMARY}
          WHERE p.category_id = ?1
             OR p.category_id IN (SELECT id FROM categories WHERE parent_id = ?2)
          ORDER BY p.name, p.id
          LIMIT ?3`,
      )
      .all(categoryId, categoryId, n)
      .map(toProduct);
  }

  listFeatured(limit: number): Product[] {
    return this.listWhere("p.is_featured = 1", "p.published_at DESC, p.name, p.id", limit);
  }

  listNewest(limit: number): Product[] {
    return this.listWhere("1 = 1", "p.published_at DESC, p.name, p.id", limit);
  }

  listDeals(limit: number): Product[] {
    return this.listWhere(
      "p.list_price_cents IS NOT NULL AND p.list_price_cents > p.price_cents",
      "CAST(p.list_price_cents - p.price_cents AS REAL) / p.list_price_cents DESC, p.name, p.id",
      limit,
    );
  }

  listTopRated(limit: number): Product[] {
    return this.listWhere(
      "p.rating_count > 0",
      "CAST(p.rating_sum AS REAL) / p.rating_count DESC, p.rating_count DESC, p.name, p.id",
      limit,
    );
  }

  listSlugsWithUpdatedAt(): { slug: string; updatedAt: string }[] {
    return this.db
      .query<{ slug: string; updated_at: string }, []>("SELECT slug, updated_at FROM products ORDER BY slug")
      .all()
      .map((row) => ({ slug: row.slug, updatedAt: row.updated_at }));
  }

  listPublishedSlugsWithUpdatedAt(nowIso: string): { slug: string; updatedAt: string }[] {
    if (typeof nowIso !== "string" || nowIso === "") return [];
    return this.db
      .query<{ slug: string; updated_at: string }, [string]>(
        "SELECT slug, updated_at FROM products WHERE published_at <> '' AND published_at <= ? ORDER BY slug",
      )
      .all(nowIso)
      .map((row) => ({ slug: row.slug, updatedAt: row.updated_at }));
  }

  /** `where` and `orderBy` are compile-time constants from this class, never input. */
  private listWhere(where: string, orderBy: string, limit: number): Product[] {
    const n = normaliseLimit(limit);
    if (n === null) return [];
    return this.db
      .query<ProductRow, [number]>(`${SELECT_SUMMARY} WHERE ${where} ORDER BY ${orderBy} LIMIT ?`)
      .all(n)
      .map(toProduct);
  }

  decrementStock(productId: string, quantity: number): Result<Product> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      return fail("INVALID_QUANTITY", "Quantity must be a positive integer", {
        quantity,
      });
    }
    const updated = this.db
      .query<{ id: string }, [number, string, number]>(
        `UPDATE products
            SET stock = stock - ?1,
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE id = ?2 AND stock >= ?3
      RETURNING id`,
      )
      .get(quantity, productId, quantity);
    if (updated !== null) {
      // Same connection, so this read sees the write (and any open transaction).
      const product = this.getById(updated.id);
      if (product !== null) return ok(product);
    }

    const current = this.getById(productId);
    if (current === null) {
      return fail("PRODUCT_NOT_FOUND", "Product not found", { productId });
    }
    if (current.stock === 0) {
      return fail("OUT_OF_STOCK", `${current.name} is out of stock`, {
        productId,
        available: 0,
        requested: quantity,
      });
    }
    return fail(
      "INSUFFICIENT_STOCK",
      `Only ${current.stock} of ${current.name} available`,
      { productId, available: current.stock, requested: quantity },
    );
  }
}
