/**
 * QA adversarial tests for T32 (search service), src/server/catalog/search-*.ts.
 * Owned by QA (QA-W1-T32). In-memory DBs only; the singleton tests set
 * DATABASE_PATH=":memory:" and call closeDatabase(); never touches ./data/.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SEED_CATALOG_STATS, SEED_PUBLISHED_CATALOG, seedDatabase } from "@/server/db/seed";
import { SqliteSearchRepository, type SearchRepository } from "@/server/catalog/search-repository";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildMatchExpression,
  createSearchService,
  createSearchServiceWithRepository,
  getSearchService,
  normalizeSearchQuery,
  type SearchOptions,
  type SearchResult,
  type SearchService,
} from "@/server/catalog/search-service";

const SEED_NOW = new Date("2026-11-07T12:00:00.000Z");
const AFTER_SEED = Date.parse("2026-11-08T00:00:00.000Z");
const FIX_NOW = Date.parse("2026-06-01T00:00:00.000Z");
const CATALOG_DIR = join(import.meta.dir, "../../../src/server/catalog");
/** Seed products visible at AFTER_SEED (the seed future-dates a few). */
const PUBLISHED = SEED_CATALOG_STATS.published;

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

function seeded(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: SEED_NOW });
  open.push(db);
  return db;
}

interface Fx {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly stock?: number;
  readonly publishedAt?: string;
  readonly brandId?: string | null;
  readonly categoryId?: string | null;
  readonly slug?: string;
}

/** Own fixture catalog: 2 brands, a department with a child category, plus `extra` setup SQL. */
function fixture(products: readonly Fx[], extra: readonly string[] = []): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  open.push(db);
  db.run("INSERT INTO brands (id, slug, name) VALUES ('b_qa', 'qa-brand', 'Quokka Works'), ('b_hidden', 'hidden-brand', 'Hidden Brand')");
  db.run("INSERT INTO categories (id, slug, name) VALUES ('c_dept', 'qa-dept', 'Gadgets')");
  db.run("INSERT INTO categories (id, slug, name, parent_id) VALUES ('c_child', 'qa-child', 'Gadget Parts', 'c_dept')");
  for (const sql of extra) db.run(sql);
  const insert = db.query(
    `INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock, brand_id, category_id, published_at)
     VALUES (?, ?, ?, ?, 1000, 'USD', '/x.svg', ?, ?, ?, ?)`,
  );
  for (const p of products) {
    insert.run(
      p.id,
      p.slug ?? p.id.replace(/^p_/, "").replaceAll("_", "-"),
      p.name,
      p.description ?? "",
      p.stock ?? 5,
      p.brandId === undefined ? "b_qa" : p.brandId,
      p.categoryId === undefined ? "c_child" : p.categoryId,
      p.publishedAt ?? "2026-01-01T00:00:00.000Z",
    );
  }
  return db;
}

