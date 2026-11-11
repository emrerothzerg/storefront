import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import type { Product } from "@/lib/types";
import { PRODUCT_CARD_IMAGE_SIZES, ProductCard } from "./ProductCard";

const base: Product = {
  id: "p_1",
  slug: "canvas-tote-bag",
  name: "Canvas Tote Bag",
  description: "A sturdy tote.",
  priceCents: 2400,
  currency: "USD",
  imageUrl: "/images/products/canvas-tote-bag.svg",
  stock: 12,
};

function make(overrides: Partial<Product> = {}): Product {
  return { ...base, ...overrides };
}

const FOCUSABLE =
  "a[href], button, input, select, textarea, summary, iframe, [tabindex]:not([tabindex='-1']), [contenteditable='true']";

describe("ProductCard", () => {
  test("renders an <article> with exactly one link to the product page", () => {
    const { container } = render(<ProductCard product={make()} />);
    const article = container.querySelector("article");
    expect(article).not.toBeNull();
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/products/canvas-tote-bag");
  });

  test("link accessible name includes the product name", () => {
    render(<ProductCard product={make()} />);
    expect(screen.getByRole("link", { name: /Canvas Tote Bag/ })).toBeInTheDocument();
  });

  test("has a single tab stop and no nested interactive elements", () => {
    const { container } = render(<ProductCard product={make()} />);
    const focusables = container.querySelectorAll(FOCUSABLE);
    expect(focusables).toHaveLength(1);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    const link = screen.getByRole("link");
    expect(link.querySelectorAll(FOCUSABLE)).toHaveLength(0);
  });

  // T137 (pin changed): the stretched `after:absolute` name link is replaced by ONE link that
  // wraps the image box and the name heading, so image and title are the same click target.
  test("one link wraps the image and the name, so image and title are one click target", () => {
    const { container } = render(<ProductCard product={make()} />);
    expect(container.querySelector("article")).toHaveClass("relative");
    const link = screen.getByRole("link");
    expect(link.querySelector("img")).not.toBeNull();
    expect(link.querySelector("h3")).toHaveTextContent("Canvas Tote Bag");
  });

  test("slug is URL-encoded in the href", () => {
    render(<ProductCard product={make({ slug: "a b/c?d" })} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/products/a%20b%2Fc%3Fd");
  });

  // T137 (pin changed): the heading now sits inside the link (it used to contain it).
  test("product name is a heading inside the product link", () => {
    render(<ProductCard product={make()} />);
    const heading = screen.getByRole("heading", { level: 3, name: "Canvas Tote Bag" });
    expect(screen.getByRole("link").contains(heading)).toBe(true);
    expect(within(screen.getByRole("link")).getByRole("heading")).toBe(heading);
  });

  test("headingLevel changes the heading element", () => {
    render(<ProductCard product={make()} headingLevel={2} />);
    expect(screen.getByRole("heading", { level: 2 })).toBeInTheDocument();
  });

  test("very long names clamp to two lines and break long words", () => {
    const longName = `${"Supercalifragilisticexpialidocious".repeat(8)} ${"Extra long product name ".repeat(20)}`;
    render(<ProductCard product={make({ name: longName })} />);
    const heading = screen.getByRole("heading");
    expect(heading).toHaveClass("line-clamp-2", "break-words");
    expect(screen.getByRole("link")).toHaveTextContent(longName.trim());
    // T137 (pin changed: min-w-0 -> min-w-40): the card keeps a 160px minimum width.
    expect(heading.closest("article")).toHaveClass("min-w-40");
  });

  // T137 (pin changed): the image is decorative (alt="") because the same link carries the
  // name as text; it used to repeat the name, giving the link the name twice.
  test("renders a decorative 600x600 image, lazy by default, in a fixed-aspect box", () => {
    const { container } = render(<ProductCard product={make()} />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("alt", "");
    expect(img.closest('[data-slot="product-card-image"]')).toHaveClass("aspect-square", "overflow-hidden");
    expect(img).toHaveAttribute("width", "600");
    expect(img).toHaveAttribute("height", "600");
    expect(img).toHaveAttribute("loading", "lazy");
  });

  test("passes grid `sizes` to optimisable (raster) images", () => {
    // next/image serves SVGs unoptimised and drops `sizes` (no srcset), so use a raster URL.
    const { container } = render(<ProductCard product={make({ imageUrl: "/images/products/photo.jpg" })} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("sizes")).toBe(PRODUCT_CARD_IMAGE_SIZES);
    expect(img.getAttribute("srcset")).toContain("w=");
  });

  test("priority loads the image eagerly", () => {
    const { container } = render(<ProductCard product={make()} priority />);
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("loading", "eager");
    expect(img).toHaveAttribute("fetchpriority", "high");
  });

  // T137 (pin changed): the placeholder is decorative like the image (aria-hidden, no label).
  test("missing image renders the decorative Image placeholder", () => {
    const { container } = render(<ProductCard product={make({ imageUrl: "" })} />);
    const placeholder = container.querySelector("[data-placeholder]");
    expect(placeholder).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("link")).toHaveAccessibleName("Canvas Tote Bag");
    expect(container.querySelector("img")).toBeNull();
  });

  test("renders the formatted price", () => {
    render(<ProductCard product={make({ priceCents: 2400, currency: "USD" })} />);
    expect(screen.getByText("$24.00")).toBeInTheDocument();
  });

  test.each([
    [0, "Out of stock"],
    [-2, "Out of stock"],
    [3, "Only 3 left"],
    [5, "Only 5 left"],
    [6, "In stock"],
  ])("stock %p shows %p", (stock, label) => {
    render(<ProductCard product={make({ stock })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  test("card surface uses token utilities", () => {
    const { container } = render(<ProductCard product={make()} />);
    expect(container.querySelector("article")).toHaveClass(
      "bg-surface-raised",
      "border-border-default",
      "rounded-lg",
      "shadow-sm",
      // T137 (pin changed: p-4 -> p-3, the Card atom's `sm` padding).
      "p-3",
      "gap-2",
    );
  });
});
