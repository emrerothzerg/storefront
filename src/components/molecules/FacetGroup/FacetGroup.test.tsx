import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FacetBucket } from "@/server/catalog/listing-service";
import {
  DEFAULT_MAX_VISIBLE,
  FacetGroup,
  PRICE_RANGE_ERROR,
  PriceFacet,
  facetLinkPatch,
  facetOptionLabel,
  isBucketDisabled,
  isPriceRangeInverted,
  parseWholeDollars,
} from ".";

const b = (value: string, label: string, count: number, selected = false): FacetBucket<string> => ({
  value,
  label,
  count,
  selected,
});

const brands = [
  b("acme", "Acme", 12, true),
  b("globex", "Globex", 3),
  b("initech", "Initech", 0),
  b("umbrella", "Umbrella", 0, true),
];

function queryOf(href: string | null): URLSearchParams {
  return new URL(href ?? "", "http://h.invalid").searchParams;
}

describe("helpers", () => {
  test("facetOptionLabel formats counts as text", () => {
    expect(facetOptionLabel("Acme", 12)).toBe("Acme (12)");
    expect(facetOptionLabel("Acme", 1234)).toBe("Acme (1,234)");
    expect(facetOptionLabel("Acme", -3)).toBe("Acme (0)");
    expect(facetOptionLabel("Acme", Number.NaN)).toBe("Acme (0)");
  });

  test("isBucketDisabled: zero and unselected only", () => {
    expect(isBucketDisabled(b("a", "A", 0))).toBe(true);
    expect(isBucketDisabled(b("a", "A", 0, true))).toBe(false);
    expect(isBucketDisabled(b("a", "A", 2))).toBe(false);
  });

  test("facetLinkPatch per dimension", () => {
    expect(facetLinkPatch("brand", "b", { brand: ["a"] })).toEqual({ brand: ["a", "b"] });
    expect(facetLinkPatch("brand", "a", { brand: ["a"] })).toEqual({ brand: ["a"] });
    expect(facetLinkPatch("category", "desks", {})).toEqual({ category: "desks" });
    expect(facetLinkPatch("rating", "4", {})).toEqual({ rating: 4 });
    expect(facetLinkPatch("rating", 3, {})).toEqual({ rating: 3 });
    expect(facetLinkPatch("rating", "x", {})).toEqual({ rating: undefined });
    expect(facetLinkPatch("instock", "1", {})).toEqual({ instock: true });
    expect(facetLinkPatch("deals", "1", {})).toEqual({ deals: true });
  });

  test("parseWholeDollars / isPriceRangeInverted", () => {
    expect(parseWholeDollars(" 25 ")).toBe(25);
    expect(parseWholeDollars("")).toBeUndefined();
    expect(parseWholeDollars("2.5")).toBeUndefined();
    expect(parseWholeDollars("-1")).toBeUndefined();
    expect(parseWholeDollars("1e3")).toBeUndefined();
    expect(isPriceRangeInverted(50, 25)).toBe(true);
    expect(isPriceRangeInverted(25, 25)).toBe(false);
    expect(isPriceRangeInverted(undefined, 25)).toBe(false);
  });
});

