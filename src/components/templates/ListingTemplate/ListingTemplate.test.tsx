import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ListingParams } from "@/components/molecules/_listing-url";
import { isAllowedInternalHref } from "@/content/routes";
import type { Product } from "@/lib/types";
import { buildListingUrl, parseListingParams, toListingQuery } from "@/app/_listing/parse-params";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createListingService, type FacetCounts, type ProductListItem } from "@/server/catalog/listing-service";
import type { CartActionFn } from "@/components/molecules/_contracts/cart-actions";
import { FEEDBACK_HREF } from "@/components/molecules/FeedbackBlock";
import type { ProductGridPromoSlot } from "@/components/organisms/ProductGrid";
import {
  LISTING_PAGINATION_LABEL,
  LISTING_RELATED_LABEL,
  LISTING_TEMPLATE_PAGE_SIZE,
  ListingTemplate,
  clearFiltersHref,
  formatResultCount,
  positionRankCardProps,
  promoPaging,
  resolveSort,
  showListingFeedback,
  viewHrefs,
  type ListingTemplateProps,
} from "./index";

const HOSTILE = `<script>alert(1)</script><img src=x onerror="alert(2)">`;

function makeProduct(n: number, overrides: Partial<Product> = {}): ProductListItem {
  return {
    id: `p${n}`,
    slug: `product-${n}`,
    name: `Product ${n}`,
    description: `Description ${n}`,
    priceCents: 1000 + n,
    currency: "USD",
    imageUrl: `/images/p${n}.jpg`,
    stock: 10,
    ...overrides,
  };
}

const facets: FacetCounts = {
  categories: [{ value: "desks", label: "Desks", count: 5, selected: false }],
  brands: [
    { value: "acme", label: "Acme", count: 4, selected: true },
    { value: "globex", label: "Globex", count: 2, selected: false },
  ],
  price: [{ value: { minCents: 0, maxCents: 2499 }, label: "Under $25", count: 3, selected: false }],
  rating: [{ value: 4, label: "4 stars & up", count: 2, selected: false }],
  inStock: 7,
  deals: 3,
};

const params: ListingParams = { q: "oak desk", brand: ["acme"], instock: true, page: 2, extra: { ref: "mail" } };

function props(overrides: Partial<ListingTemplateProps> = {}): ListingTemplateProps {
  return {
    title: 'Results for "oak desk"',
    breadcrumb: [{ label: "Home", href: "/" }, { label: "Search" }],
    params,
    facets,
    result: { items: Array.from({ length: 16 }, (_, i) => makeProduct(i + 17)), total: 48, page: 2, pageCount: 3, pageSize: 16 },
    base: "/search",
    labels: { brand: { acme: "Acme" } },
    ...overrides,
  };
}

function hrefs(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll("a[href]"), (a) => a.getAttribute("href") ?? "");
}

describe("formatResultCount (criterion 3)", () => {
  test.each([
    [1, 16, 48, 16, "1–16 of 48 results"],
    [2, 16, 48, 16, "17–32 of 48 results"],
    [3, 16, 40, 8, "33–40 of 40 results"],
    [3, 16, 48, 16, "33–48 of 48 results"],
    [1, 24, 0, 0, "0 results"],
    [1, 24, 1, 1, "1 result"],
    [1, 24, 5, 5, "1–5 of 5 results"],
    [9, 16, 48, 0, "48 results"],
    [1, 24, 1234, 24, "1–24 of 1,234 results"],
    [Number.NaN, 24, 10, 10, "1–10 of 10 results"],
    [1, 24, -5, 0, "0 results"],
    [1, 24, Number.NaN, 0, "0 results"],
  ] as const)("page %p size %p total %p items %p -> %p", (page, size, total, items, expected) => {
    expect(formatResultCount(page, size, total, items)).toBe(expected);
  });
});

describe("helpers", () => {
  test("resolveSort, viewHrefs, clearFiltersHref, positionRankCardProps", () => {
    expect(resolveSort({ q: "x" }, undefined)).toBe("relevance");
    expect(resolveSort({}, undefined)).toBe("featured");
    expect(resolveSort({ sort: "newest" }, undefined)).toBe("newest");
    expect(resolveSort({ sort: "newest" }, "price_asc")).toBe("price_asc");
    expect(viewHrefs("/search", params)).toEqual({
      grid: "/search?q=oak+desk&brand=acme&instock=1&page=2&ref=mail",
      list: "/search?q=oak+desk&brand=acme&instock=1&page=2&view=list&ref=mail",
    });
    expect(clearFiltersHref("/search", params)).toBe("/search?q=oak+desk");
    expect(clearFiltersHref("/deals", { brand: ["a"] })).toBe("/deals");
    const rank = positionRankCardProps(2, 24);
    expect(rank(null, 0)).toEqual({ rank: 25 });
    expect(positionRankCardProps(Number.NaN, 0)(null, 2)).toEqual({ rank: 3 });
  });
});

