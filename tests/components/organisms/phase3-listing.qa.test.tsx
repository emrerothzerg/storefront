// QA (T164, Phase 3 wave B2): listing organisms against T156/T157 (and T158 when it lands)
// acceptance criteria and CONTRACTS L rows. FilterSidebar v3, ProductGrid v3 + placePromos,
// ListView restyle. DOM nodes never go into `expect` inside waitFor (see @/test/dom-assertions).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_PRESERVED_KEYS, parseListingParams } from "@/app/_listing/parse-params";
import type { ListingParams } from "@/components/molecules/_listing-url";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import {
  FILTER_PANEL_DESKTOP_QUERY,
  FilterSidebar,
  filterResetHref,
  type FilterSidebarProps,
} from "@/components/organisms/FilterSidebar";
import { ListView, type ListViewActions, type OwnerListViewProps, type SharedListViewProps } from "@/components/organisms/ListView";
import {
  MAX_PROMO_SLOTS,
  PRODUCT_GRID_CARD_CLASS,
  PRODUCT_GRID_CLASSES,
  ProductGrid,
  placePromos,
  selectPromoSlots,
  type ProductGridPromoSlot,
} from "@/components/organisms/ProductGrid";
import { isFacetedForRoute } from "@/app/_listing/listing-page";
import { LISTING_HEADING_ID, ListingTemplate, type ListingTemplateProps } from "@/components/templates/ListingTemplate";
import { isAllowedInternalHref } from "@/content/routes";
import type { Product } from "@/lib/types";
import type { FacetCounts, ProductListItem } from "@/server/catalog/listing-service";
import type { ListItemView, ListView as ListViewData } from "@/server/lists/list-service";
import { expectFocused } from "@/test/dom-assertions";

