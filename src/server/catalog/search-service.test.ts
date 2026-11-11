import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { closeDatabase, createDatabase } from "../db/client";
import { runMigrations } from "../db/schema";
import { SEED_CATALOG, SEED_CATALOG_PRODUCTS, SEED_CATALOG_STATS, SEED_PUBLISHED_CATALOG, publishedAtFor, seedDatabase } from "../db/seed";
import type { SearchRepository } from "./search-repository";
import {
  boundedDamerauLevenshtein,
  buildMatchExpression,
  createSearchService,
  createSearchServiceWithRepository,
  getSearchService,
  normalizeSearchQuery,
  type SearchResult,
} from "./search-service";

const SEED_NOW = new Date("2026-11-07T12:00:00.000Z");
const AFTER_SEED = Date.parse("2026-11-08T00:00:00.000Z");
/** Seed products visible at AFTER_SEED (the seed future-dates a few). */
const PUBLISHED = SEED_CATALOG_STATS.published;
const PUBLISHED_IDS = SEED_PUBLISHED_CATALOG.map((e) => e.product.id).sort();

function seeded(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: SEED_NOW });
  return db;
}

interface FixtureProduct {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly stock?: number;
  readonly publishedAt?: string;
  readonly brandId?: string | null;
  readonly categoryId?: string | null;
}

function fixture(products: readonly FixtureProduct[]): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  db.run("INSERT INTO brands (id, slug, name) VALUES ('brand_acme', 'acme', 'Acme Sound'), ('brand_ghost', 'ghost', 'Ghost Brand')");
  db.run("INSERT INTO categories (id, slug, name) VALUES ('cat_dept', 'electronics', 'Electronics')");
  db.run("INSERT INTO categories (id, slug, name, parent_id) VALUES ('cat_audio', 'audio', 'Audio Gear', 'cat_dept')");
  const insert = db.query(
    `INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock, brand_id, category_id, published_at)
     VALUES (?, ?, ?, ?, 1000, 'USD', '/x.svg', ?, ?, ?, ?)`,
  );
  for (const p of products) {
    insert.run(
      p.id,
      p.id.replace(/^p_/, ""),
      p.name,
      p.description ?? "",
      p.stock ?? 5,
      p.brandId === undefined ? "brand_acme" : p.brandId,
      p.categoryId === undefined ? "cat_audio" : p.categoryId,
      p.publishedAt ?? "2026-01-01T00:00:00.000Z",
    );
  }
  return db;
}

