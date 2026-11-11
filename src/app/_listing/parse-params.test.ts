import { describe, expect, test } from "bun:test";
import { LISTING_SORT_VALUES, type ListingParams } from "@/components/molecules/_listing-url";
import { LISTING_SORTS } from "@/server/catalog/listing-service";
import { isAllowedInternalHref } from "@/content/routes";
import {
  DEFAULT_PRESERVED_KEYS,
  MAX_BRANDS,
  MAX_IGNORED,
  MAX_PAGE,
  MAX_PRICE_DOLLARS,
  MAX_QUERY_LENGTH,
  buildListingUrl,
  canonicalListingUrl,
  cleanListingQuery,
  isFacetedListing,
  paginationRel,
  parseListingParams,
  searchParamsToRecord,
  toListingQuery,
} from "./parse-params";

const MB = "a".repeat(1024 * 1024);
const parse = (sp: unknown, opts?: Parameters<typeof parseListingParams>[1]) => parseListingParams(sp, opts);

describe("parseListingParams: q", () => {
  test("trims, collapses whitespace, strips control and zero-width characters", () => {
    expect(parse({ q: "  oak   desk \n" }).params.q).toBe("oak desk");
    expect(parse({ q: "oak\u0000desk\u0007" }).params.q).toBe("oak desk");
    expect(parse({ q: "o​ak‍ ‮desk﻿" }).params.q).toBe("oak desk");
  });

  const hostile: [unknown, string | undefined][] = [
    ["<script>alert(1)</script>", "<script>alert(1)</script>"],
    ['" OR 1=1 -- NEAR(a b) col:x*', '" OR 1=1 -- NEAR(a b) col:x*'],
    [MB, "a".repeat(MAX_QUERY_LENGTH)],
    ["\u0000\u0001​   ", undefined],
    ["", undefined],
    ["\uD83D", undefined],
    [["shoes", "boots"], "shoes"],
    [[["nested"]], undefined],
    [42, undefined],
    [{ toString: () => "x" }, undefined],
  ];
  test.each(hostile)("hostile q %#", (value, expected) => {
    const r = parse({ q: value });
    expect(r.params.q).toBe(expected);
    if (expected === undefined) expect(r.ignored.some((i) => i.key === "q")).toBe(true);
  });

  test("100-unit cut never splits a surrogate pair", () => {
    const q = `${"a".repeat(99)}😀tail`;
    const out = parse({ q }).params.q ?? "";
    expect(out).toBe("a".repeat(99));
    expect(cleanListingQuery(`${"a".repeat(98)}😀tail`)).toBe(`${"a".repeat(98)}😀`);
  });

  test("cleaning is idempotent", () => {
    for (const raw of ["  a  b ", "x​y", `${"é".repeat(120)}`, "😀 😀"]) {
      const once = cleanListingQuery(raw) ?? "";
      expect(cleanListingQuery(once)).toBe(once === "" ? undefined : once);
    }
  });

  test("repeated q keeps the first and reports the rest", () => {
    const r = parse({ q: ["a", "b", "c"] });
    expect(r.params.q).toBe("a");
    expect(r.ignored.filter((i) => i.key === "q" && i.reason === "repeated")).toHaveLength(2);
  });
});

describe("parseListingParams: dept / category", () => {
  const bad: unknown[] = ["Electronics", "../etc", "a b", "a".repeat(65), "", "%2e%2e", ["x", "y"], 7, "desk<script>", "ünï"];
  for (const key of ["dept", "category"] as const) {
    test(`${key}: valid slug kept`, () => {
      expect(parse({ [key]: "home-office-2" }).params[key]).toBe("home-office-2");
      expect(parse({ [key]: "a".repeat(64) }).params[key]).toBe("a".repeat(64));
    });
    test.each(bad.map((v): [unknown] => [v]))(`${key}: hostile %# dropped or first taken`, (value) => {
      const r = parse({ [key]: value });
      if (Array.isArray(value)) expect(r.params[key]).toBe("x");
      else expect(r.params[key]).toBeUndefined();
      expect(r.ignored.some((i) => i.key === key)).toBe(true);
    });
    test(`${key}: 1 MB value dropped, ignored value shortened`, () => {
      const r = parse({ [key]: MB });
      expect(r.params[key]).toBeUndefined();
      expect(r.ignored[0]?.value.length).toBeLessThanOrEqual(65);
    });
  }
});

