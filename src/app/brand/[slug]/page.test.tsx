import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// next/* mocks are process-wide in bun test: registered before ./page is imported.
const realServer = { ...(await import("next/server")) };
mock.module("next/server", () => ({ ...realServer, connection: async () => {} }));
const cookies = mock(async () => {
  throw new Error("listing pages must not read cookies");
});
mock.module("next/headers", () => ({ cookies, headers: async () => new Headers() }));

class NotFoundSentinel extends Error {}
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    throw new NotFoundSentinel("NEXT_NOT_FOUND (test sentinel)");
  },
}));

const env = process.env as Record<string, string | undefined>;
env.DATABASE_PATH = ":memory:";
env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
const SITE = "https://shop.example.com";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { getListingService } = await import("@/server/catalog/listing-service");
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

async function renderPage(slug: string, sp: Record<string, string | string[]> = {}) {
  return render(await Page({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) }));
}

async function metadataFor(slug: string, sp: Record<string, string> = {}) {
  return generateMetadata({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) });
}

function jsonLd(container: HTMLElement): Array<Record<string, unknown>> {
  const script = container.querySelector('script[type="application/ld+json"]');
  const parsed: unknown = JSON.parse(script?.textContent ?? "null");
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
}


describe("/brand/[slug] page", () => {
  test.each([["nope"], ["Voltline"]])("unknown slug %p -> notFound()", async (slug) => {
    await expect(renderPage(slug)).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  test("brand: h1 = name, Home > Brands > Brand, only its products, JSON-LD, one list() call", async () => {
    const list = spyList();
    const { container } = await renderPage("voltline");
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Voltline"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(cookies).not.toHaveBeenCalled();
    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Brands" }).getAttribute("href")).toBe("/brands");
    expect(jsonLd(container).map((j) => j["@type"])).toEqual(["ItemList", "BreadcrumbList"]);
    expect(screen.queryByRole("group", { name: "Brand" })).toBeNull();
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("v3 (T167): other-brand chips, quick add on every in-stock card, feedback block", async () => {
    const { container } = await renderPage("voltline");
    const chips = screen.getByRole("navigation", { name: "More brands" });
    // CLEANUP-P3 (cf): page-specific chip label, not the template default.
    expect(screen.queryByRole("navigation", { name: "Related searches" })).toBeNull();
    const hrefs = within(chips).getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs).not.toContain("/brand/voltline");
    const forms = container.querySelectorAll("[data-listing-results] form");
    expect([...forms].some((f) => f.querySelector('input[name="productId"]') !== null)).toBe(true);
    expect(screen.getByRole("link", { name: "Give feedback" }).getAttribute("href")).toBe("/contact?topic=feedback");
  });

  test("empty brand: links to /brands", async () => {
    getDatabase()
      .query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE brand_id = (SELECT id FROM brands WHERE slug = 'voltline')")
      .run();
    await renderPage("voltline");
    expect(screen.getByRole("heading", { level: 2, name: "No products from Voltline yet" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "See all brands" }).getAttribute("href")).toBe("/brands");
  });

  test("metadata: canonical, faceted noindex,follow, unknown noindex", async () => {
    expect((await metadataFor("voltline")).alternates?.canonical).toBe(`${SITE}/brand/voltline`);
    expect((await metadataFor("voltline", { rating: "4" })).robots).toEqual({ index: false, follow: true });
    expect((await metadataFor("nope")).robots).toEqual({ index: false, follow: false });
  });
});
