import { describe, expect, test } from "bun:test";

import { resolveHeaderCartCount } from "./cart-count";

describe("resolveHeaderCartCount", () => {
  test("returns 0 when there are no totals", () => {
    expect(resolveHeaderCartCount(null)).toBe(0);
    expect(resolveHeaderCartCount(undefined)).toBe(0);
  });

  test("passes through valid counts", () => {
    expect(resolveHeaderCartCount({ itemCount: 0 })).toBe(0);
    expect(resolveHeaderCartCount({ itemCount: 1 })).toBe(1);
    expect(resolveHeaderCartCount({ itemCount: 3 })).toBe(3);
    expect(resolveHeaderCartCount({ itemCount: 250 })).toBe(250);
  });

  test("clamps negative counts to 0", () => {
    expect(resolveHeaderCartCount({ itemCount: -1 })).toBe(0);
    expect(resolveHeaderCartCount({ itemCount: -0.5 })).toBe(0);
  });

  test("treats non-finite counts as 0", () => {
    expect(resolveHeaderCartCount({ itemCount: Number.NaN })).toBe(0);
    expect(resolveHeaderCartCount({ itemCount: Number.POSITIVE_INFINITY })).toBe(0);
    expect(resolveHeaderCartCount({ itemCount: Number.NEGATIVE_INFINITY })).toBe(0);
  });

  test("floors fractional counts", () => {
    expect(resolveHeaderCartCount({ itemCount: 2.7 })).toBe(2);
  });

  test("ignores extra fields such as subtotalCents", () => {
    const totals = { itemCount: 4, subtotalCents: 1999 };
    expect(resolveHeaderCartCount(totals)).toBe(4);
  });
});
