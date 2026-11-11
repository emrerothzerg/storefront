/**
 * QA (QA-W0-A / P2-A): seed v2. Criterion 4 (+ 7: no PII, no users).
 * Every DB is :memory:. Nothing here touches ./data.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { join, resolve, sep } from "node:path";
import { createDatabase } from "@/server/db/client";
import { MIGRATIONS, runMigrations } from "@/server/db/schema";
import { SEED_CATALOG, SEED_CATALOG_STATS, SEED_PRODUCTS, SEED_UNPUBLISHED_SLUGS, seedDatabase } from "@/server/db/seed";
import { SqliteProductRepository } from "@/server/catalog/product-repository";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PUBLIC_DIR = join(ROOT, "public");
const IMAGE_DIR = join(PUBLIC_DIR, "images", "products");
const NOW = new Date("2026-11-07T15:30:00.000Z");
/** Every seed product row (published or future-dated). */
const PRODUCTS = SEED_CATALOG_STATS.total;
/** Community generator output for the current catalogue (seed has no stats export for these; SEED-EXPAND report). */
const REVIEWS = 278;
const QUESTIONS = 101;
const ANSWERS = 127;

function migrated(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}

function n(db: Database, table: string): number {
  // table names below are literals from this file
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
}

const ALL_TABLES = [
  "brands", "categories", "products", "reviews", "review_votes", "questions", "answers", "question_votes",
  "answer_votes", "coupons", "coupon_redemptions", "shipping_methods", "users", "auth_sessions", "lists",
  "list_items", "addresses", "stock_alerts", "contact_messages", "orders", "order_items", "order_events",
  "carts", "cart_items", "product_views", "rate_limits",
];

/** Frozen MVP catalogue (slug -> [price_cents, stock]) as the MVP shipped it. */
const LEGACY: Readonly<Record<string, readonly [number, number]>> = {
  "canvas-tote-bag": [1999, 42],
  "enamel-pin-set": [50, 100],
  "walnut-desk": [125000, 3],
  "ceramic-pour-over": [3400, 0],
  "limited-print-no-1": [18000, 1],
  "merino-beanie": [2800, 64],
  "linen-napkins": [3200, 25],
  "brass-desk-lamp": [14900, 12],
  "notebook-dot-grid": [1450, 88],
  "wool-throw-blanket": [11900, 15],
  "cast-iron-skillet": [4999, 30],
  "glass-water-bottle": [2299, 50],
  "leather-card-holder": [3900, 20],
  "soy-candle-cedar": [2600, 10],
  "bamboo-cutting-board": [3599, 35],
};

function snapshot(db: Database): Record<string, unknown[]> {
  return {
    products: db.query("SELECT id, slug, name, price_cents, stock, list_price_cents, sku, bullets, specs, images, brand_id, category_id, is_featured, rating_count, rating_sum FROM products ORDER BY id").all(),
    reviews: db.query("SELECT id, product_id, session_id, rating, status, helpful_count FROM reviews ORDER BY id").all(),
    questions: db.query("SELECT id, product_id, helpful_count FROM questions ORDER BY id").all(),
    answers: db.query("SELECT id, question_id, helpful_count, is_store FROM answers ORDER BY id").all(),
    coupons: db.query("SELECT code, kind, value, used_count, max_uses FROM coupons ORDER BY code").all(),
    categories: db.query("SELECT id, slug, parent_id, sort_order FROM categories ORDER BY id").all(),
  };
}

