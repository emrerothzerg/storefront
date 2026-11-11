/**
 * T104b (QA wave 5, part B): page-level QA of the listing routes and the
 * shared listing loader/template (T91, T105-T107).
 *
 * Pattern: page functions + `generateMetadata` called directly with mocked
 * `next/*` modules, `renderToStaticMarkup`, a `:memory:` SQLite database
 * seeded through the real seed + services (the preload forces
 * `DATABASE_PATH=:memory:`). QA-owned; never edits implementer files.
 *
 * Defect pins use `test.failing` and are tagged `// PIN: D-Txx-n`.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Metadata } from "next";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// next/* mocks (process-wide). Identical in all three T104b files and backed
// by one shared state object, so whichever registration is active counts.
// ---------------------------------------------------------------------------

interface QaState {
  cookieCalls: number;
  notFoundCalls: number;
  jar: Map<string, string>;
}
const g = globalThis as typeof globalThis & { __qaT104b?: QaState };
const qa: QaState = (g.__qaT104b ??= { cookieCalls: 0, notFoundCalls: 0, jar: new Map() });

const realServer = { ...(await import("next/server")) };
const realHeaders = { ...(await import("next/headers")) };
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/server", () => ({ ...realServer, connection: async (): Promise<void> => {} }));
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: async () => {
    qa.cookieCalls += 1;
    return {
      get: (name: string) => (qa.jar.has(name) ? { name, value: qa.jar.get(name) ?? "" } : undefined),
      has: (name: string) => qa.jar.has(name),
      getAll: () => [...qa.jar].map(([name, value]) => ({ name, value })),
      set: () => {
        throw new Error("render must not set cookies");
      },
      delete: () => {
        throw new Error("render must not delete cookies");
      },
    };
  },
  headers: async () => new Headers(),
}));
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    qa.notFoundCalls += 1;
    throw new Error("NEXT_NOT_FOUND (T104b sentinel)");
  },
}));

const env = process.env as Record<string, string | undefined>;
env.DATABASE_PATH = ":memory:";
const SITE = "https://shop.example.com";
env.NEXT_PUBLIC_SITE_URL = SITE;

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { SEED_CATALOG_STATS, seedDatabase } = await import("@/server/db/seed");
const { getListingService } = await import("@/server/catalog/listing-service");
const session = await import("@/server/session/session");
const currentUser = await import("@/server/session/current-user");
const { isAllowedInternalHref } = await import("@/content/routes");
const { ListingTemplate } = await import("@/components/templates/ListingTemplate");
const parse = await import("@/app/_listing/parse-params");
const listingPage = await import("@/app/_listing/listing-page");
const searchLib = await import("@/app/search/_lib/search-page");
const categoryLib = await import("@/app/category/[slug]/_lib/category-page");
const brandLib = await import("@/app/brand/[slug]/_lib/brand-page");

const productsPage = await import("@/app/products/page");
const dealsPage = await import("@/app/deals/page");
const bestSellersPage = await import("@/app/best-sellers/page");
const newArrivalsPage = await import("@/app/new-arrivals/page");
const categoryPage = await import("@/app/category/[slug]/page");
const brandPage = await import("@/app/brand/[slug]/page");
const brandsPage = await import("@/app/brands/page");
const searchPage = await import("@/app/search/page");

type SP = Record<string, string | string[] | undefined>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLONES = 30;
const CLONE_SOURCE_CATEGORY = "audio"; // department: electronics
let db: Database;
let cloneBrand = "";

/** Copies one audio product 30 times so electronics/audio/its brand paginate (2 pages of 24). */
function cloneProducts(database: Database): void {
  const source = database
    .query<{ id: string; brand: string }, []>(
      `SELECT p.id AS id, b.slug AS brand FROM products p
         JOIN categories c ON c.id = p.category_id JOIN brands b ON b.id = p.brand_id
        WHERE c.slug = '${CLONE_SOURCE_CATEGORY}' ORDER BY p.id LIMIT 1`,
    )
    .get();
  if (source === null) throw new Error("no audio product in seed");
  cloneBrand = source.brand;
  database.run("CREATE TEMP TABLE qa_clone AS SELECT * FROM products WHERE id = ?", [source.id]);
  for (let i = 1; i <= CLONES; i += 1) {
    database.run("UPDATE qa_clone SET id = ?, slug = ?, sku = NULL, name = ?", [
      `prod_qa-clone-${i}`,
      `qa-clone-${i}`,
      `QA clone speaker ${i}`,
    ]);
    database.run("INSERT INTO products SELECT * FROM qa_clone");
  }
  database.run("DROP TABLE qa_clone");
}

function totalChanges(database: Database): number {
  return database.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}

const restorers: Array<() => void> = [];

beforeAll(() => {
  env.NEXT_PUBLIC_SITE_URL = SITE;
  closeDatabase();
  db = getDatabase();
  seedDatabase(db);
  cloneProducts(db);
});

afterAll(() => {
  while (restorers.length > 0) restorers.pop()?.();
  closeDatabase();
});

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

interface RouteCase {
  readonly name: string;
  readonly base: string;
  readonly title: string;
  readonly page: (sp: SP) => Promise<ReactNode>;
  readonly metadata: (sp: SP) => Promise<Metadata>;
}

function collectionRoute(
  name: string,
  base: string,
  title: string,
  mod: { default: (p: { searchParams?: Promise<SP> }) => Promise<ReactNode>; generateMetadata: (p: { searchParams?: Promise<SP> }) => Promise<Metadata> },
): RouteCase {
  return {
    name,
    base,
    title,
    page: (sp) => mod.default({ searchParams: Promise.resolve(sp) }),
    metadata: (sp) => mod.generateMetadata({ searchParams: Promise.resolve(sp) }),
  };
}

function slugRoute(
  name: string,
  prefix: string,
  slug: string,
  title: string,
  mod: {
    default: (p: { params: Promise<{ slug: string }>; searchParams?: Promise<SP> }) => Promise<ReactNode>;
    generateMetadata: (p: { params: Promise<{ slug: string }>; searchParams?: Promise<SP> }) => Promise<Metadata>;
  },
): RouteCase {
  return {
    name,
    base: `${prefix}/${slug}`,
    title,
    page: (sp) => mod.default({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) }),
    metadata: (sp) => mod.generateMetadata({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(sp) }),
  };
}

