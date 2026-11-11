/**
 * T172 (QA wave C1): page-level QA of the v3 listing routes (T158 template, T167 data):
 * /products, /deals, /best-sellers, /new-arrivals, /top-rated, /category/[slug], /brand/[slug], /brands,
 * against `tests/redesign/CONTRACTS.md` L-1..L-28 (as amended by T172). QA-owned.
 * Page functions called directly with the wave-5 next/* mocks; `:memory:` SQLite seeded through the
 * real seed; counts derive from `SEED_CATALOG_STATS`. Phase 2 canonical/rel/404/clamp coverage lives in
 * `tests/app/phase2-wave5/pages-listing.qa.test.tsx`; this file re-checks it only where v3 touched it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { installNextMocks, NotFoundSentinel, outcomeOf, parseHtml, hrefViolations, duplicateIds, serverLike } from "../phase2-wave5/_harness";
import { brandAndThemeViolations, countClockReads, darkClassTokens } from "./_phase3";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const previousDatabasePath = env.DATABASE_PATH;
const previousSiteUrl = env.NEXT_PUBLIC_SITE_URL;
env.DATABASE_PATH = ":memory:";
const SITE = "https://shop.example.com";
env.NEXT_PUBLIC_SITE_URL = SITE;

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { SEED_CATALOG_STATS, seedDatabase } = await import("@/server/db/seed");
const { isAllowedInternalHref } = await import("@/content/routes");
const { getListingService } = await import("@/server/catalog/listing-service");
const { ratingAverage } = await import("@/server/catalog/product-repository");
const { LISTING_PAGE_SIZE } = await import("@/app/_listing/listing-page");
const { addToCart } = await import("@/app/actions/cart");
const products = await import("@/app/products/page");
const deals = await import("@/app/deals/page");
const best = await import("@/app/best-sellers/page");
const newArrivals = await import("@/app/new-arrivals/page");
const topRated = await import("@/app/top-rated/page");
const category = await import("@/app/category/[slug]/page");
const brand = await import("@/app/brand/[slug]/page");
const brands = await import("@/app/brands/page");

type SP = Record<string, string | string[] | undefined>;

interface Route {
  readonly path: string;
  readonly page: (sp: SP) => Promise<ReactNode>;
  readonly meta: (sp: SP) => Promise<{ alternates?: { canonical?: unknown } | null; robots?: unknown }>;
}

function collection(path: string, mod: { default: (p: { searchParams?: Promise<SP> }) => Promise<ReactNode>; generateMetadata: (p: { searchParams?: Promise<SP> }) => Promise<object> }): Route {
  return {
    path,
    page: (sp) => mod.default({ searchParams: Promise.resolve(sp) }),
    meta: (sp) => mod.generateMetadata({ searchParams: Promise.resolve(sp) }) as never,
  };
}

function slugRoute(prefix: "category" | "brand", slug: string): Route {
  const mod = prefix === "category" ? category : brand;
  return {
    path: `/${prefix}/${slug}`,
    page: (sp) => mod.default({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) }),
    meta: (sp) => mod.generateMetadata({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) }) as never,
  };
}

const PRODUCTS = collection("/products", products as never);
const DEALS = collection("/deals", deals as never);
const BEST = collection("/best-sellers", best as never);
const NEW = collection("/new-arrivals", newArrivals as never);
const TOP = collection("/top-rated", topRated as never);
const COLLECTIONS = [PRODUCTS, DEALS, BEST, NEW, TOP];
const DEPT = slugRoute("category", "electronics");
const SUBCAT = slugRoute("category", "audio");
/** Largest brand by published products (counts from the seed stats). */
const BIG_BRAND = Object.entries(SEED_CATALOG_STATS.byBrand).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "voltline";
const BRAND = slugRoute("brand", BIG_BRAND);
const ALL_ROUTES = [...COLLECTIONS, DEPT, SUBCAT, BRAND];
/** A subcategory with 1..7 published products (below the promo threshold). */
const SMALL_CATEGORY = Object.entries(SEED_CATALOG_STATS.byCategory).find(([slug, n]) => slug !== "" && n > 0 && n < 8)?.[0] ?? "";

