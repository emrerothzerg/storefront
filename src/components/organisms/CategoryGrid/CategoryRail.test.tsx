// Moved from CategoryGrid.test.tsx (T152): every former case is kept, updated for the rail.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DISCOVERY_TILE_ART, FALLBACK_TILE_ART, getCategoryTileArt, getDepartmentTileArt } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";
import type { CategoryWithCount } from "@/lib/types";
import * as folder from "./index";
import {
  CATEGORY_RAIL_ALL_HREF,
  CATEGORY_RAIL_ALL_LABEL,
  CATEGORY_RAIL_DEFAULT_TITLE,
  CATEGORY_RAIL_MAX_TILES,
  CategoryRail,
  categoryRailHref,
  categoryRailTiles,
  type CategoryRailItem,
} from "./index";

const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)>`;

const categories: CategoryRailItem[] = [
  { slug: "electronics", name: "Electronics", productCount: 42 },
  { slug: "home-kitchen", name: "Home & Kitchen", image: "/images/home.jpg", productCount: 1 },
  { slug: "books", name: "Books" },
];

function departments(count: number): CategoryRailItem[] {
  return Array.from({ length: count }, (_, i) => ({ slug: `dept-${i + 1}`, name: `Department ${i + 1}` }));
}

let warn: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

describe("CategoryRail: empty (T152 criterion 2)", () => {
  test("empty array returns null (no empty heading)", () => {
    expect(renderToStaticMarkup(<CategoryRail categories={[]} />)).toBe("");
  });

  test("only invalid entries returns null", () => {
    const bad: CategoryRailItem[] = [
      { slug: "", name: "Blank slug" },
      { slug: "x", name: "   " },
      { slug: "../admin", name: "Traversal" },
      { slug: "a/b", name: "Slash" },
      { slug: "..", name: "Dots" },
    ];
    expect(renderToStaticMarkup(<CategoryRail categories={bad} />)).toBe("");
  });

  test("non-array input and non-object entries never throw", () => {
    for (const input of [null, undefined, "kitchen", { slug: "a" }, [null, 3, "x"]] as unknown[]) {
      expect(renderToStaticMarkup(<CategoryRail categories={input as readonly CategoryRailItem[]} />)).toBe("");
    }
  });
});

describe("CategoryRail: links and order (T152 criterion 1)", () => {
  test("one circular tile per department, in data order, linking /category/<slug>; link name = department name", () => {
    render(<CategoryRail categories={categories} />);
    const region = screen.getByRole("region", { name: CATEGORY_RAIL_DEFAULT_TITLE });
    const links = within(region).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/category/electronics",
      "/category/home-kitchen",
      "/category/books",
    ]);
    for (const link of links) {
      expect(isAllowedInternalHref(link.getAttribute("href") ?? "")).toBe(true);
      expect(link.getAttribute("data-shape")).toBe("circle");
    }
    expect(within(region).getByRole("link", { name: "Electronics" })).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: "Home & Kitchen" })).toBeInTheDocument();
  });

  test("department art via getCategoryTileArt(slug); images decorative (alt='')", () => {
    const { container } = render(<CategoryRail categories={categories} />);
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs).toHaveLength(3);
    for (const img of imgs) expect(img.getAttribute("alt")).toBe("");
    const tiles = categoryRailTiles(categories);
    expect(tiles.map((t) => t.imageSrc)).toEqual([
      getDepartmentTileArt("electronics").path,
      getDepartmentTileArt("home-kitchen").path,
      getDepartmentTileArt("books").path,
    ]);
    // Data images are ignored in favour of the placeholder art set.
    expect(tiles[1]?.imageSrc).not.toBe("/images/home.jpg");
    // T179 U13: non-department slugs get their per-category art (getCategoryTileArt), not the bag.
    expect(categoryRailTiles([{ slug: "unknown-dept", name: "Unknown" }])[0]?.imageSrc).toBe(
      getCategoryTileArt("unknown-dept").path,
    );
  });

  test("T179 U13: leaf category tiles use per-category art (same as getCategoryTileArt), not one shared fallback", () => {
    const leaves = [
      { slug: "cookware-dining", name: "Cookware & Dining" },
      { slug: "coffee-tea", name: "Coffee & Tea" },
      { slug: "bedding-bath", name: "Bedding & Bath" },
      { slug: "storage-organization", name: "Storage & Organization" },
    ];
    const tiles = categoryRailTiles(leaves);
    expect(tiles.map((t) => t.imageSrc)).toEqual(leaves.map((l) => getCategoryTileArt(l.slug).path));
    const discovery = new Set(DISCOVERY_TILE_ART.map((a) => a.path));
    for (const t of tiles) {
      expect(t.imageSrc).not.toBe(FALLBACK_TILE_ART.path);
      expect(discovery.has(t.imageSrc)).toBe(true);
    }
    // Stable per slug: the same category gets the same art at any position.
    expect(categoryRailTiles([
        { slug: "bedding-bath", name: "Bedding & Bath" },
        { slug: "cookware-dining", name: "Cookware & Dining" },
      ]).map((t) => t.imageSrc)).toEqual([
      getCategoryTileArt("bedding-bath").path,
      getCategoryTileArt("cookware-dining").path,
    ]);
    // Departments keep their department art.
    expect(categoryRailTiles([{ slug: "books", name: "Books" }])[0]?.imageSrc).toBe(getDepartmentTileArt("books").path);
  });

  test("slugs are encoded; unsafe slugs are dropped; duplicates render once", () => {
    const tiles = categoryRailTiles([
      { slug: "électronique", name: "Encoded" },
      { slug: "a/b", name: "Slash" },
      { slug: "electronics", name: "Electronics" },
      { slug: "electronics", name: "Electronics again" },
      { slug: "javascript:alert(1)", name: "JS" },
    ]);
    expect(tiles.map((t) => t.href)).toEqual(["/category/%C3%A9lectronique", "/category/electronics"]);
    expect(categoryRailHref("a?b#c")).toBe("/category/a%3Fb%23c");
  });

  test("CategoryWithCount rows can be passed directly", () => {
    const row: CategoryWithCount = {
      id: "c1",
      slug: "toys",
      name: "Toys",
      description: "",
      parentId: null,
      sortOrder: 0,
      imageUrl: "/images/toys.jpg",
      productCount: 3,
    };
    const tiles = categoryRailTiles([row]);
    expect(tiles[0]?.href).toBe("/category/toys");
    expect(tiles[0]?.name).toBe("Toys");
  });

  test("exactly 12 departments: 12 tiles, no 'All departments' tile", () => {
    render(<CategoryRail categories={departments(CATEGORY_RAIL_MAX_TILES)} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(12);
    expect(screen.queryByRole("link", { name: CATEGORY_RAIL_ALL_LABEL })).toBeNull();
  });

  test("more than 12: first 12 in order + trailing 'All departments' tile linking /products (ruling O-3)", () => {
    render(<CategoryRail categories={departments(15)} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(13);
    expect(links.slice(0, 12).map((a) => a.getAttribute("href"))).toEqual(
      departments(12).map((d) => `/category/${d.slug}`),
    );
    const last = links[12];
    expect(last?.textContent).toBe(CATEGORY_RAIL_ALL_LABEL);
    expect(last?.getAttribute("href")).toBe(CATEGORY_RAIL_ALL_HREF);
    expect(CATEGORY_RAIL_ALL_HREF).toBe("/products");
    expect(isAllowedInternalHref(CATEGORY_RAIL_ALL_HREF)).toBe(true);
    expect(screen.queryByRole("link", { name: "Department 13" })).toBeNull();
  });

  test("the cap counts valid tiles only (invalid entries do not trigger the overflow tile)", () => {
    const input = [...departments(12), { slug: "..", name: "Dots" }, { slug: "dept-1", name: "Dup" }];
    render(<CategoryRail categories={input} />);
    expect(screen.getAllByRole("link")).toHaveLength(12);
    expect(screen.queryByRole("link", { name: CATEGORY_RAIL_ALL_LABEL })).toBeNull();
  });
});

describe("CategoryRail: structure (T152 criterion 3)", () => {
  test("section labelled by its h2; custom title and level", () => {
    const { rerender } = render(<CategoryRail categories={categories} id="cats" />);
    const section = document.getElementById("cats");
    expect(section?.tagName).toBe("SECTION");
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.id).toBe("cats-heading");
    expect(section?.getAttribute("aria-labelledby")).toBe("cats-heading");
    expect(within(section as HTMLElement).getAllByRole("listitem")).toHaveLength(3);

    rerender(<CategoryRail categories={categories} title="Departments" headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Departments" })).toBeInTheDocument();
  });

  test("tiles contain no headings; exactly one heading in the section", () => {
    const { container } = render(<CategoryRail categories={departments(14)} />);
    expect(container.querySelectorAll("h1,h2,h3,h4,h5,h6")).toHaveLength(1);
    for (const a of container.querySelectorAll("a")) expect(a.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
  });

  test("blank title falls back to the default", () => {
    render(<CategoryRail categories={categories} title="   " />);
    expect(screen.getByRole("heading", { level: 2, name: CATEGORY_RAIL_DEFAULT_TITLE })).toBeInTheDocument();
  });

  test("rail is a keyboard-focusable named scroll region (H-7); no arrow buttons without JS", () => {
    const html = renderToStaticMarkup(<CategoryRail categories={categories} id="home-categories" />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const scroller = doc.querySelector("#home-categories [role='region']");
    expect(scroller?.getAttribute("tabindex")).toBe("0");
    expect(scroller?.getAttribute("aria-label")).toBe(`${CATEGORY_RAIL_DEFAULT_TITLE}, category list`);
    for (const button of doc.querySelectorAll("button")) expect(button.hasAttribute("hidden")).toBe(true);
  });

  test("two rails on one page get distinct heading ids", () => {
    render(
      <>
        <CategoryRail categories={categories} title="A" />
        <CategoryRail categories={categories} title="B" />
      </>,
    );
    const a = screen.getByRole("heading", { name: "A" });
    const b = screen.getByRole("heading", { name: "B" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("CategoryRail: hostile text and markup", () => {
  test("hostile names and title render as text", () => {
    const html = renderToStaticMarkup(<CategoryRail categories={[{ slug: "x", name: HOSTILE }]} title={HOSTILE} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  test("no script tags; inline style only on images", () => {
    const html = renderToStaticMarkup(<CategoryRail categories={[{ slug: "books", name: "Books" }]} />);
    expect(html).not.toContain("<script");
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const el of doc.querySelectorAll("[style]")) expect(el.tagName).toBe("IMG");
  });

  test("every rendered href passes the allow-list, including with hostile slugs", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const html = renderToStaticMarkup(
      <CategoryRail categories={[...departments(13), { slug: "javascript:alert(1)", name: "JS" }, { slug: "//evil", name: "E" }]} />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const hrefs = [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toHaveLength(13);
    for (const href of hrefs) expect(isAllowedInternalHref(href)).toBe(true);
  });

  test("no use client directive; no arbitrary or raw widths in source", () => {
    const src = readFileSync(join(import.meta.dir, "CategoryRail.tsx"), "utf8");
    expect(src.startsWith('"use client"')).toBe(false);
    expect(src).not.toMatch(/\bstyle=\{/);
    expect(src).not.toMatch(/\[[0-9]+px\]/);
  });
});

describe("CategoryGrid alias removed (cj)", () => {
  test("the folder no longer exports CategoryGrid, categoryGridTiles or CATEGORY_GRID_DEFAULT_TITLE; the alias module is gone", () => {
    const exported: Record<string, unknown> = { ...folder };
    for (const name of ["CategoryGrid", "categoryGridTiles", "CATEGORY_GRID_DEFAULT_TITLE"]) expect(exported[name]).toBeUndefined();
    expect(exported.CategoryRail).toBe(CategoryRail);
    expect(existsSync(join(import.meta.dir, "CategoryGrid.tsx"))).toBe(false);
  });
});
