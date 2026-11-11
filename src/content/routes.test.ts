import { describe, expect, test } from "bun:test";
import { PLANNED_ROUTES, isAllowedInternalHref } from "./routes";

describe("PLANNED_ROUTES", () => {
  test("has unique entries that all start with a slash", () => {
    expect(new Set(PLANNED_ROUTES).size).toBe(PLANNED_ROUTES.length);
    for (const route of PLANNED_ROUTES) expect(route.startsWith("/")).toBe(true);
  });
});

describe("isAllowedInternalHref", () => {
  test.each([
    "/",
    "/products",
    "/products/blue-mug",
    "/category/kitchen",
    "/brand/acme",
    "/orders/ord_123",
    "/orders/0b6f8a0e-1c1d-4e39-9a8e-5a4d1b8a2f10/invoice",
    "/lists/abc",
    "/lists/shared/tok-123_x",
    "/help/shipping",
    "/account/alerts",
    "/accessibility",
    "/products/caf%C3%A9-mug",
    "/signin",
    "/signin?next=%2Faccount%2Fsettings",
    "/signup",
    "/account/settings",
  ])("allows %s", (href) => {
    expect(isAllowedInternalHref(href)).toBe(true);
  });

  test("ignores query strings and hashes", () => {
    expect(isAllowedInternalHref("/search?q=mug")).toBe(true);
    expect(isAllowedInternalHref("/compare?p=a&p=b")).toBe(true);
    expect(isAllowedInternalHref("/help/shipping#how-do-i-track-my-order")).toBe(true);
    expect(isAllowedInternalHref("/?ref=x#top")).toBe(true);
    expect(isAllowedInternalHref("/nope?x=/products")).toBe(false);
  });

  test.each([
    "",
    "products",
    "//evil.example.com/products",
    "https://example.com/",
    "javascript:alert(1)",
    "/products/",
    "/product",
    "/products/a/b",
    "/orders/x/receipt",
    "/help/",
    "/account/preferences",
    "/signin/",
    "/sign-in",
    "/products/..",
    "/products/.",
    "/products/a b",
    "/\\evil.example.com",
    "/FAQ",
    "/products/%2e%2e",
    "/products/%2E%2E",
    "/products/%2e",
    "/lists/.%2e",
    "/orders/%2e%2e/invoice",
    "/products/a%2fb",
    "/products/a%2Fb",
    "/products/a%5cb",
    "/products/%E0%A4%A",
    "/products/%",
  ])("rejects %p", (href) => {
    expect(isAllowedInternalHref(href)).toBe(false);
  });

  test("rejects non-string input without throwing", () => {
    expect(isAllowedInternalHref(undefined as unknown as string)).toBe(false);
    expect(isAllowedInternalHref("/" + "a".repeat(5000))).toBe(false);
  });
});
