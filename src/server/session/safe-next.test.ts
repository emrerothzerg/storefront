import { describe, expect, test } from "bun:test";

import { DEFAULT_SAFE_NEXT, SAFE_NEXT_MAX_LENGTH, safeNext } from "./safe-next";

// PLAN.md 3.7 hostile set N-H and safe set N-S, plus extra encodings.
const HOSTILE: ReadonlyArray<string> = [
  "//evil.com",
  "https://evil.com",
  "http:/evil.com",
  "///evil.com",
  "/\\evil.com",
  "\\\\evil.com",
  "/\t/evil.com",
  "/\n/evil.com",
  " //evil.com",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,x",
  "%2F%2Fevil.com",
  "/%2F/evil.com",
  "/%2f%2fevil.com",
  "/%2Fevil.com",
  "/%5Cevil.com",
  "/%5cevil.com",
  "/%252F%252Fevil.com",
  "/%255Cevil.com",
  "/%0A/evil.com",
  "/%09/evil.com",
  "/%00",
  "/%E0%A4%A",
  "/%",
  "evil.com",
  "",
  "/" + "a".repeat(4096),
  "/ok path",
  "/café",
  "/‮evil",
  "/a:b",
  "/a\\b",
  "/a@evil.com",
  "?next=/x",
  "#/x",
  "\u0000/x",
];

const SAFE: ReadonlyArray<string> = [
  "/orders",
  "/orders?page=2",
  "/account/settings",
  "/products/canvas-tote-bag#reviews",
  "/",
  "/search?q=tote&sort=price-asc",
  "/a/b/c.d~e_f-g",
  "/search?q=caf%C3%A9",
  "/" + "a".repeat(SAFE_NEXT_MAX_LENGTH - 1),
];

describe("safeNext", () => {
  test("default fallback is /account", () => {
    expect(DEFAULT_SAFE_NEXT).toBe("/account");
    expect(safeNext(undefined)).toBe("/account");
  });

  test.each(HOSTILE.map((value) => [JSON.stringify(value).slice(0, 60), value]))(
    "hostile %s -> fallback",
    (_label, value) => {
      expect(safeNext(value)).toBe("/account");
    },
  );

  test.each(SAFE.map((value) => [value.slice(0, 60), value]))("safe %s -> unchanged", (_label, value) => {
    expect(safeNext(value)).toBe(value);
  });

  test("length cap: 512 accepted, 513 rejected", () => {
    const ok = "/" + "a".repeat(SAFE_NEXT_MAX_LENGTH - 1);
    expect(ok.length).toBe(512);
    expect(safeNext(ok)).toBe(ok);
    expect(safeNext(ok + "a")).toBe("/account");
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
    ["object", { toString: () => "/orders" }],
    ["array", ["/orders"]],
    ["String object", new String("/orders")],
  ])("non-string %s -> fallback", (_label, value: unknown) => {
    expect(safeNext(value)).toBe("/account");
  });

  test("custom fallback is returned for hostile input", () => {
    expect(safeNext("//evil.com", "/")).toBe("/");
    expect(safeNext("/orders", "/")).toBe("/orders");
  });

  test("invariant over all inputs: output is a single-slash path without scheme or control chars", () => {
    for (const value of [...HOSTILE, ...SAFE]) {
      const out = safeNext(value);
      expect(out).not.toMatch(/^\/[/\\]/);
      expect(out.startsWith("/")).toBe(true);
      expect(out).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(out).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
      expect(out.includes("evil")).toBe(false);
    }
  });

  test("a 1 MiB input is rejected quickly", () => {
    const huge = "/" + "a".repeat(1024 * 1024);
    const start = performance.now();
    for (let i = 0; i < 100; i++) expect(safeNext(huge)).toBe("/account");
    expect(performance.now() - start).toBeLessThan(200);
  });
});