const FEEDBACK_HEADING = "Did you find what you were looking for?";
/** `parse-params.ts` vocabulary that may appear as filter form field names (L-6). */
const PARAM_VOCABULARY = new Set(["q", "category", "brand", "rating", "min", "max", "instock", "deals", "sort", "view", "dept"]);
const BADGE_TEXTS = new Set(["Sale", "New", "Top pick"]);
const HOSTILE = `<img src=x onerror=alert(1)><script>alert(1)</script>"'&amp;`;
const DAY = 86_400_000;

let restoreServerLike: () => void = () => {};
const restorers: Array<() => void> = [];

beforeAll(() => {
  closeDatabase();
  seedDatabase(getDatabase());
});

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

afterAll(() => {
  restoreServerLike();
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
  if (previousSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
});

restoreServerLike = serverLike([addToCart as never]);

async function render(route: Route, sp: SP = {}): Promise<{ html: string; doc: Document }> {
  env.NEXT_PUBLIC_SITE_URL = SITE;
  const html = renderToStaticMarkup(<>{await route.page(sp)}</>);
  return { html, doc: parseHtml(html) };
}

/** Runs `fn` inside a savepoint that is always rolled back. */
async function withRollback(fn: () => Promise<void>): Promise<void> {
  const db = getDatabase();
  db.run("SAVEPOINT qa_t172");
  try {
    await fn();
  } finally {
    db.run("ROLLBACK TO qa_t172");
    db.run("RELEASE qa_t172");
  }
}

function grid(doc: Document): Element | null {
  return doc.querySelector('ul[data-layout="grid"]');
}

function gridItems(doc: Document): Element[] {
  return [...(grid(doc)?.children ?? [])];
}

function isPromo(li: Element): boolean {
  return li.hasAttribute("data-promo-span");
}

function promoItems(doc: Document): Element[] {
  return gridItems(doc).filter(isPromo);
}

function relatedNav(doc: Document): { label: string; hrefs: string[] } | null {
  for (const nav of doc.querySelectorAll("nav[aria-labelledby]")) {
    const label = doc.getElementById(nav.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ?? "";
    if (label.startsWith("Related") || label === "More brands") {
      return { label, hrefs: [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "") };
    }
  }
  return null;
}

function feedbackSection(doc: Document): Element | null {
  const h2 = [...doc.querySelectorAll("h2")].find((h) => h.textContent === FEEDBACK_HEADING);
  return h2?.closest("section") ?? null;
}

function pathOf(href: string): string {
  return new URL(href, SITE).pathname;
}

/** Badge texts of a card, the rank (if any) stripped. */
function badgeTexts(card: Element): { rank: string | null; badges: string[] } {
  const strip = card.querySelector('[data-testid="product-card-badges"]');
  const spans = [...(strip?.children ?? [])].map((s) => (s.textContent ?? "").trim());
  const rank = spans[0]?.startsWith("Rank ") === true ? (spans.shift() ?? null) : null;
  return { rank, badges: spans };
}

interface Row {
  slug: string;
  price_cents: number;
  list_price_cents: number | null;
  published_at: string;
  rating_sum: number;
  rating_count: number;
  stock: number;
}

function rowBySlug(): Map<string, Row> {
  const rows = getDatabase()
    .query<Row, []>("SELECT slug, price_cents, list_price_cents, published_at, rating_sum, rating_count, stock FROM products")
    .all();
  return new Map(rows.map((r) => [r.slug, r]));
}

/** Independent re-derivation of the T137 card badge rule (sale > new (30 days) > top pick (4.5 / 5 reviews), max 2). */
function expectedBadges(row: Row, now: number): string[] {
  const out: string[] = [];
  if (row.list_price_cents !== null && row.list_price_cents > row.price_cents) out.push("Sale");
  const published = Date.parse(row.published_at);
  if (Number.isFinite(published) && now - published >= 0 && now - published <= 30 * DAY) out.push("New");
  if (row.rating_count >= 5 && ratingAverage(row.rating_sum, row.rating_count) >= 4.5) out.push("Top pick");
  return out.slice(0, 2);
}

function cardSlug(card: Element): string {
  const href = card.querySelector("a[href^='/products/']")?.getAttribute("href") ?? "";
  return decodeURIComponent(href.slice("/products/".length));
}

// ---------------------------------------------------------------------------
// Toolbar row, headings, no sidebar (L-5, L-6, L-9, L-10)
// ---------------------------------------------------------------------------

describe("listing toolbar row and headings (L-2, L-5, L-6, L-9, L-10)", () => {
  test.each(ALL_ROUTES.map((r) => [r.path, r] as const))("%s: closed Filter details, then sort + view toggle in the same row; one h1", async (_p, route) => {
    const { doc } = await render(route);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelector("h1")?.id).toBe("listing-title");
    const details = doc.querySelector("details[data-filter-panel]");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent?.trim()).toBe("Filter");
    const form = details?.querySelector("form");
    expect(form?.getAttribute("method")).toBe("get");
    const names = new Set([...(form?.querySelectorAll("[name]") ?? [])].map((el) => el.getAttribute("name") ?? ""));
    expect([...names].filter((n) => !PARAM_VOCABULARY.has(n))).toEqual([]);
    expect([...(form?.querySelectorAll('button[type="submit"]') ?? [])].map((b) => b.textContent?.trim())).toEqual(["Apply filters"]);
    const sort = doc.querySelector('select[name="sort"]');
    expect(sort).not.toBeNull();
    expect(doc.querySelector(`label[for="${sort?.id ?? "?"}"]`)?.textContent).toBe("Sort by");
    // Same toolbar row: the details and the sort select share the details' parent; sort comes after Filter.
    expect(details?.parentElement?.contains(sort ?? null)).toBe(true);
    expect(((details?.compareDocumentPosition(sort as Node) ?? 0) & 4) !== 0).toBe(true);
    const view = doc.querySelector('[role="group"][aria-label="View"]');
    expect(details?.parentElement?.contains(view ?? null)).toBe(true);
    // No facet sidebar outside the details panel.
    const asides = [...doc.querySelectorAll('aside, [role="complementary"]')].filter((a) => a.closest("details[data-filter-panel]") === null);
    expect(asides).toHaveLength(0);
  });

  test.each(ALL_ROUTES.map((r) => [r.path, r] as const))("%s: headings outside cards and promo tiles are only the allowed set (L-5)", async (_p, route) => {
    const { doc } = await render(route);
    const outside = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")].filter(
      (h) => h.closest("article") === null && h.closest("[data-promo-span]") === null,
    );
    const allowed = (h: Element): boolean => {
      const t = h.textContent ?? "";
      if (h.tagName === "H1") return true;
      if (h.tagName !== "H2") return false;
      // h2s: sr-only results heading, feedback, and the category page's own rails (subcategories, top sellers, T167).
      return t === "Results" || t === FEEDBACK_HEADING || h.closest("#category-subcategories, #category-top-sellers") !== null;
    };
    expect(outside.filter((h) => !allowed(h)).map((h) => `${h.tagName}:${h.textContent}`)).toEqual([]);
    expect(outside.filter((h) => h.tagName === "H2" && h.textContent === "Results")).toHaveLength(1);
  });

  test("L-7: the Filter badge counts applied facet values (none -> 'Filter', price -> 1, 3 facets -> 3)", async () => {
    const summary = async (sp: SP) => (await render(PRODUCTS, sp)).doc.querySelector("details[data-filter-panel] summary")?.textContent?.replace(/\s+/g, " ").trim();
    expect(await summary({})).toBe("Filter");
    expect(await summary({ sort: "price_asc", view: "list" })).toBe("Filter");
    expect(await summary({ min: "10", max: "50" })).toBe("Filter 1");
    expect(await summary({ brand: BIG_BRAND, instock: "1", rating: "4" })).toBe("Filter 3");
  });
});

