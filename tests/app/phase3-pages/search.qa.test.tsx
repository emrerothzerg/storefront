/**
 * T172 (QA wave C1): page-level QA of the v3 `/search` page (T168 on the T158 template) against
 * `tests/redesign/CONTRACTS.md` L-2, L-4, L-5, L-13..L-15, L-19, L-20, L-23, L-24, L-25 (search) and SR3.
 * QA-owned. Page function + `generateMetadata` called directly with the wave-5 next/* mocks; `:memory:`
 * SQLite seeded through the real seed. Phase 2 search coverage stays in
 * `tests/app/phase2-wave5/pages-search.qa.test.tsx`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { duplicateIds, harness, hrefViolations, installNextMocks, parseHtml, resetCookies, serverLike } from "../phase2-wave5/_harness";
import { brandAndThemeViolations, countClockReads, darkClassTokens } from "./_phase3";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const previousDatabasePath = env.DATABASE_PATH;
const previousSiteUrl = env.NEXT_PUBLIC_SITE_URL;
env.DATABASE_PATH = ":memory:";
const SITE = "https://shop.example.com";
env.NEXT_PUBLIC_SITE_URL = SITE;

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { SEED_CATALOG_STATS, seedDatabase } = await import("@/server/db/seed");
const { isAllowedInternalHref } = await import("@/content/routes");
const { POPULAR_SEARCHES } = await import("@/content/search-help");
const { getListingService } = await import("@/server/catalog/listing-service");
const { getSearchService } = await import("@/server/catalog/search-service");
const { addToCart } = await import("@/app/actions/cart");
const { default: SearchPage, generateMetadata } = await import("@/app/search/page");

type SP = Record<string, string | string[] | undefined>;

const FEEDBACK_HEADING = "Did you find what you were looking for?";
const OPEN_Q = "“";
const CLOSE_Q = "”";

const restorers: Array<() => void> = [];
let restoreServerLike: () => void = () => {};

beforeAll(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  restoreServerLike = serverLike([addToCart as never]);
});

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

afterAll(() => {
  restoreServerLike();
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
  if (previousSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
});

async function render(sp: SP): Promise<{ html: string; doc: Document }> {
  env.NEXT_PUBLIC_SITE_URL = SITE;
  resetCookies();
  const tree: ReactNode = await SearchPage({ searchParams: Promise.resolve(sp) });
  const html = renderToStaticMarkup(<>{tree}</>);
  return { html, doc: parseHtml(html) };
}

function h1(doc: Document): string[] {
  return [...doc.querySelectorAll("h1")].map((h) => h.textContent ?? "");
}

function relatedChips(doc: Document): { label: string; queries: string[]; hrefs: string[] } | null {
  for (const nav of doc.querySelectorAll("nav[aria-labelledby]")) {
    const label = doc.getElementById(nav.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() ?? "";
    if (label !== "Related searches") continue;
    const hrefs = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    return { label, hrefs, queries: hrefs.map((h) => new URL(h, SITE).searchParams.get("q") ?? "") };
  }
  return null;
}

function promoCount(doc: Document): number {
  return doc.querySelectorAll('ul[data-layout="grid"] > li[data-promo-span]').length;
}

function feedback(doc: Document): Element | null {
  return [...doc.querySelectorAll("h2")].find((h) => h.textContent === FEEDBACK_HEADING)?.closest("section") ?? null;
}

function total(q: string): number {
  const r = getSearchService().search(q, { now: Date.now() });
  return r.ok ? r.value.total : -1;
}

/** Scripts other than React's own `$$reactFormReplay` bootstrap (emitted for every no-JS action form). */
function foreignScripts(doc: Document): Element[] {
  return [...doc.querySelectorAll("script")].filter((s) => !(s.textContent ?? "").includes("$$reactFormReplay"));
}

