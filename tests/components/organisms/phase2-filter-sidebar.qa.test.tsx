// QA (QA-W4-organisms-C / T90): T79 FilterSidebar + FilterDrawerToggle.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { safeListingBase, type ListingParams } from "@/components/molecules/_listing-url";
import {
  FILTER_PANEL_DESKTOP_QUERY,
  FilterSidebar,
  activeFilterCount,
  filterHiddenEntries,
  filterResetHref,
  filtersButtonLabel,
  type FilterSidebarProps,
} from "@/components/organisms/FilterSidebar";
import { isAllowedInternalHref } from "@/content/routes";
import type { FacetCounts } from "@/server/catalog/listing-service";
import { expectFocused } from "@/test/dom-assertions";

const SRC = join(import.meta.dir, "../../../src/components/organisms/FilterSidebar");

const FACETS: FacetCounts = {
  categories: [
    { value: "desks", label: "Desks", count: 5, selected: true },
    { value: "chairs", label: "Chairs", count: 3, selected: false },
  ],
  brands: [
    { value: "acme", label: "Acme", count: 4, selected: true },
    { value: "globex", label: "Globex", count: 2, selected: false },
    { value: "initech", label: "Initech", count: 0, selected: false },
  ],
  price: [
    { value: { minCents: 0, maxCents: 2499 }, label: "Under $25", count: 3, selected: false },
    { value: { minCents: 2500, maxCents: 4999 }, label: "$25 to $50", count: 2, selected: false },
    { value: { minCents: 25000, maxCents: null }, label: "$250 & above", count: 1, selected: false },
  ],
  rating: [
    { value: 4, label: "4 stars & up", count: 6, selected: true },
    { value: 3, label: "3 stars & up", count: 8, selected: false },
  ],
  inStock: 7,
  deals: 0,
};

const EMPTY: FacetCounts = { categories: [], brands: [], price: [], rating: [], inStock: 0, deals: 0 };

const FULL: ListingParams = {
  q: "oak desk",
  dept: "furniture",
  category: "desks",
  brand: ["acme"],
  min: 10,
  max: 90,
  rating: 4,
  instock: true,
  deals: true,
  sort: "price_asc",
  page: 3,
  view: "list",
  extra: { p: "x-1", utm_source: "mail" },
};

