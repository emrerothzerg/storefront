import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createListingPageDeps, type ListingPageDeps } from "@/app/_listing/listing-page";
import { isAllowedInternalHref } from "@/content/routes";
import { POPULAR_SEARCHES, SEARCH_TIPS } from "@/content/search-help";
import { fail, ok } from "@/lib/result";
import type { ListingService } from "@/server/catalog/listing-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";

import { LISTING_PROMO_MIN_RESULTS } from "@/app/_listing/listing-page";
import { FEEDBACK_SUGGESTIONS_MAX } from "@/components/molecules/FeedbackBlock";
import { CHIP_ROW_MAX_ITEMS, type ChipRowItem } from "@/components/molecules/ChipRow";

import {
  BROWSE_TITLE,
  loadSearchPage,
  MAX_RELATED_CHIPS,
  relatedSearchChips,
  searchAllIds,
  searchFeedbackSuggestions,
  searchHeading,
  searchMetadata,
  searchPromoSlots,
  searchTitle,
} from "./search-page";

function chipQueries(items: readonly ChipRowItem[]): string[] {
  return items.map((item) => ("query" in item && item.query !== undefined ? item.query : `LINK:${item.label}`));
}

type ListCall = ReturnType<ListingService["list"]>;
function callResult(spy: { mock: { results: ReadonlyArray<{ value: unknown }> } }, index = 0) {
  const r = spy.mock.results[index]?.value as ListCall | undefined;
  if (r === undefined || !r.ok) throw new Error("list() call missing or failed");
  return r.value;
}

const SITE = "https://shop.example.com";
const env = process.env as Record<string, string | undefined>;
const originalSiteUrl = env.NEXT_PUBLIC_SITE_URL;
const NOW = Date.now();
let db: Database;
let deps: ListingPageDeps;
let nowCalls = 0;

beforeEach(() => {
  env.NEXT_PUBLIC_SITE_URL = SITE;
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  nowCalls = 0;
  deps = createListingPageDeps(db, () => {
    nowCalls += 1;
    return NOW;
  });
});

