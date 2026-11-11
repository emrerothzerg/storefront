/**
 * T172 (QA wave C1): page-level QA of the v3 home `/` (T165 loader + T166 page) against
 * `tests/redesign/CONTRACTS.md` H-order (as amended by T172) and H-1..H-25, G-6/G-7/G-17, R-5/R-6.
 * QA-owned. Page function called directly with the wave-5 next/* mocks, `:memory:` SQLite seeded
 * through the real seed; markup checks on `renderToStaticMarkup` output (no-JS view).
 * Defect pins are `test.failing` tagged `// PIN: D-T1xx-n`.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createSignedInUser,
  duplicateIds,
  harness,
  headingViolations,
  hrefViolations,
  installNextMocks,
  parseHtml,
  placePaidOrder,
  resetCookies,
  serverLike,
  totalChanges,
  UUID_RE,
} from "../phase2-wave5/_harness";
import { brandAndThemeViolations, countClockReads, darkClassTokens, themeToggles } from "./_phase3";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const previousDatabasePath = env.DATABASE_PATH;
const previousSiteUrl = env.NEXT_PUBLIC_SITE_URL;
env.DATABASE_PATH = ":memory:";
const SITE = "https://shop.example.com";
env.NEXT_PUBLIC_SITE_URL = SITE;

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const { isAllowedInternalHref } = await import("@/content/routes");
const { HOME_CONTENT } = await import("@/content/home");
const { getListingService } = await import("@/server/catalog/listing-service");
const { getSearchService } = await import("@/server/catalog/search-service");
const { SqliteBrandRepository } = await import("@/server/catalog/brand-repository");
const { getShippingService } = await import("@/server/pricing/shipping-service");
const { createRecommendationService, getRecommendationService } = await import("@/server/recommendations/recommendation-service");
const homeLib = await import("@/app/_lib/home");
const { addToCart } = await import("@/app/actions/cart");
const pageModule = await import("@/app/page");
const HomePage = pageModule.default;

type SP = Record<string, string | string[] | undefined>;
type HomeContent = typeof HOME_CONTENT;

const OWNER_A = "a1a1a1a1-0000-4000-8000-00000000000a";
const OWNER_B = "b2b2b2b2-0000-4000-8000-00000000000b";
const HOSTILE = `<img src=x onerror=alert(1)></script><script>alert(1)</script>&amp; "q' ‮x`;

/** H-order as amended by T172 (guest: no recently viewed). */
const ORDER_GUEST = [
  "home-hero",
  "home-categories",
  "home-shipping-promo",
  "home-discovery",
  "home-lifestyle-banner",
  "top-picks",
  "home-lifestyle-cards",
  "home-lifestyle-make-room",
  "home-popular-searches",
  "home-promo-pair",
  "home-brands",
  "home-services",
] as const;
const ORDER_WITH_VIEWS = [...ORDER_GUEST.slice(0, 10), "home-recently-viewed", ...ORDER_GUEST.slice(10)];
const TABS = [
  ["Best sellers", "best-sellers"],
  ["Deals", "deals"],
  ["New arrivals", "new-arrivals"],
  ["Top rated", "top-rated"],
] as const;

const restorers: Array<() => void> = [];
let restoreServerLike: () => void = () => {};

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  resetCookies();
  env.NEXT_PUBLIC_SITE_URL = SITE;
  restoreServerLike = serverLike([addToCart as never]);
});

afterEach(() => {
  restoreServerLike();
  while (restorers.length > 0) restorers.pop()?.();
});

afterAll(() => {
  while (restorers.length > 0) restorers.pop()?.();
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
  if (previousSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
});

async function renderHome(sp: SP = {}): Promise<{ html: string; doc: Document }> {
  const html = renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve(sp) }));
  return { html, doc: parseHtml(html) };
}

/** Home section roots in document order: every `id` that starts with `home-` (minus heading ids) plus `top-picks`. */
function sectionOrder(doc: Document): string[] {
  return [...doc.querySelectorAll("[id]")]
    .map((el) => el.id)
    .filter((id) => (id.startsWith("home-") || id === "top-picks") && !id.endsWith("-heading"));
}

function texts(nodes: Iterable<Element>): string[] {
  return [...nodes].map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim());
}

function topPicks(doc: Document): Element | null {
  return doc.getElementById("top-picks");
}

