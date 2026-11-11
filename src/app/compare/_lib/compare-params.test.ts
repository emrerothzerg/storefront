import { describe, expect, test } from "bun:test";

import {
  MAX_COMPARE_CANDIDATES,
  isCompareSlug,
  parseCompareParams,
} from "./compare-params";

describe("isCompareSlug", () => {
  test.each(["a", "walnut-desk", "1000-piece-puzzle-coast", "a".repeat(64), "-"])("accepts %p", (slug) => {
    expect(isCompareSlug(slug)).toBe(true);
  });

  test.each<unknown>([
    "",
    "Walnut-Desk",
    "../etc",
    "%2e%2e",
    "a/b",
    "a\\b",
    "a b",
    " walnut-desk",
    "walnut-desk\n",
    "a".repeat(65),
    "x".repeat(10_000),
    "é",
    null,
    undefined,
    42,
    [["walnut-desk"]],
    { slug: "walnut-desk" },
  ])("rejects %p", (value) => {
    expect(isCompareSlug(value)).toBe(false);
  });
});

describe("parseCompareParams", () => {
  test("single string and arrays keep URL order", () => {
    expect(parseCompareParams({ p: "a" }).candidates).toEqual(["a"]);
    expect(parseCompareParams({ p: ["c", "a", "b"] }).candidates).toEqual(["c", "a", "b"]);
  });

  test("dedupes with first occurrence winning", () => {
    expect(parseCompareParams({ p: ["b", "a", "b", "a", "c"] }).candidates).toEqual(["b", "a", "c"]);
  });

  test("drops malformed values but keeps valid ones around them", () => {
    const params = { p: ["../etc", "walnut-desk", "%2e%2e", "a/b", "x".repeat(10_000), "canvas-tote-bag"] };
    expect(parseCompareParams(params).candidates).toEqual(["walnut-desk", "canvas-tote-bag"]);
  });

  test("bounds the candidate list and flags overflow", () => {
    const many = Array.from({ length: 500 }, (_, i) => `slug-${i}`);
    const { candidates, overflow } = parseCompareParams({ p: many });
    expect(candidates).toHaveLength(MAX_COMPARE_CANDIDATES);
    expect(candidates[0]).toBe("slug-0");
    expect(overflow).toBe(true);
    expect(parseCompareParams({ p: ["a", "b"] }).overflow).toBe(false);
  });

  test("comma lists are split (?p=a,b) and mix with repeated params", () => {
    expect(parseCompareParams({ p: "a,b,c" }).candidates).toEqual(["a", "b", "c"]);
    expect(parseCompareParams({ p: ["a,b", "c", "b,d"] }).candidates).toEqual(["a", "b", "c", "d"]);
  });

  test("empty pieces (?p=, trailing commas) are ignored, not rejected", () => {
    expect(parseCompareParams({ p: ["", "a,,b,"] })).toEqual({
      candidates: ["a", "b"],
      differencesOnly: false,
      rejected: false,
      overflow: false,
    });
  });

  test("malformed non-empty values set rejected", () => {
    expect(parseCompareParams({ p: ["a", "../etc"] }).rejected).toBe(true);
    expect(parseCompareParams({ p: "a,<script>alert(1)</script>" }).rejected).toBe(true);
    expect(parseCompareParams({ p: ["a", 7] as unknown }).rejected).toBe(true);
    expect(parseCompareParams({ p: "a\u0000b" }).rejected).toBe(true);
    expect(parseCompareParams({ p: ["a", "b", "a"] }).rejected).toBe(false);
  });

  test("a huge comma list is cut at MAX_RAW_VALUES pieces and flagged", () => {
    const huge = Array.from({ length: 100_000 }, () => "x").join(",");
    const result = parseCompareParams({ p: huge });
    expect(result.candidates).toEqual(["x"]);
    expect(result.overflow).toBe(true);
  });

  test.each<[string, unknown]>([
    ["missing", {}],
    ["null params", null],
    ["undefined params", undefined],
    ["string params", "p=a"],
    ["array params", [["p", "a"]]],
    ["nested arrays", { p: [["a"], [["b"]]] }],
    ["number", { p: 5 }],
    ["object", { p: { 0: "a" } }],
    ["1 MB value", { p: "a".repeat(1024 * 1024) }],
    ["1 MB array entry", { p: ["b".repeat(1024 * 1024)] }],
  ])("garbage (%s) never throws and yields no candidates", (_label, params) => {
    expect(() => parseCompareParams(params)).not.toThrow();
    expect(parseCompareParams(params).candidates).toEqual([]);
  });

  test("ignores inherited properties", () => {
    const proto = { p: "walnut-desk", diff: "1" };
    const params: unknown = Object.create(proto);
    expect(parseCompareParams(params)).toEqual({ candidates: [], differencesOnly: false, rejected: false, overflow: false });
  });

  test("accepts null-prototype objects (Next searchParams)", () => {
    const params = Object.assign(Object.create(null) as Record<string, unknown>, { p: ["a", "b"], diff: "1" });
    expect(parseCompareParams(params)).toEqual({ candidates: ["a", "b"], differencesOnly: true, rejected: false, overflow: false });
  });

  test.each<[unknown, boolean]>([
    ["1", true],
    [["1", "0"], true],
    [["0", "1"], false],
    ["0", false],
    ["true", false],
    ["01", false],
    [" 1", false],
    ["", false],
    [1, false],
    [[["1"]], false],
    [undefined, false],
  ])("diff=%p -> %p", (diff, expected) => {
    expect(parseCompareParams({ diff }).differencesOnly).toBe(expected);
  });
});
