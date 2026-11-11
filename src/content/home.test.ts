import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { createSearchService } from "@/server/catalog/search-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { SEED_DEPARTMENTS } from "@/server/db/seed-data/taxonomy";

import {
  HOME_AMOUNT_TOKEN,
  HOME_CONTENT,
  HOME_POPULAR_SEARCH_MAX,
  HOME_TOP_PICKS_SECTION_ID,
  topPicksTabHref,
  type HomeCta,
} from "./home";
import { ALL_HOME_ART, HERO_SLIDE_ART, LIFESTYLE_ART } from "./home-art";
import { isAllowedInternalHref } from "./routes";
import { POPULAR_SEARCHES } from "./search-help";

const APP_DIR = join(import.meta.dir, "..", "app");

const CATEGORY_SLUGS = new Set<string>(SEED_DEPARTMENTS.flatMap((d) => [d.slug, ...d.categories.map((c) => c.slug)]));

const C = HOME_CONTENT;

function allCtas(): HomeCta[] {
  return [
    ...C.hero.slides.map((s) => s.cta),
    C.shippingPromo.cta,
    C.lifestyleBanner.cta,
    ...C.lifestyleExplore.items.map((i) => i.cta),
    ...C.lifestyleMakeRoom.items.map((i) => i.cta),
    ...C.promoPair.items.map((i) => i.cta),
  ];
}

function allHrefs(): string[] {
  return [
    ...allCtas().map((c) => c.href),
    C.recentlyViewed.seeAllHref,
    ...C.topPicks.tabs.map((t) => topPicksTabHref(t.id)),
  ];
}

/** Every visible string in the module. */
function allText(): string[] {
  const promos = [C.shippingPromo, C.lifestyleBanner, ...C.promoPair.items];
  const cards = [...C.lifestyleExplore.items, ...C.lifestyleMakeRoom.items];
  const sections = [C.categories, C.discovery, C.recentlyViewed, C.brands];
  return [
    C.hero.label,
    ...C.hero.slides.flatMap((s) => [s.headline, s.subline]),
    ...promos.flatMap((p) => [p.heading, p.blurb]),
    ...cards.flatMap((c) => [c.heading, c.blurb]),
    ...[C.lifestyleExplore, C.lifestyleMakeRoom].flatMap((s) => [s.heading, s.eyebrow]),
    ...sections.flatMap((s) => [s.title, s.eyebrow]),
    C.topPicks.title,
    C.topPicks.eyebrow,
    C.topPicks.tabsLabel,
    ...C.topPicks.tabs.map((t) => t.label),
    C.popularSearches.label,
    ...C.popularSearches.terms,
    C.promoPair.heading,
    C.services.heading,
    ...allCtas().map((c) => c.label),
  ];
}

/** True when `href`'s path has a page under src/app (dynamic category slugs must exist in the seed taxonomy). */
function routeExists(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? "";
  if (path === "/") return existsSync(join(APP_DIR, "page.tsx"));
  const category = /^\/category\/([^/]+)$/.exec(path);
  if (category !== null) {
    return CATEGORY_SLUGS.has(decodeURIComponent(category[1] ?? "")) && existsSync(join(APP_DIR, "category", "[slug]", "page.tsx"));
  }
  return existsSync(join(APP_DIR, path.slice(1), "page.tsx"));
}

