import { describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AppError, Result } from "@/lib/result";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SEED_CATALOG_STATS, seedDatabase } from "@/server/db/seed";
import {
  createListingService,
  getListingService,
  LISTING_SORTS,
  MAX_PAGE_SIZE,
  PRICE_BUCKETS,
  TOP_RATED_MIN_REVIEWS,
  type ListingQuery,
  type ListingResult,
  type ListingService,
  type ListingSort,
} from "./listing-service";

const NOW_DATE = new Date("2026-11-07T12:00:00.000Z");
const NOW = NOW_DATE.getTime();
/** Products visible at NOW right after seeding (the seed future-dates a few). */
const PUBLISHED = SEED_CATALOG_STATS.published;

/** Raw facts per product, read straight from the tables (test oracle). */
interface Fact {
  id: string;
  categoryId: string | null;
  departmentId: string | null;
  brandSlug: string | null;
  price: number;
  stock: number;
  listPrice: number | null;
  ratingSum: number;
  ratingCount: number;
  featured: number;
  publishedAt: string;
  units: number;
}

let orderSeq = 0;

function insertOrder(
  db: Database,
  lines: readonly (readonly [productId: string, quantity: number])[],
  status: "paid" | "payment_failed" = "paid",
  fulfillment: string = "processing",
): void {
  const id = `ord_test_${++orderSeq}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
       line1, city, region, postal_code, country, card_last4, idempotency_key, fulfillment_status)
     VALUES (?, 'seed_session_01', ?, 100, 100, 'USD', 'A', 'a@b.co', 'l1', 'c', 'r', 'p', 'US', '4242', ?, ?)`,
  ).run(id, status, `key-${id}`, fulfillment);
  for (const [productId, quantity] of lines) {
    db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'x', 100, ?)").run(
      id,
      productId,
      quantity,
    );
  }
}

function setup(opts: { orders?: boolean } = {}): { db: Database; service: ListingService } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: NOW_DATE });
  if (opts.orders === true) {
    const ids = db.query<{ id: string }, []>("SELECT id FROM products ORDER BY id").all().map((r) => r.id);
    // Deterministic sales over ~20 products, with ties, plus noise that must be ignored.
    ids.slice(0, 20).forEach((id, i) => insertOrder(db, [[id, (i % 5) + 1]]));
    insertOrder(db, [[ids[0] ?? "", 100]], "payment_failed");
    insertOrder(db, [[ids[1] ?? "", 100]], "paid", "cancelled");
  }
  return { db, service: createListingService({ db }) };
}

function facts(db: Database, nowIso = NOW_DATE.toISOString()): Fact[] {
  return db
    .query<Fact, [string]>(
      `SELECT p.id AS id, p.category_id AS categoryId, coalesce(c.parent_id, c.id) AS departmentId,
              b.slug AS brandSlug, p.price_cents AS price, p.stock AS stock, p.list_price_cents AS listPrice,
              p.rating_sum AS ratingSum, p.rating_count AS ratingCount, p.is_featured AS featured,
              p.published_at AS publishedAt,
              coalesce((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                         WHERE oi.product_id = p.id AND o.status = 'paid' AND o.fulfillment_status <> 'cancelled'), 0) AS units
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN brands b ON b.id = p.brand_id
        WHERE p.published_at <= ?`,
    )
    .all(nowIso);
}

const avg = (f: Fact): number => (f.ratingCount > 0 ? f.ratingSum / f.ratingCount : 0);
const byId = (a: Fact, b: Fact): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function oracleOrder(list: Fact[], sort: ListingSort): string[] {
  const cmp: Record<ListingSort, (a: Fact, b: Fact) => number> = {
    relevance: (a, b) => b.featured - a.featured || avg(b) - avg(a) || byId(a, b),
    featured: (a, b) => b.featured - a.featured || avg(b) - avg(a) || byId(a, b),
    price_asc: (a, b) => a.price - b.price || byId(a, b),
    price_desc: (a, b) => b.price - a.price || byId(a, b),
    rating: (a, b) => avg(b) - avg(a) || b.ratingCount - a.ratingCount || byId(a, b),
    newest: (a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0) || byId(a, b),
    best_selling: (a, b) => b.units - a.units || byId(a, b),
  };
  return [...list].sort(cmp[sort]).map((f) => f.id);
}

