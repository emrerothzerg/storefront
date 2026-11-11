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


function paidOrder(id: string, productId: string, quantity: number): void {
  const db = getDatabase();
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
       region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
     VALUES (?, '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'paid', 1, 1, 'USD', 'T', 't@e.com', '1', 'C', 'R', '0', 'US', '4242', ?, ?, 'processing')`,
  ).run(id, `k_${id}`, new Date(Date.now() - 3_600_000).toISOString());
  db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'x', 1, ?)").run(id, productId, quantity);
}

describe("/best-sellers page", () => {
  test("200: best_selling order with '#N' ranks in text, one list() call, no cookies", async () => {
    const top = getDatabase().query<{ id: string; name: string }, []>("SELECT id, name FROM products ORDER BY id DESC LIMIT 1").get();
    paidOrder("o1", top?.id ?? "", 7);
    const list = spyList();
    const { container } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Best Sellers"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0]).toMatchObject({ sort: "best_selling" });
    expect(cookies).not.toHaveBeenCalled();
    const badges = [...container.querySelectorAll('[data-testid="product-card-badges"]')].map((b) => b.textContent ?? "");
    expect(badges[0]).toContain("#1");
    expect(badges[23]).toContain("#24");
    expect(container.textContent).toContain("Rank #1");
    const firstCard = container.querySelector('[data-testid="product-card-badges"]')?.closest("article, li");
    expect(firstCard?.textContent).toContain(top?.name ?? "?");
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    expect(jsonLd(container).map((j) => j["@type"])).toEqual(["ItemList", "BreadcrumbList"]);
  });

  test("page 2 continues the ranks (#25)", async () => {
    const { container } = await renderPage({ page: "2" });
    const badges = [...container.querySelectorAll('[data-testid="product-card-badges"]')].map((b) => b.textContent ?? "");
    expect(badges[0]).toContain("#25");
  });

  test("re-sorted by price: no ranks", async () => {
    const { container } = await renderPage({ sort: "price_asc" });
    expect(container.textContent).not.toMatch(/Rank #\d/);
  });

  test("garbage params ignored", async () => {
    await renderPage({ sort: "best_selling!", page: "abc", rating: "5" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText(new RegExp(`of ${PUBLISHED} results`))).toBeTruthy();
  });

  test("metadata: canonical; redundant sort indexable; other sort noindex,follow", async () => {
    const plain = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(plain.alternates?.canonical).toBe(`${SITE}/best-sellers`);
    expect(plain.robots).toBeUndefined();
    expect((await generateMetadata({ searchParams: Promise.resolve({ sort: "best_selling" }) })).robots).toBeUndefined();
    const resorted = await generateMetadata({ searchParams: Promise.resolve({ sort: "featured", page: "2" }) });
    expect(resorted.robots).toEqual({ index: false, follow: true });
    expect(resorted.alternates?.canonical).toBe(`${SITE}/best-sellers`);
  });
});

describe("/best-sellers page v3 (T167)", () => {
  test("page 1: 3 promo li at positions 3, 10, 17; quick-add forms; feedback block without a self link", async () => {
    const { container } = await renderPage();
    const grid = container.querySelector("[data-listing-results] ul[data-layout='grid']");
    const lis = [...(grid?.children ?? [])];
    expect(lis.flatMap((li, i) => (li.hasAttribute("data-promo-span") ? [i + 1] : []))).toEqual([3, 10, 17]);
    for (const tile of container.querySelectorAll("[data-promo-span]")) {
      expect(tile.tagName).toBe("LI");
      expect(tile.querySelectorAll("a")).toHaveLength(1);
      expect(tile.querySelector("h1, h2")).toBeNull();
      expect(tile.querySelector("a")?.getAttribute("href")).not.toBe("/best-sellers");
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
