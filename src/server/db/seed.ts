import type { Database } from "bun:sqlite";
import type { Product, ProductImage, ProductSpec } from "@/lib/types";
import { withTransaction } from "./client";
import { GALLERY_VIEW_LABELS, GALLERY_VIEWS, renderPlaceholderSvg, renderVariantSvg, type GalleryView } from "./seed-images";
import { SEED_COUPONS, SEED_SHIPPING_METHODS } from "./seed-data/commerce";
import { buildSeedQuestions, buildSeedReviews, type SeedReviewProduct } from "./seed-data/community";
import { SEED_PRODUCT_INPUT, type SeedProductInput } from "./seed-data/products";
import { brandId, categoryId, SEED_BRANDS, SEED_DEPARTMENTS } from "./seed-data/taxonomy";

/**
 * Demo data. Ids are stable (`prod_<slug>`, `cat_<slug>`, `brand_<slug>`,
 * `rev_seed_*`, `q_seed_*`, `a_seed_*`) so carts/orders created against one
 * seeded DB stay meaningful after a re-seed, and every seeder is an
 * idempotent upsert: running it again never duplicates rows.
 *
 * - `seedProducts(db)`: taxonomy + the 15 legacy MVP products (what the MVP
 *   tests use; `SEED_PRODUCTS` describes them).
 * - `seedDatabase(db)`: everything (all `SEED_CATALOG` products, reviews,
 *   Q&A, coupons, shipping methods). Used by `bun run seed`.
 *
 * Counts are not hard-coded anywhere: derive them from `SEED_CATALOG_STATS`,
 * `SEED_PUBLISHED_CATALOG` and `isSeedPublished` (two catalogue products are
 * future-dated, i.e. unpublished, so "all" and "published" differ).
 */

export { renderPlaceholderSvg, renderVariantSvg } from "./seed-images";
export { SEED_COUPONS, SEED_SHIPPING_METHODS } from "./seed-data/commerce";
export { SEED_BRANDS, SEED_DEPARTMENTS } from "./seed-data/taxonomy";

/**
 * A seed product as `ProductRepository` returns it right after
 * `seedProducts`/`seedCatalogProducts` (sparse summary fields included; no
 * rating fields because those come from reviews), plus its image colour.
 */
export interface SeedProduct extends Product {
  /** Placeholder image background colour (hex). */
  readonly color: string;
}

/** Everything the seed knows about one product. */
export interface SeedCatalogEntry {
  readonly product: SeedProduct;
  /** One of the 15 MVP products (stable test fixtures). */
  readonly legacy: boolean;
  readonly brandId: string;
  readonly categoryId: string;
  readonly departmentSlug: string;
  readonly bullets: readonly string[];
  readonly specs: readonly ProductSpec[];
  /** Gallery, primary image first (2-4 images). */
  readonly images: readonly ProductImage[];
  /** Days before the seed run that the product was published (negative = future, unpublished). */
  readonly daysAgo: number;
}

export const SEED_CURRENCY = "USD";

/** Primary image of a legacy product: `/images/products/<slug>.svg`. */
export function productImageUrl(slug: string): string {
  return `/images/products/${slug}.svg`;
}

/**
 * Gallery image under `/images/products/gallery/`: `<slug>.svg` is the primary
 * image of a non-legacy product, `<slug>--<view>.svg` a gallery view.
 * (Kept out of the top-level folder, which holds only the legacy primaries.)
 */
export function galleryImageUrl(slug: string, view?: GalleryView): string {
  return `/images/products/gallery/${slug}${view === undefined ? "" : `--${view}`}.svg`;
}

const CATEGORY_LOOKUP = new Map(
  SEED_DEPARTMENTS.flatMap((department) =>
    department.categories.map((category) => [category.slug, { category, department }] as const),
  ),
);
const BRAND_LOOKUP = new Map(SEED_BRANDS.map((brand) => [brand.slug, brand] as const));

