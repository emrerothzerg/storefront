import type { Database } from "bun:sqlite";
import type { Category, CategoryWithCount, Product } from "@/lib/types";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import { getDatabase } from "@/server/db/client";
import { SqliteBrandRepository } from "./brand-repository";
import { SqliteCategoryRepository } from "./category-repository";
import { SqliteProductRepository } from "./product-repository";
import { SqliteListingRepository, type RepoFilters, type RepoSort } from "./listing-repository";

/**
 * Listing service (T33): browse with filters, facets, sort and pagination;
 * category tree and breadcrumbs; collections (deals, best sellers, new
 * arrivals, top rated); Best Sellers Rank. Server-only, synchronous.
 * See the "Listing service (T33)" section of README.md for the rules.
 */

export const LISTING_SORTS = ["relevance", "featured", "price_asc", "price_desc", "rating", "newest", "best_selling"] as const;
export type ListingSort = (typeof LISTING_SORTS)[number];

export interface ListingFilters {
  readonly categorySlug?: string;
  readonly brandSlugs?: readonly string[];
  readonly minPriceCents?: number;
  readonly maxPriceCents?: number;
  readonly minRating?: 1 | 2 | 3 | 4;
  readonly inStockOnly?: boolean;
  readonly dealsOnly?: boolean;
  /** From the search service, rank order; `relevance` sort keeps this order. */
  readonly ids?: readonly string[];
}

export interface ListingQuery extends ListingFilters {
  readonly sort?: ListingSort | string;
  readonly page?: number;
  readonly pageSize?: number;
  /** Epoch milliseconds; defaults to `Date.now()`. */
  readonly now?: number;
}

/**
 * A listing summary. Items returned by `list()` (T167 (bx)) and by the
 * collection helpers (`deals`, `bestSellers`, `newArrivals`, `topRated`;
 * CLEANUP-P3 (ch)) carry `publishedAt` (ISO) so cards can derive the "New"
 * badge. It is omitted only when the row has no publication date.
 */
export type ProductListItem = Product & { readonly rank?: number };

export interface FacetBucket<T = string> {
  readonly value: T;
  readonly label: string;
  readonly count: number;
  readonly selected: boolean;
}

export interface FacetCounts {
  /** Slug; children of the current department, or departments at root. */
  readonly categories: readonly FacetBucket[];
  /** Slug. */
  readonly brands: readonly FacetBucket[];
  /** Buckets: <2500, 2500–4999, 5000–9999, 10000–24999, >=25000. */
  readonly price: readonly FacetBucket<{ minCents: number; maxCents: number | null }>[];
  /** "N stars & up". */
  readonly rating: readonly FacetBucket<1 | 2 | 3 | 4>[];
  readonly inStock: number;
  /**
   * Matching products on deal (`list_price_cents > price_cents`) under every
   * current filter (T91; required since CONS-B5). Always set by `list()`.
   */
  readonly deals: number;
}

export interface ListingResult {
  readonly items: readonly ProductListItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly sort: ListingSort;
  readonly facets: FacetCounts;
  /** Names of filters dropped as invalid. */
  readonly ignored: readonly string[];
}

export interface ListingService {
  /** NOT_FOUND for an unknown categorySlug; invalid filters are dropped and named in `ignored`. */
  list(query: ListingQuery): Result<ListingResult, AppError>;
  /** Departments with children and published product counts at `now` (epoch ms; default / invalid → the clock). */
  categoryTree(now?: number): readonly (Category & { readonly children: readonly CategoryWithCount[] })[];
  /** Department → category; `[]` for an unknown slug. */
  breadcrumb(categorySlug: string): readonly Category[];
  deals(limit?: number, now?: number): readonly ProductListItem[];
  /** Units from order_items of orders with status='paid' AND fulfillment_status<>'cancelled'. */
  bestSellers(limit?: number, opts?: { categoryId?: string; now?: number }): readonly ProductListItem[];
  newArrivals(limit?: number, now?: number): readonly ProductListItem[];
  /** rating_count >= TOP_RATED_MIN_REVIEWS. */
  topRated(limit?: number, now?: number): readonly ProductListItem[];
  /** null when the product has no sales (or is unknown/unpublished/uncategorised). */
  rankInCategory(
    productId: string,
    now?: number,
  ): { readonly rank: number; readonly categoryName: string; readonly categorySlug: string } | null;
}

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 48;
export const TOP_RATED_MIN_REVIEWS = 3;
export const DEFAULT_COLLECTION_LIMIT = 12;
export const MAX_COLLECTION_LIMIT = 48;
/** At most this many distinct brand slugs are applied; the rest are ignored. */
export const MAX_BRAND_FILTERS = 50;