function okValue(r: ReturnType<ReturnType<typeof createSearchService>["search"]>): SearchResult {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

const HOSTILE: readonly string[] = [
  '"',
  '""',
  '"unterminated',
  "*",
  "head*",
  "**",
  "AND",
  "OR",
  "NOT",
  "NEAR",
  "a AND b OR c NOT d",
  "NEAR(head phones, 3)",
  "(",
  ")",
  "((head))",
  "-",
  "-head",
  "--",
  ":",
  "name:head",
  "brand_name:acme",
  "^",
  "^head",
  "\u0000",
  "head\u0000phones",
  "x".repeat(10_000),
  "😀🎧",
  "שלום עולם",
  "‮headphones‬​",
  "{name description}: head",
  "head + phones / 3 ; DROP TABLE products; --",
  "' OR 1=1 --",
  "\\\"\\*",
];

describe("normalizeSearchQuery", () => {
  test("non-strings and blanks yield the empty query", () => {
    for (const raw of [undefined, null, 42, {}, ["a"], "", "   ", "\t\n", "​"]) {
      expect(normalizeSearchQuery(raw)).toEqual({ normalizedQuery: "", terms: [] });
    }
  });

  test("trims, collapses whitespace and lower-cases", () => {
    expect(normalizeSearchQuery("  Wireless \t  HEADPHONES\n")).toEqual({
      normalizedQuery: "wireless headphones",
      terms: ["wireless", "headphones"],
    });
  });

  test("removes FTS operators and bare boolean tokens", () => {
    expect(normalizeSearchQuery('"head*" AND (phones) OR -noise ^x near:y NOT NEAR').terms).toEqual([
      "head",
      "phones",
      "noise",
      "x",
      "y",
    ]);
    expect(normalizeSearchQuery("over-ear").terms).toEqual(["over-ear"]);
    expect(normalizeSearchQuery("android notebook").terms).toEqual(["android", "notebook"]);
  });

  test("strips control and zero-width characters", () => {
    expect(normalizeSearchQuery("he​ad\u0000phones‮").terms).toEqual(["head", "phones"]);
  });

  test("keeps at most 8 terms", () => {
    const r = normalizeSearchQuery("a b c d e f g h i j k");
    expect(r.terms).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });

  test("caps at 100 chars deterministically without splitting surrogate pairs", () => {
    const long = normalizeSearchQuery("x".repeat(10_000));
    expect(long.normalizedQuery).toBe("x".repeat(100));
    expect(normalizeSearchQuery("x".repeat(10_000))).toEqual(long);
    const emoji = normalizeSearchQuery("😀".repeat(80));
    expect(emoji.normalizedQuery.length).toBeLessThanOrEqual(100);
    expect(emoji.normalizedQuery).toBe("😀".repeat(50));
    const words = normalizeSearchQuery(`${"abcdefghij ".repeat(5)}${"k".repeat(80)}`);
    expect(words.normalizedQuery.length).toBeLessThanOrEqual(100);
    expect(words.terms.length).toBe(6);
  });
});

describe("buildMatchExpression", () => {
  test("quotes every term, doubles inner quotes, prefixes the last", () => {
    expect(buildMatchExpression(["wireless", "head"])).toBe('"wireless" "head"*');
    expect(buildMatchExpression(['a"b'])).toBe('"a""b"*');
    expect(buildMatchExpression([])).toBe("");
  });

  test("skips terms without letters or digits", () => {
    expect(buildMatchExpression(["😀", "head", "!!"])).toBe('"head"*');
    expect(buildMatchExpression(["😀"])).toBe("");
  });

  test("control characters (NUL) cannot terminate the expression early", () => {
    expect(buildMatchExpression(["a\u0000b"])).toBe('"a b"*');
    expect(buildMatchExpression(["\u0000"])).toBe("");
  });

  test("FTS syntax errors are impossible by construction: every normalised hostile input is a valid MATCH", () => {
    const db = seeded();
    const q = db.query("SELECT COUNT(*) AS n FROM products_fts WHERE products_fts MATCH ?");
    const inputs = [...HOSTILE, ...Array.from({ length: 300 }, (_, i) => String.fromCharCode(...Array.from({ length: 12 }, (_, j) => (i * 31 + j * 17) % 128)))];
    for (const raw of inputs) {
      const { terms } = normalizeSearchQuery(raw);
      const match = buildMatchExpression(terms);
      if (match !== "") expect(() => q.get(match)).not.toThrow();
      // Even raw, un-normalised terms are safe once quoted.
      const rawMatch = buildMatchExpression(raw.split(" ").filter((t) => t !== ""));
      if (rawMatch !== "") expect(() => q.get(rawMatch)).not.toThrow();
    }
  });
});

describe("boundedDamerauLevenshtein", () => {
  test("counts edits including transpositions and bails out past the bound", () => {
    expect(boundedDamerauLevenshtein("hedphones", "headphones", 2)).toBe(1);
    expect(boundedDamerauLevenshtein("haedphones", "headphones", 2)).toBe(1);
    expect(boundedDamerauLevenshtein("abc", "abc", 2)).toBe(0);
    expect(boundedDamerauLevenshtein("abc", "xyzuvw", 2)).toBe(3);
    expect(boundedDamerauLevenshtein("kitten", "sitting", 2)).toBe(3);
  });
});

describe("SearchService.search", () => {
  test("30+ hostile strings return ok and never throw", () => {
    const service = createSearchService({ db: seeded() });
    expect(HOSTILE.length).toBeGreaterThanOrEqual(30);
    for (const raw of HOSTILE) {
      const r = service.search(raw, { now: AFTER_SEED });
      expect(r.ok).toBe(true);
    }
  });

  test("operators do not change semantics: quoted AND equals plain terms", () => {
    const service = createSearchService({ db: seeded() });
    const plain = okValue(service.search("wireless headphones", { now: AFTER_SEED }));
    const hostile = okValue(service.search('"wireless" AND (headphones)', { now: AFTER_SEED }));
    expect(hostile.ids).toEqual(plain.ids);
    const orQuery = okValue(service.search("wireless OR zzzzqqq", { now: AFTER_SEED }));
    expect(orQuery.total).toBe(0); // OR is dropped, not applied: both remaining terms must match
    const notQuery = okValue(service.search("headphones NOT wireless", { now: AFTER_SEED }));
    expect(notQuery.ids).toEqual(plain.ids);
  });

  test("empty / whitespace / operator-only query is browse all, not an error", () => {
    const service = createSearchService({ db: seeded() });
    for (const raw of ["", "   ", "AND OR", '"*"', undefined]) {
      const v = okValue(service.search(raw, { now: AFTER_SEED, pageSize: 48 }));
      expect(v.browseAll).toBe(true);
      expect(v.total).toBe(PUBLISHED);
      expect(v.didYouMean).toBeNull();
    }
  });

  test("emoji-only query is not browse all and finds nothing", () => {
    const v = okValue(createSearchService({ db: seeded() }).search("😀", { now: AFTER_SEED }));
    expect(v).toEqual({ ids: [], total: 0, normalizedQuery: "😀", terms: ["😀"], didYouMean: null, browseAll: false });
  });

  test("prefix: 'wirel' finds the wireless products", () => {
    const db = seeded();
    const v = okValue(createSearchService({ db }).search("wirel", { now: AFTER_SEED }));
    const slugs = v.ids.map((id) => db.query<{ slug: string }, [string]>("SELECT slug FROM products WHERE id = ?").get(id)?.slug);
    expect(slugs).toContain("wireless-over-ear-headphones");
    expect(slugs).toContain("true-wireless-earbuds");
    expect(slugs).toContain("wireless-charging-pad");
  });

  test("name match outranks description match for the same term (fixture)", () => {
    const db = fixture([
      { id: "p_a_desc", name: "Plain Speaker", description: "Zephyr zephyr zephyr compatible speaker." },
      { id: "p_z_name", name: "Zephyr Lamp", description: "A lamp." },
    ]);
    const v = okValue(createSearchService({ db }).search("zephyr", { now: AFTER_SEED }));
    expect(v.ids).toEqual(["p_z_name", "p_a_desc"]);
  });

  test("name match outranks description match in the seed (headphones)", () => {
    const db = seeded();
    const v = okValue(createSearchService({ db }).search("headphones", { now: AFTER_SEED }));
    expect(v.ids[0]).toBe("prod_studio-monitor-headphones");
    // Every name match (both "... Headphones" products) ranks above every description-only match.
    const nameOf = (id: string): string => SEED_CATALOG_PRODUCTS.find((p) => p.id === id)?.name ?? "";
    const isNameHit = v.ids.map((id) => /headphones/i.test(nameOf(id)));
    expect(isNameHit.filter(Boolean)).toHaveLength(2);
    expect(isNameHit).toEqual([...isNameHit].sort((a, b) => Number(b) - Number(a))); // all name hits first
    expect(v.ids).toContain("prod_wireless-over-ear-headphones");
  });

  test("unpublished products never appear; out-of-stock appear unless inStockOnly", () => {
    const db = fixture([
      { id: "p_live", name: "Orbit Speaker" },
      { id: "p_empty", name: "Orbit Speaker Mini", stock: 0 },
      { id: "p_future", name: "Orbit Speaker Max", publishedAt: "2027-01-01T00:00:00.000Z" },
    ]);
    const service = createSearchService({ db });
    const now = Date.parse("2026-06-01T00:00:00.000Z");
    expect([...okValue(service.search("orbit", { now })).ids].sort()).toEqual(["p_empty", "p_live"]);
    expect(okValue(service.search("orbit", { now, inStockOnly: true })).ids).toEqual(["p_live"]);
    expect(okValue(service.search("", { now })).total).toBe(2);
    expect(okValue(service.search("", { now, inStockOnly: true })).ids).toEqual(["p_live"]);
    // Published exactly at `now` counts as published.
    const atLaunch = Date.parse("2027-01-01T00:00:00.000Z");
    expect(okValue(service.search("max", { now: atLaunch })).ids).toEqual(["p_future"]);
  });

  test("seed: out-of-stock products are filtered by inStockOnly", () => {
    const service = createSearchService({ db: seeded() });
    const all = okValue(service.search("", { now: AFTER_SEED, pageSize: 48 })).total;
    const inStock = okValue(service.search("", { now: AFTER_SEED, inStockOnly: true })).total;
    const zeroStock = SEED_CATALOG_PRODUCTS.filter((p) => p.stock === 0).length;
    expect(all - inStock).toBe(zeroStock);
  });

  test("pagination over all published seeded products has no gaps or duplicates", () => {
    const db = seeded();
    const service = createSearchService({ db });
    for (const pageSize of [1, 7, 24, 48]) {
      const seen: string[] = [];
      for (let page = 1; page <= Math.ceil(PUBLISHED / pageSize) + 1; page++) {
        const v = okValue(service.search("", { now: AFTER_SEED, page, pageSize }));
        expect(v.total).toBe(PUBLISHED);
        seen.push(...v.ids);
      }
      expect(seen.length).toBe(PUBLISHED);
      expect(new Set(seen).size).toBe(PUBLISHED);
      expect([...seen].sort()).toEqual(PUBLISHED_IDS);
    }
  });

  test("ranked pagination is stable: concatenated pages equal one big page", () => {
    const service = createSearchService({ db: seeded() });
    const full = okValue(service.search("a", { now: AFTER_SEED, pageSize: 48 }));
    expect(full.total).toBeGreaterThan(10);
    const pages: string[] = [];
    for (let page = 1; page <= Math.ceil(full.total / 5); page++) {
      pages.push(...okValue(service.search("a", { now: AFTER_SEED, page, pageSize: 5 })).ids);
    }
    expect(pages.slice(0, full.ids.length)).toEqual([...full.ids]);
    expect(new Set(pages).size).toBe(full.total);
  });

  test("page and pageSize are clamped", () => {
    const service = createSearchService({ db: seeded() });
    const len = (opts: { page?: number; pageSize?: number }) =>
      okValue(service.search("", { now: AFTER_SEED, ...opts })).ids.length;
    expect(len({})).toBe(24);
    expect(len({ pageSize: 0 })).toBe(1);
    expect(len({ pageSize: -5 })).toBe(1);
    expect(len({ pageSize: 1000 })).toBe(48);
    expect(len({ pageSize: 2.5 })).toBe(24);
    expect(len({ pageSize: Number.NaN })).toBe(24);
    const first = okValue(service.search("", { now: AFTER_SEED })).ids;
    for (const page of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(okValue(service.search("", { now: AFTER_SEED, page })).ids).toEqual(first);
    }
    expect(okValue(service.search("", { now: AFTER_SEED, page: Number.MAX_SAFE_INTEGER })).ids).toEqual([]);
    expect(okValue(service.search("", { now: AFTER_SEED, page: Math.ceil(PUBLISHED / 24) + 1 })).ids).toEqual([]);
  });

  test("null and non-object options behave like no options (D3)", () => {
    const service = createSearchService({ db: seeded() });
    for (const opts of [null, 5, "x", true]) {
      const r = service.search("", opts as unknown as null);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.ids).toHaveLength(24);
    }
    const typed = service.search("", { page: "2", pageSize: "3", inStockOnly: "yes" } as unknown as { page: number });
    expect(typed.ok && typed.value.ids.length).toBe(24);
  });

  test("the injected clock is the default now; options.now overrides it (D4)", () => {
    const db = fixture([
      { id: "p_live", name: "Orbit Speaker" },
      { id: "p_future", name: "Orbit Speaker Max", publishedAt: "2030-01-01T00:00:00.000Z" },
    ]);
    const early = createSearchService({ db, now: () => Date.parse("2026-06-01T00:00:00.000Z") });
    expect(okValue(early.search("orbit")).ids).toEqual(["p_live"]);
    expect(okValue(early.search("orbit", { now: Date.parse("2030-01-01T00:00:00.000Z") })).total).toBe(2);
    const late = createSearchService({ db, now: () => Date.parse("2031-01-01T00:00:00.000Z") });
    expect(okValue(late.search("orbit")).total).toBe(2);
    expect(late.suggest("orbit max")).toContainEqual({ type: "product", label: "Orbit Speaker Max", href: "/products/future" });
    expect(early.suggest("orbit max")).toEqual([]);
    const throwingClock = createSearchService({ db, now: () => { throw new Error("clock"); } });
    expect(throwingClock.search("orbit").ok).toBe(true);
    expect(() => throwingClock.suggest("orbit")).not.toThrow();
  });

  test("didYouMean uses the injected clock (D4)", () => {
    const db = fixture([
      { id: "p_lamp", name: "Studio Lamp" },
      { id: "p_h", name: "Studio Headphones", publishedAt: "2030-01-01T00:00:00.000Z" },
    ]);
    expect(createSearchService({ db, now: () => Date.parse("2026-06-01T00:00:00.000Z") }).didYouMean("hedphones")).toBeNull();
    expect(createSearchService({ db, now: () => Date.parse("2031-01-01T00:00:00.000Z") }).didYouMean("hedphones")).toBe("headphones");
  });

  test("invalid now falls back to the current time", () => {
    const service = createSearchService({ db: seeded() });
    // Expected = seed products published by the real clock (the future-dated ones appear once their date passes).
    const publishedByWallClock = SEED_CATALOG.filter((e) => publishedAtFor(e.daysAgo, SEED_NOW).getTime() <= Date.now()).length;
    expect(okValue(service.search("", { now: Number.NaN })).total).toBe(publishedByWallClock);
  });

  test("zero results carry a did-you-mean hint", () => {
    const v = okValue(createSearchService({ db: seeded() }).search("wireless hedphones", { now: AFTER_SEED }));
    expect(v.total).toBe(0);
    expect(v.didYouMean).toBe("wireless headphones");
  });

  test("a repository failure becomes err(INTERNAL_ERROR), never a throw", () => {
    const boom = (): never => {
      throw new Error("disk I/O error");
    };
    const broken: SearchRepository = {
      countMatches: boom,
      findMatchIds: boom,
      countPublished: boom,
      listPublishedIds: boom,
      suggestProducts: boom,
      listCategoriesWithPublished: boom,
      listBrandsWithPublished: boom,
      listVocabulary: boom,
      listPublishedText: boom,
    };
    const service = createSearchServiceWithRepository(broken);
    const r = service.search("headphones");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INTERNAL_ERROR");
    expect(service.search("").ok).toBe(false);
    expect(service.suggest("headphones")).toEqual([]);
    expect(service.didYouMean("hedphones")).toBeNull();
  });
});

