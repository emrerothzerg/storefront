import { afterEach, describe, expect, test } from "bun:test";

import robots from "./robots";

const env = process.env as Record<string, string | undefined>;
const original = env.NEXT_PUBLIC_SITE_URL;

afterEach(() => {
  if (original === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = original;
});

describe("robots.txt", () => {
  test("allows / and disallows private routes, with an absolute sitemap URL", () => {
    env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com/";
    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/cart",
          "/checkout",
          "/orders",
          "/orders/",
          "/account",
          "/lists",
          "/search",
          "/api/",
          "/compare",
        ],
      },
      sitemap: "https://shop.example.com/sitemap.xml",
    });
  });

  test("keeps /signin, /signup, /contact, assets and /_next/ crawlable", () => {
    const rules = robots().rules;
    const list = (Array.isArray(rules) ? rules : [rules]).flatMap((rule) =>
      rule.disallow === undefined ? [] : Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow],
    );
    for (const path of ["/signin", "/signup", "/contact", "/_next/static/chunks/app.js", "/_next/image", "/images/products/x.svg", "/favicon.ico", "/manifest.webmanifest", "/sitemap.xml"]) {
      expect(list.some((rule) => path.startsWith(rule))).toBe(false);
    }
    expect(list).not.toContain("/");
  });

  test("defaults to localhost without NEXT_PUBLIC_SITE_URL", () => {
    delete env.NEXT_PUBLIC_SITE_URL;
    expect(robots().sitemap).toBe("http://localhost:3000/sitemap.xml");
  });
});
