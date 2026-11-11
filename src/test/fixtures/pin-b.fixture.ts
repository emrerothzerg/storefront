// Fixture for next-module-pins.test.ts (run in a child `bun test` after
// pin-a): statically imports `headers`, which fails to link with
// "Export named 'headers' not found" unless the preload pinned the exports.
import { expect, test } from "bun:test";
import { headers } from "next/headers";

test("headers export still linkable after a cookies-only mock", () => {
  expect(headers).toBeDefined();
});
