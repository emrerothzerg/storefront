import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CartActionFn } from "@/components/molecules/_contracts/cart-actions";
import type { Product } from "@/lib/types";
import { PRODUCT_GRID_CARD_CLASS, PRODUCT_GRID_CLASSES, ProductGrid, type ProductGridPromoSlot } from ".";

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

const many = (count: number) => Array.from({ length: count }, (_, i) => makeProduct(i + 1));
const addToCart: CartActionFn = async () => null;

const slots: ProductGridPromoSlot[] = [
  { afterIndex: 2, tile: { heading: "Free delivery over $35", cta: { label: "Delivery details", href: "/help/shipping" } } },
  { afterIndex: 9, tile: { heading: "Sale on now", span: 1, cta: { label: "Shop the sale", href: "/deals" } } },
  { afterIndex: 16, tile: { heading: "Create an account", cta: { label: "Sign up", href: "/signup" } } },
];

function listItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("ul[role=list] > li"));
}

const isPromo = (li: Element) => li.hasAttribute("data-promo-span");

describe("ProductGrid v3: columns (T156 AC3, CONTRACTS L-28)", () => {
  test("2 columns at the smallest width, 3 at md, 4 at lg; no 1-column class anywhere", () => {
    render(<ProductGrid products={many(4)} />);
    const list = screen.getByRole("list");
    expect(list.className).toBe(PRODUCT_GRID_CLASSES);
    expect(list).toHaveClass("grid-cols-2", "md:grid-cols-3", "lg:grid-cols-4");
    expect(list.className.split(/\s+/).some((c) => /(^|:)grid-cols-1$/.test(c))).toBe(false);
  });

  test("reduced column gap below xs so two 160px cards fit at 360px; wider from xs/lg", () => {
    render(<ProductGrid products={many(2)} />);
    expect(screen.getByRole("list")).toHaveClass("gap-x-2", "xs:gap-4", "lg:gap-6");
  });

  test("grid cards may shrink below their min width only under xs (no sideways scroll at 320px)", () => {
    const { container } = render(<ProductGrid products={many(2)} />);
    for (const a of container.querySelectorAll("article")) expect(a).toHaveClass("w-full", PRODUCT_GRID_CARD_CLASS);
  });

  test("list layout cards do not get the grid min-width override", () => {
    const { container } = render(<ProductGrid products={many(2)} layout="list" />);
    for (const a of container.querySelectorAll("article")) expect(a).not.toHaveClass(PRODUCT_GRID_CARD_CLASS);
  });

  test("product <li>s stretch (flex) so cards in a row share a height", () => {
    const { container } = render(<ProductGrid products={many(3)} />);
    for (const li of listItems(container)) expect(li.className).toBe("flex min-w-0");
  });
});

