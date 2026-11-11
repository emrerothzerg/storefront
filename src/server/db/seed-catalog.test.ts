import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "./client";
import { runMigrations } from "./schema";
import {
  isSeedPublished,
  publishedAtFor,
  SEED_BRANDS,
  SEED_CATALOG,
  SEED_CATALOG_PRODUCTS,
  SEED_CATALOG_STATS,
  SEED_COUPONS,
  SEED_DEPARTMENTS,
  SEED_PRODUCTS,
  SEED_PUBLISHED_CATALOG,
  SEED_SHIPPING_METHODS,
  SEED_UNPUBLISHED_SLUGS,
  seedCatalogProducts,
  seedDatabase,
  seedImageFiles,
  seedProducts,
} from "./seed";
import { buildSeedQuestions, buildSeedReviews, HIDDEN_REVIEW_IDS, type SeedReviewProduct } from "./seed-data/community";
import { SqliteProductRepository } from "../catalog/product-repository";

const PUBLIC_DIR = join(import.meta.dir, "..", "..", "..", "public");
const NOW = new Date("2026-11-07T12:00:00.000Z");

/** The MVP catalogue, frozen: tests and the HTTP smoke depend on these values. */
const LEGACY: ReadonlyArray<readonly [slug: string, priceCents: number, stock: number]> = [
  ["canvas-tote-bag", 1999, 42], ["enamel-pin-set", 50, 100], ["walnut-desk", 125000, 3],
  ["ceramic-pour-over", 3400, 0], ["limited-print-no-1", 18000, 1], ["merino-beanie", 2800, 64],
  ["linen-napkins", 3200, 25], ["brass-desk-lamp", 14900, 12], ["notebook-dot-grid", 1450, 88],
  ["wool-throw-blanket", 11900, 15], ["cast-iron-skillet", 4999, 30], ["glass-water-bottle", 2299, 50],
  ["leather-card-holder", 3900, 20], ["soy-candle-cedar", 2600, 10], ["bamboo-cutting-board", 3599, 35],
];

const TABLES = [
  "brands", "categories", "products", "reviews", "review_votes", "questions", "answers",
  "question_votes", "answer_votes", "coupons", "coupon_redemptions", "shipping_methods", "users",
  "auth_sessions", "lists", "list_items", "addresses", "stock_alerts", "contact_messages",
] as const;

function migrated(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}

function counts(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? -1;
  return out;
}

/** Phase 2 catalogue order (positions 16-60), frozen: ids, SKUs, gallery views and review/Q&A ids depend on it. */
const PHASE2_FIRST_AND_LAST = ["gooseneck-kettle", "fountain-pen-starter"] as const;

