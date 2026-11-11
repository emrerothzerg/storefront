import { describe, expect, test } from "bun:test";

import { compareIntro } from "./compare-copy";

describe("compareIntro (CONS-B4 aw)", () => {
  test("null below two products: CompareTable's notice is the only guidance", () => {
    expect(compareIntro(0)).toBeNull();
    expect(compareIntro(1)).toBeNull();
  });

  test("'Comparing N products.' from two upward", () => {
    expect(compareIntro(2)).toBe("Comparing 2 products.");
    expect(compareIntro(4)).toBe("Comparing 4 products.");
  });

  test("non-integer or negative counts never produce text", () => {
    for (const n of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(compareIntro(n)).toBeNull();
  });
});
