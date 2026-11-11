import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render } from "@testing-library/react";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { Metadata } from "next";

// ---------------------------------------------------------------------------
// QA-W0-S criteria 5 + 6: sitemap/robots/manifest route functions and page
// metadata. mock.module is process-wide in bun test: every mock is registered
// here before the pages are imported, spreads the real module, and delegates
// to per-test state in this file.
// ---------------------------------------------------------------------------

class NotFoundSentinel extends Error {
  constructor() {
    super("NEXT_NOT_FOUND (qa sentinel)");
  }
}

const callLog: string[] = [];
let connectionBehaviour: "ok" | "throw" = "ok";
const connection = mock(async (): Promise<void> => {
  callLog.push("connection");
  if (connectionBehaviour === "throw") throw new Error("prerender abort (qa)");
});

const realServer = { ...(await import("next/server")) };
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/server", () => ({ ...realServer, connection }));
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    throw new NotFoundSentinel();
  },
}));

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string): void {
    this.jar.set(name, value);
  }
}
const fakeStore = new FakeCookieStore();
// Spread the real modules: bun keeps the first registered export set for the
// whole process, so a partial mock would break later files that import
// `headers` or `revalidateTag`.
const realHeaders = { ...(await import("next/headers")) };
const realCache = { ...(await import("next/cache")) };
mock.module("next/headers", () => ({ ...realHeaders, cookies: async (): Promise<FakeCookieStore> => fakeStore }));
mock.module("next/cache", () => ({ ...realCache, revalidatePath: () => undefined }));
mock.module("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-sans", className: "geist" }),
  Geist_Mono: () => ({ variable: "font-geist-mono", className: "geist-mono" }),
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
const originalSiteUrl = env.NEXT_PUBLIC_SITE_URL;
env.DATABASE_PATH = ":memory:";
env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedProducts } = await import("@/server/db/seed");
const { SqliteProductRepository } = await import("@/server/catalog/product-repository");
const { JsonLd } = await import("@/components/molecules/JsonLd");
const pdp = await import("@/app/products/[slug]/page");
const home = await import("@/app/page");
const cart = await import("@/app/cart/page");
const checkout = await import("@/app/checkout/page");
const order = await import("@/app/orders/[id]/page");
const notFoundPage = await import("@/app/not-found");
const layout = await import("@/app/layout");
const { default: sitemap } = await import("@/app/sitemap");
const { default: robots } = await import("@/app/robots");
const { default: manifest } = await import("@/app/manifest");

function reseed(): void {
  closeDatabase();
  seedProducts(getDatabase());
}
reseed();

const listSpy = spyOn(SqliteProductRepository.prototype, "listPublishedSlugsWithUpdatedAt");
const getBySlugSpy = spyOn(SqliteProductRepository.prototype, "getBySlug");

beforeEach(() => {
  env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
  connectionBehaviour = "ok";
  callLog.length = 0;
  connection.mockClear();
  listSpy.mockClear();
  getBySlugSpy.mockClear();
});

afterAll(() => {
  closeDatabase();
  listSpy.mockRestore();
  getBySlugSpy.mockRestore();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
  if (originalSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

function allSlugs(): string[] {
  return getDatabase()
    .query<{ slug: string }, []>("SELECT slug FROM products")
    .all()
    .map((r) => r.slug);
}

function ogImages(m: Metadata): string[] {
  const images = m.openGraph?.images;
  const list = Array.isArray(images) ? images : images === undefined ? [] : [images];
  return list.map((i) => (typeof i === "string" ? i : i instanceof URL ? i.href : String(i.url)));
}

function robotsOf(m: Metadata): { index?: boolean; follow?: boolean } | undefined {
  return typeof m.robots === "object" && m.robots !== null ? m.robots : undefined;
}

// ---------------------------------------------------------------------------
// Criterion 5: route functions
// ---------------------------------------------------------------------------
describe("C5 app/sitemap.ts", () => {
  test("awaits connection() before the product query", async () => {
    // T112: the sitemap reads products through listPublishedSlugsWithUpdatedAt (one query).
    listSpy.mockImplementation(function (this: InstanceType<typeof SqliteProductRepository>, nowIso: string) {
      callLog.push("list");
      listSpy.mockRestore();
      return SqliteProductRepository.prototype.listPublishedSlugsWithUpdatedAt.call(this, nowIso);
    });
    await sitemap();
    expect(callLog[0]).toBe("connection");
    expect(callLog).toContain("list");
  });

  test("when connection() aborts, the DB is never opened (no file created)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-w0-s-"));
    const dbFile = join(dir, "never.sqlite");
    closeDatabase();
    env.DATABASE_PATH = dbFile;
    connectionBehaviour = "throw";
    try {
      await expect(sitemap()).rejects.toThrow("prerender abort (qa)");
      expect(existsSync(dbFile)).toBe(false);
    } finally {
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
      rmSync(dir, { recursive: true, force: true });
      reseed();
    }
  });

  test("lists / and every product slug exactly once, absolute URLs", async () => {
    const entries = await sitemap();
    const urls = entries.map((e) => e.url);
    expect(urls[0]).toBe("https://shop.example.com/");
    const slugs = allSlugs();
    expect(slugs.length).toBeGreaterThan(0);
    for (const slug of slugs) expect(urls).toContain(`https://shop.example.com/products/${slug}`);
    // T112: the sitemap also lists categories, brands, collections and static pages.
    expect(urls.length).toBeGreaterThanOrEqual(slugs.length + 1);
    expect(new Set(urls).size).toBe(urls.length);
    for (const u of urls) expect(u.startsWith("https://shop.example.com/")).toBe(true);
  });
});