describe("ProductGrid v3: promo slots (T156 AC1/AC2/AC4, CONTRACTS L-11, L-13, L-14, L-16, L-17)", () => {
  test("promo tiles are <li> siblings in the same <ul role=list>: N product li + P promo li", () => {
    const { container } = render(<ProductGrid products={many(24)} promoSlots={slots} page={1} pageSize={24} />);
    const items = listItems(container);
    expect(items).toHaveLength(27);
    expect(items.filter(isPromo)).toHaveLength(3);
    expect(items.filter((li) => !isPromo(li))).toHaveLength(24);
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(27);
    expect(container.querySelectorAll("ul")).toHaveLength(1);
    expect(container.querySelector("ul li ul li[data-promo-span]")).toBeNull();
  });

  test("positions: after products 3, 10, 17; the last li is a product", () => {
    const { container } = render(<ProductGrid products={many(24)} promoSlots={slots} pageSize={24} />);
    const items = listItems(container);
    const positions = items.flatMap((li, i) => (isPromo(li) ? [i] : []));
    expect(positions).toEqual([3, 11, 19]);
    expect(isPromo(items[items.length - 1]!)).toBe(false);
    expect(items[3]).toHaveTextContent("Free delivery over $35");
    expect(items[11]).toHaveTextContent("Sale on now");
  });

  test("span defaults to 2 columns; an explicit span 1 is kept", () => {
    const { container } = render(<ProductGrid products={many(24)} promoSlots={slots} />);
    const promos = listItems(container).filter(isPromo);
    expect(promos.map((li) => li.getAttribute("data-promo-span"))).toEqual(["2", "1", "2"]);
    expect(promos[0]).toHaveClass("col-span-2");
    expect(promos[1]).toHaveClass("col-span-1");
  });

  test("at most 3 promos even when more slots are passed", () => {
    const extra: ProductGridPromoSlot[] = [...slots, { afterIndex: 5, tile: { heading: "Fourth" } }];
    const { container } = render(<ProductGrid products={many(24)} promoSlots={extra} />);
    expect(listItems(container).filter(isPromo)).toHaveLength(3);
    expect(container.textContent).not.toContain("Fourth");
  });

  test("page 2 (and any non-1 page): no promo li", () => {
    for (const page of [2, 5, 0]) {
      const { container, unmount } = render(<ProductGrid products={many(24)} promoSlots={slots} page={page} />);
      expect(listItems(container).filter(isPromo)).toHaveLength(0);
      expect(listItems(container)).toHaveLength(24);
      unmount();
    }
  });

  test("empty products: the empty state renders, no list and no promos", () => {
    const { container } = render(
      <ProductGrid products={[]} promoSlots={slots} emptyState={<p>Nothing here</p>} />,
    );
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(container.querySelector("ul")).toBeNull();
    expect(container.querySelector("[data-promo-span]")).toBeNull();
  });

  test("list layout ignores promo slots", () => {
    const { container } = render(<ProductGrid products={many(24)} promoSlots={slots} layout="list" />);
    expect(listItems(container).filter(isPromo)).toHaveLength(0);
  });

  test("a blank-heading tile is skipped and does not count toward the cap", () => {
    const withBlank: ProductGridPromoSlot[] = [{ afterIndex: 0, tile: { heading: "   " } }, ...slots];
    const { container } = render(<ProductGrid products={many(24)} promoSlots={withBlank} />);
    const promos = listItems(container).filter(isPromo);
    expect(promos).toHaveLength(3);
    expect(listItems(container)[1]).not.toHaveAttribute("data-promo-span");
  });

  test("promo headings are h3 inside the grid even if a slot asks for h2; h4 is kept", () => {
    const asks: ProductGridPromoSlot[] = [
      { afterIndex: 0, tile: { heading: "Wants h2", headingLevel: 2 } },
      { afterIndex: 1, tile: { heading: "Wants h4", headingLevel: 4 } },
    ];
    render(<ProductGrid products={many(4)} promoSlots={asks} />);
    expect(screen.getByRole("heading", { name: "Wants h2" }).tagName).toBe("H3");
    expect(screen.getByRole("heading", { name: "Wants h4" }).tagName).toBe("H4");
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
  });

  test("priority and cardProps index count products only (promos do not shift them)", () => {
    const seen: number[] = [];
    const { container } = render(
      <ProductGrid
        products={many(6)}
        promoSlots={[{ afterIndex: 0, tile: { heading: "Early promo" } }]}
        priorityCount={2}
        cardProps={(_, index) => {
          seen.push(index);
          return {};
        }}
      />,
    );
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    const productImgs = listItems(container)
      .filter((li) => !isPromo(li))
      .map((li) => li.querySelector("img"));
    expect(productImgs.slice(0, 2).every((img) => img?.getAttribute("loading") !== "lazy")).toBe(true);
    expect(productImgs.slice(2).every((img) => img?.getAttribute("loading") === "lazy")).toBe(true);
  });

  test("static markup: one link per li (card link or promo CTA), quick-add forms not nested", () => {
    const html = renderToStaticMarkup(
      <ProductGrid products={many(24)} promoSlots={slots} cardProps={() => ({ quickAdd: { action: addToCart } })} />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const lis = [...doc.querySelectorAll("ul[role=list] > li")];
    expect(lis).toHaveLength(27);
    for (const li of lis) expect(li.querySelectorAll("a")).toHaveLength(1);
    expect(doc.querySelectorAll("form form")).toHaveLength(0);
    expect(doc.querySelectorAll('input[name="productId"]')).toHaveLength(24);
  });

  test("an unsafe promo CTA href renders the tile without a link", () => {
    const { container } = render(
      <ProductGrid products={many(4)} promoSlots={[{ afterIndex: 1, tile: { heading: "Bad", cta: { label: "Go", href: "javascript:alert(1)" } } }]} />,
    );
    const promo = listItems(container).find(isPromo)!;
    expect(promo).toHaveTextContent("Bad");
    expect(promo.querySelector("a")).toBeNull();
  });
});