describe("/search heading (L-2, SR3)", () => {
  test("query: one h1 'Showing results for “q”' with the query as text; browse: 'All results'", async () => {
    expect(h1((await render({ q: "desk" })).doc)).toEqual([`Showing results for ${OPEN_Q}desk${CLOSE_Q}`]);
    expect(h1((await render({})).doc)).toEqual(["All results"]);
    const { doc } = await render({ q: "desk" });
    expect(doc.querySelector("h1")?.id).toBe("listing-title");
    expect(doc.querySelector("h1 *")).toBeNull();
  });

  test("the metadata title keeps 'Results for “q”'; robots noindex,follow; canonical /search?q= without facets/sort/page/view", async () => {
    const md = await generateMetadata({ searchParams: Promise.resolve({ q: "desk", instock: "1", sort: "price_asc", page: "2", view: "list", rail: "deals" }) });
    expect(String((md.title as { absolute?: string } | string | undefined) ?? "")).toContain(`Results for ${OPEN_Q}desk${CLOSE_Q}`);
    expect(md.robots).toEqual({ index: false, follow: true });
    expect(md.alternates?.canonical).toBe(`${SITE}/search?q=desk`);
    const browse = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(browse.robots).toEqual({ index: false, follow: true });
  });
});

describe("/search related chips (L-4)", () => {
  test.each([["desk"], ["DESK"], ["Office"], ["office"], ["lumen & co."], ["Voltline"], ["headphones"]])(
    "q=%s: chips come from the result facets, <= 12, never the query (case-insensitive), each finds products",
    async (q) => {
      const { doc } = await render({ q });
      const chips = relatedChips(doc);
      expect(chips).not.toBeNull();
      expect(chips?.queries.length ?? 0).toBeGreaterThan(0);
      expect(chips?.queries.length ?? 0).toBeLessThanOrEqual(12);
      const lower = (chips?.queries ?? []).map((c) => c.toLowerCase());
      expect(lower).not.toContain(q.trim().toLowerCase());
      expect(new Set(lower).size).toBe(lower.length);
      for (const [i, href] of (chips?.hrefs ?? []).entries()) {
        expect(href).toBe(`/search?q=${encodeURIComponent(chips?.queries[i] ?? "")}`);
        expect(isAllowedInternalHref(href)).toBe(true);
        expect({ chip: chips?.queries[i], found: total(chips?.queries[i] ?? "") > 0 }).toEqual({ chip: chips?.queries[i], found: true });
      }
    },
  );

  test("browse mode (no q) has no related chips; chips add no headings", async () => {
    expect(relatedChips((await render({})).doc)).toBeNull();
    const { doc } = await render({ q: "desk" });
    const nav = [...doc.querySelectorAll("nav[aria-labelledby]")].find((n) => doc.getElementById(n.getAttribute("aria-labelledby") ?? "")?.textContent === "Related searches");
    expect(nav?.querySelectorAll("h1,h2,h3,h4,h5,h6")).toHaveLength(0);
    expect(doc.getElementById(nav?.getAttribute("aria-labelledby") ?? "")?.tagName).not.toMatch(/^H\d$/);
  });

  test("zero results for a multi-term query: chips are single terms that find something, never the query", async () => {
    const { doc } = await render({ q: "headphones zzqxv" });
    const chips = relatedChips(doc);
    expect(chips?.queries).toEqual(["headphones"]);
  });
});

