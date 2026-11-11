import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ListingParams } from "../_listing-url";
import { ActiveFilters, activeFilterChips, clearAllHref, priceChipText, ratingChipText } from ".";

const labels = { brand: { acme: "Acme", globex: "Globex Corp" }, category: { desks: "Desks" } };
const full: ListingParams = {
  q: "oak desk",
  dept: "home",
  category: "desks",
  brand: ["acme", "globex"],
  min: 25,
  max: 49,
  rating: 4,
  instock: true,
  deals: true,
  sort: "price_asc",
  page: 3,
  view: "list",
  extra: { p: "lamp-1" },
};

function qs(href: string | null): URLSearchParams {
  return new URL(href ?? "", "http://h.invalid").searchParams;
}

describe("chip text helpers", () => {
  test("price", () => {
    expect(priceChipText(25, 49)).toBe("Price: $25–$49");
    expect(priceChipText(25, undefined)).toBe("Price: $25 & above");
    expect(priceChipText(undefined, 49)).toBe("Price: Up to $49");
    expect(priceChipText(undefined, undefined)).toBeNull();
  });
  test("rating", () => {
    expect(ratingChipText(4)).toBe("4 stars & up");
    expect(ratingChipText(1)).toBe("1 star & up");
  });
});

describe("ActiveFilters", () => {
  test("accessible names say 'Remove filter: Brand Acme' etc. (criterion 3)", () => {
    render(<ActiveFilters params={full} base="/search" labels={labels} />);
    const list = screen.getByRole("list", { name: "Active filters" });
    const names = within(list).getAllByRole("link").map((a) => a.getAttribute("aria-label") ?? a.textContent);
    expect(names).toEqual([
      "Remove filter: Category Desks",
      "Remove filter: Brand Acme",
      "Remove filter: Brand Globex Corp",
      "Remove filter: Price $25–$49",
      "Remove filter: Rating 4 stars & up",
      "Remove filter: In stock only",
      "Remove filter: Deals only",
      "Clear all",
    ]);
    expect(screen.getByRole("link", { name: "Remove filter: Brand Acme" })).toHaveTextContent("Brand: Acme");
  });

  test("each chip removes exactly one filter, drops page, keeps the rest and unknown params", () => {
    render(<ActiveFilters params={full} base="/search" labels={labels} />);
    const acme = qs(screen.getByRole("link", { name: "Remove filter: Brand Acme" }).getAttribute("href"));
    expect(acme.getAll("brand")).toEqual(["globex"]);
    expect(acme.get("category")).toBe("desks");
    expect(acme.get("q")).toBe("oak desk");
    expect(acme.get("p")).toBe("lamp-1");
    expect(acme.has("page")).toBe(false);

    const price = qs(screen.getByRole("link", { name: "Remove filter: Price $25–$49" }).getAttribute("href"));
    expect(price.has("min")).toBe(false);
    expect(price.has("max")).toBe(false);
    expect(price.get("rating")).toBe("4");

    for (const [name, key] of [
      ["Remove filter: Category Desks", "category"],
      ["Remove filter: Rating 4 stars & up", "rating"],
      ["Remove filter: In stock only", "instock"],
      ["Remove filter: Deals only", "deals"],
    ] as const) {
      const sp = qs(screen.getByRole("link", { name }).getAttribute("href"));
      expect(sp.has(key)).toBe(false);
      expect(sp.getAll("brand")).toEqual(["acme", "globex"]);
    }
  });

  test("Clear all keeps q, sort, view, dept and unknown params only", () => {
    expect(clearAllHref("/search", full)).toBe("/search?q=oak+desk&dept=home&sort=price_asc&view=list&p=lamp-1");
    render(<ActiveFilters params={full} base="/search" labels={labels} />);
    expect(screen.getByRole("link", { name: "Clear all" })).toHaveAttribute(
      "href",
      "/search?q=oak+desk&dept=home&sort=price_asc&view=list&p=lamp-1",
    );
  });

  test("renders nothing without active filters (q/sort/view/dept/page are not filters)", () => {
    const { container } = render(
      <ActiveFilters params={{ q: "x", sort: "newest", view: "list", dept: "d", page: 2, extra: { p: "y" } }} base="/s" />,
    );
    expect(container.innerHTML).toBe("");
    expect(renderToStaticMarkup(<ActiveFilters params={{ rating: 9, min: -5, brand: [" "] }} base="/s" />)).toBe("");
  });

  test("unknown slugs fall back to the slug; single bounds", () => {
    const chips = activeFilterChips({ brand: ["mystery"], max: 10 }, "/s", labels);
    expect(chips.map((c) => c.removeLabel)).toEqual(["Remove filter: Brand mystery", "Remove filter: Price Up to $10"]);
    expect(chips[1]?.href).toBe("/s?brand=mystery");
  });

  test("label lookup ignores prototype keys", () => {
    const chips = activeFilterChips({ brand: ["constructor", "__proto__"] }, "/s", { brand: {} });
    expect(chips.map((c) => c.text)).toEqual(["Brand: __proto__", "Brand: constructor"]);
  });

  test("result count as text", () => {
    render(<ActiveFilters params={{ deals: true }} base="/s" resultCount={1234} />);
    expect(screen.getByText("(1,234 results)")).toBeInTheDocument();
    render(<ActiveFilters params={{ deals: true }} base="/s" resultCount={1} />);
    expect(screen.getByText("(1 result)")).toBeInTheDocument();
  });

  test("static HTML is plain links (no JS, no buttons, no forms)", () => {
    const html = renderToStaticMarkup(<ActiveFilters params={full} base="/search" labels={labels} />);
    expect(html).toContain("<ul");
    expect(html).toContain('href="/search?');
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });

  test("hostile display names render as text", () => {
    const { container } = render(
      <ActiveFilters params={{ brand: ["x"] }} base="/s" labels={{ brand: { x: '<img src=x onerror="alert(1)">' } }} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: 'Remove filter: Brand <img src=x onerror="alert(1)">' })).toBeInTheDocument();
  });

  test("server-safe and token-only source", () => {
    const src = readFileSync(join(import.meta.dir, "ActiveFilters.tsx"), "utf8");
    expect(src.startsWith('"use client"')).toBe(false);
    expect(src).not.toContain("style={");
    expect(src).not.toContain("@/server");
  });
});

