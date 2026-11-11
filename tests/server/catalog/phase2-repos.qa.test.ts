/**
 * QA (QA-W0-A / P2-A): catalog repositories v2 + domain types.
 * Criteria 5 (repositories) and 6 (types). Every DB is :memory:.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SEED_CATALOG_STATS, seedDatabase } from "@/server/db/seed";
import {
  MAX_LIST_LIMIT,
  parseBullets,
  parseImages,
  parseSpecs,
  recomputeProductRating,
  SqliteProductRepository,
} from "@/server/catalog/product-repository";
import { SqliteCategoryRepository } from "@/server/catalog/category-repository";
import { SqliteBrandRepository } from "@/server/catalog/brand-repository";
import { ERROR_CODES, type Product, type User } from "@/lib/types";

const ROOT = join(import.meta.dir, "..", "..", "..");
const NOW = new Date("2026-11-07T15:30:00.000Z");
const MVP_KEYS = ["currency", "description", "id", "imageUrl", "name", "priceCents", "slug", "stock"];
const OPTIONAL_KEYS = ["listPriceCents", "ratingCount", "ratingAvg", "brandName", "brandSlug", "categoryName", "categorySlug", "isFeatured", "sku", "publishedAt"];
/** FIX-P3-pages (D-T170-1): a bare row still gets `publishedAt` (the insert trigger fills it from created_at). */
const BARE_KEYS = [...MVP_KEYS, "publishedAt"].sort();

function seeded(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: NOW });
  return db;
}

function empty(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}

function plain(db: Database, id: string, extra: { bullets?: string; specs?: string; images?: string } = {}): void {
  db.query(
    "INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock, bullets, specs, images) VALUES (?, ?, ?, '', 100, 'USD', ?, 1, ?, ?, ?)",
  ).run(id, id, `Name ${id}`, `/images/products/${id}.svg`, extra.bullets ?? "[]", extra.specs ?? "[]", extra.images ?? "[]");
}

function noUndefinedValues(o: object): boolean {
  return Object.values(o).every((v) => v !== undefined);
}

