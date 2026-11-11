// QA (QA-W4-organisms-B / T90): T86 CompareTable + helpers.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CartActionFn } from "@/components/molecules/_contracts/cart-actions";
import { buildComparePath, COMPARE_MAX } from "@/components/molecules/CompareToggle/compare-path";
import {
  COMPARE_MIN_HINT,
  COMPARE_SECTION_HEADING,
  COMPARE_TABLE_LABEL,
  CompareTable,
  compareStateHref,
  removeHref,
  type CompareTableProps,
} from "@/components/organisms/CompareTable";
import { isAllowedInternalHref } from "@/content/routes";
import type { ProductDetail, ProductSpec } from "@/lib/types";

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; ‮evil`;
const ROOT = join(import.meta.dir, "../../../src/components/organisms");

function detail(n: number, over: Partial<ProductDetail> = {}, specs: readonly ProductSpec[] = []): ProductDetail {
  return {
    id: `qa-c${n}`,
    slug: `qa-compare-${n}`,
    name: `QA Compare ${n}`,
    description: "",
    priceCents: 1000 * n,
    currency: "USD",
    imageUrl: `/images/qa-c${n}.jpg`,
    stock: 20,
    bullets: [],
    specs,
    images: [{ url: `/images/qa-c${n}.jpg`, alt: "" }],
    listPriceCents: null,
    ratingCount: 0,
    ratingAvg: 0,
    brand: null,
    category: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const two = [
  detail(1, {}, [
    { label: "Weight", value: "1 kg" },
    { label: "Colour", value: "Red" },
  ]),
  detail(2, {}, [
    { label: "Weight", value: "1 kg" },
    { label: "Battery", value: "10 h" },
  ]),
];

function props(over: Partial<CompareTableProps> = {}): CompareTableProps {
  return { products: two, selectedSlugs: two.map((p) => p.slug), ...over };
}

let spies: Array<ReturnType<typeof spyOn>> = [];
afterEach(() => {
  for (const s of spies) s.mockRestore();
  spies = [];
});

function table(container: HTMLElement): HTMLTableElement {
  const t = container.querySelector("table");
  if (!(t instanceof HTMLTableElement)) throw new Error("no table");
  return t;
}

describe("T86.1 hints, truncation, empty", () => {
  test("0 products: message and a link to /products, no table", () => {
    const { container } = render(<CompareTable products={[]} selectedSlugs={[]} />);
    expect(screen.getByText(COMPARE_MIN_HINT)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "browse all products" })).toHaveAttribute("href", "/products");
    expect(container.querySelector("table")).toBeNull();
    expect(screen.getByRole("region", { name: COMPARE_SECTION_HEADING })).toBeInTheDocument();
  });

  test("1 product: hint to add another + the product with a Remove link via the compare path", () => {
    const p = detail(1);
    render(<CompareTable products={[p]} selectedSlugs={[p.slug]} />);
    expect(screen.getByText(COMPARE_MIN_HINT)).toBeInTheDocument();
    const remove = screen.getByRole("link", { name: `Remove ${p.name} from comparison` });
    expect(remove).toHaveAttribute("href", buildComparePath([p.slug], p.slug));
  });

  test("> 4 products: exactly 4 columns plus a notice 'Showing the first 4 of N products.'", () => {
    const six = [1, 2, 3, 4, 5, 6].map((n) => detail(n));
    const { container } = render(<CompareTable products={six} selectedSlugs={six.map((p) => p.slug)} />);
    expect(COMPARE_MAX).toBe(4);
    const headRow = table(container).querySelector("thead tr") as HTMLTableRowElement;
    expect(headRow.querySelectorAll('th[scope="col"]')).toHaveLength(5); // corner + 4
    expect(screen.getByText("Showing the first 4 of 6 products.")).toBeInTheDocument();
    expect(screen.queryByText("QA Compare 5")).toBeNull();
  });
});

describe("T86.2 em dash for missing specs; row headers scope=row; attribute rows", () => {
  test("every body row starts with <th scope=row>; header cells scope=col", () => {
    const { container } = render(<CompareTable {...props()} />);
    const t = table(container);
    for (const row of t.querySelectorAll("tbody tr")) {
      const first = row.firstElementChild as HTMLElement;
      expect(first.tagName).toBe("TH");
      expect(first.getAttribute("scope")).toBe("row");
    }
    for (const th of t.querySelectorAll("thead th")) expect(th.getAttribute("scope")).toBe("col");
    const rowNames = [...t.querySelectorAll("tbody th")].map((th) => th.textContent);
    expect(rowNames).toEqual(["Price", "Customer rating", "Brand", "Availability", "Weight", "Colour", "Battery", "Buy"]);
  });

  test("missing spec -> em dash with aria-label='not specified'", () => {
    const { container } = render(<CompareTable {...props()} />);
    const colour = container.querySelector('tr[data-row="spec-1"]') as HTMLTableRowElement;
    const cells = colour.querySelectorAll("td");
    expect(cells[0]?.textContent).toBe("Red");
    const dash = cells[1]?.querySelector('[aria-label="not specified"]');
    expect(dash?.textContent).toBe("—");
  });

  test("hostile spec labels/values, names and brand render as text", () => {
    const products = [
      detail(1, { name: HOSTILE, brand: { id: "b", slug: "b", name: HOSTILE, description: "" } }, [{ label: HOSTILE, value: HOSTILE }]),
      detail(2),
    ];
    const { container } = render(<CompareTable products={products} selectedSlugs={[]} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelectorAll("img[onerror]")).toHaveLength(0);
    expect(container.querySelectorAll("img")).toHaveLength(2);
    expect(container.textContent).toContain(HOSTILE);
    const html = renderToStaticMarkup(<CompareTable products={products} selectedSlugs={[]} />);
    expect(html).not.toContain("<script>alert(2)");
    expect(html).not.toContain("<img src=x");
  });
});

describe("T86.3 horizontal scroll inside its container at 320px; sticky first column", () => {
  test("table sits in a focusable, named region with overflow-x-auto; root is min-w-0 max-w-full", () => {
    const { container } = render(<CompareTable {...props()} />);
    const region = screen.getByRole("region", { name: COMPARE_TABLE_LABEL });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.className).toContain("overflow-x-auto");
    expect(region.className).toContain("max-w-full");
    expect(region.contains(table(container))).toBe(true);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("min-w-0");
    expect(root.className).toContain("max-w-full");
  });

  test("first column cells (corner + row headers) are sticky left-0 with an opaque background", () => {
    const { container } = render(<CompareTable {...props()} />);
    const firstCells = [...table(container).querySelectorAll("tr")].map((r) => r.firstElementChild as HTMLElement);
    for (const c of firstCells) {
      expect(c.className).toContain("sticky");
      expect(c.className).toContain("left-0");
      expect(c.className).toMatch(/\bbg-surface-/);
    }
  });

  test("section heading and region labels are distinct (unique landmarks)", () => {
    render(<CompareTable {...props()} />);
    expect(COMPARE_SECTION_HEADING).not.toBe(COMPARE_TABLE_LABEL);
    const regions = screen.getAllByRole("region");
    const names = regions.map((r) => r.getAttribute("aria-label") ?? r.getAttribute("aria-labelledby"));
    expect(new Set(names).size).toBe(names.length);
  });

  test("DEFECT D-T86-1 evidence (fixed in FIX-org-B): the <table> has a visually hidden caption 'Product comparison'", () => {
    const { container } = render(<CompareTable {...props()} />);
    const caption = table(container).querySelector("caption");
    expect(caption?.textContent).toBe(COMPARE_TABLE_LABEL);
    expect(caption).toHaveClass("sr-only");
  });

  test("DEFECT D-T86-1: the comparison table has a caption (or accessible name)", () => {
    const { container } = render(<CompareTable {...props()} />);
    const t = table(container);
    const named = t.querySelector("caption") !== null || t.hasAttribute("aria-label") || t.hasAttribute("aria-labelledby");
    expect(named).toBe(true);
  });
});

describe("T86.4 differences-only toggle (GET param)", () => {
  test("toggle link adds diff=1; with differencesOnly rows whose values are all equal are hidden", () => {
    const { container, rerender } = render(<CompareTable {...props()} />);
    const toggle = screen.getByRole("link", { name: "Show differences only" });
    expect(toggle).toHaveAttribute("href", "/compare?p=qa-compare-1&p=qa-compare-2&diff=1");
    expect(container.querySelector('tr[data-row="spec-0"]')).not.toBeNull(); // Weight equal
    rerender(<CompareTable {...props({ differencesOnly: true })} />);
    expect(container.querySelector('tr[data-row="spec-0"]')).toBeNull();
    expect(container.querySelector('tr[data-row="rating"]')).toBeNull(); // both "none"
    expect(container.querySelector('tr[data-row="brand"]')).toBeNull(); // both null
    expect(container.querySelector('tr[data-row="price"]')).not.toBeNull();
    expect(container.querySelector('tr[data-row="buy"]')).not.toBeNull();
    expect(screen.getByRole("link", { name: "Show all details" })).toHaveAttribute(
      "href",
      "/compare?p=qa-compare-1&p=qa-compare-2",
    );
  });

  test("identical products with differencesOnly: 'same details' row, Buy row kept", () => {
    const a = detail(1, { priceCents: 5 });
    const b = detail(2, { priceCents: 5, name: "Other" });
    const { container } = render(<CompareTable products={[a, b]} selectedSlugs={[]} differencesOnly />);
    expect(container.querySelector('tr[data-row="no-differences"]')).not.toBeNull();
    expect(container.querySelector('tr[data-row="buy"]')).not.toBeNull();
  });
});

describe("Remove links, add-to-cart forms, hrefs", () => {
  test("Remove links equal buildComparePath(selected, slug) and keep diff=1 when on", () => {
    const three = [1, 2, 3].map((n) => detail(n));
    const slugs = three.map((p) => p.slug);
    render(<CompareTable products={three} selectedSlugs={slugs} />);
    for (const p of three) {
      expect(screen.getByRole("link", { name: `Remove ${p.name} from comparison` })).toHaveAttribute(
        "href",
        buildComparePath(slugs, p.slug),
      );
    }
    expect(removeHref("/compare", slugs, "qa-compare-2", true)).toBe("/compare?p=qa-compare-1&p=qa-compare-3&diff=1");
  });

  test("add-to-cart forms post only productId + quantity=1; out-of-stock shows a disabled button", async () => {
    let posted: Array<[string, string]> = [];
    const addToCart: CartActionFn = async (_prev, fd) => {
      posted = [...fd.entries()].map(([k, v]) => [k, String(v)]);
      return null;
    };
    const products = [detail(1), detail(2, { stock: 0 })];
    const { container } = render(<CompareTable products={products} selectedSlugs={[]} addToCart={addToCart} />);
    const forms = [...container.querySelectorAll("form")];
    expect(forms).toHaveLength(1);
    const fields = [...new FormData(forms[0] as HTMLFormElement).entries()].map(([k, v]) => [k, String(v)]);
    expect(fields).toEqual([
      ["productId", "qa-c1"],
      ["quantity", "1"],
    ]);
    expect(screen.getByRole("button", { name: "Add to cart for QA Compare 1" })).toBeInTheDocument();
    const oos = screen.getByRole("button", { name: "Out of stock for QA Compare 2" });
    expect((oos as HTMLButtonElement).disabled).toBe(true);
    expect(posted).toEqual([]);
  });

  test("without addToCart each column links to the product page", () => {
    render(<CompareTable {...props()} />);
    expect(screen.getByRole("link", { name: "View product for QA Compare 1" })).toHaveAttribute("href", "/products/qa-compare-1");
  });

  test("every href passes isAllowedInternalHref (normal data)", () => {
    const { container } = render(<CompareTable {...props()} />);
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("selectedSlugs duplicates/blank entries are normalised in links", () => {
    render(<CompareTable {...props({ selectedSlugs: ["qa-compare-1", " qa-compare-1 ", "", "qa-compare-2"] })} />);
    expect(screen.getByRole("link", { name: "Show differences only" })).toHaveAttribute(
      "href",
      compareStateHref("/compare", ["qa-compare-1", "qa-compare-2"], true),
    );
  });

  test("unsafe basePath falls back to /compare", () => {
    render(<CompareTable {...props({ basePath: "https://evil.example/compare" })} />);
    expect(screen.getByRole("link", { name: "Show differences only" }).getAttribute("href")?.startsWith("/compare?")).toBe(true);
  });

  test("DEFECT D-T86-2 evidence (fixed in FIX-org-B): duplicate products render no React duplicate-key errors", () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    spies.push(err);
    const a = detail(1);
    render(<CompareTable products={[a, a, detail(2)]} selectedSlugs={[]} />);
    expect(err.mock.calls.some((c) => String(c[0]).includes("same key"))).toBe(false);
  });

  test("DEFECT D-T86-2: duplicate products (same id) render one column", () => {
    spies.push(spyOn(console, "error").mockImplementation(() => {}));
    const a = detail(1);
    const { container } = render(<CompareTable products={[a, a, detail(2)]} selectedSlugs={[]} />);
    expect(table(container).querySelectorAll("thead th[scope=col]").length - 1).toBe(2);
  });

  test("DEFECT D-T86-3 evidence (fixed in FIX-org-B): with an unknown slug, the shown products' slugs remain in the links", () => {
    const slugs = ["ghost-slug", ...two.map((p) => p.slug)];
    const { container } = render(<CompareTable products={two} selectedSlugs={slugs} />);
    const hrefs = [...container.querySelectorAll("a[href^='/compare']")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toEqual([
      "/compare?p=qa-compare-1&p=qa-compare-2&diff=1",
      "/compare?p=qa-compare-2",
      "/compare?p=qa-compare-1",
    ]);
  });

  test("DEFECT D-T86-3: Remove/toggle links only carry slugs of products actually shown", () => {
    const slugs = ["ghost-slug", ...two.map((p) => p.slug)];
    const { container } = render(<CompareTable products={two} selectedSlugs={slugs} />);
    const hrefs = [...container.querySelectorAll("a[href^='/compare']")].map((a) => a.getAttribute("href") ?? "");
    for (const h of hrefs) expect(h).not.toContain("ghost-slug");
  });

  test("DEFECT D-T86-4 evidence (fixed in FIX-org-B): a hostile product slug renders the name as plain text with a dev warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    spies.push(warn);
    const bad = [detail(1, { slug: "../../admin" }), detail(2, { slug: "a/b" })];
    const { container } = render(<CompareTable products={bad} selectedSlugs={[]} />);
    expect(container.querySelectorAll("a[href^='/products/']").length).toBe(0);
    expect(screen.getAllByText("QA Compare 1").length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
  });

  test("DEFECT D-T86-4: every href passes isAllowedInternalHref even for malformed slugs", () => {
    spies.push(spyOn(console, "warn").mockImplementation(() => {}));
    const bad = [detail(1, { slug: "../../admin" }), detail(2, { slug: "a/b" })];
    const { container } = render(<CompareTable products={bad} selectedSlugs={[]} />);
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });
});

describe("CompareTable price edge cases and source rules", () => {
  test("list price <= price shows no strike-through; > price shows it", () => {
    const { container } = render(
      <CompareTable products={[detail(1, { listPriceCents: 1000 }), detail(2, { listPriceCents: 9999 })]} selectedSlugs={[]} />,
    );
    const priceRow = container.querySelector('tr[data-row="price"]') as HTMLTableRowElement;
    const cells = priceRow.querySelectorAll("td");
    expect(cells[0]?.querySelector("s")).toBeNull();
    expect(cells[1]?.querySelector("s")).not.toBeNull();
  });

  test("source: no `use client`, no inline style, no raw HTML, no server runtime imports", () => {
    for (const f of ["CompareTable.tsx", "compare-table-helpers.ts"]) {
      const src = readFileSync(join(ROOT, "CompareTable", f), "utf8");
      expect(src).not.toMatch(/^\s*['"]use client['"]/m);
      expect(src).not.toMatch(/style=|dangerouslySetInnerHTML/);
      for (const line of src.split("\n").filter((l) => l.includes("@/server/"))) expect(line).toMatch(/^import type /);
    }
  });

  test("heading level prop", () => {
    render(<CompareTable {...props({ headingLevel: 3 })} />);
    expect(screen.getByRole("heading", { level: 3, name: COMPARE_SECTION_HEADING })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: COMPARE_SECTION_HEADING })).getByRole("table")).toBeInTheDocument();
  });
});
