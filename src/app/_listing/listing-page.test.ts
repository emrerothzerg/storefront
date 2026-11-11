import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { isAllowedInternalHref } from "@/content/routes";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SEED_CATALOG_STATS, seedDatabase } from "@/server/db/seed";
import { fail } from "@/lib/result";
import type { ListingService } from "@/server/catalog/listing-service";

import {
  collectionMetadata,
  createListingPageDeps,
  filterLabels,
  isFacetedForRoute,
  ITEM_LIST_MAX,
  listingBreadcrumbJsonLd,
  listingItemListJsonLd,
  listingMetadata,
  listingRelLinks,
  listingSeo,
  ListingUnavailableError,
  loadCollectionPage,
  loadListing,
  NO_DEALS_LINKS,
  normaliseRouteParams,
  composeMetaDescription,
  COLLECTIONS,
  dropUnknownCategorySlugs,
  META_DESCRIPTION_MAX,
  META_DESCRIPTION_MIN,
  productPath,
  templateBreadcrumb,
  withoutParams,
  brandChips,
  categoryChips,
  listingCardProps,
  listingFeedback,
  listingPromoSlots,
  LISTING_PROMO_AFTER_INDEXES,
  LISTING_PROMO_COLUMNS,
  LISTING_PROMO_MAX,
  LISTING_PROMO_MIN_RESULTS,
  LISTING_PROMO_SPAN,
  promoCellsBefore,
  RELATED_CHIPS_MAX,
  type ListingPageDeps,
} from "./listing-page";
import { LISTING_PROMOS, type ListingPromoCopy } from "@/content/listing-promos";
import { MAX_PROMO_SLOTS, selectPromoSlots } from "@/components/organisms/ProductGrid/place-promos";
import { FEEDBACK_HREF } from "@/components/molecules/FeedbackBlock";

type ListCall = ReturnType<ListingService["list"]>;
function callResult(spy: { mock: { results: ReadonlyArray<{ value: unknown }> } }, index = 0) {
  const r = spy.mock.results[index]?.value as ListCall | undefined;
  if (r === undefined || !r.ok) throw new Error("list() call missing or failed");
  return r.value;
}

const SITE = "https://shop.example.com";
const env = process.env as Record<string, string | undefined>;
const originalSiteUrl = env.NEXT_PUBLIC_SITE_URL;
let db: Database;
let deps: ListingPageDeps;
let nowCalls = 0;
const NOW = Date.now();

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

function totalChanges(): number {
  return db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}

function publishedCount(): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM products WHERE published_at <= ?")
      .get(new Date(NOW).toISOString())?.n ?? -1
  );
}

let orderSeq = 0;
function paidOrder(productIds: readonly string[], quantity = 1): void {
  orderSeq += 1;
  const id = `order_lp_${orderSeq}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
       region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
     VALUES (?, '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'paid', 100, 100, 'USD', 'T', 't@example.com', '1 St', 'C',
       'RG', '00000', 'US', '4242', ?, ?, 'processing')`,
  ).run(id, `idem_${id}`, new Date(NOW - 86_400_000).toISOString());
  const ins = db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'x', 100, ?)");
  for (const pid of productIds) ins.run(id, pid, quantity);
}

