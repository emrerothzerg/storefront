import { describe, expect, test } from "bun:test";

import {
  MAX_TOKEN_PARAM_LENGTH,
  RAW_PARAM_SCAN_LIMIT,
  cleanTextParam,
  firstParam,
  hasParam,
  parseOpenSlug,
  tokenParam,
} from "./search-params";

describe("firstParam", () => {
  test("string, first of array, otherwise null", () => {
    expect(firstParam("a")).toBe("a");
    expect(firstParam(["b", "c"])).toBe("b");
    expect(firstParam([])).toBeNull();
    expect(firstParam([1])).toBeNull();
    expect(firstParam(undefined)).toBeNull();
    expect(firstParam(42)).toBeNull();
    expect(firstParam({ toString: () => "x" })).toBeNull();
  });
});

describe("hasParam", () => {
  test("true for present keys including empty values", () => {
    expect(hasParam({ q: "" }, "q")).toBe(true);
    expect(hasParam({ q: ["x"] }, "q")).toBe(true);
    expect(hasParam({ q: undefined }, "q")).toBe(false);
    expect(hasParam({}, "q")).toBe(false);
    expect(hasParam(undefined, "q")).toBe(false);
  });

  test("ignores inherited keys", () => {
    expect(hasParam({}, "toString")).toBe(false);
    expect(hasParam({}, "__proto__")).toBe(false);
  });
});

describe("cleanTextParam", () => {
  test("trims and collapses whitespace", () => {
    expect(cleanTextParam("  free \n\t shipping  ", 100)).toBe("free shipping");
  });

  test("strips control, zero-width, bidi and BOM characters", () => {
    expect(cleanTextParam("re\u0000tu​rn‍﻿‮s\u0007", 100)).toBe("returns");
  });

  test("line/paragraph separators become spaces", () => {
    expect(cleanTextParam("a b c", 100)).toBe("a b c");
  });

  test("blank or invisible-only input is null", () => {
    expect(cleanTextParam("", 100)).toBeNull();
    expect(cleanTextParam("   ", 100)).toBeNull();
    expect(cleanTextParam("​\u0000﻿", 100)).toBeNull();
    expect(cleanTextParam(undefined, 100)).toBeNull();
  });

  test("caps at max code points without splitting surrogate pairs", () => {
    const emoji = "\u{1F600}".repeat(150);
    const out = cleanTextParam(emoji, 100);
    expect(Array.from(out ?? "")).toHaveLength(100);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  test("lone surrogates are removed", () => {
    expect(cleanTextParam("a\uD800b\uDC00c", 100)).toBe("abc");
  });

  test("huge input is bounded and does not throw", () => {
    const huge = "x".repeat(1_000_000);
    const out = cleanTextParam(huge, 100);
    expect(out).toHaveLength(100);
    expect(RAW_PARAM_SCAN_LIMIT).toBeGreaterThan(100);
  });

  test("regex metacharacters and markup are kept as literal text", () => {
    expect(cleanTextParam(".*(a+)+$[^]\\", 100)).toBe(".*(a+)+$[^]\\");
    expect(cleanTextParam("<script>alert(1)</script>", 100)).toBe("<script>alert(1)</script>");
  });
});

describe("tokenParam / parseOpenSlug", () => {
  test("tokenParam rejects empty and over-long values", () => {
    expect(tokenParam("abc")).toBe("abc");
    expect(tokenParam("")).toBeNull();
    expect(tokenParam("a".repeat(MAX_TOKEN_PARAM_LENGTH + 1))).toBeNull();
    expect(tokenParam(["x", "y"])).toBe("x");
  });

  test("parseOpenSlug only accepts listed slugs", () => {
    const slugs = ["one", "two"];
    expect(parseOpenSlug("two", slugs)).toBe("two");
    expect(parseOpenSlug("three", slugs)).toBeUndefined();
    expect(parseOpenSlug("TWO", slugs)).toBeUndefined();
    expect(parseOpenSlug("two\"><img>", slugs)).toBeUndefined();
    expect(parseOpenSlug(undefined, slugs)).toBeUndefined();
    expect(parseOpenSlug(["one", "two"], slugs)).toBe("one");
  });
});
