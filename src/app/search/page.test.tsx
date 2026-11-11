import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup as cleanupDom, render, screen, within } from "@testing-library/react";

// next/* mocks are process-wide in bun test: registered before ./page is imported.
const realServer = { ...(await import("next/server")) };
mock.module("next/server", () => ({ ...realServer, connection: async () => {} }));
const cookies = mock(async () => {
  throw new Error("listing pages must not read cookies");
});
mock.module("next/headers", () => ({ cookies, headers: async () => new Headers() }));

const env = process.env as Record<string, string | undefined>;
env.DATABASE_PATH = ":memory:";
env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
const SITE = "https://shop.example.com";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { SEED_CATALOG_STATS, seedDatabase } = await import("@/server/db/seed");
/** Published seed products (the seed future-dates a few). */
const PUBLISHED = SEED_CATALOG_STATS.published;
const { getListingService } = await import("@/server/catalog/listing-service");
const session = await import("@/server/session/session");
const { isAllowedInternalHref } = await import("@/content/routes");
const { default: Page, generateMetadata } = await import("./page");

const restorers: Array<() => void> = [];

beforeEach(() => {
  env.NEXT_PUBLIC_SITE_URL = SITE;
  closeDatabase();
  seedDatabase(getDatabase());
  cookies.mockClear();
});

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

function spyList() {
  const spy = spyOn(getListingService(), "list");
  restorers.push(() => spy.mockRestore());
  return spy;
}

async function renderPage(sp: Record<string, string | string[]> = {}) {
  return render(await Page({ searchParams: Promise.resolve(sp) }));
}


function h1Text(): string[] {
  return screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent ?? "");
}

