import { describe, expect, test } from "bun:test";
import { LISTING_SORTS } from "@/server/catalog/listing-service";
import {
  LISTING_PARAM_KEYS,
  LISTING_SORT_VALUES,
  buildListingHref,
  defaultSortFor,
  elidedSort,
  formatWholeDollars,
  hasActiveFilters,
  listingEntries,
  mergeListingParams,
  priceBucketToParams,
  safeListingBase,
  type ListingParams,
} from "./_listing-url";

/** Deterministic PRNG (mulberry32) so property runs are reproducible. */
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

const NASTY = ["", " ", "a&b", "x#y", "café", "日本", "🙂", "a=b", "a+b", "%20", "<b>", "a b", "?", "/", "brand"];

function pick<T>(r: () => number, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)] as T;
}

function maybe<T>(r: () => number, value: () => T): T | undefined {
  return r() < 0.5 ? value() : undefined;
}

function randomParams(r: () => number): ListingParams {
  const ints = [-1, 0, 1, 2, 4, 5, 25, 49, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e20];
  const extra: Record<string, string> = {};
  if (r() < 0.5) extra[pick(r, ["p", "utm_source", "ref", "q", "page", "_rsc", "z"])] = pick(r, NASTY);
  if (r() < 0.3) extra.p = pick(r, NASTY);
  return {
    q: maybe(r, () => pick(r, NASTY)),
    dept: maybe(r, () => pick(r, NASTY)),
    category: maybe(r, () => pick(r, NASTY)),
    brand: maybe(r, () => Array.from({ length: Math.floor(r() * 4) }, () => pick(r, NASTY))),
    min: maybe(r, () => pick(r, ints)),
    max: maybe(r, () => pick(r, ints)),
    rating: maybe(r, () => pick(r, ints)),
    instock: maybe(r, () => r() < 0.5),
    deals: maybe(r, () => r() < 0.5),
    sort: maybe(r, () => pick(r, [...LISTING_SORT_VALUES, "bogus", ""])),
    page: maybe(r, () => pick(r, ints)),
    view: maybe(r, () => pick(r, ["grid", "list"] as const)),
    extra,
  };
}

/** Minimal inverse used only to check stability here (T91 owns the real parser). */
function parseBack(href: string): ListingParams {
  const url = new URL(href, "http://local.invalid");
  const sp = url.searchParams;
  const extra: Record<string, string> = {};
  sp.forEach((value, key) => {
    if (!(LISTING_PARAM_KEYS as readonly string[]).includes(key)) extra[key] = value;
  });
  const num = (k: string) => (sp.has(k) ? Number(sp.get(k)) : undefined);
  return {
    q: sp.get("q") ?? undefined,
    dept: sp.get("dept") ?? undefined,
    category: sp.get("category") ?? undefined,
    brand: sp.getAll("brand"),
    min: num("min"),
    max: num("max"),
    rating: num("rating"),
    instock: sp.get("instock") === "1",
    deals: sp.get("deals") === "1",
    sort: sp.get("sort") ?? undefined,
    page: num("page"),
    view: sp.get("view") === "list" ? "list" : undefined,
    extra,
  };
}

describe("LISTING_SORT_VALUES", () => {
  test("mirrors LISTING_SORTS from the listing service", () => {
    expect([...LISTING_SORT_VALUES]).toEqual([...LISTING_SORTS]);
  });
});