describe("SearchService.suggest", () => {
  test("empty, 1-char and non-string prefixes return []", () => {
    const service = createSearchService({ db: seeded() });
    for (const p of ["", " ", "w", " w ", "😀", "\u0000", undefined, 5, null, {}, '"', "*"]) {
      expect(service.suggest(p)).toEqual([]);
    }
  });

  test("returns at most 8 de-duplicated typed suggestions with site-relative hrefs", () => {
    const service = createSearchService({ db: seeded() });
    for (const p of ["wi", "wirel", "head", "co", "ka", "lamp", "st", "the"]) {
      const s = service.suggest(p);
      expect(s.length).toBeLessThanOrEqual(8);
      expect(new Set(s.map((x) => x.href)).size).toBe(s.length);
      for (const x of s) {
        expect(["product", "category", "brand"]).toContain(x.type);
        expect(x.label.length).toBeGreaterThan(0);
        expect(x.href.startsWith("/")).toBe(true);
        expect(x.href.startsWith("//")).toBe(false);
        const prefix = x.type === "product" ? "/products/" : x.type === "category" ? "/category/" : "/brand/";
        expect(x.href.startsWith(prefix)).toBe(true);
      }
    }
  });

  test("mixes products, categories and brands", () => {
    const service = createSearchService({ db: seeded() });
    const s = service.suggest("head");
    expect(s).toContainEqual({ type: "product", label: "Wireless Over-Ear Headphones", href: "/products/wireless-over-ear-headphones" });
    expect(s).toContainEqual({ type: "category", label: "Headphones & Audio", href: "/category/audio" });
    const k = service.suggest("kestrel");
    expect(k).toContainEqual({ type: "brand", label: "Kestrel Audio", href: "/brand/kestrel-audio" });
  });

  test("at most 2 categories and 2 brands per response; products fill the rest (D1)", () => {
    const service = createSearchService({ db: seeded() });
    const letters = "abcdefghijklmnopqrstuvwxyz";
    for (const x of letters) {
      for (const y of letters) {
        const s = service.suggest(x + y);
        expect(s.filter((v) => v.type === "category").length).toBeLessThanOrEqual(2);
        expect(s.filter((v) => v.type === "brand").length).toBeLessThanOrEqual(2);
        expect(s.length).toBeLessThanOrEqual(8);
      }
    }
    const co = service.suggest("co");
    expect(co.filter((v) => v.type === "category").length).toBeLessThanOrEqual(2);
    expect(co.filter((v) => v.type === "product").length).toBeGreaterThan(0);
  });

  test("limit is clamped to 1..8", () => {
    const service = createSearchService({ db: seeded() });
    expect(service.suggest("a", 3)).toEqual([]);
    expect(service.suggest("wi", 2).length).toBeLessThanOrEqual(2);
    expect(service.suggest("wi", 0).length).toBe(1);
    expect(service.suggest("wi", 100).length).toBeLessThanOrEqual(8);
    expect(service.suggest("wi", Number.NaN).length).toBeLessThanOrEqual(8);
  });

  test("unpublished products, and brands/categories with only unpublished products, are not suggested", () => {
    const db = fixture([
      { id: "p_future", name: "Ghostly Speaker", publishedAt: "2999-01-01T00:00:00.000Z", brandId: "brand_ghost" },
    ]);
    const service = createSearchService({ db });
    expect(service.suggest("gho")).toEqual([]);
    expect(service.suggest("audio")).toEqual([]);
  });

  test("duplicate product names collapse to one suggestion", () => {
    const db = fixture([
      { id: "p_twin_a", name: "Twin Speaker" },
      { id: "p_twin_b", name: "Twin Speaker" },
    ]);
    const s = createSearchService({ db }).suggest("twin");
    expect(s.filter((x) => x.type === "product")).toHaveLength(1);
  });

  test("hostile prefixes never throw", () => {
    const service = createSearchService({ db: seeded() });
    for (const p of HOSTILE) expect(() => service.suggest(p)).not.toThrow();
  });
});