export const PRICE_BUCKETS: readonly { readonly minCents: number; readonly maxCents: number | null; readonly label: string }[] = [
  { minCents: 0, maxCents: 2499, label: "Under $25" },
  { minCents: 2500, maxCents: 4999, label: "$25 to $49.99" },
  { minCents: 5000, maxCents: 9999, label: "$50 to $99.99" },
  { minCents: 10000, maxCents: 24999, label: "$100 to $249.99" },
  { minCents: 25000, maxCents: null, label: "$250 & above" },
];

const RATING_THRESHOLDS = [4, 3, 2, 1] as const;
type RatingThreshold = (typeof RATING_THRESHOLDS)[number];

const SORT_SET: ReadonlySet<string> = new Set(LISTING_SORTS);

function isListingSort(value: unknown): value is ListingSort {
  return typeof value === "string" && SORT_SET.has(value);
}

function isRatingThreshold(value: unknown): value is RatingThreshold {
  return value === 1 || value === 2 || value === 3 || value === 4;
}

function isPriceCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const MAX_DATE_MS = 8.64e15;

/** ISO cut-off for `published_at <= now`; invalid `now` falls back to the clock. */
function nowIso(now: number | undefined): string {
  const ms = typeof now === "number" && Number.isFinite(now) && Math.abs(now) <= MAX_DATE_MS ? now : Date.now();
  return new Date(ms).toISOString();
}

function clampPageSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(value)));
}

function normalisePage(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function collectionLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_COLLECTION_LIMIT;
  return Math.min(MAX_COLLECTION_LIMIT, Math.max(1, Math.trunc(value)));
}

class SqliteListingService implements ListingService {
  private readonly listing: SqliteListingRepository;
  private readonly products: SqliteProductRepository;
  private readonly categories: SqliteCategoryRepository;
  private readonly brands: SqliteBrandRepository;

  constructor(db: Database) {
    this.listing = new SqliteListingRepository(db);
    this.products = new SqliteProductRepository(db);
    this.categories = new SqliteCategoryRepository(db);
    this.brands = new SqliteBrandRepository(db);
  }