describe("/search promos and feedback (L-13..L-15, L-19, L-20)", () => {
  test("q=desk (>= 8 results): promo tiles on page 1 only; a facet, dept, page 2 or the list view removes them", async () => {
    expect(total("desk")).toBeGreaterThanOrEqual(8);
    expect(promoCount((await render({ q: "desk" })).doc)).toBeGreaterThan(0);
    expect(promoCount((await render({ q: "desk", sort: "price_asc" })).doc)).toBeGreaterThan(0);
    for (const sp of [{ instock: "1" }, { dept: "office" }, { brand: "voltline" }, { view: "list" }, { min: "5" }] as SP[]) {
      expect({ sp, promos: promoCount((await render({ q: "desk", ...sp })).doc) }).toEqual({ sp, promos: 0 });
    }
    const browse = await render({ page: "2" });
    expect(promoCount(browse.doc)).toBe(0);
  });

  test("a query with 1..7 results has no promo tiles", async () => {
    const small = POPULAR_SEARCHES.concat(["lamp", "puzzle", "mug", "kettle", "candle"]).find((t) => {
      const n = total(t);
      return n > 0 && n < 8;
    });
    expect(small).toBeDefined();
    expect(promoCount((await render({ q: small ?? "" })).doc)).toBe(0);
  });

  test.each([["desk"], ["headphones"], ["HEADPHONES"], ["zzqxv"], [""]])("q=%s: feedback block present, exact feedback href, suggestions never the current query", async (q) => {
    const { doc } = await render(q === "" ? {} : { q });
    const section = feedback(doc);
    expect(section).not.toBeNull();
    expect([...(section?.querySelectorAll("a") ?? [])].filter((a) => a.textContent?.trim() === "Give feedback").map((a) => a.getAttribute("href"))).toEqual([
      "/contact?topic=feedback",
    ]);
    const suggestions = [...(section?.querySelectorAll("ul a") ?? [])].map((a) => a.getAttribute("href") ?? "");
    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    for (const href of suggestions) {
      const url = new URL(href, SITE);
      if (url.pathname === "/search") expect((url.searchParams.get("q") ?? "").toLowerCase()).not.toBe(q.toLowerCase());
      expect(isAllowedInternalHref(href)).toBe(true);
    }
    expect(section?.querySelectorAll("form, input")).toHaveLength(0);
  });
});

describe("/search zero results (L-23) and did-you-mean", () => {
  test("zero results: sunken 'No results' Card, tip/popular/department Cards (h3-labelled), no filter panel, no grid", async () => {
    const { doc } = await render({ q: "zzqxv" });
    expect(doc.getElementById("listing-result-count")?.textContent).toBe("0 results");
    const noResults = [...doc.querySelectorAll("h2")].find((h) => h.textContent === "No results");
    expect(noResults).toBeDefined();
    expect(noResults?.parentElement?.getAttribute("class") ?? "").toMatch(/\bbg-surface-sunken\b/);
    for (const id of ["search-tips", "search-popular", "search-departments"]) {
      const section = doc.querySelector(`section[aria-labelledby="${id}"]`);
      expect({ id, h3: doc.getElementById(id)?.tagName, card: /\brounded-lg\b/.test(section?.getAttribute("class") ?? "") }).toEqual({ id, h3: "H3", card: true });
    }
    const popular = [...(doc.querySelector('section[aria-labelledby="search-popular"]')?.querySelectorAll("a") ?? [])];
    expect(popular.length).toBeGreaterThanOrEqual(3);
    for (const a of popular) expect(total(new URL(a.getAttribute("href") ?? "", SITE).searchParams.get("q") ?? "")).toBeGreaterThan(0);
    const departments = [...(doc.querySelector('section[aria-labelledby="search-departments"]')?.querySelectorAll("a") ?? [])];
    expect(departments.map((a) => a.getAttribute("href")).every((h) => /^\/category\/[a-z0-9-]+$/.test(h ?? ""))).toBe(true);
    expect(doc.querySelector("details[data-filter-panel]")).toBeNull();
    expect(doc.querySelector('ul[data-layout="grid"]')).toBeNull();
    expect(feedback(doc)).not.toBeNull();
  });

  test("did-you-mean: a misspelling links the suggestion; a normal query shows none", async () => {
    const miss = await render({ q: "headphnes" });
    const link = [...miss.doc.querySelectorAll("a")].find((a) => (a.parentElement?.textContent ?? "").startsWith("Did you mean"));
    expect(link?.getAttribute("href")).toBe("/search?q=headphones");
    expect(link?.textContent).toBe("headphones");
    // The suggestion is never repeated as a related chip.
    expect(relatedChips(miss.doc)?.queries ?? []).not.toContain("headphones");
    const normal = await render({ q: "desk" });
    expect(normal.doc.body.textContent).not.toContain("Did you mean");
  });
});

