import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// mock.module is process-wide in bun test: spread the real module so other
// test files sharing this process keep every other next/server export.
const calls: string[] = [];
const connection = mock(async (): Promise<void> => {
  calls.push("connection");
});
const realServer = { ...(await import("next/server")) };
mock.module("next/server", () => ({ ...realServer, connection }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
const originalSiteUrl = env.NEXT_PUBLIC_SITE_URL;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { SEED_UNPUBLISHED_SLUGS, seedDatabase } = await import("@/server/db/seed");
const { SqliteProductRepository } = await import("@/server/catalog/product-repository");
const { HELP_TOPIC_SLUGS } = await import("@/content/help-topics");
const { POLICY_SLUGS } = await import("@/content/policies");
const { SITEMAP_URL_LIMIT } = await import("@/lib/seo/sitemap");
const { default: sitemap } = await import("./sitemap");

const SITE = "https://shop.example.com";

function reseed(): void {
  closeDatabase();
  seedDatabase(getDatabase());
}
reseed();

const realList = SqliteProductRepository.prototype.listPublishedSlugsWithUpdatedAt;
const list = spyOn(SqliteProductRepository.prototype, "listPublishedSlugsWithUpdatedAt");

beforeEach(() => {
  env.NEXT_PUBLIC_SITE_URL = SITE;
  calls.length = 0;
  list.mockImplementation(function (this: InstanceType<typeof SqliteProductRepository>, nowIso: string) {
    calls.push("list");
    return realList.call(this, nowIso);
  });
});

afterEach(() => {
  list.mockReset();
  connection.mockClear();
});

afterAll(() => {
  list.mockRestore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
  if (originalSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

function column(sql: string): string[] {
  return getDatabase()
    .query<{ v: string }, []>(sql)
    .all()
    .map((row) => row.v);
}

/** Seeded product slugs visible today (the seed future-dates SEED_UNPUBLISHED_SLUGS). */
function publishedProductSlugs(): string[] {
  return column("SELECT slug AS v FROM products ORDER BY slug").filter((slug) => !SEED_UNPUBLISHED_SLUGS.includes(slug));
}

function paths(entries: { url: string }[]): string[] {
  return entries.map((entry) => entry.url.slice(SITE.length));
}

const STATIC_PATHS = [
  "/",
  "/products",
  "/deals",
  "/best-sellers",
  "/new-arrivals",
  "/top-rated",
  "/brands",
  "/help",
  "/faq",
  ...POLICY_SLUGS.map((slug) => `/${slug}`),
];

describe("sitemap.xml", () => {
  test("calls connection() before reading the catalogue (no DB access at build time)", async () => {
    await sitemap();
    expect(calls[0]).toBe("connection");
    expect(calls).toContain("list");
  });

  test("lists every public indexable route exactly once, absolute URLs", async () => {
    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);
    expect(new Set(urls).size).toBe(urls.length);
    for (const url of urls) expect(url.startsWith(`${SITE}/`)).toBe(true);

    const expected = new Set([
      ...STATIC_PATHS,
      ...HELP_TOPIC_SLUGS.map((slug) => `/help/${slug}`),
      ...column("SELECT slug AS v FROM categories").map((slug) => `/category/${slug}`),
      ...column("SELECT slug AS v FROM brands").map((slug) => `/brand/${slug}`),
      ...publishedProductSlugs().map((slug) => `/products/${slug}`),
    ]);
    expect(new Set(paths(entries))).toEqual(expected);
    expect(urls).toHaveLength(expected.size);
    expect(entries[0]).toMatchObject({ url: `${SITE}/`, priority: 1 });
  });

  test("covers both category levels, eight help topics and six policy routes", async () => {
    const got = paths(await sitemap());
    const departments = column("SELECT slug AS v FROM categories WHERE parent_id IS NULL");
    const children = column("SELECT slug AS v FROM categories WHERE parent_id IS NOT NULL");
    expect(departments.length).toBeGreaterThan(0);
    expect(children.length).toBeGreaterThan(0);
    for (const slug of [...departments, ...children]) expect(got).toContain(`/category/${slug}`);
    expect(got.filter((p) => p.startsWith("/help/"))).toHaveLength(8);
    for (const slug of POLICY_SLUGS) expect(got).toContain(`/${slug}`);
    expect(POLICY_SLUGS).toHaveLength(6);
  });

  test("excludes private, search and auth routes", async () => {
    const got = paths(await sitemap());
    const excluded = /^\/(cart|checkout|orders|account|lists|compare|search|api|contact|signin|signup)(\/|\?|$)/;
    expect(got.filter((p) => excluded.test(p))).toEqual([]);
  });

  test("lastModified is updated_at for products, categories and brands (one product query)", async () => {
    const entries = await sitemap();
    expect(list).toHaveBeenCalledTimes(1);
    const stampsOf = (table: "products" | "categories" | "brands") =>
      new Map(
        getDatabase()
          .query<{ slug: string; updated_at: string }, []>(`SELECT slug, updated_at FROM ${table}`)
          .all()
          .map((row) => [row.slug, row.updated_at]),
      );
    const stamps = { "/products/": stampsOf("products"), "/category/": stampsOf("categories"), "/brand/": stampsOf("brands") };
    for (const slug of SEED_UNPUBLISHED_SLUGS) stamps["/products/"].delete(slug); // not in the sitemap
    let checked = 0;
    for (const entry of entries) {
      const path = entry.url.slice(SITE.length);
      for (const [prefix, map] of Object.entries(stamps)) {
        if (!path.startsWith(prefix)) continue;
        const stamp = map.get(decodeURIComponent(path.slice(prefix.length)));
        expect(entry.lastModified).toEqual(new Date(stamp ?? "invalid"));
        checked += 1;
      }
    }
    expect(checked).toBe(stamps["/products/"].size + stamps["/category/"].size + stamps["/brand/"].size);
    const newest = [...stamps["/products/"].values()].sort().at(-1);
    expect(entries[0]?.lastModified).toEqual(new Date(newest ?? "invalid"));
    expect(entries.find((e) => e.url === `${SITE}/faq`)).not.toHaveProperty("lastModified");
  });

  test("a changed brand/category updated_at shows up as lastModified", async () => {
    const db = getDatabase();
    const [brand] = column("SELECT slug AS v FROM brands ORDER BY slug LIMIT 1");
    const [category] = column("SELECT slug AS v FROM categories ORDER BY slug LIMIT 1");
    try {
      db.run("UPDATE brands SET updated_at = '2026-10-01T00:00:00.000Z' WHERE slug = ?", [brand ?? ""]);
      db.run("UPDATE categories SET updated_at = '2026-10-02T00:00:00.000Z' WHERE slug = ?", [category ?? ""]);
      const entries = await sitemap();
      expect(entries.find((e) => e.url === `${SITE}/brand/${brand}`)?.lastModified).toEqual(new Date("2026-10-01T00:00:00.000Z"));
      expect(entries.find((e) => e.url === `${SITE}/category/${category}`)?.lastModified).toEqual(
        new Date("2026-10-02T00:00:00.000Z"),
      );
    } finally {
      reseed();
    }
  });

  test("unpublished products (future or empty published_at) are excluded", async () => {
    const [future, blank] = publishedProductSlugs();
    if (future === undefined || blank === undefined) throw new Error("seed is too small");
    const db = getDatabase();
    try {
      db.run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE slug = ?", [future]);
      db.run("UPDATE products SET published_at = '' WHERE slug = ?", [blank]);
      const got = paths(await sitemap());
      expect(got).not.toContain(`/products/${future}`);
      expect(got).not.toContain(`/products/${blank}`);
      expect(got.filter((p) => p.startsWith("/products/")).length).toBe(publishedProductSlugs().length - 2);
    } finally {
      reseed();
    }
  });

  test("stays under the 50,000 URL single-file limit (generateSitemaps not needed)", async () => {
    const entries = await sitemap();
    expect(entries.length).toBeLessThan(SITEMAP_URL_LIMIT);
  });

  test("repository errors propagate (no silently empty sitemap)", async () => {
    list.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(sitemap()).rejects.toThrow("db down");
  });

  test("a connection() rejection (prerender bail-out) stops before the DB is read", async () => {
    connection.mockImplementationOnce(async () => {
      throw new Error("dynamic bail-out");
    });
    await expect(sitemap()).rejects.toThrow("dynamic bail-out");
    expect(list).not.toHaveBeenCalled();
  });
});
