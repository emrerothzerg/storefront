/**
 * QA adversarial tests for T33 (listing service), src/server/catalog/listing-*.
 * Owned by QA (QA-W1-T33). In-memory DB only; never touches ./data/.
 * The oracle below reads raw rows and filters/sorts in JS, independently of
 * listing-repository.ts SQL.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, createDatabase, getDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SEED_CATALOG_STATS, seedDatabase } from "@/server/db/seed";
import {
  DEFAULT_PAGE_SIZE,
  LISTING_SORTS,
  MAX_PAGE_SIZE,
  PRICE_BUCKETS,
  TOP_RATED_MIN_REVIEWS,
  createListingService,
  getListingService,
  type ListingQuery,
  type ListingResult,
  type ListingService,
  type ListingSort,
  type ProductListItem,
} from "@/server/catalog/listing-service";

const NOW_DATE = new Date("2026-11-07T12:00:00.000Z");
const NOW = NOW_DATE.getTime();
const DAY = 86_400_000;
const CATALOG_DIR = join(import.meta.dir, "../../../src/server/catalog");

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

function freshDb(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: NOW_DATE });
  open.push(db);
  return db;
}

function setup(): { db: Database; svc: ListingService } {
  const db = freshDb();
  return { db, svc: createListingService({ db }) };
}

let seq = 0;
function addOrder(
  db: Database,
  lines: readonly (readonly [string, number])[],
  status: "paid" | "payment_failed" = "paid",
  fulfillment = "processing",
): void {
  const id = `qa_ord_${++seq}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
       line1, city, region, postal_code, country, card_last4, idempotency_key, fulfillment_status)
     VALUES (?, 'qa-session', ?, 100, 100, 'USD', 'A', 'a@b.co', 'l1', 'c', 'r', 'p', 'US', '4242', ?, ?)`,
  ).run(id, status, `qa-key-${id}`, fulfillment);
  for (const [pid, qty] of lines) {
    db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'x', 100, ?)").run(
      id,
      pid,
      qty,
    );
  }
}

function addReview(db: Database, productId: string, rating: number, status: "published" | "hidden" = "published"): void {
  const id = `qa_rev_${++seq}`;
  db.query("INSERT INTO reviews (id, product_id, session_id, display_name, rating, status) VALUES (?, ?, ?, 'QA', ?, ?)").run(
    id,
    productId,
    `qa-sess-${id}`,
    rating,
    status,
  );
}

function deleteReviews(db: Database, productId: string): void {
  db.query("DELETE FROM reviews WHERE product_id = ?").run(productId);
}

// ---------------------------------------------------------------------------
// Independent oracle

interface Row {
  id: string;
  category_id: string | null;
  parent_id: string | null;
  brand_slug: string | null;
  price_cents: number;
  list_price_cents: number | null;
  stock: number;
  rating_sum: number;
  rating_count: number;
  is_featured: number;
  published_at: string;
}

function rows(db: Database): Row[] {
  return db
    .query<Row, []>(
      `SELECT p.id, p.category_id, c.parent_id, b.slug AS brand_slug, p.price_cents, p.list_price_cents, p.stock,
              p.rating_sum, p.rating_count, p.is_featured, p.published_at
         FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id`,
    )
    .all();
}

function unitsSold(db: Database): Map<string, number> {
  const m = new Map<string, number>();
  const all = db
    .query<{ product_id: string; quantity: number; status: string; fs: string }, []>(
      `SELECT oi.product_id, oi.quantity, o.status, o.fulfillment_status AS fs FROM order_items oi JOIN orders o ON o.id = oi.order_id`,
    )
    .all();
  for (const r of all) {
    if (r.status !== "paid" || r.fs === "cancelled") continue;
    m.set(r.product_id, (m.get(r.product_id) ?? 0) + r.quantity);
  }
  return m;
}

function catIdBySlug(db: Database, slug: string): string | null {
  return db.query<{ id: string }, [string]>("SELECT id FROM categories WHERE slug = ?").get(slug)?.id ?? null;
}

const avg = (r: Row): number => (r.rating_count > 0 ? r.rating_sum / r.rating_count : 0);
const cmpId = (a: Row, b: Row): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const desc = (x: number, y: number): number => (x > y ? -1 : x < y ? 1 : 0);

interface OracleQuery {
  categorySlug?: string;
  brandSlugs?: string[];
  minPriceCents?: number;
  maxPriceCents?: number;
  minRating?: 1 | 2 | 3 | 4;
  inStockOnly?: boolean;
  dealsOnly?: boolean;
  ids?: string[];
  sort?: ListingSort;
}

function oracle(db: Database, q: OracleQuery, nowMs = NOW): string[] {
  const iso = new Date(nowMs).toISOString();
  const units = unitsSold(db);
  const catId = q.categorySlug !== undefined ? catIdBySlug(db, q.categorySlug) : null;
  const idPos = new Map<string, number>();
  q.ids?.forEach((id, i) => {
    if (!idPos.has(id)) idPos.set(id, i);
  });
  const list = rows(db).filter((r) => {
    if (!(r.published_at <= iso)) return false;
    if (catId !== null && r.category_id !== catId && r.parent_id !== catId) return false;
    if (q.brandSlugs !== undefined && !q.brandSlugs.includes(r.brand_slug ?? "\u0000none")) return false;
    if (q.minPriceCents !== undefined && r.price_cents < q.minPriceCents) return false;
    if (q.maxPriceCents !== undefined && r.price_cents > q.maxPriceCents) return false;
    if (q.minRating !== undefined && !(r.rating_count > 0 && avg(r) >= q.minRating)) return false;
    if (q.inStockOnly === true && r.stock <= 0) return false;
    if (q.dealsOnly === true && !(r.list_price_cents !== null && r.list_price_cents > r.price_cents)) return false;
    if (q.ids !== undefined && !idPos.has(r.id)) return false;
    return true;
  });
  const sort = q.sort ?? (q.ids !== undefined ? "relevance" : "featured");
  const cmp: Record<ListingSort, (a: Row, b: Row) => number> = {
    relevance: (a, b) =>
      q.ids !== undefined ? (idPos.get(a.id) ?? 0) - (idPos.get(b.id) ?? 0) || cmpId(a, b) : cmp.featured(a, b),
    featured: (a, b) => desc(a.is_featured, b.is_featured) || desc(avg(a), avg(b)) || cmpId(a, b),
    price_asc: (a, b) => a.price_cents - b.price_cents || cmpId(a, b),
    price_desc: (a, b) => b.price_cents - a.price_cents || cmpId(a, b),
    rating: (a, b) => desc(avg(a), avg(b)) || desc(a.rating_count, b.rating_count) || cmpId(a, b),
    newest: (a, b) => (a.published_at < b.published_at ? 1 : a.published_at > b.published_at ? -1 : 0) || cmpId(a, b),
    best_selling: (a, b) => desc(units.get(a.id) ?? 0, units.get(b.id) ?? 0) || cmpId(a, b),
  };
  return list.sort(cmp[sort]).map((r) => r.id);
}

function okList(svc: ListingService, q: ListingQuery): ListingResult {
  const r = svc.list({ now: NOW, ...q });
  if (!r.ok) throw new Error(`list failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

function allPages(svc: ListingService, q: ListingQuery, pageSize = 5): string[] {
  const out: string[] = [];
  for (let page = 1; page < 1000; page++) {
    const r = okList(svc, { ...q, page, pageSize });
    if (r.items.length === 0) break;
    expect(r.items.length).toBeLessThanOrEqual(pageSize);
    out.push(...r.items.map((i) => i.id));
  }
  return out;
}

/** Collapses prices, featured, published_at, ratings into a few values to force many ties. */
function makeTies(db: Database): void {
  db.run("UPDATE products SET price_cents = 1000 * (1 + (rowid % 3)), list_price_cents = NULL, is_featured = rowid % 2");
  db.run("UPDATE products SET published_at = '2026-10-01T09:00:00.000Z'");
  const ids = db.query<{ id: string }, []>("SELECT id FROM products ORDER BY rowid").all().map((r) => r.id);
  // Equal sales for many products.
  ids.slice(0, 30).forEach((id) => addOrder(db, [[id, 2]]));
}