function buildEntry(input: SeedProductInput, index: number): SeedCatalogEntry {
  const brand = BRAND_LOOKUP.get(input.brand);
  const placement = CATEGORY_LOOKUP.get(input.category);
  if (brand === undefined) throw new Error(`seed: unknown brand ${input.brand} for ${input.slug}`);
  if (placement === undefined) throw new Error(`seed: unknown category ${input.category} for ${input.slug}`);
  const legacy = input.legacy === true;
  const imageUrl = legacy ? productImageUrl(input.slug) : galleryImageUrl(input.slug);
  const views = GALLERY_VIEWS.slice(0, 1 + (index % GALLERY_VIEWS.length));
  const product: SeedProduct = {
    id: `prod_${input.slug}`,
    slug: input.slug,
    name: input.name,
    description: input.description,
    priceCents: input.priceCents,
    currency: SEED_CURRENCY,
    imageUrl,
    stock: input.stock,
    ...(input.listPriceCents !== undefined ? { listPriceCents: input.listPriceCents } : {}),
    brandName: brand.name,
    brandSlug: brand.slug,
    categoryName: placement.category.name,
    categorySlug: placement.category.slug,
    ...(input.featured === true ? { isFeatured: true } : {}),
    sku: `${brand.skuPrefix}-${1001 + index}`,
    color: input.color,
  };
  return {
    product,
    legacy,
    brandId: brandId(brand.slug),
    categoryId: categoryId(placement.category.slug),
    departmentSlug: placement.department.slug,
    bullets: input.bullets,
    specs: input.specs.map(([label, value]) => ({ label, value })),
    images: [
      { url: imageUrl, alt: input.name },
      ...views.map((view) => ({ url: galleryImageUrl(input.slug, view), alt: `${input.name}, ${GALLERY_VIEW_LABELS[view].toLowerCase()}` })),
    ],
    daysAgo: input.daysAgo,
  };
}

/** Every seed product with its rich data, in seed order (legacy 15 first). */
export const SEED_CATALOG: readonly SeedCatalogEntry[] = SEED_PRODUCT_INPUT.map(buildEntry);

/** The 15 legacy MVP products (what `seedProducts` inserts). */
export const SEED_PRODUCTS: readonly SeedProduct[] = SEED_CATALOG.filter((e) => e.legacy).map((e) => e.product);

/** Every seed product (what `seedCatalogProducts` / `seedDatabase` insert), incl. the unpublished ones. */
export const SEED_CATALOG_PRODUCTS: readonly SeedProduct[] = SEED_CATALOG.map((e) => e.product);

/**
 * Whether a seed product is published when seeded with any `now`: its
 * `published_at` is `daysAgo` days before `now`, so it is published
 * (`published_at <= now`) exactly when `daysAgo >= 0`. Negative `daysAgo`
 * entries are future-dated ("coming soon") and hidden from storefront reads.
 */
export function isSeedPublished(entry: Pick<SeedCatalogEntry, "daysAgo">): boolean {
  return entry.daysAgo >= 0;
}

/** Seed products visible on the storefront right after seeding (published). */
export const SEED_PUBLISHED_CATALOG: readonly SeedCatalogEntry[] = SEED_CATALOG.filter(isSeedPublished);

/** Slugs of the future-dated (unpublished) seed products. */
export const SEED_UNPUBLISHED_SLUGS: readonly string[] = SEED_CATALOG.filter((e) => !isSeedPublished(e)).map(
  (e) => e.product.slug,
);

/** Days counted as "new" by `SEED_CATALOG_STATS.newArrivals` (published in the last two weeks). */
export const SEED_NEW_ARRIVAL_DAYS = 14;

/** Stock at or below this (and above 0) counts as low stock in `SEED_CATALOG_STATS`. */
export const SEED_LOW_STOCK_MAX = 3;

export interface SeedCatalogStats {
  /** Every seed product (published or not). */
  readonly total: number;
  readonly published: number;
  readonly unpublished: number;
  readonly legacy: number;
  /** The remaining fields count PUBLISHED products only (what the storefront shows). */
  readonly deals: number;
  readonly featured: number;
  readonly outOfStock: number;
  /** 1..SEED_LOW_STOCK_MAX units left. */
  readonly lowStock: number;
  /** Published 0..SEED_NEW_ARRIVAL_DAYS days before the seed run. */
  readonly newArrivals: number;
  readonly byDepartment: Readonly<Record<string, number>>;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly byBrand: Readonly<Record<string, number>>;
}

function tally(entries: readonly SeedCatalogEntry[], key: (e: SeedCatalogEntry) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) out[key(e)] = (out[key(e)] ?? 0) + 1;
  return out;
}

