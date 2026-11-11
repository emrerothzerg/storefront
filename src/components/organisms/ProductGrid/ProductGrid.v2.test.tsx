import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CartActionFn } from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import type { Product } from "@/lib/types";
import type { ProductListItem } from "@/server/catalog/listing-service";
import { ProductGrid } from "./ProductGrid";

function makeProduct(n: number, overrides: Partial<Product> = {}): Product {
  return {
    id: `p${n}`,
    slug: `product-${n}`,
    name: `Product ${n}`,
    description: `Description for product ${n}. `.repeat(12),
    priceCents: 1000 + n,
    currency: "USD",
    imageUrl: `/images/p${n}.jpg`,
    stock: 10,
    ...overrides,
  };
}

const products = Array.from({ length: 3 }, (_, i) => makeProduct(i + 1));
const addToCart: CartActionFn = async () => null;
const listAction: ListActionFn = async () => null;

describe("ProductGrid v2", () => {
  test("layout=list renders a single-column <ul role=list> of list cards", () => {
    const { container } = render(<ProductGrid products={products} layout="list" />);
    const list = container.querySelector("ul[data-layout]")!;
    expect(list).toHaveAttribute("role", "list");
    expect(list).toHaveAttribute("data-layout", "list");
    expect(list).toHaveClass("flex", "flex-col", "min-w-0");
    expect(list.className).not.toMatch(/grid-cols/);
    const articles = list.querySelectorAll(":scope > li > article");
    expect(articles).toHaveLength(3);
    for (const a of articles) expect(a).toHaveAttribute("data-layout", "list");
    expect(container.textContent).toContain("Description for product 1.");
  });

  test("default layout keeps the responsive grid (2 cols at the smallest width since T156)", () => {
    render(<ProductGrid products={products} />);
    const list = screen.getByRole("list");
    expect(list).toHaveAttribute("data-layout", "grid");
    expect(list).toHaveClass("grid-cols-2", "md:grid-cols-3", "lg:grid-cols-4");
    expect(list.className).not.toMatch(/(^|\s)(\w+:)?grid-cols-1(\s|$)/);
  });

  test("emptyState replaces the default empty text; no list rendered", () => {
    const { container } = render(
      <ProductGrid products={[]} emptyState={<p>No results for &quot;desk&quot;. Try fewer filters.</p>} />,
    );
    expect(screen.getByText('No results for "desk". Try fewer filters.')).toBeInTheDocument();
    expect(screen.queryByText("No products yet")).toBeNull();
    expect(container.querySelector("ul")).toBeNull();
  });

  test("emptyState null/false falls back to the default empty state", () => {
    const { unmount } = render(<ProductGrid products={[]} emptyState={null} />);
    expect(screen.getByRole("heading", { name: "No products yet" })).toBeInTheDocument();
    unmount();
    render(<ProductGrid products={[]} emptyState={false} />);
    expect(screen.getByRole("heading", { name: "No products yet" })).toBeInTheDocument();
  });

  test("cardProps supplies per-card extras with the typed product and index", () => {
    const ranked: ProductListItem[] = products.map((p, i) => ({ ...p, rank: i + 1 }));
    const seen: Array<[string, number]> = [];
    render(
      <ProductGrid
        products={ranked}
        cardProps={(p, index) => {
          seen.push([p.id, index]);
          return {
            rank: p.rank,
            badges: index === 0 ? ["best_seller"] : [],
            wishlist: { inList: index === 1, listId: index === 1 ? "L1" : null, addAction: listAction, removeAction: listAction },
          };
        }}
      />,
    );
    expect(seen).toEqual([["p1", 0], ["p2", 1], ["p3", 2]]);
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Rank #1");
    expect(items[0]).toHaveTextContent("Best Seller");
    expect(items[2]).toHaveTextContent("Rank #3");
    expect(within(items[1]!).getByRole("button", { name: "Remove Product 2 from Wish List" })).toBeInTheDocument();
  });

  test("cardProps cannot replace the product and className merges with w-full", () => {
    const { container } = render(
      <ProductGrid
        products={products.slice(0, 1)}
        cardProps={() => ({ product: makeProduct(99), className: "extra" }) as never}
      />,
    );
    expect(screen.getByRole("link")).toHaveAttribute("href", "/products/product-1");
    expect(container.querySelector("article")).toHaveClass("w-full", "extra");
  });

  test("static markup: one product link per card and quick-add hidden fields", () => {
    const html = renderToStaticMarkup(
      <ProductGrid products={products} cardProps={() => ({ quickAdd: { action: addToCart } })} />,
    );
    for (const p of products) {
      const links = html.match(new RegExp(`<a [^>]*href="/products/${p.slug}"`, "g")) ?? [];
      expect(links).toHaveLength(1);
      expect(html).toContain(`<input type="hidden" name="productId" value="${p.id}"/>`);
    }
    expect((html.match(/<input type="hidden" name="quantity" value="1"\/>/g) ?? [])).toHaveLength(3);
  });

  test("headingLevel and priority still flow to cards when cardProps is set", () => {
    const { container } = render(
      <ProductGrid products={products} headingLevel={2} priorityCount={1} cardProps={() => ({ badges: ["new"] })} />,
    );
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3);
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs[0]?.getAttribute("loading")).not.toBe("lazy");
    expect(imgs[1]?.getAttribute("loading")).toBe("lazy");
  });
});