describe("/search hostile queries (L-24) and safety", () => {
  const hostile: Array<[string, string]> = [
    ["script", "<script>alert(1)</script>"],
    ["img", '"><img src=x onerror=alert(1)>'],
    ["quotes", `desk "quoted" 'single'`],
    ["101+ chars", "d".repeat(150)],
    ["emoji", "🎧 headphones"],
    ["rtl override", "‮desk"],
    ["mixed", `desk "><script>alert(1)</script>`],
  ];
  test.each(hostile)("%s: escaped text in the h1, no injected markup, chip hrefs encoded and allowed", async (_n, q) => {
    const { doc, html } = await render({ q });
    const heading = h1(doc);
    expect(heading).toHaveLength(1);
    expect(heading[0]?.startsWith(`Showing results for ${OPEN_Q}`)).toBe(true);
    expect((heading[0] ?? "").length).toBeLessThanOrEqual(`Showing results for ${OPEN_Q}${CLOSE_Q}`.length + 100);
    expect(heading[0]).not.toContain("‮");
    expect(doc.querySelector("img[src='x']")).toBeNull();
    expect(foreignScripts(doc)).toHaveLength(0);
    expect(html).not.toContain("<script>alert");
    const handlers = [...doc.querySelectorAll("*")].flatMap((el) => el.getAttributeNames().filter((n) => n.startsWith("on")));
    expect(handlers).toEqual([]);
    for (const href of relatedChips(doc)?.hrefs ?? []) {
      expect(isAllowedInternalHref(href)).toBe(true);
      // encodeURIComponent leaves ' unescaped (unreserved); markup-significant chars must be encoded.
      expect(href).not.toMatch(/[<>" ]/);
    }
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
    expect(duplicateIds(doc)).toEqual([]);
  });

  test("emoji query keeps the emoji as text in the h1", async () => {
    expect(h1((await render({ q: "🎧 headphones" })).doc)[0]).toContain("🎧");
  });

  test("101+ char query: metadata title and canonical carry the 100-char cleaned query only", async () => {
    const md = await generateMetadata({ searchParams: Promise.resolve({ q: "e".repeat(300) }) });
    expect(md.alternates?.canonical).toBe(`${SITE}/search?q=${"e".repeat(100)}`);
    expect(JSON.stringify(md.title)).not.toContain("e".repeat(101));
  });

  test("brand-free, light-only markup; no cookies read or written; nothing written to the DB", async () => {
    const before = getDatabase().query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n;
    const { doc, html } = await render({ q: "desk" });
    expect(brandAndThemeViolations(html)).toEqual([]);
    expect(darkClassTokens(doc)).toEqual([]);
    expect(harness.store.writes).toEqual([]);
    expect(harness.cookieReads).toBe(0);
    expect(getDatabase().query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n).toBe(before);
  });
});

describe("/search data access", () => {
  test.each([[{ q: "desk" }], [{ q: "zzqxv" }], [{}], [{ q: "desk", instock: "1", page: "2" }]] as Array<[SP]>)("%j: one list() call", async (sp) => {
    const spy = spyOn(getListingService(), "list");
    restorers.push(() => spy.mockRestore());
    await render(sp);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test.each([[{ q: "desk" }], [{ q: "zzqxv" }], [{}]] as Array<[SP]>)("%j: the page call reads the clock once; rendering reads none", async (sp) => {
    const loaded = await countClockReads(() => SearchPage({ searchParams: Promise.resolve(sp) }));
    expect({ reads: loaded.reads, stacks: loaded.reads === 1 ? [] : loaded.stacks }).toEqual({ reads: 1, stacks: [] });
    const rendered = await countClockReads(async () => renderToStaticMarkup(<>{loaded.value}</>));
    expect({ reads: rendered.reads, stacks: rendered.stacks }).toEqual({ reads: 0, stacks: [] });
  });

  test("browse mode lists every published product", async () => {
    expect((await render({})).doc.getElementById("listing-result-count")?.textContent).toMatch(new RegExp(`of ${SEED_CATALOG_STATS.published} results$`));
  });
});