describe("QA-A C5 product repository: card shape", () => {
  test("list(): every product has the 8 MVP keys, only known sparse extras, no undefined values", () => {
    const repo = new SqliteProductRepository(seeded());
    const all = repo.list();
    expect(all.length).toBe(SEED_CATALOG_STATS.total); // the repository list is unfiltered (incl. future-dated)
    for (const p of all) {
      const keys = Object.keys(p);
      for (const k of MVP_KEYS) expect(keys).toContain(k);
      for (const k of keys) expect([...MVP_KEYS, ...OPTIONAL_KEYS]).toContain(k);
      expect(noUndefinedValues(p)).toBe(true);
      expect(p.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // D-T170-1: summaries carry publishedAt
      expect("updatedAt" in p).toBe(false);
      if ("ratingCount" in p) {
        expect(p.ratingCount).toBeGreaterThan(0);
        expect(p.ratingAvg).toBeGreaterThanOrEqual(1);
        expect(p.ratingAvg).toBeLessThanOrEqual(5);
      }
      if ("isFeatured" in p) expect(p.isFeatured).toBe(true);
    }
    const names = all.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  test("a bare row (no brand/category/list price/reviews/sku) has exactly the 8 MVP keys", () => {
    const db = empty();
    plain(db, "bare");
    const repo = new SqliteProductRepository(db);
    for (const p of [repo.list()[0], repo.getById("bare"), repo.getBySlug("bare"), repo.getManyByIds(["bare"])[0]]) {
      expect(Object.keys(p ?? {}).sort()).toEqual(BARE_KEYS);
    }
    db.run("UPDATE products SET sku = '' WHERE id = 'bare'");
    expect(Object.keys(repo.getById("bare") ?? {}).sort()).toEqual(BARE_KEYS);
    // hidden reviews do not add rating keys
    db.run("INSERT INTO reviews (id, product_id, session_id, display_name, rating, status) VALUES ('r', 'bare', 's', 'A', 5, 'hidden')");
    expect(Object.keys(repo.getById("bare") ?? {}).sort()).toEqual(BARE_KEYS);
  });
});

describe("QA-A C5 getDetailBySlug", () => {
  test("seeded product returns full ProductDetail with parsed JSON, brand, leaf category, timestamps", () => {
    const db = seeded();
    const repo = new SqliteProductRepository(db);
    const d = repo.getDetailBySlug("canvas-tote-bag");
    if (d === null) throw new Error("missing");
    expect(Array.isArray(d.bullets) && d.bullets.length >= 3).toBe(true);
    expect(d.specs.every((s) => typeof s.label === "string" && typeof s.value === "string")).toBe(true);
    expect(d.images[0]).toEqual({ url: "/images/products/canvas-tote-bag.svg", alt: "Canvas Tote Bag" });
    expect(d.listPriceCents).toBeNull();
    expect(typeof d.ratingCount).toBe("number");
    expect(typeof d.ratingAvg).toBe("number");
    expect(d.brand?.slug).toBe("northloom");
    expect(d.category?.slug).toBe("bags-accessories");
    expect(d.category?.parentId).toBe("cat_clothing");
    expect(d.publishedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(d.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(noUndefinedValues(d)).toBe(true);
    for (const p of repo.list()) {
      const detail = repo.getDetailBySlug(p.slug);
      expect(detail?.id).toBe(p.id);
      expect(detail?.images.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("unknown / hostile slugs return null", () => {
    const repo = new SqliteProductRepository(seeded());
    for (const s of ["", "nope", "' OR 1=1 --", "%", "_", "canvas-tote-bag ", "CANVAS-TOTE-BAG", "x".repeat(10_000)]) {
      expect(repo.getDetailBySlug(s)).toBeNull();
    }
  });

  test("malformed JSON in bullets/specs/images never throws: [] (images fall back to the primary)", () => {
    const db = empty();
    const bad = ["{", "null", "42", '"str"', "{}", "[1, null, true]", '[[["deep"]]]', "\u0000", "", "[" + "[".repeat(5000)];
    let i = 0;
    for (const b of bad) {
      const id = `m${i++}`;
      plain(db, id, { bullets: b, specs: b, images: b });
      const d = new SqliteProductRepository(db).getDetailBySlug(id);
      expect(d?.bullets).toEqual([]);
      expect(d?.specs).toEqual([]);
      expect(d?.images).toEqual([{ url: `/images/products/${id}.svg`, alt: `Name ${id}` }]);
      expect(parseBullets(b)).toEqual([]);
      expect(parseSpecs(b)).toEqual([]);
      expect(parseImages(b)).toEqual([]);
    }
    // unsafe/odd image entries are dropped, not thrown
    expect(parseImages(JSON.stringify([{ url: "javascript:alert(1)" }, { url: "//evil.example.com/x.png" }, { url: "https://x.example.com" }, { url: 5 }, { url: "/ok.svg", alt: 3 }]))).toEqual([{ url: "/ok.svg", alt: "" }]);
    expect(parseSpecs(JSON.stringify([{ label: "a" }, { label: "a", value: 1 }, ["a", "b"], { label: "L", value: "V" }]))).toEqual([{ label: "L", value: "V" }]);
    expect(parseBullets(JSON.stringify(["", "  ", "ok", 1]))).toEqual(["ok"]);
  });
});

describe("QA-A C5 lists and limits", () => {
  test("listByCategory: department includes children; leaf only itself; unknown -> []", () => {
    const db = seeded();
    const repo = new SqliteProductRepository(db);
    const dept = repo.listByCategory("cat_electronics");
    const expectedDept = db
      .query<{ id: string }, []>("SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id WHERE c.parent_id = 'cat_electronics' OR c.id = 'cat_electronics'")
      .all()
      .map((r) => r.id)
      .sort();
    expect(dept.map((p) => p.id).sort()).toEqual(expectedDept);
    expect(dept.length).toBeGreaterThan(0);
    const leaf = repo.listByCategory("cat_audio");
    expect(leaf.length).toBeGreaterThan(0);
    expect(leaf.every((p) => p.categorySlug === "audio")).toBe(true);
    expect(repo.listByCategory("nope")).toEqual([]);
    expect(repo.listByCategory("' OR 1=1 --")).toEqual([]);
    expect(repo.listByCategory("cat_electronics", 2).length).toBe(2);
  });

  test("limits: non-positive / NaN / Infinity / fractional -> []; capped at 200", () => {
    const db = empty();
    for (let i = 0; i < 230; i++) {
      db.query(
        "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, list_price_cents, is_featured, published_at) VALUES (?, ?, ?, 100, 'USD', '/x.svg', 1, 200, 1, ?)",
      ).run(`p${i}`, `p${i}`, `P${i}`, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString());
      db.query("INSERT INTO reviews (id, product_id, session_id, display_name, rating) VALUES (?, ?, 's', 'A', 4)").run(`r${i}`, `p${i}`);
    }
    db.run("INSERT INTO categories (id, slug, name) VALUES ('d', 'd', 'D')");
    db.run("UPDATE products SET category_id = 'd'");
    const repo = new SqliteProductRepository(db);
    const fns: ((n: number) => Product[])[] = [
      (n) => repo.listFeatured(n),
      (n) => repo.listNewest(n),
      (n) => repo.listDeals(n),
      (n) => repo.listTopRated(n),
      (n) => repo.listByCategory("d", n),
    ];
    for (const f of fns) {
      for (const bad of [0, -1, -0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
        expect(f(bad)).toEqual([]);
      }
      expect(f(1).length).toBe(1);
      expect(f(200).length).toBe(200);
      expect(f(201).length).toBe(MAX_LIST_LIMIT);
      expect(f(Number.MAX_SAFE_INTEGER).length).toBe(200);
    }
    expect(repo.listByCategory("d").length).toBe(200);
    expect(MAX_LIST_LIMIT).toBe(200);
  });

  test("listFeatured/listNewest/listDeals/listTopRated order and filter correctly on the seed", () => {
    const db = seeded();
    const repo = new SqliteProductRepository(db);
    const featured = repo.listFeatured(50);
    expect(featured.length).toBe(SEED_CATALOG_STATS.featured);
    expect(featured.every((p) => p.isFeatured === true)).toBe(true);
    const newest = repo.listNewest(60).map((p) => repo.getDetailBySlug(p.slug)?.publishedAt ?? "");
    expect(newest).toEqual([...newest].sort().reverse());
    const deals = repo.listDeals(60);
    expect(deals.length).toBe(Math.min(60, SEED_CATALOG_STATS.deals));
    const pct = deals.map((p) => ((p.listPriceCents ?? 0) - p.priceCents) / (p.listPriceCents ?? 1));
    for (let i = 1; i < pct.length; i++) expect((pct[i - 1] ?? 0) + 1e-12).toBeGreaterThanOrEqual(pct[i] ?? 0);
    const top = repo.listTopRated(60);
    expect(top.every((p) => (p.ratingCount ?? 0) > 0)).toBe(true);
    const exact = top.map((p) => {
      const r = db.query<{ s: number; c: number }, [string]>("SELECT rating_sum AS s, rating_count AS c FROM products WHERE id = ?").get(p.id);
      return { avg: (r?.s ?? 0) / (r?.c ?? 1), c: r?.c ?? 0 };
    });
    for (let i = 1; i < exact.length; i++) {
      const a = exact[i - 1];
      const b = exact[i];
      if (a === undefined || b === undefined) continue;
      expect(a.avg > b.avg || (a.avg === b.avg && a.c >= b.c)).toBe(true);
    }
  });

  test("listSlugsWithUpdatedAt: every product, ordered by slug, ISO timestamps", () => {
    const repo = new SqliteProductRepository(seeded());
    const rows = repo.listSlugsWithUpdatedAt();
    expect(rows.length).toBe(SEED_CATALOG_STATS.total);
    const slugs = rows.map((r) => r.slug);
    expect(slugs).toEqual([...slugs].sort());
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["slug", "updatedAt"]);
      expect(Number.isNaN(Date.parse(r.updatedAt))).toBe(false);
    }
    expect(new SqliteProductRepository(empty()).listSlugsWithUpdatedAt()).toEqual([]);
  });

  test("recomputeProductRating fixes a deliberately corrupted aggregate on seeded data; null for unknown", () => {
    const db = seeded();
    const row = db.query<{ id: string; rating_count: number; rating_sum: number }, []>("SELECT id, rating_count, rating_sum FROM products WHERE rating_count > 2 LIMIT 1").get();
    if (row === null) throw new Error("no rated product");
    db.query("UPDATE products SET rating_count = 999, rating_sum = 4 WHERE id = ?").run(row.id);
    expect(recomputeProductRating(db, row.id)).toEqual({ ratingCount: row.rating_count, ratingSum: row.rating_sum });
    expect(db.query("SELECT rating_count, rating_sum FROM products WHERE id = ?").get(row.id)).toEqual({ rating_count: row.rating_count, rating_sum: row.rating_sum });
    expect(recomputeProductRating(db, "nope")).toBeNull();
  });
});

describe("QA-A C5 category and brand repositories", () => {
  test("getPath: department -> category; [dept] for a department; [] unknown", () => {
    const repo = new SqliteCategoryRepository(seeded());
    expect(repo.getPath("cat_audio").map((c) => c.slug)).toEqual(["electronics", "audio"]);
    expect(repo.getPath("cat_electronics").map((c) => c.slug)).toEqual(["electronics"]);
    expect(repo.getPath("nope")).toEqual([]);
    expect(repo.getPath("")).toEqual([]);
  });

  test("listAllWithCounts matches SQL counts; departments each followed by their children", () => {
    const db = seeded();
    const rows = new SqliteCategoryRepository(db).listAllWithCounts();
    expect(rows.length).toBe(32);
    let currentDept: string | null = null;
    for (const c of rows) {
      const sql = db
        .query<{ n: number }, [string, string]>(
          "SELECT COUNT(*) AS n FROM products p WHERE p.category_id = ? OR p.category_id IN (SELECT id FROM categories WHERE parent_id = ?)",
        )
        .get(c.id, c.id)?.n;
      expect({ id: c.id, n: c.productCount }).toEqual({ id: c.id, n: sql ?? -1 });
      if (c.parentId === null) currentDept = c.id;
      else expect(c.parentId).toBe(currentDept ?? "none");
    }
    const deptTotal = rows.filter((c) => c.parentId === null).reduce((s, c) => s + c.productCount, 0);
    expect(deptTotal).toBe(SEED_CATALOG_STATS.total); // repository counts are unfiltered (incl. future-dated)
  });

  test("category lookups: departments 8, children 3 each, hostile input safe", () => {
    const repo = new SqliteCategoryRepository(seeded());
    const depts = repo.listDepartments();
    expect(depts.length).toBe(8);
    for (const d of depts) expect(repo.listChildren(d.id).length).toBe(3);
    expect(repo.listChildren("nope")).toEqual([]);
    expect(repo.getBySlug("' OR 1=1 --")).toBeNull();
    expect(repo.getById("%")).toBeNull();
    expect(repo.getBySlug("audio")?.id).toBe("cat_audio");
  });

  test("brand repo: 12 brands by name, counts match SQL, lookups and hostile input", () => {
    const db = seeded();
    const repo = new SqliteBrandRepository(db);
    const list = repo.list();
    expect(list.length).toBe(12);
    const names = list.map((b) => b.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // listWithCounts() counts products published by the real clock (its default `now`); the oracle does the same.
    const cutoff = new Date().toISOString();
    for (const b of repo.listWithCounts()) {
      const n = db.query<{ n: number }, [string, string]>("SELECT COUNT(*) AS n FROM products WHERE brand_id = ? AND published_at <> '' AND published_at <= ?").get(b.id, cutoff)?.n;
      expect({ id: b.id, n: b.productCount }).toEqual({ id: b.id, n: n ?? -1 });
      expect(Object.keys(b).sort()).toEqual(["description", "id", "name", "productCount", "slug"]);
    }
    expect(repo.listWithCounts().reduce((s, b) => s + b.productCount, 0)).toBe(
      db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM products WHERE published_at <> '' AND published_at <= ?").get(cutoff)?.n ?? -1,
    );
    expect(repo.getBySlug("northloom")?.id).toBe("brand_northloom");
    expect(repo.getById("brand_northloom")?.slug).toBe("northloom");
    expect(repo.getBySlug("' OR 1=1 --")).toBeNull();
    expect(repo.getById("")).toBeNull();
  });

  test("static: repository SQL interpolates only module constants (no input in template strings)", () => {
    for (const f of ["product-repository.ts", "category-repository.ts", "brand-repository.ts"]) {
      const src = readFileSync(join(ROOT, "src", "server", "catalog", f), "utf8");
      const interps = [...src.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1] ?? "");
      const allowed = /^(SUMMARY_COLUMNS|FROM_JOINED|SELECT_SUMMARY|CATEGORY_COLUMNS|BRAND_COLUMNS|where|orderBy|CATEGORY_COLUMNS\.split.*|c|current\.stock|current\.name|row\.\w+)$/;
      for (const i of interps) expect({ f, i, ok: allowed.test(i.trim()) }).toEqual({ f, i, ok: true });
    }
  });
});

// ---------------------------------------------------------------------------
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;
const PRODUCT_REQUIRED_OK: Equal<RequiredKeys<Product>, "id" | "slug" | "name" | "description" | "priceCents" | "currency" | "imageUrl" | "stock"> = true;
const USER_HAS_NO_HASH: Equal<Extract<keyof User, "passwordHash" | "password_hash" | "password">, never> = true;

describe("QA-A C6 types", () => {
  test("ERROR_CODES is exactly the 30 canonical codes, in order, no duplicates", () => {
    expect([...ERROR_CODES]).toEqual([
      "PRODUCT_NOT_FOUND", "OUT_OF_STOCK", "INSUFFICIENT_STOCK", "INVALID_QUANTITY", "INVALID_INPUT", "VALIDATION_FAILED",
      "EMPTY_CART", "STOCK_CHANGED", "ORDER_NOT_FOUND", "PAYMENT_FAILED", "MONEY_OVERFLOW",
      "NOT_FOUND", "DUPLICATE", "ALREADY_VOTED", "COUPON_INVALID", "COUPON_EXPIRED", "COUPON_MIN_SUBTOTAL", "COUPON_EXHAUSTED",
      "COUPON_USED", "LIST_NOT_FOUND", "ORDER_NOT_CANCELLABLE", "LIMIT_REACHED", "TOO_LONG", "RATE_LIMITED", "FORBIDDEN",
      "INVALID_CREDENTIALS", "EMAIL_TAKEN", "UNAUTHENTICATED", "ACCOUNT_LOCKED", "INTERNAL_ERROR",
    ]);
    expect(ERROR_CODES.length).toBe(30);
    expect(new Set(ERROR_CODES).size).toBe(30);
    expect(ERROR_CODES).not.toContain("CANCEL_NOT_ALLOWED");
  });

  test("Product has exactly 8 required keys; User has no password hash (compile-time, asserted at runtime)", () => {
    expect(PRODUCT_REQUIRED_OK).toBe(true);
    expect(USER_HAS_NO_HASH).toBe(true);
  });

  test("types.ts has no `any` and no ts-ignore/ts-expect-error", () => {
    const src = readFileSync(join(ROOT, "src", "lib", "types.ts"), "utf8");
    expect(src).not.toMatch(/:\s*any\b|<any>|\bas any\b|any\[\]/);
    expect(src).not.toMatch(/@ts-(ignore|expect-error|nocheck)/);
  });
});