describe("parseListingParams: brand", () => {
  test("repeated → deduped, sorted slugs", () => {
    expect(parse({ brand: ["zeta", "acme", "zeta"] }).params.brand).toEqual(["acme", "zeta"]);
    expect(parse({ brand: "acme" }).params.brand).toEqual(["acme"]);
  });
  test("max 10; the rest reported", () => {
    const many = Array.from({ length: 15 }, (_, i) => `b${String(i).padStart(2, "0")}`);
    const r = parse({ brand: many });
    expect(r.params.brand).toHaveLength(MAX_BRANDS);
    expect(r.ignored.filter((i) => i.key === "brand")).toHaveLength(5);
  });
  test("allowedBrands filters unknown slugs", () => {
    const r = parse({ brand: ["acme", "nope"] }, { allowedBrands: new Set(["acme"]) });
    expect(r.params.brand).toEqual(["acme"]);
    expect(r.ignored).toEqual([{ key: "brand", value: "nope", reason: "unknown brand" }]);
  });
  const hostile: unknown[] = ["ACME", "", "a,b", "<b>", MB, [["acme"]], [1, null], { a: 1 }, Array(100_000).fill("x"), "../x"];
  test.each(hostile.map((v): [unknown] => [v]))("hostile brand %#", (value) => {
    const r = parse({ brand: value });
    expect(() => JSON.stringify(r)).not.toThrow();
    if (r.params.brand !== undefined) for (const b of r.params.brand) expect(b).toMatch(/^[a-z0-9-]{1,64}$/);
    expect(r.ignored.length).toBeLessThanOrEqual(MAX_IGNORED);
  });
  test("100k-element array does not blow up and keeps one slug", () => {
    expect(parse({ brand: Array(100_000).fill("x") }).params.brand).toEqual(["x"]);
  });
});

describe("parseListingParams: min / max (whole dollars)", () => {
  test("valid pair kept; leading zeros normalised", () => {
    expect(parse({ min: "25", max: "049" }).params).toEqual({ min: 25, max: 49 });
    expect(parse({ min: "0" }).params).toEqual({ min: 0 });
  });
  test("min > max drops both", () => {
    const r = parse({ min: "50", max: "10" });
    expect(r.params.min).toBeUndefined();
    expect(r.params.max).toBeUndefined();
    expect(r.ignored.map((i) => i.reason)).toEqual(["min greater than max", "min greater than max"]);
  });
  const hostile: unknown[] = ["-1", "1.5", "1e3", "abc", "", " 5", String(MAX_PRICE_DOLLARS + 1), "99999999999999999999", MB.replace(/a/g, "9"), ["5", "6"], "0x10", "NaN", "Infinity"];
  for (const key of ["min", "max"] as const) {
    test.each(hostile.map((v): [unknown] => [v]))(`${key} hostile %#`, (value) => {
      const r = parse({ [key]: value });
      if (Array.isArray(value)) expect(r.params[key]).toBe(5);
      else expect(r.params[key]).toBeUndefined();
      expect(r.ignored.some((i) => i.key === key)).toBe(true);
    });
  }
});

describe("parseListingParams: rating, instock, deals, sort, page, view", () => {
  test("valid values", () => {
    expect(parse({ rating: "4", instock: "1", deals: "1", sort: "price_asc", page: "3", view: "list" }).params).toEqual({
      rating: 4,
      instock: true,
      deals: true,
      sort: "price_asc",
      page: 3,
      view: "list",
    });
    expect(parse({ page: String(MAX_PAGE) }).params.page).toBe(MAX_PAGE);
    expect(parse({ view: "grid" }).params.view).toBe("grid");
  });
  const cases: Record<string, unknown[]> = {
    rating: ["0", "5", "4.5", "-1", "", "four", MB, [[]], 4],
    instock: ["true", "0", "yes", "", "11", MB, [["1"]], 1],
    deals: ["true", "0", "on", "", " 1", MB, [{}], true],
    sort: ["PRICE_ASC", "bogus", "constructor", "__proto__", "", MB, [[]], 3],
    page: ["0", "-1", "1.5", String(MAX_PAGE + 1), "", "abc", MB, "1e2", [[]]],
    view: ["LIST", "table", "", "grid ", MB, [["list"]], null],
  };
  for (const [key, values] of Object.entries(cases)) {
    test.each(values.map((v): [unknown] => [v]))(`${key} hostile %#`, (value) => {
      const r = parse({ [key]: value });
      expect((r.params as Record<string, unknown>)[key]).toBeUndefined();
      expect(r.ignored.some((i) => i.key === key)).toBe(true);
    });
  }
  test("sort accepts exactly the service's set", () => {
    expect([...LISTING_SORT_VALUES]).toEqual([...LISTING_SORTS]);
    for (const s of LISTING_SORTS) expect(parse({ sort: s }).params.sort).toBe(s);
  });
});

