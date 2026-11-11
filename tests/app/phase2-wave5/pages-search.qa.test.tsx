/**
 * T104b (QA wave 5, part B): page-level QA of /search (T105) on top of the
 * shared listing loader (T91). Page functions + `generateMetadata` called
 * directly with mocked `next/*`, `renderToStaticMarkup`, `:memory:` SQLite
 * seeded through the real seed. QA-owned; defect pins are `test.failing`
 * tagged `// PIN: D-Txx-n`.
 */
import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// next/* mocks: identical in all three T104b files, one shared state object.
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
const { getSearchService } = await import("@/server/catalog/search-service");
const session = await import("@/server/session/session");
const { isAllowedInternalHref } = await import("@/content/routes");
const listingPage = await import("@/app/_listing/listing-page");
const searchLib = await import("@/app/search/_lib/search-page");
const { default: SearchPage, generateMetadata } = await import("@/app/search/page");

type SP = Record<string, string | string[] | undefined>;

let db: Database;

beforeAll(() => {
  env.NEXT_PUBLIC_SITE_URL = SITE;
  closeDatabase();
  db = getDatabase();
  seedDatabase(db);
});

afterAll(() => {
  closeDatabase();
});

const HASH = String.fromCharCode(35);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const NOINDEX_FOLLOW = { index: false, follow: true };

function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, "text/html");
}

async function render(sp: SP): Promise<{ html: string; doc: Document }> {
  const tree: ReactNode = await SearchPage({ searchParams: Promise.resolve(sp) });
  const html = renderToStaticMarkup(<>{tree}</>);
  return { html, doc: parseHtml(html) };
}

function h1s(doc: Document): string[] {
  return [...doc.querySelectorAll("h1")].map((h) => h.textContent ?? "");
}

function hrefs(doc: Document): string[] {
  return [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
}

function hrefViolations(doc: Document): string[] {
  return hrefs(doc).filter((h) => (h.startsWith(HASH) ? doc.getElementById(h.slice(1)) === null : !isAllowedInternalHref(h)));
}

function headingViolations(doc: Document): string[] {
  const levels = [...doc.body.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName.slice(1)));
  const out: string[] = [];
  if (levels.filter((l) => l === 1).length !== 1) out.push("h1 count");
  if (levels[0] !== 1) out.push("first heading not h1");
  for (let i = 1; i < levels.length; i += 1) if ((levels[i] ?? 1) > (levels[i - 1] ?? 1) + 1) out.push(`skip at ${i}`);
  return out;
}

function linkByText(doc: Document, text: string): Element | undefined {
  return [...doc.querySelectorAll("a")].find((a) => (a.textContent ?? "").trim() === text);
}

function countText(doc: Document): string {
  return doc.getElementById("listing-result-count")?.textContent ?? "";
}

/**
 * T172 pin move: every quick-add card form makes React emit its inline `$$reactFormReplay`
 * bootstrap script (no-JS form replay). It is React's own markup, not user input, so the
 * "no script" checks ignore exactly that script and still fail on any other.
 */
function foreignScripts(doc: Document): Element[] {
  return [...doc.querySelectorAll("script")].filter((el) => !(el.textContent ?? "").includes("$$reactFormReplay"));
}