describe("defaultSort (CONS-B5 bo)", () => {
  const filtered: ListingParams = { category: "desks", brand: ["acme", "globex"], min: 25, max: 49, rating: 4, instock: true, deals: true };

  function hrefs(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
  }

  test("user-chosen featured survives in every remove chip and Clear all", () => {
    const { container } = render(
      <ActiveFilters params={{ ...filtered, sort: "featured" }} base="/best-sellers" labels={labels} defaultSort="best_selling" />,
    );
    const all = hrefs(container);
    expect(all).toHaveLength(8);
    for (const href of all) expect(qs(href).get("sort")).toBe("featured");
  });

  test("the route default sort is elided", () => {
    const { container } = render(
      <ActiveFilters params={{ ...filtered, sort: "best_selling" }} base="/best-sellers" labels={labels} defaultSort="best_selling" />,
    );
    const all = hrefs(container);
    expect(all).toHaveLength(8);
    for (const href of all) expect(qs(href).has("sort")).toBe(false);
  });

  test("helpers take the option; no option keeps the old behaviour", () => {
    const params: ListingParams = { ...filtered, sort: "featured" };
    for (const chip of activeFilterChips(params, "/best-sellers", labels, { defaultSort: "best_selling" })) {
      expect(qs(chip.href).get("sort")).toBe("featured");
    }
    expect(qs(clearAllHref("/best-sellers", params, { defaultSort: "best_selling" })).get("sort")).toBe("featured");
    for (const chip of activeFilterChips(params, "/best-sellers", labels)) expect(qs(chip.href).has("sort")).toBe(false);
    expect(qs(clearAllHref("/best-sellers", params)).has("sort")).toBe(false);
    const best: ListingParams = { ...filtered, sort: "best_selling" };
    for (const chip of activeFilterChips(best, "/best-sellers", labels)) expect(qs(chip.href).get("sort")).toBe("best_selling");
    expect(qs(clearAllHref("/best-sellers", best)).get("sort")).toBe("best_selling");
  });
});