describe("buildListingHref basics", () => {
  test("empty params give the bare base", () => {
    expect(buildListingHref("/search", {})).toBe("/search");
  });

  test("stable key order regardless of input order", () => {
    const a = buildListingHref("/s", { view: "list", sort: "newest", q: "desk", brand: ["b", "a"], min: 5, category: "c" });
    const b = buildListingHref("/s", { category: "c", min: 5, brand: ["a", "b"], q: "desk", sort: "newest", view: "list" });
    expect(a).toBe(b);
    expect(a).toBe("/s?q=desk&category=c&brand=a&brand=b&min=5&sort=newest&view=list");
  });

  test("omits defaults: page 1, grid, false booleans, blank strings, default sort", () => {
    expect(buildListingHref("/s", { page: 1, view: "grid", instock: false, deals: false, q: "  ", sort: "featured" })).toBe("/s");
    expect(buildListingHref("/s", { q: "lamp", sort: "relevance" })).toBe("/s?q=lamp");
    expect(buildListingHref("/s", { q: "lamp", sort: "featured" })).toBe("/s?q=lamp&sort=featured");
    expect(buildListingHref("/s", { sort: "relevance" })).toBe("/s?sort=relevance");
  });

  test("booleans as 1, invalid numbers and sorts dropped", () => {
    expect(buildListingHref("/s", { instock: true, deals: true })).toBe("/s?instock=1&deals=1");
    expect(buildListingHref("/s", { min: -1, max: 2.5, rating: 5, page: Number.NaN, sort: "bogus" })).toBe("/s");
    expect(buildListingHref("/s", { rating: 0 })).toBe("/s");
    expect(buildListingHref("/s", { rating: 4, min: 0 })).toBe("/s?min=0&rating=4");
  });

  test("brands are repeated, de-duplicated, trimmed and sorted", () => {
    expect(buildListingHref("/s", { brand: ["zeta", " acme ", "acme", ""] })).toBe("/s?brand=acme&brand=zeta");
  });

  test("encodes &, #, = and unicode via URLSearchParams", () => {
    const href = buildListingHref("/s", { q: "a&b x#y=z café 🙂" });
    expect(href).toBe("/s?q=a%26b+x%23y%3Dz+caf%C3%A9+%F0%9F%99%82");
    expect(href.includes("#")).toBe(false);
    expect(new URL(href, "http://h.invalid").searchParams.get("q")).toBe("a&b x#y=z café 🙂");
  });
});

describe("page handling", () => {
  const params: ListingParams = { q: "desk", brand: ["acme"], page: 3, view: "list" };

  test("keeps page for an empty patch and for view changes", () => {
    expect(buildListingHref("/s", params)).toContain("page=3");
    expect(buildListingHref("/s", params, { view: "grid" })).toBe("/s?q=desk&brand=acme&page=3");
  });

  test.each<[string, Partial<ListingParams>]>([
    ["brand", { brand: [] }],
    ["category", { category: "c" }],
    ["min", { min: 10 }],
    ["max", { max: undefined }],
    ["rating", { rating: 4 }],
    ["instock", { instock: true }],
    ["deals", { deals: true }],
    ["sort", { sort: "newest" }],
    ["q", { q: "chair" }],
    ["dept", { dept: "home" }],
  ])("drops page when %s changes", (_name, patch) => {
    expect(buildListingHref("/s", params, patch)).not.toContain("page=");
  });

  test("explicit page in the patch wins", () => {
    expect(buildListingHref("/s", params, { brand: [], page: 2 })).toBe("/s?q=desk&page=2&view=list");
  });

  test("undefined in a patch removes the key", () => {
    expect(mergeListingParams({ q: "a", category: "c" }, { category: undefined })).toEqual({ q: "a", category: undefined });
  });
});

describe("unknown params (extra)", () => {
  test("are preserved after managed keys, sorted by key", () => {
    expect(buildListingHref("/s", { q: "a", extra: { utm_source: "news", p: "desk-1" } }, { brand: ["x"] })).toBe(
      "/s?q=a&brand=x&p=desk-1&utm_source=news",
    );
  });

  test("cannot override managed keys or carry _rsc", () => {
    expect(buildListingHref("/s", { extra: { page: "9", q: "evil", brand: "x", _rsc: "abc", "": "v" } })).toBe("/s");
  });

  test("hostile extra values are encoded, not injected", () => {
    const href = buildListingHref("/s", { extra: { p: "a&q=evil#frag" } });
    const sp = new URL(href, "http://h.invalid").searchParams;
    expect(sp.getAll("q")).toEqual([]);
    expect(sp.get("p")).toBe("a&q=evil#frag");
  });
});

describe("safeListingBase", () => {
  test.each([
    ["/search", "/search"],
    ["/search?q=x#top", "/search"],
    [" /deals ", "/deals"],
    ["//evil.example", "/"],
    ["https://evil.example/x", "/"],
    ["javascript:alert(1)", "/"],
    ["/\\evil", "/"],
    ["", "/"],
  ])("%p -> %p", (input, expected) => {
    expect(safeListingBase(input)).toBe(expected);
  });
});