// ---------------------------------------------------------------------------
// Promo slots (L-11, L-13 .. L-17)
// ---------------------------------------------------------------------------

describe("listing promo tiles (L-11, L-13..L-17)", () => {
  test.each([...COLLECTIONS, DEPT, BRAND].map((r) => [r.path, r] as const))("%s page 1: 1..3 tiles at li 3/10/17, even cells before each, never last, CTA not the route", async (_p, route) => {
    const { doc } = await render(route);
    const items = gridItems(doc);
    const products = items.filter((li) => !isPromo(li));
    expect(products.length).toBeGreaterThanOrEqual(8);
    const promos = items.filter(isPromo);
    expect(promos.length).toBeGreaterThanOrEqual(1);
    expect(promos.length).toBeLessThanOrEqual(3);
    let cells = 0;
    const positions: number[] = [];
    items.forEach((li, i) => {
      if (isPromo(li)) {
        positions.push(i + 1);
        expect({ position: i + 1, cellsBefore: cells, even: cells % 2 === 0 }).toEqual({ position: i + 1, cellsBefore: cells, even: true });
        cells += Number(li.getAttribute("data-promo-span") ?? "1");
      } else {
        cells += 1;
      }
    });
    expect(positions).toEqual([3, 10, 17].slice(0, promos.length));
    expect(isPromo(items[items.length - 1] as Element)).toBe(false);
    for (const li of promos) {
      const links = [...li.querySelectorAll("a")];
      expect(links).toHaveLength(1);
      const href = links[0]?.getAttribute("href") ?? "";
      expect(isAllowedInternalHref(href)).toBe(true);
      expect(pathOf(href)).not.toBe(route.path);
      expect(li.querySelectorAll("h1, h2")).toHaveLength(0);
      expect(li.tagName).toBe("LI");
    }
  });

  test("page 2, a facet, the list view, or < 8 results -> no promo tiles; a sort alone keeps them", async () => {
    expect(promoItems((await render(PRODUCTS, { page: "2" })).doc)).toHaveLength(0);
    expect(promoItems((await render(DEPT, { instock: "1" })).doc)).toHaveLength(0);
    expect(promoItems((await render(PRODUCTS, { brand: BIG_BRAND })).doc)).toHaveLength(0);
    expect(promoItems((await render(PRODUCTS, { min: "1" })).doc)).toHaveLength(0);
    const listView = (await render(PRODUCTS, { view: "list" })).doc;
    expect(listView.querySelectorAll("[data-promo-span]")).toHaveLength(0);
    expect(SMALL_CATEGORY).not.toBe("");
    const small = (await render(slugRoute("category", SMALL_CATEGORY))).doc;
    expect(gridItems(small).length).toBeGreaterThan(0);
    expect(promoItems(small)).toHaveLength(0);
    expect(promoItems((await render(PRODUCTS, { sort: "price_asc" })).doc).length).toBeGreaterThan(0);
  });

  test("/deals never shows the 'Shop deals' tile; /best-sellers never the best-sellers tile", async () => {
    const dealHrefs = promoItems((await render(DEALS)).doc).map((li) => li.querySelector("a")?.getAttribute("href"));
    expect(dealHrefs).not.toContain("/deals");
    const bestHrefs = promoItems((await render(BEST)).doc).map((li) => li.querySelector("a")?.getAttribute("href"));
    expect(bestHrefs).not.toContain("/best-sellers");
  });

  test("L-3/L-18: /products shows 24 product cards, '1–24 of N results', pagination nav with aria-current and rel next", async () => {
    const { doc, html } = await render(PRODUCTS);
    const productLis = gridItems(doc).filter((li) => !isPromo(li));
    expect(productLis).toHaveLength(LISTING_PAGE_SIZE);
    expect(doc.getElementById("listing-result-count")?.textContent).toBe(`1–${LISTING_PAGE_SIZE} of ${SEED_CATALOG_STATS.published} results`);
    const nav = doc.querySelector('nav[aria-label="Listing pages"]');
    expect(nav?.querySelector('[aria-current="page"]')?.textContent?.trim()).toContain("1");
    expect(nav?.querySelector('a[rel="next"]')?.getAttribute("href")).toBe("/products?page=2");
    const pages = Math.ceil(SEED_CATALOG_STATS.published / LISTING_PAGE_SIZE);
    const last = await render(PRODUCTS, { page: String(pages) });
    const lastCount = SEED_CATALOG_STATS.published - (pages - 1) * LISTING_PAGE_SIZE;
    expect(gridItems(last.doc).filter((li) => !isPromo(li))).toHaveLength(lastCount);
    expect(last.doc.querySelector('nav[aria-label="Listing pages"] a[rel="next"]')).toBeNull();
    expect(html).toContain('rel="next"');
  });
});

