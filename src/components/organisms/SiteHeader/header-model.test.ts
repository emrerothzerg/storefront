import { describe, expect, test } from "bun:test";
import {
  MAX_VISIBLE_NAME_LENGTH,
  allowedLinks,
  cartAccessibleName,
  cleanDisplayName,
  couponPromoParts,
  isCurrentPath,
  truncateDisplayName,
  visibleCartCount,
} from "./header-model";

describe("cart labels", () => {
  test.each<[number, string, string]>([
    [0, "Cart, 0 items", "0"],
    [1, "Cart, 1 item", "1"],
    [2, "Cart, 2 items", "2"],
    [99, "Cart, 99 items", "99"],
    [100, "Cart, 100 items", "99+"],
    [-4, "Cart, 0 items", "0"],
    [1.5, "Cart, 0 items", "0"],
    [Number.NaN, "Cart, 0 items", "0"],
  ])("%p -> %p / %p", (count, name, badge) => {
    expect(cartAccessibleName(count)).toBe(name);
    expect(visibleCartCount(count)).toBe(badge);
  });
});

describe("display name", () => {
  test("cleanDisplayName collapses whitespace and control characters; non-strings become empty", () => {
    expect(cleanDisplayName("  Ada \n\t Lovelace\u0000 ")).toBe("Ada Lovelace");
    expect(cleanDisplayName(42)).toBe("");
    expect(cleanDisplayName(null)).toBe("");
  });

  test("truncateDisplayName keeps <= 20 characters and appends an ellipsis", () => {
    expect(MAX_VISIBLE_NAME_LENGTH).toBe(20);
    expect(truncateDisplayName("Ada")).toBe("Ada");
    expect(truncateDisplayName("a".repeat(20))).toBe("a".repeat(20));
    expect(truncateDisplayName("a".repeat(21))).toBe(`${"a".repeat(20)}…`);
    expect(truncateDisplayName("Alexandria Ocasio Cortez")).toBe("Alexandria Ocasio Co…");
  });

  test("truncation never splits a surrogate pair", () => {
    const name = "\u{1F600}".repeat(25);
    const out = truncateDisplayName(name);
    expect(Array.from(out)).toHaveLength(21);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test("trailing space before the cut is trimmed", () => {
    expect(truncateDisplayName(`${"a".repeat(19)} bcdef`)).toBe(`${"a".repeat(19)}…`);
  });
});

describe("allowedLinks", () => {
  test("drops disallowed hrefs, empty labels and duplicate hrefs", () => {
    const out = allowedLinks([
      { label: "Deals", href: "/deals" },
      { label: "Evil", href: "https://evil.example" },
      { label: "Proto", href: "//evil.example" },
      { label: "Js", href: "javascript:alert(1)" },
      { label: "Unknown", href: "/nope" },
      { label: " ", href: "/help" },
      { label: "Deals again", href: "/deals" },
      { label: "Orders", href: "/orders" },
    ]);
    expect(out.map((l) => l.href)).toEqual(["/deals", "/orders"]);
  });

  test("undefined gives an empty list", () => {
    expect(allowedLinks(undefined)).toEqual([]);
  });
});

describe("isCurrentPath", () => {
  test("root matches only itself; sections match descendants but not prefixes", () => {
    expect(isCurrentPath("/", "/")).toBe(true);
    expect(isCurrentPath("/", "/cart")).toBe(false);
    expect(isCurrentPath("/orders", "/orders/abc")).toBe(true);
    expect(isCurrentPath("/orders", "/ordersx")).toBe(false);
    expect(isCurrentPath("/orders", undefined)).toBe(false);
  });
});

describe("couponPromoParts", () => {
  test("builds 'Use code CODE for <description>'", () => {
    expect(couponPromoParts({ code: "WELCOME10", description: "10% off" })).toEqual({
      code: "WELCOME10",
      tail: " for 10% off",
    });
  });

  test("lower-cases a leading 'Free shipping'", () => {
    expect(couponPromoParts({ code: "FREESHIP", description: "Free shipping on orders of $20.00 or more" })).toEqual({
      code: "FREESHIP",
      tail: " for free shipping on orders of $20.00 or more",
    });
  });

  test("rejects missing coupons, empty descriptions and codes outside the charset", () => {
    expect(couponPromoParts(null)).toBeNull();
    expect(couponPromoParts(undefined)).toBeNull();
    expect(couponPromoParts({ code: "OK", description: " " })).toBeNull();
    expect(couponPromoParts({ code: "<b>x</b>", description: "10% off" })).toBeNull();
    expect(couponPromoParts({ code: "lower", description: "10% off" })).toBeNull();
    expect(couponPromoParts({ code: "A".repeat(33), description: "10% off" })).toBeNull();
  });
});