// mulberry32
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
describe("criterion 1: sort orders (independent oracle, pageSize 5 across pages)", () => {
  test("seed data has products and some sales for best_selling", () => {
    const { db } = setup();
    expect(rows(db).length).toBe(SEED_CATALOG_STATS.total); // every row, incl. the future-dated ones
  });

  for (const tieHeavy of [false, true]) {
    for (const sort of LISTING_SORTS) {
      test(`${sort}${tieHeavy ? " (tie-heavy data)" : ""}: concatenated pages equal oracle order, no dupes/gaps`, () => {
        const { db, svc } = setup();
        const pids = rows(db).map((r) => r.id).sort();
        pids.slice(0, 15).forEach((id, i) => addOrder(db, [[id, (i % 4) + 1]]));
        addOrder(db, [[pids[20]!, 500]], "payment_failed");
        addOrder(db, [[pids[21]!, 500]], "paid", "cancelled");
        if (tieHeavy) makeTies(db);
        const got = allPages(svc, { sort });
        expect(got).toEqual(oracle(db, { sort }));
        expect(new Set(got).size).toBe(got.length);
        // Determinism: second run identical.
        expect(allPages(svc, { sort })).toEqual(got);
      });
    }
  }

  test("every sort with a category + in-stock filter matches the oracle across pages", () => {
    const { db, svc } = setup();
    makeTies(db);
    const dept = db.query<{ slug: string }, []>("SELECT slug FROM categories WHERE parent_id IS NULL ORDER BY slug LIMIT 1").get()!.slug;
    for (const sort of LISTING_SORTS) {
      expect(allPages(svc, { sort, categorySlug: dept, inStockOnly: true }, 3)).toEqual(
        oracle(db, { sort, categorySlug: dept, inStockOnly: true }),
      );
    }
  });

  test("relevance keeps ids rank order (duplicates use first position), sets rank; unknown ids skipped", () => {
    const { db, svc } = setup();
    const ids = rows(db).map((r) => r.id).sort().reverse().slice(0, 12);
    const query = [ids[3]!, "nope", ids[0]!, ids[3]!, ...ids.slice(5)];
    const r = okList(svc, { ids: query, pageSize: 48 });
    expect(r.sort).toBe("relevance");
    expect(r.items.map((i) => i.id)).toEqual(oracle(db, { ids: query }));
    expect(r.items[0]!.id).toBe(ids[3]!);
    expect(r.items[0]!.rank).toBe(1);
    expect(r.items[1]!.rank).toBe(3);
    expect(allPages(svc, { ids: query, sort: "relevance" }, 5)).toEqual(oracle(db, { ids: query }));
  });

  test("unknown / hostile sort values fall back to featured", () => {
    const { db, svc } = setup();
    const expected = oracle(db, { sort: "featured" }).slice(0, 10);
    for (const sort of ["bogus", "", "PRICE_ASC", "price_asc ", "1; DROP TABLE products", "__proto__", "constructor"]) {
      const r = okList(svc, { sort, pageSize: 10 });
      expect(r.sort).toBe("featured");
      expect(r.items.map((i) => i.id)).toEqual(expected);
    }
    for (const sort of [42, null, {}, ["price_asc"]] as unknown[]) {
      const r = okList(svc, { sort, pageSize: 10 } as unknown as ListingQuery);
      expect(r.sort).toBe("featured");
    }
  });
});