describe("route normalisation", () => {
  test("withoutParams copies and never mutates the parser object", () => {
    const params = { q: "desk", brand: ["a"], page: 2 };
    const next = withoutParams(params, ["brand"]);
    expect(next).toEqual({ q: "desk", page: 2 });
    expect(params.brand).toEqual(["a"]);
  });

  test("drops the route default sort, deals on /deals and brand on brand pages", () => {
    expect(normaliseRouteParams({ sort: "best_selling" }, { base: "/best-sellers", defaultSort: "best_selling" })).toEqual({});
    expect(normaliseRouteParams({ sort: "featured" }, { base: "/best-sellers", defaultSort: "best_selling" })).toEqual({
      sort: "featured",
    });
    expect(normaliseRouteParams({ deals: true, instock: true }, { base: "/deals", dealsOnly: true })).toEqual({ instock: true });
    expect(normaliseRouteParams({ brand: ["x"] }, { base: "/brand/x", brandSlug: "x" })).toEqual({});
    const same = { page: 2 };
    expect(normaliseRouteParams(same, { base: "/products" })).toBe(same);
  });

  test("q is a /search-only parameter: dropped unless the route sets allowQuery (D-T107-1)", () => {
    expect(normaliseRouteParams({ q: "desk", page: 2 }, { base: "/products" })).toEqual({ page: 2 });
    expect(normaliseRouteParams({ q: "desk" }, { base: "/category/office", categorySlug: "office" })).toEqual({});
    expect(normaliseRouteParams({ q: "desk" }, { base: "/brand/x", brandSlug: "x" })).toEqual({});
    const kept = { q: "desk", page: 2 };
    expect(normaliseRouteParams(kept, { base: "/search", allowQuery: true })).toBe(kept);
  });

  test("non-search canonical never carries q; /search keeps it", () => {
    for (const kind of Object.keys(COLLECTIONS) as (keyof typeof COLLECTIONS)[]) {
      const md = collectionMetadata(kind, { q: "anything", page: "2" });
      expect({ kind, canonical: md.alternates?.canonical }).toEqual({
        kind,
        canonical: `${SITE}${COLLECTIONS[kind].base}?page=2`,
      });
      expect(md.robots).toBeUndefined();
    }
  });

  test("isFacetedForRoute: facets, dept, non-default sort for the route", () => {
    expect(isFacetedForRoute({})).toBe(false);
    expect(isFacetedForRoute({ page: 3, view: "list" })).toBe(false);
    expect(isFacetedForRoute({ brand: ["a"] })).toBe(true);
    expect(isFacetedForRoute({ dept: "books" })).toBe(true);
    expect(isFacetedForRoute({ sort: "price_asc" })).toBe(true);
    expect(isFacetedForRoute({ sort: "featured" }, "best_selling")).toBe(true);
    expect(isFacetedForRoute({ sort: "best_selling" }, "best_selling")).toBe(false);
    expect(isFacetedForRoute({ sort: "featured" })).toBe(false);
    // Same rule as buildListingHref: relevance is the default only with a query.
    expect(isFacetedForRoute({ sort: "relevance" })).toBe(true);
    expect(isFacetedForRoute({ sort: "rating" }, "rating")).toBe(false);
    expect(isFacetedForRoute({ q: "desk" })).toBe(false);
    expect(isFacetedForRoute({ q: "desk", sort: "relevance" })).toBe(false);
  });
});

describe("canonical / robots / rel matrix", () => {
  const base = "/category/office";

  test("plain page 1: canonical base, indexable", () => {
    expect(listingSeo(base, {})).toEqual({ canonicalPath: base, faceted: false });
    const md = listingMetadata({ title: "Office", description: "d", base, params: {} });
    expect(md.alternates?.canonical).toBe(`${SITE}${base}`);
    expect(md.robots).toBeUndefined();
    expect(md.title).toBe("Office");
  });

  test("plain page 3: canonical to itself, title marks the page", () => {
    const md = listingMetadata({ title: "Office", description: "d", base, params: { page: 3, view: "list" } });
    expect(md.alternates?.canonical).toBe(`${SITE}${base}?page=3`);
    expect(md.robots).toBeUndefined();
    expect(md.title).toBe("Office (page 3)");
  });

  test("faceted page 3: canonical page-1 base, noindex follow", () => {
    const md = listingMetadata({ title: "Office", description: "d", base, params: { brand: ["voltline"], page: 3 } });
    expect(md.alternates?.canonical).toBe(`${SITE}${base}`);
    expect(md.robots).toEqual({ index: false, follow: true });
    expect(md.title).toBe("Office");
  });

  test("re-sorted collection canonicalises to the base and is noindex", () => {
    const md = listingMetadata({
      title: "Best Sellers",
      description: "d",
      base: "/best-sellers",
      params: { sort: "featured", page: 2 },
      defaultSort: "best_selling",
    });
    expect(md.alternates?.canonical).toBe(`${SITE}/best-sellers`);
    expect(md.robots).toEqual({ index: false, follow: true });
  });

  test("search: forced noindex follow, canonical keeps only q", () => {
    const md = listingMetadata({
      title: "x",
      description: "d",
      base: "/search",
      params: { q: "desk lamp", page: 2, brand: ["a"], sort: "price_asc" },
      noindex: true,
      dropPage: true,
    });
    expect(md.alternates?.canonical).toBe(`${SITE}/search?q=desk+lamp`);
    expect(md.robots).toEqual({ index: false, follow: true });
  });

  test("rel prev/next are absolute and keep filters", () => {
    expect(listingRelLinks(base, {}, 1)).toEqual({});
    expect(listingRelLinks(base, {}, 3)).toEqual({ next: `${SITE}${base}?page=2` });
    expect(listingRelLinks(base, { page: 2, instock: true }, 3)).toEqual({
      prev: `${SITE}${base}?instock=1`,
      next: `${SITE}${base}?instock=1&page=3`,
    });
    expect(listingRelLinks(base, { page: 9 }, 3)).toEqual({ prev: `${SITE}${base}?page=3` });
  });

  test("rel prev/next keep a sort that differs from the route default (D-T107-2)", () => {
    expect(listingRelLinks("/best-sellers", { sort: "featured", page: 2 }, 3, "best_selling")).toEqual({
      prev: `${SITE}/best-sellers?sort=featured`,
      next: `${SITE}/best-sellers?sort=featured&page=3`,
    });
    expect(listingRelLinks("/best-sellers", { page: 2 }, 3, "best_selling")).toEqual({
      prev: `${SITE}/best-sellers`,
      next: `${SITE}/best-sellers?page=3`,
    });
    // Without the route default, featured is the global default and is omitted.
    expect(listingRelLinks("/products", { sort: "featured", page: 2 }, 3)).toEqual({
      prev: `${SITE}/products`,
      next: `${SITE}/products?page=3`,
    });
  });
});

