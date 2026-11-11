import { describe, expect, test } from "bun:test";
import {
  COMPARE_MAX,
  buildComparePath,
  compareHref,
  normaliseCompareSlugs,
  toggleCompareSlugs,
} from "./compare-path";

function slugsOf(path: string): string[] {
  return new URL(path, "http://x.test").searchParams.getAll("p");
}

describe("buildComparePath", () => {
  test("adds a slug: /compare?p=a&p=b (criterion 3)", () => {
    expect(buildComparePath(["a"], "b")).toBe("/compare?p=a&p=b");
    expect(buildComparePath([], "a")).toBe("/compare?p=a");
  });

  test("removes a selected slug", () => {
    expect(buildComparePath(["a", "b", "c"], "b")).toBe("/compare?p=a&p=c");
    expect(buildComparePath(["a"], "a")).toBe("/compare");
  });

  test("dedupes the selection (first occurrence wins) and does not add a duplicate", () => {
    expect(buildComparePath(["a", "b", "a", " b "], "c")).toBe("/compare?p=a&p=b&p=c");
    // Toggling a duplicated slug removes every copy.
    expect(buildComparePath(["a", "a", "b"], "a")).toBe("/compare?p=b");
  });

  test("a 5th selection is refused; the 4 stay unchanged (criterion 3)", () => {
    const four = ["a", "b", "c", "d"];
    expect(buildComparePath(four, "e")).toBe("/compare?p=a&p=b&p=c&p=d");
    expect(COMPARE_MAX).toBe(4);
  });

  test("caps an oversized URL selection at max", () => {
    expect(slugsOf(buildComparePath(["a", "b", "c", "d", "e", "f"], "a"))).toEqual(["b", "c", "d"]);
    expect(slugsOf(buildComparePath(["a", "b", "c", "d", "e", "f"], "z"))).toEqual(["a", "b", "c", "d"]);
  });

  test("custom max", () => {
    expect(buildComparePath(["a", "b"], "c", 2)).toBe("/compare?p=a&p=b");
    expect(buildComparePath(["a"], "c", 2)).toBe("/compare?p=a&p=c");
  });

  test("invalid max falls back to 4", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(slugsOf(buildComparePath(["a", "b", "c"], "d", bad))).toEqual(["a", "b", "c", "d"]);
      expect(slugsOf(buildComparePath(["a", "b", "c", "d"], "e", bad))).toEqual(["a", "b", "c", "d"]);
    }
    expect(slugsOf(buildComparePath([], "a", 1.9))).toEqual(["a"]);
    expect(slugsOf(buildComparePath(["a"], "b", 1.9))).toEqual(["a"]);
  });

  test("encodes hostile slugs so they cannot add parameters", () => {
    const path = buildComparePath(["a&p=x", "b c"], "d#e?f=g/é");
    expect(path).toBe("/compare?p=a%26p%3Dx&p=b+c&p=d%23e%3Ff%3Dg%2F%C3%A9");
    expect(slugsOf(path)).toEqual(["a&p=x", "b c", "d#e?f=g/é"]);
  });

  test("empty / whitespace toggle slug leaves the selection as is", () => {
    expect(buildComparePath(["a", ""], "  ")).toBe("/compare?p=a");
  });
});

describe("helpers", () => {
  test("normaliseCompareSlugs trims, drops empties, dedupes, caps", () => {
    expect(normaliseCompareSlugs([" a", "", "a", "b", "c", "d", "e"])).toEqual(["a", "b", "c", "d"]);
  });
  test("toggleCompareSlugs does not mutate input", () => {
    const input = ["a", "b"] as const;
    expect(toggleCompareSlugs(input, "c")).toEqual(["a", "b", "c"]);
    expect(input).toEqual(["a", "b"]);
  });
  test("compareHref of nothing is /compare", () => {
    expect(compareHref([])).toBe("/compare");
  });
});
