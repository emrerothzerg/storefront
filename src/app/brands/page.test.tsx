import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
const { isAllowedInternalHref } = await import("@/content/routes");
const { default: Page, generateMetadata } = await import("./page");
const { SqliteBrandRepository } = await import("@/server/catalog/brand-repository");

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

async function renderPage() {
  return render(await Page());
}

function jsonLd(container: HTMLElement): Array<Record<string, unknown>> {
  const script = container.querySelector('script[type="application/ld+json"]');
  const parsed: unknown = JSON.parse(script?.textContent ?? "null");
  return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
}


describe("/brands page", () => {
  test("200: one h1, alphabetical brand tiles with counts, links to /brand/<slug>, BreadcrumbList, no cookies", async () => {
    const { container } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Brands"]);
    expect(cookies).not.toHaveBeenCalled();
    const brands = new SqliteBrandRepository(getDatabase()).listWithCounts();
    for (const b of brands) {
      const link = screen.getByRole("link", { name: b.name });
      expect(link.getAttribute("href")).toBe(`/brand/${b.slug}`);
      expect(link.parentElement?.textContent).toContain(`${b.productCount} product`);
    }
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    expect(jsonLd(container).map((j) => j["@type"])).toEqual(["BreadcrumbList"]);
    expect(screen.getByRole("navigation", { name: /breadcrumb/i })).toBeTruthy();

  });

  test("counts are published-only: an unpublished seed product drops its brand's count", async () => {
    const db = getDatabase();
    const row = db
      .query<{ brand_id: string; name: string; n: number }, []>(
        `SELECT p.brand_id, b.name, COUNT(*) AS n FROM products p JOIN brands b ON b.id = p.brand_id
          GROUP BY p.brand_id ORDER BY n DESC, p.brand_id LIMIT 1`,
      )
      .get();
    if (row === null) throw new Error("seed has no branded products");
    db.query(
      "UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = (SELECT id FROM products WHERE brand_id = ? ORDER BY id LIMIT 1)",
    ).run(row.brand_id);
    await renderPage();
    const link = screen.getByRole("link", { name: row.name });
    expect(link.parentElement?.textContent).toContain(`${row.n - 1} product`);
  });

  test("no brands: notice with a link", async () => {
    const db = getDatabase();
    db.query("UPDATE products SET brand_id = NULL").run();
    db.query("DELETE FROM brands").run();
    await renderPage();
    expect(screen.getByText("No brands yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse all products" }).getAttribute("href")).toBe("/products");
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.queryAllByTestId("brand-tile")).toHaveLength(0);
  });

  test("metadata: indexable, canonical /brands", () => {
    const md = generateMetadata();
    expect(md.alternates?.canonical).toBe(`${SITE}/brands`);
    expect(md.robots).toBeUndefined();
  });
});

describe("/brands page T177 (U05): one section with a tile grid", () => {
  test("one section labelled by its h2 'All brands'; total count shown; grid 2 / md 3 / lg 4 columns", async () => {
    const { container } = await renderPage();
    const sections = [...container.querySelectorAll("section")];
    expect(sections).toHaveLength(1);
    const section = sections[0]!;
    expect(section.getAttribute("aria-labelledby")).toBe("brands-all");
    const h2s = screen.getAllByRole("heading", { level: 2 });
    expect(h2s.map((h) => h.textContent)).toEqual(["All brands"]);
    expect(section.contains(h2s[0]!)).toBe(true);
    expect(h2s[0]!.id).toBe("brands-all");
    const total = new SqliteBrandRepository(getDatabase()).listWithCounts().length;
    expect(section.textContent).toContain(`${total} brands`);
    const ul = section.querySelector("ul");
    const cls = (ul?.getAttribute("class") ?? "").split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["grid", "grid-cols-2", "md:grid-cols-3", "lg:grid-cols-4"]));
    // No per-letter card sections any more.
    expect(container.querySelectorAll("section .bg-surface-raised section")).toHaveLength(0);
  });

  test("every brand is one white tile (li) with its name link and 'N products', in alphabetical order", async () => {
    await renderPage();
    const tiles = screen.getAllByTestId("brand-tile");
    const brands = new SqliteBrandRepository(getDatabase()).listWithCounts();
    expect(tiles).toHaveLength(brands.length);
    const names: string[] = [];
    for (const tile of tiles) {
      expect(tile.tagName).toBe("LI");
      const cls = tile.getAttribute("class") ?? "";
      expect(cls).toContain("bg-surface-raised");
      expect(cls).toContain("relative");
      const links = tile.querySelectorAll("a");
      expect(links).toHaveLength(1);
      // The link name is the brand alone; the stretched ::after makes the tile clickable.
      expect(links[0]!.className).toContain("after:absolute");
      expect(links[0]!.className).toContain("after:inset-0");
      expect(tile.textContent).toMatch(/\d+ products?$/);
      names.push(links[0]!.textContent ?? "");
    }
    const collator = new Intl.Collator("en", { sensitivity: "base" });
    expect(names).toEqual([...names].sort((a, b) => collator.compare(a, b)));
  });
});
