import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BACKGROUND_COLOR, THEME_COLOR } from "@/lib/seo/site";

import manifest from "./manifest";

describe("manifest.webmanifest", () => {
  test("standalone app manifest named after the store", () => {
    const m = manifest();
    expect(m).toMatchObject({
      name: "Northwind Goods",
      short_name: "Northwind",
      start_url: "/",
      display: "standalone",
    });
    expect(m.icons).toEqual([{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }]);
  });

  test("theme/background colours equal the light-only primary and page surface tokens in globals.css", () => {
    const css = readFileSync(join(import.meta.dir, "globals.css"), "utf8");
    const token = (name: string): string | undefined =>
      css.match(new RegExp(`^\\s*--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "m"))?.[1]?.toLowerCase();
    const m = manifest();
    expect(token("accent")).toBeDefined();
    expect(token("surface-page")).toBeDefined();
    expect(m.theme_color).toBe(token("accent")!);
    expect(m.background_color).toBe(token("surface-page")!);
  });

  test("colours come from the site.ts constants (single source for manifest and viewport)", () => {
    const m = manifest();
    expect(m.theme_color).toBe(THEME_COLOR);
    expect(m.background_color).toBe(BACKGROUND_COLOR);
  });
});