describe("SearchService.didYouMean", () => {
  test("'hedphones' -> 'headphones' (seed contains headphones)", () => {
    expect(createSearchService({ db: seeded() }).didYouMean("hedphones")).toBe("headphones");
  });

  test("works on an own fixture too and handles transpositions", () => {
    const db = fixture([{ id: "p_h", name: "Studio Headphones" }]);
    const service = createSearchService({ db });
    expect(service.didYouMean("hedphones")).toBe("headphones");
    expect(service.didYouMean("haedphones")).toBe("headphones");
  });

  test("a query that already matches returns null", () => {
    const service = createSearchService({ db: seeded() });
    expect(service.didYouMean("headphones")).toBeNull();
    expect(service.didYouMean("wirel")).toBeNull();
  });

  test("nonsense with no close vocabulary returns null", () => {
    const service = createSearchService({ db: seeded() });
    expect(service.didYouMean("qxzvbnmkj")).toBeNull();
    expect(service.didYouMean("")).toBeNull();
    expect(service.didYouMean("😀")).toBeNull();
    expect(service.didYouMean("zz")).toBeNull();
  });

  test("never suggests the same string back", () => {
    const service = createSearchService({ db: seeded() });
    for (const q of ["hedphones", "Hedphones", "qxzvbnmkj", "wireless hedphones"]) {
      const s = service.didYouMean(q);
      if (s !== null) expect(s).not.toBe(normalizeSearchQuery(q).normalizedQuery);
    }
  });

  test("unpublished vocabulary is never suggested", () => {
    const db = fixture([
      { id: "p_live", name: "Studio Lamp" },
      { id: "p_future", name: "Secret Headphones", publishedAt: "2999-01-01T00:00:00.000Z" },
    ]);
    expect(createSearchService({ db }).didYouMean("hedphones")).toBeNull();
  });
});

describe("getSearchService", () => {
  test("returns a cached singleton over the app database", () => {
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = ":memory:";
    try {
      const a = getSearchService();
      expect(getSearchService()).toBe(a);
      expect(a.search("").ok).toBe(true);
      closeDatabase();
      const b = getSearchService();
      expect(b).not.toBe(a);
      expect(b.search("").ok).toBe(true);
      expect(getSearchService()).toBe(b);
    } finally {
      closeDatabase();
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
    }
  });
});
