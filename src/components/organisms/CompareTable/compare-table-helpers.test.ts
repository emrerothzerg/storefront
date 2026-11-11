import { describe, expect, test } from "bun:test";
import { isAllowedInternalHref } from "@/content/routes";
import {
  compareStateHref,
  linkSlugs,
  removeHref,
  safeCompareBase,
  specRows,
  toggleDifferencesHref,
  truncateProducts,
  valuesAllEqual,
  visibleRows,
} from "./compare-table-helpers";
import { makeDetail } from "./test-fixtures";

describe("specRows", () => {
  test("union of labels in first-seen order; missing values are null", () => {
    const a = makeDetail(1, {}, [
      { label: "Weight", value: "1 kg" },
      { label: "Colour", value: "Red" },
    ]);
    const b = makeDetail(2, {}, [
      { label: "Material", value: "Steel" },
      { label: "Weight", value: "1 kg" },
    ]);
    const c = makeDetail(3, {}, [{ label: "Colour", value: "Blue" }]);
    const rows = specRows([a, b, c]);
    expect(rows.map((r) => r.label)).toEqual(["Weight", "Colour", "Material"]);
    expect(rows[0]?.values).toEqual(["1 kg", "1 kg", null]);
    expect(rows[1]?.values).toEqual(["Red", null, "Blue"]);
    expect(rows[2]?.values).toEqual([null, "Steel", null]);
  });

  test("allEqual: identical values true, any null among values false", () => {
    const a = makeDetail(1, {}, [
      { label: "Weight", value: "1 kg" },
      { label: "Size", value: "M" },
    ]);
    const b = makeDetail(2, {}, [{ label: "Weight", value: " 1 kg " }]);
    const rows = specRows([a, b]);
    expect(rows.find((r) => r.label === "Weight")?.allEqual).toBe(true);
    expect(rows.find((r) => r.label === "Size")?.allEqual).toBe(false);
  });

  test("trims labels, skips empty labels, empty values count as missing, first duplicate wins", () => {
    const a = makeDetail(1, {}, [
      { label: "  Weight ", value: "1 kg" },
      { label: "Weight", value: "2 kg" },
      { label: "   ", value: "ignored" },
      { label: "Size", value: "   " },
    ]);
    const rows = specRows([a]);
    expect(rows).toEqual([
      { label: "Weight", values: ["1 kg"], allEqual: true },
      { label: "Size", values: [null], allEqual: true },
    ]);
  });

  test("no products or no specs -> no rows", () => {
    expect(specRows([])).toEqual([]);
    expect(specRows([makeDetail(1), makeDetail(2)])).toEqual([]);
  });

  test("hostile labels and values are kept verbatim (rendered as text later)", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const rows = specRows([makeDetail(1, {}, [{ label: evil, value: evil }])]);
    expect(rows[0]?.label).toBe(evil);
    expect(rows[0]?.values).toEqual([evil]);
  });
});

describe("valuesAllEqual / visibleRows", () => {
  test("valuesAllEqual handles nulls and single values", () => {
    expect(valuesAllEqual([])).toBe(true);
    expect(valuesAllEqual(["a"])).toBe(true);
    expect(valuesAllEqual([null, null])).toBe(true);
    expect(valuesAllEqual(["a", null])).toBe(false);
    expect(valuesAllEqual([null, "a"])).toBe(false);
    expect(valuesAllEqual(["a", "a", "b"])).toBe(false);
  });

  test("visibleRows keeps everything when off and drops equal rows when on", () => {
    const rows = [
      { label: "A", values: ["1", "1"], allEqual: true },
      { label: "B", values: ["1", "2"], allEqual: false },
    ];
    expect(visibleRows(rows, false)).toEqual(rows);
    expect(visibleRows(rows, false)).not.toBe(rows);
    expect(visibleRows(rows, true).map((r) => r.label)).toEqual(["B"]);
  });

  test("with one product every row is equal, so differences-only hides all", () => {
    const rows = specRows([makeDetail(1, {}, [{ label: "A", value: "1" }])]);
    expect(visibleRows(rows, true)).toEqual([]);
  });
});

