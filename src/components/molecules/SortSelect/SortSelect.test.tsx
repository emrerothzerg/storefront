import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { LISTING_SORTS } from "@/server/catalog/listing-service";
import { DEFAULT_SORT_OPTIONS, SortSelect, visibleSortOptions } from ".";

function hiddenInputs(form: HTMLFormElement): Array<[string, string]> {
  return [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].map((i) => [i.name, i.value]);
}

describe("SortSelect", () => {
  test("default options cover every listing sort once with the agreed labels", () => {
    expect(DEFAULT_SORT_OPTIONS.map((o) => o.value).sort()).toEqual([...LISTING_SORTS].sort());
    expect(DEFAULT_SORT_OPTIONS.map((o) => o.label)).toEqual([
      "Featured",
      "Relevance",
      "Price: Low to High",
      "Price: High to Low",
      "Avg. Customer Review",
      "Newest Arrivals",
      "Best Sellers",
    ]);
  });

  test("Relevance only with a query (or when current)", () => {
    expect(visibleSortOptions(DEFAULT_SORT_OPTIONS, undefined, "featured").some((o) => o.value === "relevance")).toBe(false);
    expect(visibleSortOptions(DEFAULT_SORT_OPTIONS, "  ", "featured").some((o) => o.value === "relevance")).toBe(false);
    expect(visibleSortOptions(DEFAULT_SORT_OPTIONS, "desk", "featured").some((o) => o.value === "relevance")).toBe(true);
    expect(visibleSortOptions(DEFAULT_SORT_OPTIONS, undefined, "relevance").some((o) => o.value === "relevance")).toBe(true);
  });

  test("static HTML is a plain GET form with hidden params, labelled select and visible Apply (no JS)", () => {
    const html = renderToStaticMarkup(
      <SortSelect value="price_asc" base="/search" params={{ q: "desk", brand: ["a", "b"], sort: "newest", page: 3, view: "list", extra: { p: "x" } }} />,
    );
    expect(html).toMatch(/^<form[^>]*method="get"/);
    expect(html).toMatch(/^<form[^>]*action="\/search"/);
    expect(html).toContain('<input type="hidden" name="q" value="desk"/>');
    expect(html).toContain('name="brand" value="a"');
    expect(html).toContain('name="brand" value="b"');
    expect(html).toContain('name="view" value="list"');
    expect(html).toContain('name="p" value="x"');
    expect(html).not.toContain('name="page"');
    expect(html).not.toContain('type="hidden" name="sort"');
    expect(html).toContain('name="sort"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Apply<\/button>/);
    expect(html).not.toContain("sr-only focus:not-sr-only");
  });

  test("select is labelled 'Sort by', named sort, preselects value", () => {
    render(<SortSelect value="rating" base="/s" params={{}} />);
    const select = screen.getByRole("combobox", { name: "Sort by" });
    expect(select).toHaveAttribute("name", "sort");
    expect(select).toHaveValue("rating");
    expect(screen.queryByRole("option", { name: "Relevance" })).toBeNull();
  });

  test("hidden inputs exclude sort and page", () => {
    const { container } = render(<SortSelect value="featured" base="/s" params={{ q: "x", sort: "newest", page: 2, deals: true }} />);
    const form = container.querySelector("form") as HTMLFormElement;
    expect(hiddenInputs(form)).toEqual([
      ["q", "x"],
      ["deals", "1"],
    ]);
  });

  test("after hydration the select auto-submits and Apply is visually hidden (still focusable)", async () => {
    const { container } = render(<SortSelect value="featured" base="/s" params={{ q: "lamp" }} />);
    const form = container.querySelector("form") as HTMLFormElement;
    const requestSubmit = mock(() => {});
    form.requestSubmit = requestSubmit;
    const button = screen.getByRole("button", { name: "Apply" });
    await waitFor(() => expect(button).toHaveAttribute("data-enhanced", "true"));
    expect(button.className).toContain("sr-only");
    expect(button.className).toContain("focus:not-sr-only");
    expect(button).toHaveAttribute("type", "submit");
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "newest" } });
    expect(requestSubmit).toHaveBeenCalledTimes(1);
  });

  test("falls back to submit() without requestSubmit", async () => {
    const { container } = render(<SortSelect value="featured" base="/s" params={{}} />);
    const form = container.querySelector("form") as HTMLFormElement;
    const submit = mock(() => {});
    Object.defineProperty(form, "requestSubmit", { value: undefined, configurable: true });
    form.submit = submit;
    fireEvent.change(screen.getByRole("combobox", { name: "Sort by" }), { target: { value: "newest" } });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  test("unsafe base falls back to /", () => {
    const { container } = render(<SortSelect value="featured" base="//evil.example" params={{}} />);
    expect(container.querySelector("form")).toHaveAttribute("action", "/");
  });

  test("hostile option labels and params render as text", () => {
    const { container } = render(
      <SortSelect value="featured" base="/s" params={{ q: '"><script>x</script>' }} options={[{ value: "featured", label: "<b>Bold</b>" }]} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("option", { name: "<b>Bold</b>" })).toBeInTheDocument();
  });

  test("server part has no 'use client' and no runtime server import", () => {
    const src = readFileSync(join(import.meta.dir, "SortSelect.tsx"), "utf8");
    expect(src.startsWith('"use client"')).toBe(false);
    expect(src).not.toMatch(/^import (?!type)[^;]*@\/server/m);
    expect(src).not.toContain("style={");
  });
});

describe("SortSelect defaultSort (CONS-B1 consistency ac)", () => {
  test("hidden inputs never carry sort; other params follow the same omission rule", () => {
    const html = renderToStaticMarkup(
      <SortSelect value="featured" base="/best-sellers" params={{ sort: "featured", view: "list", page: 3 }} defaultSort="best_selling" />,
    );
    expect(html).not.toMatch(/type="hidden" name="sort"/);
    expect(html).not.toMatch(/name="page"/);
    expect(html).toMatch(/type="hidden" name="view" value="list"/);
    expect(html).toMatch(/action="\/best-sellers"/);
  });
});

describe("SortSelect compact mobile layout (T179 U07)", () => {
  test("label text is visually hidden below md but stays the accessible name; icon stays visible", () => {
    const { container } = render(<SortSelect value="featured" base="/s" params={{}} />);
    const select = screen.getByRole("combobox", { name: "Sort by" });
    const text = container.querySelector('[data-slot="sort-label-text"]');
    expect(text?.textContent).toBe("Sort by");
    expect(text).toHaveClass("sr-only", "md:not-sr-only");
    const label = container.querySelector(`label[for="${select.id}"]`);
    expect(label?.querySelector("svg")).not.toBeNull();
    expect(label?.textContent).toBe("Sort by");
  });

  test("select box is a compact fixed width below md and auto from md (no flex-1 growth)", () => {
    const { container } = render(<SortSelect value="featured" base="/s" params={{}} />);
    const box = container.querySelector('[data-slot="sort-select-box"]');
    expect(box).toHaveClass("w-28", "min-w-0", "sm:w-40", "md:w-auto");
    expect(box).not.toHaveClass("flex-1");
    expect(box?.querySelector("select[name='sort']")).not.toBeNull();
  });

  test("custom label is the accessible name in the compact layout too", () => {
    render(<SortSelect value="featured" base="/s" params={{}} label="Order" />);
    expect(screen.getByRole("combobox", { name: "Order" })).toBeInTheDocument();
  });
});