describe("loadListing", () => {
  test("one list() call; params passed through untouched", () => {
    const spy = spyOn(deps.listing, "list");
    const params = { instock: true };
    const loaded = loadListing(deps, params, { base: "/products" }, NOW);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(loaded.params).toBe(params);
    expect(loaded.dropped).toEqual([]);
    expect(loaded.result.items.every((p) => p.stock > 0)).toBe(true);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ inStockOnly: true, pageSize: 24, now: NOW });
  });

  test("unknown category/dept slug: dropped BEFORE the single list() call (D-T105-1)", () => {
    const spy = spyOn(deps.listing, "list");
    const loaded = loadListing(deps, { category: "nope", dept: "nada", instock: true }, { base: "/search" }, NOW);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(loaded.dropped).toEqual(["category", "dept"]);
    expect(loaded.params).toEqual({ instock: true });
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty("categorySlug");
    expect(loaded.result.total).toBeGreaterThan(0);
  });

  test("a known category is kept while an unknown dept is dropped (one call)", () => {
    const spy = spyOn(deps.listing, "list");
    const loaded = loadListing(deps, { category: "audio", dept: "nada" }, { base: "/products" }, NOW);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(loaded.dropped).toEqual(["dept"]);
    expect(loaded.params).toEqual({ category: "audio" });
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ categorySlug: "audio" });
  });

  test("dropUnknownCategorySlugs: no lookup without slugs; same object when nothing is dropped", () => {
    const breadcrumb = spyOn(deps.listing, "breadcrumb");
    const params = { instock: true };
    expect(dropUnknownCategorySlugs(deps.listing, params)).toEqual({ params, dropped: [] });
    expect(dropUnknownCategorySlugs(deps.listing, params).params).toBe(params);
    expect(breadcrumb).not.toHaveBeenCalled();
    const known = { dept: "electronics" };
    expect(dropUnknownCategorySlugs(deps.listing, known).params).toBe(known);
    expect(breadcrumb).toHaveBeenCalledTimes(1);
  });

  test("brand scope goes on the query; other failures throw ListingUnavailableError", () => {
    const spy = spyOn(deps.listing, "list");
    const loaded = loadListing(deps, {}, { base: "/brand/voltline", brandSlug: "voltline" }, NOW);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ brandSlugs: ["voltline"] });
    expect(loaded.result.items.every((p) => p.brandSlug === "voltline")).toBe(true);

    spy.mockImplementation(() => fail("INTERNAL_ERROR", "boom"));
    expect(() => loadListing(deps, {}, { base: "/products" }, NOW)).toThrow(ListingUnavailableError);
    spy.mockImplementation(() => fail("NOT_FOUND", "gone"));
    expect(() => loadListing(deps, { category: "x" }, { base: "/products" }, NOW)).toThrow(ListingUnavailableError);
  });

  test("parent category lists its children's products", () => {
    const loaded = loadListing(deps, {}, { base: "/category/electronics", categorySlug: "electronics" }, NOW);
    expect(loaded.result.total).toBe(SEED_CATALOG_STATS.byDepartment.electronics ?? -1);
    const slugs = new Set(loaded.result.items.map((p) => p.categorySlug));
    expect([...slugs].sort()).toEqual(["audio", "computer-accessories", "smart-home"]);
  });
});