describe("URL helpers", () => {
  test("toggleDifferencesHref takes the current state and returns the other one", () => {
    expect(toggleDifferencesHref("/compare", ["a", "b"], false)).toBe("/compare?p=a&p=b&diff=1");
    expect(toggleDifferencesHref("/compare", ["a", "b"], true)).toBe("/compare?p=a&p=b");
  });

  test("removeHref drops only that slug and keeps the order", () => {
    expect(removeHref("/compare", ["a", "b", "c"], "b")).toBe("/compare?p=a&p=c");
    expect(removeHref("/compare", ["a", "b"], "a")).toBe("/compare?p=b");
    expect(removeHref("/compare", ["a"], "a")).toBe("/compare");
    expect(removeHref("/compare", ["a", "b", "c"], "c", true)).toBe("/compare?p=a&p=b&diff=1");
  });

  test("removeHref never adds an unselected slug and dedupes / caps at 4", () => {
    expect(removeHref("/compare", ["a", "b"], "z")).toBe("/compare?p=a&p=b");
    expect(removeHref("/compare", ["a", "a", "b", "c", "d", "e"], "b")).toBe(
      "/compare?p=a&p=c&p=d",
    );
  });

  test("slugs are URL-encoded and every produced href is an allowed internal href", () => {
    const hostile = ["a&b=c", "x y", "../etc", "<script>"];
    const hrefs = [
      removeHref("/compare", hostile, "x y"),
      toggleDifferencesHref("/compare", hostile, false),
      toggleDifferencesHref("/compare", hostile, true),
      compareStateHref("/compare", []),
    ];
    expect(hrefs[0]).toBe("/compare?p=a%26b%3Dc&p=..%2Fetc&p=%3Cscript%3E");
    for (const href of hrefs) {
      expect(href.startsWith("/compare")).toBe(true);
      expect(isAllowedInternalHref(href)).toBe(true);
      const params = new URL(href, "https://shop.test").searchParams;
      expect(params.getAll("p").every((p) => hostile.includes(p))).toBe(true);
    }
  });

  test("unsafe basePath falls back to /compare; query and hash are dropped", () => {
    expect(safeCompareBase(undefined)).toBe("/compare");
    expect(safeCompareBase("https://evil.test/compare")).toBe("/compare");
    expect(safeCompareBase("//evil.test")).toBe("/compare");
    expect(safeCompareBase("/\\evil")).toBe("/compare");
    expect(safeCompareBase("")).toBe("/compare");
    expect(safeCompareBase("/compare?p=x#top")).toBe("/compare");
    expect(removeHref("//evil.test", ["a", "b"], "a")).toBe("/compare?p=b");
  });
});

describe("truncateProducts", () => {
  test("5 products are truncated to the first 4 and flagged", () => {
    const five = [1, 2, 3, 4, 5].map((n) => makeDetail(n));
    const result = truncateProducts(five);
    expect(result.shown.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
  });

  test("4 or fewer are kept as is", () => {
    const four = [1, 2, 3, 4].map((n) => makeDetail(n));
    expect(truncateProducts(four)).toEqual({ shown: four, total: 4, truncated: false });
    expect(truncateProducts([])).toEqual({ shown: [], total: 0, truncated: false });
  });
});

describe("truncateProducts dedupe (D-T86-2)", () => {
  test("duplicate ids are dropped (first wins) before truncating and counting", () => {
    const a = makeDetail(1);
    const dup = { ...a, name: "Dup" };
    const result = truncateProducts([a, dup, makeDetail(2), makeDetail(3), makeDetail(4), makeDetail(5)]);
    expect(result.shown.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(result.shown[0]?.name).toBe(a.name);
    expect(result.total).toBe(5);
    expect(result.truncated).toBe(true);
    expect(truncateProducts([a, a]).shown).toHaveLength(1);
  });
});

describe("linkSlugs (D-T86-3)", () => {
  const shown = [makeDetail(1), makeDetail(2)];
  test("keeps selected slugs of shown products in selection order; drops unknown ones", () => {
    expect(linkSlugs(["ghost", "product-2", " product-1 ", "product-2"], shown)).toEqual(["product-2", "product-1"]);
  });
  test("falls back to the shown slugs when nothing matches or nothing was selected", () => {
    expect(linkSlugs([], shown)).toEqual(["product-1", "product-2"]);
    expect(linkSlugs(["ghost", ""], shown)).toEqual(["product-1", "product-2"]);
    expect(linkSlugs([], [])).toEqual([]);
  });
});