function productHrefs(root: Element | null | undefined): string[] {
  return [...(root?.querySelectorAll("a[href^='/products/']") ?? [])].map((a) => a.getAttribute("href") ?? "");
}

function currentTab(doc: Document): string | null {
  return topPicks(doc)?.querySelector('nav a[aria-current="page"]')?.textContent?.trim() ?? null;
}

function slugHref(slug: string): string {
  return `/products/${encodeURIComponent(slug)}`;
}

function ldJson(doc: Document): unknown[] {
  return [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent ?? "null") as unknown);
}

function publishedInStock(limit: number): { id: string; slug: string; name: string }[] {
  return getDatabase()
    .query<{ id: string; slug: string; name: string }, [number]>(
      "SELECT id, slug, name FROM products WHERE stock > 5 AND published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY id LIMIT ?",
    )
    .all(limit);
}

/** Calls the real loader with a content override (the page passes no deps, so this is the only seam). */
function withContent(edit: (c: HomeContent) => HomeContent): void {
  const real = homeLib.loadHomeData;
  const spy = spyOn(homeLib, "loadHomeData").mockImplementation((input) =>
    real(input, { ...homeLib.defaultHomeDeps(), content: edit(HOME_CONTENT) }),
  );
  restorers.push(() => spy.mockRestore());
}

function stub<T extends object, K extends keyof T>(target: T, key: K, value: unknown): void {
  const spy = spyOn(target, key as never).mockImplementation((() => value) as never);
  restorers.push(() => (spy as { mockRestore: () => void }).mockRestore());
}

/** Structural no-orphan check: every h2 in the page sits inside a home section root (or the hero). */
function orphanH2s(doc: Document): string[] {
  return [...doc.querySelectorAll("h2")]
    .filter((h) => h.closest('[id^="home-"], #top-picks') === null && h.closest("[data-home-hero]") === null)
    .map((h) => h.textContent ?? "");
}

function emptySections(doc: Document): string[] {
  return [...doc.querySelectorAll("section")]
    .filter((s) => (s.textContent ?? "").trim() === "" && s.querySelector("img, a, form") === null)
    .map((s) => s.id || s.outerHTML.slice(0, 60));
}

// ---------------------------------------------------------------------------
// H-order, H-1, H-2, G-6, G-7
// ---------------------------------------------------------------------------

