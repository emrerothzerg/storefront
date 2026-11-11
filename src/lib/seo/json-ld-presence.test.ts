import { afterAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// T112 criterion 6: JSON-LD present where promised, and every ld+json script
// on every indexable page parses. Pages are rendered as they are (no page
// logic duplicated here). mock.module is process-wide in bun test: each mock
// spreads the real module and only replaces request-bound functions.
// ---------------------------------------------------------------------------

const emptyCookies = {
  get: (): undefined => undefined,
  has: (): boolean => false,
  getAll: (): never[] => [],
  set: (): void => undefined,
  delete: (): void => undefined,
};

const realServer = { ...(await import("next/server")) };
const realHeaders = { ...(await import("next/headers")) };
const realNavigation = { ...(await import("next/navigation")) };
const realCache = { ...(await import("next/cache")) };
mock.module("next/server", () => ({ ...realServer, connection: async (): Promise<void> => {} }));
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: async () => emptyCookies,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND (json-ld audit sentinel)");
  },
  redirect: (url: string): never => {
    throw new Error(`NEXT_REDIRECT (json-ld audit sentinel) ${url}`);
  },
}));
mock.module("next/cache", () => ({ ...realCache, revalidatePath: (): void => undefined }));
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
const { seedDatabase } = await import("@/server/db/seed");
const { JsonLd } = await import("@/components/molecules/JsonLd");
const { ROUTE_POLICIES, fillRoute } = await import("./routes");

closeDatabase();
seedDatabase(getDatabase());

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
  if (originalSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");

function firstValue(sql: string): string {
  const row = getDatabase().query<{ v: string }, []>(sql).get();
  if (row === null) throw new Error(`seed returned nothing for: ${sql}`);
  return row.v;
}

/** One representative slug per dynamic indexable route. */
const SAMPLE_SLUG: Readonly<Record<string, string>> = {
  "/products/[slug]": firstValue(
    "SELECT slug AS v FROM products WHERE published_at <> '' AND published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') AND stock > 0 ORDER BY slug LIMIT 1",
  ),
  "/category/[slug]": firstValue("SELECT slug AS v FROM categories WHERE parent_id IS NOT NULL ORDER BY slug LIMIT 1"),
  "/brand/[slug]": firstValue("SELECT slug AS v FROM brands ORDER BY slug LIMIT 1"),
  "/help/[topic]": "shipping",
};
const DEPARTMENT = firstValue("SELECT slug AS v FROM categories WHERE parent_id IS NULL ORDER BY slug LIMIT 1");

interface LdDoc {
  readonly "@context"?: unknown;
  readonly "@type"?: unknown;
  readonly [key: string]: unknown;
}

interface PageModule {
  readonly default: (props: unknown) => ReactNode | Promise<ReactNode>;
}

async function renderPage(file: string, params: Readonly<Record<string, string>>): Promise<string> {
  const mod = (await import(join(PROJECT_ROOT, file))) as PageModule;
  const node = await mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve({}) });
  if (!isValidElement(node)) throw new Error(`${file} rendered no element`);
  return renderToStaticMarkup(node);
}

const SCRIPT = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;

/** Every ld+json script body in `html`. */
function scriptBodies(html: string): string[] {
  return [...html.matchAll(SCRIPT)].map((match) => match[1] ?? "");
}

/** Parses every script (throws on invalid JSON) and flattens arrays and `@graph`. */
function parseDocs(html: string): LdDoc[] {
  const docs: LdDoc[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) throw new Error("JSON-LD document is not an object");
    const doc = value as LdDoc;
    if (Array.isArray(doc["@graph"])) visit(doc["@graph"]);
    else docs.push(doc);
  };
  for (const body of scriptBodies(html)) visit(JSON.parse(body) as unknown);
  return docs;
}

function types(docs: readonly LdDoc[]): string[] {
  return docs.map((doc) => String(doc["@type"]));
}

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

