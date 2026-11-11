import { describe, expect, test } from "bun:test";

import type { BrandWithCount } from "@/lib/types";

import { brandCountLabel, brandTotalLabel, brandsMetadata, groupBrands, groupLetter, loadBrandsPage, OTHER_GROUP } from "./brands-page";

function brand(slug: string, name: string, productCount = 1): BrandWithCount {
  return { id: `b_${slug}`, slug, name, description: "", productCount };
}

describe("groupLetter", () => {
  test.each([
    ["Acme", "A"],
    ["zeta", "Z"],
    ["Émile", "E"],
    ["3M", OTHER_GROUP],
    ["  kestrel", "K"],
    ["東京", OTHER_GROUP],
  ])("%p -> %p", (name, letter) => {
    expect(groupLetter(name)).toBe(letter);
  });
});

describe("groupBrands", () => {
  test("A–Z order with # last, sorted within group, invalid dropped", () => {
    const groups = groupBrands([
      brand("zed", "Zed"),
      brand("3m", "3M"),
      brand("beta", "beta"),
      brand("alpha", "Alpha"),
      brand("bad slug", "Bad"),
      brand("blank", "   "),
      brand("apex", "Apex", 0),
    ]);
    expect(groups.map((g) => g.letter)).toEqual(["A", "B", "Z", OTHER_GROUP]);
    expect(groups[0]?.brands.map((b) => b.name)).toEqual(["Alpha", "Apex"]);
    expect(groups[0]?.brands[1]).toEqual({ slug: "apex", name: "Apex", productCount: 0, href: "/brand/apex" });
  });

  test("count labels", () => {
    expect(brandCountLabel(1)).toBe("1 product");
    expect(brandCountLabel(0)).toBe("0 products");
    expect(brandTotalLabel(1)).toBe("1 brand");
    expect(brandTotalLabel(12)).toBe("12 brands");
  });
});

describe("loadBrandsPage / brandsMetadata", () => {
  test("brands: the groups flattened in A–Z order, '#' names last (T177 tile grid)", () => {
    const view = loadBrandsPage({
      brands: {
        listWithCounts: () => [brand("zed", "Zed"), brand("3m", "3M"), brand("beta", "beta"), brand("alpha", "Alpha")],
        getBySlug: () => null,
      },
      now: () => 0,
    });
    expect(view.brands.map((b) => b.name)).toEqual(["Alpha", "beta", "Zed", "3M"]);
    expect(view.brands).toEqual(view.groups.flatMap((g) => g.brands));
  });

  test("uses listWithCounts with the request now, BreadcrumbList Home > Brands", () => {
    const seen: Array<number | undefined> = [];
    const view = loadBrandsPage({
      brands: {
        listWithCounts: (now) => {
          seen.push(now);
          return [brand("kestrel-audio", "Kestrel Audio", 4)];
        },
        getBySlug: () => null,
      },
      now: () => 1_700_000_000_000,
    });
    expect(seen).toEqual([1_700_000_000_000]);
    expect(view.groups).toEqual([
      { letter: "K", brands: [{ slug: "kestrel-audio", name: "Kestrel Audio", productCount: 4, href: "/brand/kestrel-audio" }] },
    ]);
    expect(view.brands).toEqual([{ slug: "kestrel-audio", name: "Kestrel Audio", productCount: 4, href: "/brand/kestrel-audio" }]);
    expect(view.breadcrumb).toEqual([{ label: "Home", href: "/" }, { label: "Brands" }]);
    expect(view.jsonLd.itemListElement).toHaveLength(2);
  });

  test("indexable with canonical /brands", () => {
    const md = brandsMetadata();
    expect(md.robots).toBeUndefined();
    expect(String(md.alternates?.canonical)).toMatch(/\/brands$/);
  });
});
