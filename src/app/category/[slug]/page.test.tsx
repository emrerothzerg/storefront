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
const { SEED_CATALOG_STATS, seedDatabase } = await import("@/server/db/seed");
/** Published seed products in the Electronics department. */
const ELECTRONICS = SEED_CATALOG_STATS.byDepartment.electronics ?? -1;
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


describe("/category/[slug] page", () => {
  test.each([["nope"], ["UPPER"], ["..%2f"]])("unknown slug %p -> notFound()", async (slug) => {
    await expect(renderPage(slug)).rejects.toBeInstanceOf(NotFoundSentinel);
  });

  test("department: h1, breadcrumb Home > Dept, hero text, tiles, JSON-LD, one list() call, no cookies", async () => {
    const list = spyList();
    const { container } = await renderPage("electronics");
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Electronics"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(cookies).not.toHaveBeenCalled();
    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Home" }).getAttribute("href")).toBe("/");
    const tiles = screen.getByRole("region", { name: "Shop Electronics" });
    expect(within(tiles).getByRole("link", { name: /Headphones & Audio/ }).getAttribute("href")).toBe("/category/audio");
    expect(screen.getByText(new RegExp(`of ${ELECTRONICS} results|^${ELECTRONICS} results`))).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /Top sellers in/ })).toBeNull();
    const types = jsonLd(container).map((j) => j["@type"]);
    expect(types).toEqual(["ItemList", "BreadcrumbList"]);
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("v3 (T167): sibling chips, CategoryRail circle tiles, 3 promo li on page 1, quick add, feedback", async () => {
    const { container } = await renderPage("electronics");
    const chips = screen.getByRole("navigation", { name: "Related categories" });
    // CLEANUP-P3 (cf): page-specific chip label, not the template default.
    expect(screen.queryByRole("navigation", { name: "Related searches" })).toBeNull();
    const chipHrefs = within(chips).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(chipHrefs).toContain("/category/books");
    expect(chipHrefs).not.toContain("/category/electronics");
    // Subcategories: CategoryRail (not the deprecated CategoryGrid alias), circle tiles.
    const rail = container.querySelector("#category-subcategories");
    expect(rail?.hasAttribute("data-category-rail")).toBe(true);
    const grid = container.querySelector("[data-listing-results] ul[data-layout='grid']");
    const lis = [...(grid?.children ?? [])];
    const promoIndexes = lis.flatMap((li, i) => (li.hasAttribute("data-promo-span") ? [i + 1] : []));
    expect(promoIndexes).toEqual([3, 10, 17]);
    expect(lis.filter((li) => !li.hasAttribute("data-promo-span"))).toHaveLength(Math.min(24, ELECTRONICS));
    const forms = grid?.querySelectorAll("form") ?? [];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect(form.querySelector('input[name="productId"]')).not.toBeNull();
      expect(form.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
    }
    expect(screen.getByRole("heading", { level: 2, name: "Did you find what you were looking for?" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Give feedback" }).getAttribute("href")).toBe("/contact?topic=feedback");
  });

  test("v3 (T167): page 2 and faceted pages have no promo li", async () => {
    const cases: Record<string, string>[] = [{ page: "2" }, { instock: "1" }];
    for (const sp of cases) {
      const { container, unmount } = await renderPage("electronics", sp);
      expect(container.querySelectorAll("[data-promo-span]")).toHaveLength(0);
      unmount();
    }
  });

  test("child: breadcrumb Home > Dept > Child, 2-level BreadcrumbList", async () => {
    const { container } = await renderPage("audio");
    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Electronics" }).getAttribute("href")).toBe("/category/electronics");
    expect(within(crumbs).getByText("Headphones & Audio")).toBeTruthy();
    const breadcrumb = jsonLd(container).find((j) => j["@type"] === "BreadcrumbList");
    expect((breadcrumb?.itemListElement as unknown[]).length).toBe(3);
  });

  test("top sellers rail appears with sales", async () => {
    const db = getDatabase();
    const audio = db.query<{ id: string }, []>(
      "SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id WHERE c.slug = 'audio' LIMIT 1",
    ).get();
    db.query(
      `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
         region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
       VALUES ('o1', '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'paid', 1, 1, 'USD', 'T', 't@e.com', '1', 'C', 'R', '0', 'US', '4242', 'k1', ?, 'processing')`,
    ).run(new Date(Date.now() - 3_600_000).toISOString());
    db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES ('o1', ?, 'x', 1, 1)").run(audio?.id ?? "");
    await renderPage("electronics");
    expect(screen.getByRole("heading", { name: "Top sellers in Electronics" })).toBeTruthy();
  });

  test("empty category: empty state with sibling links (200)", async () => {
    getDatabase()
      .query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE category_id = (SELECT id FROM categories WHERE slug = 'cycling')")
      .run();
    await renderPage("cycling");
    expect(screen.getByRole("heading", { level: 2, name: /No products in Cycling/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Fitness & Yoga" }).getAttribute("href")).toBe("/category/fitness");
    // CONTRACTS L-22 (T167): a way out to all products; no grid, no promos, no chips, no feedback.
    expect(screen.getByRole("link", { name: "Browse all products" }).getAttribute("href")).toBe("/products");
    expect(screen.queryByRole("navigation", { name: "Related categories" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Did you find what you were looking for?" })).toBeNull();
    expect(document.querySelector("[data-listing-results] ul li form")).toBeNull();
  });

  test("hostile params ignored", async () => {
    await renderPage("electronics", { category: "<x>", dept: "books", page: ["1", "2"], brand: "../../etc" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText(new RegExp(`\\b${ELECTRONICS} results`))).toBeTruthy();
  });

  test("metadata matrix: plain, page 3, faceted, unknown", async () => {
    const plain = await metadataFor("electronics");
    expect(plain.alternates?.canonical).toBe(`${SITE}/category/electronics`);
    expect(plain.robots).toBeUndefined();
    const page3 = await metadataFor("electronics", { page: "3" });
    expect(page3.alternates?.canonical).toBe(`${SITE}/category/electronics?page=3`);
    const faceted = await metadataFor("electronics", { instock: "1", page: "3" });
    expect(faceted.alternates?.canonical).toBe(`${SITE}/category/electronics`);
    expect(faceted.robots).toEqual({ index: false, follow: true });
    expect((await metadataFor("nope")).robots).toEqual({ index: false, follow: false });
    expect(cookies).not.toHaveBeenCalled();
  });
});
