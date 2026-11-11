import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { isAllowedInternalHref } from "@/content/routes";
import type { Product } from "@/lib/types";
import { ProductRail, productRailHref } from "./ProductRail";

function makeProduct(n: number, overrides: Partial<Product> = {}): Product {
  return {
    id: `p${n}`,
    slug: `product-${n}`,
    name: `Product ${n}`,
    description: "",
    priceCents: 1000 + n,
    currency: "USD",
    imageUrl: `/images/p${n}.jpg`,
    stock: 10,
    ...overrides,
  };
}

const three = [1, 2, 3].map((n) => makeProduct(n));

let warn: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

describe("ProductRail: empty (criterion 1)", () => {
  test("no products renders nothing at all (no heading)", () => {
    const { container } = render(<ProductRail title="Customers also viewed" products={[]} />);
    expect(container.innerHTML).toBe("");
    expect(renderToStaticMarkup(<ProductRail title="X" products={[]} />)).toBe("");
  });

  test("all products with disallowed hrefs renders nothing", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <ProductRail title="X" products={three} hrefForProduct={() => "https://evil.example/"} />,
    );
    expect(container.innerHTML).toBe("");
    expect(warn).toHaveBeenCalled();
  });
});

describe("ProductRail: structure", () => {
  test("section labelled by its heading; heading level defaults to 2 and is a prop", () => {
    const { rerender } = render(<ProductRail title="Best sellers" products={three} />);
    const region = screen.getByRole("region", { name: "Best sellers" });
    expect(region.tagName).toBe("SECTION");
    // The inner scroller has its own, distinct name (unique landmarks).
    expect(screen.getByRole("region", { name: "Best sellers, product list" }).tagName).toBe("DIV");
    const heading = screen.getByRole("heading", { level: 2, name: "Best sellers" });
    expect(region.getAttribute("aria-labelledby")).toBe(heading.id);

    rerender(<ProductRail title="Best sellers" products={three} headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Best sellers" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  test("each card is a compact ProductCard with exactly one link to /products/<slug> (image + name), price beside it", () => {
    // T153: was "one link wrapping image (alt = name), name and price"; ProductCard v3 (compact)
    // keeps one link (decorative image + name heading) and renders price/rating as siblings.
    render(<ProductRail title="Rail" products={three} />);
    const scroller = screen.getByRole("region", { name: "Rail, product list" });
    expect(scroller.tagName).toBe("DIV");
    const items = within(scroller).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    items.forEach((li, i) => {
      expect(li.querySelector("article")?.getAttribute("data-variant")).toBe("compact");
      const links = within(li).getAllByRole("link");
      expect(links).toHaveLength(1);
      const link = links[0] as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe(`/products/product-${i + 1}`);
      expect(link).toHaveAccessibleName(`Product ${i + 1}`);
      expect(link.querySelector("img")?.getAttribute("alt")).toBe("");
      expect(within(link).getByRole("heading", { level: 3, name: `Product ${i + 1}` })).toBeInTheDocument();
      expect(li).toHaveTextContent(`$10.0${i + 1}`);
    });
  });

  test("rating shown only when ratingCount > 0; struck list price only when higher", () => {
    render(
      <ProductRail
        title="Rail"
        products={[
          makeProduct(1, { ratingAvg: 4.5, ratingCount: 1234, listPriceCents: 2000 }),
          makeProduct(2, { ratingAvg: 0, ratingCount: 0, listPriceCents: 1002 }),
        ]}
      />,
    );
    const [first, second] = screen.getAllByRole("listitem");
    expect(first).toHaveTextContent("4.5 out of 5 stars");
    expect(first).toHaveTextContent("1,234 ratings");
    expect(first?.querySelector("s")).toHaveTextContent("$20.00");
    expect(second).not.toHaveTextContent("out of 5 stars");
    expect(second?.querySelector("s")).toBeNull();
  });

  test("works as a plain list without JS (static markup has a ul of li, no scroll buttons shown)", () => {
    const html = renderToStaticMarkup(<ProductRail title="Rail" products={three} />);
    expect(html).toContain("overflow-x-auto");
    expect((html.match(/<li /g) ?? []).length).toBe(3);
    expect((html.match(/<a /g) ?? []).length).toBe(3);
    // Prev/next arrows render only once JS measures that the rail can scroll (ScrollRail U01), so none in server HTML.
    expect((html.match(/<button/g) ?? []).length).toBe(0);
  });

  test("two rails get unique aria-labelledby ids (criterion 5)", () => {
    render(
      <>
        <ProductRail title="A" products={three} />
        <ProductRail title="B" products={three} />
      </>,
    );
    const sections = document.querySelectorAll("section");
    const ids = Array.from(sections, (s) => s.getAttribute("aria-labelledby"));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    ids.forEach((id) => expect(document.getElementById(id ?? "")).not.toBeNull());
  });

  test("explicit id names the section and derives the heading id", () => {
    render(<ProductRail title="Rail" products={three} id="recently-viewed" />);
    const section = document.getElementById("recently-viewed");
    expect(section?.getAttribute("aria-labelledby")).toBe("recently-viewed-heading");
  });
});

describe("ProductRail: hrefs", () => {
  test("default href encodes the slug and is allowed", () => {
    const href = productRailHref(makeProduct(1, { slug: "a b" }));
    expect(href).toBe("/products/a%20b");
  });

  test("hrefForProduct validates cards: invalid ones drop the card with a warning; cards link to the product page", () => {
    // T153: ProductCard owns its link, so a custom (allowed) href is validated but not used.
    warn = spyOn(console, "warn").mockImplementation(() => {});
    render(
      <ProductRail
        title="Rail"
        products={three}
        hrefForProduct={(p) => (p.id === "p2" ? "//evil.example" : `/products/${p.slug}?ref=rail`)}
      />,
    );
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/products/product-1", "/products/product-3"]);
    links.forEach((a) => expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true));
    expect(warn).toHaveBeenCalled();
  });

  test("throwing hrefForProduct drops the card instead of crashing", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    render(
      <ProductRail
        title="Rail"
        products={three}
        hrefForProduct={(p) => {
          if (p.id === "p1") throw new Error("boom");
          return productRailHref(p);
        }}
      />,
    );
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  test("duplicate products render once", () => {
    render(<ProductRail title="Rail" products={[three[0] as Product, three[0] as Product]} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  test("seeAllHref renders a named See all link only when allowed", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const { rerender } = render(
      <ProductRail title="Best sellers" products={three} seeAllHref="/search?sort=best" />,
    );
    const seeAll = screen.getByRole("link", { name: "See all Best sellers" });
    expect(seeAll.getAttribute("href")).toBe("/search?sort=best");

    rerender(<ProductRail title="Best sellers" products={three} seeAllHref="javascript:alert(1)" />);
    expect(screen.queryByRole("link", { name: /See all/ })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe("ProductRail: hostile text, layout, tokens", () => {
  test("hostile product names and titles render as text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <ProductRail title={evil} products={[makeProduct(1, { name: evil })]} />,
    );
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(evil);
    expect(screen.getByRole("link")).toHaveAccessibleName(evil);
  });

  test("320px-safe: no unprefixed fixed widths beyond the rail item width; name clamps to 2 lines", () => {
    render(<ProductRail title="Rail" products={three} itemWidth="sm" />);
    const li = screen.getAllByRole("listitem")[0];
    expect(li).toHaveClass("w-20", "md:w-40");
    expect(screen.getAllByRole("link")[0]?.querySelector("h3.line-clamp-2")).not.toBeNull();
  });

  test("source uses no arbitrary values, inline styles or hex colours", () => {
    const src = readFileSync(join(import.meta.dir, "ProductRail.tsx"), "utf8");
    expect(src).not.toMatch(/-\[[^\]]+\]/);
    expect(src).not.toMatch(/style=\{/);
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/^["']use client["']/m);
  });
});