  list(query: ListingQuery): Result<ListingResult, AppError> {
    const ignored: string[] = [];
    const iso = nowIso(query.now);

    // Category
    let category: Category | null = null;
    const slug: unknown = query.categorySlug;
    if (typeof slug === "string" && slug !== "") {
      category = this.categories.getBySlug(slug);
      if (category === null) return fail("NOT_FOUND", "Category not found", { categorySlug: slug });
    } else if (slug !== undefined && slug !== "") {
      ignored.push("categorySlug");
    }

    // Brands: unknown, malformed or excess slugs are dropped.
    let brandIds: string[] | undefined;
    const selectedBrandSlugs = new Set<string>();
    const rawBrands: unknown = query.brandSlugs;
    if (rawBrands !== undefined) {
      let dropped = false;
      if (Array.isArray(rawBrands)) {
        const ids: string[] = [];
        for (const value of new Set<unknown>(rawBrands)) {
          if (typeof value !== "string" || selectedBrandSlugs.size >= MAX_BRAND_FILTERS) {
            dropped = true;
            continue;
          }
          const brand = this.brands.getBySlug(value);
          if (brand === null) {
            dropped = true;
            continue;
          }
          selectedBrandSlugs.add(brand.slug);
          ids.push(brand.id);
        }
        if (ids.length > 0) brandIds = ids;
      } else {
        dropped = true;
      }
      if (dropped) ignored.push("brandSlugs");
    }

    // Price: each bound must be a non-negative safe integer; min > max drops both.
    let minPriceCents: number | undefined;
    let maxPriceCents: number | undefined;
    if (query.minPriceCents !== undefined) {
      if (isPriceCents(query.minPriceCents)) minPriceCents = query.minPriceCents;
      else ignored.push("minPriceCents");
    }
    if (query.maxPriceCents !== undefined) {
      if (isPriceCents(query.maxPriceCents)) maxPriceCents = query.maxPriceCents;
      else ignored.push("maxPriceCents");
    }
    if (minPriceCents !== undefined && maxPriceCents !== undefined && minPriceCents > maxPriceCents) {
      minPriceCents = undefined;
      maxPriceCents = undefined;
      ignored.push("minPriceCents", "maxPriceCents");
    }

    let minRating: RatingThreshold | undefined;
    if (query.minRating !== undefined) {
      if (isRatingThreshold(query.minRating)) minRating = query.minRating;
      else ignored.push("minRating");
    }

    let ids: string[] | undefined;
    const rawIds: unknown = query.ids;
    if (rawIds !== undefined) {
      if (Array.isArray(rawIds)) {
        ids = rawIds.filter((v): v is string => typeof v === "string");
        if (ids.length !== rawIds.length) ignored.push("ids");
      } else {
        ignored.push("ids");
      }
    }

    const filters: RepoFilters = {
      nowIso: iso,
      ...(category !== null ? { categoryId: category.id } : {}),
      ...(brandIds !== undefined ? { brandIds } : {}),
      ...(minPriceCents !== undefined ? { minPriceCents } : {}),
      ...(maxPriceCents !== undefined ? { maxPriceCents } : {}),
      ...(minRating !== undefined ? { minRating } : {}),
      ...(query.inStockOnly === true ? { inStockOnly: true } : {}),
      ...(query.dealsOnly === true ? { dealsOnly: true } : {}),
      ...(ids !== undefined ? { ids } : {}),
    };

    const sort: ListingSort =
      query.sort === undefined ? (ids !== undefined ? "relevance" : "featured") : isListingSort(query.sort) ? query.sort : "featured";
    const pageSize = clampPageSize(query.pageSize);
    const page = normalisePage(query.page);
    const total = this.listing.count(filters);
    const pageCount = Math.ceil(total / pageSize);

    let items: ProductListItem[] = [];
    if ((page - 1) * pageSize < total) {
      const pageIds = this.listing.findIds(filters, sort, pageSize, (page - 1) * pageSize);
      const rankOf = new Map<string, number>();
      if (ids !== undefined) ids.forEach((id, index) => { if (!rankOf.has(id)) rankOf.set(id, index + 1); });
      // (bx) T167: listing summaries carry `publishedAt` so cards can show "New".
      items = this.withPublishedAt(pageIds).map((product) => {
        const rank = rankOf.get(product.id);
        return rank === undefined ? product : { ...product, rank };
      });
    }

    return ok({
      items,
      total,
      page,
      pageSize,
      pageCount,
      sort,
      facets: this.facets(filters, category, selectedBrandSlugs),
      ignored,
    });
  }

  private facets(filters: RepoFilters, category: Category | null, selectedBrands: ReadonlySet<string>): FacetCounts {
    // Categories: departments at root, else the current department's children.
    const perCategory = this.listing.categoryCounts(filters);
    const departmentId = category === null ? null : (category.parentId ?? category.id);
    let categories: FacetBucket[];
    if (departmentId === null) {
      categories = this.categories.listDepartments().map((dept) => {
        const children = this.categories.listChildren(dept.id);
        const count = children.reduce((sum, c) => sum + (perCategory.get(c.id) ?? 0), perCategory.get(dept.id) ?? 0);
        return { value: dept.slug, label: dept.name, count, selected: false };
      });
    } else {
      categories = this.categories.listChildren(departmentId).map((child) => ({
        value: child.slug,
        label: child.name,
        count: perCategory.get(child.id) ?? 0,
        selected: category !== null && category.id === child.id,
      }));
    }

    const brands: FacetBucket[] = this.listing.brandCounts(filters).map((b) => ({
      value: b.slug,
      label: b.name,
      count: b.count,
      selected: selectedBrands.has(b.slug),
    }));
    // A selected brand with no matches still shows (count 0) so it can be cleared.
    for (const slug of selectedBrands) {
      if (!brands.some((b) => b.value === slug)) {
        const brand = this.brands.getBySlug(slug);
        if (brand !== null) brands.push({ value: brand.slug, label: brand.name, count: 0, selected: true });
      }
    }

    const priceCounts = this.listing.priceCounts(filters, PRICE_BUCKETS);
    const price = PRICE_BUCKETS.map((bucket, index) => ({
      value: { minCents: bucket.minCents, maxCents: bucket.maxCents },
      label: bucket.label,
      count: priceCounts[index] ?? 0,
      selected:
        (filters.minPriceCents ?? 0) === bucket.minCents &&
        (filters.maxPriceCents ?? null) === bucket.maxCents &&
        (filters.minPriceCents !== undefined || filters.maxPriceCents !== undefined),
    })).filter((b) => b.count > 0 || b.selected);

    const ratingCounts = this.listing.ratingCounts(filters);
    const rating = RATING_THRESHOLDS.map((n) => ({
      value: n,
      label: `${n} ${n === 1 ? "star" : "stars"} & up`,
      count: ratingCounts[n - 1] ?? 0,
      selected: filters.minRating === n,
    })).filter((b) => b.count > 0 || b.selected);

    return {
      categories: categories.filter((b) => b.count > 0 || b.selected),
      brands,
      price,
      rating,
      inStock: this.listing.inStockCount(filters),
      // Same filter set as the other facets; deals is not a disjunctive dimension
      // (it is a plain AND filter), so with `dealsOnly` applied this equals `total`.
      deals: this.listing.count({ ...filters, dealsOnly: true }, null),
    };
  }