const PRODUCTS = collectionRoute("/products", "/products", "All products", productsPage);
const DEALS = collectionRoute("/deals", "/deals", "Today's Deals", dealsPage);
const BEST = collectionRoute("/best-sellers", "/best-sellers", "Best Sellers", bestSellersPage);
const NEW = collectionRoute("/new-arrivals", "/new-arrivals", "New Arrivals", newArrivalsPage);
const DEPT = slugRoute("/category/electronics", "/category", "electronics", "Electronics", categoryPage);
const CHILD = slugRoute("/category/audio", "/category", "audio", "Headphones & Audio", categoryPage);
// Brand route uses the clone brand (paginates); resolved lazily after seeding.
function brandRoute(): RouteCase {
  const name = db.query<{ name: string }, [string]>("SELECT name FROM brands WHERE slug = ?").get(cloneBrand)?.name ?? "?";
  return slugRoute(`/brand/${cloneBrand}`, "/brand", cloneBrand, name, brandPage);
}
const SEARCH: RouteCase = {
  name: "/search",
  base: "/search",
  title: "All results",
  page: (sp) => searchPage.default({ searchParams: Promise.resolve(sp) }),
  metadata: (sp) => searchPage.generateMetadata({ searchParams: Promise.resolve(sp) }),
};

/** Indexable listing routes (everything except /search). */
function indexableRoutes(): RouteCase[] {
  return [PRODUCTS, DEALS, BEST, NEW, DEPT, CHILD, brandRoute()];
}

// ---------------------------------------------------------------------------
// Markup helpers
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HASH = String.fromCharCode(35);

function isNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const digest = (error as { digest?: unknown } | null)?.digest;
  return /NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK;404/.test(`${message} ${typeof digest === "string" ? digest : ""}`);
}

type Outcome = { readonly kind: "ok"; readonly tree: ReactNode; readonly html: string } | { readonly kind: "notFound" };

async function outcome(run: () => Promise<ReactNode>): Promise<Outcome> {
  try {
    const tree = await run();
    return { kind: "ok", tree, html: renderToStaticMarkup(<>{tree}</>) };
  } catch (error) {
    if (isNotFound(error)) return { kind: "notFound" };
    throw error;
  }
}

async function renderOk(route: RouteCase, sp: SP = {}): Promise<{ tree: ReactNode; html: string; doc: Document }> {
  const o = await outcome(() => route.page(sp));
  if (o.kind !== "ok") throw new Error(`${route.name} unexpectedly 404`);
  return { tree: o.tree, html: o.html, doc: parseHtml(o.html) };
}

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, "text/html");
}

function hrefs(doc: Document): string[] {
  return [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
}

function hrefViolations(doc: Document): string[] {
  const out: string[] = [];
  for (const href of hrefs(doc)) {
    if (href.startsWith(HASH)) {
      const id = decodeURIComponent(href.slice(1));
      if (id === "" || doc.getElementById(id) === null) out.push(`dangling:${href}`);
    } else if (!isAllowedInternalHref(href)) out.push(href);
  }
  return out;
}

function headingViolations(doc: Document): string[] {
  const levels = [...doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName.slice(1)));
  const out: string[] = [];
  const h1 = levels.filter((l) => l === 1).length;
  if (h1 !== 1) out.push(`h1 count ${h1}`);
  if (levels[0] !== 1) out.push(`first heading h${levels[0] ?? "none"}`);
  for (let i = 1; i < levels.length; i += 1) {
    const prev = levels[i - 1] ?? 1;
    const cur = levels[i] ?? 1;
    if (cur > prev + 1) out.push(`skip h${prev}->h${cur} at ${i}`);
  }
  return out;
}

function landmarkName(el: Element, doc: Document): string {
  const label = el.getAttribute("aria-label");
  if (label !== null) return label.trim();
  const by = el.getAttribute("aria-labelledby");
  if (by !== null) return by.split(/\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" ").trim();
  return "";
}

/** Same-role landmarks must be uniquely named; a page never renders its own `main` (the layout does). */
function landmarkViolations(doc: Document): string[] {
  const out: string[] = [];
  if (doc.body.querySelector("main, [role='main']") !== null) out.push("page renders main");
  const groups: Record<string, Element[]> = {
    navigation: [...doc.body.querySelectorAll("nav, [role='navigation']")],
    complementary: [...doc.body.querySelectorAll("aside, [role='complementary']")],
    search: [...doc.body.querySelectorAll("search, [role='search']")],
    region: [...doc.body.querySelectorAll("section[aria-label], section[aria-labelledby], [role='region']")],
  };
  for (const [role, els] of Object.entries(groups)) {
    if (els.length < 2) continue;
    const names = els.map((el) => landmarkName(el, doc));
    if (names.some((n) => n === "")) out.push(`${role}: unnamed among ${els.length}`);
    const dupes = names.filter((n, i) => n !== "" && names.indexOf(n) !== i);
    if (dupes.length > 0) out.push(`${role}: duplicate names ${dupes.join("|")}`);
  }
  return out;
}

function duplicateIds(doc: Document): string[] {
  const seen = new Map<string, number>();
  for (const el of doc.body.querySelectorAll("[id]")) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

function jsonLdScripts(doc: Document): Element[] {
  return [...doc.querySelectorAll('script[type="application/ld+json"]')];
}

type Json = Record<string, unknown>;

function jsonLdDocs(doc: Document): Json[] {
  const scripts = jsonLdScripts(doc);
  if (scripts.length === 0) return [];
  const parsed: unknown = JSON.parse(scripts[0]?.textContent ?? "null");
  return Array.isArray(parsed) ? (parsed as Json[]) : [parsed as Json];
}

function relLinks(html: string): { prev: string[]; next: string[] } {
  const find = (rel: string) =>
    [...html.matchAll(new RegExp(`<link[^>]*rel="${rel}"[^>]*>`, "g"))].map((m) => /href="([^"]*)"/.exec(m[0])?.[1] ?? "");
  return { prev: find("prev"), next: find("next") };
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;/g, "'");
}

/** Depth-first search of an element tree for the first element of `type`. */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child as ReactNode, type);
      if (hit !== null) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown>>;
  if (el.type === type) return el;
  return findElement(el.props.children as ReactNode, type);
}

function spyList() {
  const spy = spyOn(getListingService(), "list");
  return {
    spy,
    restore: () => spy.mockRestore(),
  };
}

function spyReaders() {
  const readSession = spyOn(session, "readSessionId");
  const readUser = spyOn(currentUser, "readCurrentUser");
  return {
    readSession,
    readUser,
    restore: () => {
      readSession.mockRestore();
      readUser.mockRestore();
    },
  };
}

function rankTexts(doc: Document): string[] {
  return [...doc.querySelectorAll('[data-testid="product-card-badges"]')].map((b) => (b.textContent ?? "").trim());
}

function rank(n: number): string {
  return `Rank ${HASH}${n}`;
}

/**
 * T172 pin move (T158 ruling): the badge strip now holds the rank AND the card badges
 * ("Rank #1Sale"), so a strip is matched by its leading rank only. The char after the
 * number must not be a digit, so `rank(1)` never matches "Rank #12".
 */
function leadingRank(text: string | undefined): string | null {
  const m = /^Rank \S(\d+)(?!\d)/.exec(text ?? "");
  return m === null ? null : rank(Number(m[1]));
}