describe("FacetGroup checkbox", () => {
  test("fieldset + legend, controls named per param with bucket values (criterion 4)", () => {
    render(<FacetGroup legend="Brand" name="brand" kind="checkbox" buckets={brands} base="/search" params={{}} />);
    const group = screen.getByRole("group", { name: "Brand" });
    expect(group.tagName).toBe("FIELDSET");
    const acme = within(group).getByRole("checkbox", { name: "Acme (12)" });
    expect(acme).toHaveAttribute("name", "brand");
    expect(acme).toHaveAttribute("value", "acme");
    expect(acme).toBeChecked();
    expect(within(group).getByRole("checkbox", { name: "Globex (3)" })).not.toBeChecked();
  });

  test("unchecked zero-count bucket is disabled with (0); selected zero stays enabled (criterion 1)", () => {
    render(<FacetGroup legend="Brand" name="brand" kind="checkbox" buckets={brands} base="/search" params={{}} />);
    expect(screen.getByRole("checkbox", { name: "Initech (0)" })).toBeDisabled();
    const umbrella = screen.getByRole("checkbox", { name: "Umbrella (0)" });
    expect(umbrella).toBeEnabled();
    expect(umbrella).toBeChecked();
  });

  test("renders no form of its own (lives in the T79 form) and works as static HTML", () => {
    const html = renderToStaticMarkup(
      <FacetGroup legend="Brand" name="brand" kind="checkbox" buckets={brands} base="/search" params={{}} />,
    );
    expect(html).not.toContain("<form");
    expect(html).toContain("<fieldset");
    expect(html).toContain("<legend");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="brand"');
    expect(html).toContain("Acme (12)");
  });

  test("submitting the parent form posts selected values as repeated params", () => {
    const { container } = render(
      <form method="get" action="/search">
        <FacetGroup legend="Brand" name="brand" kind="checkbox" buckets={brands} base="/search" params={{}} />
      </form>,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Globex (3)" }));
    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    const data = new FormData(form as HTMLFormElement);
    expect(data.getAll("brand")).toEqual(["acme", "globex", "umbrella"]);
  });

  test("empty buckets render nothing", () => {
    const { container } = render(<FacetGroup legend="Brand" name="brand" kind="checkbox" buckets={[]} base="/s" params={{}} />);
    expect(container.innerHTML).toBe("");
  });

  test("hostile labels render as text", () => {
    const evil = [b("x", '<img src=x onerror="alert(1)">', 2)];
    const { container } = render(<FacetGroup legend={"<script>bad</script>"} name="brand" kind="checkbox" buckets={evil} base="/s" params={{}} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("checkbox", { name: '<img src=x onerror="alert(1)"> (2)' })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "<script>bad</script>" })).toBeInTheDocument();
  });
});

