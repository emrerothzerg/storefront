import { describe, expect, mock, spyOn, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { isAllowedInternalHref } from "@/content/routes";
import type { CartActionFn, CartActionState } from "@/components/molecules/_contracts/cart-actions";
import type { ProductDetail } from "@/lib/types";
import { CompareTable } from "./CompareTable";
import { makeDetail } from "./test-fixtures";

const brandA = { id: "b1", slug: "acme", name: "Acme", description: "" };

function three(): ProductDetail[] {
  return [
    makeDetail(1, { brand: brandA, ratingAvg: 4.5, ratingCount: 12, stock: 3 }, [
      { label: "Weight", value: "1 kg" },
      { label: "Colour", value: "Red" },
    ]),
    makeDetail(2, { brand: brandA, listPriceCents: 2000, stock: 0 }, [
      { label: "Weight", value: "1 kg" },
      { label: "Material", value: "Steel" },
    ]),
    makeDetail(3, { brand: brandA, priceCents: 1001 }, [{ label: "Weight", value: "1 kg" }]),
  ];
}

const slugs3 = ["product-1", "product-2", "product-3"];

function rowHeaders(): string[] {
  return screen.getAllByRole("rowheader").map((th) => th.textContent ?? "");
}

describe("CompareTable: fewer than two products (criterion 1)", () => {
  test("no products: info notice and no table", () => {
    render(<CompareTable products={[]} selectedSlugs={[]} />);
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("Add at least two products to compare");
    expect(screen.queryByRole("table")).toBeNull();
    expect(within(notice).getByRole("link", { name: "browse all products" })).toHaveAttribute(
      "href",
      "/products",
    );
  });

  test("one product: hint plus the product card with a remove link", () => {
    const p = makeDetail(1);
    render(<CompareTable products={[p]} selectedSlugs={["product-1"]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Add at least two products to compare");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("link", { name: "Product 1" })).toHaveAttribute(
      "href",
      "/products/product-1",
    );
    expect(screen.getByRole("img", { name: "Product 1" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Remove Product 1 from comparison" }),
    ).toHaveAttribute("href", "/compare");
  });
});

describe("CompareTable: table structure (criteria 1-3)", () => {
  test("labelled region and table, compact density, one column per product", () => {
    render(<CompareTable products={three()} selectedSlugs={slugs3} />);
    const region = screen.getByRole("region", { name: "Product comparison" });
    expect(region.className).toContain("overflow-x-auto");
    const table = within(region).getByRole("table");
    expect(table).toHaveAttribute("data-compact", "");
    const colHeaders = screen.getAllByRole("columnheader");
    expect(colHeaders).toHaveLength(4);
    for (const th of colHeaders) expect(th).toHaveAttribute("scope", "col");
  });

  test("header row: image alt = name, name links to PDP, remove link names the product", () => {
    render(<CompareTable products={three()} selectedSlugs={slugs3} />);
    expect(screen.getByRole("img", { name: "Product 2" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Product 2" })).toHaveAttribute(
      "href",
      "/products/product-2",
    );
    // D-T171-1: the standalone column-header name link is a 44px target.
    expect(screen.getByRole("link", { name: "Product 2" }).className.split(/\s+/)).toEqual(
      expect.arrayContaining(["inline-flex", "min-h-touch", "items-center"]),
    );
    const remove = screen.getByRole("link", { name: "Remove Product 2 from comparison" });
    expect(remove).toHaveAttribute("href", "/compare?p=product-1&p=product-3");
    expect(isAllowedInternalHref(remove.getAttribute("href") ?? "")).toBe(true);
  });

  test("body rows use scope=row headers: base rows then the spec union in order", () => {
    render(<CompareTable products={three()} selectedSlugs={slugs3} />);
    for (const th of screen.getAllByRole("rowheader")) expect(th).toHaveAttribute("scope", "row");
    expect(rowHeaders()).toEqual([
      "Price",
      "Customer rating",
      "Brand",
      "Availability",
      "Weight",
      "Colour",
      "Material",
      "Buy",
    ]);
  });

  test("missing spec renders an em dash labelled 'not specified' (criterion 2)", () => {
    const { container } = render(<CompareTable products={three()} selectedSlugs={slugs3} />);
    const colourRow = container.querySelector('tr[data-row="spec-1"]');
    expect(colourRow).not.toBeNull();
    const dashes = colourRow?.querySelectorAll('[aria-label="not specified"]') ?? [];
    expect(dashes).toHaveLength(2);
    for (const d of dashes) expect(d.textContent).toBe("—");
  });

  test("price, rating, brand and availability cells", () => {
    const { container } = render(<CompareTable products={three()} selectedSlugs={slugs3} />);
    const price = container.querySelector('tr[data-row="price"]');
    expect(price?.textContent).toContain("$10.01");
    expect(price?.textContent).toContain("$10.02");
    expect(price?.textContent).toContain("$20.00");
    const rating = container.querySelector('tr[data-row="rating"]');
    expect(rating?.textContent).toContain("4.5 out of 5 stars");
    expect(rating?.textContent).toContain("No reviews yet");
    const brand = container.querySelector('tr[data-row="brand"]');
    expect(brand?.textContent).toContain("Acme");
    const stock = container.querySelector('tr[data-row="availability"]');
    expect(stock?.textContent).toContain("Only 3 left in stock");
    expect(stock?.textContent).toContain("Out of stock");
    expect(stock?.textContent).toContain("In stock");
  });

  test("missing brand renders the not-specified dash", () => {
    const products = [makeDetail(1, { brand: brandA }), makeDetail(2)];
    const { container } = render(<CompareTable products={products} selectedSlugs={[]} />);
    const brand = container.querySelector('tr[data-row="brand"]');
    expect(brand?.querySelectorAll('[aria-label="not specified"]')).toHaveLength(1);
  });

  test("more than four products: first four shown plus a notice (criterion 1)", () => {
    const five = [1, 2, 3, 4, 5].map((n) => makeDetail(n));
    render(
      <CompareTable products={five} selectedSlugs={five.map((p) => p.slug)} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Showing the first 4 of 5 products.");
    expect(screen.getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.queryByRole("link", { name: "Product 5" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Remove Product 4 from comparison" }),
    ).toHaveAttribute("href", "/compare?p=product-1&p=product-2&p=product-3");
  });

  test("selectedSlugs empty falls back to the products' slugs for links", () => {
    render(<CompareTable products={three()} selectedSlugs={[]} />);
    expect(
      screen.getByRole("link", { name: "Remove Product 1 from comparison" }),
    ).toHaveAttribute("href", "/compare?p=product-2&p=product-3");
  });
});

describe("CompareTable: differences only (criterion 4)", () => {
  test("off: toggle link adds diff=1 and all rows are shown", () => {
    render(<CompareTable products={three()} selectedSlugs={slugs3} />);
    const toggle = screen.getByRole("link", { name: "Show differences only" });
    expect(toggle).toHaveAttribute("href", "/compare?p=product-1&p=product-2&p=product-3&diff=1");
    expect(rowHeaders()).toContain("Weight");
    expect(rowHeaders()).toContain("Brand");
  });

  test("on: equal rows hidden, toggle link removes diff, remove links keep diff=1", () => {
    render(<CompareTable products={three()} selectedSlugs={slugs3} differencesOnly />);
    expect(screen.getByRole("link", { name: "Show all details" })).toHaveAttribute(
      "href",
      "/compare?p=product-1&p=product-2&p=product-3",
    );
    // Weight (all "1 kg") and Brand (all Acme) are equal; Price differs via the list price.
    expect(rowHeaders()).toEqual([
      "Price",
      "Customer rating",
      "Availability",
      "Colour",
      "Material",
      "Buy",
    ]);
    expect(
      screen.getByRole("link", { name: "Remove Product 3 from comparison" }),
    ).toHaveAttribute("href", "/compare?p=product-1&p=product-2&diff=1");
  });

  test("on with identical products: a 'same details' row replaces the hidden rows", () => {
    const twins = [
      makeDetail(1, { priceCents: 500 }, [{ label: "A", value: "x" }]),
      makeDetail(2, { priceCents: 500 }, [{ label: "A", value: "x" }]),
    ];
    render(<CompareTable products={twins} selectedSlugs={[]} differencesOnly />);
    expect(rowHeaders()).toEqual(["Differences", "Buy"]);
    expect(screen.getByText("These products have the same details.")).toBeInTheDocument();
  });

  test("custom basePath is used for toggle and remove links; unsafe basePath falls back", () => {
    const { unmount } = render(
      <CompareTable products={three()} selectedSlugs={slugs3} basePath="/compare" />,
    );
    unmount();
    render(
      <CompareTable products={three()} selectedSlugs={slugs3} basePath="https://evil.test/x" />,
    );
    expect(screen.getByRole("link", { name: "Show differences only" }).getAttribute("href")).toMatch(
      /^\/compare\?/,
    );
  });
});

describe("CompareTable: buy row", () => {
  test("without addToCart: button-styled links to each PDP with unique names", () => {
    render(<CompareTable products={three()} selectedSlugs={slugs3} />);
    const link = screen.getByRole("link", { name: "View product for Product 1" });
    expect(link).toHaveAttribute("href", "/products/product-1");
    expect(screen.queryByRole("button", { name: /Add to cart/ })).toBeNull();
  });

  test("with addToCart: one form per in-stock product posting productId and quantity=1", async () => {
    const calls: FormData[] = [];
    const addToCart: CartActionFn = mock(
      async (_prev: CartActionState, formData: FormData): Promise<CartActionState> => {
        calls.push(formData);
        return { ok: true, value: { itemCount: 1, subtotalCents: 1001, message: "Added" } };
      },
    );
    const { container } = render(
      <CompareTable products={three()} selectedSlugs={slugs3} addToCart={addToCart} />,
    );
    expect(container.querySelectorAll("form")).toHaveLength(2);
    const out = screen.getByRole("button", { name: "Out of stock for Product 2" });
    expect(out).toBeDisabled();
    const button = screen.getByRole("button", { name: "Add to cart for Product 1" });
    const form = button.closest("form");
    expect(form).not.toBeNull();
    expect(form?.querySelector('input[name="productId"]')).toHaveAttribute("value", "p1");
    expect(form?.querySelector('input[name="quantity"]')).toHaveAttribute("value", "1");
    expect(form?.querySelector('input[name="price"], input[name="sessionId"]')).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.get("productId")).toBe("p1");
    expect(calls[0]?.get("quantity")).toBe("1");
  });
});

describe("CompareTable: safety, server rendering, tokens", () => {
  test("hostile names and specs render as text only", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const products = [
      makeDetail(1, { name: evil, brand: { ...brandA, name: evil } }, [{ label: evil, value: evil }]),
      makeDetail(2, { slug: "a/../b?c" }),
    ];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<CompareTable products={products} selectedSlugs={[]} />);
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    expect(screen.getAllByText(evil).length).toBeGreaterThanOrEqual(3);
    // "/products/a%2F..%2Fb%3Fc" fails isAllowedInternalHref: name shown as plain text.
    expect(screen.queryByRole("link", { name: "Product 2" })).toBeNull();
    expect(container.querySelector("span.font-semibold")?.textContent).toBe("Product 2");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("renderToStaticMarkup works (server-safe, no 'use client')", () => {
    const html = renderToStaticMarkup(
      <CompareTable products={three()} selectedSlugs={slugs3} differencesOnly />,
    );
    expect(html).toContain('aria-label="Product comparison"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('aria-label="not specified"');
    expect(html).toContain("/compare?p=product-1&amp;p=product-2&amp;p=product-3");
    const source = readFileSync(join(import.meta.dir, "CompareTable.tsx"), "utf8");
    expect(source).not.toMatch(/^["']use client["']/m);
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });

  test("320px audit: sticky first column, min widths inside the scroll region, no inline styles", () => {
    const { container } = render(
      <CompareTable products={three()} selectedSlugs={slugs3} addToCart={async () => null} />,
    );
    const root = container.firstElementChild;
    expect(root?.className).toContain("min-w-0");
    expect(root?.className).toContain("max-w-full");
    for (const th of screen.getAllByRole("rowheader")) {
      for (const cls of ["sticky", "left-0", "bg-surface-raised", "z-raised", "min-w-28"]) {
        expect(th.className.split(" ")).toContain(cls);
      }
    }
    const productCols = screen.getAllByRole("columnheader").slice(1);
    for (const th of productCols) expect(th.className.split(" ")).toContain("min-w-40");
    const region = screen.getByRole("region", { name: "Product comparison" });
    expect(region.className.split(" ")).toContain("overflow-x-auto");
    // Only next/image (inside the Image atom) sets an inline style on <img>.
    expect(container.querySelector(":not(img)[style]")).toBeNull();
    const source = readFileSync(join(import.meta.dir, "CompareTable.tsx"), "utf8");
    expect(source).not.toMatch(/style=\{/);
    expect(source).not.toMatch(/\b[a-z-]+-\[[^\]]+\]/);
    // Interactive controls keep the 44px target classes from the atoms.
    for (const link of screen.getAllByRole("link", { name: /from comparison/ })) {
      expect(link.className).toContain("min-h-touch");
    }
  });

  test("headingLevel controls the section heading", () => {
    render(<CompareTable products={three()} selectedSlugs={slugs3} headingLevel={3} />);
    const heading = screen.getByRole("heading", { level: 3, name: "Side-by-side comparison" });
    const section = heading.closest("section");
    expect(section).toHaveAttribute("aria-labelledby", heading.id);
    // Landmarks stay unique: the section and the table region have different names.
    expect(screen.getAllByRole("region", { name: "Product comparison" })).toHaveLength(1);
  });
});

describe("CompareTable: FIX-org-B (D-T86-1..4)", () => {
  test("table has a visually hidden caption naming it", () => {
    const { container } = render(<CompareTable products={three()} selectedSlugs={slugs3} />);
    const caption = container.querySelector("table > caption");
    expect(caption?.textContent).toBe("Product comparison");
    expect(caption).toHaveClass("sr-only");
  });

  test("duplicate product ids render one column (first wins)", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    const a = makeDetail(1);
    const { container } = render(
      <CompareTable products={[a, { ...a, name: "Dup" }, makeDetail(2)]} selectedSlugs={[]} />,
    );
    expect(container.querySelectorAll("thead th[scope=col]").length - 1).toBe(2);
    expect(screen.queryByText("Dup")).toBeNull();
    expect(err.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
    err.mockRestore();
  });

  test("a selected slug matching no shown product is dropped from every link", () => {
    const { container } = render(
      <CompareTable products={three()} selectedSlugs={["ghost", ...slugs3]} />,
    );
    const hrefs = [...container.querySelectorAll("a[href^='/compare']")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBe(4);
    for (const h of hrefs) expect(h).not.toContain("ghost");
  });

  test("invalid product href: plain-text name, no View product link, dev warning; other columns keep links", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const products = [makeDetail(1, { slug: ".." }), makeDetail(2)];
    const { container } = render(<CompareTable products={products} selectedSlugs={[]} />);
    expect(screen.queryByRole("link", { name: "Product 1" })).toBeNull();
    expect(container.querySelector("thead span.font-semibold")?.textContent).toBe("Product 1");
    expect(screen.getByText("Product page unavailable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Product 2" })).toHaveAttribute("href", "/products/product-2");
    for (const a of container.querySelectorAll("a[href]")) {
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
    expect(warn.mock.calls.some((c) => String(c[0]).startsWith("[CompareTable]"))).toBe(true);
    warn.mockRestore();
  });

  test("single product with invalid href renders its name as text", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(<CompareTable products={[makeDetail(1, { slug: "a/b" })]} selectedSlugs={[]} />);
    expect(screen.queryByRole("link", { name: "Product 1" })).toBeNull();
    expect(container.querySelector("span.font-semibold")?.textContent).toBe("Product 1");
    warn.mockRestore();
  });
});

describe("CompareTable: Phase 3 restyle (T160)", () => {
  test("table sits in a white bordered card; differences toggle is an outline pill link", () => {
    render(<CompareTable products={three()} selectedSlugs={slugs3} />);
    const region = screen.getByRole("region", { name: "Product comparison" });
    expect(region).toHaveClass("rounded-lg", "border", "border-border-default", "bg-surface-raised", "shadow-sm");
    const toggle = screen.getByRole("link", { name: "Show differences only" });
    expect(toggle).toHaveClass("rounded-full", "min-h-touch");
    expect(toggle).toHaveAttribute("data-differences-only", "off");
    expect(toggle).toHaveAttribute("href", "/compare?p=product-1&p=product-2&p=product-3&diff=1");
  });

  test("a single product renders on a Card with its remove link", () => {
    const [only] = three();
    render(<CompareTable products={only === undefined ? [] : [only]} selectedSlugs={["product-1"]} />);
    const card = screen.getByTestId("compare-single");
    expect(card).toHaveClass("bg-surface-raised", "border", "rounded-lg", "min-w-0");
    expect(within(card).getByRole("link", { name: /from comparison/ })).toHaveAttribute("href", "/compare");
  });
});