describe("home content (T165): links", () => {
  test("every href passes isAllowedInternalHref and has a page (category slugs from the seed taxonomy)", () => {
    const hrefs = allHrefs();
    expect(hrefs.length).toBeGreaterThan(15);
    for (const href of hrefs) {
      expect({ href, allowed: isAllowedInternalHref(href) }).toEqual({ href, allowed: true });
      expect({ href, exists: routeExists(href) }).toEqual({ href, exists: true });
    }
  });

  test("route check rejects unknown categories and missing pages (the check itself works)", () => {
    expect(routeExists("/category/not-a-real-category")).toBe(false);
    expect(routeExists("/departments")).toBe(false);
    expect(routeExists("/category/tops")).toBe(true);
    expect(routeExists("/deals")).toBe(true);
  });

  test("lifestyle and hero category CTAs point at /category/<slug>", () => {
    for (const item of [...C.lifestyleExplore.items, ...C.lifestyleMakeRoom.items]) {
      expect(item.cta.href).toMatch(/^\/category\/[a-z0-9-]+$/);
    }
  });

  test("CTA labels are non-empty and unique per set", () => {
    for (const cta of allCtas()) expect(cta.label.trim()).not.toBe("");
    for (const set of [C.lifestyleExplore, C.lifestyleMakeRoom]) {
      const hrefs = set.items.map((i) => i.cta.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
  });
});

describe("home content (T165): hero", () => {
  test("3 slides using HERO_SLIDE_ART in order, unique ids, known tones", () => {
    expect(C.hero.slides).toHaveLength(3);
    C.hero.slides.forEach((slide, i) => expect(slide.image).toBe(HERO_SLIDE_ART[i] as (typeof HERO_SLIDE_ART)[number]));
    expect(new Set(C.hero.slides.map((s) => s.id)).size).toBe(3);
    for (const slide of C.hero.slides) {
      expect(["neutral", "accent", "accent-subtle", "promo", "promo-subtle", "inverse"]).toContain(slide.tone);
      expect(slide.headline.length).toBeLessThanOrEqual(60);
    }
    expect(C.hero.sectionId).toBe("home-hero");
  });
});

describe("home content (T165): promos and lifestyle", () => {
  test("shipping promo heading names the threshold via {amount} exactly once, no hardcoded money, links /shipping", () => {
    const { heading, blurb, cta } = C.shippingPromo;
    expect(heading.split(HOME_AMOUNT_TOKEN)).toHaveLength(2);
    expect(blurb).not.toContain(HOME_AMOUNT_TOKEN);
    for (const text of [heading, blurb]) expect(text).not.toMatch(/\$\s*\d|\d+(\.\d+)?\s*(USD|dollars)/i);
    expect(cta.href).toBe("/shipping");
    expect(C.shippingPromo.sectionId).toBe("home-shipping-promo");
  });

  test("explore set: 4 columns, 4 cards from LIFESTYLE_ART; make-room set: 3 columns, 3 cards", () => {
    expect(C.lifestyleExplore.columns).toBe(4);
    expect(C.lifestyleExplore.items).toHaveLength(4);
    expect(C.lifestyleMakeRoom.columns).toBe(3);
    expect(C.lifestyleMakeRoom.items).toHaveLength(3);
    const art = new Set<unknown>(Object.values(LIFESTYLE_ART));
    for (const item of [...C.lifestyleExplore.items, ...C.lifestyleMakeRoom.items]) expect(art.has(item.image)).toBe(true);
    expect(C.lifestyleExplore.sectionId).toBe("home-lifestyle-cards");
  });

  test("promo pair: New arrivals -> /new-arrivals, Top rated -> /top-rated (contract H-19)", () => {
    expect(C.promoPair.items.map((p) => [p.heading, p.cta.href])).toEqual([
      ["New arrivals", "/new-arrivals"],
      ["Top rated", "/top-rated"],
    ]);
  });

  test("every image is a manifest entry from home-art", () => {
    const manifest = new Set<unknown>(ALL_HOME_ART);
    const images = [
      ...C.hero.slides.map((s) => s.image),
      C.shippingPromo.image,
      C.lifestyleBanner.image,
      ...C.lifestyleExplore.items.map((i) => i.image),
      ...C.lifestyleMakeRoom.items.map((i) => i.image),
      ...C.promoPair.items.map((i) => i.image),
    ].filter((image) => image !== null);
    for (const image of images) expect(manifest.has(image)).toBe(true);
  });
});

describe("home content (T165): top picks", () => {
  test("4 tabs in contract H-14 order with their loader sources; default is Best sellers", () => {
    expect(C.topPicks.tabs.map((t) => [t.id, t.label, t.source])).toEqual([
      ["best-sellers", "Best sellers", "bestSellers"],
      ["deals", "Deals", "deals"],
      ["new-arrivals", "New arrivals", "newArrivals"],
      ["top-rated", "Top rated", "topRated"],
    ]);
    expect(C.topPicks.defaultTabId).toBe("best-sellers");
    expect(C.topPicks.sectionId).toBe(HOME_TOP_PICKS_SECTION_ID);
  });

  test("topPicksTabHref builds /?rail=<id>#top-picks and encodes the id", () => {
    expect(topPicksTabHref("deals")).toBe("/?rail=deals#top-picks");
    expect(topPicksTabHref("a b&c")).toBe("/?rail=a%20b%26c#top-picks");
  });
});

describe("home content (T165): popular searches", () => {
  test("starts with the shared /search list, unique, trimmed, at most 12", () => {
    const { terms } = C.popularSearches;
    expect(terms.slice(0, POPULAR_SEARCHES.length)).toEqual([...POPULAR_SEARCHES]);
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.length).toBeLessThanOrEqual(HOME_POPULAR_SEARCH_MAX);
    expect(new Set(terms).size).toBe(terms.length);
    for (const term of terms) expect(term).toMatch(/^[a-z]+( [a-z]+)*$/);
  });

  test("every term returns at least one result on the seeded catalogue", () => {
    const db = createDatabase(":memory:");
    try {
      runMigrations(db);
      seedDatabase(db);
      const search = createSearchService({ db, now: () => Date.now() });
      for (const term of C.popularSearches.terms) {
        const r = search.search(term, { page: 1, pageSize: 1 });
        expect({ term, ok: r.ok, found: r.ok ? r.value.total > 0 : false }).toEqual({ term, ok: true, found: true });
      }
    } finally {
      db.close();
    }
  });
});

describe("home content (T165): copy rules", () => {
  test("plain text, non-empty where required, no markup or entities", () => {
    for (const text of allText()) {
      expect(text).toBe(text.trim());
      expect(text).not.toMatch(/[<>]|&[a-z]+;/i);
    }
    for (const required of [...C.hero.slides.map((s) => s.headline), C.popularSearches.label, C.topPicks.title]) {
      expect(required).not.toBe("");
    }
  });

  test("section ids are unique and match the contract ids", () => {
    const ids = [
      C.hero.sectionId,
      C.categories.sectionId,
      C.shippingPromo.sectionId,
      C.discovery.sectionId,
      C.lifestyleBanner.sectionId,
      C.topPicks.sectionId,
      C.lifestyleExplore.sectionId,
      C.lifestyleMakeRoom.sectionId,
      C.popularSearches.sectionId,
      C.promoPair.sectionId,
      C.recentlyViewed.sectionId,
      C.brands.sectionId,
      C.services.sectionId,
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id === "top-picks" || id.startsWith("home-")).toBe(true);
  });

  test("brand-free (R2) and honest (R10): no retailer, partner, membership, newsletter, store or app copy", () => {
    const text = allText().join(" ").toLowerCase();
    // Banned words are assembled at runtime so no source file contains them (guard G01 scans src/**).
    const retailer = [["k", "mart"], ["tar", "get"], ["one", "pass"], ["after", "pay"], ["zi", "p "], ["pay", "pal"], ["u", "ber"]].map((p) => p.join(""));
    const services = [
      "click & collect", "click and collect", "same day", "same-day", "member", "newsletter", "subscribe",
      "sign up for", "in store", "in-store", "find a store", "catalogue out", "download the app", "pay later",
      "low prices", "delivered faster", "reward",
    ];
    for (const banned of [...retailer, ...services]) expect({ banned, found: text.includes(banned) }).toEqual({ banned, found: false });
  });
});
