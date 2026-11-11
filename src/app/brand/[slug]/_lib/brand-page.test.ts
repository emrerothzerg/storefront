import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createListingPageDeps, type ListingPageDeps } from "@/app/_listing/listing-page";
import { isAllowedInternalHref } from "@/content/routes";
import type { ListingService } from "@/server/catalog/listing-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";

import { brandDescription, brandMetadata, EMPTY_BRAND_LINKS, loadBrandPage, type BrandPageView } from "./brand-page";

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

beforeEach(() => {
  env.NEXT_PUBLIC_SITE_URL = SITE;
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  deps = createListingPageDeps(db);
});

afterEach(() => {
  db.close();
  if (originalSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

function load(slug: string, sp: Record<string, unknown> = {}): BrandPageView {
  const r = loadBrandPage(slug, sp, deps);
  if (!r.found) throw new Error(`expected ${slug}`);
  return r.view;
}

describe("loadBrandPage", () => {
  test.each([["nope"], ["Voltline"], ["../x"], [""]])("unknown/invalid slug %p -> not found", (slug) => {
    expect(loadBrandPage(slug, {}, deps).found).toBe(false);
  });

  test("brand scope: only its products, h1 = name, brand facet hidden, one list() call", () => {
    const list = spyOn(deps.listing, "list");
    const view = load("voltline", { brand: ["kestrel-audio"] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ brandSlugs: ["voltline"] });
    expect(view.title).toBe("Voltline");
    expect(view.params.brand).toBeUndefined();
    expect(view.result.total).toBeGreaterThan(0);
    expect(view.result.items.every((p) => p.brandSlug === "voltline")).toBe(true);
    const facets = callResult(list).facets;
    expect(view.facets.brands).toEqual([]);
    expect(view.facets.categories).toBe(facets.categories);
    expect(view.breadcrumb).toEqual([{ label: "Home", href: "/" }, { label: "Brands", href: "/brands" }, { label: "Voltline" }]);
  });

  test("JSON-LD ItemList + BreadcrumbList (Home > Brands > Brand)", () => {
    const view = load("voltline");
    expect(view.jsonLd.map((j) => j["@type"])).toEqual(["ItemList", "BreadcrumbList"]);
    const crumbs = view.jsonLd[1];
    expect(crumbs && "itemListElement" in crumbs ? crumbs.itemListElement.map((e) => ("item" in e ? e.item : "")) : []).toEqual([
      `${SITE}/`,
      `${SITE}/brands`,
      `${SITE}/brand/voltline`,
    ]);
  });

  test("v3 (T167): other-brand chips, one now, promo slots by result count, feedback", () => {
    let calls = 0;
    const NOW = Date.now();
    const counted = createListingPageDeps(db, () => {
      calls += 1;
      return NOW;
    });
    const r = loadBrandPage("voltline", {}, counted);
    if (!r.found) throw new Error("expected voltline");
    const view = r.view;
    expect(calls).toBe(1);
    expect(view.now.getTime()).toBe(NOW);
    const hrefs = view.relatedSearches.map((c) => ("href" in c ? (c.href ?? "") : ""));
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.length).toBeLessThanOrEqual(12);
    expect(hrefs).not.toContain("/brand/voltline");
    for (const href of hrefs) expect(href.startsWith("/brand/") && isAllowedInternalHref(href)).toBe(true);
    expect(view.promoSlots.length).toBe(view.result.total >= 8 ? 3 : 0);
    expect(load("voltline", { page: "2" }).promoSlots).toEqual([]);
    expect(load("voltline", { rating: "1" }).promoSlots).toEqual([]);
    expect(view.feedback.suggestions).toHaveLength(3);
  });

  test("empty brand: links to /brands and /products", () => {
    db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE brand_id = (SELECT id FROM brands WHERE slug = 'voltline')").run();
    const view = load("voltline");
    expect(view.result.total).toBe(0);
    expect(view.emptyLinks).toEqual([...EMPTY_BRAND_LINKS]);
  });
});

describe("brandMetadata", () => {
  test("indexable canonical, faceted noindex, unknown noindex", () => {
    expect(brandMetadata("voltline", {}, deps).alternates?.canonical).toBe(`${SITE}/brand/voltline`);
    expect(brandMetadata("voltline", { brand: "voltline" }, deps).robots).toBeUndefined();
    const page2 = brandMetadata("voltline", { page: "2" }, deps);
    expect(page2.alternates?.canonical).toBe(`${SITE}/brand/voltline?page=2`);
    const faceted = brandMetadata("voltline", { instock: "1" }, deps);
    expect(faceted.robots).toEqual({ index: false, follow: true });
    expect(faceted.alternates?.canonical).toBe(`${SITE}/brand/voltline`);
    expect(brandMetadata("nope", {}, deps).robots).toEqual({ index: false, follow: false });
  });
});

describe("brand meta description (T112 audit, CONS-B1)", () => {
  test("every seeded brand: 70-160 chars, starts with its own copy and names the brand", () => {
    const brands = db.query<{ slug: string; name: string; description: string }, []>("SELECT slug, name, description FROM brands ORDER BY slug").all();
    expect(brands.length).toBeGreaterThan(0);
    for (const b of brands) {
      const description = String(brandMetadata(b.slug, {}, deps).description ?? "");
      expect({ slug: b.slug, length: description.length >= 70 && description.length <= 160 }).toEqual({ slug: b.slug, length: true });
      expect(description).toBe(brandDescription(b));
      if (b.description.trim() !== "") expect(description.startsWith(b.description.trim())).toBe(true);
      expect(description).toContain(b.name);
    }
  });

  test("empty or over-long copy still yields 70-160 chars", () => {
    for (const description of ["", "x ".repeat(200)]) {
      const out = brandDescription({ name: "Acme", description });
      expect(out.length).toBeGreaterThanOrEqual(70);
      expect(out.length).toBeLessThanOrEqual(160);
    }
  });
});