describe("criterion 6: JSON-LD where promised", () => {
  test("home: the root layout emits Organization + WebSite with a SearchAction", async () => {
    const layout = (await import("@/app/layout")) as { default: (props: unknown) => ReactNode };
    const elements: ReactElement[] = [];
    collect(layout.default({ children: null, params: Promise.resolve({}) }), elements);
    const html = elements
      .filter((element) => element.type === JsonLd)
      .map((element) => renderToStaticMarkup(element))
      .join("");
    const docs = parseDocs(html);
    expect(types(docs).sort()).toEqual(["Organization", "WebSite"]);
    const website = docs.find((doc) => doc["@type"] === "WebSite");
    const action = website?.potentialAction as { "@type"?: string; target?: { urlTemplate?: string } } | undefined;
    expect(action?.["@type"]).toBe("SearchAction");
    expect(action?.target?.urlTemplate).toBe("https://shop.example.com/search?q={search_term_string}");
  });

  test("home page body: every script parses (deals ItemList when present)", async () => {
    const docs = parseDocs(await renderPage("src/app/page.tsx", {}));
    for (const t of types(docs)) expect(["ItemList", "BreadcrumbList"]).toContain(t);
  });

  test("PDP: Product + BreadcrumbList", async () => {
    const docs = parseDocs(await renderPage("src/app/products/[slug]/page.tsx", { slug: SAMPLE_SLUG["/products/[slug]"] ?? "" }));
    expect(types(docs)).toContain("Product");
    expect(types(docs)).toContain("BreadcrumbList");
  });

  const listings: [string, string, Record<string, string>][] = [
    ["/products", "src/app/products/page.tsx", {}],
    ["/deals", "src/app/deals/page.tsx", {}],
    ["/best-sellers", "src/app/best-sellers/page.tsx", {}],
    ["/new-arrivals", "src/app/new-arrivals/page.tsx", {}],
    ["/top-rated", "src/app/top-rated/page.tsx", {}],
    ["/category/<department>", "src/app/category/[slug]/page.tsx", { slug: DEPARTMENT }],
    ["/category/<category>", "src/app/category/[slug]/page.tsx", { slug: SAMPLE_SLUG["/category/[slug]"] ?? "" }],
    ["/brand/<slug>", "src/app/brand/[slug]/page.tsx", { slug: SAMPLE_SLUG["/brand/[slug]"] ?? "" }],
  ];
  test.each(listings)("listing %s: ItemList + BreadcrumbList", async (_label, file, params) => {
    const docs = parseDocs(await renderPage(file, params));
    expect(types(docs)).toContain("ItemList");
    expect(types(docs)).toContain("BreadcrumbList");
    const list = docs.find((doc) => doc["@type"] === "ItemList");
    expect(Array.isArray(list?.itemListElement) && list.itemListElement.length > 0).toBe(true);
  });

  test("/faq: FAQPage with questions", async () => {
    const docs = parseDocs(await renderPage("src/app/faq/page.tsx", {}));
    const faq = docs.find((doc) => doc["@type"] === "FAQPage");
    expect(faq).toBeDefined();
    expect(Array.isArray(faq?.mainEntity) && faq.mainEntity.length > 0).toBe(true);
  });
});

describe("criterion 6: every ld+json script on every indexable page parses", () => {
  const indexable = ROUTE_POLICIES.filter((policy) => policy.indexing === "indexable");
  test.each(indexable.map((policy) => [policy.route, policy.file] as const))("%s", async (route, file) => {
    const slug = SAMPLE_SLUG[route];
    const name = /\[([^\]]+)\]/.exec(route)?.[1];
    const params: Record<string, string> = name !== undefined && slug !== undefined ? { [name]: slug } : {};
    const html = await renderPage(file, params);
    const bodies = scriptBodies(html);
    // Every indexable page carries at least a BreadcrumbList or ItemList today.
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(() => JSON.parse(body) as unknown).not.toThrow();
    for (const doc of parseDocs(html)) {
      expect(doc["@context"]).toBe("https://schema.org");
      expect(typeof doc["@type"]).toBe("string");
    }
    // Absolute URLs only: no relative "item"/"url" values leak into structured data.
    for (const match of html.matchAll(/"(?:item|url)":"([^"]*)"/g)) {
      expect(match[1]).toMatch(/^https?:\/\//);
    }
    expect(fillRoute(route, slug ?? "x").startsWith("/")).toBe(true);
  });
});