describe("QA-A C4 seed counts and idempotency", () => {
  test("seedDatabase twice: identical counts (brands/categories/products/reviews/coupons/shipping) and identical rows, no duplicates", () => {
    const db = migrated();
    const first = seedDatabase(db, { now: NOW });
    expect(first).toMatchObject({ brands: 12, categories: 32, products: PRODUCTS, reviews: REVIEWS, coupons: 5, shippingMethods: 3 });
    const counts1 = Object.fromEntries(ALL_TABLES.map((t) => [t, n(db, t)]));
    const snap1 = snapshot(db);
    const second = seedDatabase(db, { now: NOW });
    expect(second).toEqual(first);
    expect(Object.fromEntries(ALL_TABLES.map((t) => [t, n(db, t)]))).toEqual(counts1);
    expect(snapshot(db)).toEqual(snap1);
    expect(counts1).toMatchObject({ brands: 12, categories: 32, products: PRODUCTS, reviews: REVIEWS, coupons: 5, shipping_methods: 3 });
    expect(db.query("SELECT COUNT(DISTINCT slug) AS a, COUNT(DISTINCT sku) AS b, COUNT(DISTINCT name) AS c FROM products").get()).toEqual({ a: PRODUCTS, b: PRODUCTS, c: PRODUCTS });
    db.run("INSERT INTO products_fts (products_fts, rank) VALUES ('integrity-check', 1)");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("re-seeding 30 days later keeps the same rows (only dates move)", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const ids = db.query("SELECT id FROM reviews UNION ALL SELECT id FROM questions UNION ALL SELECT id FROM answers ORDER BY 1").all();
    seedDatabase(db, { now: new Date(NOW.getTime() + 30 * 86_400_000) });
    expect(db.query("SELECT id FROM reviews UNION ALL SELECT id FROM questions UNION ALL SELECT id FROM answers ORDER BY 1").all()).toEqual(ids);
    expect(n(db, "reviews")).toBe(REVIEWS);
  });

  test("helpful_count equals the vote rows, and rating aggregates equal published reviews, after two seeds", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    seedDatabase(db, { now: NOW });
    for (const [parent, votes, col] of [["reviews", "review_votes", "review_id"], ["questions", "question_votes", "question_id"], ["answers", "answer_votes", "answer_id"]] as const) {
      const bad = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${parent} x WHERE helpful_count <> (SELECT COUNT(*) FROM ${votes} v WHERE v.${col} = x.id)`).get();
      expect({ parent, bad: bad?.n }).toEqual({ parent, bad: 0 });
    }
    const drift = db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM products p WHERE rating_count <> (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published')
          OR rating_sum <> (SELECT coalesce(SUM(rating), 0) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published')`,
    ).get();
    expect(drift?.n).toBe(0);
    expect(n(db, "questions")).toBe(QUESTIONS);
    expect(n(db, "answers")).toBe(ANSWERS);
  });

  test("seeding an MVP (v1) database that already has legacy rows, a cart and an order: ids kept, FK clean", () => {
    const db = createDatabase(":memory:");
    db.run("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) STRICT");
    const v1 = MIGRATIONS[0];
    if (v1 === undefined) throw new Error("no v1");
    db.exec(v1.sql);
    db.query("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(v1.version, v1.name);
    for (const p of SEED_PRODUCTS) {
      db.query("INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(p.id, p.slug, p.name, p.description, p.priceCents, p.currency, p.imageUrl, 1);
    }
    db.run("INSERT INTO carts (session_id) VALUES ('11111111-1111-4111-8111-111111111111')");
    db.run("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES ('11111111-1111-4111-8111-111111111111', 'prod_walnut-desk', 1)");
    runMigrations(db);
    seedDatabase(db, { now: NOW });
    expect(n(db, "products")).toBe(PRODUCTS);
    expect(db.query("SELECT id, stock FROM products WHERE slug = 'walnut-desk'").get()).toEqual({ id: "prod_walnut-desk", stock: 3 });
    expect(n(db, "cart_items")).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.run("INSERT INTO products_fts (products_fts, rank) VALUES ('integrity-check', 1)");
  });
});

describe("QA-A C4 legacy products frozen", () => {
  test("the 15 legacy products keep exact ids, slugs, prices and stock (incl. 50c pin set, stock 0/1/3) and have no list price", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const rows = db
      .query<{ id: string; slug: string; price_cents: number; stock: number; list_price_cents: number | null; image_url: string }, []>(
        "SELECT id, slug, price_cents, stock, list_price_cents, image_url FROM products",
      )
      .all();
    for (const [slug, [price, stock]] of Object.entries(LEGACY)) {
      const row = rows.find((r) => r.slug === slug);
      expect({ slug, row }).toEqual({ slug, row: { id: `prod_${slug}`, slug, price_cents: price, stock, list_price_cents: null, image_url: `/images/products/${slug}.svg` } });
    }
    expect(SEED_PRODUCTS.map((p) => p.slug).sort()).toEqual(Object.keys(LEGACY).sort());
  });
});

describe("QA-A C4 per-product content", () => {
  test("every product: leaf category, brand, 3-5 bullets, 4-8 specs, 2-4 images with files on disk, non-empty SKU", async () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const rows = db
      .query<{ slug: string; sku: string | null; bullets: string; specs: string; images: string; image_url: string; cat_parent: string | null; category_id: string | null; brand_id: string | null }, []>(
        `SELECT p.slug, p.sku, p.bullets, p.specs, p.images, p.image_url, p.category_id, p.brand_id, c.parent_id AS cat_parent
           FROM products p LEFT JOIN categories c ON c.id = p.category_id`,
      )
      .all();
    expect(rows.length).toBe(PRODUCTS);
    for (const r of rows) {
      expect({ slug: r.slug, cat: r.category_id !== null, leaf: r.cat_parent !== null, brand: r.brand_id !== null }).toEqual({ slug: r.slug, cat: true, leaf: true, brand: true });
      expect(typeof r.sku === "string" && r.sku.trim().length > 0).toBe(true);
      const bullets: unknown = JSON.parse(r.bullets);
      const specs: unknown = JSON.parse(r.specs);
      const images: unknown = JSON.parse(r.images);
      if (!Array.isArray(bullets) || !Array.isArray(specs) || !Array.isArray(images)) throw new Error(`bad json ${r.slug}`);
      expect({ slug: r.slug, b: bullets.length >= 3 && bullets.length <= 5 }).toEqual({ slug: r.slug, b: true });
      expect({ slug: r.slug, s: specs.length >= 4 && specs.length <= 8 }).toEqual({ slug: r.slug, s: true });
      expect({ slug: r.slug, i: images.length >= 2 && images.length <= 4 }).toEqual({ slug: r.slug, i: true });
      for (const b of bullets) expect(typeof b === "string" && b.trim() !== "").toBe(true);
      for (const s of specs) expect(typeof s?.label === "string" && typeof s?.value === "string" && s.label !== "" && s.value !== "").toBe(true);
      expect(images[0]?.url).toBe(r.image_url);
      for (const img of images) {
        const url: unknown = img?.url;
        if (typeof url !== "string") throw new Error(`bad image ${r.slug}`);
        expect(typeof img.alt === "string" && img.alt.trim() !== "").toBe(true);
        expect(url.startsWith("/images/products/")).toBe(true);
        const file = resolve(PUBLIC_DIR, `.${url}`);
        expect(file.startsWith(IMAGE_DIR + sep)).toBe(true);
        expect({ url, exists: await Bun.file(file).exists() }).toEqual({ url, exists: true });
      }
    }
  });

  test("~30% deals, some featured, published within the last 90 days of `now`; exactly SEED_UNPUBLISHED_SLUGS are future-dated", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const nowIso = NOW.toISOString();
    // Deals and featured are counted over what the storefront shows (published products).
    const s = db
      .query<{ published: number; deals: number; featured: number; minp: string; maxp: string }, [string]>(
        "SELECT COUNT(*) AS published, SUM(list_price_cents > price_cents) AS deals, SUM(is_featured) AS featured, MIN(published_at) AS minp, MAX(published_at) AS maxp FROM products WHERE published_at <= ?1",
      )
      .get(nowIso);
    expect(s?.published).toBe(SEED_CATALOG_STATS.published);
    expect(s?.deals).toBe(SEED_CATALOG_STATS.deals);
    expect(s?.featured).toBe(SEED_CATALOG_STATS.featured);
    const published = s?.published ?? 0;
    expect(s?.deals ?? 0).toBeGreaterThanOrEqual(Math.floor(published * 0.25));
    expect(s?.deals ?? 0).toBeLessThanOrEqual(Math.ceil(published * 0.4));
    expect(s?.featured ?? 0).toBeGreaterThan(0);
    const min = new Date(s?.minp ?? "").getTime();
    const max = new Date(s?.maxp ?? "").getTime();
    expect(min).toBeGreaterThanOrEqual(NOW.getTime() - 90 * 86_400_000);
    expect(max).toBeLessThanOrEqual(NOW.getTime());
    // Ruling (SEED-EXPAND): exactly SEED_UNPUBLISHED_SLUGS are future-dated; every other product is published by `now`.
    const future = db
      .query<{ slug: string }, [string]>("SELECT slug FROM products WHERE published_at > ?1 ORDER BY slug")
      .all(nowIso)
      .map((r) => r.slug);
    expect(SEED_UNPUBLISHED_SLUGS.length).toBeGreaterThan(0);
    expect(future).toEqual([...SEED_UNPUBLISHED_SLUGS].sort());
    expect(n(db, "products") - future.length).toBe(SEED_CATALOG_STATS.published);
    // list price never below price
    expect(db.query("SELECT COUNT(*) AS n FROM products WHERE list_price_cents IS NOT NULL AND list_price_cents < price_cents").get()).toEqual({ n: 0 });
  });

  test("SEED_CATALOG and the DB agree via the repository (sparse summary round-trip, minus colour)", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const repo = new SqliteProductRepository(db);
    for (const e of SEED_CATALOG) {
      const got = repo.getBySlug(e.product.slug);
      const expected: Record<string, unknown> = { ...e.product };
      delete expected.color;
      const rest: Record<string, unknown> = { ...got };
      delete rest.ratingCount;
      delete rest.ratingAvg;
      expect(typeof rest.publishedAt).toBe("string"); // D-T170-1: summaries carry publishedAt
      delete rest.publishedAt;
      expect(got).not.toBeNull();
      expect(rest).toEqual(expected);
    }
  });
});

