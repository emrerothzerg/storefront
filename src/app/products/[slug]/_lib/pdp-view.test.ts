import { describe, expect, test } from "bun:test";
import type { ProductDetail } from "@/lib/types";
import { breadcrumbItems, infoRows, pdpBadges, ratingLinkText, safeHref } from "./pdp-view";

describe("ratingLinkText", () => {
  test("formats average and count", () => {
    expect(ratingLinkText(4.3, 128)).toBe("4.3 out of 5, 128 ratings");
    expect(ratingLinkText(5, 1)).toBe("5.0 out of 5, 1 rating");
    expect(ratingLinkText(4.26, 1234)).toBe("4.3 out of 5, 1,234 ratings");
  });
  test("clamps garbage", () => {
    expect(ratingLinkText(Number.NaN, -1)).toBe("0.0 out of 5, 0 ratings");
    expect(ratingLinkText(9, 2)).toBe("5.0 out of 5, 2 ratings");
  });
});

describe("safeHref / breadcrumbItems", () => {
  test("allows planned routes only", () => {
    expect(safeHref("/category/kitchen")).toBe("/category/kitchen");
    expect(safeHref("/brand/acme")).toBe("/brand/acme");
    expect(safeHref("//evil.com")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
  test("last crumb is the current page; disallowed hrefs become text", () => {
    expect(
      breadcrumbItems([
        { label: "Home", href: "/" },
        { label: "Bad", href: "/category/%2e%2e" },
        { label: "Thing", href: "/products/thing" },
      ]),
    ).toEqual([{ label: "Home", href: "/" }, { label: "Bad" }, { label: "Thing" }]);
  });
});

describe("infoRows", () => {
  const base = { sku: undefined, brand: null, category: null, specs: [] } as Pick<
    ProductDetail,
    "sku" | "brand" | "category" | "specs"
  >;
  test("empty product -> no rows (section omitted)", () => {
    expect(infoRows(base)).toEqual([]);
  });
  test("SKU, brand, category and dimension/weight specs", () => {
    const rows = infoRows({
      sku: " SKU-1 ",
      brand: { id: "b", slug: "acme", name: "Acme", description: "" },
      category: { id: "c", slug: "mugs", name: "Mugs", description: "", parentId: "d", sortOrder: 0, imageUrl: null },
      specs: [
        { label: "Material", value: "Clay" },
        { label: "Dimensions", value: "10 x 10 cm" },
        { label: "Weight", value: " " },
      ],
    });
    expect(rows).toEqual([
      { label: "SKU", value: "SKU-1" },
      { label: "Brand", value: "Acme" },
      { label: "Category", value: "Mugs" },
      { label: "Dimensions", value: "10 x 10 cm" },
    ]);
  });
});

describe("pdpBadges (T169, contract P-5 = L-12 rules)", () => {
  const now = new Date("2026-11-08T12:00:00.000Z");
  const plain = {
    priceCents: 1999,
    listPriceCents: null,
    publishedAt: "2020-01-01T00:00:00.000Z",
    ratingAvg: 4.0,
    ratingCount: 3,
  };

  test("no qualifying data -> no badges", () => {
    expect(pdpBadges(plain, now)).toEqual([]);
  });

  test("sale > new > top pick, capped at 2, with the card labels", () => {
    const all = { ...plain, listPriceCents: 2499, publishedAt: "2026-11-01T00:00:00.000Z", ratingAvg: 4.8, ratingCount: 40 };
    expect(pdpBadges(all, now).map((b) => b.label)).toEqual(["Sale", "New"]);
    expect(pdpBadges({ ...all, listPriceCents: null }, now).map((b) => b.label)).toEqual(["New", "Top pick"]);
    expect(pdpBadges({ ...plain, ratingAvg: 4.5, ratingCount: 5 }, now)).toEqual([
      { key: "top_pick", label: "Top pick", tone: "accent", emphasis: "solid" },
    ]);
  });

  test("list price at or below the price is not a sale; future or old dates are not new", () => {
    expect(pdpBadges({ ...plain, listPriceCents: 1999 }, now)).toEqual([]);
    expect(pdpBadges({ ...plain, listPriceCents: 999 }, now)).toEqual([]);
    expect(pdpBadges({ ...plain, publishedAt: "2026-12-01T00:00:00.000Z" }, now)).toEqual([]);
    expect(pdpBadges({ ...plain, publishedAt: "2026-09-01T00:00:00.000Z" }, now)).toEqual([]);
  });

  test("garbage data or an invalid clock never throws and yields no badge", () => {
    const garbage = { priceCents: Number.NaN, listPriceCents: Number.NaN, publishedAt: "nope", ratingAvg: Number.NaN, ratingCount: -1 };
    expect(pdpBadges(garbage, now)).toEqual([]);
    expect(pdpBadges({ ...plain, publishedAt: "2026-11-07T00:00:00.000Z" }, new Date(Number.NaN))).toEqual([]);
  });
});