describe("JSON-LD and links", () => {
  test("ItemList: at most 24 entries, absolute PDP URLs, null when empty", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ slug: `p-${i}`, name: `P ${i}` }));
    const ld = listingItemListJsonLd(items);
    expect(ld?.itemListElement).toHaveLength(ITEM_LIST_MAX);
    expect(ld?.numberOfItems).toBe(24);
    expect(ld?.itemListElement[0]).toMatchObject({ position: 1, url: `${SITE}/products/p-0`, name: "P 0" });
    expect(listingItemListJsonLd([])).toBeNull();
    expect(listingItemListJsonLd([{ slug: "../x", name: "bad" }])).toBeNull();
  });

  test("productPath rejects non-route slugs", () => {
    expect(productPath("walnut-desk")).toBe("/products/walnut-desk");
    expect(productPath("")).toBeNull();
    expect(productPath("a/b")).toBeNull();
  });

  test("breadcrumb items and BreadcrumbList", () => {
    const crumbs = [{ label: "Home", href: "/" }, { label: "Bad", href: "https://evil.example" }, { label: "Now" }];
    expect(templateBreadcrumb(crumbs)).toEqual([{ label: "Home", href: "/" }, { label: "Bad" }, { label: "Now" }]);
    const ld = listingBreadcrumbJsonLd([{ label: "Home", href: "/" }, { label: "Deals" }], "/deals");
    expect(ld.itemListElement.map((e) => e.item)).toEqual([`${SITE}/`, `${SITE}/deals`]);
  });

  test("filterLabels: brand labels from facets, department label from its breadcrumb", () => {
    const loaded = loadListing(deps, { category: "electronics", brand: ["voltline"] }, { base: "/search" }, NOW);
    const labels = filterLabels(deps, loaded.params, loaded.result.facets);
    expect(labels.brand?.voltline).toBe("Voltline");
    expect(labels.category?.electronics).toBe("Electronics");
  });
});