function val(r: ReturnType<SearchService["search"]>): SearchResult {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

/** Every id of a query, concatenated over all 48-item pages (one "big" listing). */
function allPagesOf48(svc: SearchService, q: string): string[] {
  const total = val(svc.search(q, { now: AFTER_SEED, pageSize: 48 })).total;
  const out: string[] = [];
  for (let page = 1; page <= Math.ceil(total / 48); page++) out.push(...val(svc.search(q, { now: AFTER_SEED, pageSize: 48, page })).ids);
  return out;
}

// ---------------------------------------------------------------------------
// 100 hostile inputs
// ---------------------------------------------------------------------------

const HOSTILE_STRINGS: readonly string[] = [
  '"', '""', '"""', '"head', 'head"', '"head phones"', "'", "''", "`", "*", "**", "head*", "*head", "h*e*a*d",
  "AND", "OR", "NOT", "NEAR", "and", "or", "not", "near", "AND OR NOT NEAR", "a AND b", "a OR b", "a NOT b",
  "NEAR(", "NEAR(a b)", "NEAR(a b, 2)", "NEAR(\"a\" \"b\", 10)", "near/3", "a NEAR/2 b",
  "(", ")", "()", "((", "))", "(head", "head)", "((head) OR (phones))",
  "-", "--", "-foo", "--foo", "- foo", "foo-", "t-shirt", "usb-c", "a - b", "-\"x\"",
  ":", "a:b", "name:head", "brand_name:acme", "{name}:head", "{name brand_name}: head", "products_fts:x", "rank:1", "rowid:1",
  "^", "^head", "head^", "^^", "+", "+head", "a + b", "3.5mm", "o'clock", "%", "%%", "_", "%00", "%22", "\\", "\\\"",
  "\u0000", "a\u0000b", "\u0000\u0000\"", "\u0001\u0002\u001f\u007f", "head\u0000\"phones",
  "x".repeat(10_000), "head ".repeat(2_000), "\"".repeat(5_000), "(".repeat(3_000),
  "😀", "😀🎧🔥", "👩‍👩‍👧‍👦", "🇹🇷",
  "שלום עולם", "مرحبا بالعالم", "‮headphones‬", "‏‎",
  "​", "head​phones", "﻿head", "⁠⁡",
  "__proto__", "constructor", "prototype", "toString", "hasOwnProperty",
  "' OR 1=1 --", "'; DROP TABLE products; --", "<script>alert(1)</script>", "\uD800", "\uDFFF", "a\uD800b",
];

const HOSTILE_NON_STRINGS: readonly unknown[] = [
  undefined, null, 0, 42, Number.NaN, Number.POSITIVE_INFINITY, true, false, 10n, Symbol("q"), {}, [], ["headphones"],
  { toString: () => "headphones" }, () => "x", new Date(), Object.create(null),
];

describe("criterion 1: hostile input never throws and returns ok", () => {
  test("at least 100 hostile strings + non-strings → ok, never throw (search/suggest/didYouMean)", () => {
    expect(HOSTILE_STRINGS.length).toBeGreaterThanOrEqual(100);
    const svc = createSearchService({ db: seeded() });
    for (const raw of [...HOSTILE_STRINGS, ...HOSTILE_NON_STRINGS]) {
      let r: ReturnType<SearchService["search"]> | undefined;
      expect(() => {
        r = svc.search(raw, { now: AFTER_SEED });
      }).not.toThrow();
      expect(r?.ok).toBe(true);
      expect(() => svc.suggest(raw)).not.toThrow();
      expect(() => svc.didYouMean(raw as string)).not.toThrow();
      const s = svc.suggest(raw);
      expect(Array.isArray(s)).toBe(true);
    }
  });

  test("non-strings are browse-all (never coerced via toString)", () => {
    const svc = createSearchService({ db: seeded() });
    for (const raw of HOSTILE_NON_STRINGS) {
      const v = val(svc.search(raw, { now: AFTER_SEED }));
      expect(v.browseAll).toBe(true);
      expect(v.total).toBe(PUBLISHED);
    }
  });

  test("operators never change semantics", () => {
    const svc = createSearchService({ db: seeded() });
    const ids = (q: string) => val(svc.search(q, { now: AFTER_SEED, pageSize: 48 })).ids;
    const plain = ids("wireless headphones");
    expect(plain.length).toBeGreaterThan(0);
    for (const q of [
      "-wireless headphones",
      "wireless -headphones",
      "wireless NOT headphones",
      "wireless AND headphones",
      "(wireless) (headphones)",
      '"wireless" "headphones"',
      "^wireless ^headphones",
      "wireless* headphones*",
      "WIRELESS NEAR HEADPHONES",
      "wireless\u0000headphones",
    ]) {
      expect(ids(q)).toEqual(plain);
    }
    // OR is dropped, not applied
    expect(val(svc.search("wireless OR qqzzxxv", { now: AFTER_SEED })).total).toBe(0);
    // a:b is two terms, not a column filter
    expect(normalizeSearchQuery("brand_name:kestrel").terms).toEqual(["brand_name", "kestrel"]);
    expect(normalizeSearchQuery("a:b").terms).toEqual(["a", "b"]);
  });

  test("total always equals the number of ids reachable via pagination for hostile inputs", () => {
    const svc = createSearchService({ db: seeded() });
    for (const raw of HOSTILE_STRINGS.slice(0, 60)) {
      const v = val(svc.search(raw, { now: AFTER_SEED, pageSize: 48 }));
      expect(v.ids.length).toBe(Math.min(48, v.total));
    }
  });
});

// ---------------------------------------------------------------------------
// normalizeSearchQuery
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ..."      \t\n\"'*^:()-+{}[]%_\\/.,;!?<>",
  "\u0000", "\u0001", "\u001f", "\u007f", "​", "‏", "‮", "﻿", "😀", "é", "İ", "ß", "ﬁ", "Ａ", "ש", "م",
  "AND ", "OR ", "NOT ", "NEAR(", " near ",
];