describe("parseListingParams: unknown keys and garbage", () => {
  test("unknown keys dropped and listed; preserved keys go to extra", () => {
    const r = parse({ foo: "1", __proto__x: "2", ref: "mail", utm_source: "news", p: ["a", "b"], _rsc: "x" });
    expect(r.params.extra).toEqual({ ref: "mail", utm_source: "news", p: "a" });
    expect(r.ignored.map((i) => `${i.key}:${i.reason}`).sort()).toEqual(
      ["__proto__x:unknown parameter", "_rsc:unknown parameter", "foo:unknown parameter", "p:repeated"].sort(),
    );
  });
  test("preserve: [] drops every unknown key", () => {
    expect(parse({ ref: "x" }, { preserve: [] }).params).toEqual({});
  });
  test("preserved values are cleaned and length-capped", () => {
    expect(parse({ ref: "a\u0000b​" }).params.extra).toEqual({ ref: "ab" });
    expect(parse({ ref: MB }).params.extra).toBeUndefined();
    expect(DEFAULT_PRESERVED_KEYS).toContain("p");
  });
  test("never throws on non-objects, prototype keys, proxies and throwing getters", () => {
    const evilProxy = new Proxy({}, { ownKeys: () => { throw new Error("boom"); } });
    const getter = Object.defineProperty({}, "q", { enumerable: true, get: () => { throw new Error("boom"); } });
    for (const sp of [null, undefined, 42, "q=x", [], [["q", "x"]], evilProxy, getter, JSON.parse('{"__proto__": {"q": "x"}}')]) {
      expect(() => parse(sp)).not.toThrow();
    }
    expect(parse(JSON.parse('{"__proto__": {"q": "x"}}')).params.q).toBeUndefined();
  });
  test("ignored list is capped", () => {
    const sp = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, "v"]));
    expect(parse(sp).ignored).toHaveLength(MAX_IGNORED);
  });
});

// Deterministic PRNG (mulberry32) for the property test.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL: Record<string, readonly unknown[]> = {
  q: ["oak desk", "  a  b ", "<b>x</b>", "😀 lamp", "a​b", "\u0000", "", "x".repeat(150), `${"y".repeat(99)}😀`, "a&b=c#d", "+%20"],
  dept: ["electronics", "Electronics", "", "home-office", "../x"],
  category: ["desks", "chairs", "a b", ""],
  brand: ["acme", "zeta", "ACME", "", "acme", "b-2", "x".repeat(70)],
  min: ["0", "25", "-1", "1.5", "", "100", "007"],
  max: ["10", "49", "1000000", "1000001", "abc"],
  rating: ["1", "4", "5", "", "x"],
  instock: ["1", "0", "true"],
  deals: ["1", "", "yes"],
  sort: [...LISTING_SORT_VALUES, "bogus", ""],
  page: ["1", "2", "1000", "1001", "0", "x"],
  view: ["grid", "list", "table"],
  ref: ["mail", "", "a\u0000b"],
  p: ["prod-a", "prod-b"],
  junk: ["1", "<x>"],
};

function randomInput(r: () => number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, pool] of Object.entries(POOL)) {
    if (r() < 0.45) continue;
    const pick = () => pool[Math.floor(r() * pool.length)];
    const roll = r();
    out[key] = roll < 0.6 ? pick() : roll < 0.9 ? [pick(), pick(), pick()] : roll < 0.95 ? 12 : [[pick()]];
  }
  return out;
}

describe("round trip (criterion 2)", () => {
  test("buildListingUrl(parse(x)) is a fixed point over 300 random inputs", () => {
    const r = rng(91);
    for (let i = 0; i < 300; i++) {
      const input = randomInput(r);
      const url1 = buildListingUrl("/search", parse(input).params);
      const reparsed = parse(searchParamsToRecord(new URL(url1, "http://x").searchParams));
      const url2 = buildListingUrl("/search", reparsed.params);
      expect({ i, url: url2 }).toEqual({ i, url: url1 });
      // A built URL never yields an ignored entry: it holds only valid values.
      expect({ i, ignored: reparsed.ignored }).toEqual({ i, ignored: [] });
      expect(isAllowedInternalHref(url1)).toBe(true);
    }
  });

  test("defaults omitted; keys in deterministic order", () => {
    expect(buildListingUrl("/search", { q: "x", sort: "relevance", page: 1, view: "grid" })).toBe("/search?q=x");
    expect(buildListingUrl("/products", { sort: "featured", instock: false })).toBe("/products");
    expect(
      buildListingUrl("/search", { view: "list", page: 2, brand: ["z", "a"], q: "x", extra: { ref: "m" }, min: 1 }),
    ).toBe("/search?q=x&brand=a&brand=z&min=1&page=2&view=list&ref=m");
  });
});

