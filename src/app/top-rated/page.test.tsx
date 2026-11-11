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
const { seedDatabase } = await import("@/server/db/seed");
const { getListingService } = await import("@/server/catalog/listing-service");
const { isAllowedInternalHref } = await import("@/content/routes");
type ListingService = ReturnType<typeof getListingService>;
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

describe("/top-rated page", () => {
  test("200: highest rating first, one h1, JSON-LD, one list() call, no cookies, allowed hrefs", async () => {
    const list = spyList();
    const { container } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Top Rated"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ sort: "rating" });
    const value = callResult(list);
    expect(value.sort).toBe("rating");
    expect(value.items.length).toBeGreaterThan(0);
    const ratings = value.items.map((p) => p.ratingAvg ?? 0);
    expect([...ratings].sort((a, b) => b - a)).toEqual(ratings);
    expect(cookies).not.toHaveBeenCalled();
    expect(container.textContent).not.toMatch(/Rank #\d/);
    const ld = jsonLd(container);
    expect(ld.map((j) => j["@type"])).toEqual(["ItemList", "BreadcrumbList"]);
    const crumbs = ld[1]?.itemListElement as Array<Record<string, unknown>>;
    expect(crumbs.map((c) => c.name)).toEqual(["Home", "Top Rated"]);
    expect(crumbs[crumbs.length - 1]?.item).toBe(`${SITE}/top-rated`);
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("route default `rating` is omitted from links; a chosen featured sort survives pagination and view links", async () => {
    const { container } = await renderPage({ sort: "featured" });
    const hrefs = [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    const viewLinks = [...container.querySelectorAll('[role="group"][aria-label="View"] a')].map((a) => a.getAttribute("href") ?? "");
    expect(viewLinks.length).toBe(2);
    for (const h of viewLinks) expect(new URL(h, SITE).searchParams.get("sort")).toBe("featured");
    const plain = await renderPage({ sort: "rating" });
    const plainHrefs = [...plain.container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    expect(plainHrefs.filter((h) => h.startsWith("/top-rated") && /[?&]sort=rating/.test(h))).toEqual([]);
    expect(hrefs.length).toBeGreaterThan(0);
  });

  test("q is dropped (not a search route): no q in links", async () => {
    const { container } = await renderPage({ q: "desk" });
    const hrefs = [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.filter((h) => h.startsWith("/top-rated") && /[?&]q=/.test(h))).toEqual([]);
  });

  test("metadata: indexable canonical, compliant description, re-sorted noindex, q stripped", async () => {
    const plain = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(plain.title).toBe("Top Rated");
    expect(plain.alternates?.canonical).toBe(`${SITE}/top-rated`);
    expect(plain.robots).toBeUndefined();
    const description = String(plain.description ?? "");
    expect(description.length).toBeGreaterThanOrEqual(70);
    expect(description.length).toBeLessThanOrEqual(160);
    const redundant = await generateMetadata({ searchParams: Promise.resolve({ sort: "rating", page: "2" }) });
    expect(redundant.robots).toBeUndefined();
    expect(redundant.alternates?.canonical).toBe(`${SITE}/top-rated?page=2`);
    const resorted = await generateMetadata({ searchParams: Promise.resolve({ sort: "featured" }) });
    expect(resorted.robots).toEqual({ index: false, follow: true });
    expect(resorted.alternates?.canonical).toBe(`${SITE}/top-rated`);
    const withQ = await generateMetadata({ searchParams: Promise.resolve({ q: "desk" }) });
    expect(withQ.alternates?.canonical).toBe(`${SITE}/top-rated`);
    expect(withQ.robots).toBeUndefined();
  });
});

describe("/top-rated page v3 (T167)", () => {
  test("page 1: 3 promo li at positions 3, 10, 17; quick-add forms; feedback block without a self link", async () => {
    const { container } = await renderPage();
    const grid = container.querySelector("[data-listing-results] ul[data-layout='grid']");
    const lis = [...(grid?.children ?? [])];
    expect(lis.flatMap((li, i) => (li.hasAttribute("data-promo-span") ? [i + 1] : []))).toEqual([3, 10, 17]);
    for (const tile of container.querySelectorAll("[data-promo-span]")) {
      expect(tile.tagName).toBe("LI");
      expect(tile.querySelectorAll("a")).toHaveLength(1);
      expect(tile.querySelector("h1, h2")).toBeNull();
      expect(tile.querySelector("a")?.getAttribute("href")).not.toBe("/top-rated");
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