  categoryTree(now?: number): readonly (Category & { readonly children: readonly CategoryWithCount[] })[] {
    const counts = this.listing.publishedCountsByCategory(nowIso(now));
    return this.categories.listDepartments().map((dept) => ({
      ...dept,
      children: this.categories
        .listChildren(dept.id)
        .map((child) => ({ ...child, productCount: counts.get(child.id) ?? 0 })),
    }));
  }

  breadcrumb(categorySlug: string): readonly Category[] {
    if (typeof categorySlug !== "string" || categorySlug === "") return [];
    const category = this.categories.getBySlug(categorySlug);
    return category === null ? [] : this.categories.getPath(category.id);
  }

  deals(limit?: number, now?: number): readonly ProductListItem[] {
    return this.collection({ nowIso: nowIso(now), dealsOnly: true }, "deal_saving", limit);
  }

  bestSellers(limit?: number, opts: { categoryId?: string; now?: number } = {}): readonly ProductListItem[] {
    const filters: RepoFilters = {
      nowIso: nowIso(opts.now),
      soldOnly: true,
      ...(typeof opts.categoryId === "string" ? { categoryId: opts.categoryId } : {}),
    };
    return this.collection(filters, "best_selling", limit).map((product, index) => ({ ...product, rank: index + 1 }));
  }

  newArrivals(limit?: number, now?: number): readonly ProductListItem[] {
    return this.collection({ nowIso: nowIso(now) }, "newest", limit);
  }

  topRated(limit?: number, now?: number): readonly ProductListItem[] {
    return this.collection({ nowIso: nowIso(now), minReviewCount: TOP_RATED_MIN_REVIEWS }, "rating", limit);
  }

  rankInCategory(
    productId: string,
    now?: number,
  ): { readonly rank: number; readonly categoryName: string; readonly categorySlug: string } | null {
    if (typeof productId !== "string" || productId === "") return null;
    const found = this.listing.rankInCategory(productId, nowIso(now));
    if (found === null) return null;
    const category = this.categories.getById(found.categoryId);
    return category === null ? null : { rank: found.rank, categoryName: category.name, categorySlug: category.slug };
  }

  private collection(filters: RepoFilters, sort: RepoSort, limit: number | undefined): Product[] {
    // (ch) CLEANUP-P3: collections carry `publishedAt` like `list()` items.
    return this.withPublishedAt(this.listing.findIds(filters, sort, collectionLimit(limit), 0));
  }

  /** Products for `ids` (repository order) with `publishedAt` attached when the row has one. */
  private withPublishedAt(ids: readonly string[]): Product[] {
    const publishedAt = this.listing.publishedAtByIds(ids);
    return this.products.getManyByIds(ids).map((product) => {
      const published = publishedAt.get(product.id);
      return published === undefined ? product : { ...product, publishedAt: published };
    });
  }
}

export function createListingService(deps: { db: Database }): ListingService {
  return new SqliteListingService(deps.db);
}

const globalForListing = globalThis as typeof globalThis & {
  __storefrontListingService?: { db: Database; service: ListingService };
};

/** App-wide singleton over `getDatabase()`; rebuilt if the database handle changes. */
export function getListingService(): ListingService {
  const db = getDatabase();
  const cached = globalForListing.__storefrontListingService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createListingService({ db });
  globalForListing.__storefrontListingService = { db, service };
  return service;
}
