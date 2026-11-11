// QA (T14): ProductCard + StockBadge adversarial checks against the acceptance criteria.
import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ProductCard, productHref } from "@/components/molecules/ProductCard";
import { StockBadge, getStockStatus, LOW_STOCK_THRESHOLD } from "@/components/molecules/StockBadge";
import type { Product } from "@/lib/types";

const INTERACTIVE = "a, button, input, select, textarea, [tabindex], [href], [contenteditable]";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    slug: "blue-mug",
    name: "Blue Mug",
    description: "A mug.",
    priceCents: 1250,
    currency: "USD",
    imageUrl: "/images/blue-mug.jpg",
    stock: 10,
    ...overrides,
  };
}

function allClasses(root: Element): string[] {
  const out: string[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const cls = el.getAttribute("class");
    if (cls) out.push(...cls.split(/\s+/).filter(Boolean));
  }
  return out;
}

describe("T14.1 single link / no nested interactive elements", () => {
  const cases: Array<[string, Partial<Product>]> = [
    ["default", {}],
    ["300-char name", { name: "N".repeat(150) + " " + "x".repeat(149) }],
    ["emoji slug", { slug: "🍕-pizza ü/../?#" }],
    ['imageUrl ""', { imageUrl: "" }],
    ["stock 0", { stock: 0 }],
    ["stock -1", { stock: -1 }],
    ["stock NaN", { stock: Number.NaN }],
  ];
  for (const [label, overrides] of cases) {
    test(`${label}: exactly one interactive element, and it is the product link`, () => {
      const p = product(overrides);
      const { container } = render(<ProductCard product={p} />);
      const interactive = container.querySelectorAll(INTERACTIVE);
      expect(interactive).toHaveLength(1);
      const links = screen.getAllByRole("link");
      expect(links).toHaveLength(1);
      expect(interactive[0]).toBe(links[0]!);
      expect(links[0]!.getAttribute("href")).toBe(`/products/${encodeURIComponent(p.slug)}`);
      // Accessible name includes the product name.
      expect(links[0]!.textContent).toContain(p.name);
      expect(screen.getByRole("link", { name: new RegExp(p.name.slice(0, 40)) })).toBe(links[0]!);
    });
  }

  test("emoji/reserved-char slug is percent-encoded in href (no raw '/', '?', '#')", () => {
    const slug = "🍕-pizza ü/../?#";
    render(<ProductCard product={product({ slug })} />);
    const href = screen.getByRole("link").getAttribute("href")!;
    expect(href).toBe(`/products/${encodeURIComponent(slug)}`);
    expect(href).toBe(productHref(slug));
    expect(href.slice("/products/".length)).not.toMatch(/[/?#\s]/);
  });

  // T137 (Phase 3): the stretched `after:` overlay is gone; ONE link wraps the image box and the title,
  // so the image and the name are a single target. The article stays `relative` (it anchors the
  // badge/heart/"+ Add" overlay that sits beside the link, never inside it).
  test("one link wraps the image box and the title; article is relative; no after: overlay", () => {
    const { container } = render(<ProductCard product={product()} />);
    const article = container.querySelector("article")!;
    expect(article).toHaveClass("relative");
    const link = screen.getByRole("link");
    const imageBox = container.querySelector('[data-slot="product-card-image"]');
    const heading = screen.getByRole("heading");
    expect(imageBox !== null && link.contains(imageBox)).toBe(true);
    expect(link.contains(heading)).toBe(true);
    expect((link.getAttribute("class") ?? "").split(/\s+/).filter((c) => c.startsWith("after:"))).toEqual([]);
  });

  test("product name is a heading (level 3 by default, configurable)", () => {
    const { rerender } = render(<ProductCard product={product()} />);
    expect(screen.getByRole("heading", { level: 3, name: "Blue Mug" })).toBeInTheDocument();
    rerender(<ProductCard product={product()} headingLevel={2} />);
    expect(screen.getByRole("heading", { level: 2, name: "Blue Mug" })).toBeInTheDocument();
  });
});

describe("T14.2 StockBadge thresholds", () => {
  const table: Array<[number, string, string]> = [
    [0, "Out of stock", "out"],
    [1, "Only 1 left", "low"],
    [2, "Only 2 left", "low"],
    [5, "Only 5 left", "low"],
    [6, "In stock", "in"],
    [1000, "In stock", "in"],
    [-1, "Out of stock", "out"],
    [-999, "Out of stock", "out"],
    [Number.NaN, "Out of stock", "out"],
    [Number.NEGATIVE_INFINITY, "Out of stock", "out"],
  ];
  for (const [stock, label, status] of table) {
    test(`stock ${String(stock)} -> "${label}"`, () => {
      render(<StockBadge stock={stock} />);
      const badge = screen.getByText(label);
      expect(badge).toHaveTextContent(new RegExp(`^${label}$`));
      expect(badge).toHaveAttribute("data-stock-status", status);
      expect(getStockStatus(stock).label).toBe(label);
    });
  }

  test("LOW_STOCK_THRESHOLD is 5", () => {
    expect(LOW_STOCK_THRESHOLD).toBe(5);
  });

  test("ProductCard renders the badge for its stock (0/1/5/6/-1/NaN)", () => {
    const table2: Array<[number, string]> = [
      [0, "Out of stock"],
      [1, "Only 1 left"],
      [5, "Only 5 left"],
      [6, "In stock"],
      [-1, "Out of stock"],
      [Number.NaN, "Out of stock"],
    ];
    for (const [stock, label] of table2) {
      const { unmount } = render(<ProductCard product={product({ stock })} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });

  test("badge meaning is text, not colour only (tone class + visible text)", () => {
    render(<StockBadge stock={0} />);
    const badge = screen.getByText("Out of stock");
    expect(badge).toHaveClass("bg-danger-subtle", "text-danger");
  });

  test("documents behaviour: Infinity and non-integer stock are treated as out of stock", () => {
    expect(getStockStatus(Number.POSITIVE_INFINITY).label).toBe("Out of stock");
    expect(getStockStatus(2.5).label).toBe("Out of stock");
  });
});

describe("T14.3 long names and missing image", () => {
  test("300-char unbroken name: heading clamps and breaks words; card min width 160px (min-w-40, T137 AC6)", () => {
    const name = "Supercalifragilistic".repeat(15); // 300 chars, no spaces
    expect(name).toHaveLength(300);
    const { container } = render(<ProductCard product={product({ name })} />);
    const heading = screen.getByRole("heading");
    expect(heading).toHaveClass("line-clamp-2");
    expect(heading.className).toMatch(/\bbreak-(words|all)\b|\bwrap-break-word\b/);
    // T137 AC6: card min width 160px; the title itself still shrinks (min-w-0) and breaks words.
    expect(container.querySelector("article")).toHaveClass("min-w-40");
    expect(heading).toHaveClass("min-w-0");
    // Full name still in the accessible name (truncation is visual only).
    expect(screen.getByRole("link").textContent).toBe(name);
  });

  // T137: the card image is decorative (alt=""), so the placeholder is aria-hidden and the product
  // name reaches assistive tech once, through the card link.
  test('imageUrl "" renders the placeholder, no <img>, hidden from AT; the link is named by the product', () => {
    const { container } = render(<ProductCard product={product({ imageUrl: "" })} />);
    expect(container.querySelector("img")).toBeNull();
    const placeholder = container.querySelector("[data-placeholder]");
    expect(placeholder).not.toBeNull();
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("link", { name: "Blue Mug" }).getAttribute("href")).toBe("/products/blue-mug");
  });

  test("real imageUrl renders a lazy <img> with responsive sizes", () => {
    const { container } = render(<ProductCard product={product({ imageUrl: "/images/x.jpg" })} />);
    const img = container.querySelector("img")!;
    expect(new URL(img.getAttribute("src")!, "http://localhost:3000/").pathname).toMatch(/\/_next\/image|\/images\/x\.jpg/);
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("sizes");
  });

  for (const imageUrl of ["   ", "\t\n", " \u00a0 "]) {
    test(`whitespace-only imageUrl ${JSON.stringify(imageUrl)} renders the placeholder (no throw, no <img>)`, () => {
      const { container } = render(<ProductCard product={product({ imageUrl })} />);
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("[data-placeholder]")).toHaveAttribute("aria-hidden", "true");
      expect(screen.getByRole("link", { name: "Blue Mug" }).getAttribute("href")).toBe("/products/blue-mug");
      expect(container.querySelectorAll(INTERACTIVE)).toHaveLength(1);
    });
  }

  test("padded imageUrl is trimmed before reaching next/image", () => {
    const { container } = render(<ProductCard product={product({ imageUrl: "  /images/x.jpg  " })} />);
    const img = container.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(decodeURIComponent(img.getAttribute("src")!)).toContain("/images/x.jpg");
    expect(decodeURIComponent(img.getAttribute("src")!)).not.toMatch(/%20|\s\/images/);
  });

  test("priority card loads eagerly", () => {
    const { container } = render(<ProductCard product={product()} priority />);
    expect(container.querySelector("img")).toHaveAttribute("loading", "eager");
  });

  // T137 AC6: fixed aspect box; the image fills it and is letterboxed (object-contain), so it cannot force overflow.
  test("image fills a fixed aspect box (h-full w-full object-contain), so it cannot force overflow", () => {
    const { container } = render(<ProductCard product={product()} />);
    const box = container.querySelector('[data-slot="product-card-image"]');
    expect(box).toHaveClass("aspect-square", "w-full", "overflow-hidden");
    const img = container.querySelector("img");
    expect(img !== null && box !== null && box.contains(img)).toBe(true);
    expect(img).toHaveClass("h-full", "w-full", "object-contain");
  });
});

describe("T14.4 tokens only", () => {
  test("no inline style, no arbitrary values, no palette colours, no raw hex in rendered output", () => {
    const { container } = render(
      <>
        <ProductCard product={product()} />
        <ProductCard product={product({ id: "p2", imageUrl: "", stock: 3 })} />
        <StockBadge stock={0} />
      </>,
    );
    // next/image sets `style="color:transparent"` on <img>; exclude that one framework attribute.
    const styled = [...container.querySelectorAll("[style]")].filter((el) => el.tagName !== "IMG");
    expect(styled).toHaveLength(0);
    const classes = allClasses(container);
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(
      classes.filter((c) =>
        /(^|:)(bg|text|border|ring|fill|stroke)-(gray|slate|zinc|neutral|stone|red|blue|green|yellow|white|black)(-\d+)?$/.test(c),
      ),
    ).toEqual([]);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