describe("seed catalogue content", () => {
  test("125 products with unique ids, slugs, colours and SKUs; legacy 15 first and frozen", () => {
    expect(SEED_CATALOG).toHaveLength(125);
    for (const key of ["id", "slug", "color", "sku"] as const) {
      expect(new Set(SEED_CATALOG_PRODUCTS.map((p) => (key === "color" ? p.color.toLowerCase() : p[key]))).size).toBe(125);
    }
    for (const p of SEED_CATALOG_PRODUCTS) expect(p.color).toMatch(/^#[0-9a-f]{6}$/);
    // Append-only: phase 2 products keep their positions (SKU = prefix + 1001 + index).
    expect(SEED_CATALOG_PRODUCTS[15]?.slug).toBe(PHASE2_FIRST_AND_LAST[0]);
    expect(SEED_CATALOG_PRODUCTS[59]?.slug).toBe(PHASE2_FIRST_AND_LAST[1]);
    expect(SEED_CATALOG_PRODUCTS[59]?.sku).toBe("IS-1060");
    expect(SEED_PRODUCTS).toHaveLength(15);
    expect(SEED_PRODUCTS.map((p) => [p.slug, p.priceCents, p.stock])).toEqual(LEGACY.map((l) => [...l]));
    for (const p of SEED_PRODUCTS) {
      expect(p.imageUrl).toBe(`/images/products/${p.slug}.svg`);
      expect(p.listPriceCents).toBeUndefined(); // see seed-data/products.ts header
    }
    for (const p of SEED_CATALOG_PRODUCTS) expect(p.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  test("8 departments x 3 categories, 12 brands, every product placed in a leaf category and brand", () => {
    expect(SEED_DEPARTMENTS).toHaveLength(8);
    for (const d of SEED_DEPARTMENTS) expect(d.categories).toHaveLength(3);
    expect(SEED_BRANDS).toHaveLength(12);
    const departmentsUsed = new Set(SEED_CATALOG.map((e) => e.departmentSlug));
    expect(departmentsUsed.size).toBe(8);
    for (const e of SEED_CATALOG) {
      expect(e.categoryId).toMatch(/^cat_/);
      expect(e.brandId).toMatch(/^brand_/);
    }
  });

  test("rich content: 3-5 bullets, 4-8 specs, 2-4 images (primary first) per product", () => {
    for (const e of SEED_CATALOG) {
      const slug = e.product.slug;
      expect({ slug, ok: e.bullets.length >= 3 && e.bullets.length <= 5 }).toEqual({ slug, ok: true });
      expect({ slug, ok: e.specs.length >= 4 && e.specs.length <= 8 }).toEqual({ slug, ok: true });
      expect({ slug, ok: e.images.length >= 2 && e.images.length <= 4 }).toEqual({ slug, ok: true });
      expect(e.images[0]?.url).toBe(e.product.imageUrl);
      for (const image of e.images) expect(image.alt.length).toBeGreaterThan(0);
    }
  });

  test("~1/3 deals at 10-40% off, 12 featured, published over the last 90 days (2 future-dated), stock spread incl. 0/1/2", () => {
    const deals = SEED_CATALOG_PRODUCTS.filter((p) => p.listPriceCents !== undefined && p.listPriceCents !== null);
    expect(deals.length).toBe(43);
    for (const p of deals) {
      const off = 1 - p.priceCents / (p.listPriceCents ?? 0);
      expect({ slug: p.slug, ok: off >= 0.1 && off <= 0.4 }).toEqual({ slug: p.slug, ok: true });
    }
    expect(SEED_CATALOG_PRODUCTS.filter((p) => p.isFeatured === true)).toHaveLength(12);
    const future = SEED_CATALOG.filter((e) => e.daysAgo < 0);
    expect(future.map((e) => e.product.slug)).toEqual(["smart-thermostat", "neroli-eau-de-toilette"]);
    for (const e of future) expect(e.daysAgo).toBeGreaterThanOrEqual(-30);
    // Published products: 3..90 days (0-2 would depend on the time of day; see products.ts header).
    for (const e of SEED_CATALOG.filter((x) => x.daysAgo >= 0)) expect({ slug: e.product.slug, ok: e.daysAgo >= 3 && e.daysAgo <= 90 }).toEqual({ slug: e.product.slug, ok: true });
    const stocks = SEED_CATALOG_PRODUCTS.map((p) => p.stock);
    for (const s of stocks) expect(Number.isSafeInteger(s) && s >= 0).toBe(true);
    for (const s of [0, 1, 2]) expect(stocks.filter((x) => x === s).length).toBeGreaterThanOrEqual(2);
  });

  test("SEED_CATALOG_STATS is derived from the data and matches the documented spread", () => {
    expect(SEED_CATALOG_STATS).toMatchObject({
      total: 125, published: 123, unpublished: 2, legacy: 15,
      deals: 43, featured: 12, outOfStock: 11, lowStock: 17, newArrivals: 23,
    });
    expect(SEED_PUBLISHED_CATALOG).toHaveLength(SEED_CATALOG_STATS.published);
    expect(SEED_UNPUBLISHED_SLUGS).toEqual(["smart-thermostat", "neroli-eau-de-toilette"]);
    expect(SEED_PUBLISHED_CATALOG.every(isSeedPublished)).toBe(true);
    const sum = (r: Readonly<Record<string, number>>) => Object.values(r).reduce((a, b) => a + b, 0);
    expect(sum(SEED_CATALOG_STATS.byDepartment)).toBe(123);
    expect(sum(SEED_CATALOG_STATS.byCategory)).toBe(123);
    expect(sum(SEED_CATALOG_STATS.byBrand)).toBe(123);
    // Every department, leaf category and brand has a healthy published spread.
    for (const d of SEED_DEPARTMENTS) {
      expect({ d: d.slug, ok: (SEED_CATALOG_STATS.byDepartment[d.slug] ?? 0) >= 14 }).toEqual({ d: d.slug, ok: true });
      for (const c of d.categories) {
        expect({ c: c.slug, ok: (SEED_CATALOG_STATS.byCategory[c.slug] ?? 0) >= 4 }).toEqual({ c: c.slug, ok: true });
      }
    }
    for (const b of SEED_BRANDS) {
      expect({ b: b.slug, ok: (SEED_CATALOG_STATS.byBrand[b.slug] ?? 0) >= 7 }).toEqual({ b: b.slug, ok: true });
    }
  });

  test("expansion: ~15 new arrivals in the last two weeks, sub-$10 prices with cents, hundreds-of-dollars items", () => {
    const expansion = SEED_CATALOG.slice(60);
    expect(expansion).toHaveLength(65);
    const recent = expansion.filter((e) => e.daysAgo >= 0 && e.daysAgo <= 14);
    expect(recent.length).toBeGreaterThanOrEqual(13);
    expect(recent.length).toBeLessThanOrEqual(17);
    const prices = expansion.map((e) => e.product.priceCents);
    expect(prices.filter((c) => c < 1000 && c % 100 !== 0).length).toBeGreaterThanOrEqual(4);
    expect(prices.filter((c) => c >= 10000).length).toBeGreaterThanOrEqual(5);
    // Some just under / over the $35 free-shipping threshold for progress-bar tests.
    expect(prices.some((c) => c >= 3000 && c < 3500)).toBe(true);
    expect(prices).toContain(3500);
  });

  test("coupons and shipping methods match the brief", () => {
    const byCode = new Map(SEED_COUPONS.map((c) => [c.code, c]));
    expect(byCode.get("WELCOME10")).toMatchObject({ kind: "percent", value: 10, minSubtotalCents: 0, promoted: true });
    expect(byCode.get("SAVE5")).toMatchObject({ kind: "fixed", value: 500, minSubtotalCents: 2500, promoted: false });
    expect(byCode.get("FREESHIP")).toMatchObject({ kind: "free_shipping", value: 0, minSubtotalCents: 2000, promoted: true });
    expect(new Date(byCode.get("EXPIRED10")?.expiresAt ?? "2999-01-01").getTime()).toBeLessThan(NOW.getTime());
    expect(byCode.get("MAXED5")).toMatchObject({ maxUses: 1, usedCount: 1 });
    expect(SEED_SHIPPING_METHODS.map((m) => [m.id, m.priceCents, m.freeOverCents, m.minDays, m.maxDays])).toEqual([
      ["standard", 499, 3500, 5, 8], ["express", 999, null, 2, 3], ["next_day", 1999, null, 1, 1],
    ]);
  });

  test("publishedAtFor is 09:00 UTC, N days before now's date (negative = future)", () => {
    expect(publishedAtFor(0, NOW).toISOString()).toBe("2026-11-07T09:00:00.000Z");
    expect(publishedAtFor(90, NOW).toISOString()).toBe("2026-08-09T09:00:00.000Z");
    expect(publishedAtFor(-10, NOW).toISOString()).toBe("2026-11-17T09:00:00.000Z");
  });
});

describe("seedDatabase", () => {
  test("seeds every entity; running twice gives identical counts and rows (idempotent)", () => {
    const db = migrated();
    const first = seedDatabase(db, { now: NOW });
    const after1 = counts(db);
    const snapshot = db.query("SELECT id, slug, price_cents, stock, rating_count, rating_sum, sku FROM products ORDER BY id").all();
    const second = seedDatabase(db, { now: NOW });
    expect(second).toEqual(first);
    expect(counts(db)).toEqual(after1);
    expect(db.query("SELECT id, slug, price_cents, stock, rating_count, rating_sum, sku FROM products ORDER BY id").all()).toEqual(snapshot);
    expect(after1).toMatchObject({
      brands: 12, categories: 32, products: 125, coupons: 5, shipping_methods: 3,
      users: 0, auth_sessions: 0, lists: 0, addresses: 0, stock_alerts: 0, contact_messages: 0, coupon_redemptions: 0,
    });
    expect(after1.reviews).toBe(first.reviews);
    expect(first.reviews).toBeGreaterThanOrEqual(250);
    expect(first.reviews).toBeLessThanOrEqual(300);
    expect(first.questions).toBeGreaterThanOrEqual(90);
    expect(first.questions).toBeLessThanOrEqual(115);
    expect(after1.review_votes).toBe(first.reviewVotes);
  });

  test("future-dated products are unpublished at seed time and have no reviews or questions; some products stay unrated", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const unpublished = db
      .query<{ slug: string }, [string]>("SELECT slug FROM products WHERE published_at > ? ORDER BY slug")
      .all(NOW.toISOString())
      .map((r) => r.slug);
    expect(unpublished).toEqual([...SEED_UNPUBLISHED_SLUGS].sort());
    const community = db.query<{ n: number }, []>(
      `SELECT (SELECT COUNT(*) FROM reviews r JOIN products p ON p.id = r.product_id WHERE p.published_at > '${NOW.toISOString()}')
            + (SELECT COUNT(*) FROM questions q JOIN products p ON p.id = q.product_id WHERE p.published_at > '${NOW.toISOString()}') AS n`,
    ).get();
    expect(community).toEqual({ n: 0 });
    const unrated = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM products WHERE rating_count = 0").get()?.n ?? 0;
    expect(unrated).toBeGreaterThanOrEqual(10);
    expect(unrated).toBeLessThanOrEqual(30);
  });

  test("appending products leaves the existing 60 products' reviews and questions unchanged", () => {
    const asReviewProducts = (entries: readonly (typeof SEED_CATALOG)[number][]): SeedReviewProduct[] =>
      entries.map((e) => ({
        id: e.product.id,
        name: e.product.name,
        department: e.departmentSlug,
        publishedAt: publishedAtFor(e.daysAgo, NOW),
        ageDays: e.daysAgo,
        featured: e.product.isFeatured === true,
      }));
    const before = asReviewProducts(SEED_CATALOG.slice(0, 60));
    const after = asReviewProducts(SEED_CATALOG);
    const reviewsBefore = buildSeedReviews(before, NOW);
    expect(reviewsBefore.length).toBeGreaterThanOrEqual(130);
    expect(buildSeedReviews(after, NOW).slice(0, reviewsBefore.length)).toEqual(reviewsBefore);
    const questionsBefore = buildSeedQuestions(before, NOW);
    expect(buildSeedQuestions(after, NOW).slice(0, questionsBefore.length)).toEqual(questionsBefore);
  });

  test("re-seeding at a different time of day does not change which rows exist", () => {
    const db = migrated();
    seedDatabase(db, { now: new Date("2026-11-07T00:30:00.000Z") });
    const before = counts(db);
    seedDatabase(db, { now: new Date("2026-11-07T23:30:00.000Z") });
    expect(counts(db)).toEqual(before);
  });

  test("preserves the 15 legacy products' ids, prices and stock", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const repo = new SqliteProductRepository(db);
    for (const [slug, price, stock] of LEGACY) {
      expect(repo.getBySlug(slug)).toMatchObject({ id: `prod_${slug}`, priceCents: price, stock });
    }
  });

  test("ratings equal the published reviews; hidden reviews are excluded", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const drift = db.query(
      `SELECT id FROM products p
        WHERE rating_count <> (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published')
           OR rating_sum <> (SELECT coalesce(SUM(rating), 0) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published')`,
    ).all();
    expect(drift).toEqual([]);
    const hidden = db.query<{ id: string }, []>("SELECT id FROM reviews WHERE status = 'hidden' ORDER BY id").all().map((r) => r.id);
    expect(hidden).toEqual([...HIDDEN_REVIEW_IDS].sort());
    const helpfulDrift = db.query(
      "SELECT id FROM reviews r WHERE helpful_count <> (SELECT COUNT(*) FROM review_votes v WHERE v.review_id = r.id)",
    ).all();
    expect(helpfulDrift).toEqual([]);
  });

  test("review mix: skewed positive with some 1-2 stars, ~40% verified, synthetic sessions only", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const dist = db.query<{ rating: number; n: number }, []>("SELECT rating, COUNT(*) AS n FROM reviews GROUP BY rating").all();
    const by = new Map(dist.map((d) => [d.rating, d.n]));
    const total = dist.reduce((s, d) => s + d.n, 0);
    expect((by.get(5) ?? 0) + (by.get(4) ?? 0)).toBeGreaterThan(total * 0.6);
    expect((by.get(1) ?? 0) + (by.get(2) ?? 0)).toBeGreaterThan(5);
    const verified = db.query<{ v: number }, []>("SELECT AVG(verified_purchase) AS v FROM reviews").get()?.v ?? 0;
    expect(verified).toBeGreaterThan(0.3);
    expect(verified).toBeLessThan(0.5);
    for (const t of ["reviews", "questions", "answers", "review_votes", "question_votes", "answer_votes"]) {
      const bad = db.query(`SELECT session_id FROM ${t} WHERE session_id NOT LIKE 'seed\\_%' ESCAPE '\\'`).all();
      expect({ t, bad }).toEqual({ t, bad: [] });
    }
    const answersPerQuestion = db.query<{ n: number }, []>(
      "SELECT (SELECT COUNT(*) FROM answers a WHERE a.question_id = q.id) AS n FROM questions q",
    ).all().map((r) => r.n);
    for (const n of answersPerQuestion) expect(n >= 0 && n <= 3).toBe(true);
    expect(answersPerQuestion).toContain(0);
    expect(db.query("SELECT COUNT(*) AS n FROM answers WHERE is_store = 1").get()).not.toEqual({ n: 0 });
  });

  test("re-seed keeps real activity: shopper votes and coupon redemptions are not undone", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const review = db.query<{ id: string; helpful_count: number }, []>("SELECT id, helpful_count FROM reviews LIMIT 1").get();
    if (review === null) throw new Error("no reviews");
    db.query("INSERT INTO review_votes (review_id, session_id) VALUES (?, '00000000-0000-4000-8000-000000000001')").run(review.id);
    db.run("UPDATE coupons SET used_count = 7 WHERE code = 'WELCOME10'");
    seedDatabase(db, { now: NOW });
    expect(db.query("SELECT helpful_count FROM reviews WHERE id = ?").get(review.id)).toEqual({ helpful_count: review.helpful_count + 1 });
    expect(db.query("SELECT used_count FROM coupons WHERE code = 'WELCOME10'").get()).toEqual({ used_count: 7 });
    expect(db.query("SELECT used_count FROM coupons WHERE code = 'MAXED5'").get()).toEqual({ used_count: 1 });
  });

  test("seeded products are fully searchable through products_fts", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const hits = (q: string) =>
      db.query<{ slug: string }, [string]>(
        "SELECT p.slug FROM products_fts JOIN products p ON p.rowid = products_fts.rowid WHERE products_fts MATCH ? ORDER BY p.slug",
      ).all(q).map((r) => r.slug);
    const kestrel = SEED_CATALOG_PRODUCTS.filter((p) => p.brandSlug === "kestrel-audio").map((p) => p.slug).sort();
    expect(kestrel).toHaveLength(7);
    expect(hits("kestrel")).toEqual(kestrel);
    expect(hits("walnut")).toContain("walnut-desk");
    expect(hits("headph*")).toContain("wireless-over-ear-headphones");
    // FTS indexes every product, published or not.
    expect(hits("department_name:electronics").length).toBe(SEED_CATALOG.filter((e) => e.departmentSlug === "electronics").length);
    expect(hits("department_name:electronics").length).toBe(17);
    db.run("INSERT INTO products_fts (products_fts) VALUES ('integrity-check')");
  });
});

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("seedProducts / seedCatalogProducts", () => {
  test("seedProducts inserts only the 15 legacy products (plus taxonomy) and round-trips SEED_PRODUCTS", () => {
    const db = migrated();
    expect(seedProducts(db, { now: NOW })).toBe(15);
    const repo = new SqliteProductRepository(db);
    expect(repo.list()).toHaveLength(15);
    for (const seed of SEED_PRODUCTS) {
      const { color: _color, ...expected } = seed;
      void _color;
      // D-T170-1: summaries also carry the seeded publish time.
      expect(repo.getBySlug(seed.slug)).toEqual({ ...expected, publishedAt: expect.stringMatching(ISO_RE) });
    }
    expect(repo.getDetailBySlug("walnut-desk")?.publishedAt).toBe(publishedAtFor(80, NOW).toISOString());
  });

  test("seedCatalogProducts inserts all 125 and round-trips SEED_CATALOG_PRODUCTS", () => {
    const db = migrated();
    expect(seedCatalogProducts(db, { now: NOW })).toBe(125);
    const repo = new SqliteProductRepository(db);
    for (const seed of SEED_CATALOG_PRODUCTS) {
      const { color: _color, ...expected } = seed;
      void _color;
      // D-T170-1: summaries also carry the seeded publish time.
      expect(repo.getBySlug(seed.slug)).toEqual({ ...expected, publishedAt: expect.stringMatching(ISO_RE) });
    }
    const entry = SEED_CATALOG.find((e) => e.product.slug === "gooseneck-kettle");
    const detail = repo.getDetailBySlug("gooseneck-kettle");
    expect(detail?.bullets).toEqual(entry?.bullets ?? []);
    expect(detail?.specs).toEqual(entry?.specs ?? []);
    expect(detail?.images).toEqual(entry?.images ?? []);
  });
});

describe("seed images", () => {
  test("every image file referenced by the seed exists on disk with the rendered content", () => {
    const files = seedImageFiles();
    const urls = new Set(SEED_CATALOG.flatMap((e) => e.images.map((i) => i.url.slice(1))));
    expect(new Set(files.map((f) => f.path))).toEqual(urls);
    for (const f of files) {
      expect({ path: f.path, same: readFileSync(join(PUBLIC_DIR, f.path), "utf8") === f.svg }).toEqual({ path: f.path, same: true });
      expect(f.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(f.svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    }
  });

  test("the gallery folder has no orphan SVGs", () => {
    const expected = seedImageFiles()
      .map((f) => f.path)
      .filter((p) => p.startsWith("images/products/gallery/"))
      .map((p) => p.slice("images/products/gallery/".length))
      .sort();
    const actual = readdirSync(join(PUBLIC_DIR, "images", "products", "gallery")).filter((n) => n.endsWith(".svg")).sort();
    expect(actual).toEqual(expected);
  });
});
