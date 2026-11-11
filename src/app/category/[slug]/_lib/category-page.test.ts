import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createListingPageDeps, type ListingPageDeps } from "@/app/_listing/listing-page";
import { isAllowedInternalHref } from "@/content/routes";
import type { ListingService } from "@/server/catalog/listing-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SEED_CATALOG_STATS, seedDatabase } from "@/server/db/seed";

import {
  categoryDescription,
  categoryMetadata,
  loadCategoryPage,
  scopeCategoryParams,
  type CategoryPageView,
} from "./category-page";

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
/** Published seed products in the Electronics department and its Audio category. */
const ELECTRONICS = SEED_CATALOG_STATS.byDepartment.electronics ?? -1;
const AUDIO = SEED_CATALOG_STATS.byCategory.audio ?? -1;
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

function load(slug: string, sp: Record<string, unknown> = {}): CategoryPageView {
  const r = loadCategoryPage(slug, sp, deps);
  if (!r.found) throw new Error(`expected ${slug} to exist`);
  return r.view;
}

describe("loadCategoryPage", () => {
  test.each([["nope"], ["Electronics"], ["../etc"], [""], ["a".repeat(65)], ["%2e%2e"]])("unknown/invalid slug %p -> not found", (slug) => {
    expect(loadCategoryPage(slug, {}, deps).found).toBe(false);
  });

  test("department: children's products, tiles, category facet, Home > Dept, one list() call", () => {
    const list = spyOn(deps.listing, "list");
    const view = load("electronics");
    expect(list).toHaveBeenCalledTimes(1);
    expect(nowCalls).toBe(1);
    expect(view.isDepartment).toBe(true);
    expect(view.title).toBe("Electronics");
    expect(view.result.total).toBe(ELECTRONICS);
    expect(view.facets).toBe(callResult(list).facets);
    expect(view.subcategories.map((c) => c.slug).sort()).toEqual(["audio", "computer-accessories", "smart-home"]);
    expect(view.showCategoryFacet).toBe(true);
    expect(view.breadcrumb).toEqual([{ label: "Home", href: "/" }, { label: "Electronics" }]);
    expect(view.emptySiblings).toBeNull();
    expect(view.description.length).toBeGreaterThan(0);
  });

  test("child: Home > Dept > Child, no tiles, no category facet", () => {
    const view = load("audio");
    expect(view.isDepartment).toBe(false);
    expect(view.breadcrumb).toEqual([
      { label: "Home", href: "/" },
      { label: "Electronics", href: "/category/electronics" },
      { label: "Headphones & Audio" },
    ]);
    expect(view.subcategories).toEqual([]);
    expect(view.showCategoryFacet).toBe(false);
    expect(view.result.items.every((p) => p.categorySlug === "audio")).toBe(true);
  });

  test("JSON-LD: ItemList <= 24 absolute + 2-level BreadcrumbList", () => {
    const view = load("audio");
    const itemList = view.jsonLd.find((j) => j["@type"] === "ItemList");
    const crumbs = view.jsonLd.find((j) => j["@type"] === "BreadcrumbList");
    expect(itemList && "numberOfItems" in itemList ? itemList.numberOfItems : -1).toBe(Math.min(24, AUDIO));
    if (itemList === undefined || !("numberOfItems" in itemList)) throw new Error("ItemList missing");
    expect(itemList.itemListElement.length).toBeLessThanOrEqual(24);
    for (const e of itemList.itemListElement) expect(e.url?.startsWith(`${SITE}/products/`)).toBe(true);
    expect(crumbs?.itemListElement.map((e) => ("item" in e ? e.item : ""))).toEqual([
      `${SITE}/`,
      `${SITE}/category/electronics`,
      `${SITE}/category/audio`,
    ]);
  });

  test("category param only scopes within the department; dept param dropped", () => {
    const view = load("electronics", { category: "audio", dept: "books" });
    expect(view.params).toEqual({ category: "audio" });
    expect(view.result.total).toBe(AUDIO);
    const foreign = load("electronics", { category: "fiction" });
    expect(foreign.params.category).toBeUndefined();
    expect(foreign.result.total).toBe(ELECTRONICS);
    const child = load("audio", { category: "smart-home" });
    expect(child.params.category).toBeUndefined();
    expect(child.result.items.every((p) => p.categorySlug === "audio")).toBe(true);
    expect(scopeCategoryParams({ category: "x", page: 2 }, [{ slug: "x" }])).toEqual({ category: "x", page: 2 });
  });

  test("empty category: 200-shaped view with sibling links", () => {
    db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE category_id = (SELECT id FROM categories WHERE slug = 'cycling')").run();
    const view = load("cycling");
    expect(view.result.total).toBe(0);
    expect(view.emptySiblings?.map((l) => l.href)).toEqual(["/category/fitness", "/category/camping-hydration"]);
    expect(view.jsonLd.map((j) => j["@type"])).toEqual(["BreadcrumbList"]);
    const filtered = load("cycling", { instock: "1" });
    expect(filtered.emptySiblings).toBeNull();
  });

  test("v3 (T167): sibling chips, one now, promo slots on page 1, feedback", () => {
    const dept = load("electronics");
    expect(nowCalls).toBe(1);
    expect(dept.now.getTime()).toBe(NOW);
    const departments = deps.listing.categoryTree(NOW).filter((d) => d.slug !== "electronics");
    expect(dept.relatedSearches.map((c) => ("href" in c ? c.href : ""))).toEqual(
      departments.map((d) => `/category/${d.slug}`).slice(0, 12),
    );
    expect(dept.relatedSearches.map((c) => ("href" in c ? c.href : ""))).not.toContain("/category/electronics");
    for (const chip of dept.relatedSearches) expect(isAllowedInternalHref("href" in chip ? (chip.href ?? "") : "")).toBe(true);
    expect(dept.result.total).toBeGreaterThanOrEqual(8);
    expect(dept.promoSlots.map((s) => s.afterIndex)).toEqual([1, 7, 13]);
    expect(dept.feedback.suggestions).toHaveLength(3);
    for (const item of dept.result.items) expect(typeof item.publishedAt).toBe("string");

    const child = load("audio");
    expect(child.relatedSearches.map((c) => ("href" in c ? c.href : "")).sort()).toEqual(["/category/computer-accessories", "/category/smart-home"]);

    expect(load("electronics", { page: "2" }).promoSlots).toEqual([]);
    expect(load("electronics", { category: "audio" }).promoSlots).toEqual([]);
    expect(load("electronics", { instock: "1" }).promoSlots).toEqual([]);
    expect(load("electronics", { sort: "price_asc" }).promoSlots).toHaveLength(3);
  });

  test("v3 (T167): empty category shows no chips (the empty state lists the siblings) and no promos", () => {
    db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE category_id = (SELECT id FROM categories WHERE slug = 'cycling')").run();
    const view = load("cycling");
    expect(view.relatedSearches).toEqual([]);
    expect(view.promoSlots).toEqual([]);
  });

  test("top sellers rail: omitted without sales, filled with category best sellers", () => {
    expect(load("audio").topSellers).toEqual([]);
    const audio = db.query<{ id: string }, []>(
      "SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id WHERE c.slug = 'audio' ORDER BY p.id LIMIT 1",
    ).get();
    db.query(
      `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
         region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
       VALUES ('o1', '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'paid', 1, 1, 'USD', 'T', 't@e.com', '1', 'C', 'R', '0', 'US', '4242', 'k1', ?, 'processing')`,
    ).run(new Date(NOW - 3_600_000).toISOString());
    db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES ('o1', ?, 'x', 1, 1)").run(audio?.id ?? "");
    expect(load("electronics").topSellers.map((p) => p.id)).toEqual([audio?.id ?? ""]);
    expect(load("fiction").topSellers).toEqual([]);
  });

  test("pagination rel + every link allowed", () => {
    const view = load("electronics", { page: "1" });
    expect(view.rel).toEqual({});
    for (const c of view.breadcrumb) if (c.href !== undefined) expect(isAllowedInternalHref(c.href)).toBe(true);
  });
});

