import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CategoryWithCount } from "@/lib/types";
import { isAllowedInternalHref } from "@/content/routes";
import {
  CategoryTile,
  categoryHref,
  categoryTileLabel,
  formatProductCount,
  normaliseProductCount,
} from "./CategoryTile";

const FOCUSABLE =
  "a[href], button, input, select, textarea, summary, iframe, [tabindex]:not([tabindex='-1']), [contenteditable='true']";

const full: CategoryWithCount = {
  id: "c_1",
  slug: "home-kitchen",
  name: "Home & Kitchen",
  description: "Everything for the home.",
  parentId: null,
  sortOrder: 1,
  imageUrl: "/images/categories/home-kitchen.svg",
  productCount: 12,
};

let originalWarn: typeof console.warn;
let warn: ReturnType<typeof mock>;
beforeEach(() => {
  originalWarn = console.warn;
  warn = mock(() => {});
  console.warn = warn;
});
afterEach(() => {
  console.warn = originalWarn;
});

describe("CategoryTile", () => {
  test("accepts a CategoryWithCount and renders ONE link to /category/<slug>", () => {
    const { container } = render(<CategoryTile category={full} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/category/home-kitchen");
    expect(container.querySelectorAll(FOCUSABLE)).toHaveLength(1);
    // The link IS the tile (no wrapper around it).
    expect(container.firstElementChild).toBe(links[0] ?? null);
  });

  test('accessible name is "Name, N products"', () => {
    render(<CategoryTile category={full} />);
    expect(screen.getByRole("link", { name: "Home & Kitchen, 12 products" })).toBeInTheDocument();
  });

  test("singular: 1 product", () => {
    render(<CategoryTile category={{ ...full, productCount: 1 }} />);
    expect(screen.getByRole("link", { name: "Home & Kitchen, 1 product" })).toBeInTheDocument();
    expect(screen.getByText("1 product")).toBeInTheDocument();
  });

  test("large counts are grouped en-US", () => {
    render(<CategoryTile category={{ ...full, productCount: 1234 }} />);
    expect(screen.getByRole("link", { name: "Home & Kitchen, 1,234 products" })).toBeInTheDocument();
  });

  test.each([0, undefined, -3, Number.NaN, Number.POSITIVE_INFINITY])(
    "count %p hides the count (name only)",
    (productCount) => {
      const { container } = render(
        <CategoryTile category={{ slug: "toys", name: "Toys", productCount }} />,
      );
      expect(screen.getByRole("link", { name: "Toys" })).toBeInTheDocument();
      expect(container.textContent).toBe("Toys");
      expect(container.textContent).not.toMatch(/product/);
    },
  );

  test("name and count text are visible", () => {
    render(<CategoryTile category={full} />);
    expect(screen.getByText("Home & Kitchen")).toBeInTheDocument();
    expect(screen.getByText("12 products")).toHaveClass("text-text-secondary", "text-small");
  });

  test("renders a decorative image when imageUrl is set (no icon)", () => {
    const { container } = render(<CategoryTile category={full} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("alt", "");
    expect(container.querySelector("[data-icon-fallback]")).toBeNull();
    // Only the link is exposed: the image adds nothing to the name.
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  test.each([null, undefined, "", "   "])("imageUrl %p falls back to the icon (default grid)", (imageUrl) => {
    const { container } = render(
      <CategoryTile category={{ slug: "toys", name: "Toys", imageUrl, productCount: 2 }} />,
    );
    expect(container.querySelector("img")).toBeNull();
    const fallback = container.querySelector("[data-icon-fallback]");
    expect(fallback).not.toBeNull();
    expect(fallback).toHaveClass("bg-accent-subtle", "text-accent");
    const svg = fallback?.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  test("custom icon prop changes the fallback icon", () => {
    const grid = render(<CategoryTile category={{ slug: "a", name: "A" }} />);
    const gridPaths = grid.container.querySelector("svg")?.innerHTML;
    grid.unmount();
    const gift = render(<CategoryTile category={{ slug: "a", name: "A" }} icon="gift" />);
    expect(gift.container.querySelector("svg")?.innerHTML).not.toBe(gridPaths);
  });

  test("tile surface, hover and touch target use tokens", () => {
    render(<CategoryTile category={full} className="mt-2" />);
    const link = screen.getByRole("link");
    expect(link).toHaveClass(
      "bg-surface-raised",
      "border",
      "border-border-default",
      "rounded-lg",
      "shadow-sm",
      "hover:border-border-strong",
      "min-h-touch",
      "w-full",
    );
    expect(link.className.endsWith("mt-2")).toBe(true);
  });

  test("size sm renders a compact row with a 48px thumbnail; md stacks", () => {
    const sm = render(<CategoryTile category={{ slug: "a", name: "A" }} size="sm" />);
    expect(sm.container.querySelector("[data-icon-fallback]")).toHaveClass("size-12", "shrink-0");
    expect(sm.container.querySelector("a > span")).toHaveClass("items-center");
    expect(sm.container.querySelector("a > span")).not.toHaveClass("flex-col");
    sm.unmount();
    const md = render(<CategoryTile category={{ slug: "a", name: "A" }} />);
    expect(md.container.querySelector("a > span")).toHaveClass("flex-col");
    expect(md.container.querySelector("[data-icon-fallback]")).toHaveClass("aspect-square", "w-full");
  });

  test("long names wrap instead of overflowing at 320px", () => {
    const long = "Supercalifragilisticexpialidocious".repeat(6);
    render(<CategoryTile category={{ slug: "a", name: long, productCount: 3 }} />);
    expect(screen.getByText(long)).toHaveClass("break-words");
    expect(screen.getByRole("link").querySelector("span")).toHaveClass("min-w-0");
  });

  test("hostile names render as text, never markup", () => {
    const hostile = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
    const { container } = render(<CategoryTile category={{ slug: "a", name: hostile, productCount: 2 }} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(hostile)).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("aria-label", `${hostile}, 2 products`);
  });

  test("slug is URL-encoded and the default href passes the route allowlist", () => {
    expect(isAllowedInternalHref(categoryHref("home-kitchen"))).toBe(true);
    render(<CategoryTile category={{ slug: "a b", name: "A" }} />);
    const href = screen.getByRole("link").getAttribute("href") ?? "";
    expect(href).toBe("/category/a%20b");
    expect(isAllowedInternalHref(href)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  test("a custom allowed href is kept", () => {
    render(<CategoryTile category={full} href="/deals?category=home-kitchen" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/deals?category=home-kitchen");
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(["javascript:alert(1)", "//evil.example/x", "https://evil.example", "/not-a-route", "/category/.."])(
    "disallowed href %p renders # with a dev warning",
    (href) => {
      render(<CategoryTile category={full} href={href} />);
      expect(screen.getByRole("link")).toHaveAttribute("href", "#");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("CategoryTile");
    },
  );

  test("dot-segment slugs fall back to #", () => {
    render(<CategoryTile category={{ slug: "..", name: "Up" }} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "#");
  });

  test("renderToStaticMarkup works (server-safe)", () => {
    const html = renderToStaticMarkup(<CategoryTile category={full} />);
    expect(html).toContain('href="/category/home-kitchen"');
    expect(html).toContain('aria-label="Home &amp; Kitchen, 12 products"');
    expect(html).toContain("12 products");
    const fallback = renderToStaticMarkup(<CategoryTile category={{ slug: "x", name: "<b>X</b>" }} />);
    expect(fallback).toContain("&lt;b&gt;X&lt;/b&gt;");
    expect(fallback).not.toContain("<b>");
  });
});

describe("CategoryTile helpers", () => {
  test("normaliseProductCount", () => {
    expect(normaliseProductCount(undefined)).toBe(0);
    expect(normaliseProductCount(-1)).toBe(0);
    expect(normaliseProductCount(Number.NaN)).toBe(0);
    expect(normaliseProductCount(2.9)).toBe(2);
    expect(normaliseProductCount(7)).toBe(7);
  });

  test("formatProductCount / categoryTileLabel", () => {
    expect(formatProductCount(1)).toBe("1 product");
    expect(formatProductCount(2)).toBe("2 products");
    expect(categoryTileLabel("Toys", 0)).toBe("Toys");
    expect(categoryTileLabel("Toys", 5)).toBe("Toys, 5 products");
  });
});