describe("C5 app/robots.ts", () => {
  test("allow /, disallow private routes, absolute sitemap", () => {
    const r = robots();
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    expect(rules.length).toBe(1);
    const rule = rules[0];
    expect(rule?.userAgent).toBe("*");
    expect(rule?.allow).toBe("/");
    const disallow = Array.isArray(rule?.disallow) ? rule.disallow : [rule?.disallow];
    for (const p of ["/cart", "/checkout", "/orders", "/account", "/lists", "/search", "/api/", "/compare"]) {
      expect(disallow).toContain(p);
    }
    expect(disallow).not.toContain("/");
    expect(r.sitemap).toBe("https://shop.example.com/sitemap.xml");
  });

  test("sitemap URL follows NEXT_PUBLIC_SITE_URL incl. base path", () => {
    env.NEXT_PUBLIC_SITE_URL = "https://example.com/store/";
    expect(robots().sitemap).toBe("https://example.com/store/sitemap.xml");
  });

  test("does not touch the DB", () => {
    robots();
    expect(listSpy).not.toHaveBeenCalled();
    expect(connection).not.toHaveBeenCalled();
  });
});

describe("C5 app/manifest.ts", () => {
  test("colours equal --accent and --surface-page from globals.css", async () => {
    const css = await Bun.file(`${import.meta.dir}/../../src/app/globals.css`).text();
    const token = (name: string): string | undefined =>
      new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(css)?.[1]?.toLowerCase();
    const m = manifest();
    expect(m.theme_color?.toLowerCase()).toBe(token("accent"));
    expect(m.background_color?.toLowerCase()).toBe(token("surface-page"));
    expect(m.name).toBe("Northwind Goods");
    expect(m.start_url).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: page metadata
// ---------------------------------------------------------------------------
const props = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("C6 PDP generateMetadata", () => {
  test("known slug: title, description, canonical, OG image", async () => {
    const product = new SqliteProductRepository(getDatabase()).getBySlug("canvas-tote-bag");
    expect(product).not.toBeNull();
    const m = await pdp.generateMetadata(props("canvas-tote-bag"));
    expect(String(m.title)).toContain("Canvas Tote Bag");
    expect(typeof m.description).toBe("string");
    expect(String(m.description).length).toBeGreaterThan(0);
    expect(product?.description.startsWith(String(m.description).replace(/…$/, ""))).toBe(true);
    expect(m.alternates?.canonical).toBe("https://shop.example.com/products/canvas-tote-bag");
    expect(ogImages(m)).toEqual([`https://shop.example.com${product?.imageUrl ?? ""}`]);
    expect(m.robots).toBeUndefined();
    expect(connection).toHaveBeenCalled();
  });

  test("every seeded product produces indexable metadata with its own canonical", async () => {
    for (const slug of allSlugs()) {
      const m = await pdp.generateMetadata(props(slug));
      expect(m.alternates?.canonical).toBe(`https://shop.example.com/products/${slug}`);
      expect(String(m.title).length).toBeLessThanOrEqual(60);
      expect(String(m.description).length).toBeLessThanOrEqual(160);
    }
  });

  test.each([
    ["'; DROP TABLE products; --"],
    ["a".repeat(10_000)],
    ["../../etc/passwd"],
    ["nope-not-a-product"],
    [""],
    ["<script>alert(1)</script>"],
    ["%00"],
    ["Canvas-Tote-Bag"],
  ])("unknown/hostile slug %#: no throw, 'Product not found' + noindex, no canonical", async (slug) => {
    const m = await pdp.generateMetadata(props(slug));
    expect(m.title).toBe("Product not found");
    expect(robotsOf(m)?.index).toBe(false);
    expect(robotsOf(m)?.follow).toBe(false);
    expect(m.alternates).toBeUndefined();
    expect(ogImages(m)).toEqual([]);
    expect(JSON.stringify(m)).not.toContain(slug.length > 0 && slug.length < 100 ? slug : "\u0000");
  });

  test("products table intact after hostile metadata calls", async () => {
    await pdp.generateMetadata(props("x'; DROP TABLE products; --"));
    expect(allSlugs().length).toBeGreaterThan(0);
  });
});

describe("C6 static page metadata", () => {
  test("home: indexable, canonical /", () => {
    // Static `metadata` is evaluated once at module import (another test file
    // may import the page first with NEXT_PUBLIC_SITE_URL unset), so only the
    // shape is asserted: an absolute site root.
    expect(String(home.metadata.alternates?.canonical)).toMatch(/^https?:\/\/[^/]+\/$/);
    expect(home.metadata.robots).toBeUndefined();
  });

  test.each([
    ["cart", cart.metadata],
    ["checkout", checkout.metadata],
    ["not-found", notFoundPage.metadata],
  ])("%s is noindex", (_name, m) => {
    expect(robotsOf(m)?.index).toBe(false);
  });

  test("not-found has no canonical", () => {
    expect(notFoundPage.metadata.alternates).toBeUndefined();
  });

  test("orders metadata: noindex, no canonical, no og:url, no order id or PII", async () => {
    const m = await order.generateMetadata();
    expect(robotsOf(m)?.index).toBe(false);
    expect(m.alternates).toBeUndefined();
    expect(m.openGraph && "url" in m.openGraph).toBe(false);
    const json = JSON.stringify(m);
    expect(json).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(json).not.toMatch(/ord_|@|\/orders\//i);
  });
});

describe("C6 PDP JSON-LD in page output", () => {
  test("renders Product and BreadcrumbList JSON-LD", async () => {
    const { container } = render(await pdp.default(props("canvas-tote-bag")));
    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts.length).toBe(1);
    const parsed: unknown = JSON.parse(scripts[0]?.textContent ?? "null");
    expect(Array.isArray(parsed)).toBe(true);
    const docs = parsed as { "@type": string; [k: string]: unknown }[];
    expect(docs.map((d) => d["@type"]).sort()).toEqual(["BreadcrumbList", "Product"]);
    const productDoc = docs.find((d) => d["@type"] === "Product");
    expect(productDoc?.name).toBe("Canvas Tote Bag");
    expect(productDoc?.url).toBe("https://shop.example.com/products/canvas-tote-bag");
    expect((productDoc?.offers as { price?: unknown } | undefined)?.price).toBe("19.99");
    // P2-A (in flight) adds a real sku; otherwise the builder falls back to id.
    const product = new SqliteProductRepository(getDatabase()).getBySlug("canvas-tote-bag");
    const row: Record<string, unknown> | null = product ? { ...product } : null;
    const expectedSku = typeof row?.sku === "string" && row.sku.trim() ? row.sku.trim() : row?.id;
    expect(productDoc?.sku).toBe(expectedSku);
    const crumbs = docs.find((d) => d["@type"] === "BreadcrumbList")?.itemListElement as {
      position: number;
      item: string;
    }[];
    // T97: the PDP breadcrumb is Home › department › category › product, so the
    // list has >= 2 entries with consecutive positions, Home first, product last.
    expect(crumbs.length).toBeGreaterThanOrEqual(2);
    expect(crumbs.map((c) => c.position)).toEqual(crumbs.map((_, i) => i + 1));
    expect(crumbs[0]?.item).toBe("https://shop.example.com/");
    expect(crumbs[crumbs.length - 1]?.item).toBe("https://shop.example.com/products/canvas-tote-bag");
  });

  test("out-of-stock product JSON-LD says OutOfStock", async () => {
    const { container } = render(await pdp.default(props("ceramic-pour-over")));
    const text = container.querySelector('script[type="application/ld+json"]')?.textContent ?? "";
    expect(text).toContain("https://schema.org/OutOfStock");
    expect(text).not.toContain("https://schema.org/InStock");
  });
});

// ---------------------------------------------------------------------------
// Layout: Organization + WebSite exactly once
// ---------------------------------------------------------------------------
function collect(node: ReactNode, out: ReactElement[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return;
  }
  if (!isValidElement(node)) return;
  out.push(node);
  const children = (node.props as { children?: ReactNode }).children;
  if (children !== undefined) collect(children, out);
}

describe("C6 root layout", () => {
  test("metadata: title template, metadataBase, indexable default", () => {
    const m = layout.metadata;
    expect(String(m.metadataBase)).toMatch(/^https?:\/\//);
    expect(m.title).toEqual({ default: "Northwind Goods", template: "%s | Northwind Goods" });
    expect(robotsOf(m)?.index).toBe(true);
  });

  test("renders Organization + WebSite JSON-LD exactly once", () => {
    const tree = layout.default({ children: null, params: Promise.resolve({}) } as Parameters<
      typeof layout.default
    >[0]);
    const elements: ReactElement[] = [];
    collect(tree, elements);
    const jsonLd = elements.filter((e) => e.type === JsonLd);
    expect(jsonLd.length).toBe(1);
    const data = (jsonLd[0]?.props as { data: unknown }).data;
    const docs = (Array.isArray(data) ? data : [data]) as { "@type": string }[];
    const types = docs.map((d) => d["@type"]);
    expect(types.filter((t) => t === "Organization").length).toBe(1);
    expect(types.filter((t) => t === "WebSite").length).toBe(1);
    expect(types.length).toBe(2);
  });
});

afterEach(() => {
  listSpy.mockClear();
});
