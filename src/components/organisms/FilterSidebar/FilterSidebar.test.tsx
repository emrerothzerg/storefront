import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { FacetCounts } from "@/server/catalog/listing-service";
import type { ListingParams } from "@/components/molecules/_listing-url";
import {
  FILTER_PANEL_DESKTOP_QUERY,
  FILTER_SUMMARY_LABEL,
  FilterSidebar,
  activeFilterCount,
  filterBadgeText,
  filterHiddenEntries,
  filterResetHref,
  filtersButtonLabel,
  hasAvailableBucket,
  isDesktopViewport,
} from ".";
import type { FilterSidebarProps } from ".";
import { expectFocused } from "@/test/dom-assertions";

const facets: FacetCounts = {
  categories: [
    { value: "desks", label: "Desks", count: 5, selected: true },
    { value: "chairs", label: "Chairs", count: 3, selected: false },
  ],
  brands: [
    { value: "acme", label: "Acme", count: 4, selected: true },
    { value: "globex", label: "Globex", count: 2, selected: false },
  ],
  price: [
    { value: { minCents: 0, maxCents: 2499 }, label: "Under $25", count: 3, selected: false },
    { value: { minCents: 2500, maxCents: 4999 }, label: "$25 to $50", count: 2, selected: false },
  ],
  rating: [
    { value: 4, label: "4 stars & up", count: 6, selected: false },
    { value: 3, label: "3 stars & up", count: 8, selected: false },
  ],
  inStock: 7,
  deals: 0,
};

const emptyFacets: FacetCounts = { categories: [], brands: [], price: [], rating: [], inStock: 0, deals: 0 };

const params: ListingParams = {
  q: "oak desk",
  dept: "furniture",
  category: "desks",
  brand: ["acme"],
  min: 10,
  max: 90,
  rating: 4,
  instock: true,
  sort: "price_asc",
  page: 3,
  view: "list",
  extra: { p: "x-1", utm_source: "mail" },
};

function setup(overrides: Partial<FilterSidebarProps> = {}) {
  const props: FilterSidebarProps = { facets, params, base: "/search", labels: { brand: { acme: "Acme" } }, ...overrides };
  return <FilterSidebar {...props} />;
}

function queryOf(href: string | null): URLSearchParams {
  return new URL(href ?? "", "http://h.invalid").searchParams;
}

function pressEscape(dialog: HTMLDialogElement) {
  act(() => {
    const event = new Event("cancel", { cancelable: true });
    if (dialog.dispatchEvent(event)) dialog.close();
  });
}

describe("helpers", () => {
  test("filtersButtonLabel shows the count as text", () => {
    expect(filtersButtonLabel(0)).toBe("Filters");
    expect(filtersButtonLabel(3)).toBe("Filters (3)");
    expect(filtersButtonLabel(Number.NaN)).toBe("Filters");
  });

  test("activeFilterCount counts one per chip (price range once)", () => {
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ q: "x", sort: "rating", page: 2 })).toBe(0);
    // category, brand, price, rating, instock
    expect(activeFilterCount(params)).toBe(5);
    expect(activeFilterCount({ brand: ["a", "b"], deals: true })).toBe(3);
  });

  test("filterResetHref keeps q/sort/view/dept/extra and drops every facet and page", () => {
    const href = filterResetHref("/search", { ...params, deals: true });
    expect(new URL(href, "http://h.invalid").pathname).toBe("/search");
    const qs = queryOf(href);
    expect(qs.get("q")).toBe("oak desk");
    expect(qs.get("sort")).toBe("price_asc");
    expect(qs.get("view")).toBe("list");
    expect(qs.get("dept")).toBe("furniture");
    expect(qs.get("p")).toBe("x-1");
    expect(qs.get("utm_source")).toBe("mail");
    for (const key of ["category", "brand", "min", "max", "rating", "instock", "deals", "page"]) {
      expect(qs.has(key)).toBe(false);
    }
  });

  test("filterResetHref falls back to a safe base", () => {
    expect(filterResetHref("https://evil.example/x", { q: "a" })).toBe("/?q=a");
    expect(filterResetHref("//evil", {})).toBe("/");
  });

  test("filterHiddenEntries preserves non-control params and drops page", () => {
    expect(filterHiddenEntries(params)).toEqual([
      ["q", "oak desk"],
      ["dept", "furniture"],
      ["category", "desks"],
      ["sort", "price_asc"],
      ["view", "list"],
      ["p", "x-1"],
      ["utm_source", "mail"],
    ]);
  });

  test("hasAvailableBucket", () => {
    expect(hasAvailableBucket([])).toBe(false);
    expect(hasAvailableBucket([{ value: "a", label: "A", count: 0, selected: false }])).toBe(false);
    expect(hasAvailableBucket([{ value: "a", label: "A", count: 0, selected: true }])).toBe(true);
    expect(hasAvailableBucket([{ value: "a", label: "A", count: 2, selected: false }])).toBe(true);
  });
});