describe("ListingTemplate structure", () => {
  test("breadcrumb, one h1, count, toolbar, sidebar, grid, pagination", () => {
    const { container } = render(<ListingTemplate {...props()} />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent('Results for "oak desk"');
    expect(container.textContent).toContain("17–32 of 48 results");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    const pager = screen.getByRole("navigation", { name: LISTING_PAGINATION_LABEL });
    expect(container.querySelectorAll("ul[data-layout='grid'] > li")).toHaveLength(16);
    // Page links preserve every filter (and the preserved extra).
    expect(within(pager).getByRole("link", { name: "Page 3" })).toHaveAttribute(
      "href",
      "/search?q=oak+desk&brand=acme&instock=1&page=3&ref=mail",
    );
    expect(within(pager).getByRole("link", { name: "Page 1" })).toHaveAttribute(
      "href",
      "/search?q=oak+desk&brand=acme&instock=1&ref=mail",
    );
    // Landmarks unique.
    const navNames = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(new Set(navNames).size).toBe(navNames.length);
  });

  test("grid/list toggle are links with aria-current (criterion 4)", () => {
    render(<ListingTemplate {...props()} />);
    const group = screen.getByRole("group", { name: "View" });
    const grid = within(group).getByRole("link", { name: "Grid" });
    const list = within(group).getByRole("link", { name: "List" });
    expect(grid).toHaveAttribute("aria-current", "true");
    expect(list).not.toHaveAttribute("aria-current");
    expect(list.getAttribute("href")).toContain("view=list");
    expect(list.getAttribute("href")).toContain("page=2");
  });

  test("view=list renders the list layout and flips aria-current", () => {
    const { container } = render(<ListingTemplate {...props({ params: { ...params, view: "list" } })} />);
    expect(container.querySelector("ul[data-layout='list']")).not.toBeNull();
    expect(within(screen.getByRole("group", { name: "View" })).getByRole("link", { name: "List" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  test("static markup: exactly two GET forms, none nested; every href is an allowed internal route", () => {
    const html = renderToStaticMarkup(<ListingTemplate {...props()} />);
    const doc = document.createElement("div");
    doc.innerHTML = html;
    const forms = doc.querySelectorAll("form");
    expect(forms).toHaveLength(2);
    for (const form of forms) {
      expect(form.getAttribute("method")).toBe("get");
      expect(form.getAttribute("action")).toBe("/search");
      expect(form.querySelector("form")).toBeNull();
    }
    // The sort form keeps the filters; the sidebar form keeps the sort.
    const sortForm = Array.from(forms).find((f) => f.querySelector("select[name='sort']"));
    expect(sortForm?.querySelector("input[name='brand'][value='acme']")).not.toBeNull();
    const all = hrefs(doc);
    expect(all.length).toBeGreaterThan(10);
    for (const href of all) expect({ href, ok: isAllowedInternalHref(href) }).toEqual({ href, ok: true });
  });

  test("the sidebar gets the same params/facets and dealsCount = facets.deals", () => {
    render(<ListingTemplate {...props()} />);
    expect(screen.getByRole("group", { name: "Deals" })).toHaveTextContent("Deals only (3)");
    render(<ListingTemplate {...props({ facets: { ...facets, deals: 0 } })} />);
    expect(screen.getAllByRole("group", { name: "Deals" })).toHaveLength(1);
  });

  test("hostile title, labels and breadcrumb render as text; bad crumb hrefs become text", () => {
    const html = renderToStaticMarkup(
      <ListingTemplate
        {...props({
          title: HOSTILE,
          breadcrumb: [{ label: HOSTILE, href: "javascript:alert(1)" }, { label: "x", href: "//evil.com" }, { label: "Search" }],
          labels: { brand: { acme: HOSTILE } },
        })}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.com");
  });

  test("320px safety: layout wrappers are min-w-0; v3 has no fixed-width left column (T158 AC5)", () => {
    const { container } = render(<ListingTemplate {...props()} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("min-w-0");
    // The old `lg:w-64` sidebar column is gone: the grid takes the full width.
    expect(container.querySelector(".lg\\:w-64")).toBeNull();
    expect(container.querySelector(".lg\\:flex-row")).toBeNull();
    for (const el of [root, ...Array.from(root.children)]) expect(el.className).toMatch(/min-w-0|text-small/);
  });

  test("cardProps reach the cards; no default rank badge from search positions", () => {
    const items = [makeProduct(1, {}), makeProduct(2)].map((p, i) => ({ ...p, rank: i + 1 }));
    const result = { items, total: 2, page: 1, pageCount: 1, pageSize: 24 };
    const { container, unmount } = render(<ListingTemplate {...props({ result })} />);
    expect(container.textContent).not.toContain("#1");
    unmount();
    const { container: c2 } = render(<ListingTemplate {...props({ result, cardProps: positionRankCardProps(1, 24) })} />);
    expect(c2.textContent).toContain("#1");
    expect(c2.textContent).toContain("#2");
  });
});

describe("ListingTemplate empty states", () => {
  const empty = { items: [], total: 0, page: 1, pageCount: 0, pageSize: 24 };

  test("0 results with filters: default empty state + Clear filters (keeps q), sidebar kept, no toolbar/pager", () => {
    const { container } = render(<ListingTemplate {...props({ result: empty })} />);
    expect(container.textContent).toContain("0 results");
    expect(screen.getByRole("heading", { name: "No results" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/search?q=oak+desk");
    expect(container.querySelector("select[name='sort']")).toBeNull();
    expect(screen.queryByRole("navigation", { name: LISTING_PAGINATION_LABEL })).toBeNull();
    expect(screen.getByRole("button", { name: "Apply filters" })).toBeInTheDocument();
  });

  test("0 results without filters: no sidebar, no Clear link; emptyState slot replaces the default", () => {
    const { container, unmount } = render(
      <ListingTemplate {...props({ params: { q: "zzz" }, result: empty })} />,
    );
    expect(container.querySelector("form")).toBeNull();
    expect(screen.queryByRole("link", { name: "Clear filters" })).toBeNull();
    unmount();
    render(<ListingTemplate {...props({ result: empty, emptyState: <p>No deals right now</p> })} />);
    expect(screen.getByText("No deals right now")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No results" })).toBeNull();
  });

  test("page beyond the last: count shows total, link back to the last page", () => {
    const { container } = render(
      <ListingTemplate {...props({ params: { q: "x", page: 9 }, result: { items: [], total: 48, page: 9, pageCount: 3, pageSize: 16 } })} />,
    );
    expect(container.textContent).toContain("48 results");
    expect(screen.getByRole("link", { name: "Go to the last page" })).toHaveAttribute("href", "/search?q=x&page=3");
    expect(screen.queryByRole("navigation", { name: LISTING_PAGINATION_LABEL })).toBeNull();
  });

  test("single page: no pagination landmark", () => {
    const result = { items: [makeProduct(1)], total: 1, page: 1, pageCount: 1, pageSize: 24 };
    const { container } = render(<ListingTemplate {...props({ params: {}, result })} />);
    expect(container.textContent).toContain("1 result");
    expect(screen.queryByRole("navigation", { name: LISTING_PAGINATION_LABEL })).toBeNull();
  });
});

describe("integration with the listing service (seeded :memory: DB)", () => {
  test("parse -> list -> template: facets and params from the same call; deals count rendered", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db, { now: new Date("2026-11-07T12:00:00.000Z") });
    const service = createListingService({ db });
    const { params: parsed, ignored } = parseListingParams({ sort: "price_asc", page: "1", junk: "<x>", view: "list" });
    expect(ignored.map((i) => i.key)).toEqual(["junk"]);
    const listed = service.list(toListingQuery(parsed, { pageSize: 8, now: Date.parse("2026-11-07T12:00:00.000Z") }));
    if (!listed.ok) throw new Error("list failed");
    const r = listed.value;
    expect(r.facets.deals ?? 0).toBeGreaterThan(0);
    const { container } = render(
      <ListingTemplate
        title="All products"
        breadcrumb={[{ label: "Home", href: "/" }, { label: "All products" }]}
        params={parsed}
        facets={r.facets}
        result={r}
        sort={r.sort}
        base="/products"
        labels={{}}
      />,
    );
    expect(container.textContent).toContain(`1–${r.items.length} of ${r.total} results`);
    expect(screen.getByRole("group", { name: "Deals" })).toHaveTextContent(`Deals only (${r.facets.deals})`);
    expect(container.querySelectorAll("ul[data-layout='list'] > li")).toHaveLength(r.items.length);
    expect((container.querySelector("select[name='sort']") as HTMLSelectElement).value).toBe("price_asc");
    const pager = screen.getByRole("navigation", { name: LISTING_PAGINATION_LABEL });
    expect(within(pager).getByRole("link", { name: "Page 2" })).toHaveAttribute(
      "href",
      buildListingUrl("/products", { ...parsed, page: 2 }),
    );
    db.close();
  });
});

describe("route defaultSort (CONS-B1 consistency ac / D-T107-2)", () => {
  const featuredParams: ListingParams = { sort: "featured", page: 2 };

  test("pagination, view toggles, filter form keep sort=featured when the route default is best_selling", () => {
    const { container } = render(
      <ListingTemplate {...props({ base: "/best-sellers", params: featuredParams, defaultSort: "best_selling", sort: "featured" })} />,
    );
    const keeps = (h: string) => new URL(h, "http://h.invalid").searchParams.get("sort") === "featured";
    const pages = Array.from(
      container.querySelectorAll(`nav[aria-label="${LISTING_PAGINATION_LABEL}"] a`),
      (a) => a.getAttribute("href") ?? "",
    );
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.every(keeps)).toBe(true);
    const views = Array.from(container.querySelectorAll('[role="group"][aria-label="View"] a'), (a) => a.getAttribute("href") ?? "");
    expect(views.length).toBe(2);
    expect(views.every(keeps)).toBe(true);
    // Filter form hidden input (the sort form never posts a hidden sort).
    expect(container.querySelector('input[type="hidden"][name="sort"][value="featured"]')).not.toBeNull();
  });

  test("QA (CONS-B5 bo): every href in the sidebar keeps sort=featured on a best_selling route", () => {
    const filtered: ListingParams = { sort: "featured", category: "desks", brand: ["acme"], min: 10, max: 90, rating: 4, instock: true, page: 2 };
    const { container } = render(
      <ListingTemplate {...props({ base: "/best-sellers", params: filtered, defaultSort: "best_selling", sort: "featured" })} />,
    );
    // v3 (T158): the facets live in the Filter panel (`aside` inside the details), not a left column.
    const form = container.querySelector('form[method="get"] input[type="hidden"][name="sort"]')?.closest("form");
    const sidebar = form?.closest('aside[aria-label="Filters"]') ?? null;
    expect(sidebar).not.toBeNull();
    const links = sidebar === null ? [] : hrefs(sidebar);
    // 5 active-filter chips + Clear all, 1 category link, 1 price preset, Reset.
    expect(links).toHaveLength(9);
    const offenders = links.filter((h) => new URL(h, "http://h.invalid").searchParams.get("sort") !== "featured");
    expect(offenders).toEqual([]);
  });

  test("the route default itself is omitted from every link", () => {
    const { container } = render(
      <ListingTemplate {...props({ base: "/best-sellers", params: { page: 2 }, defaultSort: "best_selling", sort: "best_selling" })} />,
    );
    expect(hrefs(container).filter((h) => /[?&]sort=/.test(h))).toEqual([]);
    expect((container.querySelector('select[name="sort"]') as HTMLSelectElement | null)?.value).toBe("best_selling");
  });

  test("without defaultSort, featured stays the omitted default (unchanged behaviour)", () => {
    const { container } = render(<ListingTemplate {...props({ base: "/products", params: featuredParams })} />);
    expect(hrefs(container).filter((h) => /[?&]sort=featured/.test(h))).toEqual([]);
  });

  test("resolveSort falls back to the route default, then the q default", () => {
    expect(resolveSort({}, undefined, "newest")).toBe("newest");
    expect(resolveSort({ sort: "price_asc" }, undefined, "newest")).toBe("price_asc");
    expect(resolveSort({}, undefined)).toBe("featured");
    expect(resolveSort({ q: "x" }, undefined)).toBe("relevance");
    expect(viewHrefs("/new-arrivals", { sort: "featured" }, { defaultSort: "newest" }).list).toBe(
      "/new-arrivals?sort=featured&view=list",
    );
  });
});

// ---------------------------------------------------------------------------
// v3 (T158): toolbar row, related chips, promo slots, feedback, quick add.

const PROMOS: ProductGridPromoSlot[] = [
  { afterIndex: 2, tile: { heading: "Free shipping over the threshold", cta: { label: "Shipping details", href: "/shipping" } } },
  { afterIndex: 9, tile: { heading: "Sale on now", cta: { label: "Shop deals", href: "/deals" } } },
  { afterIndex: 16, tile: { heading: "Create an account", cta: { label: "Sign up", href: "/signup" } } },
  { afterIndex: 20, tile: { heading: "Fourth promo is dropped" } },
];

function page1(count: number, total = count): ListingTemplateProps["result"] {
  return {
    items: Array.from({ length: count }, (_, i) => makeProduct(i + 1)),
    total,
    page: 1,
    pageCount: Math.max(1, Math.ceil(total / 24)),
    pageSize: 24,
  };
}

function gridItems(container: ParentNode): Element[] {
  return Array.from(container.querySelectorAll("ul[data-layout] > li"));
}
const isPromo = (li: Element) => li.hasAttribute("data-promo-span");

const fakeAddToCart: CartActionFn = async () => null;

describe("helpers v3", () => {
  test("promoPaging: URL page (absent = 1) and the result page size, falling back to 24", () => {
    expect(promoPaging(undefined, 24)).toEqual({ page: 1, pageSize: 24 });
    expect(promoPaging(2, 16)).toEqual({ page: 2, pageSize: 16 });
    expect(promoPaging(1, 0)).toEqual({ page: 1, pageSize: LISTING_TEMPLATE_PAGE_SIZE });
    expect(promoPaging(1, Number.NaN)).toEqual({ page: 1, pageSize: 24 });
    expect(promoPaging(1, -3).pageSize).toBe(24);
  });

  test("showListingFeedback: results >= 1 or a non-blank q (CONTRACTS L-20)", () => {
    expect(showListingFeedback(1, undefined)).toBe(true);
    expect(showListingFeedback(0, "uno")).toBe(true);
    expect(showListingFeedback(0, "   ")).toBe(false);
    expect(showListingFeedback(0, undefined)).toBe(false);
    expect(showListingFeedback(Number.NaN, undefined)).toBe(false);
    expect(showListingFeedback(-1, "")).toBe(false);
  });
});

describe("ListingTemplate v3 toolbar row (T158 AC5, CONTRACTS L-6, L-9, L-10)", () => {
  test("one row: Filter pill first, then the sort form and the view toggle; no aside outside the details panel", () => {
    const { container } = render(<ListingTemplate {...props()} />);
    const details = container.querySelector("details[data-filter-panel]");
    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent).toContain("Filter");
    const sortForm = container.querySelector("select[name='sort']")?.closest("form") ?? null;
    const view = screen.getByRole("group", { name: "View" });
    expect(sortForm).not.toBeNull();
    // Same row: the details and the toolbar end share one parent row.
    const row = details?.parentElement ?? null;
    expect(row?.contains(sortForm)).toBe(true);
    expect(row?.contains(view)).toBe(true);
    // DOM order: Filter control, then sort, then the view toggle.
    const order = (a: Node, b: Node) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(order(details as Node, sortForm as Node)).toBeTruthy();
    expect(order(sortForm as Node, view)).toBeTruthy();
    // The sort form is not inside the filter panel (no nested forms, sort stays visible).
    expect(details?.contains(sortForm)).toBe(false);
    // Every complementary landmark sits inside the details panel.
    for (const aside of container.querySelectorAll("aside, [role='complementary']")) {
      expect(aside.closest("details[data-filter-panel]")).not.toBeNull();
    }
  });

  test("the filter panel comes before the grid; the grid is not in a side-by-side column", () => {
    const { container } = render(<ListingTemplate {...props()} />);
    const details = container.querySelector("details[data-filter-panel]") as Node;
    const grid = container.querySelector("ul[data-layout='grid']") as HTMLElement;
    expect(details.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(grid.closest("[data-listing-results]")).not.toBeNull();
    expect(grid.parentElement?.className ?? "").not.toMatch(/flex-row/);
  });

  test("no results and no filters: no toolbar at all; results but filters hidden: sort + view row only", () => {
    const empty = { items: [], total: 0, page: 1, pageCount: 0, pageSize: 24 };
    const { container, unmount } = render(<ListingTemplate {...props({ params: { q: "zzz" }, result: empty })} />);
    expect(container.querySelector("details[data-filter-panel]")).toBeNull();
    expect(container.querySelector("select[name='sort']")).toBeNull();
    unmount();
    const { container: c2 } = render(<ListingTemplate {...props({ showFilters: false })} />);
    expect(c2.querySelector("details[data-filter-panel]")).toBeNull();
    expect(c2.querySelector("select[name='sort']")).not.toBeNull();
    expect(c2.querySelectorAll("form")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "View" })).toBeInTheDocument();
  });

  test("filter badge counts the applied facet values (brand + instock = 2)", () => {
    const { container } = render(<ListingTemplate {...props()} />);
    expect(container.querySelector("[data-filter-badge]")?.textContent).toBe("2");
  });

  test("mobile (T179 U07): view toggle hidden below md, shown as a flex row from md; sort is icon-only below md", () => {
    const { container } = render(<ListingTemplate {...props()} />);
    const view = screen.getByRole("group", { name: "View" });
    expect(view).toHaveClass("hidden", "md:flex");
    expect(view).not.toHaveClass("flex");
    // The sort select keeps its accessible name; the visible text collapses below md.
    const select = screen.getByRole("combobox", { name: "Sort by" });
    expect(container.querySelector('[data-slot="sort-label-text"]')).toHaveClass("sr-only", "md:not-sr-only");
    expect(select.closest('[data-slot="sort-select-box"]')).toHaveClass("w-28", "md:w-auto");
  });

  test("view toggle links are pills", () => {
    render(<ListingTemplate {...props()} />);
    for (const a of within(screen.getByRole("group", { name: "View" })).getAllByRole("link")) {
      expect(a).toHaveClass("rounded-full");
    }
  });
});

describe("ListingTemplate v3 headings (T158 AC4, CONTRACTS L-2, L-5)", () => {
  test("exactly one h1; chips and toolbar add no headings; outline has no skipped level", () => {
    const html = renderToStaticMarkup(
      <ListingTemplate
        {...props({
          result: page1(24, 60),
          params: { q: "uno" },
          relatedSearches: [{ query: "uno cards" }, { query: "card games" }],
          promoSlots: PROMOS,
          feedback: true,
        })}
      />,
    );
    const doc = document.createElement("div");
    doc.innerHTML = html;
    const headings = Array.from(doc.querySelectorAll("h1,h2,h3,h4,h5,h6"));
    expect(headings.filter((h) => h.tagName === "H1")).toHaveLength(1);
    // Outside product cards and promo tiles: the h1, the sr-only results h2, the feedback h2.
    const outside = headings.filter((h) => h.closest("ul[data-layout]") === null);
    expect(outside.map((h) => h.textContent)).toEqual(['Results for "oak desk"', "Results", "Did you find what you were looking for?"]);
    // No heading inside the chip row or the toolbar row.
    for (const nav of doc.querySelectorAll(`nav[aria-label="${LISTING_RELATED_LABEL}"]`)) {
      expect(nav.querySelector("h1,h2,h3,h4,h5,h6")).toBeNull();
    }
    const row = doc.querySelector("details[data-filter-panel]")?.parentElement;
    expect(row?.querySelector("h1,h2,h3,h4,h5,h6") ?? null).toBeNull();
    // Promo tiles inside the grid never use h1/h2 (L-17).
    for (const li of gridItems(doc).filter(isPromo)) expect(li.querySelector("h1,h2")).toBeNull();
    // No skipped levels.
    const levels = headings.map((h) => Number(h.tagName.slice(1)));
    for (let i = 1; i < levels.length; i += 1) expect(levels[i] ?? 1).toBeLessThanOrEqual((levels[i - 1] ?? 1) + 1);
  });
});

describe("ListingTemplate v3 related searches (T158 AC1, CONTRACTS L-4)", () => {
  test("chips render in a named nav under the heading, before the toolbar", () => {
    const { container } = render(
      <ListingTemplate {...props({ relatedSearches: [{ query: "uno cards" }, { label: "Card games", href: "/category/card-games" }] })} />,
    );
    const nav = screen.getByRole("navigation", { name: LISTING_RELATED_LABEL });
    expect(within(nav).getByRole("link", { name: "uno cards" })).toHaveAttribute("href", "/search?q=uno%20cards");
    expect(within(nav).getByRole("link", { name: "Card games" })).toHaveAttribute("href", "/category/card-games");
    const h1 = container.querySelector("h1") as Node;
    const details = container.querySelector("details[data-filter-panel]") as Node;
    expect(h1.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nav.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("custom label; omitted (no empty nav) when absent, empty or all invalid", () => {
    const { unmount } = render(<ListingTemplate {...props({ relatedSearches: [{ query: "desks" }], relatedSearchesLabel: "Shop related" })} />);
    expect(screen.getByRole("navigation", { name: "Shop related" })).toBeInTheDocument();
    unmount();
    for (const relatedSearches of [undefined, [], [{ label: "Evil", href: "javascript:alert(1)" }, { query: "   " }]]) {
      const { unmount: u } = render(<ListingTemplate {...props({ relatedSearches })} />);
      expect(screen.queryByRole("navigation", { name: LISTING_RELATED_LABEL })).toBeNull();
      u();
    }
  });

  test("hostile chip text renders as text", () => {
    const html = renderToStaticMarkup(<ListingTemplate {...props({ relatedSearches: [{ query: HOSTILE }] })} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });
});

describe("ListingTemplate v3 promo slots (T158, CONTRACTS L-3, L-11, L-13, L-14)", () => {
  test("page 1: at most 3 promo li in the same list as the products; count line excludes promos", () => {
    const { container } = render(<ListingTemplate {...props({ params: {}, result: page1(24, 60), promoSlots: PROMOS })} />);
    const items = gridItems(container);
    expect(items.filter(isPromo)).toHaveLength(3);
    expect(items.filter((li) => !isPromo(li))).toHaveLength(24);
    expect(container.textContent).toContain("1–24 of 60 results");
    // Positions: after products 3, 10 and 17.
    const promoIndexes = items.map((li, i) => (isPromo(li) ? i : -1)).filter((i) => i >= 0);
    expect(promoIndexes).toEqual([3, 11, 19]);
  });

  test("page 2+: no promos (the template forwards params.page)", () => {
    const result = { ...page1(24, 60), page: 2 };
    const { container } = render(<ListingTemplate {...props({ params: { page: 2 }, result, promoSlots: PROMOS })} />);
    expect(gridItems(container).filter(isPromo)).toHaveLength(0);
  });

  test("a facet filter applied: no promos; list layout: no promos; none passed: none invented", () => {
    const cases: Array<Partial<ListingTemplateProps>> = [
      { params: { brand: ["acme"] }, promoSlots: PROMOS },
      { params: { instock: true }, promoSlots: PROMOS },
      { params: { view: "list" }, promoSlots: PROMOS },
      { params: {} },
    ];
    for (const c of cases) {
      const { container, unmount } = render(<ListingTemplate {...props({ result: page1(24, 60), ...c })} />);
      expect(gridItems(container).filter(isPromo)).toHaveLength(0);
      unmount();
    }
  });

  test("a search query alone does not suppress promos (the page decides)", () => {
    const { container } = render(<ListingTemplate {...props({ params: { q: "uno" }, result: page1(24, 60), promoSlots: PROMOS })} />);
    expect(gridItems(container).filter(isPromo)).toHaveLength(3);
  });
});

describe("ListingTemplate v3 pagination (CONTRACTS L-18)", () => {
  test("pill links, rel prev/next and aria-current unchanged", () => {
    render(<ListingTemplate {...props()} />);
    const pager = screen.getByRole("navigation", { name: LISTING_PAGINATION_LABEL });
    expect(pager.className).toContain("[&_li>*]:rounded-full");
    expect(within(pager).getByRole("link", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    expect(within(pager).getByRole("link", { name: "Page 1" })).toHaveAttribute("rel", "prev");
    expect(within(pager).getByRole("link", { name: "Page 3" })).toHaveAttribute("rel", "next");
    expect(within(pager).getByRole("link", { name: "Previous page" })).toHaveAttribute("rel", "prev");
    expect(within(pager).getByRole("link", { name: "Next page" })).toHaveAttribute("rel", "next");
  });
});

describe("ListingTemplate v3 feedback (T158 AC3, CONTRACTS L-19, L-20)", () => {
  const empty = { items: [], total: 0, page: 1, pageCount: 0, pageSize: 24 };

  test("rendered after the results when requested and there are results", () => {
    const { container } = render(<ListingTemplate {...props({ feedback: true })} />);
    const h2 = screen.getByRole("heading", { level: 2, name: "Did you find what you were looking for?" });
    expect(screen.getByRole("link", { name: "Give feedback" })).toHaveAttribute("href", FEEDBACK_HREF);
    const pager = screen.getByRole("navigation", { name: LISTING_PAGINATION_LABEL });
    expect(pager.compareDocumentPosition(h2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const section = h2.closest("section") as HTMLElement;
    expect(section.querySelector("form, input")).toBeNull();
    expect(container.querySelectorAll("form")).toHaveLength(2);
  });

  test("page suggestions are used (2-3 links)", () => {
    render(
      <ListingTemplate
        {...props({
          feedback: {
            suggestions: [
              { label: "Try uno cards", href: "/search?q=uno+cards" },
              { label: "Try card games", href: "/search?q=card+games" },
            ],
          },
        })}
      />,
    );
    expect(screen.getByRole("link", { name: "Try uno cards" })).toHaveAttribute("href", "/search?q=uno+cards");
    expect(screen.getByRole("link", { name: "Try card games" })).toBeInTheDocument();
  });

  test("0 results with a query: shown; 0 results without a query: not shown; not requested: never shown", () => {
    const { unmount } = render(<ListingTemplate {...props({ params: { q: "zzz" }, result: empty, feedback: true })} />);
    expect(screen.getByRole("link", { name: "Give feedback" })).toBeInTheDocument();
    unmount();
    const { unmount: u2 } = render(
      <ListingTemplate {...props({ base: "/category/desks", params: {}, result: empty, feedback: true })} />,
    );
    expect(screen.queryByRole("link", { name: "Give feedback" })).toBeNull();
    u2();
    for (const feedback of [undefined, false] as const) {
      const { unmount: u } = render(<ListingTemplate {...props({ feedback })} />);
      expect(screen.queryByRole("link", { name: "Give feedback" })).toBeNull();
      u();
    }
  });
});

describe("ListingTemplate v3 card props (quick add, variant)", () => {
  test("addToCart gives every card a one-unit quick-add form without price fields (L-12, SR9)", () => {
    const result = page1(3);
    const { container } = render(<ListingTemplate {...props({ params: {}, result, addToCart: fakeAddToCart })} />);
    const cards = container.querySelectorAll("ul[data-layout='grid'] > li article");
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      const form = card.querySelector("form");
      expect(form).not.toBeNull();
      expect(form?.querySelector('input[name="productId"]')).not.toBeNull();
      expect(form?.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
      expect(form?.querySelector('input[name*="price" i], input[name*="total" i]') ?? null).toBeNull();
    }
  });

  test("no addToCart: no quick-add forms (only sort + filter forms)", () => {
    const { container } = render(<ListingTemplate {...props({ params: {}, result: page1(3) })} />);
    expect(container.querySelectorAll("ul[data-layout] form")).toHaveLength(0);
  });

  test("cardVariant reaches the cards; page cardProps win over template extras", () => {
    const { container, unmount } = render(
      <ListingTemplate {...props({ params: {}, result: page1(2), cardVariant: "compact" })} />,
    );
    for (const a of container.querySelectorAll("article")) expect(a).toHaveAttribute("data-variant", "compact");
    unmount();
    const { container: c2 } = render(
      <ListingTemplate
        {...props({ params: {}, result: page1(2), cardVariant: "compact", cardProps: () => ({ variant: "default" }) })}
      />,
    );
    for (const a of c2.querySelectorAll("article")) expect(a).toHaveAttribute("data-variant", "default");
  });
});

describe("ListingTemplate now forwarding (CLEANUP-P3 ci)", () => {
  const NOW = new Date("2026-11-07T12:00:00.000Z");
  const fresh = (n: number) => makeProduct(n, { publishedAt: "2026-11-01T00:00:00.000Z" });
  const freshPage = (count: number): ListingTemplateProps["result"] => ({
    items: Array.from({ length: count }, (_, i) => fresh(i + 1)),
    total: count,
    page: 1,
    pageCount: 1,
    pageSize: 24,
  });
  const hasNew = (cell: Element | undefined) =>
    [...(cell?.querySelectorAll('[data-testid="product-card-badges"] > *') ?? [])].some((b) => b.textContent === "New");
  const newBadges = (container: ParentNode) => gridItems(container).filter(hasNew);

  test("now reaches every card: recent products show the 'New' badge", () => {
    const { container } = render(<ListingTemplate {...props({ params: {}, result: freshPage(3), now: NOW })} />);
    expect(gridItems(container)).toHaveLength(3);
    expect(newBadges(container)).toHaveLength(3);
  });

  test("no now: no 'New' badge and the clock is never read", () => {
    const original = Date.now;
    let reads = 0;
    Date.now = () => {
      reads += 1;
      return original();
    };
    try {
      const { container } = render(<ListingTemplate {...props({ params: {}, result: freshPage(3) })} />);
      expect(newBadges(container)).toHaveLength(0);
    } finally {
      Date.now = original;
    }
    expect(reads).toBe(0);
  });

  test("a now from cardProps still wins for that card (listingCardProps keeps working)", () => {
    const long = new Date("2027-06-01T00:00:00.000Z");
    const { container } = render(
      <ListingTemplate
        {...props({ params: {}, result: freshPage(2), now: NOW, cardProps: (_p, i) => (i === 0 ? { now: long } : {}) })}
      />,
    );
    const cells = gridItems(container);
    expect(hasNew(cells[0])).toBe(false);
    expect(hasNew(cells[1])).toBe(true);
  });

  test("cardProps-only now (pages still using listingCardProps) is unchanged", () => {
    const { container } = render(
      <ListingTemplate {...props({ params: {}, result: freshPage(2), cardProps: () => ({ now: NOW }) })} />,
    );
    expect(newBadges(container)).toHaveLength(2);
  });
});