function buildStats(): SeedCatalogStats {
  const pub = SEED_PUBLISHED_CATALOG;
  const count = (f: (e: SeedCatalogEntry) => boolean): number => pub.filter(f).length;
  return {
    total: SEED_CATALOG.length,
    published: pub.length,
    unpublished: SEED_CATALOG.length - pub.length,
    legacy: SEED_CATALOG.filter((e) => e.legacy).length,
    deals: count((e) => e.product.listPriceCents !== undefined),
    featured: count((e) => e.product.isFeatured === true),
    outOfStock: count((e) => e.product.stock === 0),
    lowStock: count((e) => e.product.stock > 0 && e.product.stock <= SEED_LOW_STOCK_MAX),
    newArrivals: count((e) => e.daysAgo <= SEED_NEW_ARRIVAL_DAYS),
    byDepartment: tally(pub, (e) => e.departmentSlug),
    byCategory: tally(pub, (e) => e.product.categorySlug ?? ""),
    byBrand: tally(pub, (e) => e.product.brandSlug ?? ""),
  };
}

/**
 * Seed catalogue counts, derived from the data (never hard-coded). Tests that
 * pin catalogue sizes should read these instead of literals.
 */
export const SEED_CATALOG_STATS: SeedCatalogStats = buildStats();

export interface SeedOptions {
  /** Reference time for published_at and review dates. Default: now. */
  readonly now?: Date;
}

/** `daysAgo` days before `now`'s UTC date, at 09:00 UTC. */
export function publishedAtFor(daysAgo: number, now: Date): Date {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - daysAgo * 86_400_000 + 9 * 3_600_000);
}

