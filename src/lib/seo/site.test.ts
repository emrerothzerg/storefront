import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BACKGROUND_COLOR,
  DEFAULT_SITE_URL,
  ROBOTS_DISALLOW,
  SITE_NAME,
  THEME_COLOR,
  absoluteUrl,
  getSiteUrl,
} from "./site";

const env = process.env as Record<string, string | undefined>;
const original = env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (original === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = original;
});

describe("site config", () => {
  test("placeholder store name", () => {
    expect(SITE_NAME).toBe("Northwind Goods");
  });

  test("brand colours mirror the light-only accent and page surface tokens in globals.css", () => {
    const css = readFileSync(join(import.meta.dir, "../../app/globals.css"), "utf8");
    const token = (name: string): string | undefined =>
      css.match(new RegExp(`^\\s*--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "m"))?.[1]?.toLowerCase();
    expect(token("accent")).toBeDefined();
    expect(token("surface-page")).toBeDefined();
    expect(THEME_COLOR).toBe(token("accent")!);
    expect(BACKGROUND_COLOR).toBe(token("surface-page")!);
  });

  test("robots disallow list covers every private route", () => {
    for (const path of ["/cart", "/checkout", "/orders", "/orders/", "/account", "/lists", "/search", "/api/", "/compare"]) {
      expect(ROBOTS_DISALLOW).toContain(path);
    }
  });
});

describe("getSiteUrl", () => {
  test("defaults to localhost when unset or blank", () => {
    delete env.NEXT_PUBLIC_SITE_URL;
    expect(getSiteUrl()).toBe(DEFAULT_SITE_URL);
    env.NEXT_PUBLIC_SITE_URL = "   ";
    expect(getSiteUrl()).toBe("http://localhost:3000");
  });

  test("trims and strips trailing slashes, query and hash", () => {
    env.NEXT_PUBLIC_SITE_URL = "  https://shop.example.com///  ";
    expect(getSiteUrl()).toBe("https://shop.example.com");
    env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com/?a=1#x";
    expect(getSiteUrl()).toBe("https://shop.example.com");
  });

  test("keeps a base path", () => {
    env.NEXT_PUBLIC_SITE_URL = "https://example.com/store/";
    expect(getSiteUrl()).toBe("https://example.com/store");
  });

  test.each(["not a url", "javascript:alert(1)", "ftp://example.com", "https://user:pw@example.com", "//example.com"])(
    "falls back for invalid value %p",
    (value) => {
      env.NEXT_PUBLIC_SITE_URL = value;
      expect(getSiteUrl()).toBe(DEFAULT_SITE_URL);
    },
  );
});

describe("absoluteUrl", () => {
  test("joins site paths with and without a leading slash", () => {
    env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com/";
    expect(absoluteUrl("/products/x")).toBe("https://shop.example.com/products/x");
    expect(absoluteUrl("products/x")).toBe("https://shop.example.com/products/x");
    expect(absoluteUrl("/")).toBe("https://shop.example.com/");
  });

  test("returns absolute http(s) URLs unchanged", () => {
    env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
    expect(absoluteUrl("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
  });

  test("a protocol-relative path stays on the site", () => {
    env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
    expect(absoluteUrl("//evil.example.com/x")).toBe("https://shop.example.com//evil.example.com/x");
  });
});