describe("home / section order and headings (H-order, H-1, H-2, G-6, G-7)", () => {
  test("guest: sections in the amended H-order exactly (hero first, make-room after explore, brands before services)", async () => {
    const { doc } = await renderHome();
    expect(sectionOrder(doc)).toEqual([...ORDER_GUEST]);
  });

  test("signed-in user with views: recently viewed sits after the promo pair and before brands", async () => {
    const db = getDatabase();
    const user = await createSignedInUser(db, "Hana Homeorder", "hana.homeorder");
    const [p0] = publishedInStock(1);
    expect(createRecommendationService({ db }).recordView(user.ownerKey, p0?.id ?? "", Date.now() - 1000).ok).toBe(true);
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
    const { doc, html } = await renderHome();
    expect(sectionOrder(doc)).toEqual(ORDER_WITH_VIEWS);
    expect(html).not.toContain(user.ownerKey);
  });

  test("one h1, first heading, inside #home-hero, equal to the first slide headline; no skipped levels", async () => {
    const { doc } = await renderHome();
    const h1s = [...doc.querySelectorAll("h1")];
    expect(texts(h1s)).toEqual([HOME_CONTENT.hero.slides[0]?.headline ?? "?"]);
    expect(h1s[0]?.closest("#home-hero")).not.toBeNull();
    expect(doc.querySelector("h1,h2,h3,h4,h5,h6")?.tagName).toBe("H1");
    expect(headingViolations(doc)).toEqual([]);
    expect(duplicateIds(doc)).toEqual([]);
  });

  test("each section after the hero: exactly one h2, it is the first heading, and the section is labelled by it", async () => {
    const { doc } = await renderHome();
    const problems: string[] = [];
    for (const id of ORDER_GUEST.slice(1)) {
      const section = doc.getElementById(id);
      if (section === null) {
        problems.push(`${id}: missing`);
        continue;
      }
      const h2s = section.querySelectorAll("h2");
      const first = section.querySelector("h1,h2,h3,h4,h5,h6");
      if (h2s.length !== 1) problems.push(`${id}: ${h2s.length} h2`);
      if (first?.tagName !== "H2") problems.push(`${id}: first heading ${first?.tagName ?? "none"}`);
      const labelledBy = section.getAttribute("aria-labelledby");
      if (labelledBy === null || labelledBy !== h2s[0]?.id) problems.push(`${id}: aria-labelledby=${labelledBy} h2#${h2s[0]?.id}`);
      if (section.querySelector("h1") !== null) problems.push(`${id}: contains h1`);
    }
    expect(problems).toEqual([]);
  });

  test("cards and tiles hold no h1/h2 (H-3): product cards h3, category tiles no headings", async () => {
    const { doc } = await renderHome();
    expect(doc.querySelectorAll("article h1, article h2, li h1, li h2")).toHaveLength(0);
    for (const id of ["home-categories", "home-discovery"]) {
      expect({ id, headings: doc.getElementById(id)?.querySelectorAll("li h1, li h2, li h3, li h4").length }).toEqual({ id, headings: 0 });
    }
    const cardTitles = topPicks(doc)?.querySelectorAll("article h3").length ?? 0;
    expect(cardTitles).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// H-4 omission matrix
// ---------------------------------------------------------------------------

describe("home / omission matrix (H-4): each reader or content set empty removes only its section(s)", () => {
  type Case = { name: string; gone: readonly string[]; install: () => void };
  const cases: Case[] = [
    { name: "categoryTree empty", gone: ["home-categories", "home-discovery"], install: () => stub(getListingService(), "categoryTree", []) },
    { name: "brands empty", gone: ["home-brands"], install: () => stub(SqliteBrandRepository.prototype, "listWithCounts", []) },
    { name: "no shipping methods (no threshold)", gone: ["home-shipping-promo"], install: () => stub(getShippingService(), "listMethods", []) },
    {
      name: "every top-picks tab empty",
      gone: ["top-picks"],
      install: () => {
        for (const k of ["deals", "bestSellers", "newArrivals", "topRated"] as const) stub(getListingService(), k, []);
      },
    },
    { name: "hero slides empty (content)", gone: ["home-hero"], install: () => withContent((c) => ({ ...c, hero: { ...c.hero, slides: [] } })) },
    {
      name: "lifestyle banner CTA not allowed (content)",
      gone: ["home-lifestyle-banner"],
      install: () => withContent((c) => ({ ...c, lifestyleBanner: { ...c.lifestyleBanner, cta: { label: "x", href: "https://evil.example/" } } })),
    },
    {
      name: "explore set with 1 valid card (content)",
      gone: ["home-lifestyle-cards"],
      install: () =>
        withContent((c) => ({
          ...c,
          lifestyleExplore: {
            ...c.lifestyleExplore,
            items: c.lifestyleExplore.items.map((it, i) => (i === 0 ? it : { ...it, cta: { label: it.cta.label, href: "javascript:alert(1)" } })),
          },
        })),
    },
    {
      name: "make-room set with 1 valid card (content)",
      gone: ["home-lifestyle-make-room"],
      install: () =>
        withContent((c) => ({
          ...c,
          lifestyleMakeRoom: { ...c.lifestyleMakeRoom, items: c.lifestyleMakeRoom.items.slice(0, 1) },
        })),
    },
    {
      name: "popular searches empty (content)",
      gone: ["home-popular-searches"],
      install: () => withContent((c) => ({ ...c, popularSearches: { ...c.popularSearches, terms: [] } })),
    },
    {
      name: "promo pair with one invalid CTA (content)",
      gone: ["home-promo-pair"],
      install: () =>
        withContent((c) => ({
          ...c,
          promoPair: { ...c.promoPair, items: c.promoPair.items.map((it, i) => (i === 1 ? { ...it, cta: { label: "x", href: "//evil.example" } } : it)) },
        })),
    },
  ];

  test.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    c.install();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    restorers.push(() => errors.mockRestore());
    const { doc } = await renderHome();
    expect(sectionOrder(doc)).toEqual(ORDER_GUEST.filter((id) => !c.gone.includes(id)));
    expect(orphanH2s(doc)).toEqual([]);
    expect(emptySections(doc)).toEqual([]);
    // An empty reader is not a failure: nothing is logged.
    expect(errors).not.toHaveBeenCalled();
    if (!c.gone.includes("home-hero")) expect(headingViolations(doc)).toEqual([]);
  });

  test("deals empty: the Deals tab keeps its link (empty tab), the hero deal panel and the deals ItemList go", async () => {
    stub(getListingService(), "deals", []);
    const { doc } = await renderHome({ rail: "deals" });
    expect(sectionOrder(doc)).toEqual([...ORDER_GUEST]);
    expect(topPicks(doc)?.querySelector('a[href="/?rail=deals#top-picks"]')?.getAttribute("aria-current")).toBe("page");
    expect(productHrefs(topPicks(doc))).toEqual([]);
    expect(topPicks(doc)?.querySelectorAll('[role="status"]').length).toBe(1);
    expect(doc.getElementById("home-hero-deal-heading")).toBeNull();
    expect(ldJson(doc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// H-14 / H-15 / H-16 top picks tabs
// ---------------------------------------------------------------------------

describe("home / top picks tabs (H-14, H-15, H-16)", () => {
  test("4 link tabs in order with /?rail=<id>#top-picks hrefs, exactly one aria-current, no role=tab (no-JS)", async () => {
    const { doc } = await renderHome();
    const nav = topPicks(doc)?.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe(HOME_CONTENT.topPicks.tabsLabel);
    const links = [...(nav?.querySelectorAll("a") ?? [])];
    expect(links.map((a) => [a.textContent?.trim(), a.getAttribute("href")])).toEqual(
      TABS.map(([label, id]) => [label, `/?rail=${id}#top-picks`]),
    );
    expect(links.filter((a) => a.getAttribute("aria-current") === "page")).toHaveLength(1);
    expect(doc.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
    // Tabs are plain links: no tab buttons; every visible button in the section is a quick-add submit or a disabled OOS label.
    const stray = [...doc.querySelectorAll("#top-picks button:not([hidden])")].filter((b) => b.closest("form") === null && !b.hasAttribute("disabled"));
    expect(stray.map((b) => b.outerHTML.slice(0, 80))).toEqual([]);
  });

  test("fresh seed (no paid orders): default tab is the first non-empty one (Deals), with the deals products", async () => {
    const { doc } = await renderHome();
    expect(currentTab(doc)).toBe("Deals");
    const now = Date.now();
    const deals = getListingService().deals(homeLib.RAIL_LIMIT, now).map((p) => slugHref(p.slug));
    expect(productHrefs(topPicks(doc))).toEqual(deals);
  });

  test("after one paid order the content default (Best sellers) is the default tab", async () => {
    const [p] = publishedInStock(1);
    await placePaidOrder(getDatabase(), OWNER_B, [p?.id ?? ""]);
    const { doc } = await renderHome();
    expect(currentTab(doc)).toBe("Best sellers");
    expect(productHrefs(topPicks(doc))).toContain(slugHref(p?.slug ?? ""));
  });

  test.each(TABS.slice(1).map(([label, id]) => [id, label] as const))("?rail=%s selects %s and renders only that list", async (id, label) => {
    const { doc } = await renderHome({ rail: id });
    expect(currentTab(doc)).toBe(label);
    const now = Date.now();
    const svc = getListingService();
    const expected = (
      id === "deals" ? svc.deals(12, now) : id === "new-arrivals" ? svc.newArrivals(12, now) : svc.topRated(12, now)
    ).map((p) => slugHref(p.slug));
    expect(productHrefs(topPicks(doc))).toEqual(expected);
  });

  test("?rail=best-sellers on a fresh seed: the empty tab is selected, keeps heading + tabs, shows a status line and no cards", async () => {
    const { doc } = await renderHome({ rail: "best-sellers" });
    expect(currentTab(doc)).toBe("Best sellers");
    expect(topPicks(doc)?.querySelector("h2")?.textContent).toBe(HOME_CONTENT.topPicks.title);
    expect(topPicks(doc)?.querySelectorAll("nav a")).toHaveLength(4);
    expect(productHrefs(topPicks(doc))).toEqual([]);
    expect(topPicks(doc)?.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  const invalid: Array<[string, string | string[]]> = [
    ["unknown", "x"],
    ["empty", ""],
    ["array", ["deals", "top-rated"]],
    ["__proto__", "__proto__"],
    ["constructor", "constructor"],
    ["toString", "toString"],
    ["500 chars", "deals".repeat(100)],
    ["upper case", "DEALS"],
    ["padded", " deals "],
    ["fragment", "deals#top-picks"],
    ["encoded", "%64eals"],
    ["script", "<script>alert(1)</script>"],
    ["nul", "deals\u0000"],
  ];
  test.each(invalid)("invalid rail (%s) falls back to the default tab and never throws", async (_n, rail) => {
    const { doc, html } = await renderHome({ rail });
    expect(currentTab(doc)).toBe("Deals");
    expect(html).not.toContain("<script>alert");
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
  });

  test("rail cards: at most 12, no duplicate product, compact variant", async () => {
    for (const [, id] of TABS) {
      const { doc } = await renderHome({ rail: id });
      const hrefs = productHrefs(topPicks(doc));
      expect({ id, n: hrefs.length <= 12 }).toEqual({ id, n: true });
      expect({ id, unique: new Set(hrefs).size }).toEqual({ id, unique: hrefs.length });
      const variants = [...(topPicks(doc)?.querySelectorAll("article") ?? [])].map((a) => a.getAttribute("data-variant"));
      expect(variants.every((v) => v === "compact")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Quick add (L-12 on home), one clock
// ---------------------------------------------------------------------------

describe("home / quick add and clock", () => {
  test("every in-stock rail card has a sibling POST form: productId + quantity=1, no price field, named button", async () => {
    const { doc } = await renderHome();
    const cards = [...(topPicks(doc)?.querySelectorAll("article") ?? [])];
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      const link = card.querySelector("a[href^='/products/']");
      const name = card.querySelector("h3")?.textContent ?? "";
      const form = card.querySelector("form");
      if (card.textContent?.includes("Out of stock")) {
        expect({ name, form: form === null }).toEqual({ name, form: true });
        continue;
      }
      expect(form?.getAttribute("method")?.toUpperCase()).toBe("POST");
      expect(link?.contains(form ?? null)).toBe(false);
      expect(link?.querySelectorAll("a, button, form, input")).toHaveLength(0);
      const fields = [...(form?.querySelectorAll("input:not([name^='$ACTION'])") ?? [])].map((i) => [i.getAttribute("name"), i.getAttribute("type")]);
      expect(fields).toEqual([
        ["productId", "hidden"],
        ["quantity", "hidden"],
      ]);
      expect(form?.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
      expect(form?.querySelector("button[type='submit']")?.textContent?.replace(/\s+/g, " ").trim()).toBe(`Add to cart: ${name}`);
    }
  });

  test("the loader reads the clock exactly once; rendering the element reads none", async () => {
    const loaded = await countClockReads(() => HomePage({ searchParams: Promise.resolve({ rail: "new-arrivals" }) }));
    expect({ reads: loaded.reads, stacks: loaded.reads === 1 ? [] : loaded.stacks }).toEqual({ reads: 1, stacks: [] });
    const rendered = await countClockReads(async () => renderToStaticMarkup(loaded.value));
    expect({ reads: rendered.reads, stacks: rendered.stacks }).toEqual({ reads: 0, stacks: [] });
  });
});

// ---------------------------------------------------------------------------
// Own-data recently viewed (H-20)
// ---------------------------------------------------------------------------

describe("home / recently viewed uses only the owner's own data (H-20)", () => {
  test("owner A sees only A's in-stock views; B's views never appear; no write, no cookie, no owner key", async () => {
    const db = getDatabase();
    const reco = createRecommendationService({ db });
    const [a0, a1, b0, oos] = publishedInStock(4);
    if (a0 === undefined || a1 === undefined || b0 === undefined || oos === undefined) throw new Error("fixture");
    db.run("UPDATE products SET stock = 0 WHERE id = ?", [oos.id]);
    const t = Date.now() - 60_000;
    for (const [owner, id, k] of [
      [OWNER_A, a0.id, 0],
      [OWNER_A, a1.id, 1],
      [OWNER_A, oos.id, 2],
      [OWNER_B, b0.id, 3],
    ] as const) {
      expect(reco.recordView(owner, id, t + k * 1000).ok).toBe(true);
    }
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const before = totalChanges(db);
    const { doc, html } = await renderHome();
    const recent = productHrefs(doc.getElementById("home-recently-viewed"));
    expect(recent).toContain(slugHref(a0.slug));
    expect(recent).toContain(slugHref(a1.slug));
    expect(recent).not.toContain(slugHref(b0.slug));
    expect(recent).not.toContain(slugHref(oos.slug));
    expect(totalChanges(db)).toBe(before);
    expect(harness.store.writes).toEqual([]);
    expect(html).not.toContain(OWNER_A);
    expect(html.match(UUID_RE)).toBeNull();
    expect(doc.getElementById("home-buy-again")).toBeNull();
  });

  test("no cookie: the recently-viewed reader is not called at all", async () => {
    const spy = spyOn(getRecommendationService(), "recentlyViewed");
    restorers.push(() => spy.mockRestore());
    const { doc } = await renderHome();
    expect(spy).not.toHaveBeenCalled();
    expect(doc.getElementById("home-recently-viewed")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Content sections: shipping promo, popular searches, services, discovery, lifestyle, promo pair
// ---------------------------------------------------------------------------

describe("home / content sections (H-12, H-13, H-17, H-18, H-19, H-21)", () => {
  test("shipping promo: one link to /shipping; the threshold comes from shipping-method data (changing it changes the text)", async () => {
    const first = (await renderHome()).doc.getElementById("home-shipping-promo");
    expect([...(first?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual(["/shipping"]);
    const lowest = getDatabase().query<{ c: number }, []>("SELECT MIN(free_over_cents) AS c FROM shipping_methods WHERE is_active = 1 AND free_over_cents > 0").get()?.c ?? 0;
    expect(first?.querySelector("h2")?.textContent).toBe(`Free shipping on orders of $${lowest / 100} or more`);

    getDatabase().run("UPDATE shipping_methods SET free_over_cents = 5250 WHERE free_over_cents IS NOT NULL");
    const changed = (await renderHome()).doc.getElementById("home-shipping-promo");
    expect(changed?.querySelector("h2")?.textContent).toBe("Free shipping on orders of $52.50 or more");
  });

  test("popular searches: named nav, <= 12 chips, hrefs /search?q=<encodeURIComponent(term)>, each term finds products", async () => {
    const { doc } = await renderHome();
    const section = doc.getElementById("home-popular-searches");
    const nav = section?.querySelector("nav");
    expect((nav?.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
    const links = [...(nav?.querySelectorAll("a") ?? [])];
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThanOrEqual(12);
    const now = Date.now();
    for (const a of links) {
      const term = a.textContent?.trim() ?? "";
      expect(a.getAttribute("href")).toBe(`/search?q=${encodeURIComponent(term)}`);
      const r = getSearchService().search(term, { now });
      expect({ term, found: r.ok && r.value.total > 0 }).toEqual({ term, found: true });
    }
  });

  test("services: h2 'Customer services', the returns notice comes BEFORE the tile list, tiles link the 6 service routes", async () => {
    const { doc } = await renderHome();
    const section = doc.getElementById("home-services");
    expect(section?.querySelector("h2")?.textContent).toBe("Customer services");
    const notice = [...(section?.querySelectorAll('a[href="/returns"]') ?? [])].find((a) => a.closest("ul") === null) ?? null;
    const list = section?.querySelector("ul") ?? null;
    expect(notice !== null && list !== null && (notice.compareDocumentPosition(list) & 4) !== 0).toBe(true);
    expect([...(list?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual([
      "/orders",
      "/returns",
      "/shipping",
      "/help",
      "/faq",
      "/contact",
    ]);
  });

  test("discovery: eyebrow + h2, 1..6 tiles, each a single /category/<slug> link with a non-empty name", async () => {
    const { doc } = await renderHome();
    const section = doc.getElementById("home-discovery");
    expect(section?.querySelector("[data-eyebrow]")?.textContent).toBe(HOME_CONTENT.discovery.eyebrow);
    const tiles = [...(section?.querySelectorAll("li") ?? [])];
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThanOrEqual(6);
    for (const li of tiles) {
      const links = li.querySelectorAll("a");
      expect(links).toHaveLength(1);
      expect(links[0]?.getAttribute("href")).toMatch(/^\/category\/[a-z0-9-]+$/);
      expect((links[0]?.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  test("lifestyle sets: 4 explore cards and 3 make-room cards, each one allowed /category link and an img with alt", async () => {
    const { doc } = await renderHome();
    for (const [id, n] of [
      ["home-lifestyle-cards", 4],
      ["home-lifestyle-make-room", 3],
    ] as const) {
      const cards = [...(doc.getElementById(id)?.querySelectorAll("ul > li") ?? [])];
      expect({ id, n: cards.length }).toEqual({ id, n });
      for (const li of cards) {
        const links = [...li.querySelectorAll("a")];
        expect(links).toHaveLength(1);
        expect(isAllowedInternalHref(links[0]?.getAttribute("href") ?? "")).toBe(true);
        for (const img of li.querySelectorAll("img")) expect(img.hasAttribute("alt")).toBe(true);
      }
    }
  });

  test("promo pair: 'New arrivals' -> /new-arrivals and 'Top rated' -> /top-rated", async () => {
    const { doc } = await renderHome();
    const pair = doc.getElementById("home-promo-pair");
    expect(texts(pair?.querySelectorAll("h3") ?? [])).toEqual(["New arrivals", "Top rated"]);
    expect([...(pair?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual(["/new-arrivals", "/top-rated"]);
  });

  test("hero (H-8..H-10): carousel region, 3 slides '1 of 3'.., 3 dot links, first image eager, others lazy, no autoplay", async () => {
    const { doc, html } = await renderHome();
    const hero = doc.getElementById("home-hero");
    expect(hero?.getAttribute("role")).toBe("region");
    expect(hero?.getAttribute("aria-roledescription")).toBe("carousel");
    expect((hero?.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
    const slides = [...(hero?.querySelectorAll('[aria-roledescription="slide"]') ?? [])];
    expect(slides.map((s) => s.getAttribute("aria-label"))).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
    const dots = [...(hero?.querySelectorAll('a[href^="#slide-"]') ?? [])];
    expect(dots.map((a) => a.getAttribute("href"))).toEqual(["#slide-1", "#slide-2", "#slide-3"]);
    const imgs = slides.map((s) => s.querySelector("img")?.getAttribute("loading"));
    expect(imgs).toEqual(["eager", "lazy", "lazy"]);
    expect(html).not.toMatch(/autoplay/i);
  });
});

// ---------------------------------------------------------------------------
// SEO: canonical, JSON-LD (H-22, H-23)
// ---------------------------------------------------------------------------

describe("home / canonical and JSON-LD (H-22, H-23)", () => {
  test("static metadata with canonical '/', no generateMetadata, so ?rail= can never change it", () => {
    expect((pageModule as Record<string, unknown>).generateMetadata).toBeUndefined();
    const canonical = String(pageModule.metadata.alternates?.canonical ?? "");
    expect(new URL(canonical, SITE).pathname).toBe("/");
    expect(canonical).not.toContain("rail");
    expect(canonical).not.toContain("?");
  });

  test("one ItemList of the deals rail, valid JSON, no raw '<', independent of the selected tab", async () => {
    const deals = getListingService().deals(12, Date.now()).map((p) => p.slug);
    for (const rail of [undefined, "new-arrivals", "best-sellers"]) {
      const { doc } = await renderHome(rail === undefined ? {} : { rail });
      const scripts = [...doc.querySelectorAll('script[type="application/ld+json"]')];
      expect(scripts).toHaveLength(1);
      expect(scripts[0]?.textContent ?? "").not.toContain("<");
      const data = JSON.parse(scripts[0]?.textContent ?? "{}") as { "@type": string; itemListElement: { url: string; position: number }[] };
      expect(data["@type"]).toBe("ItemList");
      expect(data.itemListElement.map((e) => new URL(e.url).pathname)).toEqual(deals.map(slugHref));
      expect(data.itemListElement.map((e) => e.position)).toEqual(deals.map((_, i) => i + 1));
    }
  });
});

// ---------------------------------------------------------------------------
// Safety: hrefs, brand-free, light-only, hostile names, omitted reference items
// ---------------------------------------------------------------------------

describe("home / safety and brand rules (G-14-style hrefs, G-17, R-5, R-6, H-24, H-25)", () => {
  test("every href is allow-listed or a same-page anchor that exists; no duplicate ids", async () => {
    for (const sp of [{}, { rail: "top-rated" }] as SP[]) {
      const { doc } = await renderHome(sp);
      expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
      expect(duplicateIds(doc)).toEqual([]);
    }
  });

  test("brand-free and light-only markup: no retailer names, theme strings, dark: classes or theme toggle", async () => {
    const { doc, html } = await renderHome();
    expect(brandAndThemeViolations(html)).toEqual([]);
    expect(darkClassTokens(doc)).toEqual([]);
    expect(themeToggles(doc)).toEqual([]);
  });

  test("H-24: no newsletter email field, no app download strip, no store finder", async () => {
    const { doc } = await renderHome();
    expect(doc.querySelectorAll('input[type="email"]')).toHaveLength(0);
    const text = (doc.body.textContent ?? "").toLowerCase();
    for (const word of ["download the app", "get the app", "store finder", "find a store", "newsletter"]) {
      expect({ word, found: text.includes(word) }).toEqual({ word, found: false });
    }
  });

  // R-6 forbidden copy minus "catalogue" (pinned separately below as D-T165-1).
  test("R-6: rendered text has none of the reference/partner phrases (except the pinned 'catalogue')", async () => {
    const { doc } = await renderHome();
    const text = (doc.body.textContent ?? "").toLowerCase();
    const words = ["low prices", "delivered faster", "click & collect", "click and collect", "same day", "app store", "google play", "pay" + "pal", "visa", "mastercard", "member"];
    expect(words.filter((w) => text.includes(w))).toEqual([]);
  });

  // PIN: D-T165-1 (fixed: copy changed in src/content/home.ts) (minor). CONTRACTS R-6 lists "catalogue" as forbidden rendered copy (R2/R10; the reference's
  // catalogue strip H15 is out of scope). The promo-pair blurb in src/content/home.ts reads "The latest additions to
  // the catalogue, …" and renders on every home page. Flip to `test` when the copy drops the word.
  test("DEFECT D-T165-1: home rendered text contains no 'catalogue' (R-6)", async () => {
    const { doc } = await renderHome();
    expect((doc.body.textContent ?? "").toLowerCase()).not.toContain("catalogue");
  });

  test("H-25: every img in the page has an alt attribute and width+height (or a fill image)", async () => {
    const { doc } = await renderHome();
    const bad = [...doc.querySelectorAll("img")].filter(
      (img) => !img.hasAttribute("alt") || !((img.getAttribute("width") && img.getAttribute("height")) || img.getAttribute("data-nimg") === "fill"),
    );
    expect(bad.map((img) => img.outerHTML.slice(0, 100))).toEqual([]);
    // Only the first hero slide is eager.
    expect([...doc.querySelectorAll('img[loading="eager"]')].map((i) => i.closest("[id]")?.id)).toEqual(["slide-1"]);
  });

  test("keyboard: scroll rails are focusable named regions; no positive tabindex; hidden scroll buttons stay hidden without JS", async () => {
    const { doc } = await renderHome();
    const scrollers = [...doc.querySelectorAll('[role="region"][tabindex="0"]')];
    expect(scrollers.length).toBeGreaterThanOrEqual(3);
    for (const el of scrollers) expect((el.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
    const positive = [...doc.querySelectorAll("[tabindex]")].filter((el) => Number(el.getAttribute("tabindex")) > 0);
    expect(positive).toHaveLength(0);
    for (const btn of doc.querySelectorAll("button[aria-label^='Scroll'], button[aria-label='Previous'], button[aria-label='Next']")) {
      expect(btn.hasAttribute("hidden")).toBe(true);
    }
  });

  test("hostile product, brand and category names render as inert text (cards, deal panel, tiles, brand strip, JSON-LD)", async () => {
    const db = getDatabase();
    const deal = getListingService().deals(1, Date.now())[0];
    if (deal === undefined) throw new Error("no deal");
    db.run("UPDATE products SET name = ? WHERE id = ?", [HOSTILE, deal.id]);
    db.run("UPDATE brands SET name = ? WHERE slug = (SELECT slug FROM brands ORDER BY slug LIMIT 1)", [HOSTILE]);
    db.run("UPDATE categories SET name = ? WHERE slug = 'electronics'", [HOSTILE]);
    const { doc, html } = await renderHome({ rail: "deals" });
    expect(doc.querySelector("img[src='x']")).toBeNull();
    expect(html).not.toContain("<script>alert");
    const handlers = [...doc.querySelectorAll("*")].flatMap((el) => el.getAttributeNames().filter((n) => n.startsWith("on")));
    expect(handlers).toEqual([]);
    expect(texts(topPicks(doc)?.querySelectorAll("h3") ?? [])).toContain(HOSTILE.replace(/\s+/g, " ").trim());
    expect(doc.getElementById("home-brands")?.textContent).toContain(HOSTILE);
    expect(doc.getElementById("home-categories")?.textContent).toContain(HOSTILE);
    const ld = doc.querySelector('script[type="application/ld+json"]')?.textContent ?? "";
    expect(ld).not.toContain("<");
    const parsed = JSON.parse(ld) as { itemListElement: { name: string }[] };
    expect(parsed.itemListElement[0]?.name).toBe(HOSTILE);
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
  });
});
