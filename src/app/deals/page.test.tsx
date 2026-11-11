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
const { getListingService } = await import("@/server/catalog/listing-service");
type ListingService = ReturnType<typeof getListingService>;
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

type ListCall = ReturnType<ListingService["list"]>;
function callResult(spy: { mock: { results: ReadonlyArray<{ value: unknown }> } }, index = 0) {
  const r = spy.mock.results[index]?.value as ListCall | undefined;
  if (r === undefined || !r.ok) throw new Error("list() call missing or failed");
  return r.value;
}

function jsonLd(container: HTMLElement): Array<Record<string, unknown>> {
  const script = container.querySelector('script[type="application/ld+json"]');
  const parsed: unknown = JSON.parse(script?.textContent ?? "null");
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
}


describe("/deals page", () => {
  test("200: one h1, only discounted products, JSON-LD, one list() call, no cookies", async () => {
    const list = spyList();
    const { container } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Today's Deals"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ dealsOnly: true });
    const value = { value: callResult(list) };
    expect(value.value.total).toBe(SEED_CATALOG_STATS.deals);
    for (const p of value.value.items) expect(p.listPriceCents ?? 0).toBeGreaterThan(p.priceCents);
    expect(cookies).not.toHaveBeenCalled();
    expect(jsonLd(container).map((j) => j["@type"])).toEqual(["ItemList", "BreadcrumbList"]);
    expect(screen.queryByText("No deals right now")).toBeNull();
  });

  test("no deals: 'No deals right now' with links, 200", async () => {
    getDatabase().query("UPDATE products SET list_price_cents = price_cents").run();
    const { container } = await renderPage();
    expect(screen.getByRole("heading", { level: 2, name: "No deals right now" })).toBeTruthy();
    for (const name of ["Browse all products", "Best Sellers", "New Arrivals"]) {
      expect(isAllowedInternalHref(screen.getByRole("link", { name }).getAttribute("href") ?? "")).toBe(true);
    }
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(jsonLd(container).map((j) => j["@type"])).toEqual(["BreadcrumbList"]);
  });

  test("garbage params ignored; every link allowed", async () => {
    const { container } = await renderPage({ deals: "yes", sort: "x", page: "0", junk: "1" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("metadata: indexable canonical; redundant deals=1 stays indexable; facets noindex,follow", async () => {
    const plain = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(plain.alternates?.canonical).toBe(`${SITE}/deals`);
    expect(plain.robots).toBeUndefined();
    expect((await generateMetadata({ searchParams: Promise.resolve({ deals: "1" }) })).robots).toBeUndefined();
    const faceted = await generateMetadata({ searchParams: Promise.resolve({ rating: "4" }) });
    expect(faceted.robots).toEqual({ index: false, follow: true });
  });
});

describe("/deals page v3 (T167)", () => {
  test("page 1: 3 promo li at positions 3, 10, 17; quick-add forms; feedback block without a self link", async () => {
    const { container } = await renderPage();
    const grid = container.querySelector("[data-listing-results] ul[data-layout='grid']");
    const lis = [...(grid?.children ?? [])];
    expect(lis.flatMap((li, i) => (li.hasAttribute("data-promo-span") ? [i + 1] : []))).toEqual([3, 10, 17]);
    for (const tile of container.querySelectorAll("[data-promo-span]")) {
      expect(tile.tagName).toBe("LI");
      expect(tile.querySelectorAll("a")).toHaveLength(1);
      expect(tile.querySelector("h1, h2")).toBeNull();
      expect(tile.querySelector("a")?.getAttribute("href")).not.toBe("/deals");
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