describe("/search page", () => {
  test("empty q: browse mode 'All results' with every product", async () => {
    await renderPage();
    expect(h1Text()).toEqual(["All results"]);
    expect(screen.getByText(new RegExp(`of ${PUBLISHED} results`))).toBeTruthy();
  });

  test("q=desk: results, one list() call, no cookies, no session read", async () => {
    const list = spyList();
    const readSession = spyOn(session, "readSessionId");
    restorers.push(() => readSession.mockRestore());
    const { container } = await renderPage({ q: "desk" });
    expect(h1Text()).toEqual(["Showing results for “desk”"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(cookies).not.toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();
    expect(screen.queryByText(/Did you mean/)).toBeNull();
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  const HOSTILE: readonly [string, string, string][] = [
    ["script", '<script>alert("x")</script>', '<script>alert("x")</script>'],
    ["FTS syntax", 'desk" OR * NEAR(', 'desk" OR * NEAR('],
    ["10k chars", "a".repeat(10_000), "a".repeat(100)],
    ["unicode", "café \u{1F600} ‮​desk", "café \u{1F600} desk"],
    ["control chars", "lamp\u0000\u0007x", "lamp x"],
  ];
  test.each(HOSTILE)("hostile q (%s): 200, echoed only as h1 text", async (_name, q, shown) => {
    const { container } = await renderPage({ q });
    expect(h1Text()).toEqual([`Showing results for “${shown}”`]);
    expect(container.querySelectorAll("script:not([type='application/ld+json'])")).toHaveLength(0);
    expect(container.querySelector("img[src='x']")).toBeNull();
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("misspelling: no-results page with did-you-mean, tips, popular, departments; facets omitted", async () => {
    const { container } = await renderPage({ q: "headphnes" });
    const dym = within(screen.getByText(/Did you mean/)).getByRole("link", { name: "headphones" });
    expect(dym.getAttribute("href")).toBe("/search?q=headphones");
    expect(screen.getByRole("heading", { name: "Search tips" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Popular searches" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Shop by department" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Electronics" }).getAttribute("href")).toBe("/category/electronics");
    expect(container.querySelectorAll("form")).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Related searches" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Related searches" })).toBeNull();
  });

  test("related searches on a multi-term no-results query: template chip row, not a heading", async () => {
    await renderPage({ q: "headphones zzqxv" });
    expect(screen.queryByRole("heading", { name: "Related searches" })).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Related searches" });
    expect(within(nav).getByRole("link", { name: "headphones" }).getAttribute("href")).toBe("/search?q=headphones");
  });

  test("unknown dept is ignored; page beyond last shows the empty-page state", async () => {
    await renderPage({ q: "desk", dept: "no-such" });
    expect(screen.queryByText("No results")).toBeNull();
    cleanupDom();
    await renderPage({ q: "desk", page: "30" });
    expect(screen.getByText("This page is empty")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the last page" }).getAttribute("href")).toBe("/search?q=desk");
  });

  test("metadata: noindex,follow; canonical /search?q= without facets", async () => {
    const md = await generateMetadata({ searchParams: Promise.resolve({ q: "desk", brand: "voltline", page: "2" }) });
    expect(md.robots).toEqual({ index: false, follow: true });
    expect(md.alternates?.canonical).toBe(`${SITE}/search?q=desk`);
    const browse = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(browse.robots).toEqual({ index: false, follow: true });
    expect(cookies).not.toHaveBeenCalled();
  });

  test("v3 results: chip row under the heading, promo tiles, quick add, feedback block", async () => {
    const { container } = await renderPage({ q: "the" });
    const h1 = screen.getByRole("heading", { level: 1 });
    const nav = screen.getByRole("navigation", { name: "Related searches" });
    // chips come after the heading in document order and add no headings
    expect(h1.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nav.querySelectorAll("h1,h2,h3,h4,h5,h6")).toHaveLength(0);
    const chips = within(nav).getAllByRole("link");
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThanOrEqual(12);
    for (const chip of chips) expect(chip.getAttribute("href") ?? "").toMatch(/^\/search\?q=/);
    expect(chips.map((c) => c.getAttribute("href"))).not.toContain("/search?q=the");
    // cards and the one-unit quick-add forms (addToCart passed to the template)
    const products = container.querySelectorAll('a[href^="/products/"]');
    expect(products.length).toBeGreaterThan(0);
    const quickAdd = container.querySelectorAll('form input[name="productId"]');
    expect(quickAdd.length).toBeGreaterThan(0);
    const feedback = screen.getByRole("heading", { level: 2, name: "Did you find what you were looking for?" });
    expect(feedback).toBeTruthy();
    expect(screen.getByRole("link", { name: "Give feedback" }).getAttribute("href")).toBe("/contact?topic=feedback");
    expect(screen.getByRole("link", { name: "Search for “headphones”" }).getAttribute("href")).toBe("/search?q=headphones");
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    expect(cookies).not.toHaveBeenCalled();
  });

  test("promo tiles on page 1 only, never with a facet or dept", async () => {
    const promoLinks = (c: HTMLElement) =>
      [...c.querySelectorAll("a[href]")].filter((a) => ["/shipping", "/deals", "/signup", "/best-sellers"].includes(a.getAttribute("href") ?? ""));
    const first = await renderPage({});
    expect(promoLinks(first.container).length).toBeGreaterThan(0);
    expect(promoLinks(first.container).length).toBeLessThanOrEqual(3);
    const cases: Record<string, string>[] = [{ page: "2" }, { instock: "1" }, { dept: "electronics" }, { q: "desk", rating: "4" }];
    for (const sp of cases) {
      cleanupDom();
      const { container } = await renderPage(sp);
      expect({ sp, promos: promoLinks(container).length }).toEqual({ sp, promos: 0 });
    }
  });

  test("browse mode: 'All results', no related chips, feedback present", async () => {
    await renderPage();
    expect(h1Text()).toEqual(["All results"]);
    expect(screen.queryByRole("navigation", { name: "Related searches" })).toBeNull();
    expect(screen.getByRole("heading", { level: 2, name: "Did you find what you were looking for?" })).toBeTruthy();
  });

  test("zero results: Cards keep tips, popular searches and departments; feedback still shown for a query", async () => {
    const { container } = await renderPage({ q: "zzqxv", instock: "1" });
    expect(screen.getByText("No results")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Clear filters" }).getAttribute("href")).toBe("/search?q=zzqxv");
    const popular = screen.getByRole("navigation", { name: "Popular searches" });
    expect(within(popular).getByRole("link", { name: "yoga mat" }).getAttribute("href")).toBe("/search?q=yoga+mat");
    expect(screen.getByRole("navigation", { name: "Shop by department" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Search tips" }).closest("section")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Did you find what you were looking for?" })).toBeTruthy();
    expect(container.querySelectorAll('input[name="productId"]')).toHaveLength(0);
  });
});