// ---------------------------------------------------------------------------
// Criterion 1: parser fuzz (200 random query strings)
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so a failure is reproducible from its index. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_KEYS = [
  "q", "dept", "category", "brand", "min", "max", "rating", "instock", "deals", "sort", "page", "view",
  "p", "ref", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "__proto__", "constructor", "toString", "hasOwnProperty", "brand[]", "Q", "PAGE", "", "x".repeat(300),
] as const;

const FUZZ_VALUES: readonly string[] = [
  "", " ", "1", "0", "-1", "2", "3", "4", "5", "24", "999", "1000", "1001", "1e3", "0x10", "NaN", "Infinity",
  "999999999999999999999", "1.5", "+1", " 2 ", "electronics", "audio", "fiction", "voltline", "kestrel-audio",
  "no-such", "UPPER", "..", "%2e%2e", "../../etc/passwd", "<script>alert(1)</script>", '" OR 1=1 --',
  "AND", "OR", "NOT", "NEAR(", "*", "^", '"', "-", ":", "desk", "headphones", "a".repeat(10_000),
  "\u202e\u200bdesk", "\u0000\u0007x", "\u{1F600}", "\ud800", "café", "featured", "best_selling", "price_asc",
  "price_desc", "relevance", "rating", "newest", "grid", "list", "true", "on", "[object Object]", "%", "%zz",
  "+", "&", "=", "javascript:alert(1)", "//evil.example", "\\\\evil", "\r\nSet-Cookie: x=1",
];

/** encodeURIComponent, or the raw text when it holds a lone surrogate (cannot be encoded). */
function safeEncode(text: string): string {
  try {
    return encodeURIComponent(text);
  } catch {
    return text;
  }
}

function fuzzQuery(rand: () => number): string {
  const pairs: string[] = [];
  const n = 1 + Math.floor(rand() * 8);
  for (let i = 0; i < n; i += 1) {
    const key = FUZZ_KEYS[Math.floor(rand() * FUZZ_KEYS.length)] ?? "q";
    const value = FUZZ_VALUES[Math.floor(rand() * FUZZ_VALUES.length)] ?? "";
    // Mostly encoded; sometimes raw (malformed percent escapes, stray & and =).
    const raw = rand() < 0.2;
    pairs.push(`${raw ? key : safeEncode(key)}=${raw ? value : safeEncode(value)}`);
  }
  return pairs.join("&");
}

function assertParamsShape(params: Record<string, unknown>): void {
  const sorts = new Set(["relevance", "featured", "price_asc", "price_desc", "rating", "newest", "best_selling"]);
  if (params.q !== undefined) {
    expect(typeof params.q).toBe("string");
    expect((params.q as string).length).toBeLessThanOrEqual(100);
    expect(/\p{Cc}|\p{Cf}/u.test(params.q as string)).toBe(false);
  }
  for (const key of ["dept", "category"]) if (params[key] !== undefined) expect(params[key]).toMatch(/^[a-z0-9-]{1,64}$/);
  if (params.brand !== undefined) {
    expect(Array.isArray(params.brand)).toBe(true);
    for (const b of params.brand as string[]) expect(b).toMatch(/^[a-z0-9-]{1,64}$/);
    expect((params.brand as string[]).length).toBeLessThanOrEqual(10);
  }
  for (const key of ["min", "max"]) {
    if (params[key] !== undefined) {
      expect(Number.isSafeInteger(params[key])).toBe(true);
      expect(params[key] as number).toBeGreaterThanOrEqual(0);
    }
  }
  if (params.min !== undefined && params.max !== undefined) expect(params.min as number).toBeLessThanOrEqual(params.max as number);
  if (params.rating !== undefined) expect([1, 2, 3, 4]).toContain(params.rating as number);
  for (const key of ["instock", "deals"]) if (params[key] !== undefined) expect(params[key]).toBe(true);
  if (params.sort !== undefined) expect(sorts.has(params.sort as string)).toBe(true);
  if (params.page !== undefined) {
    expect(Number.isSafeInteger(params.page)).toBe(true);
    expect(params.page as number).toBeGreaterThanOrEqual(1);
    expect(params.page as number).toBeLessThanOrEqual(1000);
  }
  if (params.view !== undefined) expect(["grid", "list"]).toContain(params.view as string);
  if (params.extra !== undefined) {
    const allowed = new Set(["p", "ref", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]);
    for (const [k, v] of Object.entries(params.extra as Record<string, unknown>)) {
      expect(allowed.has(k)).toBe(true);
      expect(typeof v).toBe("string");
      expect((v as string).length).toBeLessThanOrEqual(200);
    }
  }
}

