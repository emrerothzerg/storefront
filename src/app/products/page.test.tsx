import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen } from "@testing-library/react";

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

function jsonLd(container: HTMLElement): Array<Record<string, unknown>> {
  const script = container.querySelector('script[type="application/ld+json"]');
  const parsed: unknown = JSON.parse(script?.textContent ?? "null");
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
}

describe("/products page", () => {
  test("200: one h1, all products, ItemList <= 24 absolute, rel next, one list() call, no cookies", async () => {
    const list = spyList();
    const readSession = spyOn(session, "readSessionId");
    restorers.push(() => readSession.mockRestore());
    const { container } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["All products"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(cookies).not.toHaveBeenCalled();
    expect(readSession).not.toHaveBeenCalled();
    expect(screen.getByText(new RegExp(`of ${PUBLISHED} results`))).toBeTruthy();
    const [itemList, crumbs] = jsonLd(container);
    expect(itemList?.["@type"]).toBe("ItemList");
    const elements = itemList?.itemListElement as Array<{ url: string }>;
    expect(elements.length).toBe(24);
    for (const e of elements) expect(e.url.startsWith(`${SITE}/products/`)).toBe(true);
    expect(crumbs?.["@type"]).toBe("BreadcrumbList");
    const rel = document.querySelector('link[rel="next"]');
    expect(rel?.getAttribute("href")).toBe(`${SITE}/products?page=2`);
    expect(document.querySelector('link[rel="prev"]')).toBeNull();
  });

  test("every link passes isAllowedInternalHref", async () => {
    const { container } = await renderPage({ page: "2", instock: "1" });
    const hrefs = [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(isAllowedInternalHref(href)).toBe(true);
  });

  const HOSTILE: readonly [string, Record<string, string | string[]>][] = [
    ["garbage", { foo: "<b>x</b>", page: "-1", sort: "evil", rating: "0" }],
    ["arrays", { page: ["2", "3"], view: ["list", "grid"] }],
    ["huge", { page: "9".repeat(5000), min: "1".repeat(100) }],
    ["unknown category", { category: "zzz" }],
  ];
  test.each(HOSTILE)("hostile params (%s) -> still one h1 and results", async (_name, sp) => {
    await renderPage(sp);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText(new RegExp(`\\b${PUBLISHED} results`))).toBeTruthy();
  });

  test("page beyond the last: empty-page state with a link back", async () => {
    await renderPage({ page: "40" });
    expect(screen.getByText("This page is empty")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to the last page" }).getAttribute("href")).toBe(`/products?page=${Math.ceil(PUBLISHED / 24)}`);
  });

  test("metadata: plain indexable, page 3 self-canonical, faceted noindex,follow", async () => {
    const plain = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(plain.alternates?.canonical).toBe(`${SITE}/products`);
    expect(plain.robots).toBeUndefined();
    const page3 = await generateMetadata({ searchParams: Promise.resolve({ page: "3" }) });
    expect(page3.alternates?.canonical).toBe(`${SITE}/products?page=3`);
    const faceted = await generateMetadata({ searchParams: Promise.resolve({ brand: "voltline", page: "3" }) });
    expect(faceted.alternates?.canonical).toBe(`${SITE}/products`);
    expect(faceted.robots).toEqual({ index: false, follow: true });
    expect(cookies).not.toHaveBeenCalled();
  });
});

describe("/products page v3 (T167)", () => {
  test("page 1: 3 promo li at positions 3, 10, 17; quick-add forms; feedback block without a self link", async () => {
    const { container } = await renderPage();
    const grid = container.querySelector("[data-listing-results] ul[data-layout='grid']");
    const lis = [...(grid?.children ?? [])];
    expect(lis.flatMap((li, i) => (li.hasAttribute("data-promo-span") ? [i + 1] : []))).toEqual([3, 10, 17]);
    for (const tile of container.querySelectorAll("[data-promo-span]")) {
      expect(tile.tagName).toBe("LI");
      expect(tile.querySelectorAll("a")).toHaveLength(1);
      expect(tile.querySelector("h1, h2")).toBeNull();
      expect(tile.querySelector("a")?.getAttribute("href")).not.toBe("/products");
    }
    const forms = grid?.querySelectorAll("form") ?? [];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(form.querySelector('input[name="productId"]')).not.toBeNull();
      expect(form.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
      expect(form.querySelector('input[name*="price" i], input[name*="total" i]')).toBeNull();
    }
    expect(screen.getByRole("heading", { level: 2, name: "Did you find what you were looking for?" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Give feedback" }).getAttribute("href")).toBe("/contact?topic=feedback");
    // Collections have no related chips.
    expect(screen.queryByRole("navigation", { name: "Related searches" })).toBeNull();
  });

  test("page 2 and faceted pages: no promo li", async () => {
    const cases: Record<string, string>[] = [{ page: "2" }, { instock: "1" }, { rating: "1" }];
    for (const sp of cases) {
      const { container, unmount } = await renderPage(sp);
      expect({ sp, promos: container.querySelectorAll("[data-promo-span]").length }).toEqual({ sp, promos: 0 });
      unmount();
    }
  });
});