afterEach(() => {
  db.close();
  if (originalSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

function allIds(): string[] {
  return db.query<{ id: string }, []>("SELECT id FROM products ORDER BY id").all().map((r) => r.id);
}

/** Products visible at NOW (the seed future-dates a few). */
function publishedCount(): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM products WHERE published_at <= ?")
      .get(new Date(NOW).toISOString())?.n ?? -1
  );
}

function stubSearch(ids: readonly string[], didYouMean: string | null): ListingPageDeps {
  return {
    ...deps,
    search: {
      search: () => ok({ ids, total: ids.length, normalizedQuery: "q", terms: ["q"], didYouMean, browseAll: false }),
    },
  };
}

describe("browse mode (empty q)", () => {
  test.each([[{}], [{ q: "" }], [{ q: "   " }], [{ q: "\u0000​" }]])("%p -> all products, 'All results'", (sp) => {
    const view = loadSearchPage(sp, deps);
    expect(view.mode).toBe("browse");
    expect(view.title).toBe(BROWSE_TITLE);
    expect(view.result.total).toBe(publishedCount());
    expect(view.sort).toBe("featured");
    expect(view.noResults).toBeNull();
    expect(view.relatedSearches).toEqual([]);
  });
});

describe("results", () => {
  test("q=desk: relevance results, one list() call, now read once, no writes", () => {
    const before = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n;
    const list = spyOn(deps.listing, "list");
    const view = loadSearchPage({ q: "desk" }, deps);
    expect(list).toHaveBeenCalledTimes(1);
    expect(nowCalls).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n).toBe(before);
    expect(view.mode).toBe("results");
    expect(view.title).toBe("Showing results for “desk”");
    expect(view.sort).toBe("relevance");
    expect(view.result.total).toBeGreaterThan(0);
    expect(view.result.items.some((p) => /desk/i.test(p.name))).toBe(true);
    expect(view.facets).toBe(callResult(list).facets);
    expect(view.showFilters).toBe(true);
    expect(view.didYouMean).toBeNull();
  });

  test("searchAllIds pages through every match", () => {
    const calls = spyOn(deps.search, "search");
    const found = searchAllIds(deps, "the", NOW);
    expect(found.ids.length).toBe(new Set(found.ids).size);
    expect(calls.mock.calls.every((c) => c[1]?.pageSize === 48)).toBe(true);
  });

  test("search failure throws (500), never a silent empty page", () => {
    const broken: ListingPageDeps = { ...deps, search: { search: () => fail("INTERNAL_ERROR", "x") } };
    expect(() => loadSearchPage({ q: "desk" }, broken)).toThrow();
  });

  const HOSTILE: readonly [string, string][] = [
    ["FTS syntax", 'desk" OR lamp* NEAR(a b) ^title:x -'],
    ["10k chars", "lamp ".repeat(2000)],
    ["script tag", "<script>alert(1)</script>"],
    ["emoji only", "\u{1F600}\u{1F525}"],
    ["bidi + zero width", "‮desk​"],
    ["control chars", "desk\u0000\u0007lamp"],
    ["operators only", "AND OR NOT"],
    ["SQL", "'; DROP TABLE products; --"],
  ];
  test.each(HOSTILE)("hostile q (%s): view built, echo is cleaned text <= 100 code units", (_name, q) => {
    const view = loadSearchPage({ q }, deps);
    expect(view.params.q).toBeDefined();
    expect((view.params.q ?? "").length).toBeLessThanOrEqual(100);
    expect(view.title).toBe(searchHeading(view.params.q));
    for (const q2 of chipQueries(view.relatedSearches)) expect(q2.toLowerCase()).not.toBe((view.params.q ?? "").toLowerCase());
    expect(view.title).not.toMatch(/[\u0000-\u001f​‮]/);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM products").get()?.n).toBe(allIds().length);
  });

  test("unknown dept/category slug is dropped before the single list() call (D-T105-1)", () => {
    const list = spyOn(deps.listing, "list");
    const view = loadSearchPage({ q: "desk", dept: "no-such-dept" }, deps);
    expect(list).toHaveBeenCalledTimes(1);
    expect(view.params.dept).toBeUndefined();
    expect(view.result.total).toBeGreaterThan(0);
  });

  test("page beyond the last keeps the total (template renders the empty-page state)", () => {
    const view = loadSearchPage({ q: "desk", page: "50" }, deps);
    expect(view.result.items).toHaveLength(0);
    expect(view.result.total).toBeGreaterThan(0);
    expect(view.noResults).toBeNull();
  });
});

describe("did you mean", () => {
  test("misspelling with no results shows the service suggestion as a /search link", () => {
    const view = loadSearchPage({ q: "headphnes" }, deps);
    expect(view.result.total).toBe(0);
    expect(view.didYouMean).toEqual({ label: "headphones", href: "/search?q=headphones" });
  });

  test("gated on the result count: shown for <= 2 results, hidden for more", () => {
    const ids = allIds();
    expect(loadSearchPage({ q: "x" }, stubSearch(ids.slice(0, 2), "foo")).didYouMean?.label).toBe("foo");
    expect(loadSearchPage({ q: "x" }, stubSearch(ids.slice(0, 1), "foo")).didYouMean?.label).toBe("foo");
    expect(loadSearchPage({ q: "x" }, stubSearch(ids.slice(0, 3), "foo")).didYouMean).toBeNull();
    expect(loadSearchPage({ q: "x" }, stubSearch([], null)).didYouMean).toBeNull();
    expect(loadSearchPage({ q: "foo" }, stubSearch([], "foo")).didYouMean).toBeNull();
  });
});