describe("static markup (no JS)", () => {
  test("exactly one GET form with the Apply button, no drawer or dialog", () => {
    const html = renderToStaticMarkup(setup());
    expect(html.match(/<form/g)?.length).toBe(1);
    expect(html).toMatch(/<form(?=[^>]*\smethod="get")(?=[^>]*\saction="\/search")[^>]*>/);
    expect(html.match(/type="submit"/g)?.length).toBe(1);
    expect(html).toContain("Apply filters");
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("Filters (");
    expect(html).not.toContain("data-filter-toggle");
    expect(html).toContain('<aside aria-label="Filters"');
    // The aside is not hidden at small widths without JS.
    expect(html).not.toMatch(/<aside[^>]*class="[^"]*\bhidden\b/);
  });

  test("hostile base falls back to /", () => {
    const html = renderToStaticMarkup(setup({ base: "javascript:alert(1)" }));
    expect(html).toMatch(/<form(?=[^>]*\smethod="get")(?=[^>]*\saction="\/")[^>]*>/);
  });

  test("id goes on the wrapper only", () => {
    const html = renderToStaticMarkup(setup({ id: "filters" }));
    expect(html.match(/id="filters"/g)?.length).toBe(1);
  });
});

describe("form contents", () => {
  test("hidden inputs and controls post the expected GET query", () => {
    const { container } = render(setup());
    const form = container.querySelector("aside form") as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(form.getAttribute("method")).toBe("get");
    const data = new FormData(form);
    expect(data.get("q")).toBe("oak desk");
    expect(data.get("dept")).toBe("furniture");
    expect(data.get("category")).toBe("desks");
    expect(data.get("sort")).toBe("price_asc");
    expect(data.get("view")).toBe("list");
    expect(data.get("p")).toBe("x-1");
    expect(data.getAll("brand")).toEqual(["acme"]);
    expect(data.get("min")).toBe("10");
    expect(data.get("max")).toBe("90");
    expect(data.get("instock")).toBe("1");
    expect(data.has("page")).toBe(false);
    // Each managed param is posted once (no hidden duplicate of a control).
    expect(data.getAll("q")).toHaveLength(1);
    expect(data.getAll("min")).toHaveLength(1);
  });

  test("renders all groups with counts, Apply and Reset", () => {
    render(setup({ dealsCount: 4 }));
    const aside = screen.getByRole("complementary", { name: "Filters" });
    const form = within(aside);
    expect(form.getByRole("group", { name: "Category" })).toBeInTheDocument();
    expect(form.getByRole("link", { name: "Chairs (3)" })).toBeInTheDocument();
    expect(form.getByRole("checkbox", { name: "Acme (4)" })).toBeChecked();
    expect(form.getByRole("radiogroup", { name: "Customer review" })).toBeInTheDocument();
    expect(form.getByRole("radio", { name: "4 stars & up (6)" })).toBeInTheDocument();
    expect(form.getByRole("group", { name: "Price" })).toBeInTheDocument();
    expect(form.getByRole("checkbox", { name: "In stock only (7)" })).toBeChecked();
    expect(form.getByRole("checkbox", { name: "Deals only (4)" })).not.toBeChecked();
    expect(form.getByRole("button", { name: "Apply filters" })).toHaveAttribute("type", "submit");
    const reset = form.getByRole("link", { name: "Reset" });
    const qs = queryOf(reset.getAttribute("href"));
    expect(qs.get("q")).toBe("oak desk");
    expect(qs.has("brand")).toBe(false);
    expect(qs.has("page")).toBe(false);
  });

  test("ActiveFilters chips render at the top with the result count", () => {
    render(setup({ resultCount: 12 }));
    const aside = screen.getByRole("complementary", { name: "Filters" });
    expect(within(aside).getByText("(12 results)")).toBeInTheDocument();
    expect(within(aside).getByRole("link", { name: "Remove filter: Brand Acme" })).toBeInTheDocument();
  });

  test("empty facet groups are omitted (Apply and Reset remain)", () => {
    render(setup({ facets: emptyFacets, params: { q: "zzz" } }));
    const aside = screen.getByRole("complementary", { name: "Filters" });
    expect(within(aside).queryByRole("group")).toBeNull();
    expect(within(aside).queryByRole("radiogroup")).toBeNull();
    expect(within(aside).queryByRole("checkbox")).toBeNull();
    expect(within(aside).queryByLabelText("Min price")).toBeNull();
    expect(within(aside).getByRole("button", { name: "Apply filters" })).toBeInTheDocument();
  });

  test("groups whose buckets all have zero count and none selected are omitted", () => {
    const zero: FacetCounts = {
      ...emptyFacets,
      brands: [{ value: "a", label: "A", count: 0, selected: false }],
      categories: [{ value: "c", label: "C", count: 0, selected: false }],
    };
    render(setup({ facets: zero, params: {} }));
    expect(screen.queryByRole("group", { name: "Brand" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Category" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Deals" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Availability" })).toBeNull();
  });

  test("applied filters keep their group so they can be cleared", () => {
    render(setup({ facets: emptyFacets, params: { instock: true, deals: true, min: 5 } }));
    const aside = within(screen.getByRole("complementary", { name: "Filters" }));
    expect(aside.getByRole("checkbox", { name: "In stock only (0)" })).toBeChecked();
    expect(aside.getByRole("checkbox", { name: "Deals only (0)" })).toBeChecked();
    expect(aside.getByLabelText("Min price")).toHaveValue("5");
  });

  test("showCategoryFacet=false hides the category group but keeps category in the form", () => {
    const { container } = render(setup({ showCategoryFacet: false }));
    expect(screen.queryByRole("group", { name: "Category" })).toBeNull();
    const data = new FormData(container.querySelector("aside form") as HTMLFormElement);
    expect(data.get("category")).toBe("desks");
  });

  test("hostile labels render as text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const hostile: FacetCounts = {
      ...facets,
      brands: [{ value: "evil", label: evil, count: 1, selected: true }],
      categories: [{ value: "c", label: "<script>x</script>", count: 1, selected: false }],
    };
    const { container } = render(
      setup({ facets: hostile, params: { brand: ["evil"], category: "c" }, labels: { brand: { evil }, category: { c: "<b>c</b>" } } }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("checkbox", { name: `${evil} (1)` })).toBeInTheDocument();
    expect(screen.getByText(`Brand: ${evil}`)).toBeInTheDocument();
  });
});

type MatchMedia = typeof window.matchMedia;

/** Stubs `matchMedia` so `FILTER_PANEL_DESKTOP_QUERY` matches (desktop) or not (mobile). */
function withViewport<T>(desktop: boolean, run: () => T): T {
  const original: MatchMedia = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === FILTER_PANEL_DESKTOP_QUERY ? desktop : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as MatchMedia;
  try {
    return run();
  } finally {
    window.matchMedia = original;
  }
}

function pill(): HTMLElement {
  const summary = document.querySelector("details[data-filter-panel] > summary");
  if (!(summary instanceof HTMLElement)) throw new Error("no Filter summary");
  return summary;
}

function detailsOf(): HTMLDetailsElement {
  const details = document.querySelector("details[data-filter-panel]");
  if (!(details instanceof HTMLDetailsElement)) throw new Error("no Filter details");
  return details;
}

describe("v3 Filter pill and panel (T157)", () => {
  test("no-JS: closed details; summary reads 'Filter' + badge; the aside and the one GET form sit inside it (L-6)", () => {
    const doc = new DOMParser().parseFromString(`<body>${renderToStaticMarkup(setup())}</body>`, "text/html");
    const details = doc.querySelectorAll("details");
    expect(details).toHaveLength(1);
    const panel = details[0] as HTMLDetailsElement;
    expect(panel.hasAttribute("open")).toBe(false);
    const summary = panel.querySelector(":scope > summary");
    expect(summary?.textContent?.replace(/\s+/g, " ").trim()).toBe("Filter 5");
    expect(summary?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const aside = doc.querySelector('aside[aria-label="Filters"]');
    expect(panel.contains(aside)).toBe(true);
    const form = doc.querySelector("form");
    expect(aside?.contains(form)).toBe(true);
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.querySelector('button[type="submit"]')?.textContent).toContain("Apply");
    // No landmark outside the details panel (L-10).
    expect(doc.querySelectorAll("aside")).toHaveLength(1);
  });

  test("badge equals the applied facet count: none, 3 facets, price only (L-7)", () => {
    const badgeOf = (p: ListingParams) => {
      const doc = new DOMParser().parseFromString(`<body>${renderToStaticMarkup(setup({ params: p }))}</body>`, "text/html");
      const summary = doc.querySelector("summary");
      return { badge: summary?.querySelector("[data-filter-badge]")?.textContent ?? null, text: summary?.textContent?.trim() };
    };
    expect(badgeOf({ q: "oak", sort: "rating", page: 2 })).toEqual({ badge: null, text: "Filter" });
    expect(badgeOf({ brand: ["acme"], rating: 4, instock: true }).badge).toBe("3");
    expect(badgeOf({ min: 10, max: 90 }).badge).toBe("1");
    expect(badgeOf({ max: 90 }).badge).toBe("1");
  });

  test("filterBadgeText", () => {
    expect(filterBadgeText(0)).toBeNull();
    expect(filterBadgeText(-1)).toBeNull();
    expect(filterBadgeText(Number.NaN)).toBeNull();
    expect(filterBadgeText(1.5)).toBeNull();
    expect(filterBadgeText(3)).toBe("3");
    expect(filterBadgeText(1234)).toBe("1,234");
    expect(FILTER_SUMMARY_LABEL).toBe("Filter");
  });

  test("'Clear all' drops facets but keeps q and sort (L-8)", () => {
    render(setup());
    const clear = screen.getByRole("link", { name: "Clear all" });
    const qs = queryOf(clear.getAttribute("href"));
    expect(qs.get("q")).toBe("oak desk");
    expect(qs.get("sort")).toBe("price_asc");
    for (const key of ["category", "brand", "min", "max", "rating", "instock", "deals", "page"]) expect(qs.has(key)).toBe(false);
  });

  test("toolbarEnd renders after the Filter control in the same row, outside the details; forms never nest (L-9)", () => {
    const sort = (
      <form method="get" action="/search" data-testid="sort-form">
        <label htmlFor="s">Sort by</label>
        <select id="s" name="sort" defaultValue="price_asc">
          <option value="price_asc">Price: Low to High</option>
        </select>
      </form>
    );
    const { container } = render(setup({ toolbarEnd: sort }));
    const details = detailsOf();
    const sortForm = screen.getByTestId("sort-form");
    expect(details.contains(sortForm)).toBe(false);
    expect(details.compareDocumentPosition(sortForm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(sortForm.parentElement?.parentElement).toBe(details.parentElement);
    for (const form of container.querySelectorAll("form")) expect(form.parentElement?.closest("form")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Sort by" })).toBeInTheDocument();
  });

  test("no toolbarEnd: no empty trailing wrapper", () => {
    const { container } = render(setup());
    // Row = the details + the (hydrated, closed) Drawer; nothing else.
    expect([...(detailsOf().parentElement?.children ?? [])].map((el) => el.tagName)).toEqual(["DETAILS", "DIALOG"]);
    expect(container.querySelectorAll("form")).toHaveLength(1);
  });

  test("headingLevel: absent = no heading; set = 'Filters' heading at that level, inline panel only", () => {
    const { unmount } = render(setup());
    expect(screen.queryByRole("heading")).toBeNull();
    unmount();
    withViewport(false, () => {
      render(setup({ headingLevel: 3 }));
      const aside = screen.getByRole("complementary", { name: "Filters" });
      expect(within(aside).getByRole("heading", { level: 3, name: "Filters" })).toBeInTheDocument();
      fireEvent.click(pill());
      const drawer = screen.getByRole("dialog", { name: "Filters" });
      expect(within(drawer).queryByRole("heading", { level: 3 })).toBeNull();
    });
  });

  test("dealsCount absent falls back to facets.deals; an explicit dealsCount wins", () => {
    const { unmount } = render(setup({ facets: { ...facets, deals: 6 } }));
    expect(screen.getByRole("checkbox", { name: "Deals only (6)" })).toBeInTheDocument();
    unmount();
    render(setup({ facets: { ...facets, deals: 6 }, dealsCount: 0 }));
    expect(screen.queryByRole("group", { name: "Deals" })).toBeNull();
  });
});

describe("hydrated, below lg: Drawer", () => {
  test("activating the pill opens the Drawer with the form; the details stays closed", () => {
    withViewport(false, () => {
      const original = HTMLDialogElement.prototype.showModal;
      const spy = mock(function (this: HTMLDialogElement) {
        original.call(this);
      });
      HTMLDialogElement.prototype.showModal = spy;
      try {
        const { container } = render(setup());
        // Closed: the form exists once (details panel), the drawer body is empty.
        expect(container.querySelectorAll("form")).toHaveLength(1);
        const dialog = container.querySelector("dialog") as HTMLDialogElement;
        expect(dialog.open).toBe(false);

        const summary = pill();
        fireEvent.click(summary);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(dialog.open).toBe(true);
        expect(detailsOf().open).toBe(false);
        const drawer = screen.getByRole("dialog", { name: "Filters" });
        expect(drawer).toHaveAttribute("data-side", "left");
        const drawerForm = drawer.querySelector("form") as HTMLFormElement;
        expect(drawerForm.getAttribute("method")).toBe("get");
        expect(within(drawer).getByRole("button", { name: "Apply filters" })).toBeInTheDocument();
        expect(within(drawer).getByRole("checkbox", { name: "Acme (4)" })).toBeChecked();
        // The drawer copy is not inside the details/aside landmark.
        expect(drawer.closest("details")).toBeNull();
        expect(drawer.closest("aside")).toBeNull();

        // Two instances while open never share ids.
        const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
        expect(new Set(ids).size).toBe(ids.length);
      } finally {
        HTMLDialogElement.prototype.showModal = original;
      }
    });
  });

  test("Escape closes the Drawer and focus returns to the pill", () => {
    withViewport(false, () => {
      const { container } = render(setup());
      const summary = pill();
      fireEvent.click(summary);
      expectFocused(summary);
      const dialog = container.querySelector("dialog") as HTMLDialogElement;
      const drawer = screen.getByRole("dialog", { name: "Filters" });
      expect(dialog.open).toBe(true);
      pressEscape(dialog);
      expect(dialog.open).toBe(false);
      expect(drawer.querySelector("form")).toBeNull();
      expectFocused(summary);
    });
  });

  test("the Close button closes the Drawer and returns focus", () => {
    withViewport(false, () => {
      render(setup());
      const summary = pill();
      fireEvent.click(summary);
      const dialog = document.querySelector("dialog") as HTMLDialogElement;
      expect(dialog.open).toBe(true);
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      expect(dialog.open).toBe(false);
      expectFocused(summary);
    });
  });
});

describe("hydrated, lg and up: details panel", () => {
  test("the pill toggles the details natively; no Drawer opens", () => {
    withViewport(true, () => {
      const { container } = render(setup());
      const details = detailsOf();
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      pill().dispatchEvent(event);
      // The organism does not cancel the native toggle on desktop.
      expect(event.defaultPrevented).toBe(false);
      expect((container.querySelector("dialog") as HTMLDialogElement).open).toBe(false);
      expect(details.querySelector("aside form")).not.toBeNull();
    });
  });

  test("Escape inside the open panel closes it and returns focus to the pill", () => {
    withViewport(true, () => {
      render(setup());
      const details = detailsOf();
      details.open = true;
      const checkbox = screen.getByRole("checkbox", { name: "Acme (4)" });
      checkbox.focus();
      fireEvent.keyDown(checkbox, { key: "Escape" });
      expect(details.open).toBe(false);
      expectFocused(pill());
    });
  });

  test("Escape on a closed panel and other keys do nothing", () => {
    withViewport(true, () => {
      render(setup());
      const details = detailsOf();
      const summary = pill();
      summary.focus();
      fireEvent.keyDown(summary, { key: "Escape" });
      expect(details.open).toBe(false);
      details.open = true;
      fireEvent.keyDown(summary, { key: "Enter" });
      expect(details.open).toBe(true);
    });
  });

  test("isDesktopViewport: true without matchMedia (native details fallback)", () => {
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", { value: undefined, configurable: true, writable: true });
    try {
      expect(isDesktopViewport()).toBe(true);
    } finally {
      Object.defineProperty(window, "matchMedia", { value: original, configurable: true, writable: true });
    }
    expect(withViewport(false, () => isDesktopViewport())).toBe(false);
    expect(withViewport(true, () => isDesktopViewport())).toBe(true);
  });
});

describe("source hygiene", () => {
  test("tokens only, no inline styles, no server runtime imports, toggle is the only client file", () => {
    const sidebar = readFileSync(join(import.meta.dir, "FilterSidebar.tsx"), "utf8");
    const toggle = readFileSync(join(import.meta.dir, "FilterDrawerToggle.tsx"), "utf8");
    expect(sidebar.startsWith('"use client"')).toBe(false);
    expect(toggle.startsWith('"use client"')).toBe(true);
    for (const src of [sidebar, toggle]) {
      expect(src).not.toContain("style={");
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/^import (?!type)[^;]*@\/server/m);
      expect(src).not.toMatch(/\[[^\]]*\d+px\]/);
      expect(src).not.toContain("useEffect");
    }
  });
});

describe("route defaultSort (CONS-B1 consistency ac)", () => {
  const featured: ListingParams = { sort: "featured", instock: true, page: 2 };

  test("hidden inputs and Reset keep sort=featured when the route default is best_selling", () => {
    expect(filterHiddenEntries(featured, { defaultSort: "best_selling" })).toEqual([["sort", "featured"]]);
    expect(filterResetHref("/best-sellers", featured, { defaultSort: "best_selling" })).toBe("/best-sellers?sort=featured");
    // Without a route default, featured is the global default and is omitted.
    expect(filterHiddenEntries(featured)).toEqual([]);
    expect(filterResetHref("/products", featured)).toBe("/products");
    // The route default itself is omitted.
    expect(filterHiddenEntries({ sort: "best_selling" }, { defaultSort: "best_selling" })).toEqual([]);
  });

  test("the rendered form posts sort=featured on a best_selling route", () => {
    const html = renderToStaticMarkup(
      setup({ params: featured, base: "/best-sellers", defaultSort: "best_selling" }),
    );
    const doc = document.implementation.createHTMLDocument("t");
    doc.body.innerHTML = html;
    const form = doc.querySelector("form");
    expect(form?.querySelector('input[type="hidden"][name="sort"][value="featured"]')).not.toBeNull();
    const reset = [...doc.querySelectorAll("a")].find((a) => a.textContent === "Reset");
    expect(reset?.getAttribute("href")).toBe("/best-sellers?sort=featured");
  });
  test("forwards defaultSort to the facet molecules: every link keeps sort=featured (CONS-B5 bo)", () => {
    const filtered: ListingParams = { category: "desks", brand: ["acme"], min: 10, max: 90, rating: 4, instock: true };
    const linksOf = (html: string): string[] => {
      const doc = document.implementation.createHTMLDocument("t");
      doc.body.innerHTML = html;
      return [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    };
    const sortOf = (href: string) => new URL(href, "http://h.invalid").searchParams.get("sort");

    const kept = linksOf(
      renderToStaticMarkup(setup({ params: { ...filtered, sort: "featured" }, base: "/best-sellers", defaultSort: "best_selling" })),
    );
    // 5 remove chips + Clear all, 2 category links, 2 price presets, Reset.
    expect(kept).toHaveLength(11);
    for (const href of kept) expect(sortOf(href)).toBe("featured");

    const elided = linksOf(
      renderToStaticMarkup(setup({ params: { ...filtered, sort: "best_selling" }, base: "/best-sellers", defaultSort: "best_selling" })),
    );
    for (const href of elided) expect(sortOf(href)).toBeNull();

    // No defaultSort: featured is the global default and is elided everywhere (old behaviour).
    const legacy = linksOf(renderToStaticMarkup(setup({ params: { ...filtered, sort: "featured" }, base: "/products" })));
    for (const href of legacy) expect(sortOf(href)).toBeNull();
  });
});