// ---------------------------------------------------------------------------
// Related chips (L-4) and feedback (L-19, L-20)
// ---------------------------------------------------------------------------

describe("listing related chips and feedback (L-4, L-19, L-20)", () => {
  test("department: 'Related categories' chips to other departments, never the current one, <= 12", async () => {
    const { doc } = await render(DEPT);
    const nav = relatedNav(doc);
    expect(nav?.label).toBe("Related categories");
    expect(nav?.hrefs.length ?? 0).toBeGreaterThan(0);
    expect(nav?.hrefs.length ?? 0).toBeLessThanOrEqual(12);
    for (const href of nav?.hrefs ?? []) {
      expect(href).toMatch(/^\/category\/[a-z0-9-]+$/);
      expect(href).not.toBe(DEPT.path);
    }
  });

  test("subcategory: chips are its siblings, never itself", async () => {
    const { doc } = await render(SUBCAT);
    const nav = relatedNav(doc);
    expect(nav?.hrefs.length ?? 0).toBeGreaterThan(0);
    expect(nav?.hrefs).not.toContain(SUBCAT.path);
    const tree = getListingService().categoryTree(Date.now());
    const parent = tree.find((d) => d.children.some((c) => c.slug === "audio"));
    const siblings = new Set((parent?.children ?? []).filter((c) => c.slug !== "audio").map((c) => `/category/${c.slug}`));
    for (const href of nav?.hrefs ?? []) expect(siblings.has(href)).toBe(true);
  });

  test("brand: 'More brands' chips to other brands with products, never the current brand, most products first", async () => {
    const { doc } = await render(BRAND);
    const nav = relatedNav(doc);
    expect(nav?.label).toBe("More brands");
    expect(nav?.hrefs).not.toContain(BRAND.path);
    expect(nav?.hrefs.length ?? 0).toBeLessThanOrEqual(12);
    const counts = (nav?.hrefs ?? []).map((h) => SEED_CATALOG_STATS.byBrand[h.slice("/brand/".length)] ?? 0);
    expect(counts.every((n) => n > 0)).toBe(true);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  test("collections have no related-chip nav", async () => {
    for (const route of COLLECTIONS) {
      expect({ route: route.path, nav: relatedNav((await render(route)).doc) }).toEqual({ route: route.path, nav: null });
    }
  });

  test.each(ALL_ROUTES.map((r) => [r.path, r] as const))("%s: feedback block with exact 'Give feedback' href, 2..3 suggestions, never the current route, no form", async (_p, route) => {
    const { doc } = await render(route);
    const section = feedbackSection(doc);
    expect(section).not.toBeNull();
    const give = [...(section?.querySelectorAll("a") ?? [])].filter((a) => a.textContent?.trim() === "Give feedback");
    expect(give.map((a) => a.getAttribute("href"))).toEqual(["/contact?topic=feedback"]);
    const suggestions = [...(section?.querySelectorAll("ul a") ?? [])].map((a) => a.getAttribute("href") ?? "");
    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    for (const href of suggestions) {
      expect(isAllowedInternalHref(href)).toBe(true);
      expect(pathOf(href)).not.toBe(route.path);
    }
    expect(section?.querySelectorAll("form, input")).toHaveLength(0);
    // L-order: the feedback block comes after the grid.
    expect(((grid(doc)?.compareDocumentPosition(section as Node) ?? 0) & 4) !== 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cards: badges with publishedAt, rank, quick add (L-12)
// ---------------------------------------------------------------------------

describe("listing cards (L-12, T137 badges with publishedAt)", () => {
  test.each([NEW, DEALS, PRODUCTS, TOP, DEPT].map((r) => [r.path, r] as const))("%s: every card's badges match the sale > new > top pick rule from its DB row", async (_p, route) => {
    const now = Date.now();
    const { doc } = await render(route);
    const rows = rowBySlug();
    const mismatches: string[] = [];
    for (const card of grid(doc)?.querySelectorAll("article") ?? []) {
      const slug = cardSlug(card);
      const row = rows.get(slug);
      if (row === undefined) {
        mismatches.push(`${slug}: unknown`);
        continue;
      }
      const { badges } = badgeTexts(card);
      const want = expectedBadges(row, now);
      if (JSON.stringify(badges) !== JSON.stringify(want)) mismatches.push(`${slug}: ${badges.join("+")} != ${want.join("+")}`);
      if (badges.some((b) => !BADGE_TEXTS.has(b))) mismatches.push(`${slug}: unknown badge ${badges.join("+")}`);
    }
    expect(mismatches).toEqual([]);
  });

  test("/new-arrivals page 1 shows 'New' badges (publishedAt reaches listing cards, bx)", async () => {
    const { doc } = await render(NEW);
    const withNew = [...(grid(doc)?.querySelectorAll("article") ?? [])].filter((c) => badgeTexts(c).badges.includes("New"));
    expect(withNew.length).toBeGreaterThan(0);
  });

  test("/best-sellers: the strip starts with 'Rank #n' (1..24 in order), then at most 2 card badges", async () => {
    const { doc } = await render(BEST);
    const cards = [...(grid(doc)?.querySelectorAll("article") ?? [])];
    expect(cards).toHaveLength(LISTING_PAGE_SIZE);
    const hash = String.fromCharCode(35);
    cards.forEach((card, i) => {
      const { rank, badges } = badgeTexts(card);
      expect(rank?.replace(/\s+/g, " ")).toBe(`Rank ${hash}${i + 1}`);
      expect(badges.length).toBeLessThanOrEqual(2);
      for (const b of badges) expect(BADGE_TEXTS.has(b)).toBe(true);
    });
  });

  test.each(ALL_ROUTES.map((r) => [r.path, r] as const))("%s: quick add is a sibling POST form (productId + quantity=1 only); out of stock has no form", async (_p, route) => {
    const { doc } = await render(route);
    const rows = rowBySlug();
    for (const card of grid(doc)?.querySelectorAll("article") ?? []) {
      const slug = cardSlug(card);
      const link = card.querySelector("a[href^='/products/']");
      expect(link?.querySelectorAll("a, button, form, input")).toHaveLength(0);
      const form = card.querySelector("form");
      if ((rows.get(slug)?.stock ?? 0) === 0) {
        expect({ slug, form: form === null, text: card.textContent?.includes("Out of stock") }).toEqual({ slug, form: true, text: true });
        continue;
      }
      expect(form?.getAttribute("method")?.toUpperCase()).toBe("POST");
      const fields = [...(form?.querySelectorAll("input") ?? [])]
        .map((i) => i.getAttribute("name") ?? "")
        .filter((n) => !n.startsWith("$ACTION"));
      expect({ slug, fields }).toEqual({ slug, fields: ["productId", "quantity"] });
      expect(form?.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
    }
  });
});

// ---------------------------------------------------------------------------
// Data access: one list() call, one clock read
// ---------------------------------------------------------------------------

describe("listing data access (one list() call, now once)", () => {
  test.each(ALL_ROUTES.map((r) => [r.path, r] as const))("%s: exactly one list() call per render", async (_p, route) => {
    const spy = spyOn(getListingService(), "list");
    restorers.push(() => spy.mockRestore());
    await render(route, { sort: "price_asc" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test.each(ALL_ROUTES.map((r) => [r.path, r] as const))("%s: the page call reads the clock once; rendering reads none", async (_p, route) => {
    const loaded = await countClockReads(() => route.page({}));
    expect({ reads: loaded.reads, stacks: loaded.reads === 1 ? [] : loaded.stacks }).toEqual({ reads: 1, stacks: [] });
    const rendered = await countClockReads(async () => renderToStaticMarkup(<>{loaded.value}</>));
    expect({ reads: rendered.reads, stacks: rendered.stacks }).toEqual({ reads: 0, stacks: [] });
  });
});

// ---------------------------------------------------------------------------
// SEO unchanged (L-25), 404, empty category (L-22, L-20), /brands
// ---------------------------------------------------------------------------

describe("listing SEO, 404 and empty states (L-20, L-22, L-25)", () => {
  test.each(ALL_ROUTES.map((r) => [r.path, r] as const))("%s: canonical drops sort/view/page=1/rail; facets -> noindex,follow", async (_p, route) => {
    const plain = await route.meta({ sort: "price_asc", view: "list", page: "1", rail: "deals", utm_source: "x" });
    const canonical = String(plain.alternates?.canonical ?? "");
    expect(canonical).toBe(`${SITE}${route.path}`);
    const faceted = await route.meta({ instock: "1" });
    expect(faceted.robots).toEqual({ index: false, follow: true });
    expect(String(faceted.alternates?.canonical ?? "")).not.toContain("instock");
  });

  test.each(ALL_ROUTES.map((r) => [r.path, r] as const))("%s: JSON-LD parses, holds an ItemList, has no raw '<'", async (_p, route) => {
    const { doc } = await render(route);
    const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
    expect(scripts.length).toBeGreaterThan(0);
    const types: string[] = [];
    for (const s of scripts) {
      expect(s.textContent ?? "").not.toContain("<");
      const data = JSON.parse(s.textContent ?? "null") as unknown;
      for (const d of Array.isArray(data) ? data : [data]) types.push(String((d as { "@type"?: unknown })["@type"]));
    }
    expect(types).toContain("ItemList");
  });

  test("unknown category and brand slugs -> notFound()", async () => {
    for (const route of [slugRoute("category", "no-such-category-qa"), slugRoute("brand", "no-such-brand-qa"), slugRoute("category", "../etc")]) {
      const outcome = await outcomeOf(() => route.page({}));
      expect({ route: route.path, kind: outcome.kind }).toEqual({ route: route.path, kind: "notFound" });
    }
    expect(NotFoundSentinel).toBeDefined();
  });

  test("empty category: empty state with a /products link; no grid, no promos, no feedback, no related chips", async () => {
    await withRollback(async () => {
      const db = getDatabase();
      const dept = db.query<{ id: string }, []>("SELECT id FROM categories WHERE slug = 'electronics'").get();
      db.run("INSERT INTO categories (id, slug, name, parent_id, sort_order) VALUES ('cat_qa_empty', 'qa-empty-shelf', 'QA Empty Shelf', ?, 99)", [dept?.id ?? null]);
      const { doc } = await render(slugRoute("category", "qa-empty-shelf"));
      expect(doc.querySelector("h1")?.textContent).toBe("QA Empty Shelf");
      expect([...doc.querySelectorAll("h2")].map((h) => h.textContent)).toContain("No products in QA Empty Shelf yet");
      expect([...doc.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/products")).toBe(true);
      expect(grid(doc)).toBeNull();
      expect(doc.querySelectorAll("[data-promo-span]")).toHaveLength(0);
      expect(feedbackSection(doc)).toBeNull();
      expect(doc.getElementById("listing-result-count")?.textContent).toBe("0 results");
      expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
    });
  });

  test("/brands: one h1, one section (labelled by its h2) of white brand tiles, every brand with products linked", async () => {
    // T177 (U05): the per-letter Card sections became one grid of tiles.
    const html = renderToStaticMarkup(<>{await brands.default()}</>);
    const doc = parseHtml(html);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    const sections = [...doc.querySelectorAll("section[aria-labelledby]")];
    expect(sections).toHaveLength(1);
    const h2 = doc.getElementById(sections[0]?.getAttribute("aria-labelledby") ?? "");
    expect(h2?.tagName).toBe("H2");
    expect(sections[0]?.contains(h2 ?? null)).toBe(true);
    const tiles = [...(sections[0]?.querySelectorAll("ul > li") ?? [])];
    expect(tiles.length).toBeGreaterThan(0);
    for (const li of tiles) {
      const cls = li.getAttribute("class") ?? "";
      expect(/\brounded-lg\b/.test(cls) && /\bbg-surface-raised\b/.test(cls)).toBe(true);
    }
    const names = tiles.map((li) => li.querySelector("a")?.textContent ?? "");
    const collator = new Intl.Collator("en", { sensitivity: "base" });
    expect(names).toEqual([...names].sort((a, b) => collator.compare(a, b)));
    const linked = new Set([...doc.querySelectorAll("a[href^='/brand/']")].map((a) => a.getAttribute("href")));
    for (const [slug, n] of Object.entries(SEED_CATALOG_STATS.byBrand)) if (slug !== "" && n > 0) expect(linked.has(`/brand/${slug}`)).toBe(true);
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

describe("listing safety (hrefs, brand-free, hostile names, L-27)", () => {
  test.each(ALL_ROUTES.map((r) => [r.path, r] as const))("%s: hrefs allow-listed, ids unique, brand-free, light-only, no marketplace copy", async (_p, route) => {
    const { doc, html } = await render(route);
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
    expect(duplicateIds(doc)).toEqual([]);
    expect(brandAndThemeViolations(html)).toEqual([]);
    expect(darkClassTokens(doc)).toEqual([]);
    const text = (doc.body.textContent ?? "").toLowerCase();
    for (const word of ["marketplace", "online only", "sold by", "third-party seller"]) expect({ word, found: text.includes(word) }).toEqual({ word, found: false });
  });

  test("hostile product, brand and category names render as inert text in cards, chips and JSON-LD", async () => {
    await withRollback(async () => {
      const db = getDatabase();
      db.run("UPDATE categories SET name = ? WHERE slug = 'books'", [HOSTILE]);
      db.run("UPDATE brands SET name = ? WHERE slug <> ? AND slug = (SELECT slug FROM brands WHERE slug <> ? ORDER BY slug LIMIT 1)", [HOSTILE, BIG_BRAND, BIG_BRAND]);
      const slug = db.query<{ slug: string }, []>("SELECT p.slug FROM products p JOIN categories c ON c.id = p.category_id JOIN categories d ON d.id = c.parent_id WHERE d.slug = 'electronics' ORDER BY p.slug LIMIT 1").get()?.slug ?? "";
      db.run("UPDATE products SET name = ? WHERE slug = ?", [HOSTILE, slug]);
      for (const route of [DEPT, BRAND]) {
        const { doc, html } = await render(route);
        expect(doc.querySelector("img[src='x']")).toBeNull();
        expect(html).not.toContain("<script>alert");
        const handlers = [...doc.querySelectorAll("*")].flatMap((el) => el.getAttributeNames().filter((n) => n.startsWith("on")));
        expect(handlers).toEqual([]);
        for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) expect(s.textContent ?? "").not.toContain("<");
        // Full text in the card title (DEPT); chips may truncate long names (ChipRow), so BRAND only checks inertness.
        if (route === DEPT) expect(doc.body.textContent).toContain(HOSTILE);
        expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
      }
    });
  });
});