describe("no results", () => {
  test("tips, popular searches, departments; facets omitted", () => {
    const view = loadSearchPage({ q: "zzqxv" }, deps);
    expect(view.result.total).toBe(0);
    expect(view.showFilters).toBe(false);
    const nr = view.noResults;
    expect(nr?.tips).toEqual(SEARCH_TIPS);
    expect(nr?.popular.map((l) => l.label)).toEqual([...POPULAR_SEARCHES]);
    expect(nr?.departments.length).toBe(8);
    expect(view.relatedSearches).toEqual([]);
    expect(nr?.clearFiltersHref).toBeNull();
    for (const link of [...(nr?.popular ?? []), ...(nr?.departments ?? [])]) expect(isAllowedInternalHref(link.href)).toBe(true);
  });

  test("departments use the request now: categoryTree(now), no hidden wall-clock read", () => {
    const tree = spyOn(deps.listing, "categoryTree");
    const wall = spyOn(Date, "now");
    try {
      loadSearchPage({ q: "zzqxv" }, deps);
      expect(tree.mock.calls).toEqual([[NOW]]);
      expect(wall).not.toHaveBeenCalled();
    } finally {
      wall.mockRestore();
      tree.mockRestore();
    }
  });

  test("related searches: single terms of the query that have results", () => {
    const view = loadSearchPage({ q: "headphones zzqxv" }, deps);
    expect(view.result.total).toBe(0);
    expect(view.relatedSearches).toEqual([{ query: "headphones" }]);
  });

  test("filtered to zero: clear-filters link keeps q only", () => {
    const view = loadSearchPage({ q: "desk", min: "999999" }, deps);
    expect(view.result.total).toBe(0);
    expect(view.noResults?.clearFiltersHref).toBe("/search?q=desk");
  });

  test.each(POPULAR_SEARCHES.map((t) => [t]))("popular search %p returns results on the seeded catalogue", (term) => {
    expect(loadSearchPage({ q: term }, deps).result.total).toBeGreaterThan(0);
  });
});

describe("searchMetadata", () => {
  test("noindex,follow; canonical /search?q= without facets/page", () => {
    const md = searchMetadata({ q: "desk lamp", brand: "voltline", page: "3", sort: "price_asc" });
    expect(md.robots).toEqual({ index: false, follow: true });
    expect(md.alternates?.canonical).toBe(`${SITE}/search?q=desk+lamp`);
    expect(md.title).toBe("Results for “desk lamp”");
    const browse = searchMetadata({});
    expect(browse.alternates?.canonical).toBe(`${SITE}/search`);
    expect(browse.title).toBe(BROWSE_TITLE);
    expect(searchMetadata({ q: "x".repeat(10_000) }).robots).toEqual({ index: false, follow: true });
  });
});