describe("FacetGroup show more", () => {
  const many = Array.from({ length: 9 }, (_, i) => b(`b${i}`, `Brand ${i}`, i + 1));

  test(`shows ${DEFAULT_MAX_VISIBLE} then "Show N more" in a details element`, () => {
    const { container } = render(<FacetGroup legend="Brand" name="brand" kind="checkbox" buckets={many} base="/s" params={{}} />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(within(details as HTMLElement).getByText("Show 3 more")).toBeInTheDocument();
    expect(within(details as HTMLElement).getAllByRole("checkbox", { hidden: true })).toHaveLength(3);
    // Inputs inside a closed <details> still post with the form.
    expect(container.querySelectorAll('input[name="brand"]')).toHaveLength(9);
  });

  test("maxVisible and defaultOpen", () => {
    const { container } = render(
      <FacetGroup legend="Brand" name="brand" kind="checkbox" buckets={many} base="/s" params={{}} maxVisible={2} defaultOpen />,
    );
    expect(screen.getByText("Show 7 more")).toBeInTheDocument();
    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  test("opens automatically when a hidden bucket is selected", () => {
    const withSelected = many.map((x, i) => (i === 8 ? { ...x, selected: true } : x));
    const { container } = render(<FacetGroup legend="Brand" name="brand" kind="checkbox" buckets={withSelected} base="/s" params={{}} />);
    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  test("no disclosure when everything fits; garbage maxVisible falls back", () => {
    const { container } = render(
      <FacetGroup legend="Brand" name="brand" kind="checkbox" buckets={many.slice(0, 6)} base="/s" params={{}} maxVisible={Number.NaN} />,
    );
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("FacetGroup radio", () => {
  const ratings: FacetBucket<number>[] = [
    { value: 4, label: "4 stars & up", count: 10, selected: true },
    { value: 3, label: "3 stars & up", count: 0, selected: false },
  ];

  test("radiogroup named by its legend with an Any option", () => {
    render(<FacetGroup legend="Customer review" name="rating" kind="radio" buckets={ratings} base="/s" params={{}} />);
    const group = screen.getByRole("radiogroup", { name: "Customer review" });
    expect(within(group).getByRole("radio", { name: "4 stars & up (10)" })).toBeChecked();
    expect(within(group).getByRole("radio", { name: "4 stars & up (10)" })).toHaveAttribute("name", "rating");
    expect(within(group).getByRole("radio", { name: "3 stars & up (0)" })).toBeDisabled();
    const any = within(group).getByRole("radio", { name: "Any" });
    expect(any).toHaveAttribute("value", "");
    expect(any).not.toBeChecked();
  });

  test("Any is checked when nothing is selected", () => {
    render(
      <FacetGroup legend="Customer review" name="rating" kind="radio" buckets={ratings.map((r) => ({ ...r, selected: false }))} base="/s" params={{}} />,
    );
    expect(screen.getByRole("radio", { name: "Any" })).toBeChecked();
  });
});

describe("FacetGroup links", () => {
  const categories = [b("desks", "Desks", 5, true), b("chairs", "Chairs & Stools", 2), b("lamps", "Lamps", 0)];

  test("plain links keep params, drop page, preserve unknown params", () => {
    render(
      <FacetGroup
        legend="Category"
        name="category"
        kind="links"
        buckets={categories}
        base="/search"
        params={{ q: "oak", page: 3, brand: ["acme"], extra: { p: "x-1" } }}
      />,
    );
    const chairs = screen.getByRole("link", { name: "Chairs & Stools (2)" });
    const qs = queryOf(chairs.getAttribute("href"));
    expect(new URL(chairs.getAttribute("href") ?? "", "http://h.invalid").pathname).toBe("/search");
    expect(qs.get("category")).toBe("chairs");
    expect(qs.get("q")).toBe("oak");
    expect(qs.getAll("brand")).toEqual(["acme"]);
    expect(qs.get("p")).toBe("x-1");
    expect(qs.has("page")).toBe(false);
  });

  test("selected link is marked current; zero count is text, not a link", () => {
    render(<FacetGroup legend="Category" name="category" kind="links" buckets={categories} base="/s" params={{}} />);
    expect(screen.getByRole("link", { name: "Desks (5)" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: /Lamps/ })).toBeNull();
    expect(screen.getByText("Lamps (0)")).toBeInTheDocument();
  });

  test("rating links set rating", () => {
    render(
      <FacetGroup legend="Review" name="rating" kind="links" buckets={[{ value: 4, label: "4 stars & up", count: 3, selected: false }]} base="/s" params={{}} />,
    );
    expect(screen.getByRole("link", { name: "4 stars & up (3)" })).toHaveAttribute("href", "/s?rating=4");
  });
});

describe("PriceFacet", () => {
  const presets = [
    { value: { minCents: 0, maxCents: 2499 }, label: "Under $25", count: 4, selected: false },
    { value: { minCents: 2500, maxCents: 4999 }, label: "$25 to $50", count: 2, selected: true },
    { value: { minCents: 25000, maxCents: null }, label: "$250 & above", count: 0, selected: false },
  ];

  test("labelled numeric inputs posting min/max (criterion 2)", () => {
    render(<PriceFacet presets={presets} base="/search" params={{ min: 25, max: 49 }} />);
    expect(screen.getByRole("group", { name: "Price" }).tagName).toBe("FIELDSET");
    const min = screen.getByLabelText("Min price");
    const max = screen.getByLabelText("Max price");
    expect(min).toHaveAttribute("name", "min");
    expect(min).toHaveAttribute("inputmode", "numeric");
    expect(min).toHaveValue("25");
    expect(max).toHaveAttribute("name", "max");
    expect(max).toHaveValue("49");
    expect(screen.queryByText(PRICE_RANGE_ERROR)).toBeNull();
  });

  test("preset links set whole-dollar min/max and drop page", () => {
    render(<PriceFacet presets={presets} base="/search" params={{ q: "desk", page: 4 }} />);
    expect(screen.getByRole("link", { name: "Under $25 (4)" })).toHaveAttribute("href", "/search?q=desk&max=24");
    const mid = screen.getByRole("link", { name: "$25 to $50 (2)" });
    expect(mid).toHaveAttribute("href", "/search?q=desk&min=25&max=49");
    expect(mid).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: /\$250/ })).toBeNull();
    expect(screen.getByText("$250 & above (0)")).toBeInTheDocument();
  });

  test("server-rendered hint when URL min > max, linked via aria-describedby", () => {
    const html = renderToStaticMarkup(<PriceFacet base="/s" params={{ min: 50, max: 10 }} />);
    expect(html).toContain(PRICE_RANGE_ERROR);
    expect(html).not.toContain("<form");
    render(<PriceFacet base="/s" params={{ min: 50, max: 10 }} />);
    const min = screen.getByLabelText("Min price");
    const msg = screen.getByText(PRICE_RANGE_ERROR);
    expect(min.getAttribute("aria-describedby")).toBe(msg.id);
    expect(min).toHaveAttribute("aria-invalid", "true");
  });

  test("live hint while typing (JS on); never blocks the form", async () => {
    render(<PriceFacet base="/s" params={{}} />);
    const min = screen.getByLabelText("Min price");
    const max = screen.getByLabelText("Max price");
    await act(async () => {
      fireEvent.change(min, { target: { value: "80" } });
      fireEvent.change(max, { target: { value: "20" } });
    });
    expect(screen.getByText(PRICE_RANGE_ERROR)).toBeInTheDocument();
    expect(max.getAttribute("aria-describedby")).toBe(screen.getByText(PRICE_RANGE_ERROR).id);
    await act(async () => {
      fireEvent.change(max, { target: { value: "200" } });
    });
    expect(screen.queryByText(PRICE_RANGE_ERROR)).toBeNull();
    expect(max).not.toHaveAttribute("aria-describedby");
  });
});

describe("defaultSort (CONS-B5 bo)", () => {
  const categories = [b("desks", "Desks", 5, true), b("chairs", "Chairs", 2)];
  const ratings: FacetBucket<number>[] = [
    { value: 4, label: "4 stars & up", count: 3, selected: false },
    { value: 3, label: "3 stars & up", count: 5, selected: false },
  ];
  const presets = [
    { value: { minCents: 0, maxCents: 2499 }, label: "Under $25", count: 4, selected: false },
    { value: { minCents: 2500, maxCents: 4999 }, label: "$25 to $50", count: 2, selected: true },
  ];

  function hrefs(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
  }

  function renderAll(params: { sort?: string }, defaultSort?: "best_selling") {
    const sortProp = defaultSort !== undefined ? { defaultSort } : {};
    return render(
      <div>
        <FacetGroup legend="Category" name="category" kind="links" buckets={categories} base="/best-sellers" params={params} {...sortProp} />
        <FacetGroup legend="Review" name="rating" kind="links" buckets={ratings} base="/best-sellers" params={params} {...sortProp} />
        <PriceFacet presets={presets} base="/best-sellers" params={params} {...sortProp} />
      </div>,
    );
  }

  test("user-chosen featured survives in every category, rating and price link", () => {
    const { container } = renderAll({ sort: "featured" }, "best_selling");
    const all = hrefs(container);
    expect(all).toHaveLength(6);
    for (const href of all) expect(queryOf(href).get("sort")).toBe("featured");
  });

  test("the route default sort is elided from every link", () => {
    const { container } = renderAll({ sort: "best_selling" }, "best_selling");
    const all = hrefs(container);
    expect(all).toHaveLength(6);
    for (const href of all) expect(queryOf(href).has("sort")).toBe(false);
  });

  test("no prop: old behaviour (featured elided, other sorts kept)", () => {
    const featured = renderAll({ sort: "featured" });
    for (const href of hrefs(featured.container)) expect(queryOf(href).has("sort")).toBe(false);
    featured.unmount();
    const best = renderAll({ sort: "best_selling" });
    const all = hrefs(best.container);
    expect(all).toHaveLength(6);
    for (const href of all) expect(queryOf(href).get("sort")).toBe("best_selling");
  });
});

describe("source hygiene", () => {
  test("server-safe components have no 'use client'; tokens only (no inline style)", () => {
    for (const file of ["FacetGroup.tsx", "PriceFacet.tsx"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src.startsWith('"use client"')).toBe(false);
      expect(src).not.toContain("style={");
      expect(src).not.toMatch(/from "@\/server\/(?!catalog\/listing-service")/);
      expect(src).not.toMatch(/^import (?!type)[^;]*@\/server/m);
    }
  });
});