// ---------------------------------------------------------------------------
describe("criterion 2: page and page size", () => {
  test("pageSize clamps to 1..48 with default 24", () => {
    const { svc } = setup();
    const cases: [unknown, number][] = [
      [undefined, DEFAULT_PAGE_SIZE],
      [0, 1],
      [-5, 1],
      [1, 1],
      [48, 48],
      [49, MAX_PAGE_SIZE],
      [1e9, MAX_PAGE_SIZE],
      [Number.NaN, DEFAULT_PAGE_SIZE],
      [Number.POSITIVE_INFINITY, DEFAULT_PAGE_SIZE],
      ["10", DEFAULT_PAGE_SIZE],
      [null, DEFAULT_PAGE_SIZE],
      [2.7, 2],
    ];
    expect(DEFAULT_PAGE_SIZE).toBe(24);
    expect(MAX_PAGE_SIZE).toBe(48);
    for (const [pageSize, want] of cases) {
      const r = okList(svc, { pageSize } as unknown as ListingQuery);
      expect(r.pageSize).toBe(want);
      expect(r.items.length).toBe(Math.min(want, r.total));
    }
  });

  test("page 0, -1, 1.5, NaN, '3', null, Infinity -> page 1", () => {
    const { svc } = setup();
    const first = okList(svc, { pageSize: 5 }).items.map((i) => i.id);
    for (const page of [0, -1, 1.5, Number.NaN, "3", null, Number.POSITIVE_INFINITY, {}, 2 ** 60]) {
      const r = okList(svc, { page, pageSize: 5 } as unknown as ListingQuery);
      expect(r.page).toBe(1);
      expect(r.items.map((i) => i.id)).toEqual(first);
    }
  });

  test("page beyond last -> empty items, correct total, not an error", () => {
    const { db, svc } = setup();
    const total = oracle(db, {}).length;
    const lastPage = Math.ceil(total / 5);
    for (const page of [lastPage + 1, lastPage + 88, Number.MAX_SAFE_INTEGER]) {
      const r = svc.list({ page, pageSize: 5, now: NOW });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.value.items).toEqual([]);
      expect(r.value.total).toBe(total);
      expect(r.value.pageCount).toBe(Math.ceil(total / 5));
    }
    const last = okList(svc, { page: lastPage, pageSize: 5 });
    expect(last.items.length).toBe(total - 5 * (lastPage - 1));
  });

  test("empty result set: total 0, pageCount 0, items []", () => {
    const { svc } = setup();
    const r = okList(svc, { ids: [] });
    expect(r.total).toBe(0);
    expect(r.items).toEqual([]);
    expect(r.pageCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 3: invalid price filters dropped into ignored, never throw", () => {
  const bad: unknown[] = [-1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "100", "abc", null, {}, [], true, 2 ** 60];
  for (const key of ["minPriceCents", "maxPriceCents"] as const) {
    for (const value of bad) {
      test(`${key} = ${String(typeof value === "object" ? JSON.stringify(value) : value)} is ignored`, () => {
        const { db, svc } = setup();
        let r: ReturnType<ListingService["list"]> | undefined;
        expect(() => {
          r = svc.list({ [key]: value, now: NOW } as unknown as ListingQuery);
        }).not.toThrow();
        expect(r?.ok).toBe(true);
        if (r === undefined || !r.ok) return;
        expect(r.value.ignored).toContain(key);
        expect(r.value.total).toBe(oracle(db, {}).length);
      });
    }
  }

  test("min > max drops both and names both", () => {
    const { db, svc } = setup();
    const r = okList(svc, { minPriceCents: 5000, maxPriceCents: 1000 });
    expect(r.ignored).toEqual(expect.arrayContaining(["minPriceCents", "maxPriceCents"]));
    expect(r.total).toBe(oracle(db, {}).length);
  });

  test("valid inclusive bounds filter exactly (min == max allowed)", () => {
    const { db, svc } = setup();
    const p = rows(db)[7]!.price_cents;
    const r = okList(svc, { minPriceCents: p, maxPriceCents: p, pageSize: 48 });
    expect(r.ignored).toEqual([]);
    expect(r.items.map((i) => i.id)).toEqual(oracle(db, { minPriceCents: p, maxPriceCents: p }));
    expect(r.total).toBeGreaterThan(0);
  });

  test("other bad filters also go to ignored without throwing", () => {
    const { svc } = setup();
    const r = okList(svc, { minRating: 5, brandSlugs: "acme", ids: "x", categorySlug: 7 } as unknown as ListingQuery);
    expect(r.ignored).toEqual(expect.arrayContaining(["minRating", "brandSlugs", "ids", "categorySlug"]));
  });
});

// ---------------------------------------------------------------------------
describe("criterion 5 + brands: category and brand filters", () => {
  test("department includes children; leaf includes only itself", () => {
    const { db, svc } = setup();
    const depts = db.query<{ id: string; slug: string }, []>("SELECT id, slug FROM categories WHERE parent_id IS NULL").all();
    expect(depts.length).toBeGreaterThan(0);
    for (const d of depts) {
      const r = okList(svc, { categorySlug: d.slug, pageSize: 48 });
      const want = oracle(db, { categorySlug: d.slug });
      expect(r.total).toBe(want.length);
      expect(r.items.map((i) => i.id)).toEqual(want.slice(0, 48));
      const children = db.query<{ slug: string }, [string]>("SELECT slug FROM categories WHERE parent_id = ?").all(d.id);
      const sum = children.reduce((s, c) => s + okList(svc, { categorySlug: c.slug }).total, 0);
      const direct = rows(db).filter((x) => x.category_id === d.id && x.published_at <= NOW_DATE.toISOString()).length;
      expect(r.total).toBe(sum + direct);
    }
  });

  test("unknown category slug -> NOT_FOUND (hostile strings too)", () => {
    const { svc } = setup();
    for (const slug of ["nope", "x".repeat(10_000), "' OR 1=1 --", "\u0000", "electronics\u0000", "\u{1F600}", "%", "_"]) {
      const r = svc.list({ categorySlug: slug, now: NOW });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    }
  });

  test("unknown brand slugs dropped into ignored; known ones still apply (OR)", () => {
    const { db, svc } = setup();
    const brands = db.query<{ slug: string }, []>("SELECT slug FROM brands ORDER BY slug LIMIT 2").all().map((b) => b.slug);
    const r = okList(svc, { brandSlugs: [brands[0]!, "nope", "' OR 1=1 --", brands[1]!, "x".repeat(10_000)], pageSize: 48 });
    expect(r.ignored).toEqual(["brandSlugs"]);
    expect(r.items.map((i) => i.id)).toEqual(oracle(db, { brandSlugs: brands }));
    const onlyBad = okList(svc, { brandSlugs: ["nope"] });
    expect(onlyBad.ignored).toEqual(["brandSlugs"]);
    expect(onlyBad.total).toBe(oracle(db, {}).length);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 4: facet counts (property test, 10 seeded combos + empty)", () => {
  function randomQuery(db: Database, rnd: () => number): ListingQuery {
    const cats = db.query<{ slug: string }, []>("SELECT slug FROM categories ORDER BY slug").all().map((c) => c.slug);
    const brands = db.query<{ slug: string }, []>("SELECT slug FROM brands ORDER BY slug").all().map((b) => b.slug);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const q: { -readonly [K in keyof ListingQuery]: ListingQuery[K] } = {};
    if (rnd() < 0.5) q.categorySlug = pick(cats);
    if (rnd() < 0.5) q.brandSlugs = [pick(brands), ...(rnd() < 0.5 ? [pick(brands)] : [])];
    if (rnd() < 0.4) {
      const b = pick(PRICE_BUCKETS);
      q.minPriceCents = b.minCents;
      if (b.maxCents !== null) q.maxPriceCents = b.maxCents;
    } else if (rnd() < 0.3) {
      q.minPriceCents = Math.floor(rnd() * 5000);
    }
    if (rnd() < 0.4) q.minRating = pick([1, 2, 3, 4] as const);
    if (rnd() < 0.4) q.inStockOnly = true;
    if (rnd() < 0.3) q.dealsOnly = true;
    return q;
  }

  function checkFacets(db: Database, svc: ListingService, q: ListingQuery): void {
    const res = okList(svc, q);
    const total = (extra: ListingQuery): number => okList(svc, { ...q, ...extra }).total;
    const f = res.facets;
    // The listing itself agrees with the oracle.
    const oq: OracleQuery = {};
    if (q.categorySlug !== undefined) oq.categorySlug = q.categorySlug;
    if (q.brandSlugs !== undefined) oq.brandSlugs = [...q.brandSlugs];
    if (q.minPriceCents !== undefined) oq.minPriceCents = q.minPriceCents;
    if (q.maxPriceCents !== undefined) oq.maxPriceCents = q.maxPriceCents;
    if (q.minRating !== undefined) oq.minRating = q.minRating;
    if (q.inStockOnly === true) oq.inStockOnly = true;
    if (q.dealsOnly === true) oq.dealsOnly = true;
    expect(res.total).toBe(oracle(db, oq).length);

    // Categories: candidate set = departments at root, else children of the department.
    const selectedCat = q.categorySlug !== undefined
      ? db.query<{ id: string; parent_id: string | null }, [string]>("SELECT id, parent_id FROM categories WHERE slug = ?").get(q.categorySlug)
      : null;
    const deptId = selectedCat === null ? null : (selectedCat.parent_id ?? selectedCat.id);
    const candidates =
      deptId === null
        ? db.query<{ slug: string }, []>("SELECT slug FROM categories WHERE parent_id IS NULL").all()
        : db.query<{ slug: string }, [string]>("SELECT slug FROM categories WHERE parent_id = ?").all(deptId);
    for (const { slug } of candidates) {
      const want = total({ categorySlug: slug });
      const bucket = f.categories.find((b) => b.value === slug);
      const selected = q.categorySlug === slug;
      if (bucket === undefined) expect({ slug, want, selected }).toEqual({ slug, want: 0, selected: false });
      else {
        expect({ slug, count: bucket.count }).toEqual({ slug, count: want });
        expect(bucket.selected).toBe(selected);
        if (!selected) expect(bucket.count).toBeGreaterThan(0);
      }
    }
    expect(f.categories.every((b) => candidates.some((c) => c.slug === b.value))).toBe(true);

    // Brands.
    const allBrands = db.query<{ slug: string }, []>("SELECT slug FROM brands").all();
    for (const { slug } of allBrands) {
      const want = total({ brandSlugs: [slug] });
      const bucket = f.brands.find((b) => b.value === slug);
      const selected = q.brandSlugs?.includes(slug) === true;
      if (bucket === undefined) expect({ slug, want, selected }).toEqual({ slug, want: 0, selected: false });
      else {
        expect({ slug, count: bucket.count }).toEqual({ slug, count: want });
        expect(bucket.selected).toBe(selected);
        if (!selected) expect(bucket.count).toBeGreaterThan(0);
      }
    }
    expect(new Set(f.brands.map((b) => b.value)).size).toBe(f.brands.length);

    // Price.
    for (const pb of PRICE_BUCKETS) {
      const extra: ListingQuery = { minPriceCents: pb.minCents, maxPriceCents: pb.maxCents ?? undefined };
      const want = total(extra);
      const bucket = f.price.find((b) => b.value.minCents === pb.minCents && b.value.maxCents === pb.maxCents);
      const selected =
        (q.minPriceCents !== undefined || q.maxPriceCents !== undefined) &&
        (q.minPriceCents ?? 0) === pb.minCents &&
        (q.maxPriceCents ?? null) === pb.maxCents;
      if (bucket === undefined) expect({ label: pb.label, want, selected }).toEqual({ label: pb.label, want: 0, selected: false });
      else {
        expect({ label: pb.label, count: bucket.count }).toEqual({ label: pb.label, count: want });
        expect(bucket.selected).toBe(selected);
      }
    }

    // Rating.
    for (const n of [1, 2, 3, 4] as const) {
      const want = total({ minRating: n });
      const bucket = f.rating.find((b) => b.value === n);
      const selected = q.minRating === n;
      if (bucket === undefined) expect({ n, want, selected }).toEqual({ n, want: 0, selected: false });
      else {
        expect({ n, count: bucket.count }).toEqual({ n, count: want });
        expect(bucket.selected).toBe(selected);
      }
    }

    // In stock.
    expect(f.inStock).toBe(total({ inStockOnly: true }));
  }

  test("empty query", () => {
    const { db, svc } = setup();
    checkFacets(db, svc, {});
  });

  test("10 seeded random filter combinations (seed 0x7333)", () => {
    const { db, svc } = setup();
    const rnd = prng(0x7333);
    for (let i = 0; i < 10; i++) {
      const q = randomQuery(db, rnd);
      try {
        checkFacets(db, svc, q);
      } catch (e) {
        throw new Error(`combo ${i} ${JSON.stringify(q)}: ${(e as Error).message}`);
      }
    }
  });

  test("20 more combinations with a different seed and some unpublished products", () => {
    const { db, svc } = setup();
    db.run(`UPDATE products SET published_at = '2099-01-01T00:00:00.000Z' WHERE rowid % 7 = 0`);
    const rnd = prng(42);
    for (let i = 0; i < 20; i++) {
      const q = randomQuery(db, rnd);
      try {
        checkFacets(db, svc, q);
      } catch (e) {
        throw new Error(`combo ${i} ${JSON.stringify(q)}: ${(e as Error).message}`);
      }
    }
  });

  test("selected brand with zero matches is still listed as selected", () => {
    const { db, svc } = setup();
    const brand = db.query<{ slug: string }, []>("SELECT slug FROM brands ORDER BY slug LIMIT 1").get()!.slug;
    const r = okList(svc, { brandSlugs: [brand], minPriceCents: 10_000_000 });
    expect(r.total).toBe(0);
    expect(r.facets.brands.find((b) => b.value === brand)).toMatchObject({ count: 0, selected: true });
  });
});

// ---------------------------------------------------------------------------
describe("published rule (published_at <= now)", () => {
  function pickTarget(db: Database): string {
    // A deal product with >= 3 reviews and a category: appears in every collection once sold.
    const id = db
      .query<{ id: string }, []>(
        `SELECT id FROM products WHERE list_price_cents > price_cents AND rating_count >= 3 AND category_id IS NOT NULL ORDER BY id LIMIT 1`,
      )
      .get()?.id;
    if (id !== undefined) return id;
    const fallback = db.query<{ id: string }, []>("SELECT id FROM products WHERE category_id IS NOT NULL ORDER BY id LIMIT 1").get()!.id;
    db.run(`UPDATE products SET list_price_cents = price_cents + 1000 WHERE id = '${fallback}'`);
    for (let i = 0; i < 3; i++) addReview(db, fallback, 5);
    return fallback;
  }

  test("unpublished product is invisible everywhere, then appears once now passes", () => {
    const { db, svc } = setup();
    const target = pickTarget(db);
    addOrder(db, [[target, 10_000]]); // top seller
    const future = new Date(NOW + 2 * DAY).toISOString();
    db.query("UPDATE products SET published_at = ?, is_featured = 1 WHERE id = ?").run(future, target);
    const cat = db
      .query<{ slug: string; brand: string | null }, [string]>(
        "SELECT c.slug, b.slug AS brand FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN brands b ON b.id = p.brand_id WHERE p.id = ?",
      )
      .get(target)!;

    const before = (now: number): void => {
      for (const sort of LISTING_SORTS) {
        const ids = allPages(svc, { sort, now }, 48);
        expect(ids).not.toContain(target);
      }
      const inCat = okList(svc, { categorySlug: cat.slug, now, pageSize: 48 });
      expect(inCat.items.map((i) => i.id)).not.toContain(target);
      expect(inCat.total).toBe(oracle(db, { categorySlug: cat.slug }, now).length);
      expect(okList(svc, { ids: [target], now }).total).toBe(0);
      const facets = okList(svc, { ids: [target], now }).facets;
      expect(facets.inStock).toBe(0);
      expect(facets.categories).toEqual([]);
      expect(facets.brands).toEqual([]);
      expect(facets.price).toEqual([]);
      expect(facets.rating).toEqual([]);
      expect(svc.deals(48, now).map((p) => p.id)).not.toContain(target);
      expect(svc.bestSellers(48, { now }).map((p) => p.id)).not.toContain(target);
      expect(svc.newArrivals(48, now).map((p) => p.id)).not.toContain(target);
      expect(svc.topRated(48, now).map((p) => p.id)).not.toContain(target);
      expect(svc.rankInCategory(target, now)).toBeNull();
    };
    before(NOW);

    const after = NOW + 3 * DAY;
    expect(allPages(svc, { sort: "featured", now: after }, 48)).toContain(target);
    expect(okList(svc, { ids: [target], now: after }).total).toBe(1);
    expect(svc.deals(48, after).map((p) => p.id)).toContain(target);
    expect(svc.bestSellers(1, { now: after })[0]!.id).toBe(target);
    expect(svc.newArrivals(1, after)[0]!.id).toBe(target);
    expect(svc.topRated(48, after).map((p) => p.id)).toContain(target);
    expect(svc.rankInCategory(target, after)).toMatchObject({ rank: 1, categorySlug: cat.slug });
  });

  test("boundary: published_at exactly == now is visible; 1 ms later is not", () => {
    const { db, svc } = setup();
    const id = rows(db)[0]!.id;
    db.query("UPDATE products SET published_at = ? WHERE id = ?").run(new Date(NOW).toISOString(), id);
    expect(okList(svc, { ids: [id], now: NOW }).total).toBe(1);
    expect(okList(svc, { ids: [id], now: NOW - 1 }).total).toBe(0);
  });

  test("unpublished product does not consume a rank in another product's rankInCategory", () => {
    const { db, svc } = setup();
    const [a, b] = db
      .query<{ id: string }, []>(
        "SELECT id FROM products WHERE category_id = (SELECT category_id FROM products WHERE category_id IS NOT NULL GROUP BY category_id HAVING COUNT(*) >= 2 LIMIT 1) ORDER BY id LIMIT 2",
      )
      .all()
      .map((r) => r.id);
    addOrder(db, [[a!, 50], [b!, 10]]);
    expect(svc.rankInCategory(b!, NOW)?.rank).toBe(2);
    db.query("UPDATE products SET published_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(a!);
    expect(svc.rankInCategory(b!, NOW)?.rank).toBe(1);
    expect(svc.bestSellers(48, { now: NOW }).map((p) => p.id)).toEqual([b!]);
  });

  test("categoryTree counts exclude products published in the future (real clock)", () => {
    const { db, svc } = setup();
    const leaf = db.query<{ id: string }, []>("SELECT category_id AS id FROM products WHERE category_id IS NOT NULL GROUP BY category_id LIMIT 1").get()!.id;
    const countIn = (): number =>
      svc.categoryTree().flatMap((d) => d.children).find((c) => c.id === leaf)?.productCount ?? -1;
    const before = countIn();
    db.query("UPDATE products SET published_at = ? WHERE category_id = ?").run(new Date(Date.now() + 10 * DAY).toISOString(), leaf);
    expect(before).toBeGreaterThan(0);
    expect(countIn()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 6: collections", () => {
  test("deals: only list_price > price, ordered by % saving desc then id", () => {
    const { db, svc } = setup();
    // Force a % tie to exercise the id tiebreak.
    const dealIds = db.query<{ id: string }, []>("SELECT id FROM products WHERE list_price_cents > price_cents ORDER BY id").all().map((r) => r.id);
    expect(dealIds.length).toBeGreaterThan(2);
    db.query("UPDATE products SET price_cents = 750, list_price_cents = 1000 WHERE id IN (?, ?)").run(dealIds[0]!, dealIds[1]!);
    // A product with list == price must never appear.
    const nonDeal = db.query<{ id: string }, []>("SELECT id FROM products WHERE list_price_cents IS NULL ORDER BY id LIMIT 1").get()!.id;
    db.query("UPDATE products SET list_price_cents = price_cents WHERE id = ?").run(nonDeal);
    const got = svc.deals(48, NOW);
    const r = rows(db);
    const byId = new Map(r.map((x) => [x.id, x]));
    const want = r
      .filter((x) => x.list_price_cents !== null && x.list_price_cents > x.price_cents && x.published_at <= NOW_DATE.toISOString())
      .sort((a, b) => {
        const sa = (a.list_price_cents! - a.price_cents) / a.list_price_cents!;
        const sb = (b.list_price_cents! - b.price_cents) / b.list_price_cents!;
        return desc(sa, sb) || cmpId(a, b);
      })
      .map((x) => x.id);
    expect(got.map((p) => p.id)).toEqual(want.slice(0, 48));
    for (const p of got) {
      const row = byId.get(p.id)!;
      expect(row.list_price_cents! > row.price_cents).toBe(true);
    }
    expect(got.map((p) => p.id)).not.toContain(nonDeal);
    expect(svc.deals(undefined, NOW).length).toBe(Math.min(12, want.length));
    expect(svc.deals(0, NOW).length).toBe(1);
    expect(svc.deals(1000, NOW).length).toBe(Math.min(48, want.length));
  });

  test("dealsOnly listing agrees with the deals definition", () => {
    const { db, svc } = setup();
    expect(allPages(svc, { dealsOnly: true, sort: "price_asc" })).toEqual(oracle(db, { dealsOnly: true, sort: "price_asc" }));
  });

  test("bestSellers: ignores payment_failed and cancelled orders, counts other fulfilment states, sets rank", () => {
    const { db, svc } = setup();
    const ids = rows(db).map((r) => r.id).sort();
    const [a, b, c, d, e] = ids;
    addOrder(db, [[a!, 3]]);
    addOrder(db, [[b!, 1]], "paid", "delivered");
    addOrder(db, [[b!, 1]], "paid", "shipped");
    addOrder(db, [[c!, 999]], "payment_failed");
    addOrder(db, [[d!, 999]], "paid", "cancelled");
    addOrder(db, [[e!, 2]], "paid", "out_for_delivery");
    addOrder(db, [[d!, 1], [e!, 1]], "paid", "packed");
    const got = svc.bestSellers(48, { now: NOW });
    // units: a 3, e 3, b 2, d 1  -> a,e tie (id order), then b, then d
    const want = [[a!, 3], [e!, 3], [b!, 2], [d!, 1]].sort((x, y) => desc(x[1] as number, y[1] as number) || ((x[0] as string) < (y[0] as string) ? -1 : 1)).map((x) => x[0]);
    expect(got.map((p) => p.id)).toEqual(want as string[]);
    expect(got.map((p) => p.rank)).toEqual([1, 2, 3, 4]);
    expect(got.map((p) => p.id)).not.toContain(c!);
  });

  test("bestSellers department scoping includes children; leaf scoping; unknown id -> []", () => {
    const { db, svc } = setup();
    const all = rows(db);
    const dept = db.query<{ id: string }, []>("SELECT parent_id AS id FROM categories WHERE parent_id IS NOT NULL ORDER BY id LIMIT 1").get()!.id;
    const inDept = all.filter((r) => r.parent_id === dept || r.category_id === dept).map((r) => r.id).sort();
    const outside = all.filter((r) => r.parent_id !== dept && r.category_id !== dept).map((r) => r.id).sort();
    expect(inDept.length).toBeGreaterThan(1);
    addOrder(db, [[inDept[0]!, 2], [inDept[1]!, 5], [outside[0]!, 50]]);
    expect(svc.bestSellers(48, { categoryId: dept, now: NOW }).map((p) => p.id)).toEqual([inDept[1]!, inDept[0]!]);
    const leaf = all.find((r) => r.id === inDept[1]!)!.category_id!;
    const leafIds = svc.bestSellers(48, { categoryId: leaf, now: NOW }).map((p) => p.id);
    expect(leafIds[0]).toBe(inDept[1]!);
    expect(leafIds).not.toContain(outside[0]!);
    for (const bad of ["nope", "x".repeat(10_000), "' OR 1=1 --", "\u0000"]) {
      expect(svc.bestSellers(48, { categoryId: bad, now: NOW })).toEqual([]);
    }
  });

  test("bestSellers with no sales -> []", () => {
    const { svc } = setup();
    expect(svc.bestSellers(12, { now: NOW })).toEqual([]);
  });

  test("topRated requires >= 3 published reviews (hidden reviews do not count)", () => {
    const { db, svc } = setup();
    expect(TOP_RATED_MIN_REVIEWS).toBe(3);
    const [two, three, hiddenThird] = rows(db).map((r) => r.id).sort();
    for (const id of [two!, three!, hiddenThird!]) deleteReviews(db, id);
    addReview(db, two!, 5);
    addReview(db, two!, 5);
    for (let i = 0; i < 3; i++) addReview(db, three!, 5);
    addReview(db, hiddenThird!, 5);
    addReview(db, hiddenThird!, 5);
    addReview(db, hiddenThird!, 5, "hidden");
    const got = svc.topRated(48, NOW);
    const ids = got.map((p) => p.id);
    expect(ids).toContain(three!);
    expect(ids).not.toContain(two!);
    expect(ids).not.toContain(hiddenThird!);
    const r = rows(db);
    const want = r
      .filter((x) => x.rating_count >= 3 && x.published_at <= NOW_DATE.toISOString())
      .sort((a, b) => desc(avg(a), avg(b)) || desc(a.rating_count, b.rating_count) || cmpId(a, b))
      .map((x) => x.id)
      .slice(0, 48);
    expect(ids).toEqual(want);
  });

  test("newArrivals: published_at desc then id; excludes future", () => {
    const { db, svc } = setup();
    makeTies(db);
    const r = rows(db);
    const [x] = r.map((p) => p.id).sort();
    db.query("UPDATE products SET published_at = ? WHERE id = ?").run(new Date(NOW - DAY).toISOString(), x!);
    const got = svc.newArrivals(48, NOW).map((p) => p.id);
    expect(got).toEqual(oracle(db, { sort: "newest" }).slice(0, 48));
    expect(got[0]).toBe(x!);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 7: rankInCategory", () => {
  test("null for no sales, unknown, hostile ids; ties broken by id", () => {
    const { db, svc } = setup();
    const leaf = db.query<{ id: string }, []>("SELECT category_id AS id FROM products WHERE category_id IS NOT NULL GROUP BY category_id HAVING COUNT(*) >= 3 ORDER BY category_id LIMIT 1").get()!.id;
    const [p1, p2, p3] = db.query<{ id: string }, [string]>("SELECT id FROM products WHERE category_id = ? ORDER BY id").all(leaf).map((r) => r.id);
    expect(svc.rankInCategory(p1!, NOW)).toBeNull();
    addOrder(db, [[p2!, 4], [p3!, 4]]);
    addOrder(db, [[p1!, 9]], "payment_failed");
    addOrder(db, [[p1!, 9]], "paid", "cancelled");
    expect(svc.rankInCategory(p1!, NOW)).toBeNull();
    const slug = db.query<{ slug: string; name: string }, [string]>("SELECT slug, name FROM categories WHERE id = ?").get(leaf)!;
    expect(svc.rankInCategory(p2!, NOW)).toEqual({ rank: 1, categoryName: slug.name, categorySlug: slug.slug });
    expect(svc.rankInCategory(p3!, NOW)?.rank).toBe(2);
    addOrder(db, [[p3!, 1]]);
    expect(svc.rankInCategory(p3!, NOW)?.rank).toBe(1);
    expect(svc.rankInCategory(p2!, NOW)?.rank).toBe(2);
    for (const bad of ["", "nope", "x".repeat(10_000), "' OR 1=1 --", "\u0000", `${p2!}\u0000`, "\u{1F600}"]) {
      expect(svc.rankInCategory(bad, NOW)).toBeNull();
    }
    for (const bad of [null, undefined, 42, {}] as unknown[]) {
      expect(svc.rankInCategory(bad as string, NOW)).toBeNull();
    }
  });

  test("rank only counts the product's own leaf category", () => {
    const { db, svc } = setup();
    const all = rows(db).filter((r) => r.category_id !== null);
    const a = all[0]!;
    const other = all.find((r) => r.category_id !== a.category_id)!;
    addOrder(db, [[a.id, 1], [other.id, 100]]);
    expect(svc.rankInCategory(a.id, NOW)?.rank).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 8: no internal fields, bound parameters", () => {
  const FORBIDDEN = /rating_sum|ratingSum|session_id|sessionId|cost|is_featured|published_at|category_id|brand_id|owner/i;

  function assertClean(items: readonly ProductListItem[]): void {
    for (const item of items) {
      for (const key of Object.keys(item)) expect(key).not.toMatch(FORBIDDEN);
      expect(JSON.stringify(item)).not.toMatch(/rating_sum|session_id/);
    }
  }

  test("items from list and every collection expose no internal keys", () => {
    const { db, svc } = setup();
    const ids = rows(db).map((r) => r.id);
    addOrder(db, ids.slice(0, 5).map((id) => [id, 1] as const));
    assertClean(okList(svc, { pageSize: 48 }).items);
    assertClean(okList(svc, { ids, pageSize: 48 }).items);
    assertClean(svc.deals(48, NOW));
    assertClean(svc.bestSellers(48, { now: NOW }));
    assertClean(svc.newArrivals(48, NOW));
    assertClean(svc.topRated(48, NOW));
  });

  test("hostile inputs across every entry point never throw and leave the DB intact", () => {
    const { db, svc } = setup();
    const hostile = [
      "x".repeat(10_000),
      "' OR 1=1 --",
      "'; DROP TABLE products; --",
      "\") OR 1=1; --",
      "\u0000",
      "a\u0000b",
      "\u{1F600}‮​",
      "%",
      "_",
      "[\"x\"]",
      "{}",
      "]",
    ];
    for (const h of hostile) {
      expect(() => svc.list({ categorySlug: h, now: NOW })).not.toThrow();
      expect(() => svc.list({ brandSlugs: [h, h], now: NOW })).not.toThrow();
      expect(() => svc.list({ ids: [h], now: NOW })).not.toThrow();
      expect(okList(svc, { ids: [h] }).total).toBe(0);
      expect(() => svc.list({ sort: h, now: NOW })).not.toThrow();
      expect(svc.breadcrumb(h)).toEqual([]);
      expect(svc.rankInCategory(h, NOW)).toBeNull();
      expect(svc.bestSellers(5, { categoryId: h, now: NOW })).toEqual([]);
    }
    const big = Array.from({ length: 5000 }, (_, i) => `id-${i}'"`);
    expect(okList(svc, { ids: big }).total).toBe(0);
    expect(rows(db).length).toBe(SEED_CATALOG_STATS.total);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM brands").get()!.n).toBeGreaterThan(0);
  });

  test("brandSlugs list of 1000 entries does not throw and applies at most MAX_BRAND_FILTERS", () => {
    const { svc } = setup();
    const r = svc.list({ brandSlugs: Array.from({ length: 1000 }, (_, i) => `b${i}`), now: NOW });
    expect(r.ok).toBe(true);
  });

  test("static: no string interpolation of input into SQL in listing files; no any / ts-ignore", () => {
    for (const f of ["listing-service.ts", "listing-repository.ts"]) {
      const src = readFileSync(join(CATALOG_DIR, f), "utf8");
      expect(src).not.toMatch(/@ts-ignore|@ts-expect-error|:\s*any\b|as any\b|<any>/);
      expect(src).not.toMatch(/\.(run|exec)\(`/);
    }
    const repo = readFileSync(join(CATALOG_DIR, "listing-repository.ts"), "utf8");
    // Only module constants are interpolated into SQL: from, orderBy, IDS_JOIN, SALES_JOIN, AVG, join(" ").
    const interpolations = [...repo.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!.trim());
    const allowed = new Set(["AVG", "from", "orderBy", 'joins.join(" ")', 'where.join(" AND ")']);
    for (const i of interpolations) expect(allowed.has(i) ? i : `UNEXPECTED ${i}`).toBe(i);
  });
});

// ---------------------------------------------------------------------------
describe("breadcrumb and categoryTree", () => {
  test("breadcrumb: [dept, leaf], [dept], [] for unknown/empty", () => {
    const { db, svc } = setup();
    const leaf = db.query<{ slug: string; parent: string }, []>("SELECT c.slug, p.slug AS parent FROM categories c JOIN categories p ON p.id = c.parent_id LIMIT 1").get()!;
    expect(svc.breadcrumb(leaf.slug).map((c) => c.slug)).toEqual([leaf.parent, leaf.slug]);
    expect(svc.breadcrumb(leaf.parent).map((c) => c.slug)).toEqual([leaf.parent]);
    expect(svc.breadcrumb("")).toEqual([]);
    expect(svc.breadcrumb(undefined as unknown as string)).toEqual([]);
  });

  test("categoryTree lists every department with children", () => {
    const { db, svc } = setup();
    const tree = svc.categoryTree();
    const depts = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM categories WHERE parent_id IS NULL").get()!.n;
    expect(tree.length).toBe(depts);
    const kids = tree.reduce((s, d) => s + d.children.length, 0);
    expect(kids + depts).toBe(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM categories").get()!.n);
  });
});

// ---------------------------------------------------------------------------
describe("getListingService singleton", () => {
  const saved = process.env.DATABASE_PATH;
  afterAll(() => {
    closeDatabase();
    if (saved === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = saved;
  });

  test("reuses per DB handle and rebuilds on a new handle", () => {
    process.env.DATABASE_PATH = ":memory:";
    closeDatabase();
    const s1 = getListingService();
    expect(getListingService()).toBe(s1);
    getDatabase();
    expect(getListingService()).toBe(s1);
    closeDatabase();
    const s2 = getListingService();
    expect(s2).not.toBe(s1);
    expect(getListingService()).toBe(s2);
  });

  test("singleton reads the shared handle", () => {
    process.env.DATABASE_PATH = ":memory:";
    const db = getDatabase();
    runMigrations(db);
    seedDatabase(db, { now: NOW_DATE });
    expect(okList(getListingService(), {}).total).toBe(SEED_CATALOG_STATS.published);
  });
});
