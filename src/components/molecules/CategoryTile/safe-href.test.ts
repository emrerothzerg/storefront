import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolveInternalHref, UNSAFE_HREF_FALLBACK } from "./safe-href";

let originalWarn: typeof console.warn;
let warn: ReturnType<typeof mock>;
beforeEach(() => {
  originalWarn = console.warn;
  warn = mock(() => {});
  console.warn = warn;
});
afterEach(() => {
  console.warn = originalWarn;
});

describe("resolveInternalHref", () => {
  test.each(["/", "/category/toys", "/deals", "/search?q=desk#top"])("keeps %p", (href) => {
    expect(resolveInternalHref(href, "X")).toBe(href);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "//evil.example",
    "/\\evil.example",
    "https://evil.example/",
    "data:text/html,<script>",
    "",
    "category/toys",
    "/category/toys/",
  ])("rejects %p", (href) => {
    expect(resolveInternalHref(href, "Widget")).toBe(UNSAFE_HREF_FALLBACK);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("Widget");
  });

  test("is silent in production", () => {
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      expect(resolveInternalHref("javascript:alert(1)", "X")).toBe("#");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      env.NODE_ENV = prev;
    }
  });
});
