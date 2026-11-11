// Fixture for next-module-pins.test.ts (run in a child `bun test`): mocks
// next/headers with `cookies` only, like many app test files do.
import { expect, mock, test } from "bun:test";

mock.module("next/headers", () => ({ cookies: async () => new Map<string, string>() }));

test("cookies-only next/headers mock registered", async () => {
  const mod = await import("next/headers");
  expect(typeof mod.cookies).toBe("function");
});
