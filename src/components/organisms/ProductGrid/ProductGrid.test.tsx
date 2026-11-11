import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import type { Product } from "@/lib/types";
import { ProductGrid } from "./ProductGrid";

function makeProduct(n: number): Product {
  return {
    id: `p${n}`,
    slug: `product-${n}`,
    name: `Product ${n}`,
    description: "",
    priceCents: 1000 + n,
    currency: "USD",
    imageUrl: `/images/p${n}.jpg`,
    stock: 10,
  };
}

function nth<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`missing element ${index}`);
  return value;
}

const products = Array.from({ length: 6 }, (_, i) => makeProduct(i + 1));

describe("ProductGrid", () => {
  test("empty products render an empty state (not a blank area) and no list", () => {
    const { container } = render(<ProductGrid products={[]} />);
    expect(screen.getByRole("heading", { level: 2, name: "No products yet" })).toBeInTheDocument();
    expect(screen.getByText(/new products are on their way/)).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    expect(container.querySelector("ul")).toBeNull();
    expect(container.textContent?.trim()).not.toBe("");
  });

  test("custom emptyMessage is shown", () => {
    render(<ProductGrid products={[]} emptyMessage="Nothing matches your filters." />);
    expect(screen.getByText("Nothing matches your filters.")).toBeInTheDocument();
  });

  test("renders a semantic list with one listitem per product, each containing a card link", () => {
    render(<ProductGrid products={products} />);
    const list = screen.getByRole("list");
    expect(list.tagName).toBe("UL");
    expect(list).toHaveAttribute("role", "list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(6);
    expect(within(nth(items, 0)).getByRole("link", { name: "Product 1" })).toHaveAttribute(
      "href",
      "/products/product-1",
    );
  });

  test("responsive grid classes: 2 columns down to 320px (T156), then 3/4; children can shrink", () => {
    render(<ProductGrid products={products} />);
    const list = screen.getByRole("list");
    expect(list).toHaveClass(
      "grid",
      "grid-cols-2",
      "md:grid-cols-3",
      "lg:grid-cols-4",
      "gap-x-2",
      "lg:gap-6",
      "min-w-0",
    );
    expect(list).not.toHaveClass("grid-cols-1");
    for (const li of within(list).getAllByRole("listitem")) {
      expect(li).toHaveClass("min-w-0");
    }
  });

  test("first priorityCount (default 4) images load eagerly, the rest lazily", () => {
    const { container } = render(<ProductGrid products={products} />);
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs).toHaveLength(6);
    expect(imgs.slice(0, 4).every((img) => img.getAttribute("loading") !== "lazy")).toBe(true);
    expect(imgs.slice(4).every((img) => img.getAttribute("loading") === "lazy")).toBe(true);
  });

  test("priorityCount is configurable", () => {
    const { container } = render(<ProductGrid products={products} priorityCount={1} />);
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(nth(imgs, 0).getAttribute("loading")).not.toBe("lazy");
    expect(nth(imgs, 1).getAttribute("loading")).toBe("lazy");
  });

  test("headingLevel defaults to 3 and is passed to cards", () => {
    const { unmount } = render(<ProductGrid products={products.slice(0, 2)} />);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
    unmount();
    render(<ProductGrid products={products.slice(0, 2)} headingLevel={2} />);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });
});