function el(over: Partial<FilterSidebarProps> = {}) {
  return <FilterSidebar facets={FACETS} params={FULL} base="/search" labels={{ brand: { acme: "Acme" } }} {...over} />;
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

function qs(href: string | null): URLSearchParams {
  return new URL(href ?? "", "http://qa.invalid").searchParams;
}

function pressEscape(dialog: HTMLDialogElement) {
  act(() => {
    const event = new Event("cancel", { cancelable: true });
    if (dialog.dispatchEvent(event)) dialog.close();
  });
}

function allClasses(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((n) => (n.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
}

const ALLOWED_NAMES = new Set(["q", "dept", "category", "brand", "min", "max", "rating", "instock", "deals", "sort", "view"]);

describe("T79.1 no-JS static markup", () => {
  test("exactly one <form method=get>, one aside 'Filters', no toggle/dialog/script/inline handlers", () => {
    const html = renderToStaticMarkup(el({ dealsCount: 3 }));
    const doc = parse(html);
    expect(doc.querySelectorAll("form")).toHaveLength(1);
    const form = doc.querySelector("form") as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/search");
    const asides = doc.querySelectorAll("aside");
    expect(asides).toHaveLength(1);
    expect(asides[0]?.getAttribute("aria-label")).toBe("Filters");
    expect(asides[0]?.contains(form)).toBe(true);
    expect(doc.querySelector("dialog")).toBeNull();
    // T157 (v3, pin moved by T164): the Phase 2 `[data-filter-toggle]` button is gone; the
    // no-JS control is exactly one native `<details>`, closed, whose summary reads "Filter".
    const details = doc.querySelectorAll("details");
    expect(details).toHaveLength(1);
    expect(details[0]?.hasAttribute("open")).toBe(false);
    expect(details[0]?.hasAttribute("data-filter-panel")).toBe(true);
    const summary = details[0]?.querySelector(":scope > summary");
    expect(summary?.querySelector("span")?.textContent).toBe("Filter");
    expect(summary?.textContent?.replace(/\s+/g, " ").trim()).toBe("Filter 6");
    expect(details[0]?.contains(form)).toBe(true);
    expect(doc.querySelector('button[type="button"][aria-haspopup]')).toBeNull();
    expect(html).not.toContain("<script");
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
    expect(html).not.toContain("style=");
  });

  test("single submit control: one type=submit 'Apply filters'; Reset is a link", () => {
    const doc = parse(renderToStaticMarkup(el({ dealsCount: 3 })));
    const submits = doc.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])');
    expect(submits).toHaveLength(1);
    expect(submits[0]?.textContent).toContain("Apply filters");
    const reset = [...doc.querySelectorAll("a")].find((a) => a.textContent === "Reset");
    expect(reset?.tagName).toBe("A");
  });

  const BASES: Array<[string, string]> = [
    ["/search", "/search"],
    ["/category/desks", "/category/desks"],
    ["  /deals  ", "/deals"],
    ["/search?evil=1#x", "/search"],
    ["https://evil.example/search", "/"],
    ["//evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["/\\evil.example", "/"],
    ["search", "/"],
    ["", "/"],
  ];
  for (const [base, expected] of BASES) {
    test(`action = safeListingBase(${JSON.stringify(base)}) = ${expected}`, () => {
      expect(safeListingBase(base)).toBe(expected);
      const doc = parse(renderToStaticMarkup(el({ base })));
      expect(doc.querySelector("form")?.getAttribute("action")).toBe(expected);
      for (const a of doc.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") ?? "";
        expect(href.startsWith(expected === "/" ? "/" : expected)).toBe(true);
        expect(href.startsWith("//")).toBe(false);
      }
    });
  }
});

describe("T79.1 hidden inputs", () => {
  test("preserve q/dept/category/sort/view/extra, never page", () => {
    const doc = parse(renderToStaticMarkup(el()));
    const hidden = [...doc.querySelectorAll('input[type="hidden"]')].map((i) => [i.getAttribute("name"), i.getAttribute("value")]);
    expect(hidden).toEqual([
      ["q", "oak desk"],
      ["dept", "furniture"],
      ["category", "desks"],
      ["sort", "price_asc"],
      ["view", "list"],
      ["p", "x-1"],
      ["utm_source", "mail"],
    ]);
  });

  test("page is never posted, even via extra / huge page numbers; reserved extra keys dropped", () => {
    const params: ListingParams = { q: "a", page: 99, extra: { page: "7", _rsc: "abc", brand: "forged", ok: "1" } };
    expect(filterHiddenEntries(params)).toEqual([
      ["q", "a"],
      ["ok", "1"],
    ]);
    const doc = parse(renderToStaticMarkup(el({ params })));
    expect(doc.querySelector('input[name="page"]')).toBeNull();
    expect(doc.querySelector('input[name="_rsc"]')).toBeNull();
    expect(doc.querySelectorAll('input[type="hidden"][name="brand"]')).toHaveLength(0);
  });

  test("hostile q / extra values stay attribute text", () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const doc = parse(renderToStaticMarkup(el({ params: { q: evil, extra: { utm: evil } } })));
    expect(doc.querySelector("img")).toBeNull();
    expect(doc.querySelector('input[name="q"]')?.getAttribute("value")).toBe(evil);
    expect(doc.querySelector('input[name="utm"]')?.getAttribute("value")).toBe(evil);
  });
});

describe("T79.2 group omission and counts", () => {
  function legends(doc: Document | HTMLElement): string[] {
    return [...doc.querySelectorAll("legend")].map((l) => (l.textContent ?? "").trim());
  }

  test("no facets and no params: no groups at all, Apply + Reset remain", () => {
    const doc = parse(renderToStaticMarkup(el({ facets: EMPTY, params: {} })));
    expect(doc.querySelectorAll("fieldset")).toHaveLength(0);
    expect(doc.querySelector('input[name="min"]')).toBeNull();
    expect(doc.querySelector('button[type="submit"]')?.textContent).toContain("Apply filters");
  });

  test("all-zero unselected buckets omit their group (category/brand/rating/price/availability)", () => {
    const zero: FacetCounts = {
      categories: [{ value: "c", label: "C", count: 0, selected: false }],
      brands: [{ value: "b", label: "B", count: 0, selected: false }],
      price: [{ value: { minCents: 0, maxCents: 2499 }, label: "Under $25", count: 0, selected: false }],
      rating: [{ value: 4, label: "4 stars & up", count: 0, selected: false }],
      inStock: 0,
      deals: 0,
    };
    const doc = parse(renderToStaticMarkup(el({ facets: zero, params: { q: "x" } })));
    expect(legends(doc)).toEqual([]);
  });

  test("price group stays while only min or only max is applied", () => {
    for (const params of [{ min: 5 }, { max: 50 }, { min: 0 }] as ListingParams[]) {
      const doc = parse(renderToStaticMarkup(el({ facets: EMPTY, params })));
      expect(legends(doc)).toContain("Price");
    }
  });

  test("Deals: only when dealsCount > 0 (safe integer) or deals applied", () => {
    const cases: Array<[number | undefined, boolean, boolean]> = [
      [undefined, false, false],
      [0, false, false],
      [-3, false, false],
      [1.5, false, false],
      [Number.NaN, false, false],
      [Number.POSITIVE_INFINITY, false, false],
      [2, false, true],
      [undefined, true, true],
      [0, true, true],
    ];
    for (const [dealsCount, deals, shown] of cases) {
      const doc = parse(renderToStaticMarkup(el({ facets: EMPTY, params: deals ? { deals: true } : {}, dealsCount })));
      expect(legends(doc).includes("Deals")).toBe(shown);
    }
  });

  test("counts are shown as text on every option; zero-count option disabled", () => {
    render(el({ dealsCount: 4 }));
    const aside = within(screen.getByRole("complementary", { name: "Filters" }));
    expect(aside.getByRole("checkbox", { name: "Globex (2)" })).toBeEnabled();
    expect(aside.getByRole("checkbox", { name: "Initech (0)" })).toBeDisabled();
    expect(aside.getByRole("link", { name: "Under $25 (3)" })).toBeInTheDocument();
    expect(aside.getByRole("radio", { name: "3 stars & up (8)" })).toBeInTheDocument();
    expect(aside.getByRole("checkbox", { name: "Deals only (4)" })).toBeInTheDocument();
  });
});

describe("T79.4 Reset and counts", () => {
  test("Reset keeps q/sort/view/dept/extra, drops every facet and page", () => {
    render(el());
    const reset = within(screen.getByRole("complementary", { name: "Filters" })).getByRole("link", { name: "Reset" });
    const href = reset.getAttribute("href") ?? "";
    expect(href).toBe(filterResetHref("/search", FULL));
    expect(new URL(href, "http://qa.invalid").pathname).toBe("/search");
    const q = qs(href);
    expect([...q.keys()].sort()).toEqual(["dept", "p", "q", "sort", "utm_source", "view"]);
    expect(q.get("q")).toBe("oak desk");
  });

  test("Reset with q only keeps exactly q", () => {
    expect(filterResetHref("/search", { q: "lamp", brand: ["a"], page: 4, min: 1 })).toBe("/search?q=lamp");
  });

  test("activeFilterCount: price range counts once; invalid values never count", () => {
    expect(activeFilterCount({ min: 1, max: 9 })).toBe(1);
    expect(activeFilterCount({ min: 1 })).toBe(1);
    expect(activeFilterCount({ max: 9 })).toBe(1);
    expect(activeFilterCount(FULL)).toBe(6); // category, brand, price, rating, instock, deals
    expect(activeFilterCount({ brand: ["a", "a", " a "] })).toBe(1);
    expect(activeFilterCount({ rating: 7, min: -1, max: 1.5, brand: [""], category: "  " })).toBe(0);
    expect(activeFilterCount({ q: "x", dept: "d", sort: "rating", view: "list", page: 3, extra: { p: "1" } })).toBe(0);
  });

  test("filtersButtonLabel", () => {
    expect(filtersButtonLabel(0)).toBe("Filters");
    expect(filtersButtonLabel(1)).toBe("Filters (1)");
    expect(filtersButtonLabel(1234)).toBe("Filters (1,234)");
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(filtersButtonLabel(bad)).toBe("Filters");
  });
});

type MatchMedia = typeof window.matchMedia;

/** T164: stub `matchMedia` so `FILTER_PANEL_DESKTOP_QUERY` matches (desktop) or not (below lg). */
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

function filterSummary(root: ParentNode = document): HTMLElement {
  const summary = root.querySelector("details[data-filter-panel] > summary");
  if (!(summary instanceof HTMLElement)) throw new Error("no Filter summary");
  return summary;
}

function squash(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

describe("T79.1/T79.3 hydrated small-screen drawer (v3 pins moved by T164: details > summary pill)", () => {
  test("trigger shows active count: details[data-filter-panel] > summary reads 'Filter 6', badge '6'; native summary (keyboard operable)", () => {
    const { container } = render(el());
    const summary = filterSummary(container);
    expect(summary.tagName).toBe("SUMMARY");
    expect(squash(summary.textContent)).toBe("Filter 6");
    expect(summary.querySelector("[data-filter-badge]")?.textContent).toBe("6");
    const details = summary.parentElement as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // The summary is the details' first child, so it is natively focusable / toggled by Enter and Space.
    expect(details.firstElementChild === summary).toBe(true);
  });

  test("below lg: click the summary -> Drawer 'Filters' with the same form; Escape closes and returns focus; ids unique while open", () => {
    withViewport(false, () => {
      const { container } = render(el({ dealsCount: 2 }));
      const summary = filterSummary(container);
      summary.focus();
      fireEvent.click(summary);
      const dialog = container.querySelector("dialog") as HTMLDialogElement;
      expect(dialog.open).toBe(true);
      expect((summary.parentElement as HTMLDetailsElement).open).toBe(false);
      const drawer = screen.getByRole("dialog", { name: "Filters" });
      const forms = container.querySelectorAll("form");
      expect(forms).toHaveLength(2);
      const drawerForm = drawer.querySelector("form") as HTMLFormElement;
      const asideForm = container.querySelector("aside form") as HTMLFormElement;
      expect(drawerForm.getAttribute("action")).toBe("/search");
      expect(drawerForm.getAttribute("method")).toBe("get");
      expect([...new FormData(drawerForm).entries()]).toEqual([...new FormData(asideForm).entries()]);
      const ids = [...container.querySelectorAll("[id]")].map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      // label[for] and aria-describedby/labelledby inside the drawer point inside the drawer.
      for (const label of drawer.querySelectorAll("label[for]")) {
        const target = document.getElementById(label.getAttribute("for") ?? "");
        expect(target).not.toBeNull();
        expect(drawer.contains(target)).toBe(true);
      }
      pressEscape(dialog);
      expect(dialog.open).toBe(false);
      expectFocused(summary);
      expect(container.querySelectorAll("form")).toHaveLength(1);
    });
  });

  test("below lg: Close button closes and returns focus to the summary", () => {
    withViewport(false, () => {
      const { container } = render(el());
      const summary = filterSummary(container);
      summary.focus();
      fireEvent.click(summary);
      const dialog = container.querySelector("dialog") as HTMLDialogElement;
      expect(dialog.open).toBe(true);
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      expect(dialog.open).toBe(false);
      expectFocused(summary);
    });
  });

  test("hydrated: still exactly one form while closed, summary reads 'Filter' with no badge when no filters", () => {
    const { container } = render(el({ params: { q: "x" } }));
    expect(container.querySelectorAll("form")).toHaveLength(1);
    const summary = filterSummary(container);
    expect(squash(summary.textContent)).toBe("Filter");
    expect(summary.querySelector("[data-filter-badge]")).toBeNull();
  });
});

describe("T79 FormData shape", () => {
  test("submitted names are only listing params (+ extra keys); never page", () => {
    const { container } = render(el({ dealsCount: 2 }));
    const form = container.querySelector("aside form") as HTMLFormElement;
    const names = [...new FormData(form).keys()];
    for (const name of names) expect(ALLOWED_NAMES.has(name) || name === "p" || name === "utm_source").toBe(true);
    expect(names).not.toContain("page");
    const data = new FormData(form);
    expect(data.getAll("q")).toEqual(["oak desk"]);
    expect(data.getAll("category")).toEqual(["desks"]);
    expect(data.getAll("brand")).toEqual(["acme"]);
    expect(data.getAll("rating")).toEqual(["4"]);
    expect(data.getAll("deals")).toEqual(["1"]);
    expect(data.getAll("instock")).toEqual(["1"]);
  });

  test("observation (accepted by ruling): empty filters post min=&max=&rating=", () => {
    const unselected: FacetCounts = { ...FACETS, rating: FACETS.rating.map((b) => ({ ...b, selected: false })) };
    const { container } = render(el({ facets: unselected, params: {} }));
    const data = new FormData(container.querySelector("aside form") as HTMLFormElement);
    expect(data.get("min")).toBe("");
    expect(data.get("max")).toBe("");
    expect(data.get("rating")).toBe("");
    expect(data.has("page")).toBe(false);
  });
});

describe("T79 hostile text, hrefs, 320px, source hygiene", () => {
  test("hostile facet labels / chip labels render as text (static and hydrated)", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const facets: FacetCounts = {
      ...FACETS,
      brands: [{ value: "evil", label: evil, count: 1, selected: true }],
      categories: [{ value: "c", label: evil, count: 2, selected: false }],
      rating: [{ value: 4, label: evil, count: 1, selected: false }],
    };
    const props = { facets, params: { brand: ["evil"], category: "c" }, labels: { brand: { evil }, category: { c: evil } } };
    const html = renderToStaticMarkup(el(props));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    const { container } = render(el(props));
    expect(container.querySelector("img, script")).toBeNull();
    expect(screen.getAllByText(`Brand: ${evil}`).length).toBeGreaterThan(0);
  });

  for (const base of ["/search", "/category/desks", "/brand/acme", "/deals", "/products"]) {
    test(`every href passes isAllowedInternalHref for base ${base}`, () => {
      const doc = parse(renderToStaticMarkup(el({ base, dealsCount: 3 })));
      const hrefs = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
      expect(hrefs.length).toBeGreaterThan(5);
      for (const href of hrefs) expect(isAllowedInternalHref(href)).toBe(true);
      expect(isAllowedInternalHref(doc.querySelector("form")?.getAttribute("action") ?? "")).toBe(true);
    });
  }

  test("320px: no arbitrary or fixed widths without a breakpoint in the rendered panel", () => {
    const { container } = render(el({ dealsCount: 3 }));
    const aside = container.querySelector("aside") as HTMLElement;
    for (const cls of allClasses(aside)) {
      expect(cls).not.toMatch(/\[/);
      expect(cls).not.toMatch(/^(w|min-w)-([1-9]|px)/);
    }
  });

  test("source: no runtime src/server import, no style=, no dangerouslySetInnerHTML, no any/ts-ignore", () => {
    for (const file of ["FilterSidebar.tsx", "FilterDrawerToggle.tsx", "index.ts"]) {
      const src = readFileSync(join(SRC, file), "utf8");
      expect(src).not.toMatch(/^import (?!type )[^;]*["']@\/server/m);
      expect(src).not.toMatch(/style=\{/);
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src).not.toMatch(/@ts-ignore|@ts-expect-error|eslint-disable/);
    }
  });
});

describe("T79 observations (not defects: inconsistent props, page parser owns consistency)", () => {
  test("applied brand/rating whose control is not rendered is not preserved by Apply", () => {
    const facets: FacetCounts = { ...EMPTY, brands: [], rating: [] };
    const { container } = render(el({ facets, params: { q: "x", brand: ["ghost"], rating: 4 } }));
    const data = new FormData(container.querySelector("aside form") as HTMLFormElement);
    expect(data.has("brand")).toBe(false);
    expect(data.has("rating")).toBe(false);
    // ...while the chip still shows it as applied.
    expect(screen.getAllByText("Brand: ghost").length).toBeGreaterThan(0);
  });
});