describe("property: random params", () => {
  test("stable, no duplicate non-brand keys, brand repeated, page rules, extras kept (500 runs)", () => {
    const r = rng(20261107);
    for (let i = 0; i < 500; i += 1) {
      const params = randomParams(r);
      const href = buildListingHref("/search", params);
      // Deterministic.
      expect(buildListingHref("/search", params)).toBe(href);
      // Re-building from the parsed URL gives the same URL (idempotent normal form).
      expect(buildListingHref("/search", parseBack(href))).toBe(href);
      const sp = new URL(href, "http://h.invalid").searchParams;
      const keys = [...sp.keys()];
      const nonBrand = keys.filter((k) => k !== "brand");
      expect(new Set(nonBrand).size).toBe(nonBrand.length);
      expect(href.includes("#")).toBe(false);
      // Managed keys appear in canonical order.
      const managed = keys.filter((k) => (LISTING_PARAM_KEYS as readonly string[]).includes(k));
      const order = managed.map((k) => LISTING_PARAM_KEYS.indexOf(k as (typeof LISTING_PARAM_KEYS)[number]));
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // Brands as repeated params, de-duplicated.
      const brands = sp.getAll("brand");
      expect(new Set(brands).size).toBe(brands.length);
      // Filter change drops page.
      expect(buildListingHref("/search", params, { instock: !params.instock })).not.toContain("page=");
      // Unknown extras survive any patch.
      for (const [k, v] of Object.entries(params.extra ?? {})) {
        if ((LISTING_PARAM_KEYS as readonly string[]).includes(k) || k === "_rsc") continue;
        const after = new URL(buildListingHref("/search", params, { brand: ["n"] }), "http://h.invalid").searchParams;
        expect(after.get(k)).toBe(v);
      }
    }
  });
});

describe("misc helpers", () => {
  test("defaultSortFor", () => {
    expect(defaultSortFor(undefined)).toBe("featured");
    expect(defaultSortFor("  ")).toBe("featured");
    expect(defaultSortFor("desk")).toBe("relevance");
  });

  test("hasActiveFilters ignores q/dept/sort/page/view/extra", () => {
    expect(hasActiveFilters({ q: "a", dept: "d", sort: "newest", page: 2, view: "list", extra: { p: "x" } })).toBe(false);
    expect(hasActiveFilters({ brand: ["a"] })).toBe(true);
    expect(hasActiveFilters({ rating: 9 })).toBe(false);
  });

  test("priceBucketToParams converts cents to whole dollars", () => {
    expect(priceBucketToParams({ minCents: 0, maxCents: 2499 })).toEqual({ min: undefined, max: 24 });
    expect(priceBucketToParams({ minCents: 2500, maxCents: 4999 })).toEqual({ min: 25, max: 49 });
    expect(priceBucketToParams({ minCents: 25000, maxCents: null })).toEqual({ min: 250, max: undefined });
  });

  test("formatWholeDollars", () => {
    expect(formatWholeDollars(25)).toBe("$25");
    expect(formatWholeDollars(1000)).toBe("$1,000");
  });

  test("listingEntries feeds hidden inputs", () => {
    expect(listingEntries({ q: "a", sort: "newest", page: 2 }, { sort: undefined, page: undefined })).toEqual([["q", "a"]]);
  });
});

describe("route defaultSort option (consistency ac)", () => {
  test("only the route default is omitted; featured survives on a best_selling route", () => {
    const opts = { defaultSort: "best_selling" } as const;
    expect(buildListingHref("/best-sellers", { sort: "featured" }, {}, opts)).toBe("/best-sellers?sort=featured");
    expect(buildListingHref("/best-sellers", { sort: "best_selling" }, {}, opts)).toBe("/best-sellers");
    expect(buildListingHref("/best-sellers", { sort: "featured" }, { page: 2 }, opts)).toBe(
      "/best-sellers?sort=featured&page=2",
    );
    expect(listingEntries({ sort: "featured", view: "list" }, {}, { defaultSort: "newest" })).toEqual([
      ["sort", "featured"],
      ["view", "list"],
    ]);
    expect(listingEntries({ sort: "newest" }, {}, { defaultSort: "newest" })).toEqual([]);
  });

  test("without the option the q-based default still applies", () => {
    expect(buildListingHref("/products", { sort: "featured" })).toBe("/products");
    expect(buildListingHref("/search", { q: "x", sort: "relevance" })).toBe("/search?q=x");
    expect(elidedSort(undefined)).toBe("featured");
    expect(elidedSort("desk")).toBe("relevance");
    expect(elidedSort("desk", { defaultSort: "rating" })).toBe("rating");
  });

  test("an invalid defaultSort at runtime falls back to the q-based default", () => {
    const bogus = { defaultSort: "bogus" } as unknown as { defaultSort: "featured" };
    expect(elidedSort(undefined, bogus)).toBe("featured");
    expect(buildListingHref("/products", { sort: "featured" }, {}, bogus)).toBe("/products");
  });
});