describe("criterion 1: parser fuzz + page render for 200 random query strings", () => {
  test(
    "parseListingParams never throws; every listing page function renders (200) for each string",
    async () => {
      const rand = prng(0x7104b);
      const routes = [...indexableRoutes(), SEARCH];
      const failures: string[] = [];
      for (let i = 0; i < 200; i += 1) {
        const qs = fuzzQuery(rand);
        let record: Record<string, string | string[]>;
        try {
          record = parse.searchParamsToRecord(new URLSearchParams(qs));
          const parsed = parse.parseListingParams(record);
          assertParamsShape(parsed.params as Record<string, unknown>);
          // Round trip stays parseable and stable (T91 AC2).
          const url = parse.buildListingUrl("/products", parsed.params);
          const again = parse.parseListingParams(parse.searchParamsToRecord(new URL(url, SITE).searchParams));
          expect(parse.buildListingUrl("/products", again.params)).toBe(url);
        } catch (error) {
          failures.push(`#${i} parse ${JSON.stringify(qs.slice(0, 120))}: ${String(error)}`);
          continue;
        }
        const route = routes[i % routes.length];
        if (route === undefined) continue;
        try {
          const o = await outcome(() => route.page(record));
          if (o.kind !== "ok") failures.push(`#${i} ${route.name} 404 for ${JSON.stringify(qs.slice(0, 120))}`);
          else if ((o.html.match(/<h1[\s>]/g) ?? []).length !== 1) failures.push(`#${i} ${route.name} h1 count`);
          for (const r of routes) await r.metadata(record);
        } catch (error) {
          failures.push(`#${i} ${route.name} threw for ${JSON.stringify(qs.slice(0, 120))}: ${String(error)}`);
        }
      }
      expect(failures).toEqual([]);
    },
    30_000,
  );

  test("non-string / exotic searchParams shapes never throw in the parser", () => {
    const throwing = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("boom");
        },
      },
    );
    const getterThrows = Object.defineProperty({}, "q", {
      enumerable: true,
      get: () => {
        throw new Error("boom");
      },
    });
    const inputs: unknown[] = [
      undefined, null, 0, "q=desk", [], [["q", "desk"]], new Map([["q", "desk"]]), throwing, getterThrows,
      { q: 1, page: { a: 1 }, brand: [1, null, ["x"], "voltline"], sort: ["featured", "rating"] },
      { brand: Array.from({ length: 500 }, (_, i) => `b-${i}`) },
      { page: "1".repeat(5000), min: "9".repeat(400), max: "-0" },
      Object.create({ q: "inherited" }) as unknown,
    ];
    for (const input of inputs) {
      const parsed = parse.parseListingParams(input);
      assertParamsShape(parsed.params as Record<string, unknown>);
      expect(parsed.ignored.length).toBeLessThanOrEqual(parse.MAX_IGNORED);
    }
    expect(parse.parseListingParams(Object.create({ q: "inherited" }) as unknown).params.q).toBeUndefined();
  });

  test("a page past the end renders the template's empty page with a link to the last page (200)", async () => {
    for (const route of [PRODUCTS, DEPT, brandRoute()]) {
      const { doc, html } = await renderOk(route, { page: "999" });
      expect(doc.body.textContent).toContain("This page is empty");
      const link = [...doc.querySelectorAll("a")].find((a) => a.textContent === "Go to the last page");
      expect(link).toBeDefined();
      const href = link?.getAttribute("href") ?? "";
      expect(isAllowedInternalHref(href)).toBe(true);
      // The linked page exists and has items.
      const last = Number(new URL(href, SITE).searchParams.get("page") ?? "1");
      const lastPage = await renderOk(route, { page: String(last) });
      expect(lastPage.doc.body.textContent).not.toContain("This page is empty");
      expect(lastPage.doc.querySelectorAll('[data-testid="product-card-badges"], article').length).toBeGreaterThan(0);
      // rel: prev = last page, no next.
      const rel = relLinks(html);
      expect(rel.next).toEqual([]);
      expect(rel.prev.map(decodeEntities)).toEqual([`${SITE}${href}`]);
    }
    // Filters survive on the "last page" link.
    const filtered = await renderOk(PRODUCTS, { instock: "1", page: "999" });
    const link = [...filtered.doc.querySelectorAll("a")].find((a) => a.textContent === "Go to the last page");
    expect(link?.getAttribute("href") ?? "").toContain("instock=1");
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: canonical / robots matrix + rel prev/next
// ---------------------------------------------------------------------------

const NOINDEX_FOLLOW = { index: false, follow: true };

describe("criterion 2: canonical/robots matrix per route", () => {
  test("page 1 self-canonical + indexable; page N self-canonical with '(page N)'", async () => {
    for (const route of indexableRoutes()) {
      const plain = await route.metadata({});
      expect({ route: route.name, canonical: plain.alternates?.canonical, robots: plain.robots, title: plain.title }).toEqual({
        route: route.name,
        canonical: `${SITE}${route.base}`,
        robots: undefined,
        title: route.title,
      });
      const p2 = await route.metadata({ page: "2" });
      expect({ route: route.name, canonical: p2.alternates?.canonical, robots: p2.robots, title: p2.title }).toEqual({
        route: route.name,
        canonical: `${SITE}${route.base}?page=2`,
        robots: undefined,
        title: `${route.title} (page 2)`,
      });
      // page=1 explicitly is the same as no page.
      expect((await route.metadata({ page: "1" })).alternates?.canonical).toBe(`${SITE}${route.base}`);
    }
  });

  test("faceted or re-sorted URLs: canonical page-1 base + noindex, follow", async () => {
    const variants: SP[] = [
      { instock: "1", page: "2" },
      { min: "10", max: "50" },
      { rating: "4" },
      { brand: "voltline" },
      { sort: "price_asc", page: "3" },
      { sort: "rating" },
    ];
    for (const route of indexableRoutes()) {
      for (const sp of variants) {
        if (route.base.startsWith("/brand/") && sp.brand !== undefined) continue; // dropped on brand pages (criterion 5)
        const md = await route.metadata(sp);
        expect({ route: route.name, sp, canonical: md.alternates?.canonical, robots: md.robots, title: md.title }).toEqual({
          route: route.name,
          sp,
          canonical: `${SITE}${route.base}`,
          robots: NOINDEX_FOLLOW,
          title: route.title,
        });
      }
    }
  });

  test("view, utm_*, ref and p are not facets: canonical base, indexable", async () => {
    for (const route of indexableRoutes()) {
      const md = await route.metadata({ view: "list", utm_source: "news", ref: "home", p: "a-b" });
      expect({ route: route.name, canonical: md.alternates?.canonical, robots: md.robots }).toEqual({
        route: route.name,
        canonical: `${SITE}${route.base}`,
        robots: undefined,
      });
    }
  });

  test("/best-sellers: any non-default sort -> noindex; redundant best_selling stays indexable", async () => {
    for (const sort of ["featured", "price_asc", "price_desc", "rating", "newest", "relevance"]) {
      const md = await BEST.metadata({ sort });
      expect({ sort, robots: md.robots, canonical: md.alternates?.canonical }).toEqual({
        sort,
        robots: NOINDEX_FOLLOW,
        canonical: `${SITE}/best-sellers`,
      });
    }
    const redundant = await BEST.metadata({ sort: "best_selling", page: "2" });
    expect(redundant.robots).toBeUndefined();
    expect(redundant.alternates?.canonical).toBe(`${SITE}/best-sellers?page=2`);
    // /new-arrivals mirrors it for "newest".
    expect((await NEW.metadata({ sort: "featured" })).robots).toEqual(NOINDEX_FOLLOW);
    expect((await NEW.metadata({ sort: "newest" })).robots).toBeUndefined();
  });

  // D-T107-1 (fixed in CONS-B1): `q` is a /search-only parameter; other
  // listing routes drop it from params and canonical (page-1 base).
  test("D-T107-1: ?q= on a non-search listing is not self-canonical + indexable", async () => {
    for (const route of indexableRoutes()) {
      const md = await route.metadata({ q: "anything at all" });
      const indexable = md.robots === undefined;
      const canonical = md.alternates?.canonical;
      expect({ route: route.name, ok: !(indexable && canonical !== `${SITE}${route.base}`) }).toEqual({
        route: route.name,
        ok: true,
      });
    }
  });

  test("rel prev/next: <link> with absolute URLs and correct targets", async () => {
    // /products has every published seed product + 30 clones -> lastPage pages of 24 (at least 3).
    const lastPage = Math.ceil((SEED_CATALOG_STATS.published + CLONES) / 24);
    expect(lastPage).toBeGreaterThanOrEqual(3);
    const p1 = relLinks((await renderOk(PRODUCTS, {})).html);
    expect(p1).toEqual({ prev: [], next: [`${SITE}/products?page=2`] });
    const p2 = relLinks((await renderOk(PRODUCTS, { page: "2" })).html);
    expect(p2).toEqual({ prev: [`${SITE}/products`], next: [`${SITE}/products?page=3`] });
    const pLast = relLinks((await renderOk(PRODUCTS, { page: String(lastPage) })).html);
    expect(pLast).toEqual({ prev: [`${SITE}/products?page=${lastPage - 1}`], next: [] });
    // Filters preserved on rel targets.
    const faceted = relLinks((await renderOk(PRODUCTS, { sort: "price_asc", page: "2" })).html);
    expect(faceted.prev.map(decodeEntities)).toEqual([`${SITE}/products?sort=price_asc`]);
    expect(faceted.next.map(decodeEntities)).toEqual([`${SITE}/products?sort=price_asc&page=3`]);
    // Category, brand: 2 pages each with the clones.
    for (const route of [DEPT, CHILD, brandRoute()]) {
      expect(relLinks((await renderOk(route, {})).html)).toEqual({ prev: [], next: [`${SITE}${route.base}?page=2`] });
      expect(relLinks((await renderOk(route, { page: "2" })).html)).toEqual({ prev: [`${SITE}${route.base}`], next: [] });
    }
    // Single-page listing: none.
    const single = slugRoute("/category/fiction", "/category", "fiction", "Fiction", categoryPage);
    expect(relLinks((await renderOk(single, {})).html)).toEqual({ prev: [], next: [] });
    // Every rel href is absolute and on the site origin.
    for (const route of indexableRoutes()) {
      const rel = relLinks((await renderOk(route, { page: "2" })).html);
      for (const href of [...rel.prev, ...rel.next]) expect(decodeEntities(href).startsWith(`${SITE}/`)).toBe(true);
    }
  });

  test("/search never renders rel prev/next <link>", async () => {
    for (const sp of [{}, { page: "2" }, { q: "a", page: "2" }, { page: "3" }] as SP[]) {
      const { html } = await renderOk(SEARCH, sp);
      expect(relLinks(html)).toEqual({ prev: [], next: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: JSON-LD
// ---------------------------------------------------------------------------

describe("criterion 3: JSON-LD on indexable listings", () => {
  test("one script, valid JSON, ItemList <= 24 absolute URLs with positions, BreadcrumbList", async () => {
    for (const route of indexableRoutes()) {
      for (const sp of [{}, { page: "2" }] as SP[]) {
        const { doc } = await renderOk(route, sp);
        expect({ route: route.name, scripts: jsonLdScripts(doc).length }).toEqual({ route: route.name, scripts: 1 });
        const docs = jsonLdDocs(doc);
        const types = docs.map((d) => d["@type"]);
        const items = docs.find((d) => d["@type"] === "ItemList");
        const crumbs = docs.find((d) => d["@type"] === "BreadcrumbList");
        expect(crumbs).toBeDefined();
        if (items === undefined) {
          // Only legitimately absent when the page has no products.
          expect({ route: route.name, sp, types }).toEqual({ route: route.name, sp, types: ["BreadcrumbList"] });
          expect(doc.body.textContent ?? "").toMatch(/No products|No deals|This page is empty|0 results/);
          continue;
        }
        const list = items.itemListElement as Json[];
        expect(list.length).toBeGreaterThan(0);
        expect(list.length).toBeLessThanOrEqual(24);
        expect(items.numberOfItems).toBe(list.length);
        list.forEach((entry, i) => {
          expect(entry.position).toBe(i + 1);
          expect(String(entry.url)).toMatch(new RegExp(`^${SITE.replace(/\./g, "\\.")}/products/[a-z0-9-]+$`));
        });
        // The ItemList mirrors the rendered product order.
        const cardLinks = [
          ...new Set(
            hrefs(doc)
              .filter((h) => /^\/products\/[a-z0-9-]+$/.test(h))
              .map((h) => `${SITE}${h}`),
          ),
        ];
        expect(list.map((e) => e.url)).toEqual(cardLinks.slice(0, list.length));
        // Breadcrumb: absolute item URLs, consecutive positions, last = route base.
        const bl = crumbs?.itemListElement as Json[];
        bl.forEach((entry, i) => {
          expect(entry.position).toBe(i + 1);
          expect(String(entry.item).startsWith(`${SITE}/`)).toBe(true);
        });
        expect(bl[0]?.item).toBe(`${SITE}/`);
        expect(bl[bl.length - 1]?.item).toBe(`${SITE}${route.base}`);
      }
    }
  });

  test("BreadcrumbList depth: collections Home > Title; dept Home > Dept; child Home > Dept > Child; brand Home > Brands > Brand", async () => {
    const depth = async (route: RouteCase) => {
      const crumbs = jsonLdDocs((await renderOk(route)).doc).find((d) => d["@type"] === "BreadcrumbList");
      return (crumbs?.itemListElement as Json[]).map((e) => e.name);
    };
    for (const route of [PRODUCTS, DEALS, BEST, NEW]) expect(await depth(route)).toEqual(["Home", route.title]);
    expect(await depth(DEPT)).toEqual(["Home", "Electronics"]);
    expect(await depth(CHILD)).toEqual(["Home", "Electronics", "Headphones & Audio"]);
    const brand = brandRoute();
    expect(await depth(brand)).toEqual(["Home", "Brands", brand.title]);
  });

  test("/search renders no JSON-LD at all", async () => {
    for (const sp of [{}, { q: "desk" }, { q: "zzqxv" }] as SP[]) {
      expect(jsonLdScripts((await renderOk(SEARCH, sp)).doc)).toHaveLength(0);
    }
  });

  test("/brands: one valid BreadcrumbList script (index page, no product ItemList)", async () => {
    const tree = await brandsPage.default();
    const doc = parseHtml(renderToStaticMarkup(<>{tree}</>));
    expect(jsonLdScripts(doc)).toHaveLength(1);
    const docs = jsonLdDocs(doc);
    expect(docs.map((d) => d["@type"])).toEqual(["BreadcrumbList"]);
    const md = brandsPage.generateMetadata();
    expect(md.alternates?.canonical).toBe(`${SITE}/brands`);
    expect(md.robots).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: data rules
// ---------------------------------------------------------------------------

describe("criterion 4: data rules", () => {
  test("list() exactly once; template facets is that call's object; no cookies/session; no writes", async () => {
    const routes: RouteCase[] = [...indexableRoutes().filter((r) => !r.base.startsWith("/brand/")), SEARCH];
    for (const route of routes) {
      for (const sp of [{}, { instock: "1", sort: "price_desc" }, { page: "2" }] as SP[]) {
        const { spy, restore } = spyList();
        const readers = spyReaders();
        const cookieBefore = qa.cookieCalls;
        const before = totalChanges(db);
        try {
          const { tree } = await renderOk(route, sp);
          expect({ route: route.name, sp, calls: spy.mock.calls.length }).toEqual({ route: route.name, sp, calls: 1 });
          const returned = spy.mock.results[0]?.value as { ok: boolean; value?: { facets: unknown } };
          expect(returned.ok).toBe(true);
          const template = findElement(tree, ListingTemplate);
          expect(template).not.toBeNull();
          expect(template?.props.facets === returned.value?.facets).toBe(true);
          expect(readers.readSession).not.toHaveBeenCalled();
          expect(readers.readUser).not.toHaveBeenCalled();
          expect(qa.cookieCalls).toBe(cookieBefore);
          expect(totalChanges(db)).toBe(before);
        } finally {
          readers.restore();
          restore();
        }
      }
    }
  });

  // D-T106-1 (ruling: accepted): the brand page may pass a shallow copy of
  // list()'s facets with only the `brands` bucket emptied (brand facet
  // hidden); every other bucket must be the very object list() returned.
  test("D-T106-1: /brand/[slug] facets = list() facets with only brands emptied (same bucket objects)", async () => {
    const { spy, restore } = spyList();
    try {
      const { tree } = await renderOk(brandRoute(), {});
      expect(spy).toHaveBeenCalledTimes(1);
      const returned = (spy.mock.results[0]?.value as { value: { facets: Record<string, unknown> } }).value.facets;
      const passed = findElement(tree, ListingTemplate)?.props.facets as Record<string, unknown>;
      expect(passed.brands).toEqual([]);
      expect(Object.keys(passed).sort()).toEqual(Object.keys(returned).sort());
      for (const key of Object.keys(returned)) {
        if (key === "brands") continue;
        expect({ key, same: passed[key] === returned[key] }).toEqual({ key, same: true });
      }
    } finally {
      restore();
    }
  });

  // D-T105-1 (fixed in CONS-B1): unknown `category`/`dept` URL slugs are dropped before the single list() call.
  test("D-T105-1: unknown category/dept slug still renders with exactly one list() call", async () => {
    for (const route of [PRODUCTS, SEARCH]) {
      const { spy, restore } = spyList();
      try {
        await renderOk(route, { category: "no-such-category" });
        expect({ route: route.name, calls: spy.mock.calls.length }).toEqual({ route: route.name, calls: 1 });
      } finally {
        restore();
      }
    }
  });

  test("now: loaders read the injected clock exactly once (collections, brand, search with results)", () => {
    const realNow = Date.now();
    for (const kind of ["products", "deals", "best-sellers", "new-arrivals"] as const) {
      const now = mock(() => realNow);
      listingPage.loadCollectionPage(kind, { page: "2" }, listingPage.createListingPageDeps(db, now));
      expect({ kind, calls: now.mock.calls.length }).toEqual({ kind, calls: 1 });
    }
    const nowBrand = mock(() => realNow);
    brandLib.loadBrandPage(cloneBrand, {}, listingPage.createListingPageDeps(db, nowBrand));
    expect(nowBrand).toHaveBeenCalledTimes(1);
    const nowSearch = mock(() => realNow);
    searchLib.loadSearchPage({ q: "desk" }, listingPage.createListingPageDeps(db, nowSearch));
    expect(nowSearch).toHaveBeenCalledTimes(1);
    const nowCategory = mock(() => realNow);
    categoryLib.loadCategoryPage("electronics", {}, listingPage.createListingPageDeps(db, nowCategory));
    expect(nowCategory).toHaveBeenCalledTimes(1);
  });

  // D-T106-2 (found by T104b: category loader + /search zero results called
  // listing.categoryTree() which read Date.now()) was fixed concurrently at
  // 21:27 (categoryTree(now) threaded through). Kept as a regression test.
  test("D-T106-2 regression: no hidden wall-clock read during category / zero-result search / collection renders", () => {
    const realNow = Date.now();
    const wall = spyOn(Date, "now");
    try {
      listingPage.loadCollectionPage("products", {}, listingPage.createListingPageDeps(db, () => realNow));
      categoryLib.loadCategoryPage("electronics", {}, listingPage.createListingPageDeps(db, () => realNow));
      searchLib.loadSearchPage({ q: "zzqxv" }, listingPage.createListingPageDeps(db, () => realNow));
      brandLib.loadBrandPage(cloneBrand, {}, listingPage.createListingPageDeps(db, () => realNow));
      expect(wall).not.toHaveBeenCalled();
    } finally {
      wall.mockRestore();
    }
  });

  test("metadata never calls list() and never reads cookies", async () => {
    const { spy, restore } = spyList();
    const cookieBefore = qa.cookieCalls;
    try {
      for (const route of [...indexableRoutes(), SEARCH]) await route.metadata({ q: "desk", instock: "1", page: "2" });
      expect(spy).not.toHaveBeenCalled();
      expect(qa.cookieCalls).toBe(cookieBefore);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: route behaviour (category / brand / collections)
// ---------------------------------------------------------------------------

const HOSTILE_SLUGS: readonly unknown[] = [
  "no-such-category",
  "nope",
  "UPPER",
  "Electronics",
  "electronics/",
  "..",
  "%2e%2e",
  "..%2f..%2fetc",
  "a".repeat(10_000),
  "<script>alert(1)</script>",
  "\u202eevil\u200b",
  "elec\u0000tronics",
  "electronics\r\n",
  "\u{1F600}",
  "",
  ["electronics", "audio"],
  ["a"],
  42,
];

describe("criterion 5: route behaviour", () => {
  test("category/brand: unknown, slug-shaped missing and non-slug-shaped slugs -> 404 (never a throw)", async () => {
    for (const mod of [categoryPage, brandPage]) {
      for (const slug of HOSTILE_SLUGS) {
        const o = await outcome(() => mod.default({ params: Promise.resolve({ slug: slug as string }), searchParams: Promise.resolve({}) }));
        expect({ slug: String(slug).slice(0, 40), kind: o.kind }).toEqual({ slug: String(slug).slice(0, 40), kind: "notFound" });
        const md = await mod.generateMetadata({ params: Promise.resolve({ slug: slug as string }), searchParams: Promise.resolve({}) });
        expect(md.robots).toEqual({ index: false, follow: false });
        expect(md.alternates?.canonical).toBeUndefined();
      }
    }
  });

  test("brand page: brand facet hidden, brand= dropped from params and every href", async () => {
    const route = brandRoute();
    const { tree, doc } = await renderOk(route, { brand: ["voltline", "northloom"] });
    const props = findElement(tree, ListingTemplate)?.props as { params: Record<string, unknown>; facets: { brands: unknown[] } };
    expect(props.params.brand).toBeUndefined();
    expect(props.facets.brands).toEqual([]);
    expect(doc.querySelectorAll('input[name="brand"]')).toHaveLength(0);
    expect(hrefs(doc).filter((h) => /[?&]brand=/.test(h))).toEqual([]);
    // Still scoped to the route brand only.
    expect(doc.getElementById("listing-result-count")?.textContent).toMatch(new RegExp(`of ${(SEED_CATALOG_STATS.byBrand[cloneBrand] ?? 0) + CLONES} results`));
    expect((await route.metadata({ brand: "voltline" })).robots).toBeUndefined();
  });

  test("category pages: `category` kept only when a child of the department; `dept` dropped", async () => {
    const child = await renderOk(DEPT, { category: "audio", dept: "books" });
    const childProps = findElement(child.tree, ListingTemplate)?.props as { params: Record<string, unknown> };
    expect(childProps.params).toMatchObject({ category: "audio" });
    expect(childProps.params.dept).toBeUndefined();
    expect(hrefs(child.doc).filter((h) => /[?&]dept=/.test(h))).toEqual([]);
    expect(child.doc.getElementById("listing-result-count")?.textContent).toMatch(
      new RegExp(`of ${(SEED_CATALOG_STATS.byCategory[CLONE_SOURCE_CATEGORY] ?? 0) + CLONES} results`),
    );

    for (const [route, sp] of [
      [DEPT, { category: "fiction" }],
      [DEPT, { category: "electronics" }],
      [CHILD, { category: "audio" }],
      [CHILD, { category: "smart-home" }],
      [DEPT, { dept: "home-kitchen" }],
    ] as const) {
      const { tree, doc } = await renderOk(route, sp);
      const params = (findElement(tree, ListingTemplate)?.props as { params: Record<string, unknown> }).params;
      expect({ route: route.name, sp, category: params.category, dept: params.dept }).toEqual({
        route: route.name,
        sp,
        category: undefined,
        dept: undefined,
      });
      expect(hrefs(doc).filter((h) => /[?&]dept=/.test(h))).toEqual([]);
      // Category facet links (departments only) may only name this department's children.
      const children = new Set(["audio", "computer-accessories", "smart-home"]);
      for (const h of hrefs(doc).filter((x) => x.startsWith(route.base) && /[?&]category=/.test(x))) {
        expect(route).toBe(DEPT);
        expect(children.has(new URL(h, SITE).searchParams.get("category") ?? "")).toBe(true);
      }
      expect((await route.metadata(sp)).robots).toBeUndefined();
    }
  });

  test("/deals drops a redundant deals=1 (params, hrefs, canonical) and lists only discounted products", async () => {
    const { spy, restore } = spyList();
    try {
      const { tree, doc } = await renderOk(DEALS, { deals: "1" });
      const params = (findElement(tree, ListingTemplate)?.props as { params: Record<string, unknown> }).params;
      expect(params.deals).toBeUndefined();
      expect(hrefs(doc).filter((h) => h.startsWith("/deals") && /[?&]deals=1/.test(h))).toEqual([]);
      const result = (spy.mock.results[0]?.value as { value: { items: { priceCents: number; listPriceCents?: number | null }[] } }).value;
      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items) expect((item.listPriceCents ?? 0) > item.priceCents).toBe(true);
    } finally {
      restore();
    }
    const md = await DEALS.metadata({ deals: "1" });
    expect(md.robots).toBeUndefined();
    expect(md.alternates?.canonical).toBe(`${SITE}/deals`);
  });

  test("/deals with no deals: 'No deals right now' with allow-listed links (200)", async () => {
    db.run("SAVEPOINT qa_deals");
    try {
      db.run("UPDATE products SET list_price_cents = NULL");
      const { doc } = await renderOk(DEALS, {});
      expect(doc.body.textContent).toContain("No deals right now");
      const links = [...doc.querySelectorAll("a")].filter((a) => /Browse all products|Best Sellers|New Arrivals/.test(a.textContent ?? ""));
      expect(links.length).toBeGreaterThanOrEqual(3);
      expect(hrefViolations(doc)).toEqual([]);
    } finally {
      db.run("ROLLBACK TO qa_deals");
      db.run("RELEASE qa_deals");
    }
  });

  test("/best-sellers ranks #1.. and continues #25 on page 2 only while best-selling", async () => {
    const p1 = rankTexts((await renderOk(BEST, {})).doc);
    expect(leadingRank(p1[0])).toBe(rank(1));
    expect(leadingRank(p1[23])).toBe(rank(24));
    const p2 = rankTexts((await renderOk(BEST, { page: "2" })).doc);
    expect(leadingRank(p2[0])).toBe(rank(25));
    const redundant = rankTexts((await renderOk(BEST, { sort: "best_selling", page: "2" })).doc);
    expect(leadingRank(redundant[0])).toBe(rank(25));
    for (const sort of ["price_asc", "featured", "newest", "rating"]) {
      const texts = rankTexts((await renderOk(BEST, { sort, page: "2" })).doc).join(" ");
      expect({ sort, ranked: /Rank \S\d/.test(texts) }).toEqual({ sort, ranked: false });
    }
    // Other collections never rank, even when re-sorted to best_selling.
    const products = rankTexts((await renderOk(PRODUCTS, { sort: "best_selling" })).doc).join(" ");
    expect(/Rank \S\d/.test(products)).toBe(false);
  });

  // D-T107-2 (fixed in CONS-B1, consistency ac): on routes whose default
  // sort is not "featured" (/best-sellers, /new-arrivals) a user-chosen
  // sort=featured survives pagination links, rel=next, view toggles and the
  // filter form (each route declares its own `defaultSort`).
  test("D-T107-2: sort=featured survives pagination, rel next, view toggles and filters on /best-sellers and /new-arrivals", async () => {
    for (const route of [BEST, NEW]) {
      const { doc, html } = await renderOk(route, { sort: "featured" });
      const pageLinks = [...doc.querySelectorAll('nav[aria-label="Listing pages"] a')].map((a) => a.getAttribute("href") ?? "");
      const viewLinks = [...doc.querySelectorAll('[role="group"][aria-label="View"] a')].map((a) => a.getAttribute("href") ?? "");
      const next = relLinks(html).next.map(decodeEntities);
      const filterForm = doc.querySelector('aside[aria-label="Filters"] form');
      const keepsSort = (h: string) => new URL(h, SITE).searchParams.get("sort") === "featured";
      expect({
        route: route.name,
        pages: pageLinks.every(keepsSort),
        views: viewLinks.every(keepsSort),
        next: next.every(keepsSort),
        filters: filterForm?.querySelector('input[name="sort"][value="featured"]') !== null && filterForm !== null,
      }).toEqual({ route: route.name, pages: true, views: true, next: true, filters: true });
    }
  });

  test("collections: correct default sort per route", async () => {
    const expected: Array<[RouteCase, string]> = [
      [PRODUCTS, "featured"],
      [DEALS, "featured"],
      [BEST, "best_selling"],
      [NEW, "newest"],
    ];
    for (const [route, sort] of expected) {
      const { tree } = await renderOk(route, {});
      expect({ route: route.name, sort: findElement(tree, ListingTemplate)?.props.sort }).toEqual({ route: route.name, sort });
    }
  });

  test("/brands lists every brand with allow-listed /brand/<slug> links", async () => {
    const doc = parseHtml(renderToStaticMarkup(<>{await brandsPage.default()}</>));
    const brandLinks = hrefs(doc).filter((h) => h.startsWith("/brand/"));
    expect(brandLinks).toHaveLength(12);
    expect(hrefViolations(doc)).toEqual([]);
    expect(headingViolations(doc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 7: cross-route markup rules
// ---------------------------------------------------------------------------

describe("criterion 7: markup rules on every listing route", () => {
  const SCENARIOS: SP[] = [{}, { page: "2", view: "list" }, { instock: "1", sort: "price_asc" }, { page: "999" }, { min: "999999" }];

  test("one h1, no skipped heading levels, unique landmarks/ids, allow-listed hrefs, no UUIDs", async () => {
    const problems: string[] = [];
    for (const route of [...indexableRoutes(), SEARCH]) {
      for (const sp of SCENARIOS) {
        const { doc, html } = await renderOk(route, sp);
        const tag = `${route.name} ${JSON.stringify(sp)}`;
        for (const v of headingViolations(doc)) problems.push(`${tag} heading ${v}`);
        for (const v of landmarkViolations(doc)) problems.push(`${tag} landmark ${v}`);
        for (const v of duplicateIds(doc)) problems.push(`${tag} duplicate id ${v}`);
        for (const v of hrefViolations(doc)) problems.push(`${tag} href ${v}`);
        if (UUID_RE.test(html)) problems.push(`${tag} UUID in markup`);
        if (/sf_session|sf_auth|owner_?key/i.test(html)) problems.push(`${tag} session/owner token name in markup`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("hostile product names render as text (cards, JSON-LD, active-filter chips)", async () => {
    const hostile = `<img src=x onerror=alert(1)></script><!-- "quoted" & \u202e`;
    db.run("SAVEPOINT qa_hostile");
    try {
      db.run("UPDATE products SET name = ? WHERE slug = 'qa-clone-1'", [hostile]);
      for (const route of [PRODUCTS, DEPT, CHILD, brandRoute()]) {
        // Find the page holding the clone (it may be on page 1 or 2).
        let found: { doc: Document; html: string } | null = null;
        for (const page of ["1", "2", "3", "4"]) {
          const r = await renderOk(route, { page });
          if (r.html.includes("qa-clone-1\"")) {
            found = r;
            break;
          }
        }
        expect({ route: route.name, found: found !== null }).toEqual({ route: route.name, found: true });
        if (found === null) continue;
        expect(found.doc.querySelector('img[src="x"]')).toBeNull();
        expect(found.html).not.toContain("<img src=x");
        expect(found.doc.querySelector("[onerror]")).toBeNull();
        expect(found.doc.body.textContent).toContain("<img src=x onerror=alert(1)>");
        const script = jsonLdScripts(found.doc)[0]?.textContent ?? "";
        expect(script.toLowerCase()).not.toContain("</script");
        expect(script).not.toContain("<!--");
        const list = jsonLdDocs(found.doc).find((d) => d["@type"] === "ItemList");
        expect((list?.itemListElement as Json[]).some((e) => e.name === hostile.trim())).toBe(true);
      }
    } finally {
      db.run("ROLLBACK TO qa_hostile");
      db.run("RELEASE qa_hostile");
    }
  });

  test("44px targets: pagination links/edges, sort controls and view toggles carry touch classes", async () => {
    const TOUCH = /\b(min-h-touch|h-touch|size-touch)\b/;
    for (const route of [PRODUCTS, DEPT, SEARCH]) {
      const { doc } = await renderOk(route, { page: "2" });
      const nav = doc.querySelector('nav[aria-label="Listing pages"]');
      expect({ route: route.name, nav: nav !== null }).toEqual({ route: route.name, nav: true });
      const targets = [...(nav?.querySelectorAll("a, span[aria-disabled]") ?? [])];
      expect(targets.length).toBeGreaterThan(0);
      for (const el of targets) expect({ route: route.name, text: el.textContent, ok: TOUCH.test(el.getAttribute("class") ?? "") }).toMatchObject({ ok: true });
      const sortSelect = doc.querySelector('select[name="sort"]');
      expect(sortSelect).not.toBeNull();
      expect(TOUCH.test(sortSelect?.getAttribute("class") ?? "")).toBe(true);
      for (const button of sortSelect?.closest("form")?.querySelectorAll("button") ?? []) {
        expect(TOUCH.test(button.getAttribute("class") ?? "")).toBe(true);
      }
      const view = doc.querySelector('[role="group"][aria-label="View"]');
      for (const a of view?.querySelectorAll("a") ?? []) expect(TOUCH.test(a.getAttribute("class") ?? "")).toBe(true);
    }
  });

  test("listing forms are GET forms without hidden identity fields", async () => {
    for (const route of [...indexableRoutes(), SEARCH]) {
      const { doc } = await renderOk(route, { instock: "1" });
      for (const form of doc.querySelectorAll("form")) {
        const method = (form.getAttribute("method") ?? "get").toLowerCase();
        if (method === "get") {
          for (const input of form.querySelectorAll('input[type="hidden"]')) {
            expect(/session|owner|user|token|email/i.test(input.getAttribute("name") ?? "")).toBe(false);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// T91 template unit checks that the pages rely on
// ---------------------------------------------------------------------------

describe("T91 helpers used by every page", () => {
  test("canonicalListingUrl / paginationRel edge cases", () => {
    expect(parse.canonicalListingUrl("/products", { page: 1 })).toBe("/products");
    expect(parse.canonicalListingUrl("/products", { page: 3, view: "list", extra: { utm_source: "x" } })).toBe("/products?page=3");
    expect(parse.canonicalListingUrl("/products", { page: 3, rating: 4 })).toBe("/products");
    expect(parse.paginationRel("/products", { page: 1 }, 1)).toEqual({});
    expect(parse.paginationRel("/products", { page: 9 }, 3)).toEqual({ prev: "/products?page=3" });
    expect(parse.paginationRel("/products", { page: 2 }, Number.NaN)).toEqual({});
    expect(parse.paginationRel("/products", { page: 2 }, -4)).toEqual({});
  });

  test("listingItemListJsonLd caps at 24 and drops non-allow-listed slugs", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ slug: i === 0 ? "../evil" : `p-${i}`, name: `P ${i}` }));
    const ld = listingPage.listingItemListJsonLd(items);
    expect(ld?.itemListElement).toHaveLength(24);
    expect(ld?.itemListElement[0]?.url).toBe(`${SITE}/products/p-1`);
    expect(listingPage.listingItemListJsonLd([])).toBeNull();
  });
});