describe("canonicalListingUrl (criterion 5)", () => {
  test("keeps q and page; page 1 omitted", () => {
    expect(canonicalListingUrl("/search", { q: "oak desk", page: 3 })).toBe("/search?q=oak+desk&page=3");
    expect(canonicalListingUrl("/search", { q: "oak", page: 1 })).toBe("/search?q=oak");
    expect(canonicalListingUrl("/category/desks", { page: 2, view: "list", extra: { utm_source: "x" } })).toBe(
      "/category/desks?page=2",
    );
  });
  test("faceted or re-sorted pages canonicalise to the page-1 base", () => {
    const faceted: ListingParams[] = [
      { brand: ["acme"], page: 3 },
      { min: 10, page: 2 },
      { rating: 4 },
      { instock: true },
      { deals: true },
      { category: "desks" },
      { dept: "electronics" },
      { sort: "price_asc", page: 2 },
    ];
    for (const p of faceted) {
      expect(isFacetedListing(p)).toBe(true);
      expect(canonicalListingUrl("/category/office", { ...p, q: "x" })).toBe("/category/office?q=x");
    }
    expect(isFacetedListing({ q: "x", sort: "relevance", page: 4, view: "list" })).toBe(false);
  });
  test("base query/hash and off-site bases are neutralised", () => {
    expect(canonicalListingUrl("/deals?x=1#h", {})).toBe("/deals");
    expect(canonicalListingUrl("//evil.com", {})).toBe("/");
  });
});

describe("paginationRel (criterion 3)", () => {
  const params: ListingParams = { q: "x", brand: ["acme"], page: 2 };
  test("prev/next preserve filters", () => {
    expect(paginationRel("/search", params, 3)).toEqual({
      prev: "/search?q=x&brand=acme",
      next: "/search?q=x&brand=acme&page=3",
    });
  });
  test("first, last, single, out of range, garbage count", () => {
    expect(paginationRel("/search", { q: "x" }, 3)).toEqual({ next: "/search?q=x&page=2" });
    expect(paginationRel("/search", { page: 3 }, 3)).toEqual({ prev: "/search?page=2" });
    expect(paginationRel("/search", { page: 9 }, 3)).toEqual({ prev: "/search?page=3" });
    expect(paginationRel("/search", {}, 1)).toEqual({});
    expect(paginationRel("/search", {}, 0)).toEqual({});
    expect(paginationRel("/search", {}, Number.NaN)).toEqual({});
  });
});

describe("toListingQuery", () => {
  test("maps params to the service query (dollars -> cents)", () => {
    const { params } = parse({ q: "x", dept: "electronics", brand: ["b", "a"], min: "25", max: "49", rating: "3", instock: "1", deals: "1", sort: "price_desc", page: "2" });
    expect(toListingQuery(params, { pageSize: 16, now: 5 })).toEqual({
      categorySlug: "electronics",
      brandSlugs: ["a", "b"],
      minPriceCents: 2500,
      maxPriceCents: 4999,
      minRating: 3,
      inStockOnly: true,
      dealsOnly: true,
      sort: "price_desc",
      page: 2,
      pageSize: 16,
      now: 5,
    });
  });
  test("category precedence, default sort, forced deals, ids", () => {
    expect(toListingQuery({ category: "desks", dept: "x" }, { categorySlug: "office" }).categorySlug).toBe("desks");
    expect(toListingQuery({ dept: "x" }, { categorySlug: "office" }).categorySlug).toBe("office");
    expect(toListingQuery({}, { defaultSort: "best_selling" }).sort).toBe("best_selling");
    expect(toListingQuery({ sort: "newest" }, { defaultSort: "best_selling" }).sort).toBe("newest");
    expect(toListingQuery({}, { dealsOnly: true, ids: ["a"] })).toEqual({ dealsOnly: true, ids: ["a"] });
    expect(toListingQuery({ max: MAX_PRICE_DOLLARS }).maxPriceCents).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});