const ORG = join(import.meta.dir, "../../../src/components/organisms");
const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; "q" 's' ‮evil`;
/** Built at runtime so this file never contains the literal light-only guard string. */
const DARK_PREFIX = ["da", "rk:"].join("");

const parse = (html: string): Document => new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
const doc = (el: ReactElement): Document => parse(renderToStaticMarkup(el));
const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function allClasses(root: ParentNode): string[] {
  const nodes = root instanceof Element ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
  return nodes.flatMap((n) => (n.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
}

/** No `dark:` variants, no arbitrary values (`[...]`), no palette colours (tokens only). */
function expectTokenOnlyClasses(root: ParentNode, where: string) {
  const bad = allClasses(root).filter(
    (c) =>
      c.includes(DARK_PREFIX) ||
      /\[/.test(c) ||
      /(^|:)(bg|text|border|ring|fill|stroke)-(red|blue|green|gray|slate|zinc|neutral|stone|orange|amber|yellow|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)-\d/.test(c),
  );
  expect({ where, bad }).toEqual({ where, bad: [] });
}

/** Hostile text stayed text: no injected element (React's own form-replay `<script>` is allowed; it never contains user text). */
function expectNoInjectedMarkup(html: string) {
  const d = parse(html);
  expect(d.querySelectorAll('img[src="x"], img[onerror]')).toHaveLength(0);
  for (const sc of d.querySelectorAll("script")) expect(sc.textContent?.includes("alert(")).toBe(false);
}

function expectBrandFree(html: string) {
  const lower = html.toLowerCase();
  for (const word of ["kmart", "onepass", "afterpay", "zip pay"]) expect({ word, found: lower.includes(word) }).toEqual({ word, found: false });
  // "target" also occurs in React's form-replay script (`a.target`), so only visible text is checked for it.
  const body = parse(html).body;
  for (const sc of body.querySelectorAll("script")) sc.remove();
  const text = (body.textContent ?? "").toLowerCase();
  expect({ word: "target", found: /\btarget\b/.test(text) }).toEqual({ word: "target", found: false });
}

type MatchMedia = typeof window.matchMedia;
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

// ---------------------------------------------------------------------------
// FilterSidebar v3 (T157; CONTRACTS L-5..L-10)
// ---------------------------------------------------------------------------

const FACETS: FacetCounts = {
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
    { value: 4, label: "4 stars & up", count: 6, selected: true },
    { value: 3, label: "3 stars & up", count: 8, selected: false },
  ],
  inStock: 7,
  deals: 4,
};

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

function sidebar(over: Partial<FilterSidebarProps> = {}) {
  return <FilterSidebar facets={FACETS} params={FULL} base="/search" labels={{ brand: { acme: "Acme" } }} {...over} />;
}

function summaryOf(root: ParentNode = document): HTMLElement {
  const s = root.querySelector("details[data-filter-panel] > summary");
  if (!(s instanceof HTMLElement)) throw new Error("no Filter summary");
  return s;
}

/** Listing vocabulary from parse-params.ts: managed keys + repeated `brand` + preserved extras. */
const VOCAB = new Set(["q", "dept", "category", "brand", "min", "max", "rating", "instock", "deals", "sort", "page", "view", ...DEFAULT_PRESERVED_KEYS]);

function formRecord(form: HTMLFormElement): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new FormData(form).entries()) {
    const value = String(v);
    const prev = out[k];
    out[k] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value];
  }
  return out;
}

describe("T157 FilterSidebar v3: no-JS structure (L-6, L-10)", () => {
  test("one closed details[data-filter-panel]; summary first child = pill 'Filter' + badge; aside + ONE GET form inside; no dialog", () => {
    const d = doc(sidebar());
    const details = d.querySelectorAll("details");
    expect(details).toHaveLength(1);
    const panel = details[0] as HTMLDetailsElement;
    expect(panel.hasAttribute("open")).toBe(false);
    expect(panel.hasAttribute("data-filter-panel")).toBe(true);
    const summary = panel.firstElementChild;
    expect(summary?.tagName).toBe("SUMMARY");
    expect(squash(summary?.textContent)).toBe("Filter 6");
    expect(summary?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const classes = (summary?.getAttribute("class") ?? "").split(/\s+/);
    for (const cls of ["rounded-full", "min-h-touch", "list-none", "cursor-pointer"]) expect({ cls, has: classes.includes(cls) }).toEqual({ cls, has: true });
    const forms = d.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    const form = forms[0] as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/search");
    const aside = d.querySelector('aside[aria-label="Filters"]');
    expect(aside?.contains(form)).toBe(true);
    expect(panel.contains(aside)).toBe(true);
    expect(d.querySelectorAll("aside")).toHaveLength(1);
    expect(d.querySelector("dialog")).toBeNull();
    expect(d.querySelector('[role="complementary"]:not(aside)')).toBeNull();
    // Exactly one submit ("Apply filters"), inside the details.
    const submits = d.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])');
    expect(submits).toHaveLength(1);
    expect(squash(submits[0]?.textContent)).toBe("Apply filters");
  });

  test("toolbar adds no headings by default (L-5); headingLevel puts exactly one 'Filters' heading in the inline panel", () => {
    expect(doc(sidebar()).querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(0);
    for (const level of [2, 3, 4, 5, 6] as const) {
      const d = doc(sidebar({ headingLevel: level }));
      const hs = d.querySelectorAll("h1, h2, h3, h4, h5, h6");
      expect(hs).toHaveLength(1);
      expect(hs[0]?.tagName).toBe(`H${level}`);
      expect(hs[0]?.textContent).toBe("Filters");
      expect(d.querySelector("aside")?.contains(hs[0] ?? null)).toBe(true);
    }
  });

  test("unsafe base falls back to '/' for the form action; the pill still renders", () => {
    for (const base of ["javascript:alert(1)", "//evil.example", "https://evil.example/x", ""]) {
      const d = doc(sidebar({ base }));
      expect(d.querySelector("form")?.getAttribute("action")).toBe("/");
      expect(d.querySelectorAll("details[data-filter-panel]")).toHaveLength(1);
      for (const a of d.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
  });
});

describe("T157 badge count (T157 AC2, L-7)", () => {
  const badgeOf = (params: ListingParams) => {
    const s = summaryOf(doc(sidebar({ params })));
    return { badge: s.querySelector("[data-filter-badge]")?.textContent ?? null, text: squash(s.textContent) };
  };
  test("none -> 'Filter' and no badge (q/sort/view/page/dept/extra are not filters)", () => {
    expect(badgeOf({})).toEqual({ badge: null, text: "Filter" });
    expect(badgeOf({ q: "x", sort: "rating", view: "list", page: 4, dept: "furniture", extra: { p: "a" } })).toEqual({ badge: null, text: "Filter" });
  });
  test("3 facets -> '3'", () => {
    expect(badgeOf({ brand: ["acme"], rating: 4, instock: true })).toEqual({ badge: "3", text: "Filter 3" });
  });
  test("price only (min+max, min only, max only) -> '1'", () => {
    for (const p of [{ min: 10, max: 90 }, { min: 10 }, { max: 90 }]) expect(badgeOf(p)).toEqual({ badge: "1", text: "Filter 1" });
  });
  test("two brand values count as two applied values", () => {
    expect(badgeOf({ brand: ["acme", "globex"] }).badge).toBe("2");
  });
});

describe("T164 AC2: filter form params equal the parse-params.ts vocabulary and round-trip", () => {
  test("every submitted name is in the parse-params vocabulary; never page; round-trip through parseListingParams keeps the state (page dropped)", () => {
    const { container } = render(sidebar());
    const form = container.querySelector("aside form") as HTMLFormElement;
    const record = formRecord(form);
    for (const name of Object.keys(record)) expect({ name, known: VOCAB.has(name) }).toEqual({ name, known: true });
    expect(Object.keys(record)).not.toContain("page");
    const { params, ignored } = parseListingParams(record);
    const expected: ListingParams = { ...FULL };
    delete expected.page;
    expect(params).toEqual(expected);
    expect(ignored).toEqual([]);
  });

  test("with nothing applied the form posts only empty optional fields, which the parser ignores as 'empty'", () => {
    const unselected: FacetCounts = { ...FACETS, rating: FACETS.rating.map((b) => ({ ...b, selected: false })), categories: FACETS.categories.map((b) => ({ ...b, selected: false })), brands: FACETS.brands.map((b) => ({ ...b, selected: false })) };
    const { container } = render(sidebar({ facets: unselected, params: { q: "lamp" } }));
    const record = formRecord(container.querySelector("aside form") as HTMLFormElement);
    const { params, ignored } = parseListingParams(record);
    expect(params).toEqual({ q: "lamp" });
    for (const entry of ignored) expect(entry.reason).toBe("empty");
  });

  test("hostile q survives as a hidden input value (text, not markup)", () => {
    const html = renderToStaticMarkup(sidebar({ params: { q: HOSTILE, brand: ["acme"] } }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    const d = parse(html);
    expect(d.querySelector('input[type="hidden"][name="q"]')?.getAttribute("value")).toBe(HOSTILE);
  });
});

describe("T157 AC3 / L-8: 'Clear all' and 'Reset' drop facets, keep q and sort", () => {
  const params: ListingParams = { q: "lamp", sort: "price_desc", brand: ["acme"], min: 5, max: 50, rating: 4, instock: true, deals: true, category: "desks", page: 2 };
  test("both links keep exactly q + sort (+ path)", () => {
    render(sidebar({ params }));
    const aside = within(screen.getByRole("complementary", { name: "Filters" }));
    for (const name of ["Clear all", "Reset"]) {
      const href = aside.getByRole("link", { name }).getAttribute("href") ?? "";
      const url = new URL(href, "http://qa.invalid");
      expect({ name, path: url.pathname, keys: [...url.searchParams.keys()].sort() }).toEqual({ name, path: "/search", keys: ["q", "sort"] });
      expect(url.searchParams.get("q")).toBe("lamp");
      expect(url.searchParams.get("sort")).toBe("price_desc");
    }
  });
});

describe("T157 toolbarEnd (L-9): outside the details, forms never nest, sort after the Filter control", () => {
  const sortForm = (
    <form method="get" action="/search" aria-label="Sort results">
      <label htmlFor="qa-sort">Sort by</label>
      <select id="qa-sort" name="sort" defaultValue="featured">
        <option value="featured">Featured</option>
      </select>
    </form>
  );
  test("sort form follows the details in DOM order, is not inside it, and no form contains another form", () => {
    const d = doc(sidebar({ toolbarEnd: sortForm }));
    const details = d.querySelector("details[data-filter-panel]") as Element;
    const sort = d.querySelector('form[aria-label="Sort results"]') as Element;
    expect(details.contains(sort)).toBe(false);
    expect(Boolean(details.compareDocumentPosition(sort) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    for (const f of d.querySelectorAll("form")) expect(f.querySelector("form")).toBeNull();
    expect(d.querySelectorAll("form")).toHaveLength(2);
    // Sort control keeps its label.
    expect(d.querySelector('label[for="qa-sort"]')?.textContent).toBe("Sort by");
  });
  test("hydrated + Drawer open below lg: still no nested forms", () => {
    withViewport(false, () => {
      const { container } = render(sidebar({ toolbarEnd: sortForm }));
      fireEvent.click(summaryOf(container));
      expect(container.querySelectorAll("form")).toHaveLength(3);
      for (const f of container.querySelectorAll("form")) expect(f.querySelector("form")).toBeNull();
    });
  });
  test("no toolbarEnd (undefined / null): no empty end wrapper", () => {
    for (const toolbarEnd of [undefined, null]) {
      const d = doc(sidebar({ toolbarEnd }));
      const row = d.querySelector("details[data-filter-panel]")?.parentElement;
      expect(row?.children).toHaveLength(1);
    }
  });
});

describe("T157 AC4: Escape and focus return (hydrated)", () => {
  test("below lg: summary click opens the Drawer (details stays closed); Escape closes, focus back on the summary", () => {
    withViewport(false, () => {
      const { container } = render(sidebar());
      const summary = summaryOf(container);
      fireEvent.click(summary);
      const dialog = container.querySelector("dialog") as HTMLDialogElement;
      expect(dialog.open).toBe(true);
      expect((summary.parentElement as HTMLDetailsElement).open).toBe(false);
      expect(within(screen.getByRole("dialog", { name: "Filters" })).getAllByRole("heading", { name: "Filters" })).toHaveLength(1);
      act(() => {
        const cancel = new Event("cancel", { cancelable: true });
        if (dialog.dispatchEvent(cancel)) dialog.close();
      });
      expect(dialog.open).toBe(false);
      expectFocused(summary);
    });
  });
  test("from lg: native details; Escape from a control inside closes it and focuses the summary", () => {
    withViewport(true, () => {
      const { container } = render(sidebar());
      const summary = summaryOf(container);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      summary.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      const details = summary.parentElement as HTMLDetailsElement;
      details.open = true;
      const apply = within(details).getByRole("button", { name: "Apply filters" });
      apply.focus();
      fireEvent.keyDown(apply, { key: "Escape" });
      expect(details.open).toBe(false);
      expectFocused(summary);
      expect((container.querySelector("dialog") as HTMLDialogElement).open).toBe(false);
    });
  });
});

describe("T157 defaultSort forwarding (CONS-B1) and dealsCount fallback", () => {
  test("/best-sellers with defaultSort best_selling: a chosen 'featured' survives hidden inputs, Reset, Clear all and facet links", () => {
    const params: ListingParams = { sort: "featured", brand: ["acme"] };
    const { container } = render(sidebar({ base: "/best-sellers", params, defaultSort: "best_selling" }));
    const form = container.querySelector("aside form") as HTMLFormElement;
    expect(new FormData(form).getAll("sort")).toEqual(["featured"]);
    const aside = within(screen.getByRole("complementary", { name: "Filters" }));
    for (const name of ["Reset", "Clear all", "Chairs (3)"]) {
      const href = aside.getByRole("link", { name }).getAttribute("href") ?? "";
      expect({ name, sort: new URL(href, "http://qa.invalid").searchParams.get("sort") }).toEqual({ name, sort: "featured" });
    }
    expect(filterResetHref("/best-sellers", params, { defaultSort: "best_selling" })).toBe("/best-sellers?sort=featured");
  });
  test("without defaultSort, featured (the no-q default) is elided", () => {
    const { container } = render(sidebar({ base: "/products", params: { sort: "featured", brand: ["acme"] } }));
    expect(new FormData(container.querySelector("aside form") as HTMLFormElement).getAll("sort")).toEqual([]);
  });
  test("dealsCount absent -> facets.deals; explicit 0 hides the group unless deals is applied", () => {
    const none: ListingParams = { q: "x" };
    render(sidebar({ params: none }));
    expect(screen.getByRole("checkbox", { name: "Deals only (4)" })).toBeInTheDocument();
    const zero = doc(sidebar({ params: none, dealsCount: 0 }));
    expect([...zero.querySelectorAll("legend")].map((l) => l.textContent)).not.toContain("Deals");
    const noFacet = doc(sidebar({ params: none, facets: { ...FACETS, deals: 0 } }));
    expect([...noFacet.querySelectorAll("legend")].map((l) => l.textContent)).not.toContain("Deals");
    const applied = doc(sidebar({ params: { deals: true }, facets: { ...FACETS, deals: 0 } }));
    expect([...applied.querySelectorAll("legend")].map((l) => l.textContent)).toContain("Deals");
  });
});

describe("T157 cross-cutting: tokens, brand-free, hrefs", () => {
  test("static markup: token-only classes, no inline styles/handlers, brand-free, every href allow-listed", () => {
    const html = renderToStaticMarkup(sidebar({ dealsCount: 3, headingLevel: 2 }));
    const d = parse(html);
    expectTokenOnlyClasses(d.body, "FilterSidebar");
    expect(html).not.toContain("style=");
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
    expectBrandFree(html);
    const hrefs = [...d.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(3);
    for (const h of hrefs) expect({ h, ok: isAllowedInternalHref(h) }).toEqual({ h, ok: true });
  });
  test("panel overlay never forces a fixed width below lg (320px)", () => {
    const d = doc(sidebar());
    const overlay = d.querySelector("details[data-filter-panel] > div");
    const cls = (overlay?.getAttribute("class") ?? "").split(/\s+/);
    for (const c of cls) expect({ c, fixed: /^(w|min-w)-([1-9]|px)/.test(c) }).toEqual({ c, fixed: false });
    expect(cls).toContain("lg:w-96");
  });
});

// ---------------------------------------------------------------------------
// ProductGrid v3 + placePromos (T156; CONTRACTS L-11, L-13, L-14, L-16, L-17, L-28)
// ---------------------------------------------------------------------------

const product = (n: number, over: Partial<Product> = {}): Product => ({
  id: `qa-p-${n}`,
  slug: `qa-product-${n}`,
  name: `QA Product ${n}`,
  description: "",
  priceCents: 1000 + n,
  currency: "USD",
  imageUrl: `/images/qa-${n}.jpg`,
  stock: 5,
  ...over,
});
const products = (count: number) => Array.from({ length: count }, (_, i) => product(i));
const tile = (heading: string, over: Partial<ProductGridPromoSlot["tile"]> = {}): ProductGridPromoSlot["tile"] => ({ heading, cta: { label: "Shop", href: "/deals" }, ...over });
const slot = (afterIndex: number, heading = `T${afterIndex}`, over: Partial<ProductGridPromoSlot["tile"]> = {}): ProductGridPromoSlot => ({ afterIndex, tile: tile(heading, over) });

function shape(entries: ReturnType<typeof placePromos>): string[] {
  return entries.map((e) => (e.kind === "product" ? `p${e.index}` : `promo@${e.afterIndex}`));
}

describe("T164 AC1: placePromos boundaries", () => {
  test("0 products -> nothing, whatever the slots", () => {
    expect(placePromos([], [slot(0), slot(1)], { pageSize: 24 })).toEqual([]);
    expect(selectPromoSlots(0, [slot(0)])).toEqual([]);
  });
  test("1 product: slot at 0 would be last -> dropped; kept only when the page is full (pageSize 1)", () => {
    expect(shape(placePromos([1], [slot(0)]))).toEqual(["p0"]);
    expect(shape(placePromos([1], [slot(0)], { pageSize: 24 }))).toEqual(["p0"]);
    expect(shape(placePromos([1], [slot(0)], { pageSize: 1 }))).toEqual(["p0", "promo@0"]);
  });
  test("slot at 0 -> right after the first product", () => {
    expect(shape(placePromos([1, 2, 3], [slot(0)]))).toEqual(["p0", "promo@0", "p1", "p2"]);
  });
  test("beyond the end / negative / non-integer / NaN afterIndex -> dropped", () => {
    for (const bad of [3, 4, 99, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect({ bad, out: shape(placePromos([1, 2, 3], [slot(bad)], { pageSize: 3 })) }).toEqual({ bad, out: ["p0", "p1", "p2"] });
    }
    // Index of the last product on a full page is allowed.
    expect(shape(placePromos([1, 2, 3], [slot(2)], { pageSize: 3 }))).toEqual(["p0", "p1", "p2", "promo@2"]);
  });
  test("> 3 slots -> exactly MAX_PROMO_SLOTS (3), first three in caller order, placed by position", () => {
    expect(MAX_PROMO_SLOTS).toBe(3);
    const out = placePromos(products(20), [slot(9, "B"), slot(2, "A"), slot(16, "C"), slot(5, "D"), slot(12, "E")]);
    expect(shape(out).filter((s) => s.startsWith("promo"))).toEqual(["promo@2", "promo@9", "promo@16"]);
  });
  test("page 2 (and 0, NaN, 1.5, -1) -> no promos; page 1 / absent -> promos", () => {
    for (const page of [2, 3, 0, -1, 1.5, Number.NaN]) {
      expect({ page, n: placePromos(products(10), [slot(2)], { page }).filter((e) => e.kind === "promo").length }).toEqual({ page, n: 0 });
    }
    expect(placePromos(products(10), [slot(2)], { page: 1 }).filter((e) => e.kind === "promo")).toHaveLength(1);
    expect(placePromos(products(10), [slot(2)]).filter((e) => e.kind === "promo")).toHaveLength(1);
  });
  test("same index twice keeps the first; null/undefined slots and tiles are skipped; isValidTile drops before the cap", () => {
    const out = placePromos(products(10), [slot(2, "first"), slot(2, "second")]);
    expect(out.filter((e) => e.kind === "promo").map((e) => (e.kind === "promo" ? (e.tile as { heading: string }).heading : ""))).toEqual(["first"]);
    const messy = [null, undefined, { afterIndex: 1, tile: null }, slot(3)] as unknown as ProductGridPromoSlot[];
    expect(shape(placePromos(products(6), messy)).filter((s) => s.startsWith("promo"))).toEqual(["promo@3"]);
    const valid = placePromos(products(20), [slot(1, " "), slot(2), slot(4), slot(6), slot(8)], {
      isValidTile: (t) => t.heading.trim() !== "",
    });
    expect(shape(valid).filter((s) => s.startsWith("promo"))).toEqual(["promo@2", "promo@4", "promo@6"]);
  });
  test("null/undefined/non-array slots never throw", () => {
    for (const slots of [null, undefined, {} as unknown as ProductGridPromoSlot[], "x" as unknown as ProductGridPromoSlot[]]) {
      expect(shape(placePromos([1, 2], slots))).toEqual(["p0", "p1"]);
    }
  });
  test("product index counts products only (cardProps / priority / rank never see promos)", () => {
    const out = placePromos(products(8), [slot(0), slot(3)]);
    expect(out.filter((e) => e.kind === "product").map((e) => (e.kind === "product" ? e.index : -1))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

const promoLis = (d: Document) => [...d.querySelectorAll("ul[role='list'] > li")].filter((li) => li.querySelector("article") === null);

describe("T156 ProductGrid v3 rendering", () => {
  test("promo tiles are PromoTile <li> direct children of the same ul[role=list]; product count excludes promos (L-11, AC2)", () => {
    const d = doc(<ProductGrid products={products(12)} promoSlots={[slot(2), slot(5), slot(8)]} />);
    const lists = d.querySelectorAll("ul");
    expect(lists).toHaveLength(1);
    const ul = lists[0] as HTMLUListElement;
    expect(ul.getAttribute("role")).toBe("list");
    const lis = [...ul.children];
    expect(lis.every((li) => li.tagName === "LI")).toBe(true);
    expect(lis).toHaveLength(15);
    expect(d.querySelectorAll("article")).toHaveLength(12);
    const promos = promoLis(d);
    expect(promos.map((li) => lis.indexOf(li))).toEqual([3, 7, 11]);
    for (const li of promos) {
      expect(li.getAttribute("data-promo-span")).toBe("2");
      expect(li.classList.contains("col-span-2")).toBe(true);
      expect(li.querySelectorAll("a")).toHaveLength(1);
    }
  });

  test("span 1 is kept; tile headingLevel 2 is clamped to h3, 4 kept; no h1/h2 anywhere inside the grid (L-17)", () => {
    const d = doc(
      <ProductGrid products={products(10)} promoSlots={[slot(1, "Two", { headingLevel: 2, span: 1 }), slot(4, "Four", { headingLevel: 4 })]} />,
    );
    expect(d.querySelectorAll("h1, h2")).toHaveLength(0);
    const [a, b] = promoLis(d);
    expect(a?.querySelector("h3")?.textContent).toBe("Two");
    expect(a?.classList.contains("col-span-1")).toBe(true);
    expect(b?.querySelector("h4")?.textContent).toBe("Four");
  });

  test("never in list layout; never on page 2; never for an empty grid (empty slot rendered instead, AC4)", () => {
    expect(promoLis(doc(<ProductGrid products={products(10)} promoSlots={[slot(2)]} layout="list" />))).toHaveLength(0);
    expect(promoLis(doc(<ProductGrid products={products(10)} promoSlots={[slot(2)]} page={2} />))).toHaveLength(0);
    const empty = doc(<ProductGrid products={[]} promoSlots={[slot(0)]} emptyState={<p data-qa-empty="">Nothing here</p>} pageSize={24} />);
    expect(empty.querySelector("ul")).toBeNull();
    expect(empty.querySelector("[data-qa-empty]")?.textContent).toBe("Nothing here");
    expect(empty.querySelector("[data-promo-span]")).toBeNull();
    const defaultEmpty = doc(<ProductGrid products={[]} promoSlots={[slot(0)]} />);
    expect(defaultEmpty.querySelector("[data-promo-span]")).toBeNull();
    expect(defaultEmpty.body.textContent).toContain("No products yet");
  });

  test("trailing tile only on a full page (pageSize); blank heading tiles dropped without using up the cap", () => {
    expect(promoLis(doc(<ProductGrid products={products(6)} promoSlots={[slot(5)]} />))).toHaveLength(0);
    expect(promoLis(doc(<ProductGrid products={products(6)} promoSlots={[slot(5)]} pageSize={6} />))).toHaveLength(1);
    const d = doc(<ProductGrid products={products(20)} promoSlots={[slot(1, "   "), slot(2, ""), slot(4), slot(6), slot(8), slot(10)]} />);
    expect(promoLis(d).map((li) => li.querySelector("h3")?.textContent)).toEqual(["T4", "T6", "T8"]);
  });

  test("columns 2 / md 3 / lg 4, never 1 (L-28); product li exactly 'flex min-w-0'; grid cards max-xs:min-w-0, list cards not", () => {
    const d = doc(<ProductGrid products={products(4)} promoSlots={[slot(1)]} />);
    const ul = d.querySelector("ul") as HTMLUListElement;
    expect(ul.className).toBe(PRODUCT_GRID_CLASSES);
    expect(PRODUCT_GRID_CLASSES).toBe("grid min-w-0 grid-cols-2 gap-x-2 gap-y-4 xs:gap-4 md:grid-cols-3 lg:grid-cols-4 lg:gap-6");
    expect([...ul.classList].filter((c) => /(^|:)grid-cols-1$/.test(c))).toEqual([]);
    for (const li of [...ul.children].filter((li) => li.querySelector("article"))) {
      expect(li.className).toBe("flex min-w-0");
      expect(li.querySelector("article")?.classList.contains(PRODUCT_GRID_CARD_CLASS)).toBe(true);
    }
    const list = doc(<ProductGrid products={products(2)} layout="list" />);
    for (const a of list.querySelectorAll("article")) expect(a.classList.contains(PRODUCT_GRID_CARD_CLASS)).toBe(false);
  });

  test("cardProps index and priorityCount count products only, even with a promo at index 0", () => {
    const seen: number[] = [];
    const { container } = render(
      <ProductGrid
        products={products(6)}
        priorityCount={2}
        promoSlots={[slot(0)]}
        cardProps={(p, index) => {
          seen.push(index);
          return {};
        }}
      />,
    );
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    const imgs = [...container.querySelectorAll("article img")];
    expect(imgs).toHaveLength(6);
    const eager = imgs.map((img) => img.getAttribute("loading") !== "lazy");
    expect(eager).toEqual([true, true, false, false, false, false]);
  });

  test("promo with an off-site / script href renders without a link; hostile promo text is text", () => {
    const html = renderToStaticMarkup(
      <ProductGrid
        products={products(8)}
        promoSlots={[slot(1, HOSTILE, { blurb: HOSTILE, cta: { label: HOSTILE, href: "javascript:alert(1)" } }), slot(3, "Off", { cta: { label: "Go", href: "https://evil.example" } })]}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    const d = parse(html);
    const promos = promoLis(d);
    expect(promos).toHaveLength(2);
    for (const li of promos) expect(li.querySelector("a")).toBeNull();
    expect(promos[0]?.querySelector("h3")?.textContent).toBe(HOSTILE);
    for (const a of d.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("token-only classes and brand-free markup", () => {
    const html = renderToStaticMarkup(<ProductGrid products={products(8)} promoSlots={[slot(1), slot(3, "Sale", { tone: "accent" })]} />);
    expectTokenOnlyClasses(parse(html).body, "ProductGrid");
    expectBrandFree(html);
  });
});

// ---------------------------------------------------------------------------
// ListView restyle (T156): behaviour unchanged, pills/chips, aria-current
// ---------------------------------------------------------------------------

const LIST_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-2222-4333-8444-555555555555";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const noopList: ListActionFn = async () => null;
const listActions: ListViewActions = {
  renameList: noopList,
  deleteList: noopList,
  setListSharing: noopList,
  addAllToCart: noopList,
  updateListItem: noopList,
  removeFromList: noopList,
  moveListItem: noopList,
};
function item(n: number, over: Partial<ListItemView> = {}): ListItemView {
  return {
    listId: LIST_ID,
    productId: `qa-p-${n}`,
    quantityDesired: 1,
    priority: 1,
    priceAtAddCents: 1000 + n,
    note: null,
    addedAt: "2026-11-01T00:00:00.000Z",
    product: product(n),
    priceDroppedByCents: null,
    purchasedSinceAdded: false,
    available: true,
    ...over,
  };
}
function listData(items: ListItemView[], over: Partial<ListViewData> = {}): ListViewData {
  return {
    id: LIST_ID,
    name: "Birthday ideas",
    kind: "wishlist",
    isDefault: true,
    isPublic: false,
    shareToken: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    items,
    itemCount: items.length,
    totalCents: items.reduce((s, i) => s + (i.product?.priceCents ?? 0), 0),
    ...over,
  };
}
function owner(over: Partial<OwnerListViewProps> = {}): OwnerListViewProps {
  return {
    mode: "owner",
    list: listData([item(1), item(2)]),
    otherLists: [{ id: OTHER_ID, name: "Other list", itemCount: 1, kind: "wishlist" }],
    actions: listActions,
    sort: "added_desc",
    basePath: `/lists/${LIST_ID}`,
    ...over,
  };
}
function shared(over: Partial<SharedListViewProps> = {}): SharedListViewProps {
  return {
    mode: "shared",
    shared: { name: "Shared ideas", itemCount: 2, items: [item(1), item(2)] },
    sort: "price_desc",
    basePath: `/lists/shared/${TOKEN}`,
    ...over,
  };
}

describe("T156 ListView restyle", () => {
  test("shared: sort is a nav of pill chip links; exactly one aria-current='page' on the current sort; 44px; no forms/inputs", () => {
    const d = doc(<ListView {...shared()} />);
    const nav = d.querySelector('nav[aria-label="Sort list"]') as HTMLElement;
    const links = [...nav.querySelectorAll("a[href]")];
    expect(links.length).toBe(4);
    const current = links.filter((a) => a.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(new URL(current[0]?.getAttribute("href") ?? "", "http://qa.invalid").searchParams.get("sort")).toBe("price_desc");
    for (const a of links) {
      const cls = a.className.split(/\s+/);
      expect({ href: a.getAttribute("href"), pill: cls.includes("rounded-full"), touch: cls.includes("min-h-touch") }).toEqual({ href: a.getAttribute("href"), pill: true, touch: true });
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
    expect(d.querySelector("form, input, select, textarea")).toBeNull();
  });

  test("owner: toolbar is a raised Card (data-slot=list-toolbar) holding the GET sort form; Apply is an outline pill; kind badge is a pill", () => {
    const d = doc(<ListView {...owner()} />);
    const toolbar = d.querySelector('[data-slot="list-toolbar"]') as HTMLElement;
    expect(toolbar).not.toBeNull();
    expect(toolbar.className).toContain("rounded-lg");
    const form = toolbar.querySelector('form[aria-label="Sort list"]') as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe(`/lists/${LIST_ID}`);
    const apply = [...form.querySelectorAll("button")].find((b) => squash(b.textContent) === "Apply");
    expect(apply?.getAttribute("type")).toBe("submit");
    expect(apply?.className.split(/\s+/)).toContain("rounded-full");
    const badge = [...d.querySelectorAll("span")].find((s) => squash(s.textContent) === "Default");
    expect(badge?.className.split(/\s+/)).toContain("rounded-full");
  });

  test("owner no-JS other-lists links are 44px pill chips to /lists/<id>", () => {
    const d = doc(<ListView {...owner()} />);
    const link = [...d.querySelectorAll("a[href]")].find((a) => a.getAttribute("href") === `/lists/${OTHER_ID}`);
    expect(link).toBeDefined();
    const cls = (link?.className ?? "").split(/\s+/);
    expect(cls).toContain("rounded-full");
    expect(cls).toContain("min-h-touch");
  });

  test("empty list: sunken Card empty state with pill links to /products and /best-sellers; no sort form", () => {
    const d = doc(<ListView {...owner({ list: listData([]) })} />);
    expect(d.body.textContent).toContain("This list is empty");
    const hrefs = [...d.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/products");
    expect(hrefs).toContain("/best-sellers");
    expect(d.querySelector('form[aria-label="Sort list"]')).toBeNull();
  });

  test("hostile list name / note render as text; token-only classes; brand-free", () => {
    const html = renderToStaticMarkup(<ListView {...owner({ list: listData([item(1, { note: HOSTILE })], { name: HOSTILE }) })} />);
    expectNoInjectedMarkup(html);
    const d = parse(html);
    expect([...d.querySelectorAll("h1, h2")].some((h) => h.textContent === HOSTILE)).toBe(true);
    expectTokenOnlyClasses(d.body, "ListView owner");
    expectTokenOnlyClasses(doc(<ListView {...shared()} />).body, "ListView shared");
    expectBrandFree(html);
  });
});

// ---------------------------------------------------------------------------
// ListingTemplate v3 (T158; CONTRACTS L-2..L-11, L-13..L-14, L-18..L-20, L-25)
// ---------------------------------------------------------------------------

const listItem = (n: number): ProductListItem => ({ ...product(n) });
const T_FACETS: FacetCounts = { ...FACETS, categories: FACETS.categories.map((b) => ({ ...b, selected: false })), brands: FACETS.brands.map((b) => ({ ...b, selected: false })), rating: FACETS.rating.map((b) => ({ ...b, selected: false })) };
const addToCartNoop = async () => null;
function tProps(over: Partial<ListingTemplateProps> = {}): ListingTemplateProps {
  return {
    title: "Desks",
    breadcrumb: [{ label: "Home", href: "/" }, { label: "Desks" }],
    params: {},
    facets: T_FACETS,
    result: { items: Array.from({ length: 24 }, (_, i) => listItem(i)), total: 60, page: 1, pageCount: 3, pageSize: 24 },
    base: "/category/desks",
    labels: {},
    promoSlots: [slot(2, "Free shipping"), slot(9, "Sale"), slot(16, "Sign up")],
    relatedSearches: [{ query: "standing desk" }, { label: "Chairs", href: "/category/chairs" }],
    feedback: true,
    ...over,
  };
}
const tDoc = (over: Partial<ListingTemplateProps> = {}) => doc(<ListingTemplate {...tProps(over)} />);
const classesOf = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
/** ChipRow names its nav with aria-labelledby (visible label), so find it by the label text. */
function relatedNav(d: Document): Element | null {
  return [...d.querySelectorAll("nav[aria-labelledby]")].find((n) => d.getElementById(n.getAttribute("aria-labelledby") ?? "")?.textContent === "Related searches") ?? null;
}
const gridPromos = (d: Document) => [...d.querySelectorAll("ul[data-layout] > li")].filter((li) => li.querySelector("article") === null);

describe("T158 ListingTemplate v3", () => {
  test("DOM order: breadcrumb -> h1 + count -> related chips -> toolbar (Filter details, then sort, then view toggle) -> grid -> pagination -> feedback", () => {
    const d = tDoc();
    const nodes = [
      d.querySelector('nav[aria-label="Breadcrumb"]'),
      d.getElementById(LISTING_HEADING_ID),
      d.getElementById("listing-result-count"),
      relatedNav(d),
      d.querySelector("details[data-filter-panel]"),
      d.querySelector('select[name="sort"]'),
      d.querySelector('[role="group"][aria-label="View"]'),
      d.querySelector("ul[data-layout]"),
      d.querySelector('nav[aria-label="Listing pages"]'),
      [...d.querySelectorAll("h2")].find((h) => h.textContent === "Did you find what you were looking for?") ?? null,
    ];
    expect(nodes.map((n) => n !== null)).toEqual(nodes.map(() => true));
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1] as Element;
      const cur = nodes[i] as Element;
      expect({ i, follows: Boolean(prev.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING) }).toEqual({ i, follows: true });
    }
    expect(squash(d.getElementById("listing-result-count")?.textContent)).toBe("1–24 of 60 results");
  });

  test("headings: exactly one h1 (#listing-title); outside cards/promos only the sr-only 'Results' h2 and the feedback h2 (L-2, L-5)", () => {
    const d = tDoc();
    const h1s = d.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.id).toBe(LISTING_HEADING_ID);
    const outside = [...d.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter((h) => h.closest("ul[data-layout]") === null);
    expect(outside.map((h) => `${h.tagName}:${h.textContent}`)).toEqual(["H1:Desks", "H2:Results", "H2:Did you find what you were looking for?"]);
    expect(d.querySelectorAll("ul[data-layout] h1, ul[data-layout] h2")).toHaveLength(0);
  });

  test("forms: exactly two GET forms (sort + filters), never nested; with addToCart one POST quick-add per card (L-9, L-12)", () => {
    const d = tDoc();
    const forms = [...d.querySelectorAll("form")];
    expect(forms.map((f) => (f.getAttribute("method") ?? "").toLowerCase())).toEqual(["get", "get"]);
    for (const f of forms) expect(f.querySelector("form")).toBeNull();
    const withAdd = doc(<ListingTemplate {...tProps({ addToCart: addToCartNoop })} />);
    const gets = [...withAdd.querySelectorAll("form")].filter((f) => (f.getAttribute("method") ?? "").toLowerCase() === "get");
    expect(gets).toHaveLength(2);
    for (const f of withAdd.querySelectorAll("form")) expect(f.querySelector("form")).toBeNull();
    const quick = [...withAdd.querySelectorAll("ul[data-layout] form")];
    expect(quick).toHaveLength(24);
    for (const f of quick.slice(0, 3)) {
      expect([...f.querySelectorAll("input[name]")].map((i) => i.getAttribute("name")).sort()).toEqual(["productId", "quantity"]);
    }
  });

  test("no left sidebar: the only aside / complementary is inside the Filter details (L-10)", () => {
    const d = tDoc();
    const asides = [...d.querySelectorAll("aside, [role='complementary']")];
    expect(asides.length).toBeGreaterThan(0);
    for (const a of asides) expect(a.closest("details[data-filter-panel]") !== null).toBe(true);
  });

  test("promo slots forwarded with page: page 1 -> 3 promos at positions 3, 11, 19 with count excluding promos; page 2, list view, or an active facet -> none (L-13..L-16)", () => {
    const d = tDoc();
    const lis = [...d.querySelectorAll("ul[data-layout] > li")];
    expect(lis).toHaveLength(27);
    expect(gridPromos(d).map((li) => lis.indexOf(li))).toEqual([3, 11, 19]);
    expect(squash(d.getElementById("listing-result-count")?.textContent)).toBe("1–24 of 60 results");
    const page2 = tDoc({ params: { page: 2 }, result: { items: Array.from({ length: 24 }, (_, i) => listItem(i + 24)), total: 60, page: 2, pageCount: 3, pageSize: 24 } });
    expect(gridPromos(page2)).toHaveLength(0);
    expect(gridPromos(tDoc({ params: { view: "list" } }))).toHaveLength(0);
    expect(gridPromos(tDoc({ params: { brand: ["acme"] } }))).toHaveLength(0);
    expect(gridPromos(tDoc({ params: { min: 5 } }))).toHaveLength(0);
    // Sort / view-irrelevant params are not facets: promos stay on page 1.
    expect(gridPromos(tDoc({ params: { sort: "price_asc" } }))).toHaveLength(3);
  });

  test("pagination: nav 'Listing pages', current aria-current=page, rel prev/next, pill items, filters kept; absent on a single page (L-18)", () => {
    const params: ListingParams = { brand: ["acme"], sort: "price_asc", page: 2 };
    const d = tDoc({ params, result: { items: Array.from({ length: 24 }, (_, i) => listItem(i)), total: 60, page: 2, pageCount: 3, pageSize: 24 } });
    const nav = d.querySelector('nav[aria-label="Listing pages"]') as HTMLElement;
    expect(squash(nav.querySelector('[aria-current="page"]')?.textContent)).toContain("2");
    const prev = nav.querySelector('a[rel="prev"]');
    const next = nav.querySelector('a[rel="next"]');
    expect(prev).not.toBeNull();
    expect(next).not.toBeNull();
    for (const a of [prev, next]) {
      const url = new URL(a?.getAttribute("href") ?? "", "http://qa.invalid");
      expect(url.pathname).toBe("/category/desks");
      expect(url.searchParams.getAll("brand")).toEqual(["acme"]);
      expect(url.searchParams.get("sort")).toBe("price_asc");
    }
    expect(new URL(next?.getAttribute("href") ?? "", "http://qa.invalid").searchParams.get("page")).toBe("3");
    expect(nav.className).toContain("rounded-full");
    for (const a of nav.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    const single = tDoc({ result: { items: [listItem(0), listItem(1)], total: 2, page: 1, pageCount: 1, pageSize: 24 } });
    expect(single.querySelector('nav[aria-label="Listing pages"]')).toBeNull();
  });

  test("feedback: rendered with results or a search query; not for a 0-result category without q; never when not requested (L-19, L-20)", () => {
    const has = (d: Document) => [...d.querySelectorAll("h2")].some((h) => h.textContent === "Did you find what you were looking for?");
    const zero = { items: [], total: 0, page: 1, pageCount: 0, pageSize: 24 };
    expect(has(tDoc())).toBe(true);
    expect(has(tDoc({ result: zero }))).toBe(false);
    expect(has(tDoc({ result: zero, base: "/search", params: { q: "zzz" } }))).toBe(true);
    expect(has(tDoc({ result: zero, base: "/search", params: { q: "   " } }))).toBe(false);
    expect(has(tDoc({ feedback: false }))).toBe(false);
    expect(has(tDoc({ feedback: undefined }))).toBe(false);
    const d = tDoc();
    const give = [...d.querySelectorAll("a[href]")].find((a) => squash(a.textContent) === "Give feedback");
    expect(give?.getAttribute("href")).toBe("/contact?topic=feedback");
  });

  test("view toggle: two 44px pill links in a 'View' group, the current one aria-current; links keep filters and sort", () => {
    const d = tDoc({ params: { brand: ["acme"], sort: "rating", view: "list" } });
    const group = d.querySelector('[role="group"][aria-label="View"]') as HTMLElement;
    const links = [...group.querySelectorAll("a[href]")];
    expect(links.map((a) => squash(a.textContent))).toEqual(["Grid", "List"]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, "true"]);
    for (const a of links) {
      expect(classesOf(a)).toEqual(expect.arrayContaining(["rounded-full", "min-h-touch"]));
      const url = new URL(a.getAttribute("href") ?? "", "http://qa.invalid");
      expect(url.searchParams.getAll("brand")).toEqual(["acme"]);
      expect(url.searchParams.get("sort")).toBe("rating");
    }
  });

  test("related chips: nav 'Related searches' of links (search chips -> /search?q=); none valid -> no nav, no heading (L-4)", () => {
    const d = tDoc();
    const nav = relatedNav(d) as HTMLElement;
    const hrefs = [...nav.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/search?q=standing%20desk", "/category/chairs"]);
    expect(nav.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(0);
    const none = tDoc({ relatedSearches: [{ label: "Bad", href: "javascript:alert(1)" }, { query: "   " }] });
    expect(relatedNav(none)).toBeNull();
    expect(none.querySelectorAll("nav[aria-labelledby]")).toHaveLength(0);
    expect(relatedNav(tDoc({ relatedSearches: [] }))).toBeNull();
  });

  test("hostile title and chips render as text; hrefs allow-listed; no arbitrary VALUE classes, no dark variant, brand-free", () => {
    const html = renderToStaticMarkup(<ListingTemplate {...tProps({ title: `Showing results for "${HOSTILE}"`, base: "/search", params: { q: HOSTILE }, relatedSearches: [{ query: HOSTILE }] })} />);
    expectNoInjectedMarkup(html);
    const d = parse(html);
    expect(d.querySelector("h1")?.textContent).toBe(`Showing results for "${HOSTILE}"`);
    for (const a of d.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    // The pager pill look uses an arbitrary VARIANT (`[&_li>*]:rounded-full`, allowed by check:tokens,
    // designer follow-up (cd) Pagination shape="pill"); arbitrary VALUES (`-[...]`) stay banned.
    const bad = allClasses(d.body).filter((c) => c.includes(DARK_PREFIX) || /-\[/.test(c) || /^\[[a-z-]+:/.test(c));
    expect(bad).toEqual([]);
    expectBrandFree(html);
    expect((d.body.textContent ?? "").toLowerCase()).not.toContain("marketplace");
  });

  test("canonical helper unchanged: isFacetedForRoute ignores sort default/view/page/q, flags facets and re-sorts (L-25)", () => {
    expect(isFacetedForRoute({})).toBe(false);
    expect(isFacetedForRoute({ page: 3, view: "list" })).toBe(false);
    expect(isFacetedForRoute({ brand: ["acme"] })).toBe(true);
    expect(isFacetedForRoute({ min: 5 })).toBe(true);
    expect(isFacetedForRoute({ sort: "price_asc" })).toBe(true);
    expect(isFacetedForRoute({ sort: "best_selling" }, "best_selling")).toBe(false);
    expect(isFacetedForRoute({ sort: "featured" }, "best_selling")).toBe(true);
  });
});

describe("source hygiene (T156/T157 files)", () => {
  const files = [
    "FilterSidebar/FilterSidebar.tsx",
    "FilterSidebar/FilterDrawerToggle.tsx",
    "ProductGrid/ProductGrid.tsx",
    "ProductGrid/place-promos.ts",
    "ListView/ListView.tsx",
    "ListView/ListViewIslands.tsx",
    "../templates/ListingTemplate/ListingTemplate.tsx",
    "../templates/ListingTemplate/listing-template-utils.ts",
  ];
  for (const file of files) {
    test(`${file}: no any, ts-ignore, dangerouslySetInnerHTML, style=, dark variant, runtime server import`, () => {
      const src = readFileSync(join(ORG, file), "utf8");
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src).not.toContain("@ts-ignore");
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/style=\{/);
      expect(src.includes(DARK_PREFIX)).toBe(false);
      expect(src).not.toMatch(/^import (?!type )[^;]*["']@\/server/m);
    });
  }
});