/** Upserts all brands and the department/category tree. Returns `{ brands, categories }`. */
export function seedTaxonomy(db: Database): { brands: number; categories: number } {
  const upsertBrand = db.query<unknown, [string, string, string, string]>(
    `INSERT INTO brands (id, slug, name, description) VALUES (?, ?, ?, ?)
     ON CONFLICT (slug) DO UPDATE SET
       name = excluded.name, description = excluded.description,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  const upsertCategory = db.query<unknown, [string, string, string, string, string | null, number]>(
    `INSERT INTO categories (id, slug, name, description, parent_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (slug) DO UPDATE SET
       name = excluded.name, description = excluded.description,
       parent_id = excluded.parent_id, sort_order = excluded.sort_order,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  let categories = 0;
  withTransaction(db, () => {
    for (const brand of SEED_BRANDS) upsertBrand.run(brandId(brand.slug), brand.slug, brand.name, brand.description);
    SEED_DEPARTMENTS.forEach((department, d) => {
      upsertCategory.run(categoryId(department.slug), department.slug, department.name, department.description, null, d + 1);
      categories++;
      department.categories.forEach((category, c) => {
        upsertCategory.run(
          categoryId(category.slug),
          category.slug,
          category.name,
          category.description,
          categoryId(department.slug),
          c + 1,
        );
        categories++;
      });
    });
  });
  return { brands: SEED_BRANDS.length, categories };
}

type ProductParams = [
  string, string, string, string, number, string, string, number,
  string, string, number | null, string, string, string, string, number, string,
];

function upsertEntries(db: Database, entries: readonly SeedCatalogEntry[], now: Date): void {
  // Upsert by slug: an existing row keeps its id (carts/orders stay valid).
  const upsert = db.query<unknown, ProductParams>(
    `INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock,
                           brand_id, category_id, list_price_cents, sku, bullets, specs, images,
                           is_featured, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (slug) DO UPDATE SET
       name             = excluded.name,
       description      = excluded.description,
       price_cents      = excluded.price_cents,
       currency         = excluded.currency,
       image_url        = excluded.image_url,
       stock            = excluded.stock,
       brand_id         = excluded.brand_id,
       category_id      = excluded.category_id,
       list_price_cents = excluded.list_price_cents,
       sku              = excluded.sku,
       bullets          = excluded.bullets,
       specs            = excluded.specs,
       images           = excluded.images,
       is_featured      = excluded.is_featured,
       published_at     = excluded.published_at,
       updated_at       = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  withTransaction(db, () => {
    for (const entry of entries) {
      const p = entry.product;
      upsert.run(
        p.id, p.slug, p.name, p.description, p.priceCents, p.currency, p.imageUrl, p.stock,
        entry.brandId, entry.categoryId, p.listPriceCents ?? null, p.sku ?? "",
        JSON.stringify(entry.bullets), JSON.stringify(entry.specs), JSON.stringify(entry.images),
        p.isFeatured === true ? 1 : 0, publishedAtFor(entry.daysAgo, now).toISOString(),
      );
    }
  });
}

/**
 * Upserts the taxonomy and the 15 legacy products, matched by slug. Re-running
 * never duplicates; it resets every seeded column **including stock** to the
 * seed values (keeping the existing id). Ratings are untouched (they belong
 * to reviews). Returns the number of legacy products (15).
 */
export function seedProducts(db: Database, options: SeedOptions = {}): number {
  seedTaxonomy(db);
  upsertEntries(db, SEED_CATALOG.filter((e) => e.legacy), options.now ?? new Date());
  return SEED_PRODUCTS.length;
}

/** Like `seedProducts` but for every catalogue product. Returns `SEED_CATALOG.length`. */
export function seedCatalogProducts(db: Database, options: SeedOptions = {}): number {
  seedTaxonomy(db);
  upsertEntries(db, SEED_CATALOG, options.now ?? new Date());
  return SEED_CATALOG.length;
}

function reviewProducts(db: Database, now: Date): SeedReviewProduct[] {
  // Resolve real ids by slug (a pre-existing row may have a different id).
  const idOf = db.query<{ id: string }, [string]>("SELECT id FROM products WHERE slug = ?");
  const result: SeedReviewProduct[] = [];
  for (const entry of SEED_CATALOG) {
    const row = idOf.get(entry.product.slug);
    if (row === null) continue;
    result.push({
      id: row.id,
      name: entry.product.name,
      department: entry.departmentSlug,
      publishedAt: publishedAtFor(entry.daysAgo, now),
      ageDays: entry.daysAgo,
      featured: entry.product.isFeatured === true,
    });
  }
  return result;
}

/**
 * Upserts seed reviews (by id) and their helpful votes. Rating aggregates
 * on `products` follow through the review triggers. Call after the products
 * exist. Returns `{ reviews, reviewVotes }` seeded.
 */
export function seedReviews(db: Database, options: SeedOptions = {}): { reviews: number; reviewVotes: number } {
  const now = options.now ?? new Date();
  const reviews = buildSeedReviews(reviewProducts(db, now), now);
  const upsert = db.query<unknown, [string, string, string, string, number, string, string, number, string, string, string]>(
    `INSERT INTO reviews (id, product_id, session_id, display_name, rating, title, body,
                          verified_purchase, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       display_name = excluded.display_name, rating = excluded.rating, title = excluded.title,
       body = excluded.body, verified_purchase = excluded.verified_purchase, status = excluded.status,
       created_at = excluded.created_at, updated_at = excluded.updated_at`,
  );
  const vote = db.query<unknown, [string, string]>(
    "INSERT INTO review_votes (review_id, session_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
  );
  let votes = 0;
  withTransaction(db, () => {
    for (const r of reviews) {
      upsert.run(r.id, r.productId, r.sessionId, r.displayName, r.rating, r.title, r.body,
        r.verifiedPurchase ? 1 : 0, r.status, r.createdAt, r.createdAt);
      for (const voter of r.voterSessionIds) {
        vote.run(r.id, voter);
        votes++;
      }
    }
  });
  return { reviews: reviews.length, reviewVotes: votes };
}

/** Upserts seed questions, answers and their votes. Call after the products exist. */
export function seedQuestions(
  db: Database,
  options: SeedOptions = {},
): { questions: number; answers: number; questionVotes: number; answerVotes: number } {
  const now = options.now ?? new Date();
  const questions = buildSeedQuestions(reviewProducts(db, now), now);
  const upsertQuestion = db.query<unknown, [string, string, string, string, string, string]>(
    `INSERT INTO questions (id, product_id, session_id, display_name, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, body = excluded.body,
       created_at = excluded.created_at`,
  );
  const upsertAnswer = db.query<unknown, [string, string, string, string, string, number, string]>(
    `INSERT INTO answers (id, question_id, session_id, display_name, body, is_store, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, body = excluded.body,
       is_store = excluded.is_store, created_at = excluded.created_at`,
  );
  const questionVote = db.query<unknown, [string, string]>(
    "INSERT INTO question_votes (question_id, session_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
  );
  const answerVote = db.query<unknown, [string, string]>(
    "INSERT INTO answer_votes (answer_id, session_id) VALUES (?, ?) ON CONFLICT DO NOTHING",
  );
  const counts = { questions: questions.length, answers: 0, questionVotes: 0, answerVotes: 0 };
  withTransaction(db, () => {
    for (const q of questions) {
      upsertQuestion.run(q.id, q.productId, q.sessionId, q.displayName, q.body, q.createdAt);
      for (const voter of q.voterSessionIds) {
        questionVote.run(q.id, voter);
        counts.questionVotes++;
      }
      for (const a of q.answers) {
        upsertAnswer.run(a.id, a.questionId, a.sessionId, a.displayName, a.body, a.isStore ? 1 : 0, a.createdAt);
        counts.answers++;
        for (const voter of a.voterSessionIds) {
          answerVote.run(a.id, voter);
          counts.answerVotes++;
        }
      }
    }
  });
  return counts;
}

/**
 * Upserts the demo coupons. `used_count` never goes down on a re-seed
 * (real redemptions are kept); everything else is reset to the seed values.
 */
export function seedCoupons(db: Database): number {
  const upsert = db.query<
    unknown,
    [string, string, number, number, number | null, number, string | null, string | null, number, number]
  >(
    `INSERT INTO coupons (code, kind, value, min_subtotal_cents, max_uses, used_count, starts_at,
                          expires_at, is_active, promoted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (code) DO UPDATE SET
       kind = excluded.kind, value = excluded.value, min_subtotal_cents = excluded.min_subtotal_cents,
       max_uses = excluded.max_uses,
       used_count = CASE WHEN excluded.max_uses IS NULL THEN max(coupons.used_count, excluded.used_count)
                         ELSE min(max(coupons.used_count, excluded.used_count), excluded.max_uses) END,
       starts_at = excluded.starts_at, expires_at = excluded.expires_at,
       is_active = excluded.is_active, promoted = excluded.promoted,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  withTransaction(db, () => {
    for (const c of SEED_COUPONS) {
      upsert.run(c.code, c.kind, c.value, c.minSubtotalCents, c.maxUses, c.usedCount, c.startsAt,
        c.expiresAt, c.isActive ? 1 : 0, c.promoted ? 1 : 0);
    }
  });
  return SEED_COUPONS.length;
}

/** Upserts the shipping methods (by id). */
export function seedShippingMethods(db: Database): number {
  const upsert = db.query<unknown, [string, string, string, number, number | null, number, number, number, number]>(
    `INSERT INTO shipping_methods (id, name, description, price_cents, free_over_cents, min_days,
                                   max_days, sort_order, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name, description = excluded.description, price_cents = excluded.price_cents,
       free_over_cents = excluded.free_over_cents, min_days = excluded.min_days,
       max_days = excluded.max_days, sort_order = excluded.sort_order, is_active = excluded.is_active,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  );
  withTransaction(db, () => {
    for (const m of SEED_SHIPPING_METHODS) {
      upsert.run(m.id, m.name, m.description, m.priceCents, m.freeOverCents, m.minDays, m.maxDays,
        m.sortOrder, m.isActive ? 1 : 0);
    }
  });
  return SEED_SHIPPING_METHODS.length;
}

export interface SeedCounts {
  readonly brands: number;
  readonly categories: number;
  readonly products: number;
  readonly reviews: number;
  readonly reviewVotes: number;
  readonly questions: number;
  readonly answers: number;
  readonly questionVotes: number;
  readonly answerVotes: number;
  readonly coupons: number;
  readonly shippingMethods: number;
}

/** Seeds everything in one transaction. Idempotent. Returns how many of each entity the seed defines. */
export function seedDatabase(db: Database, options: SeedOptions = {}): SeedCounts {
  const now = options.now ?? new Date();
  return withTransaction(db, () => {
    const taxonomy = seedTaxonomy(db);
    const products = seedCatalogProducts(db, { now });
    const reviews = seedReviews(db, { now });
    const qa = seedQuestions(db, { now });
    return {
      ...taxonomy,
      products,
      ...reviews,
      ...qa,
      coupons: seedCoupons(db),
      shippingMethods: seedShippingMethods(db),
    };
  });
}

export interface SeedImageFile {
  /** Path relative to `public/`, e.g. `images/products/gallery/plush-fox.svg`. */
  readonly path: string;
  readonly svg: string;
}

/** Every seed image file (primaries and gallery views) with its content. */
export function seedImageFiles(): SeedImageFile[] {
  const files: SeedImageFile[] = [];
  for (const entry of SEED_CATALOG) {
    const p = entry.product;
    files.push({ path: p.imageUrl.slice(1), svg: renderPlaceholderSvg(p) });
    for (const image of entry.images.slice(1)) {
      const view = GALLERY_VIEWS.find((v) => image.url.endsWith(`--${v}.svg`));
      if (view !== undefined) files.push({ path: image.url.slice(1), svg: renderVariantSvg(p, view) });
    }
  }
  return files;
}