/** T172 pin move (T168): the related-search chips are a `nav` labelled via `aria-labelledby`. */
function navLinksByLabel(doc: Document, label: string): string[] {
  const nav = [...doc.querySelectorAll("nav[aria-labelledby]")].find(
    (n) => doc.getElementById(n.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === label,
  );
  return [...(nav?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href") ?? "");
}

function sectionLinks(doc: Document, heading: string): string[] {
  const h = [...doc.querySelectorAll("h3")].find((x) => x.textContent === heading);
  const section = h?.closest("section");
  return [...(section?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href") ?? "");
}

// ---------------------------------------------------------------------------
// Criterion 2: /search canonical + robots
// ---------------------------------------------------------------------------

describe("/search metadata (criterion 2)", () => {
  test("always noindex, follow; canonical /search?q=<q> with facets, sort, page, view, extras stripped", async () => {
    const cases: Array<[SP, string]> = [
      [{}, `${SITE}/search`],
      [{ page: "3" }, `${SITE}/search`],
      [{ q: "desk" }, `${SITE}/search?q=desk`],
      [{ q: "desk", page: "2" }, `${SITE}/search?q=desk`],
      [{ q: "desk", sort: "price_asc", brand: "voltline", instock: "1", rating: "4", min: "5", max: "90", deals: "1", category: "audio", dept: "electronics", view: "list", utm_source: "x", ref: "home", p: "a" }, `${SITE}/search?q=desk`],
      [{ q: "  walnut   desk  " }, `${SITE}/search?q=walnut+desk`],
      [{ q: "<script>" }, `${SITE}/search?q=%3Cscript%3E`],
      [{ q: "   " }, `${SITE}/search`],
    ];
    for (const [sp, canonical] of cases) {
      const md = await generateMetadata({ searchParams: Promise.resolve(sp) });
      expect({ sp, robots: md.robots, canonical: md.alternates?.canonical }).toEqual({ sp, robots: NOINDEX_FOLLOW, canonical });
      expect(String(md.title)).not.toContain("(page");
    }
    // 10k chars: canonical carries the 100-char cleaned query only.
    const long = await generateMetadata({ searchParams: Promise.resolve({ q: "b".repeat(10_000) }) });
    expect(long.alternates?.canonical).toBe(`${SITE}/search?q=${"b".repeat(100)}`);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: /search behaviour
// ---------------------------------------------------------------------------

describe("/search behaviour (criterion 5)", () => {
  test("empty q = browse mode: h1 'All results' with every product", async () => {
    for (const sp of [{}, { q: "" }, { q: "   " }, { q: "​‮" }, { q: "\u0000\u0007" }, { q: ["", "desk"] }] as SP[]) {
      const { doc } = await render(sp);
      expect({ sp: JSON.stringify(sp), h1: h1s(doc) }).toEqual({ sp: JSON.stringify(sp), h1: ["All results"] });
      expect(countText(doc)).toMatch(new RegExp(`of ${SEED_CATALOG_STATS.published} results`));
    }
  });

  test("hostile q -> 200, echoed only as escaped h1 text", async () => {
    const cases: Array<[string, string]> = [
      ['<img src=x onerror=alert(1)>', '<img src=x onerror=alert(1)>'],
      ['</h1><script>alert(1)</script>', '</h1><script>alert(1)</script>'],
      ["a".repeat(10_000), "a".repeat(100)],
      ["‮desk​", "desk"],
    ];
    for (const [q, shown] of cases) {
      const { doc, html } = await render({ q });
      // T172 pin move (T168): the h1 reads "Showing results for “q”" (metadata title keeps "Results for").
      expect(h1s(doc)).toEqual([`Showing results for “${shown}”`]);
      expect(doc.querySelector("img[src='x']")).toBeNull();
      expect(foreignScripts(doc)).toHaveLength(0);
      expect(html).not.toContain("<script>alert");
      expect(hrefViolations(doc)).toEqual([]);
    }
  });

  test("FTS-operator-only and FTS-syntax queries never throw (200, one h1)", async () => {
    const queries = [
      "AND", "OR", "NOT", "NEAR", "NEAR(", "NEAR/2", "*", "**", '"', '""', '"""', "^", "-", "--", ":", "col:desk",
      "()", "(", ")", "AND OR NOT", "{x}", "a*b", "+", "&&", "||", "'", "''", "\\", "%", "_", "desk NOT", "NOT desk",
      "desk OR", "OR desk AND", '"desk', 'desk"', "^desk", "desk*", "-desk", "title:desk", "rowid=1", "x'); DROP TABLE products;--",
    ];
    for (const q of queries) {
      const { doc } = await render({ q });
      expect({ q, h1: h1s(doc).length }).toEqual({ q, h1: 1 });
    }
    // The catalogue is intact afterwards.
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM products").get()?.n).toBe(SEED_CATALOG_STATS.total);
  });

  test("zero results: tips, related, popular, department links; no filters; no 'Clear filters' when unfiltered", async () => {
    const { doc } = await render({ q: "headphones zzqxv" });
    expect(doc.body.textContent).toContain("No results");
    expect(doc.body.textContent).toContain("Search tips");
    expect(navLinksByLabel(doc, "Related searches")).toContain("/search?q=headphones");
    const popular = sectionLinks(doc, "Popular searches");
    expect(popular.length).toBeGreaterThanOrEqual(3);
    for (const href of popular) expect(href).toMatch(/^\/search\?q=[a-z+]+$/);
    const departments = sectionLinks(doc, "Shop by department");
    expect(departments.length).toBeGreaterThanOrEqual(5);
    for (const href of departments) expect(href).toMatch(/^\/category\/[a-z0-9-]+$/);
    expect(linkByText(doc, "Clear filters")).toBeUndefined();
    expect(doc.querySelector('aside[aria-label="Filters"]')).toBeNull();
    expect(doc.querySelectorAll("form")).toHaveLength(0);
    expect(hrefViolations(doc)).toEqual([]);
    expect(headingViolations(doc)).toEqual([]);
  });

  test("every popular search returns results (no dead suggestions)", async () => {
    const { doc } = await render({ q: "zzqxv" });
    for (const href of sectionLinks(doc, "Popular searches")) {
      const q = new URL(href, SITE).searchParams.get("q") ?? "";
      const page = await render({ q });
      expect({ q, empty: (page.doc.body.textContent ?? "").includes("Search tips") }).toEqual({ q, empty: false });
    }
  });

  test("zero results when filtered: 'Clear filters' keeps only q", async () => {
    const filtered = await render({ q: "zzqxv", instock: "1", sort: "price_asc" });
    expect(linkByText(filtered.doc, "Clear filters")?.getAttribute("href")).toBe("/search?q=zzqxv");
    const narrowed = await render({ q: "desk", min: "999999" });
    expect(narrowed.doc.body.textContent).toContain("Search tips");
    expect(linkByText(narrowed.doc, "Clear filters")?.getAttribute("href")).toBe("/search?q=desk");
    const browse = await render({ min: "999999" });
    expect(h1s(browse.doc)).toEqual(["All results"]);
    expect(linkByText(browse.doc, "Clear filters")?.getAttribute("href")).toBe("/search");
  });

  test("did-you-mean: shown for a misspelling with 0 results, never for a normal query", async () => {
    const miss = await render({ q: "headphnes" });
    const dym = linkByText(miss.doc, "headphones");
    expect(dym?.getAttribute("href")).toBe("/search?q=headphones");
    expect(miss.doc.body.textContent).toContain("Did you mean headphones?");
    const filtered = await render({ q: "headphnes", instock: "1" });
    expect(filtered.doc.body.textContent).toContain("Did you mean");
    for (const q of ["desk", "headphones", "coffee"]) {
      expect((await render({ q })).doc.body.textContent).not.toContain("Did you mean");
    }
  });

  test("did-you-mean gating (loader): total 0-2 + suggestion != q only", () => {
    const real = listingPage.createListingPageDeps(db);
    const ids = db.query<{ id: string }, []>("SELECT id FROM products ORDER BY id LIMIT 5").all().map((r) => r.id);
    const fake = (count: number, didYouMean: string | null) => ({
      ...real,
      search: {
        search: () => ({
          ok: true as const,
          value: { ids: ids.slice(0, count), total: count, didYouMean, browseAll: false, terms: ["dsek"], page: 1, pageSize: 50, pageCount: 1 },
        }),
      } as unknown as typeof real.search,
    });
    const view = (count: number, s: string | null, q = "dsek") => searchLib.loadSearchPage({ q }, fake(count, s)).didYouMean;
    expect(view(0, "desk")).toEqual({ label: "desk", href: "/search?q=desk" });
    expect(view(1, "desk")).not.toBeNull();
    expect(view(2, "desk")).not.toBeNull();
    expect(view(3, "desk")).toBeNull();
    expect(view(5, "desk")).toBeNull();
    expect(view(0, null)).toBeNull();
    expect(view(0, "dsek")).toBeNull();
    expect(view(0, "DSEK".toLowerCase(), "DSEK")).toBeNull();
  });

  test("unknown dept/category slug ignored (same results as without it)", async () => {
    const plain = countText((await render({ q: "desk" })).doc);
    for (const sp of [{ q: "desk", dept: "no-such" }, { q: "desk", category: "no-such" }, { q: "desk", dept: "<x>" }] as SP[]) {
      const { doc } = await render(sp);
      expect(countText(doc)).toBe(plain);
      expect(doc.body.textContent).not.toContain("Search tips");
    }
  });

  test("page past the end: empty page state with link back to the last page (200)", async () => {
    const { doc } = await render({ q: "desk", page: "50" });
    expect(doc.body.textContent).toContain("This page is empty");
    expect(linkByText(doc, "Go to the last page")?.getAttribute("href")).toBe("/search?q=desk");
    const browse = await render({ page: "50" });
    expect(linkByText(browse.doc, "Go to the last page")?.getAttribute("href")).toBe(`/search?page=${Math.ceil(SEED_CATALOG_STATS.published / 24)}`);
  });

  test("breadcrumb Home > Search; markup rules; no session reads, no writes", async () => {
    const readSession = spyOn(session, "readSessionId");
    const searchSpy = spyOn(getSearchService(), "search");
    const before = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n;
    const cookieBefore = qa.cookieCalls;
    try {
      for (const sp of [{ q: "desk" }, { q: "headphnes" }, { q: "headphones zzqxv" }, {}, { q: "desk", page: "2", view: "list" }] as SP[]) {
        const { doc, html } = await render(sp);
        const crumbs = doc.querySelector('nav[aria-label="Breadcrumb"]');
        expect(crumbs?.querySelector('a[href="/"]')?.textContent).toBe("Home");
        expect(headingViolations(doc)).toEqual([]);
        expect(hrefViolations(doc)).toEqual([]);
        expect(UUID_RE.test(html)).toBe(false);
      }
      expect(readSession).not.toHaveBeenCalled();
      expect(qa.cookieCalls).toBe(cookieBefore);
      expect(db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n).toBe(before);
      // Search service is asked with an explicit `now` every time.
      for (const call of searchSpy.mock.calls) expect(typeof (call[1] as { now?: unknown } | undefined)?.now).toBe("number");
    } finally {
      readSession.mockRestore();
      searchSpy.mockRestore();
    }
  });

  test("extras (ref, utm_*) are cleaned before reaching links; hostile extras never become markup", async () => {
    const { doc, html } = await render({ q: "desk", ref: '"><script>x</script>', utm_source: "\u0000news‮", evil: "1" });
    expect(foreignScripts(doc)).toHaveLength(0);
    expect(html).not.toContain("<script>x");
    for (const href of hrefs(doc).filter((h) => h.startsWith("/search"))) {
      expect(href).not.toContain("evil=");
      expect(/%00|%E2%80%AE/i.test(href)).toBe(false);
    }
  });
});