function randomString(r: () => number, maxLen: number): string {
  const n = Math.floor(r() * maxLen);
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(r() * ALPHABET.length)];
  return out;
}

describe("criterion 2: normalizeSearchQuery caps and cleans deterministically", () => {
  test("100-char cap and 8-term cap, deterministic", () => {
    const long = "abcdefghijk ".repeat(50);
    const a = normalizeSearchQuery(long);
    const b = normalizeSearchQuery(long);
    expect(a).toEqual(b);
    expect(a.terms.length).toBe(8);
    expect(a.normalizedQuery.length).toBeLessThanOrEqual(100);
    const many = normalizeSearchQuery("one two three four five six seven eight nine ten");
    expect(many.terms).toEqual(["one", "two", "three", "four", "five", "six", "seven", "eight"]);
    const big = normalizeSearchQuery("y".repeat(250));
    expect(big.normalizedQuery).toBe("y".repeat(100));
    expect(big.terms).toEqual(["y".repeat(100)]);
  });

  test("lower-cases and strips operators", () => {
    expect(normalizeSearchQuery('  "Wireless"  (HEAD*) ^Phones  ').terms).toEqual(["wireless", "head", "phones"]);
    expect(normalizeSearchQuery("NEAR(Lamp Desk, 3)").normalizedQuery).toBe("lamp desk, 3");
  });

  test("fuzz 2000 random strings: invariants hold", () => {
    const r = rng(0xc0ffee);
    const OPS = /["*^:()]/;
    for (let i = 0; i < 2000; i++) {
      const raw = randomString(r, i % 10 === 0 ? 400 : 60);
      const n = normalizeSearchQuery(raw);
      expect(n).toEqual(normalizeSearchQuery(raw));
      expect(n.normalizedQuery.length).toBeLessThanOrEqual(100);
      expect(n.terms.length).toBeLessThanOrEqual(8);
      expect(n.normalizedQuery).toBe(n.terms.join(" "));
      expect(n.normalizedQuery).toBe(n.normalizedQuery.toLowerCase());
      for (const t of n.terms) {
        expect(t).not.toBe("");
        expect(OPS.test(t)).toBe(false);
        expect(/\p{Cc}|\p{Cf}|\s/u.test(t)).toBe(false);
        expect(t.startsWith("-")).toBe(false);
        expect(["and", "or", "not", "near"]).not.toContain(t);
      }
      // the last code unit is never a lone high surrogate created by the cut
      const last = n.normalizedQuery.charCodeAt(n.normalizedQuery.length - 1);
      if (n.normalizedQuery.length === 100) expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  test("emoji at the 100-char boundary is not split", () => {
    const q = normalizeSearchQuery(`${"a".repeat(99)}😀`);
    expect(q.normalizedQuery).toBe("a".repeat(99));
  });
});

// ---------------------------------------------------------------------------
// browse-all / emoji
// ---------------------------------------------------------------------------

describe("criterion 2: empty query is browse-all", () => {
  test("empty/whitespace/non-string → browseAll with all published ids ordered by id", () => {
    const db = fixture([
      { id: "p_c", name: "Gamma Thing" },
      { id: "p_a", name: "Alpha Thing", stock: 0 },
      { id: "p_b", name: "Beta Thing" },
      { id: "p_future", name: "Future Thing", publishedAt: "2027-01-01T00:00:00.000Z" },
    ]);
    const svc = createSearchService({ db });
    for (const raw of ["", " ", "\t\n  ", "​​", "\u0000", "AND OR", "( ) * ^ :", null, undefined, 7, {}]) {
      const v = val(svc.search(raw, { now: FIX_NOW }));
      expect(v.browseAll).toBe(true);
      expect(v.ids).toEqual(["p_a", "p_b", "p_c"]);
      expect(v.total).toBe(3);
      expect(v.didYouMean).toBeNull();
      expect(v.normalizedQuery).toBe("");
    }
  });

  test("seed: browse-all equals SELECT id ORDER BY id across pages", () => {
    const db = seeded();
    const svc = createSearchService({ db });
    const expected = db
      .query<{ id: string }, [string]>("SELECT id FROM products WHERE published_at <= ? ORDER BY id")
      .all(new Date(AFTER_SEED).toISOString())
      .map((r) => r.id);
    const got = allPagesOf48(svc, "");
    expect(got).toEqual(expected);
  });

  test("emoji-only → 0 results and not browseAll", () => {
    const svc = createSearchService({ db: seeded() });
    for (const q of ["😀", "😀🎧", "👩‍👩‍👧‍👦", "🇹🇷 🔥"]) {
      const v = val(svc.search(q, { now: AFTER_SEED }));
      expect(v.browseAll).toBe(false);
      expect(v.total).toBe(0);
      expect(v.ids).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// ranking, prefix, stemming
// ---------------------------------------------------------------------------

describe("criterion 3: ranking, prefix and stemming (own fixtures)", () => {
  test("name match outranks description match even when the description repeats the term and sorts first by id", () => {
    const db = fixture([
      { id: "p_a1", name: "Basic Kettle", description: "Pelican pelican pelican pelican. Pelican compatible." },
      { id: "p_a2", name: "Steel Mug", description: "Inspired by the pelican." },
      { id: "p_z9", name: "Pelican Desk Organizer With Many Extra Words In The Name", description: "Holds pens." },
    ]);
    const v = val(createSearchService({ db }).search("pelican", { now: FIX_NOW }));
    expect(v.ids[0]).toBe("p_z9");
    expect(v.total).toBe(3);
  });

  test("prefix: 'wirel' finds wireless", () => {
    const db = fixture([
      { id: "p_w1", name: "Wireless Mouse" },
      { id: "p_w2", name: "Desk Lamp", description: "Works wirelessly." },
      { id: "p_x", name: "Wired Keyboard" },
    ]);
    const v = val(createSearchService({ db }).search("WIREL", { now: FIX_NOW }));
    expect(v.ids).toContain("p_w1");
    expect(v.ids).not.toContain("p_x");
  });

  test("stemming: run ↔ running", () => {
    const db = fixture([
      { id: "p_r1", name: "Running Shoes" },
      { id: "p_r2", name: "Trail Run Vest" },
      { id: "p_r3", name: "Rain Jacket" },
    ]);
    const svc = createSearchService({ db });
    expect([...val(svc.search("run", { now: FIX_NOW })).ids].sort()).toEqual(["p_r1", "p_r2"]);
    expect([...val(svc.search("running", { now: FIX_NOW })).ids].sort()).toEqual(["p_r1", "p_r2"]);
    expect([...val(svc.search("runs shoes", { now: FIX_NOW })).ids]).toEqual(["p_r1"]);
  });
});

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

describe("criterion 7: pagination", () => {
  test("pageSize clamp 1..48 default 24; page < 1 / NaN → 1", () => {
    const svc = createSearchService({ db: seeded() });
    const run = (o: SearchOptions) => val(svc.search("", { now: AFTER_SEED, ...o })).ids;
    expect(run({}).length).toBe(DEFAULT_PAGE_SIZE);
    expect(run({ pageSize: 1 }).length).toBe(1);
    expect(run({ pageSize: 48 }).length).toBe(MAX_PAGE_SIZE);
    expect(run({ pageSize: 49 }).length).toBe(48);
    expect(run({ pageSize: 0 }).length).toBe(1);
    expect(run({ pageSize: -100 }).length).toBe(1);
    expect(run({ pageSize: Number.NaN }).length).toBe(24);
    expect(run({ pageSize: Number.POSITIVE_INFINITY }).length).toBe(24);
    expect(run({ pageSize: "10" as unknown as number }).length).toBe(24);
    const first = run({});
    for (const page of [0, -1, -0, 0.5, Number.NaN, Number.NEGATIVE_INFINITY, "2" as unknown as number]) {
      expect(run({ page })).toEqual(first);
    }
    const lastPage = Math.ceil(PUBLISHED / 24);
    expect(run({ page: lastPage }).length).toBe(PUBLISHED - 24 * (lastPage - 1)); // partial last page
    expect(run({ page: lastPage + 1 })).toEqual([]);
    expect(val(svc.search("", { now: AFTER_SEED, page: lastPage + 1 })).total).toBe(PUBLISHED);
  });

  test("ranked queries: no gaps or duplicates across all pages, stable on repeated calls", () => {
    const svc = createSearchService({ db: seeded() });
    for (const q of ["", "a", "co", "s", "the", "wireless", "e"]) {
      const total = val(svc.search(q, { now: AFTER_SEED })).total;
      for (const pageSize of [1, 5, 7, 24, 48]) {
        const pages: string[] = [];
        for (let page = 1; page <= Math.ceil(total / pageSize) + 1; page++) {
          const a = val(svc.search(q, { now: AFTER_SEED, page, pageSize }));
          const b = val(svc.search(q, { now: AFTER_SEED, page, pageSize }));
          expect(b.ids).toEqual(a.ids);
          expect(a.total).toBe(total);
          pages.push(...a.ids);
        }
        expect(pages.length).toBe(total);
        expect(new Set(pages).size).toBe(total);
        const big = allPagesOf48(svc, q);
        expect(pages).toEqual(big);
      }
    }
  });

  test("browse-all over every published seeded product covers all ids exactly once", () => {
    const db = seeded();
    const svc = createSearchService({ db });
    const all = db
      .query<{ id: string }, [string]>("SELECT id FROM products WHERE published_at <= ? ORDER BY id")
      .all(new Date(AFTER_SEED).toISOString())
      .map((r) => r.id);
    expect(all.length).toBe(PUBLISHED);
    expect(all).toEqual(SEED_PUBLISHED_CATALOG.map((e) => e.product.id).sort());
    for (const pageSize of [1, 11, 13, 24, 48]) {
      const seen: string[] = [];
      for (let p = 1; p <= Math.ceil(PUBLISHED / pageSize); p++) seen.push(...val(svc.search("   ", { now: AFTER_SEED, page: p, pageSize })).ids);
      expect(seen).toEqual(all);
    }
  });
});

// ---------------------------------------------------------------------------
// published / stock
// ---------------------------------------------------------------------------

describe("criterion 6: unpublished never appear, out-of-stock unless inStockOnly", () => {
  const products: Fx[] = [
    { id: "p_live", name: "Nimbus Speaker" },
    { id: "p_oos", name: "Nimbus Speaker Lite", stock: 0 },
    { id: "p_future", name: "Nimbus Speaker Pro Zanzibar", publishedAt: "2026-06-01T00:00:00.001Z", brandId: "b_hidden" },
  ];

  test("search and browse", () => {
    const svc = createSearchService({ db: fixture(products) });
    expect([...val(svc.search("nimbus", { now: FIX_NOW })).ids].sort()).toEqual(["p_live", "p_oos"]);
    expect(val(svc.search("nimbus", { now: FIX_NOW, inStockOnly: true })).ids).toEqual(["p_live"]);
    expect(val(svc.search("zanzibar", { now: FIX_NOW })).total).toBe(0);
    expect(val(svc.search("", { now: FIX_NOW })).ids).toEqual(["p_live", "p_oos"]);
    expect(val(svc.search("", { now: FIX_NOW, inStockOnly: true })).ids).toEqual(["p_live"]);
    // 1 ms later it is published
    expect(val(svc.search("zanzibar", { now: FIX_NOW + 1 })).ids).toEqual(["p_future"]);
    // inStockOnly only when strictly true
    expect(val(svc.search("nimbus", { now: FIX_NOW, inStockOnly: "yes" as unknown as boolean })).total).toBe(2);
  });

  test("suggest / didYouMean never leak unpublished products, brands or words", () => {
    const db = fixture(products);
    const svc = createSearchService({ db });
    // suggest/didYouMean use the real clock; FIX_NOW + 1ms is in the past, so push the future product far ahead.
    db.run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = 'p_future'");
    for (const p of ["zanz", "zanzibar", "hidden", "hid", "pro"]) {
      const s = svc.suggest(p);
      expect(s.some((x) => x.href.includes("future") || x.label.includes("Zanzibar") || x.label === "Hidden Brand")).toBe(false);
    }
    expect(svc.didYouMean("zanzibat")).toBeNull();
    // suggestions ignore stock
    expect(svc.suggest("nimbus").map((x) => x.href)).toContain("/products/oos");
  });
});

// ---------------------------------------------------------------------------
// suggest
// ---------------------------------------------------------------------------

function checkSuggestShape(s: ReturnType<SearchService["suggest"]>): void {
  expect(s.length).toBeLessThanOrEqual(8);
  expect(new Set(s.map((x) => x.href)).size).toBe(s.length);
  expect(new Set(s.map((x) => `${x.type}|${x.label.toLowerCase()}`)).size).toBe(s.length);
  for (const x of s) {
    expect(typeof x.label).toBe("string");
    expect(x.label.length).toBeGreaterThan(0);
    expect(x.href.startsWith("/")).toBe(true);
    expect(x.href.startsWith("//")).toBe(false);
    expect(x.href.includes("\\")).toBe(false);
    expect(["product", "category", "brand"]).toContain(x.type);
  }
}

describe("criterion 4: suggest", () => {
  test("'' and 1-char prefixes → []", () => {
    const svc = createSearchService({ db: seeded() });
    for (const p of ["", " ", "a", "Z", "1", " h ", "é", "😀", "-a", "\"a\"", "a*", "(a)", null, undefined, 1, {}]) {
      expect(svc.suggest(p)).toEqual([]);
    }
  });

  test("shape invariants for every 2-letter prefix a..z × a..z over the seed", () => {
    const svc = createSearchService({ db: seeded() });
    const letters = "abcdefghijklmnopqrstuvwxyz";
    for (const x of letters) for (const y of letters) checkSuggestShape(svc.suggest(x + y));
  });

  test("at most 2 categories and at most 2 brands per response (seed, all 2-letter prefixes)", () => {
    const svc = createSearchService({ db: seeded() });
    const letters = "abcdefghijklmnopqrstuvwxyz";
    const violations: string[] = [];
    for (const x of letters) {
      for (const y of letters) {
        const s = svc.suggest(x + y);
        const c = s.filter((v) => v.type === "category").length;
        const b = s.filter((v) => v.type === "brand").length;
        if (c > 2 || b > 2) violations.push(`${x}${y}: ${c} categories, ${b} brands`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("suggest('co') specifically: ≤ 2 categories, ≤ 2 brands", () => {
    const s = createSearchService({ db: seeded() }).suggest("co");
    expect(s.filter((v) => v.type === "category").length).toBeLessThanOrEqual(2);
    expect(s.filter((v) => v.type === "brand").length).toBeLessThanOrEqual(2);
  });

  test("hostile slugs and labels: hrefs encoded and site-relative, labels returned as plain text", () => {
    const db = fixture([
      { id: "p_evil1", name: "<b>Xylo</b> Speaker", slug: "//evil.example/x" },
      { id: "p_evil2", name: "Xylo Phone", slug: "a b?c#d" },
      { id: "p_evil3", name: "Xylo javascript:alert(1)", slug: "javascript:alert(1)" },
    ]);
    const s = createSearchService({ db }).suggest("xylo");
    checkSuggestShape(s);
    expect(s.map((x) => x.label)).toContain("<b>Xylo</b> Speaker");
    for (const x of s.filter((v) => v.type === "product")) expect(x.href.startsWith("/products/")).toBe(true);
    expect(s.map((x) => x.href)).toContain("/products/%2F%2Fevil.example%2Fx");
  });

  test("categories/brands only with a published product; parent category counts via child", () => {
    const db = fixture([{ id: "p_g", name: "Gizmo", brandId: "b_qa", categoryId: "c_child" }]);
    const svc = createSearchService({ db });
    const g = svc.suggest("gadget");
    expect(g.filter((x) => x.type === "category").map((x) => x.href).sort()).toEqual(["/category/qa-child", "/category/qa-dept"]);
    expect(svc.suggest("hidden")).toEqual([]);
    expect(svc.suggest("quokka")).toContainEqual({ type: "brand", label: "Quokka Works", href: "/brand/qa-brand" });
  });

  test("never more than 8 even with many matching products", () => {
    const many: Fx[] = Array.from({ length: 30 }, (_, i) => ({ id: `p_m${String(i).padStart(2, "0")}`, name: `Gadget Model ${i}` }));
    const s = createSearchService({ db: fixture(many) }).suggest("gadget");
    checkSuggestShape(s);
    expect(s.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// didYouMean
// ---------------------------------------------------------------------------

describe("criterion 5: didYouMean", () => {
  const fx: Fx[] = [
    { id: "p_h", name: "Studio Headphones" },
    { id: "p_l", name: "Desk Lamp" },
    { id: "p_k", name: "Kettle" },
  ];

  test("hedphones → headphones (fixture)", () => {
    expect(createSearchService({ db: fixture(fx) }).didYouMean("hedphones")).toBe("headphones");
    expect(createSearchService({ db: fixture(fx) }).didYouMean("HEDPHONES")).toBe("headphones");
  });

  test("null when the query already matches (incl. stem/prefix matches)", () => {
    const svc = createSearchService({ db: fixture(fx) });
    for (const q of ["headphones", "headphone", "Headphones", "lamp", "lam", "studio lamp"]) expect(svc.didYouMean(q)).toBeNull();
  });

  test("null for nonsense, empty, emoji, non-strings", () => {
    const svc = createSearchService({ db: fixture(fx) });
    for (const q of ["qxzvbnmkj", "zzzzzzzz", "", "   ", "😀", "\u0000", "__proto__", "constructor"]) expect(svc.didYouMean(q)).toBeNull();
    for (const q of [null, undefined, 5, {}]) expect(svc.didYouMean(q as unknown as string)).toBeNull();
  });

  test("never returns the (normalised) input back", () => {
    const svc = createSearchService({ db: seeded() });
    const r = rng(7);
    const inputs = ["hedphones", "Hedphones", "wireless hedphones", "lmap", "ketle", "HEADPHONES", ...Array.from({ length: 200 }, () => randomString(r, 14))];
    for (const q of inputs) {
      const s = svc.didYouMean(q);
      if (s !== null) {
        expect(s).not.toBe(q);
        expect(s).not.toBe(normalizeSearchQuery(q).normalizedQuery);
      }
    }
  });

  test("4-char words allow exactly 1 edit", () => {
    const svc = createSearchService({ db: fixture(fx) });
    expect(svc.didYouMean("lmap")).toBe("lamp"); // transposition
    expect(svc.didYouMean("lanp")).toBe("lamp"); // substitution
    expect(svc.didYouMean("lxxp")).toBeNull(); // 2 edits on a 4-char word
    expect(svc.didYouMean("ketle")).toBe("kettle"); // 5 chars, 1 edit
    expect(svc.didYouMean("kettlexx")).toBe("kettle"); // 8 chars, 2 edits allowed
    expect(svc.didYouMean("kettlexxx")).toBeNull(); // 3 edits
    expect(svc.didYouMean("lam")).toBeNull(); // prefix match, already matches
  });

  test("search() zero-result carries the hint; matching search carries null", () => {
    const svc = createSearchService({ db: fixture(fx) });
    expect(val(svc.search("studio hedphones", { now: FIX_NOW })).didYouMean).toBe("studio headphones");
    expect(val(svc.search("studio", { now: FIX_NOW })).didYouMean).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildMatchExpression fuzz + SQL hygiene
// ---------------------------------------------------------------------------

describe("MATCH expression safety", () => {
  test("fuzz 1000 random token lists (quotes, control chars, operators) always parse", () => {
    const db = seeded();
    const q = db.query("SELECT COUNT(*) AS n FROM products_fts WHERE products_fts MATCH ?");
    const r = rng(0xbeef);
    for (let i = 0; i < 1000; i++) {
      const n = 1 + Math.floor(r() * 10);
      const tokens = Array.from({ length: n }, () => randomString(r, 16));
      const match = buildMatchExpression(tokens);
      if (match === "") continue;
      expect(() => q.get(match)).not.toThrow();
    }
  });

  test("raw hostile strings used directly as single tokens always parse", () => {
    const db = seeded();
    const q = db.query("SELECT COUNT(*) AS n FROM products_fts WHERE products_fts MATCH ?");
    for (const s of HOSTILE_STRINGS) {
      const match = buildMatchExpression([s]);
      if (match !== "") expect(() => q.get(match)).not.toThrow();
    }
  });

  test("MATCH is always a bound parameter; only constants are interpolated into SQL", () => {
    const src = readFileSync(join(CATALOG_DIR, "search-repository.ts"), "utf8");
    const matches = src.match(/products_fts MATCH\s+[^\s]+/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) expect(m).toBe("products_fts MATCH ?");
    const interpolations = new Set(src.match(/\$\{[^}]+\}/g) ?? []);
    expect([...interpolations].sort()).toEqual(["${BM25_RANK}", "${STOCK_CLAUSE}"]);
    const svcSrc = readFileSync(join(CATALOG_DIR, "search-service.ts"), "utf8");
    expect(/\.(query|run|prepare|exec)\(/.test(svcSrc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// failures, singleton, options
// ---------------------------------------------------------------------------

const boom = (): never => {
  throw new Error("SQLITE_IOERR: disk I/O error");
};

function realRepo(db: Database): SearchRepository {
  return new SqliteSearchRepository(db);
}

describe("SQLite failures", () => {
  const methods: (keyof SearchRepository)[] = [
    "countMatches",
    "findMatchIds",
    "countPublished",
    "listPublishedIds",
    "suggestProducts",
    "listCategoriesWithPublished",
    "listBrandsWithPublished",
    "listVocabulary",
    "listPublishedText",
  ];

  test("each repository method failing alone: search → err (never throws), suggest → [], didYouMean → null", () => {
    const db = seeded();
    for (const m of methods) {
      const base = realRepo(db);
      const repo = new Proxy(base, {
        get(target, prop, receiver) {
          if (prop === m) return boom;
          const v: unknown = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
      const svc = createSearchServiceWithRepository(repo);
      for (const q of ["", "headphones", "hedphones", "qxzvbn"]) {
        let r: ReturnType<SearchService["search"]> | undefined;
        expect(() => {
          r = svc.search(q, { now: AFTER_SEED });
        }).not.toThrow();
        if (r !== undefined && !r.ok) expect(typeof r.error.code).toBe("string");
      }
      expect(() => svc.suggest("head")).not.toThrow();
      expect(() => svc.didYouMean("hedphones")).not.toThrow();
    }
    const allBroken = Object.fromEntries(methods.map((m) => [m, boom])) as unknown as SearchRepository;
    const svc = createSearchServiceWithRepository(allBroken);
    expect(svc.search("headphones").ok).toBe(false);
    expect(svc.search("").ok).toBe(false);
    expect(svc.suggest("headphones")).toEqual([]);
    expect(svc.didYouMean("hedphones")).toBeNull();
  });

  // QA-triage-search 2026-11-07: load, not a regression. 500 inputs = 2.2-2.5 s CPU (3.4-6.3 s wall at load 17-81), max input 138 ms;
  // 486/500 take the did-you-mean path. Split into 3 slices (~0.8 s CPU each) with an explicit timeout so suite load cannot flake it.
  const SQLITE_FUZZ_INPUTS: readonly string[] = (() => {
    const r = rng(42);
    return Array.from({ length: 500 }, () => randomString(r, 120));
  })();
  for (const [from, to] of [[0, 167], [167, 334], [334, 500]] as const) {
    test(`real SQLite never produces err for any hostile input (errors only when SQLite fails) [fuzz ${from}–${to - 1}]`, () => {
      const svc = createSearchService({ db: seeded() });
      for (const q of SQLITE_FUZZ_INPUTS.slice(from, to)) expect(svc.search(q, { now: AFTER_SEED }).ok).toBe(true);
    }, 30_000);
  }

  test("closed database → err, not throw", () => {
    const db = seeded();
    const svc = createSearchService({ db });
    db.close();
    expect(() => svc.search("headphones")).not.toThrow();
    expect(svc.search("headphones").ok).toBe(false);
    expect(svc.suggest("headphones")).toEqual([]);
    expect(svc.didYouMean("hedphones")).toBeNull();
  });

  test("null / hostile options never throw", () => {
    const svc = createSearchService({ db: seeded() });
    expect(() => svc.search("headphones", { now: "tomorrow" as unknown as number, page: {} as unknown as number })).not.toThrow();
    expect(() => svc.suggest("headphones", "8" as unknown as number)).not.toThrow();
  });

  test("options = null (JS caller / parsed JSON) does not throw (README: search never throws)", () => {
    const svc = createSearchService({ db: seeded() });
    expect(() => svc.search("headphones", null as unknown as SearchOptions)).not.toThrow();
  });

});

describe("singleton", () => {
  function withMemoryDb(fn: () => void): void {
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = ":memory:";
    try {
      fn();
    } finally {
      closeDatabase();
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
    }
  }

  test("getSearchService() is reused", () => {
    withMemoryDb(() => {
      const a = getSearchService();
      expect(getSearchService()).toBe(a);
    });
  });

  test("after closeDatabase() the singleton still works (rebinds to the new connection like peer services)", () => {
    withMemoryDb(() => {
      getSearchService();
      closeDatabase();
      const r = getSearchService().search("");
      expect(r.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// performance
// ---------------------------------------------------------------------------

describe("performance", () => {
  function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  }

  test("search over the seed: median < 20 ms (ranked, browse, zero-result with did-you-mean)", () => {
    const svc = createSearchService({ db: seeded() });
    const queries = ["wireless headphones", "a", "", "co", "hedphones", "qxzvbnmkj", "x".repeat(10_000)];
    const results: Record<string, number> = {};
    for (const q of queries) {
      svc.search(q, { now: AFTER_SEED });
      const times: number[] = [];
      for (let i = 0; i < 31; i++) {
        const t0 = performance.now();
        svc.search(q, { now: AFTER_SEED });
        times.push(performance.now() - t0);
      }
      results[q.slice(0, 20)] = median(times);
    }
    for (const [, ms] of Object.entries(results)) expect(ms).toBeLessThan(20);
    console.log("[QA-T32 perf] median ms:", JSON.stringify(results));
  });
});