describe("QA-A C4/C7 privacy: no users, no real-looking PII", () => {
  test("no user, auth_session, address, contact, order, list or alert rows are seeded", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    for (const t of ["users", "auth_sessions", "addresses", "contact_messages", "orders", "lists", "stock_alerts", "carts", "product_views", "coupon_redemptions"]) {
      expect({ t, n: n(db, t) }).toEqual({ t, n: 0 });
    }
  });

  test("display names are invented 'First L.' (or the store), no emails/phones/URLs in any seeded text, sessions synthetic", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const names = db.query<{ d: string }, []>("SELECT display_name AS d FROM reviews UNION SELECT display_name FROM questions UNION SELECT display_name FROM answers").all().map((r) => r.d);
    for (const d of names) expect(d === "Storefront Support" || /^[A-Z][a-z]+ [A-Z]\.$/.test(d)).toBe(true);
    const sessions = db.query<{ s: string }, []>("SELECT session_id AS s FROM reviews UNION SELECT session_id FROM questions UNION SELECT session_id FROM answers UNION SELECT session_id FROM review_votes UNION SELECT session_id FROM question_votes UNION SELECT session_id FROM answer_votes").all().map((r) => r.s);
    for (const s of sessions) expect(/^seed_(session|voter)_\d{2}$|^seed_store$/.test(s)).toBe(true);
    const texts = db
      .query<{ t: string }, []>(
        `SELECT title || ' ' || body AS t FROM reviews UNION ALL SELECT body FROM questions UNION ALL SELECT body FROM answers
         UNION ALL SELECT name || ' ' || description || ' ' || bullets || ' ' || specs FROM products
         UNION ALL SELECT name || ' ' || description FROM brands UNION ALL SELECT name || ' ' || description FROM categories
         UNION ALL SELECT name || ' ' || description FROM shipping_methods`,
      )
      .all()
      .map((r) => r.t);
    for (const t of texts) {
      const emails = t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [];
      for (const e of emails) expect(e.endsWith("@example.com")).toBe(true);
      expect(t).not.toMatch(/https?:\/\//);
      expect(t).not.toMatch(/\+?\d[\d\s().-]{8,}\d/); // phone-like digit runs
    }
  });
});

