import { describe, expect, test } from "bun:test";

import {
  CREATE_ERROR_MESSAGES,
  isListIdShape,
  isShareTokenShape,
  parseCreateError,
  parseFlag,
  parseIndexParams,
  parseListSort,
  singleParam,
} from "./params";

describe("isListIdShape", () => {
  test("accepts canonical lower-case UUIDs (what crypto.randomUUID produces)", () => {
    expect(isListIdShape(crypto.randomUUID())).toBe(true);
    expect(isListIdShape("11111111-1111-4111-8111-111111111111")).toBe(true);
  });

  test.each([
    ["empty", ""],
    ["upper case", "11111111-1111-4111-8111-11111111111A"],
    ["no hyphens", "11111111111141118111111111111111"],
    ["share token", "AAAAAAAAAAAAAAAAAAAAAA"],
    ["traversal", "../../etc/passwd"],
    ["sql", "1' OR '1'='1"],
    ["too long", `${"1".repeat(10_000)}`],
    ["trailing newline", "11111111-1111-4111-8111-111111111111\n"],
  ])("rejects %s", (_label, value) => {
    expect(isListIdShape(value)).toBe(false);
  });

  test("rejects non-strings", () => {
    for (const value of [null, undefined, 1, {}, ["11111111-1111-4111-8111-111111111111"]]) {
      expect(isListIdShape(value)).toBe(false);
    }
  });
});

describe("isShareTokenShape", () => {
  test("accepts 22-char base64url", () => {
    expect(isShareTokenShape("abcdefghijklmnopqrstu_")).toBe(true);
    expect(isShareTokenShape("ABCDEFGHIJ-0123456789x")).toBe(true);
  });

  test.each([
    ["21 chars", "abcdefghijklmnopqrstu"],
    ["23 chars", "abcdefghijklmnopqrstuvw"],
    ["padding", "abcdefghijklmnopqrstu="],
    ["plus/slash", "abcdefghijklmnopqrst+/"],
    ["uuid", "11111111-1111-4111-8111-111111111111"],
    ["percent", "abcdefghijklmnopqrs%2F"],
  ])("rejects %s", (_label, value) => {
    expect(isShareTokenShape(value)).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isShareTokenShape(undefined)).toBe(false);
    expect(isShareTokenShape(42)).toBe(false);
  });
});

describe("search params", () => {
  test("singleParam drops arrays", () => {
    expect(singleParam("a")).toBe("a");
    expect(singleParam(["a", "b"])).toBeUndefined();
    expect(singleParam(undefined)).toBeUndefined();
  });

  test("parseListSort keeps known values and defaults the rest (criterion 3)", () => {
    expect(parseListSort("price_asc")).toBe("price_asc");
    expect(parseListSort("price_desc")).toBe("price_desc");
    expect(parseListSort("priority")).toBe("priority");
    expect(parseListSort("added_desc")).toBe("added_desc");
    for (const bad of [undefined, "", "PRICE_ASC", "price_asc ", "constructor", "__proto__", ["price_asc", "priority"], "<script>"]) {
      expect(parseListSort(bad)).toBe("added_desc");
    }
  });

  test("parseFlag is true only for exactly '1'", () => {
    expect(parseFlag("1")).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", ["1"], "1 "]) expect(parseFlag(v)).toBe(false);
  });

  test("parseCreateError maps unknown values to UNKNOWN and never echoes input", () => {
    expect(parseCreateError(undefined)).toBeNull();
    expect(parseCreateError("")).toBeNull();
    expect(parseCreateError("TOO_LONG")).toBe("TOO_LONG");
    expect(parseCreateError("LIMIT_REACHED")).toBe("LIMIT_REACHED");
    expect(parseCreateError("<img src=x onerror=alert(1)>")).toBe("UNKNOWN");
    expect(parseCreateError("toString")).toBe("UNKNOWN");
    expect(parseCreateError("hasOwnProperty")).toBe("UNKNOWN");
    expect(parseCreateError(["TOO_LONG", "x"])).toBeNull();
    expect(Object.keys(CREATE_ERROR_MESSAGES)).toContain("UNKNOWN");
  });

  test("parseIndexParams", () => {
    expect(parseIndexParams({})).toEqual({ deleted: false, created: false, createError: null });
    expect(parseIndexParams({ deleted: "1", created: "1", createError: "RATE_LIMITED" })).toEqual({
      deleted: true,
      created: true,
      createError: "RATE_LIMITED",
    });
  });
});