describe("loadCollectionPage", () => {
  test("/products: all products, featured, page 1 of N, JSON-LD, rel next; now once; no writes", () => {
    const before = totalChanges();
    const spy = spyOn(deps.listing, "list");
    const view = loadCollectionPage("products", {}, deps);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(nowCalls).toBe(1);
    expect(totalChanges()).toBe(before);
    expect(view.result.total).toBe(publishedCount());
    expect(view.result.items).toHaveLength(24);
    expect(view.sort).toBe("featured");
    expect(view.facets).toBe(callResult(spy).facets);
    expect(view.rel).toEqual({ next: `${SITE}/products?page=2` });
    const [itemList, crumbs] = view.jsonLd;
    expect(itemList?.["@type"]).toBe("ItemList");
    expect(crumbs?.["@type"]).toBe("BreadcrumbList");
    expect(view.ranked).toBe(false);
    expect(view.noDealsLinks).toBeNull();
  });

  test("/deals: only discounted products; facet param `deals` is redundant", () => {
    const view = loadCollectionPage("deals", { deals: "1" }, deps);
    expect(view.params.deals).toBeUndefined();
    expect(view.result.total).toBeGreaterThan(0);
    for (const p of view.result.items) expect(p.listPriceCents ?? 0).toBeGreaterThan(p.priceCents);
    expect(view.noDealsLinks).toBeNull();
  });

  test("/deals with no discounts: 'No deals right now' links", () => {
    db.query("UPDATE products SET list_price_cents = price_cents").run();
    const view = loadCollectionPage("deals", {}, deps);
    expect(view.result.total).toBe(0);
    expect(view.noDealsLinks).toEqual([...NO_DEALS_LINKS]);
    expect(view.noDealsLinks?.every((l) => isAllowedInternalHref(l.href))).toBe(true);
    expect(view.jsonLd.map((j) => j["@type"])).toEqual(["BreadcrumbList"]);
  });

  test("/best-sellers: best_selling by default, ranked; re-sorted -> not ranked", () => {
    const ids = db.query<{ id: string }, []>("SELECT id FROM products ORDER BY id LIMIT 3").all().map((r) => r.id);
    paidOrder([ids[2] ?? ""], 5);
    paidOrder([ids[1] ?? ""], 2);
    const view = loadCollectionPage("best-sellers", { sort: "best_selling" }, deps);
    expect(view.sort).toBe("best_selling");
    expect(view.params.sort).toBeUndefined();
    expect(view.ranked).toBe(true);
    expect(view.result.items[0]?.id).toBe(ids[2]);
    expect(view.result.items[1]?.id).toBe(ids[1]);
    const resorted = loadCollectionPage("best-sellers", { sort: "price_asc" }, deps);
    expect(resorted.ranked).toBe(false);
    expect(resorted.sort).toBe("price_asc");
  });

  test("/new-arrivals: newest first", () => {
    const view = loadCollectionPage("new-arrivals", {}, deps);
    expect(view.sort).toBe("newest");
    const dates = view.result.items.map((p) => p.publishedAt ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  const hostile: readonly [string, Record<string, unknown>][] = [
    ["garbage keys", { foo: "bar", "__proto__": "x", page: "abc", sort: "DROP TABLE", rating: "9" }],
    ["array values", { page: ["2", "3"], brand: ["voltline", "<script>"], min: ["5"] }],
    ["huge values", { q: "x".repeat(10_000), page: "9".repeat(50), max: "1e9" }],
    ["unicode", { brand: "v\u0000oltline", category: "électronique", view: "‮grid" }],
    ["unknown category", { category: "does-not-exist" }],
    ["non-object", { 0: null }],
  ];
  test.each(hostile)("garbage is ignored (%s): 200-shaped view, every href allowed", (_name, sp) => {
    const view = loadCollectionPage("products", sp, deps);
    expect(view.result.total).toBeGreaterThan(0);
    for (const c of view.breadcrumb) if (c.href !== undefined) expect(isAllowedInternalHref(c.href)).toBe(true);
    for (const rel of [view.rel.prev, view.rel.next]) if (rel !== undefined) expect(rel.startsWith(`${SITE}/products`)).toBe(true);
  });

  test("page beyond the last: empty items, total kept, prev points at the last page", () => {
    const view = loadCollectionPage("products", { page: "99" }, deps);
    expect(view.result.items).toHaveLength(0);
    expect(view.result.total).toBe(publishedCount());
    expect(view.rel).toEqual({ prev: `${SITE}/products?page=${Math.ceil(publishedCount() / 24)}` });
  });
});

describe("collectionMetadata", () => {
  test("indexable canonical; faceted noindex,follow; garbage ignored", () => {
    expect(collectionMetadata("deals", {}).alternates?.canonical).toBe(`${SITE}/deals`);
    expect(collectionMetadata("deals", {}).robots).toBeUndefined();
    expect(collectionMetadata("deals", { deals: "1" }).robots).toBeUndefined();
    expect(collectionMetadata("products", { foo: "1", page: "2" }).alternates?.canonical).toBe(`${SITE}/products?page=2`);
    const faceted = collectionMetadata("new-arrivals", { rating: "4", page: "2" });
    expect(faceted.alternates?.canonical).toBe(`${SITE}/new-arrivals`);
    expect(faceted.robots).toEqual({ index: false, follow: true });
    expect(collectionMetadata("best-sellers", { sort: "best_selling" }).robots).toBeUndefined();
  });
});

describe("collection route table (CONS-B1)", () => {
  test("each collection declares its default sort; /top-rated sorts by rating", () => {
    expect(COLLECTIONS.products.defaultSort).toBeUndefined();
    expect(COLLECTIONS.deals.defaultSort).toBeUndefined();
    expect(COLLECTIONS["best-sellers"].defaultSort).toBe("best_selling");
    expect(COLLECTIONS["new-arrivals"].defaultSort).toBe("newest");
    expect(COLLECTIONS["top-rated"]).toMatchObject({ base: "/top-rated", title: "Top Rated", defaultSort: "rating" });
  });

  test("every collection description is 70-160 characters (T112 audit)", () => {
    for (const config of Object.values(COLLECTIONS)) {
      expect({ base: config.base, ok: config.description.length >= 70 && config.description.length <= 160 }).toEqual({
        base: config.base,
        ok: true,
      });
    }
  });

  test("loadCollectionPage exposes the route default sort and keeps sort=featured on rel links", () => {
    const view = loadCollectionPage("new-arrivals", { sort: "featured" }, deps);
    expect(view.defaultSort).toBe("newest");
    expect(view.params.sort).toBe("featured");
    const top = loadCollectionPage("top-rated", { q: "desk" }, deps);
    expect(top.params.q).toBeUndefined();
    expect(top.sort).toBe("rating");
    expect(top.defaultSort).toBe("rating");
  });
});

describe("composeMetaDescription", () => {
  test("appends context sentences while they fit; result within bounds", () => {
    const out = composeMetaDescription("Novels and short stories.", ["Shop Fiction in Books.", "Compare prices and reviews."]);
    expect(out).toBe("Novels and short stories. Shop Fiction in Books. Compare prices and reviews.");
    expect(out.length).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN);
  });

  test("skips a context that would overflow once the minimum is met", () => {
    const lead = "x".repeat(100);
    expect(composeMetaDescription(lead, ["y".repeat(70), "Short one."])).toBe(`${lead} Short one.`);
  });

  test("clips an over-long lead at a word boundary with an ellipsis", () => {
    const out = composeMetaDescription("word ".repeat(60), ["tail."]);
    expect(out.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  test("empty lead uses the contexts; whitespace collapsed", () => {
    expect(composeMetaDescription("  ", ["  Shop   here. "])).toBe("Shop here.");
  });
});

// ---------------------------------------------------------------------------
// v3 listing extras (T167)
// ---------------------------------------------------------------------------

describe("listingPromoSlots (T167, CONTRACTS L-13..L-16)", () => {
  const promoHrefs = (slots: ReturnType<typeof listingPromoSlots>) => slots.map((s) => s.tile.cta?.href);

  test("page 1, >= 8 results, no facet: 3 span-2 h3 tiles after products 2, 8 and 14 (li 3, 10, 17)", () => {
    const slots = listingPromoSlots({ base: "/products", params: {}, total: 60 });
    expect(slots.map((s) => s.afterIndex)).toEqual([1, 7, 13]);
    expect(slots).toHaveLength(LISTING_PROMO_MAX);
    expect(LISTING_PROMO_MAX).toBe(MAX_PROMO_SLOTS);
    for (const s of slots) {
      expect(s.tile.span).toBe(2);
      expect(s.tile.headingLevel).toBe(3);
      expect(isAllowedInternalHref(s.tile.cta?.href ?? "")).toBe(true);
    }
    expect(promoHrefs(slots)).toEqual(["/shipping", "/deals", "/best-sellers"]);
    // li positions (1-based) of the tiles once interleaved: products before + tiles before + 1.
    expect(slots.map((s, k) => s.afterIndex + 1 + k + 1)).toEqual([3, 10, 17]);
  });

  test("even cell count before every span-2 tile at 4 columns (no hole, no straddle)", () => {
    const cells = promoCellsBefore(LISTING_PROMO_AFTER_INDEXES, LISTING_PROMO_SPAN);
    expect(cells).toEqual([2, 10, 18]);
    for (const c of cells) {
      expect(c % 2).toBe(0);
      // A span-2 tile starting at an even cell never crosses a 4-column row end.
      expect((c % LISTING_PROMO_COLUMNS) + LISTING_PROMO_SPAN).toBeLessThanOrEqual(LISTING_PROMO_COLUMNS);
    }
  });

  test("threshold: 7 results -> none; exactly 8 -> slots (the grid then drops tiles past the last product)", () => {
    expect(listingPromoSlots({ base: "/products", params: {}, total: LISTING_PROMO_MIN_RESULTS - 1 })).toEqual([]);
    const eight = listingPromoSlots({ base: "/products", params: {}, total: 8 });
    expect(eight.length).toBeGreaterThan(0);
    // 8 items on a non-full page: ProductGrid keeps only the tile after product 2 (the one after 8 would be last).
    expect(selectPromoSlots(8, eight, { page: 1, pageSize: 24 }).map((s) => s.afterIndex)).toEqual([1]);
    expect(listingPromoSlots({ base: "/products", params: {}, total: 0 })).toEqual([]);
    expect(listingPromoSlots({ base: "/products", params: {}, total: Number.NaN })).toEqual([]);
  });

  test("page 2+ -> none", () => {
    expect(listingPromoSlots({ base: "/products", params: { page: 2 }, total: 60 })).toEqual([]);
    expect(listingPromoSlots({ base: "/products", params: { page: 1 }, total: 60 })).toHaveLength(3);
  });

  test("any facet or dept -> none; sort, view and extras alone keep them", () => {
    const faceted: Record<string, unknown>[] = [
      { brand: ["voltline"] }, { category: "audio" }, { min: 5 }, { max: 50 }, { rating: 4 }, { instock: true }, { deals: true }, { dept: "electronics" },
    ];
    for (const params of faceted) {
      expect({ params, n: listingPromoSlots({ base: "/products", params, total: 60 }).length }).toEqual({ params, n: 0 });
    }
    expect(listingPromoSlots({ base: "/products", params: { sort: "price_asc", view: "list", extra: { utm_source: "x" } }, total: 60 })).toHaveLength(3);
  });

  test("a tile pointing at the current route is skipped (the spare tile fills in)", () => {
    expect(promoHrefs(listingPromoSlots({ base: "/deals", params: {}, total: 60 }))).toEqual(["/shipping", "/best-sellers", "/signup"]);
    expect(promoHrefs(listingPromoSlots({ base: "/best-sellers", params: {}, total: 60 }))).toEqual(["/shipping", "/deals", "/signup"]);
    expect(promoHrefs(listingPromoSlots({ base: "/category/audio", params: {}, total: 60 }))).toEqual(["/shipping", "/deals", "/best-sellers"]);
  });

  test("blank headings and off-allow-list CTAs are dropped; fewer tiles keep the first positions", () => {
    const first = LISTING_PROMOS[0] as ListingPromoCopy;
    const promos: ListingPromoCopy[] = [
      { ...first, id: "blank", heading: "  " },
      { ...first, id: "evil", cta: { label: "x", href: "javascript:alert(1)" } },
      { ...first, id: "ext", cta: { label: "x", href: "https://evil.example" } },
      { ...first, id: "ok" },
    ];
    const slots = listingPromoSlots({ base: "/products", params: {}, total: 60, promos });
    expect(slots).toHaveLength(1);
    expect(slots[0]?.afterIndex).toBe(1);
    expect(listingPromoSlots({ base: "/products", params: {}, total: 60, promos: [] })).toEqual([]);
  });

  test("images are decorative placeholder art", () => {
    for (const s of listingPromoSlots({ base: "/products", params: {}, total: 60 })) {
      if (s.tile.image) {
        expect(s.tile.image.decorative).toBe(true);
        expect(s.tile.image.path.startsWith("/images/")).toBe(true);
      }
    }
  });
});

describe("listingFeedback (T167, CONTRACTS L-19)", () => {
  test("3 allow-listed suggestions, never the current route, never the feedback link itself", () => {
    for (const base of ["/products", "/deals", "/best-sellers", "/new-arrivals", "/top-rated", "/category/audio", "/brand/voltline"]) {
      const { suggestions } = listingFeedback(base);
      expect(suggestions).toHaveLength(3);
      for (const s of suggestions ?? []) {
        expect(isAllowedInternalHref(s.href)).toBe(true);
        expect(s.href).not.toBe(base);
        expect(s.href).not.toBe(FEEDBACK_HREF);
      }
    }
    expect(listingFeedback("/products").suggestions?.map((s) => s.href)).toEqual(["/deals", "/help", "/best-sellers"]);
    expect(listingFeedback("/deals").suggestions?.map((s) => s.href)).toEqual(["/products", "/help", "/best-sellers"]);
  });

  test("hostile suggestions are dropped", () => {
    const out = listingFeedback("/products", [
      { label: "x", href: "javascript:alert(1)" },
      { label: " ", href: "/help" },
      { label: "Help", href: "/help" },
    ]);
    expect(out.suggestions).toEqual([{ label: "Help", href: "/help" }]);
  });
});

describe("related chips (T167, CONTRACTS L-4)", () => {
  test("categoryChips: /category links, allow-listed, at most 12", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ slug: `c-${i}`, name: `Cat ${i}` }));
    const chips = categoryChips(many);
    expect(chips).toHaveLength(RELATED_CHIPS_MAX);
    expect(chips[0]).toEqual({ label: "Cat 0", href: "/category/c-0" });
    expect(categoryChips([{ slug: "a b?x", name: "Bad" }, { slug: "ok", name: " " }])).toEqual([]);
    expect(categoryChips([])).toEqual([]);
  });

  test("brandChips: others with products, most products first, at most 12", () => {
    const brand = (slug: string, name: string, productCount: number) => ({ id: slug, slug, name, description: "", productCount });
    const chips = brandChips([brand("a", "Acme", 3), brand("b", "Bolt", 9), brand("c", "Cell", 0), brand("d", "Dyna", 3), brand("me", "Me", 50)], "me");
    expect(chips).toEqual([
      { label: "Bolt", href: "/brand/b" },
      { label: "Acme", href: "/brand/a" },
      { label: "Dyna", href: "/brand/d" },
    ]);
    const many = Array.from({ length: 30 }, (_, i) => brand(`b-${i}`, `Brand ${i}`, 1));
    expect(brandChips(many, "x")).toHaveLength(RELATED_CHIPS_MAX);
  });
});

describe("listingCardProps (one clock per page)", () => {
  test("every card gets the same Date; the inner function's keys are merged", () => {
    const now = new Date(NOW);
    const plain = listingCardProps(now);
    expect(plain({}, 0)).toEqual({ now });
    expect(plain({}, 5).now).toBe(now);
    const ranked = listingCardProps(now, (_p: unknown, i: number) => ({ rank: i + 25 }));
    expect(ranked({}, 0)).toEqual({ now, rank: 25 });
  });
});

describe("loadCollectionPage v3 fields (T167)", () => {
  test("now from the injected clock (read once), promo slots on page 1, feedback suggestions", () => {
    const view = loadCollectionPage("products", {}, deps);
    expect(nowCalls).toBe(1);
    expect(view.now.getTime()).toBe(NOW);
    expect(view.promoSlots.map((s) => s.afterIndex)).toEqual([1, 7, 13]);
    expect(view.feedback.suggestions?.map((s) => s.href)).toEqual(["/deals", "/help", "/best-sellers"]);
    // (bx) listing summaries carry publishedAt for the "New" badge.
    for (const item of view.result.items) expect(typeof item.publishedAt).toBe("string");
  });

  test("page 2, a facet, or fewer than 8 results: no promo slots", () => {
    expect(loadCollectionPage("products", { page: "2" }, deps).promoSlots).toEqual([]);
    expect(loadCollectionPage("products", { instock: "1" }, deps).promoSlots).toEqual([]);
    db.query("UPDATE products SET list_price_cents = NULL").run();
    const ids = db.query<{ id: string }, []>("SELECT id FROM products ORDER BY id LIMIT 7").all().map((r) => r.id);
    const mark = db.query("UPDATE products SET list_price_cents = price_cents + 100 WHERE id = ?");
    for (const id of ids) mark.run(id);
    const deals = loadCollectionPage("deals", {}, deps);
    expect(deals.result.total).toBeLessThan(LISTING_PROMO_MIN_RESULTS);
    expect(deals.promoSlots).toEqual([]);
  });

  test("/deals swaps its own sale tile for the stand-in", () => {
    const view = loadCollectionPage("deals", {}, deps);
    expect(view.result.total).toBeGreaterThanOrEqual(LISTING_PROMO_MIN_RESULTS);
    expect(view.promoSlots).toHaveLength(3);
    expect(view.promoSlots.map((s) => s.tile.cta?.href)).not.toContain("/deals");
    expect(view.feedback.suggestions?.map((s) => s.href)).not.toContain("/deals");
  });
});