describe("QA-A C4 coupons and shipping semantics", () => {
  test("WELCOME10 / SAVE5 / FREESHIP / EXPIRED10 / MAXED5 and standard / express / next_day", () => {
    const db = migrated();
    seedDatabase(db, { now: NOW });
    const c = db
      .query<{ code: string; kind: string; value: number; min_subtotal_cents: number; max_uses: number | null; used_count: number; expires_at: string | null; is_active: number }, []>(
        "SELECT code, kind, value, min_subtotal_cents, max_uses, used_count, expires_at, is_active FROM coupons ORDER BY code",
      )
      .all();
    const by = Object.fromEntries(c.map((x) => [x.code, x]));
    expect(Object.keys(by).sort()).toEqual(["EXPIRED10", "FREESHIP", "MAXED5", "SAVE5", "WELCOME10"]);
    expect(by.WELCOME10).toMatchObject({ kind: "percent", value: 10, min_subtotal_cents: 0, max_uses: null, expires_at: null, is_active: 1 });
    expect(by.SAVE5).toMatchObject({ kind: "fixed", value: 500, min_subtotal_cents: 2500, is_active: 1, expires_at: null });
    expect(by.FREESHIP).toMatchObject({ kind: "free_shipping", value: 0, is_active: 1, expires_at: null });
    expect(by.EXPIRED10?.is_active).toBe(1);
    expect(new Date(by.EXPIRED10?.expires_at ?? "2999-01-01").getTime()).toBeLessThan(NOW.getTime());
    expect(by.MAXED5).toMatchObject({ max_uses: 1, used_count: 1, is_active: 1 });
    // MAXED5 is genuinely exhausted under the README's race-safe redemption statement
    expect(db.query("UPDATE coupons SET used_count = used_count + 1 WHERE code = 'MAXED5' AND (max_uses IS NULL OR used_count < max_uses)").run().changes).toBe(0);
    expect(
      db.query("SELECT id, price_cents, free_over_cents, min_days, max_days, is_active FROM shipping_methods ORDER BY sort_order").all(),
    ).toEqual([
      { id: "standard", price_cents: 499, free_over_cents: 3500, min_days: 5, max_days: 8, is_active: 1 },
      { id: "express", price_cents: 999, free_over_cents: null, min_days: 2, max_days: 3, is_active: 1 },
      { id: "next_day", price_cents: 1999, free_over_cents: null, min_days: 1, max_days: 1, is_active: 1 },
    ]);
  });
});