describe("loadCategoryPage clock (consistency ba)", () => {
  test("categoryTree gets the request now; no hidden wall-clock read during the render", () => {
    const tree = spyOn(deps.listing, "categoryTree");
    const wall = spyOn(Date, "now");
    try {
      load("electronics");
      load("audio");
      expect(tree.mock.calls).toEqual([[NOW], [NOW]]);
      expect(wall).not.toHaveBeenCalled();
    } finally {
      wall.mockRestore();
      tree.mockRestore();
    }
  });
});

describe("categoryMetadata", () => {
  test("matrix: plain, page 3, faceted, unknown", () => {
    const plain = categoryMetadata("electronics", {}, deps);
    expect(plain.alternates?.canonical).toBe(`${SITE}/category/electronics`);
    expect(plain.robots).toBeUndefined();
    const page3 = categoryMetadata("electronics", { page: "3" }, deps);
    expect(page3.alternates?.canonical).toBe(`${SITE}/category/electronics?page=3`);
    expect(page3.robots).toBeUndefined();
    const faceted = categoryMetadata("electronics", { category: "audio", page: "2" }, deps);
    expect(faceted.alternates?.canonical).toBe(`${SITE}/category/electronics`);
    expect(faceted.robots).toEqual({ index: false, follow: true });
    const foreign = categoryMetadata("electronics", { category: "fiction", dept: "books" }, deps);
    expect(foreign.robots).toBeUndefined();
    const unknown = categoryMetadata("nope", {}, deps);
    expect(unknown.robots).toEqual({ index: false, follow: false });
    expect(unknown.alternates).toBeUndefined();
  });
});

describe("category meta description (T112 audit, CONS-B1)", () => {
  test("every seeded category: 70-160 chars, starts with its own copy, names the department for children", () => {
    const slugs = db.query<{ slug: string }, []>("SELECT slug FROM categories ORDER BY slug").all().map((r) => r.slug);
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) {
      const path = deps.listing.breadcrumb(slug);
      const category = path[path.length - 1];
      const description = String(categoryMetadata(slug, {}, deps).description ?? "");
      expect({ slug, length: description.length >= 70 && description.length <= 160 }).toEqual({ slug, length: true });
      expect(description).toBe(categoryDescription(path));
      if (category !== undefined && category.description.trim() !== "") {
        expect(description.startsWith(category.description.trim())).toBe(true);
      }
      if (path.length > 1) expect(description).toContain(`in ${path[0]?.name}`);
    }
  });

  test("categoryMetadata reads the injected clock once and passes it to categoryTree (CONS-B1 bg)", () => {
    let calls = 0;
    const now = Date.now();
    const clocked = createListingPageDeps(db, () => {
      calls += 1;
      return now;
    });
    const tree = spyOn(clocked.listing, "categoryTree");
    categoryMetadata("electronics", {}, clocked);
    expect(calls).toBe(1);
    expect(tree).toHaveBeenCalledWith(now);
  });
});