describe("v3 heading, related chips, promos, feedback, clock (T168)", () => {
  test("heading: 'Showing results for “q”' in results mode, 'All results' in browse; metadata title unchanged", () => {
    expect(searchHeading(undefined)).toBe(BROWSE_TITLE);
    expect(searchHeading("uno")).toBe("Showing results for “uno”");
    expect(searchTitle("uno")).toBe("Results for “uno”");
  });

  test("results: related chips are query chips from the result facets, <= 12, never the current query, each finds results", () => {
    for (const q of ["desk", "headphones", "coffee", "the"]) {
      const view = loadSearchPage({ q }, deps);
      const queries = chipQueries(view.relatedSearches);
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.length).toBeLessThanOrEqual(CHIP_ROW_MAX_ITEMS);
      expect(queries.every((x) => !x.startsWith("LINK:"))).toBe(true);
      expect(queries.map((x) => x.toLowerCase())).not.toContain(q);
      expect(new Set(queries.map((x) => x.toLowerCase())).size).toBe(queries.length);
      for (const chip of queries) expect({ chip, total: loadSearchPage({ q: chip }, deps).result.total > 0 }).toEqual({ chip, total: true });
    }
  });

  test("related chips skip the selected facet value", () => {
    const view = loadSearchPage({ q: "desk" }, deps);
    const top = view.facets.brands.find((b) => b.count > 0);
    if (top === undefined) throw new Error("expected a brand facet for desk");
    const filtered = loadSearchPage({ q: "desk", brand: top.value }, deps);
    expect(chipQueries(filtered.relatedSearches)).not.toContain(top.label);
  });

  test("relatedSearchChips: trims, dedupes case-insensitively, drops excluded and blank, caps at 12", () => {
    const many = Array.from({ length: 30 }, (_, i) => `term ${i}`);
    expect(relatedSearchChips(many, [])).toHaveLength(MAX_RELATED_CHIPS);
    expect(MAX_RELATED_CHIPS).toBe(12);
    expect(relatedSearchChips(["  Desk  ", "desk", "", "   ", "Lamp", "UNO"], ["uno"])).toEqual([{ query: "Desk" }, { query: "Lamp" }]);
    expect(relatedSearchChips(['<script>alert("x")</script>'], [])).toEqual([{ query: '<script>alert("x")</script>' }]);
  });

  test("zero results: the did-you-mean suggestion is never also a chip", () => {
    const view = loadSearchPage({ q: "headphnes" }, deps);
    expect(view.didYouMean?.label).toBe("headphones");
    expect(chipQueries(view.relatedSearches)).not.toContain("headphones");
  });

  test("promo slots: page 1, >= 8 results, no facet, no dept (CONTRACTS L-15)", () => {
    const browse = loadSearchPage({}, deps);
    expect(browse.result.total).toBeGreaterThanOrEqual(LISTING_PROMO_MIN_RESULTS);
    expect(browse.promoSlots.length).toBeGreaterThan(0);
    expect(browse.promoSlots.length).toBeLessThanOrEqual(3);
    for (const slot of browse.promoSlots) {
      expect(isAllowedInternalHref(slot.tile.cta?.href ?? "")).toBe(true);
      expect(slot.tile.cta?.href.startsWith("/search")).toBe(false);
    }
    expect(loadSearchPage({ page: "2" }, deps).promoSlots).toEqual([]);
    expect(loadSearchPage({ instock: "1" }, deps).promoSlots).toEqual([]);
    expect(loadSearchPage({ brand: "voltline" }, deps).promoSlots).toEqual([]);
    expect(loadSearchPage({ dept: "electronics" }, deps).promoSlots).toEqual([]);
    expect(loadSearchPage({ q: "zzqxv" }, deps).promoSlots).toEqual([]);
    // sort and view are not facets
    expect(loadSearchPage({ sort: "price_asc" }, deps).promoSlots.length).toBeGreaterThan(0);
  });

  test("promo threshold: 7 results -> none, 8 -> tiles (stubbed search ids)", () => {
    const ids = allIds();
    expect(loadSearchPage({ q: "x" }, stubSearch(ids.slice(0, 7), null)).promoSlots).toEqual([]);
    const eight = loadSearchPage({ q: "x" }, stubSearch(ids.slice(0, 20), null));
    expect(eight.result.total).toBeGreaterThanOrEqual(8);
    expect(eight.promoSlots.length).toBeGreaterThan(0);
    expect(searchPromoSlots({ q: "x" }, 7)).toEqual([]);
    expect(searchPromoSlots({ q: "x" }, 8).length).toBeGreaterThan(0);
    expect(searchPromoSlots({ q: "x", page: 2 }, 100)).toEqual([]);
    expect(searchPromoSlots({ q: "x", dept: "electronics" }, 100)).toEqual([]);
    expect(searchPromoSlots({ q: "x", rating: 4 }, 100)).toEqual([]);
    expect(searchPromoSlots({ q: "x" }, Number.NaN)).toEqual([]);
  });

  test("feedback: a popular search (not the current one), all products, help; 3 links, allow-listed", () => {
    const view = loadSearchPage({ q: "desk" }, deps);
    expect(view.feedback.suggestions).toEqual(searchFeedbackSuggestions("desk"));
    expect(view.feedback.suggestions.length).toBeLessThanOrEqual(FEEDBACK_SUGGESTIONS_MAX);
    expect(searchFeedbackSuggestions("desk")).toEqual([
      { label: "Search for “headphones”", href: "/search?q=headphones" },
      { label: "Browse all products", href: "/products" },
      { label: "Search help and FAQs", href: "/help" },
    ]);
    expect(searchFeedbackSuggestions("headphones")[0]?.href).toBe("/search?q=desk");
    expect(searchFeedbackSuggestions(undefined)[0]?.href).toBe("/search?q=headphones");
    for (const s of view.feedback.suggestions) expect(isAllowedInternalHref(s.href)).toBe(true);
  });

  test("one clock: now read once and exposed as the same instant for the cards", () => {
    const wall = spyOn(Date, "now");
    try {
      const view = loadSearchPage({ q: "desk" }, deps);
      expect(nowCalls).toBe(1);
      expect(view.now.getTime()).toBe(NOW);
      expect(wall).not.toHaveBeenCalled();
    } finally {
      wall.mockRestore();
    }
  });
});
