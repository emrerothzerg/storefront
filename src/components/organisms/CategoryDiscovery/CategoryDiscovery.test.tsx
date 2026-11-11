import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { FALLBACK_TILE_ART, getCategoryTileArt } from "@/content/home-art";
import { categoryRailTiles } from "@/components/organisms/CategoryGrid";
import { isAllowedInternalHref } from "@/content/routes";
import type { Category } from "@/lib/types";
import {
  CATEGORY_DISCOVERY_DEFAULT_EYEBROW,
  CATEGORY_DISCOVERY_DEFAULT_ID,
  CATEGORY_DISCOVERY_DEFAULT_TITLE,
  CATEGORY_DISCOVERY_MAX_TILES,
  CategoryDiscovery,
  categoryDiscoveryTiles,
  type CategoryDiscoveryItem,
} from "./index";

const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)>`;

function children(count: number): CategoryDiscoveryItem[] {
  return Array.from({ length: count }, (_, i) => ({ slug: `child-${i + 1}`, name: `Child ${i + 1}` }));
}

const doc = (html: string) => new DOMParser().parseFromString(html, "text/html");

let warn: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

describe("CategoryDiscovery: empty", () => {
  test("no categories, only invalid ones or non-array input render nothing", () => {
    for (const input of [[], null, "x", { slug: "a" }, [null, 1], [{ slug: "", name: "A" }, { slug: "..", name: "B" }, { slug: "a", name: " " }]] as unknown[]) {
      expect(renderToStaticMarkup(<CategoryDiscovery categories={input as readonly CategoryDiscoveryItem[]} />)).toBe("");
    }
  });
});

describe("CategoryDiscovery: section, eyebrow and heading (H-13)", () => {
  test("section #home-discovery labelled by its h2, with an eyebrow above the heading", () => {
    const { container } = render(<CategoryDiscovery categories={children(3)} />);
    const section = container.querySelector("section");
    expect(section?.id).toBe(CATEGORY_DISCOVERY_DEFAULT_ID);
    expect(CATEGORY_DISCOVERY_DEFAULT_ID).toBe("home-discovery");
    const heading = screen.getByRole("heading", { level: 2, name: CATEGORY_DISCOVERY_DEFAULT_TITLE });
    expect(section?.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.id).toBe("home-discovery-heading");
    const eyebrow = container.querySelector("[data-eyebrow]");
    expect(eyebrow?.textContent).toBe(CATEGORY_DISCOVERY_DEFAULT_EYEBROW);
    expect(eyebrow?.tagName).toBe("P");
    // Eyebrow precedes the heading in reading order.
    expect(eyebrow && eyebrow.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("custom title, eyebrow and id; blank eyebrow hidden; blank title falls back", () => {
    const { rerender, container } = render(
      <CategoryDiscovery categories={children(2)} title="Explore Home & Kitchen" eyebrow="Fresh ideas" id="disc" />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Explore Home & Kitchen" }).id).toBe("disc-heading");
    expect(container.querySelector("[data-eyebrow]")?.textContent).toBe("Fresh ideas");

    rerender(<CategoryDiscovery categories={children(2)} title="  " eyebrow="  " />);
    expect(screen.getByRole("heading", { level: 2, name: CATEGORY_DISCOVERY_DEFAULT_TITLE })).toBeInTheDocument();
    expect(container.querySelector("[data-eyebrow]")).toBeNull();
  });

  test("tiles contain no headings; exactly one heading", () => {
    const { container } = render(<CategoryDiscovery categories={children(6)} />);
    expect(container.querySelectorAll("h1,h2,h3,h4,h5,h6")).toHaveLength(1);
    for (const a of container.querySelectorAll("a")) expect(a.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
  });

  test("rail is a focusable named scroll region; arrow buttons hidden without JS", () => {
    const d = doc(renderToStaticMarkup(<CategoryDiscovery categories={children(6)} />));
    const scroller = d.querySelector("#home-discovery [role='region']");
    expect(scroller?.getAttribute("tabindex")).toBe("0");
    expect(scroller?.getAttribute("aria-label")).toBe(`${CATEGORY_DISCOVERY_DEFAULT_TITLE}, category list`);
    for (const button of d.querySelectorAll("button")) expect(button.hasAttribute("hidden")).toBe(true);
  });
});

describe("CategoryDiscovery: tiles", () => {
  test("up to 6 card tiles in input order, each ONE link to /category/<slug> named by the caption", () => {
    const { container } = render(<CategoryDiscovery categories={children(9)} />);
    const section = container.querySelector("section") as HTMLElement;
    const links = within(section).getAllByRole("link");
    expect(links).toHaveLength(CATEGORY_DISCOVERY_MAX_TILES);
    expect(CATEGORY_DISCOVERY_MAX_TILES).toBe(6);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(children(6).map((c) => `/category/${c.slug}`));
    for (const [i, link] of links.entries()) {
      expect(link.getAttribute("data-shape")).toBe("card");
      expect(link.textContent).toBe(`Child ${i + 1}`);
    }
    expect(within(section).getByRole("link", { name: "Child 1" })).toBeInTheDocument();
    expect(within(section).getAllByRole("listitem")).toHaveLength(6);
  });

  test("art via getCategoryTileArt(slug), stable per slug (T179 U13); images decorative", () => {
    const tiles = categoryDiscoveryTiles([{ slug: "..", name: "Skipped" }, ...children(6)]);
    expect(tiles.map((t) => t.imageSrc)).toEqual(tiles.map((t) => getCategoryTileArt(t.slug).path));
    for (const t of tiles) expect(t.imageSrc).not.toBe(FALLBACK_TILE_ART.path);
    // Position does not change a category's art.
    const reversed = categoryDiscoveryTiles([...children(6)].reverse());
    for (const t of reversed) expect(t.imageSrc).toBe(getCategoryTileArt(t.slug).path);
    const { container } = render(<CategoryDiscovery categories={children(6)} />);
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs).toHaveLength(6);
    for (const img of imgs) expect(img.getAttribute("alt")).toBe("");
  });

  test("invalid and duplicate entries are dropped before the cap; slugs encoded", () => {
    const input: CategoryDiscoveryItem[] = [
      { slug: "a/b", name: "Slash" },
      { slug: "child-1", name: "Child 1" },
      { slug: "child-1", name: "Duplicate" },
      { slug: "javascript:alert(1)", name: "JS" },
      { slug: "électronique", name: "Encoded" },
      ...children(8).slice(1),
    ];
    const tiles = categoryDiscoveryTiles(input);
    expect(tiles).toHaveLength(6);
    expect(tiles.map((t) => t.href)).toEqual([
      "/category/child-1",
      "/category/%C3%A9lectronique",
      "/category/child-2",
      "/category/child-3",
      "/category/child-4",
      "/category/child-5",
    ]);
  });

  test("Category rows can be passed directly", () => {
    const row: Category = {
      id: "c1",
      slug: "cookware",
      name: "Cookware",
      description: "",
      parentId: "p1",
      sortOrder: 0,
      imageUrl: null,
    };
    expect(categoryDiscoveryTiles([row])[0]?.href).toBe("/category/cookware");
  });
});

describe("CategoryDiscovery: hostile input and markup", () => {
  test("hostile names, title and eyebrow render as text", () => {
    const html = renderToStaticMarkup(
      <CategoryDiscovery categories={[{ slug: "x", name: HOSTILE }]} title={HOSTILE} eyebrow={HOSTILE} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    const d = doc(html);
    expect(d.querySelector("script, img[src=x]")).toBeNull();
    expect(d.body.textContent).toContain(HOSTILE);
  });

  test("every rendered href passes the allow-list; inline style only on images", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const d = doc(
      renderToStaticMarkup(
        <CategoryDiscovery categories={[{ slug: "//evil.example", name: "E" }, { slug: "%2e%2e", name: "Enc" }, ...children(3)]} />,
      ),
    );
    const hrefs = [...d.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(isAllowedInternalHref(href)).toBe(true);
      expect(href).not.toBe("#");
    }
    for (const el of d.querySelectorAll("[style]")) expect(el.tagName).toBe("IMG");
  });

  test("no use client directive; no inline style or arbitrary sizes in source", () => {
    const src = readFileSync(join(import.meta.dir, "CategoryDiscovery.tsx"), "utf8");
    expect(src.startsWith('"use client"')).toBe(false);
    expect(src).not.toMatch(/\bstyle=\{/);
    expect(src).not.toMatch(/\[[0-9]+px\]/);
  });
});

describe("CategoryDiscovery art matches the department page (T179 U13)", () => {
  test("a leaf category gets identical art here and in CategoryRail", () => {
    const leaves = [
      { slug: "cookware-dining", name: "Cookware & Dining" },
      { slug: "coffee-tea", name: "Coffee & Tea" },
      { slug: "books", name: "Books" },
    ];
    const home = categoryDiscoveryTiles(leaves).map((t) => [t.slug, t.imageSrc]);
    const dept = categoryRailTiles([...leaves].reverse()).map((t) => [t.slug, t.imageSrc]);
    expect(Object.fromEntries(home)).toEqual(Object.fromEntries(dept));
  });
});