function unwrap(r: Result<ListingResult, AppError>): ListingResult {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function allIds(service: ListingService, query: ListingQuery): string[] {
  const out: string[] = [];
  for (let page = 1; page <= 1000; page++) { // until pageCount; the cap only guards against a runaway pageCount
    const r = unwrap(service.list({ ...query, page, pageSize: 7, now: NOW }));
    out.push(...r.items.map((i) => i.id));
    if (page >= r.pageCount) break;
  }
  return out;
}

describe("sorting", () => {
  test("each sort gives the oracle's deterministic total order across pages", () => {
    const { db, service } = setup({ orders: true });
    const all = facts(db);
    for (const sort of LISTING_SORTS) {
      expect({ sort, ids: allIds(service, { sort }) }).toEqual({ sort, ids: oracleOrder(all, sort) });
    }
  });

  test("ties are broken by id (equal prices)", () => {
    const { db, service } = setup();
    const ids = allIds(service, { sort: "price_asc" });
    const price = new Map(facts(db).map((f) => [f.id, f.price]));
    for (let i = 1; i < ids.length; i++) {
      const a = ids[i - 1] ?? "";
      const b = ids[i] ?? "";
      if (price.get(a) === price.get(b)) expect(a < b).toBe(true);
    }
  });

  test("unknown sort falls back to featured; missing sort is featured without ids", () => {
    const { service } = setup();
    const featured = unwrap(service.list({ sort: "featured", now: NOW }));
    for (const sort of ["bogus", "", "PRICE_ASC", "constructor"]) {
      const r = unwrap(service.list({ sort, now: NOW }));
      expect(r.sort).toBe("featured");
      expect(r.items.map((i) => i.id)).toEqual(featured.items.map((i) => i.id));
    }
    expect(unwrap(service.list({ now: NOW })).sort).toBe("featured");
  });

  test("relevance keeps the ids order and sets rank; unknown and duplicate ids are skipped", () => {
    const { db, service } = setup();
    const ids = facts(db).map((f) => f.id).slice(0, 6).reverse();
    const r = unwrap(service.list({ ids: [...ids, "prod_nope", ids[0] ?? ""], now: NOW }));
    expect(r.sort).toBe("relevance");
    expect(r.total).toBe(6);
    expect(r.items.map((i) => i.id)).toEqual(ids);
    expect(r.items.map((i) => i.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    // Other sorts reorder within the id set.
    const asc = unwrap(service.list({ ids, sort: "price_asc", now: NOW }));
    expect(new Set(asc.items.map((i) => i.id))).toEqual(new Set(ids));
    // Empty ids = no results.
    expect(unwrap(service.list({ ids: [], now: NOW })).total).toBe(0);
  });

  test("relevance without ids behaves like featured", () => {
    const { service } = setup();
    const a = unwrap(service.list({ sort: "relevance", now: NOW }));
    const b = unwrap(service.list({ sort: "featured", now: NOW }));
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
  });
});

describe("pagination", () => {
  test("pageSize clamps to 1..48 with default 24", () => {
    const { service } = setup();
    const cases: [number | undefined, number][] = [
      [undefined, 24],
      [0, 1],
      [-5, 1],
      [1000, MAX_PAGE_SIZE],
      [Number.NaN, 24],
      [Number.POSITIVE_INFINITY, 24],
      [10.7, 10],
    ];
    for (const [pageSize, expected] of cases) {
      const r = unwrap(service.list({ ...(pageSize === undefined ? {} : { pageSize }), now: NOW }));
      expect({ pageSize, got: r.pageSize }).toEqual({ pageSize, got: expected });
      expect(r.items.length).toBe(Math.min(expected, r.total));
      expect(r.pageCount).toBe(Math.ceil(r.total / expected));
    }
  });

  test("page < 1 or non-integer becomes 1; page beyond last is empty with the right total", () => {
    const { service } = setup();
    const first = unwrap(service.list({ now: NOW }));
    for (const page of [0, -1, 1.5, Number.NaN]) {
      const r = unwrap(service.list({ page, now: NOW }));
      expect(r.page).toBe(1);
      expect(r.items.map((i) => i.id)).toEqual(first.items.map((i) => i.id));
    }
    const beyond = unwrap(service.list({ page: 99, now: NOW }));
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(PUBLISHED);
    expect(beyond.page).toBe(99);
    expect(beyond.pageCount).toBe(Math.ceil(PUBLISHED / 24));
  });
});

describe("filter validation", () => {
  test("negative, NaN, non-integer and min>max prices are dropped into ignored, never thrown", () => {
    const { service } = setup();
    const all = unwrap(service.list({ now: NOW })).total;
    const cases: [ListingQuery, string[]][] = [
      [{ minPriceCents: -1 }, ["minPriceCents"]],
      [{ maxPriceCents: Number.NaN }, ["maxPriceCents"]],
      [{ minPriceCents: 10.5 }, ["minPriceCents"]],
      [{ minPriceCents: Number.POSITIVE_INFINITY }, ["minPriceCents"]],
      [{ minPriceCents: 5000, maxPriceCents: 1000 }, ["minPriceCents", "maxPriceCents"]],
      [{ minRating: 5 as unknown as 4 }, ["minRating"]],
      [{ brandSlugs: ["no-such-brand"] }, ["brandSlugs"]],
      [{ brandSlugs: "northloom" as unknown as string[] }, ["brandSlugs"]],
    ];
    for (const [query, ignored] of cases) {
      const r = unwrap(service.list({ ...query, now: NOW }));
      expect({ query, ignored: r.ignored }).toEqual({ query, ignored });
      expect(r.total).toBe(all);
    }
  });

  test("a valid brand next to an unknown one still filters", () => {
    const { db, service } = setup();
    const r = unwrap(service.list({ brandSlugs: ["northloom", "nope"], now: NOW }));
    expect(r.ignored).toEqual(["brandSlugs"]);
    expect(r.total).toBe(facts(db).filter((f) => f.brandSlug === "northloom").length);
    expect(r.facets.brands.find((b) => b.value === "northloom")?.selected).toBe(true);
  });

  test("hostile strings are bound parameters, not SQL", () => {
    const { service } = setup();
    const r = service.list({ categorySlug: "' OR 1=1 --", now: NOW });
    expect(r.ok).toBe(false);
    const b = unwrap(service.list({ brandSlugs: ["' OR '1'='1", "\"); DROP TABLE products; --"], ids: ["' OR 1=1 --"], now: NOW }));
    expect(b.total).toBe(0);
    expect(unwrap(service.list({ now: NOW })).total).toBe(PUBLISHED);
  });
});

describe("categories", () => {
  test("unknown category slug is NOT_FOUND", () => {
    const { service } = setup();
    const r = service.list({ categorySlug: "no-such-category", now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });

  test("a department includes its children; a leaf lists its siblings as facet buckets", () => {
    const { db, service } = setup();
    const all = facts(db);
    const dept = db
      .query<{ id: string; slug: string }, []>("SELECT id, slug FROM categories WHERE parent_id IS NULL ORDER BY sort_order, id LIMIT 1")
      .get();
    if (dept === null) throw new Error("no department");
    const r = unwrap(service.list({ categorySlug: dept.slug, pageSize: 48, now: NOW }));
    expect(r.total).toBe(all.filter((f) => f.departmentId === dept.id).length);
    expect(r.total).toBeGreaterThan(0);
    const children = db.query<{ slug: string }, [string]>("SELECT slug FROM categories WHERE parent_id = ?").all(dept.id);
    expect(r.facets.categories.map((b) => b.value).sort()).toEqual(children.map((c) => c.slug).sort());
    expect(r.facets.categories.every((b) => !b.selected)).toBe(true);

    const leaf = r.facets.categories[0];
    if (leaf === undefined) throw new Error("no leaf");
    const lr = unwrap(service.list({ categorySlug: leaf.value, now: NOW }));
    expect(lr.total).toBe(leaf.count);
    expect(lr.facets.categories.map((b) => b.value)).toEqual(r.facets.categories.map((b) => b.value));
    expect(lr.facets.categories.find((b) => b.value === leaf.value)?.selected).toBe(true);
  });

  test("root category facet lists departments with child-inclusive counts", () => {
    const { db, service } = setup();
    const r = unwrap(service.list({ now: NOW }));
    const depts = db.query<{ id: string; slug: string }, []>("SELECT id, slug FROM categories WHERE parent_id IS NULL").all();
    const all = facts(db);
    for (const bucket of r.facets.categories) {
      const dept = depts.find((d) => d.slug === bucket.value);
      expect(dept).toBeDefined();
      expect(bucket.count).toBe(all.filter((f) => f.departmentId === dept?.id).length);
    }
    expect(r.facets.categories.reduce((s, b) => s + b.count, 0)).toBe(PUBLISHED);
  });

  test("categoryTree and breadcrumb", () => {
    const { db, service } = setup();
    const tree = service.categoryTree();
    expect(tree.length).toBe(8);
    expect(tree.every((d) => d.parentId === null && d.children.every((c) => c.parentId === d.id))).toBe(true);
    expect(tree.flatMap((d) => d.children).reduce((s, c) => s + c.productCount, 0)).toBe(PUBLISHED);
    const dept = tree[0];
    const child = dept?.children[0];
    if (dept === undefined || child === undefined) throw new Error("no child");
    expect(service.breadcrumb(child.slug).map((c) => c.slug)).toEqual([dept.slug, child.slug]);
    expect(service.breadcrumb(dept.slug).map((c) => c.slug)).toEqual([dept.slug]);
    expect(service.breadcrumb("nope")).toEqual([]);
    expect(service.breadcrumb("")).toEqual([]);
    // Unpublished products are not counted.
    db.query("UPDATE products SET published_at = '2099-01-01T00:00:00.000Z' WHERE category_id = ?").run(child.id);
    expect(service.categoryTree()[0]?.children[0]?.productCount).toBe(0);
  });

  test("categoryTree(now): counts at the injected now; invalid now falls back to the clock", () => {
    const { db, service } = setup();
    const child = service.categoryTree(NOW)[0]?.children[0];
    if (child === undefined) throw new Error("no child");
    const countAt = (now?: number) =>
      service.categoryTree(now).flatMap((d) => d.children).find((c) => c.id === child.id)?.productCount ?? -1;
    const before = countAt(NOW);
    expect(before).toBeGreaterThan(0);
    const publishAt = NOW + 60_000;
    db.query("UPDATE products SET published_at = ? WHERE category_id = ?").run(new Date(publishAt).toISOString(), child.id);
    expect(countAt(NOW)).toBe(0);
    expect(countAt(publishAt - 1)).toBe(0);
    const total = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM products WHERE category_id = ?").get(child.id)?.n;
    expect(countAt(publishAt)).toBe(total ?? -1);
    const wall = spyOn(Date, "now");
    try {
      service.categoryTree(NOW);
      expect(wall).not.toHaveBeenCalled();
    } finally {
      wall.mockRestore();
    }
    expect(countAt(Number.NaN)).toBe(countAt(undefined));
  });
});

/** Tiny deterministic PRNG (mulberry32) so the property test is reproducible. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("facets (property)", () => {
  test("every facet count equals the total of the listing with that facet applied", () => {
    const { db, service } = setup();
    const rnd = prng(33);
    const pick = <T,>(xs: readonly T[]): T | undefined => xs[Math.floor(rnd() * xs.length)];
    const catSlugs = db.query<{ slug: string }, []>("SELECT slug FROM categories ORDER BY slug").all().map((r) => r.slug);
    const brandSlugs = db.query<{ slug: string }, []>("SELECT slug FROM brands ORDER BY slug").all().map((r) => r.slug);
    const combos: ListingQuery[] = [];
    for (let i = 0; i < 12; i++) { // criterion asks for 3; 12 costs little
      const bucket = pick(PRICE_BUCKETS);
      combos.push({
        ...(rnd() < 0.6 ? { categorySlug: pick(catSlugs) } : {}),
        ...(rnd() < 0.6 ? { brandSlugs: [pick(brandSlugs) ?? "", pick(brandSlugs) ?? ""] } : {}),
        ...(rnd() < 0.5 && bucket !== undefined
          ? { minPriceCents: bucket.minCents, ...(bucket.maxCents === null ? {} : { maxPriceCents: bucket.maxCents }) }
          : {}),
        ...(rnd() < 0.5 ? { minRating: pick([1, 2, 3, 4] as const) } : {}),
        ...(rnd() < 0.5 ? { inStockOnly: true } : {}),
        ...(rnd() < 0.3 ? { dealsOnly: true } : {}),
      });
    }
    // Plus the empty filter set, which must hold too.
    combos.push({});
    for (const base of combos) {
      const r = unwrap(service.list({ ...base, now: NOW }));
      const total = (q: ListingQuery): number => unwrap(service.list({ ...q, now: NOW })).total;
      for (const b of r.facets.categories) expect({ base, b: b.value, n: total({ ...base, categorySlug: b.value }) }).toEqual({ base, b: b.value, n: b.count });
      for (const b of r.facets.brands) expect({ base, b: b.value, n: total({ ...base, brandSlugs: [b.value] }) }).toEqual({ base, b: b.value, n: b.count });
      for (const b of r.facets.price) {
        const { minPriceCents: _a, maxPriceCents: _b, ...rest } = base;
        void _a;
        void _b;
        const q: ListingQuery = { ...rest, minPriceCents: b.value.minCents, ...(b.value.maxCents === null ? {} : { maxPriceCents: b.value.maxCents }) };
        expect({ base, b: b.label, n: total(q) }).toEqual({ base, b: b.label, n: b.count });
      }
      for (const b of r.facets.rating) expect({ base, b: b.value, n: total({ ...base, minRating: b.value }) }).toEqual({ base, b: b.value, n: b.count });
      expect(r.facets.inStock).toBe(total({ ...base, inStockOnly: true }));
      // Selected flags mirror the query.
      if (base.minRating !== undefined && r.facets.rating.length > 0) {
        expect(r.facets.rating.filter((b) => b.selected).map((b) => b.value)).toEqual([base.minRating]);
      }
    }
  });

  test("price buckets cover every product once and rating thresholds are nested", () => {
    const { service } = setup();
    const r = unwrap(service.list({ now: NOW }));
    expect(r.facets.price.reduce((s, b) => s + b.count, 0)).toBe(PUBLISHED);
    const counts = r.facets.rating.map((b) => b.count);
    expect(r.facets.rating.map((b) => b.value)).toEqual([4, 3, 2, 1]);
    for (let i = 1; i < counts.length; i++) expect((counts[i] ?? 0) >= (counts[i - 1] ?? 0)).toBe(true);
    expect(r.facets.inStock).toBe(PUBLISHED - SEED_CATALOG_STATS.outOfStock);
  });
});

describe("publishing", () => {
  test("unpublished products are never listed, counted or collected", () => {
    const { db, service } = setup({ orders: true });
    const target = facts(db).find((f) => f.listPrice !== null && f.listPrice > f.price && f.units > 0 && f.ratingCount >= 3);
    if (target === undefined) throw new Error("fixture: need a sold, reviewed deal");
    db.query("UPDATE products SET published_at = '2026-11-08T00:00:00.000Z' WHERE id = ?").run(target.id);
    const r = unwrap(service.list({ pageSize: 48, page: 1, now: NOW }));
    expect(r.total).toBe(PUBLISHED - 1);
    expect(allIds(service, {})).not.toContain(target.id);
    expect(unwrap(service.list({ ids: [target.id], now: NOW })).total).toBe(0);
    expect(service.deals(48, NOW).map((p) => p.id)).not.toContain(target.id);
    expect(service.bestSellers(48, { now: NOW }).map((p) => p.id)).not.toContain(target.id);
    expect(service.newArrivals(48, NOW).map((p) => p.id)).not.toContain(target.id);
    expect(service.topRated(48, NOW).map((p) => p.id)).not.toContain(target.id);
    expect(service.rankInCategory(target.id, NOW)).toBeNull();
    // Visible once `now` passes published_at.
    const later = Date.parse("2026-11-09T00:00:00.000Z");
    expect(unwrap(service.list({ now: later })).total).toBe(PUBLISHED);
    expect(service.rankInCategory(target.id, later)).not.toBeNull();
  });
});

describe("publishedAt on listing summaries (T167 bx)", () => {
  test("every list() item carries its row's published_at; search ranks keep it", () => {
    const { db, service } = setup();
    const published = new Map(facts(db).map((f) => [f.id, f.publishedAt]));
    const r = unwrap(service.list({ now: NOW, pageSize: 48 }));
    expect(r.items.length).toBeGreaterThan(0);
    for (const item of r.items) expect(item.publishedAt).toBe(published.get(item.id));
    const ids = r.items.slice(0, 3).map((i) => i.id);
    const ranked = unwrap(service.list({ now: NOW, ids }));
    expect(ranked.items.map((i) => [i.rank, i.publishedAt])).toEqual(ids.map((id, i) => [i + 1, published.get(id)]));
  });

  test("raw columns still never leak (only the public publishedAt key is added)", () => {
    const { service } = setup();
    const item = unwrap(service.list({ now: NOW, pageSize: 1 })).items[0];
    expect(item).toBeDefined();
    for (const key of Object.keys(item ?? {})) expect(key).not.toMatch(/published_at|rating_sum|category_id|brand_id/);
  });

  test("beyond the last page: no items and no date lookup", () => {
    const { service } = setup();
    expect(unwrap(service.list({ now: NOW, page: 999 })).items).toEqual([]);
  });
});

describe("publishedAt on collection helpers (CLEANUP-P3 ch)", () => {
  test("deals, bestSellers, newArrivals and topRated items carry their row's published_at", () => {
    const { db, service } = setup({ orders: true });
    const published = new Map(facts(db).map((f) => [f.id, f.publishedAt]));
    const collections = {
      deals: service.deals(48, NOW),
      bestSellers: service.bestSellers(48, { now: NOW }),
      newArrivals: service.newArrivals(48, NOW),
      topRated: service.topRated(48, NOW),
    };
    for (const [name, items] of Object.entries(collections)) {
      expect({ name, count: items.length > 0 }).toEqual({ name, count: true });
      for (const item of items) {
        expect({ name, id: item.id, publishedAt: item.publishedAt }).toEqual({ name, id: item.id, publishedAt: published.get(item.id) });
      }
    }
  });

  test("bestSellers keeps rank alongside publishedAt; order unchanged", () => {
    const { db, service } = setup({ orders: true });
    const best = service.bestSellers(5, { now: NOW });
    expect(best.map((p) => p.rank)).toEqual(best.map((_, i) => i + 1));
    for (const p of best) expect(typeof p.publishedAt).toBe("string");
    const all = facts(db);
    expect(service.newArrivals(5, NOW).map((p) => [p.id, p.publishedAt])).toEqual(
      oracleOrder(all, "newest").slice(0, 5).map((id) => [id, all.find((f) => f.id === id)?.publishedAt]),
    );
  });

  test("no results: empty array and no throw", () => {
    const { service } = setup();
    expect(service.bestSellers(5, { now: NOW, categoryId: "cat_nope" })).toEqual([]);
  });
});

describe("collections", () => {
  test("deals: only list price above price, biggest saving first", () => {
    const { service } = setup();
    const deals = service.deals(48, NOW);
    expect(deals.length).toBe(Math.min(48, SEED_CATALOG_STATS.deals));
    const saving = deals.map((p) => ((p.listPriceCents ?? 0) - p.priceCents) / (p.listPriceCents ?? 1));
    for (const p of deals) expect((p.listPriceCents ?? 0) > p.priceCents).toBe(true);
    for (let i = 1; i < saving.length; i++) expect((saving[i] ?? 0) <= (saving[i - 1] ?? 0)).toBe(true);
    expect(service.deals(undefined, NOW).length).toBe(12);
    expect(service.deals(3, NOW).length).toBe(3);
    expect(service.deals(0, NOW).length).toBe(1);
    expect(service.deals(Number.NaN, NOW).length).toBe(12);
  });

  test("dealsOnly filter matches the deals collection set", () => {
    const { service } = setup();
    const r = unwrap(service.list({ dealsOnly: true, pageSize: 48, now: NOW }));
    expect(new Set(r.items.map((i) => i.id))).toEqual(new Set(service.deals(48, NOW).map((p) => p.id)));
  });

  test("bestSellers ignores payment_failed and cancelled orders and sets rank", () => {
    const { db, service } = setup();
    const [a, b, c] = facts(db).map((f) => f.id).sort();
    if (a === undefined || b === undefined || c === undefined) throw new Error("fixture");
    insertOrder(db, [[a, 2], [b, 5]]);
    insertOrder(db, [[a, 2]], "paid", "delivered");
    insertOrder(db, [[c, 50]], "payment_failed");
    insertOrder(db, [[c, 50]], "paid", "cancelled");
    const best = service.bestSellers(10, { now: NOW });
    expect(best.map((p) => p.id)).toEqual([b, a]);
    expect(best.map((p) => p.rank)).toEqual([1, 2]);
    expect(service.rankInCategory(c, NOW)).toBeNull();
  });

  test("bestSellers by category includes a department's children", () => {
    const { db, service } = setup({ orders: true });
    const all = facts(db).filter((f) => f.units > 0);
    const deptId = all[0]?.departmentId;
    if (deptId === undefined || deptId === null) throw new Error("fixture");
    const expected = oracleOrder(all.filter((f) => f.departmentId === deptId), "best_selling");
    expect(service.bestSellers(48, { categoryId: deptId, now: NOW }).map((p) => p.id)).toEqual(expected);
    expect(service.bestSellers(48, { categoryId: "cat_nope", now: NOW })).toEqual([]);
  });

  test("bestSellers is empty without sales", () => {
    const { service } = setup();
    expect(service.bestSellers(10, { now: NOW })).toEqual([]);
  });

  test("newArrivals newest first; topRated needs the minimum review count", () => {
    const { db, service } = setup();
    const all = facts(db);
    expect(service.newArrivals(48, NOW).map((p) => p.id)).toEqual(oracleOrder(all, "newest").slice(0, 48));
    expect(TOP_RATED_MIN_REVIEWS).toBe(3);
    const top = service.topRated(48, NOW);
    expect(top.length).toBe(Math.min(48, all.filter((f) => f.ratingCount >= 3).length));
    expect(top.every((p) => (p.ratingCount ?? 0) >= 3)).toBe(true);
    expect(top.map((p) => p.id)).toEqual(oracleOrder(all.filter((f) => f.ratingCount >= 3), "rating").slice(0, 48));
  });
});

describe("rankInCategory", () => {
  test("null without sales or for unknown ids; otherwise rank within the leaf category", () => {
    const { db, service } = setup();
    const all = facts(db);
    const leaf = all.find((f) => all.filter((g) => g.categoryId === f.categoryId).length >= 3)?.categoryId;
    const inLeaf = all.filter((f) => f.categoryId === leaf).map((f) => f.id).sort();
    const [x, y, z] = inLeaf;
    if (x === undefined || y === undefined || z === undefined) throw new Error("fixture");
    expect(service.rankInCategory(x, NOW)).toBeNull();
    expect(service.rankInCategory("prod_nope", NOW)).toBeNull();
    expect(service.rankInCategory("", NOW)).toBeNull();
    insertOrder(db, [[x, 1], [y, 4], [z, 1]]);
    const cat = db.query<{ name: string; slug: string }, [string]>("SELECT name, slug FROM categories WHERE id = ?").get(leaf ?? "");
    expect(service.rankInCategory(y, NOW)).toEqual({ rank: 1, categoryName: cat?.name ?? "", categorySlug: cat?.slug ?? "" });
    expect(service.rankInCategory(x, NOW)?.rank).toBe(2); // tie with z broken by id
    expect(service.rankInCategory(z, NOW)?.rank).toBe(3);
  });
});

describe("hydration", () => {
  const ALLOWED = new Set([
    "id", "slug", "name", "description", "priceCents", "currency", "imageUrl", "stock", "listPriceCents",
    "ratingCount", "ratingAvg", "brandName", "brandSlug", "categoryName", "categorySlug", "isFeatured", "sku", "rank",
    // T167 (bx) + CLEANUP-P3 (ch): list() and collection items carry the public ISO publish date for the "New" badge.
    "publishedAt",
  ]);

  test("items expose only public Product keys (no rating_sum, session_id, cost)", () => {
    const { service } = setup({ orders: true });
    const items = [
      ...unwrap(service.list({ pageSize: 48, now: NOW })).items,
      ...service.deals(48, NOW),
      ...service.bestSellers(48, { now: NOW }),
      ...service.newArrivals(48, NOW),
      ...service.topRated(48, NOW),
    ];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      for (const key of Object.keys(item)) expect({ key, ok: ALLOWED.has(key) }).toEqual({ key, ok: true });
    }
  });
});

describe("getListingService", () => {
  test("returns a cached singleton over the shared database", () => {
    const previous = process.env.DATABASE_PATH;
    closeDatabase();
    process.env.DATABASE_PATH = ":memory:";
    try {
      const a = getListingService();
      expect(getListingService()).toBe(a);
      expect(unwrap(a.list({ now: NOW })).total).toBe(0);
      closeDatabase();
      expect(getListingService()).not.toBe(a);
    } finally {
      closeDatabase();
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
    }
  });
});

describe("facets.deals (T91, additive)", () => {
  const isDeal = (f: Fact): boolean => f.listPrice !== null && f.listPrice > f.price;

  test("counts discounted products in the current result set (seeded :memory: DB)", () => {
    const { db, service } = setup();
    const all = facts(db);
    const root = unwrap(service.list({ now: NOW }));
    expect(root.facets.deals).toBe(all.filter(isDeal).length);
    expect(root.facets.deals ?? 0).toBeGreaterThan(0);

    // Under a department filter.
    const dept = all.find((f) => f.departmentId !== null)?.departmentId ?? "";
    const slug = db.query<{ slug: string }, [string]>("SELECT slug FROM categories WHERE id = ?").get(dept)?.slug ?? "";
    const inDept = unwrap(service.list({ categorySlug: slug, now: NOW }));
    expect(inDept.facets.deals).toBe(all.filter((f) => f.departmentId === dept && isDeal(f)).length);

    // Under in-stock + price filters.
    const filtered = unwrap(service.list({ inStockOnly: true, maxPriceCents: 9999, now: NOW }));
    expect(filtered.facets.deals).toBe(all.filter((f) => f.stock > 0 && f.price <= 9999 && isDeal(f)).length);
  });

  test("equals total when dealsOnly is applied; 0 for an empty result", () => {
    const { service } = setup();
    const r = unwrap(service.list({ dealsOnly: true, now: NOW }));
    expect(r.facets.deals).toBe(r.total);
    expect(unwrap(service.list({ ids: [], now: NOW })).facets.deals).toBe(0);
  });

  test("tracks writes: making a product a deal raises the count by one; list_price <= price is not a deal", () => {
    const { db, service } = setup();
    const before = unwrap(service.list({ now: NOW })).facets.deals ?? 0;
    const target = facts(db).find((f) => !isDeal(f));
    if (target === undefined) throw new Error("seed has no non-deal product");
    db.query("UPDATE products SET list_price_cents = price_cents WHERE id = ?").run(target.id);
    expect(unwrap(service.list({ now: NOW })).facets.deals).toBe(before);
    db.query("UPDATE products SET list_price_cents = price_cents + 1 WHERE id = ?").run(target.id);
    expect(unwrap(service.list({ now: NOW })).facets.deals).toBe(before + 1);
  });

  test("unpublished deals are not counted", () => {
    const { db, service } = setup();
    const before = unwrap(service.list({ now: NOW })).facets.deals ?? 0;
    const deal = facts(db).find(isDeal);
    if (deal === undefined) throw new Error("seed has no deal");
    db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(deal.id);
    expect(unwrap(service.list({ now: NOW })).facets.deals).toBe(before - 1);
  });
});
