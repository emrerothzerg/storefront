import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { ROUTE_POLICIES, type RoutePolicy } from "./routes";
import { SITEMAP_URL_LIMIT, buildSiteSitemap, buildSitemapEntries, toSitemapProduct, type SiteSitemapData } from "./sitemap";

const env = process.env as Record<string, string | undefined>;
const original = env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
});

afterEach(() => {
  if (original === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = original;
});

describe("buildSitemapEntries", () => {
  test("home only for an empty catalogue", () => {
    expect(buildSitemapEntries([])).toEqual([
      { url: "https://shop.example.com/", changeFrequency: "daily", priority: 1 },
    ]);
  });

  test("one entry per product; lastModified only when a valid timestamp exists", () => {
    const entries = buildSitemapEntries([
      { slug: "a", updatedAt: "2026-11-01T00:00:00.000Z" },
      { slug: "b" },
      { slug: "c", updatedAt: "not a date" },
      { slug: "d", updatedAt: "2026-11-05T12:00:00.000Z" },
    ]);
    expect(entries).toHaveLength(5);
    expect(entries[0]).toEqual({
      url: "https://shop.example.com/",
      lastModified: new Date("2026-11-05T12:00:00.000Z"),
      changeFrequency: "daily",
      priority: 1,
    });
    expect(entries[1]).toEqual({
      url: "https://shop.example.com/products/a",
      lastModified: new Date("2026-11-01T00:00:00.000Z"),
      changeFrequency: "weekly",
      priority: 0.8,
    });
    expect(entries[2]).not.toHaveProperty("lastModified");
    expect(entries[3]).not.toHaveProperty("lastModified");
  });

  test("skips blank and duplicate slugs and URL-encodes", () => {
    const urls = buildSitemapEntries([{ slug: "a" }, { slug: "a" }, { slug: "  " }, { slug: "x y" }]).map(
      (entry) => entry.url,
    );
    expect(urls).toEqual([
      "https://shop.example.com/",
      "https://shop.example.com/products/a",
      "https://shop.example.com/products/x%20y",
    ]);
  });
});

describe("toSitemapProduct", () => {
  test("picks up an updatedAt string when present, ignores other fields", () => {
    expect(toSitemapProduct({ slug: "a" })).toEqual({ slug: "a" });
    const row = { slug: "b", name: "B", updatedAt: "2026-11-01T00:00:00.000Z" };
    expect(toSitemapProduct(row)).toEqual({ slug: "b", updatedAt: "2026-11-01T00:00:00.000Z" });
    const odd = { slug: "c", updatedAt: 123 };
    expect(toSitemapProduct(odd)).toEqual({ slug: "c" });
  });
});

const EMPTY: SiteSitemapData = { products: [], categories: [], brands: [], helpTopics: [] };

describe("buildSiteSitemap", () => {
  test("empty data still lists every static sitemap route of the policy table, in order", () => {
    const urls = buildSiteSitemap(EMPTY).map((entry) => entry.url.replace("https://shop.example.com", ""));
    const expected = ROUTE_POLICIES.filter((p) => p.sitemap && !p.route.includes("[")).map((p) => p.route);
    expect(urls).toEqual(expected);
    expect(urls[0]).toBe("/");
    expect(urls).toContain("/faq");
    expect(urls).not.toContain("/signin");
  });

  test("fills dynamic routes from their sources; skips blanks and duplicate URLs; encodes slugs", () => {
    const urls = buildSiteSitemap({
      products: [{ slug: "a" }, { slug: "a" }, { slug: " " }, { slug: "x y" }],
      categories: [{ slug: "kitchen" }, { slug: "kitchen" }],
      brands: [{ slug: "acme" }],
      helpTopics: [{ slug: "shipping" }],
    }).map((entry) => entry.url);
    expect(urls).toContain("https://shop.example.com/products/a");
    expect(urls).toContain("https://shop.example.com/products/x%20y");
    expect(urls).toContain("https://shop.example.com/category/kitchen");
    expect(urls).toContain("https://shop.example.com/brand/acme");
    expect(urls).toContain("https://shop.example.com/help/shipping");
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.filter((u) => u.endsWith("/products/a"))).toHaveLength(1);
  });

  test("lastModified only for valid dates; home gets the newest product date", () => {
    const entries = buildSiteSitemap({
      ...EMPTY,
      products: [
        { slug: "a", updatedAt: "2026-11-01T00:00:00.000Z" },
        { slug: "b", updatedAt: "garbage" },
        { slug: "c", updatedAt: "2026-11-05T00:00:00.000Z" },
      ],
      categories: [{ slug: "k", updatedAt: "2026-10-01T00:00:00.000Z" }, { slug: "m" }],
    });
    const byPath = new Map(entries.map((e) => [e.url.replace("https://shop.example.com", ""), e]));
    expect(byPath.get("/")?.lastModified).toEqual(new Date("2026-11-05T00:00:00.000Z"));
    expect(byPath.get("/products/a")?.lastModified).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(byPath.get("/products/b")).not.toHaveProperty("lastModified");
    expect(byPath.get("/category/k")?.lastModified).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(byPath.get("/category/m")).not.toHaveProperty("lastModified");
    expect(byPath.get("/faq")).not.toHaveProperty("lastModified");
  });

  test("caps at the limit and reports the overflow once", () => {
    const reports: [number, number][] = [];
    const policies: RoutePolicy[] = [
      { route: "/", file: "src/app/page.tsx", indexing: "indexable", sitemap: true, canonical: "self", robotsDisallowed: false },
      {
        route: "/products/[slug]",
        file: "src/app/products/[slug]/page.tsx",
        indexing: "indexable",
        sitemap: true,
        sitemapSource: "products",
        canonical: "self",
        robotsDisallowed: false,
      },
    ];
    const products = Array.from({ length: 10 }, (_, i) => ({ slug: `p${i}` }));
    const entries = buildSiteSitemap({ ...EMPTY, products }, { policies, limit: 5, onOverflow: (t, l) => reports.push([t, l]) });
    expect(entries).toHaveLength(5);
    expect(reports).toEqual([[11, 5]]);
    expect(entries[0]?.url).toBe("https://shop.example.com/");
  });

  test("default overflow handler logs via console.error; limit constant is 50,000", () => {
    expect(SITEMAP_URL_LIMIT).toBe(50_000);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args[0]);
    };
    try {
      buildSiteSitemap(EMPTY, { limit: 1 });
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("exceed");
  });

  test("an entry never has an Invalid Date", () => {
    const entries = buildSiteSitemap({ ...EMPTY, products: [{ slug: "a", updatedAt: "2026-13-45" }] });
    for (const entry of entries) {
      if (entry.lastModified instanceof Date) expect(Number.isNaN(entry.lastModified.getTime())).toBe(false);
    }
  });
});
