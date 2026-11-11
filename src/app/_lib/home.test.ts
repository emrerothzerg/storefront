import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import type { Product } from "@/lib/types";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import type { ShippingQuote } from "@/server/pricing/shipping-service";

import { HOME_CONTENT, type HomeContent } from "@/content/home";
import { HERO_SLIDE_ART } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";

import * as homeModule from "./home";
import {
  CATALOG_READERS,
  createHomeDeps,
  DISCOVERY_LIMIT,
  formatShippingThreshold,
  HomeDataUnavailableError,
  homeReadErrorCode,
  loadHomeData,
  RAIL_LIMIT,
  RAIL_TITLES,
  type HomeData,
  type HomeDeps,
} from "./home";

const SESSION = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const OTHER = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let db: Database;
const env = process.env as Record<string, string | undefined>;
const originalSiteUrl = env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
});

afterEach(() => {
  db.close();
  if (originalSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
});

function productIds(limit = 60): string[] {
  return db
    .query<{ id: string }, [number]>("SELECT id FROM products ORDER BY id LIMIT ?")
    .all(limit)
    .map((r) => r.id);
}

let orderSeq = 0;
function paidOrder(session: string, productIds: readonly string[], at = Date.now() - 86_400_000): void {
  orderSeq += 1;
  const id = `order_test_${orderSeq}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
       region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
     VALUES (?, ?, 'paid', 100, 100, 'USD', 'Test', 't@example.com', '1 St', 'City', 'RG', '00000', 'US', '4242', ?, ?, 'processing')`,
  ).run(id, session, `idem_${id}`, new Date(at).toISOString());
  const ins = db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'x', 100, 1)");
  for (const pid of productIds) ins.run(id, pid);
}

function view(session: string, productId: string, at: number): void {
  db.query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)").run(
    session,
    productId,
    new Date(at).toISOString(),
  );
}

/** Products of one top-picks tab (`?rail=<id>`), or undefined when the tab is not the active one / the section is omitted. */
async function tabProducts(deps: HomeDeps, id: string, sessionId: string | null = null): Promise<readonly Product[] | undefined> {
  const data = await loadHomeData({ sessionId, rail: id }, deps);
  return data.topPicks?.activeId === id ? data.topPicks.products : undefined;
}

function totalChanges(): number {
  return db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}

function shippingQuote(id: string, freeOverCents: number | null, isActive = true): ShippingQuote {
  return {
    method: { id, name: id, description: "", priceCents: 499, freeOverCents, minDays: 2, maxDays: 5, sortOrder: 1, isActive },
    priceCents: 499,
    isFree: false,
    amountToFreeCents: null,
  };
}

function fakeProduct(i: number, overrides: Partial<Product> = {}): Product {
  return {
    id: `p${i}`,
    slug: `product-${i}`,
    name: `Product ${i}`,
    description: "",
    priceCents: 1000 + i,
    currency: "USD",
    imageUrl: `/images/products/p${i}.svg`,
    stock: 5,
    ...overrides,
  };
}

/** Real deps with a spy on the session-dependent reader. */
function spiedDeps(logError = mock<(code: string) => void>(() => {})) {
  const real = createHomeDeps(db);
  const recentlyViewed = mock(real.recommendations.recentlyViewed.bind(real.recommendations));
  const deps: HomeDeps = { ...real, recommendations: { recentlyViewed }, logError };
  return { deps, recentlyViewed, logError };
}

describe("loadHomeData — T166 removals (deprecated Phase 2 surface)", () => {
  test("no banner/rails/coupon fields; HOME_BANNER and RAIL_ORDER are gone; readers only the v3 page uses", async () => {
    const data = await loadHomeData({ sessionId: SESSION }, createHomeDeps(db));
    for (const key of ["banner", "rails", "coupon"]) expect(Object.hasOwn(data, key)).toBe(false);
    for (const name of ["HOME_BANNER", "RAIL_ORDER", "BUY_AGAIN_FETCH_LIMIT"]) expect(Object.hasOwn(homeModule, name)).toBe(false);
    expect(Object.keys(createHomeDeps(db)).sort()).toEqual(["brands", "listing", "recommendations", "shipping"]);
    expect(Object.keys(RAIL_TITLES).sort()).toEqual(["best-sellers", "deals", "new-arrivals", "recently-viewed", "top-rated"]);
  });

  test("now: returned as data.now (the injected value, else one Date.now read)", async () => {
    const injected = await loadHomeData({ sessionId: null, now: 1_800_000_000_000 }, createHomeDeps(db));
    expect(injected.now).toBe(1_800_000_000_000);
    const before = Date.now();
    const read = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(read.now).toBeGreaterThanOrEqual(before);
    expect(read.now).toBeLessThanOrEqual(Date.now());
    const invalid = await loadHomeData({ sessionId: null, now: Number.NaN }, createHomeDeps(db));
    expect(Number.isFinite(invalid.now)).toBe(true);
  });
});

describe("loadHomeData — seeded :memory: DB, no session", () => {
  test("catalog sections load; the personal reader is never called; nothing is written", async () => {
    const { deps, recentlyViewed, logError } = spiedDeps();
    const before = totalChanges();
    const data = await loadHomeData({ sessionId: null }, deps);

    expect(totalChanges()).toBe(before);
    expect(recentlyViewed).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
    expect(data.recentlyViewed).toBeNull();
    expect(data.topPicks?.products.length ?? 0).toBeGreaterThan(0);
    expect(data.topPicks?.products.length ?? 0).toBeLessThanOrEqual(RAIL_LIMIT);
    for (const id of ["deals", "new-arrivals", "top-rated"]) {
      const products = await tabProducts(deps, id);
      expect(products?.length ?? 0).toBeGreaterThan(0);
      expect(products?.length ?? 0).toBeLessThanOrEqual(RAIL_LIMIT);
    }
    expect(await tabProducts(deps, "best-sellers")).toEqual([]);
  });

  test("hero deal is the first deal mapped to the HomeHero shape", async () => {
    const deps = createHomeDeps(db);
    const data = await loadHomeData({ sessionId: null }, deps);
    const first = (await tabProducts(deps, "deals"))?.[0];
    expect(first).toBeDefined();
    expect(data.deal).toEqual({
      title: first?.name ?? "",
      priceCents: first?.priceCents ?? 0,
      listPriceCents: first?.listPriceCents ?? null,
      currency: first?.currency ?? "",
      href: `/products/${encodeURIComponent(first?.slug ?? "")}`,
      imageUrl: first?.imageUrl,
    });
    expect((data.deal?.listPriceCents ?? 0) > (data.deal?.priceCents ?? 0)).toBe(true);
  });

  test.each([
    ["deals", "/deals"],
    ["new-arrivals", "/new-arrivals"],
    ["top-rated", "/top-rated"],
    ["best-sellers", "/best-sellers"],
  ])("see-all link of the %s tab: %s (planned routes only)", async (id, href) => {
    const data = await loadHomeData({ sessionId: null, rail: id }, createHomeDeps(db));
    expect(data.topPicks?.seeAllHref).toBe(href);
  });

  test("categoryTree and brands.listWithCounts receive the request now (CONS-B1 bl)", async () => {
    const deps = createHomeDeps(db);
    const tree = spyOn(deps.listing, "categoryTree");
    const brands = spyOn(deps.brands, "listWithCounts");
    const now = Date.now() - 60_000;
    await loadHomeData({ sessionId: null, now }, deps);
    expect(tree).toHaveBeenCalledWith(now);
    expect(brands).toHaveBeenCalledWith(now);
  });

  test("every product in every tab exists in the DB under its slug", async () => {
    const deps = createHomeDeps(db);
    const slugs = new Set(db.query<{ slug: string }, []>("SELECT slug FROM products").all().map((r) => r.slug));
    for (const id of ["deals", "new-arrivals", "top-rated"]) {
      for (const p of (await tabProducts(deps, id)) ?? []) expect(slugs.has(p.slug)).toBe(true);
    }
  });

  test("departments carry published product counts; empty departments are dropped", async () => {
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.departments.length).toBeGreaterThan(0);
    for (const d of data.departments) expect(d.productCount).toBeGreaterThan(0);
    const total = data.departments.reduce((s, d) => s + d.productCount, 0);
    const published = db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM products WHERE category_id IS NOT NULL AND published_at <= ?")
      .get(new Date().toISOString())?.n;
    expect(total).toBe(published ?? -1);
  });

  test("brands are filtered to brands with products", async () => {
    db.query("INSERT INTO brands (id, slug, name, description) VALUES ('brand_empty', 'empty-brand', 'Empty Brand', '')").run();
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.brands.length).toBeGreaterThan(0);
    expect(data.brands.map((b) => b.slug)).not.toContain("empty-brand");
    for (const b of data.brands) expect(Object.keys(b).sort()).toEqual(["name", "slug"]);
  });

  test("deals ItemList: positions 1..n, absolute PDP urls, same order as the deals tab", async () => {
    const deps = createHomeDeps(db);
    const data = await loadHomeData({ sessionId: null }, deps);
    const deals = (await tabProducts(deps, "deals")) ?? [];
    const ld = data.dealsJsonLd;
    expect(ld?.["@type"]).toBe("ItemList");
    expect(ld?.numberOfItems).toBe(deals.length);
    ld?.itemListElement.forEach((item, i) => {
      expect(item.url).toBe(`https://shop.example.com/products/${encodeURIComponent(deals[i]?.slug ?? "")}`);
      expect(item.position).toBe(i + 1);
    });
  });

  test("no deals: empty deals tab, no hero deal, no ItemList", async () => {
    db.query("UPDATE products SET list_price_cents = NULL").run();
    const deps = createHomeDeps(db);
    const data = await loadHomeData({ sessionId: null }, deps);
    expect(await tabProducts(deps, "deals")).toEqual([]);
    expect(data.deal).toBeNull();
    expect(data.dealsJsonLd).toBeNull();
  });

  test("cold start with sales anywhere: Best Sellers has products without a session (and becomes the default tab)", async () => {
    paidOrder(OTHER, productIds(3));
    const deps = createHomeDeps(db);
    expect((await tabProducts(deps, "best-sellers"))?.length).toBe(3);
    expect((await loadHomeData({ sessionId: null }, deps)).topPicks?.activeId).toBe("best-sellers");
  });

  test("a non-UUID session id is treated as no session", async () => {
    const { deps, recentlyViewed } = spiedDeps();
    await loadHomeData({ sessionId: "not-a-uuid" }, deps);
    expect(recentlyViewed).not.toHaveBeenCalled();
  });
});

describe("loadHomeData — seeded :memory: DB, with a session", () => {
  test("recently viewed appears once, excludes out-of-stock products, and carries no owner key", async () => {
    const ids = productIds(8);
    const [a, b, c, d] = ids as [string, string, string, string];
    const t = Date.now() - 60_000;
    view(SESSION, a, t);
    view(SESSION, b, t + 1);
    view(SESSION, c, t + 2);
    paidOrder(SESSION, [d]);
    db.query("UPDATE products SET stock = 0 WHERE id = ?").run(b);

    const { deps, recentlyViewed } = spiedDeps();
    const before = totalChanges();
    const data = await loadHomeData({ sessionId: SESSION }, deps);
    expect(totalChanges()).toBe(before);
    expect(recentlyViewed).toHaveBeenCalledTimes(1);

    expect(data.recentlyViewed?.products.map((p) => p.id)).toEqual([c, a]);
    expect(data.recentlyViewed?.id).toBe("recently-viewed");
    for (const p of data.recentlyViewed?.products ?? []) expect(p.stock).toBeGreaterThan(0);

    const json = JSON.stringify(data);
    expect(json).not.toContain(SESSION);
    expect(json).not.toMatch(UUID_RE);
  });

  test("another owner's history never leaks", async () => {
    const [a, b] = productIds(2) as [string, string];
    view(OTHER, a, Date.now() - 1000);
    paidOrder(OTHER, [b]);
    const data = await loadHomeData({ sessionId: SESSION }, createHomeDeps(db));
    expect(data.recentlyViewed).toBeNull();
  });
});

function fakeDeps(overrides: Partial<{ [K in keyof HomeDeps]: HomeDeps[K] }> = {}): HomeDeps {
  const products = Array.from({ length: 20 }, (_, i) => fakeProduct(i, { listPriceCents: 5000 }));
  return {
    listing: {
      deals: () => products,
      bestSellers: () => products,
      newArrivals: () => products,
      topRated: () => products,
      categoryTree: () => [
        {
          id: "d1", slug: "home", name: "Home", description: "", parentId: null, sortOrder: 1, imageUrl: null,
          children: [{ id: "c1", slug: "kitchen", name: "Kitchen", description: "", parentId: "d1", sortOrder: 1, imageUrl: null, productCount: 4 }],
        },
        { id: "d2", slug: "empty", name: "Empty", description: "", parentId: null, sortOrder: 2, imageUrl: null, children: [] },
      ],
    },
    brands: { listWithCounts: () => [{ id: "b1", slug: "acme", name: "Acme", description: "", productCount: 3 }] },
    shipping: { listMethods: () => [shippingQuote("standard", 3500)] },
    recommendations: { recentlyViewed: () => products },
    logError: () => {},
    ...overrides,
  };
}

describe("loadHomeData — fake readers", () => {
  test("rails are capped at RAIL_LIMIT; duplicates and unsafe slugs are dropped", async () => {
    const dup = fakeProduct(1);
    const bad = fakeProduct(99, { slug: "" });
    const deps = fakeDeps();
    const withDups: HomeDeps = { ...deps, listing: { ...deps.listing, newArrivals: () => [bad, dup, dup, fakeProduct(2)] } };
    const data = await loadHomeData({ sessionId: SESSION }, withDups);
    expect(data.recentlyViewed?.products).toHaveLength(RAIL_LIMIT);
    expect(await tabProducts(withDups, "deals")).toHaveLength(RAIL_LIMIT);
    expect((await tabProducts(withDups, "new-arrivals"))?.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(data.dealsJsonLd?.numberOfItems).toBe(RAIL_LIMIT);
    expect(data.departments.map((d) => d.slug)).toEqual(["home"]);
  });

  type Breaker = { reader: Parameters<typeof homeReadErrorCode>[0]; break: (d: HomeDeps) => HomeDeps; gone: (data: HomeData) => boolean };
  const boom = (): never => {
    throw new Error("SQLITE_ERROR: secret detail 3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b");
  };
  const tabIds = (x: HomeData) => x.topPicks?.tabs.map((t) => t.id) ?? [];
  const breakers: Breaker[] = [
    { reader: "deals", break: (d) => ({ ...d, listing: { ...d.listing, deals: boom } }), gone: (x) => !tabIds(x).includes("deals") && x.deal === null && x.dealsJsonLd === null },
    { reader: "bestSellers", break: (d) => ({ ...d, listing: { ...d.listing, bestSellers: boom } }), gone: (x) => !tabIds(x).includes("best-sellers") },
    { reader: "newArrivals", break: (d) => ({ ...d, listing: { ...d.listing, newArrivals: boom } }), gone: (x) => !tabIds(x).includes("new-arrivals") },
    { reader: "topRated", break: (d) => ({ ...d, listing: { ...d.listing, topRated: boom } }), gone: (x) => !tabIds(x).includes("top-rated") },
    { reader: "categories", break: (d) => ({ ...d, listing: { ...d.listing, categoryTree: boom } }), gone: (x) => x.departments.length === 0 && x.discoveryCategories.length === 0 },
    { reader: "brands", break: (d) => ({ ...d, brands: { listWithCounts: boom } }), gone: (x) => x.brands.length === 0 },
    { reader: "shipping", break: (d) => ({ ...d, shipping: { listMethods: boom } }), gone: (x) => x.freeShippingThresholdCents === null && x.promos.shipping === null },
    { reader: "recentlyViewed", break: (d) => ({ ...d, recommendations: { recentlyViewed: boom } }), gone: (x) => x.recentlyViewed === null },
  ];

  test.each(breakers.map((b) => [b.reader, b] as const))("a failing %s reader omits only its section and logs a code", async (reader, b) => {
    const logError = mock<(code: string) => void>(() => {});
    const data = await loadHomeData({ sessionId: SESSION }, { ...b.break(fakeDeps()), logError });
    expect(b.gone(data)).toBe(true);
    expect(logError.mock.calls).toEqual([[homeReadErrorCode(reader)]]);
    // Everything else is still there.
    for (const other of breakers.filter((x) => x.reader !== reader)) expect({ reader: other.reader, gone: other.gone(data) }).toEqual({ reader: other.reader, gone: false });
  });

  test("the default logger prints only the code", async () => {
    const spy = mock<(...args: unknown[]) => void>(() => {});
    const original = console.error;
    console.error = spy;
    try {
      const deps = fakeDeps();
      const withoutLogger: HomeDeps = {
        listing: deps.listing,
        brands: { listWithCounts: boom },
        shipping: deps.shipping,
        recommendations: deps.recommendations,
      };
      await loadHomeData({ sessionId: null }, withoutLogger);
    } finally {
      console.error = original;
    }
    expect(spy.mock.calls).toEqual([["[home] home.read_failed.brands"]]);
  });

  test("all catalog readers failing = DB unusable: rejects (error page) instead of an empty shell", async () => {
    const d = fakeDeps();
    const broken: HomeDeps = {
      ...d,
      listing: { deals: boom, bestSellers: boom, newArrivals: boom, topRated: boom, categoryTree: boom },
      brands: { listWithCounts: boom },
    };
    await expect(loadHomeData({ sessionId: null }, broken)).rejects.toBeInstanceOf(HomeDataUnavailableError);
  });

  test("the personal reader failing still renders the page", async () => {
    const data = await loadHomeData({ sessionId: SESSION }, { ...fakeDeps(), recommendations: { recentlyViewed: boom } });
    expect(data.recentlyViewed).toBeNull();
    expect(data.topPicks?.tabs).toHaveLength(4);
  });

  test("Next control-flow errors are rethrown, never swallowed", async () => {
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/signin;307;" });
    const d = fakeDeps();
    const logError = mock<(code: string) => void>(() => {});
    const promise = loadHomeData(
      { sessionId: null },
      { ...d, logError, brands: { listWithCounts: () => { throw redirectError; } } },
    );
    await expect(promise).rejects.toBe(redirectError);
    expect(logError).not.toHaveBeenCalled();
  });

  test("now is forwarded to every time-dependent reader", async () => {
    const d = fakeDeps();
    const seen: unknown[] = [];
    await loadHomeData(
      { sessionId: SESSION, now: 1_800_000_000_000 },
      {
        ...d,
        listing: {
          ...d.listing,
          deals: (_l, now) => { seen.push(now); return []; },
          newArrivals: (_l, now) => { seen.push(now); return []; },
          topRated: (_l, now) => { seen.push(now); return []; },
          bestSellers: (_l, o) => { seen.push(o?.now); return []; },
          categoryTree: (now) => { seen.push(now); return []; },
        },
        brands: { listWithCounts: (now) => { seen.push(now); return []; } },
        recommendations: { recentlyViewed: (_s, o) => { seen.push(o?.now); return []; } },
      },
    );
    expect(seen).toEqual(Array.from({ length: 7 }, () => 1_800_000_000_000));
  });
});

describe("loadHomeData v3 (T165) — hero, sections, content-driven fields", () => {
  test("heroSlides: the 3 content slides in order with their art; slide 1's headline is the Phase 2 h1 text", async () => {
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.heroSlides.map((s) => s.id)).toEqual(HOME_CONTENT.hero.slides.map((s) => s.id));
    expect(data.heroSlides).toHaveLength(3);
    data.heroSlides.forEach((slide, i) => {
      expect(slide.image).toBe(HERO_SLIDE_ART[i] as (typeof HERO_SLIDE_ART)[number]);
      expect(slide.cta?.href === undefined || isAllowedInternalHref(slide.cta.href)).toBe(true);
    });
    expect(data.heroSlides[0]?.headline).toBe("Everyday essentials, all in one place");
    expect(data.sections.hero).toEqual({ id: "home-hero", label: HOME_CONTENT.hero.label });
  });

  test("a slide CTA that fails the allow-list is dropped, the slide stays", async () => {
    const [first, ...rest] = HOME_CONTENT.hero.slides;
    if (first === undefined) throw new Error("no slides");
    const content: HomeContent = {
      ...HOME_CONTENT,
      hero: { ...HOME_CONTENT.hero, slides: [{ ...first, cta: { label: "Bad", href: "https://evil.example" } }, ...rest] },
    };
    const data = await loadHomeData({ sessionId: null }, { ...createHomeDeps(db), content });
    expect(data.heroSlides).toHaveLength(3);
    expect(data.heroSlides[0]?.cta).toBeNull();
  });

  test("lifestyle sets: explore = 4 columns/4 cards, make-room = 3 columns/3 cards; category CTAs", async () => {
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.lifestyle.explore?.columns).toBe(4);
    expect(data.lifestyle.explore?.items).toHaveLength(4);
    expect(data.lifestyle.explore?.id).toBe("home-lifestyle-cards");
    expect(data.lifestyle.makeRoom?.columns).toBe(3);
    expect(data.lifestyle.makeRoom?.items).toHaveLength(3);
    for (const item of [...(data.lifestyle.explore?.items ?? []), ...(data.lifestyle.makeRoom?.items ?? [])]) {
      expect(item.cta.href).toMatch(/^\/category\//);
    }
  });

  test("invalid CTAs are dropped; a lifestyle set with < 2 valid cards, a bad banner and a broken pair are omitted", async () => {
    const bad = { label: "Bad", href: "//evil.example" };
    const content: HomeContent = {
      ...HOME_CONTENT,
      lifestyleExplore: {
        ...HOME_CONTENT.lifestyleExplore,
        items: HOME_CONTENT.lifestyleExplore.items.map((item, i) => (i === 0 ? item : { ...item, cta: bad })),
      },
      lifestyleMakeRoom: {
        ...HOME_CONTENT.lifestyleMakeRoom,
        items: HOME_CONTENT.lifestyleMakeRoom.items.map((item, i) => (i === 0 ? { ...item, cta: bad } : item)),
      },
      lifestyleBanner: { ...HOME_CONTENT.lifestyleBanner, cta: bad },
      promoPair: { ...HOME_CONTENT.promoPair, items: HOME_CONTENT.promoPair.items.map((p, i) => (i === 1 ? { ...p, cta: bad } : p)) },
    };
    const data = await loadHomeData({ sessionId: null }, { ...createHomeDeps(db), content });
    expect(data.lifestyle.explore).toBeNull();
    expect(data.lifestyle.makeRoom?.items).toHaveLength(2);
    expect(data.promos.lifestyleBanner).toBeNull();
    expect(data.promos.pair).toEqual([]);
  });

  test("promos: beauty split banner and the New arrivals / Top rated pair (contract H-19)", async () => {
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.promos.lifestyleBanner?.cta.href).toBe("/category/beauty-personal-care");
    expect(data.promos.lifestyleBanner?.imagePosition).toBe("start");
    expect(data.promos.pair.map((p) => [p.heading, p.cta.href])).toEqual([
      ["New arrivals", "/new-arrivals"],
      ["Top rated", "/top-rated"],
    ]);
  });

  test("popular searches: content terms as ChipRow search items (≤ 12), nav label from content", async () => {
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.popularSearches.id).toBe("home-popular-searches");
    expect(data.popularSearches.label).toBe(HOME_CONTENT.popularSearches.label);
    expect(data.popularSearches.items).toEqual(HOME_CONTENT.popularSearches.terms.map((query) => ({ query })));
    expect(data.popularSearches.items.length).toBeLessThanOrEqual(12);
  });

  test("services: ServicesBand overrides from content (tiles/notice stay the organism defaults)", async () => {
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.services).toEqual({ id: "home-services", heading: "Customer services", noticePlacement: "before" });
  });

  test("sections carry contract ids and titles", async () => {
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.sections.categories.sectionId).toBe("home-categories");
    expect(data.sections.discovery.sectionId).toBe("home-discovery");
    expect(data.sections.recentlyViewed.sectionId).toBe("home-recently-viewed");
    expect(data.sections.brands.title).toBe("Featured brands");
  });
});

describe("loadHomeData v3 (T165) — discovery categories", () => {
  test("seed: 6 child categories (never departments), each with products, top department's children first", async () => {
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    const found = data.discoveryCategories;
    expect(found).toHaveLength(DISCOVERY_LIMIT);
    const deptSlugs = new Set(data.departments.map((d) => d.slug));
    for (const c of found) {
      expect(deptSlugs.has(c.slug)).toBe(false);
      expect(c.productCount).toBeGreaterThan(0);
      expect(isAllowedInternalHref(`/category/${c.slug}`)).toBe(true);
    }
    expect(new Set(found.map((c) => c.slug)).size).toBe(found.length);
    const top = [...data.departments].sort((a, b) => b.productCount - a.productCount)[0];
    const tree = createHomeDeps(db).listing.categoryTree(Date.now());
    const topChildren = new Set(tree.find((d) => d.slug === top?.slug)?.children.filter((c) => c.productCount > 0).map((c) => c.slug));
    expect(found.slice(0, topChildren.size).every((c) => topChildren.has(c.slug))).toBe(true);
  });

  test("fake tree: departments by count, children by count, empty children skipped, capped at 6", async () => {
    const child = (slug: string, productCount: number) => ({
      id: slug, slug, name: slug.toUpperCase(), description: "", parentId: "x", sortOrder: 1, imageUrl: null, productCount,
    });
    const dept = (slug: string, children: ReturnType<typeof child>[]) => ({
      id: slug, slug, name: slug, description: "", parentId: null, sortOrder: 1, imageUrl: null, children,
    });
    const d = fakeDeps();
    const data = await loadHomeData(
      { sessionId: null },
      {
        ...d,
        listing: {
          ...d.listing,
          categoryTree: () => [
            dept("small", [child("s1", 1), child("s2", 0)]),
            dept("big", [child("b1", 2), child("b2", 9), child("b3", 4)]),
            dept("mid", [child("m1", 3), child("m2", 3), child("m3", 1), child("m4", 1)]),
          ],
        },
      },
    );
    expect(data.discoveryCategories.map((c) => c.slug)).toEqual(["b2", "b3", "b1", "m1", "m2", "m3"]);
  });

  test("categories reader failing empties departments and discovery only", async () => {
    const data = await loadHomeData({ sessionId: null }, { ...fakeDeps(), listing: { ...fakeDeps().listing, categoryTree: () => { throw new Error("x"); } } });
    expect(data.departments).toEqual([]);
    expect(data.discoveryCategories).toEqual([]);
    expect(data.topPicks).not.toBeNull();
  });
});

describe("loadHomeData v3 (T165) — top picks tabs", () => {
  const TAB_IDS = ["best-sellers", "deals", "new-arrivals", "top-rated"];

  test("tabs in contract H-14 order with /?rail=<id>#top-picks links; default falls back to Deals (Best sellers empty on a fresh seed)", async () => {
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    const picks = data.topPicks;
    expect(picks).not.toBeNull();
    expect(picks?.id).toBe("top-picks");
    expect(picks?.tabs.map((t) => [t.id, t.label, t.href])).toEqual([
      ["best-sellers", "Best sellers", "/?rail=best-sellers#top-picks"],
      ["deals", "Deals", "/?rail=deals#top-picks"],
      ["new-arrivals", "New arrivals", "/?rail=new-arrivals#top-picks"],
      ["top-rated", "Top rated", "/?rail=top-rated#top-picks"],
    ]);
    // T165 ruling: the content default (Best sellers) has no paid orders yet, so the first non-empty tab is shown.
    expect(picks?.activeId).toBe("deals");
    expect(picks?.products.length ?? 0).toBeGreaterThan(0);
    expect(picks?.seeAllHref).toBe("/deals");
    // An explicit ?rail=best-sellers still selects the empty tab (it keeps its link; the rail shows its status line).
    const explicit = await loadHomeData({ sessionId: null, rail: "best-sellers" }, createHomeDeps(db));
    expect(explicit.topPicks?.activeId).toBe("best-sellers");
    expect(explicit.topPicks?.products).toEqual([]);
    expect(explicit.topPicks?.seeAllHref).toBe("/best-sellers");
  });

  test("?rail=deals loads only the deals list (same products and order as the deals ItemList)", async () => {
    const data = await loadHomeData({ sessionId: null, rail: "deals" }, createHomeDeps(db));
    expect(data.topPicks?.activeId).toBe("deals");
    expect(data.topPicks?.products.map((p) => `https://shop.example.com/products/${encodeURIComponent(p.slug)}`)).toEqual(
      data.dealsJsonLd?.itemListElement.map((item) => item.url ?? "") ?? ["missing"],
    );
    expect(data.topPicks?.seeAllHref).toBe("/deals");
    const ids = data.topPicks?.products.map((p) => p.id) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(RAIL_LIMIT);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test.each(["new-arrivals", "top-rated"])("?rail=%s selects that tab", async (id) => {
    const data = await loadHomeData({ sessionId: null, rail: id }, createHomeDeps(db));
    expect(data.topPicks?.activeId).toBe(id);
    expect(data.topPicks?.products.length).toBeGreaterThan(0);
  });

  test.each([
    ["unknown", "x"],
    ["empty", ""],
    ["repeated", ["deals", "top-rated"]],
    ["prototype", "__proto__"],
    ["constructor", "constructor"],
    ["500 chars", "d".repeat(500)],
    ["case", "DEALS"],
    ["null", null],
    ["undefined", undefined],
  ] as const)("invalid rail (%s) falls back to the default tab without throwing", async (_name, raw) => {
    const data = await loadHomeData({ sessionId: null, rail: raw }, fakeDeps());
    expect(data.topPicks?.activeId).toBe("best-sellers");
    expect(data.topPicks?.tabs.map((t) => t.id)).toEqual(TAB_IDS);
  });

  test("only the active tab's reader output is returned; every product is capped and unique", async () => {
    const d = fakeDeps();
    const marked = (prefix: string) => Array.from({ length: 15 }, (_, i) => fakeProduct(i, { id: `${prefix}${i}`, slug: `${prefix}-${i}` }));
    const data = await loadHomeData(
      { sessionId: null, rail: "top-rated" },
      { ...d, listing: { ...d.listing, topRated: () => [...marked("t"), ...marked("t")], deals: () => marked("d") } },
    );
    const ids = data.topPicks?.products.map((p) => p.id) ?? [];
    expect(ids).toHaveLength(RAIL_LIMIT);
    expect(ids.every((id) => id.startsWith("t"))).toBe(true);
  });

  test("a failing tab reader drops its tab; the default moves to the first live tab", async () => {
    const d = fakeDeps();
    const logError = mock<(code: string) => void>(() => {});
    const broken: HomeDeps = { ...d, logError, listing: { ...d.listing, bestSellers: () => { throw new Error("x"); } } };
    const data = await loadHomeData({ sessionId: null, rail: "best-sellers" }, broken);
    expect(data.topPicks?.tabs.map((t) => t.id)).toEqual(["deals", "new-arrivals", "top-rated"]);
    expect(data.topPicks?.activeId).toBe("deals");
    expect(logError.mock.calls).toEqual([[homeReadErrorCode("bestSellers")]]);
  });

  test("every tab empty (or failed): topPicks is null", async () => {
    const d = fakeDeps();
    const empty = await loadHomeData(
      { sessionId: null },
      { ...d, listing: { ...d.listing, deals: () => [], bestSellers: () => [], newArrivals: () => [], topRated: () => [] } },
    );
    expect(empty.topPicks).toBeNull();
    const boom = (): never => { throw new Error("x"); };
    const failed = await loadHomeData(
      { sessionId: null },
      { ...d, listing: { ...d.listing, deals: boom, bestSellers: boom, newArrivals: boom, topRated: boom } },
    );
    expect(failed.topPicks).toBeNull();
    expect(failed.departments.length).toBeGreaterThan(0);
  });

  test("an empty selected tab keeps the section when another tab has products", async () => {
    const d = fakeDeps();
    const deps: HomeDeps = { ...d, listing: { ...d.listing, bestSellers: () => [] } };
    const data = await loadHomeData({ sessionId: null, rail: "best-sellers" }, deps);
    expect(data.topPicks?.activeId).toBe("best-sellers");
    expect(data.topPicks?.products).toEqual([]);
    expect(data.topPicks?.tabs).toHaveLength(4);
  });

  test("default tab (T165 ruling): an empty content default falls back to the first non-empty tab, for missing and invalid rail", async () => {
    const d = fakeDeps();
    const deps: HomeDeps = { ...d, listing: { ...d.listing, bestSellers: () => [], deals: () => [] } };
    for (const rail of [undefined, null, "x", "", "__proto__"]) {
      const data = await loadHomeData({ sessionId: null, rail }, deps);
      expect({ rail, activeId: data.topPicks?.activeId }).toEqual({ rail, activeId: "new-arrivals" });
      expect(data.topPicks?.products.length ?? 0).toBeGreaterThan(0);
      expect(data.topPicks?.tabs).toHaveLength(4);
    }
  });

  test("default tab: a non-empty content default wins over earlier tabs", async () => {
    const content: HomeContent = { ...HOME_CONTENT, topPicks: { ...HOME_CONTENT.topPicks, defaultTabId: "top-rated" } };
    const data = await loadHomeData({ sessionId: null }, { ...fakeDeps(), content });
    expect(data.topPicks?.activeId).toBe("top-rated");
  });
});

describe("loadHomeData v3 (T165) — free-shipping threshold", () => {
  test("seed: lowest active free-over threshold ($35) and the shipping promo names it", async () => {
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.freeShippingThresholdCents).toBe(3500);
    expect(data.promos.shipping?.heading).toBe("Free shipping on orders of $35 or more");
    expect(data.promos.shipping?.cta.href).toBe("/shipping");
    expect(data.promos.shipping?.heading).not.toContain("{amount}");
  });

  test("the lowest of several active thresholds wins; inactive methods are ignored", async () => {
    db.query("UPDATE shipping_methods SET free_over_cents = 2550 WHERE id = 'express'").run();
    db.query("UPDATE shipping_methods SET free_over_cents = 1000, is_active = 0 WHERE id = 'next_day'").run();
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.freeShippingThresholdCents).toBe(2550);
    expect(data.promos.shipping?.heading).toBe("Free shipping on orders of $25.50 or more");
  });

  test("no free-shipping method: threshold null and the shipping promo omitted", async () => {
    db.query("UPDATE shipping_methods SET free_over_cents = NULL").run();
    const data = await loadHomeData({ sessionId: null }, createHomeDeps(db));
    expect(data.freeShippingThresholdCents).toBeNull();
    expect(data.promos.shipping).toBeNull();
  });

  test("malformed thresholds are skipped (fake quotes)", async () => {
    const data = await loadHomeData(
      { sessionId: null },
      fakeDeps({ shipping: { listMethods: () => [shippingQuote("a", -5), shippingQuote("b", 1.5), shippingQuote("c", 0), shippingQuote("d", 4000, false), shippingQuote("e", 6000)] } }),
    );
    expect(data.freeShippingThresholdCents).toBe(6000);
  });

  test("shipping methods are listed with a 0 subtotal; the shipping reader is not a catalog reader", async () => {
    const listMethods = mock((subtotal: number): readonly ShippingQuote[] => (subtotal >= 0 ? [shippingQuote("s", 3500)] : []));
    await loadHomeData({ sessionId: null }, fakeDeps({ shipping: { listMethods } }));
    expect(listMethods.mock.calls).toEqual([[0]]);
    expect([...CATALOG_READERS]).toEqual(["deals", "bestSellers", "newArrivals", "topRated", "categories", "brands"]);
    expect(CATALOG_READERS).not.toContain("shipping");
  });

  test("a promo template without exactly one {amount} is omitted rather than shown broken", async () => {
    const content: HomeContent = { ...HOME_CONTENT, shippingPromo: { ...HOME_CONTENT.shippingPromo, heading: "Free shipping" } };
    const data = await loadHomeData({ sessionId: null }, { ...fakeDeps(), content });
    expect(data.freeShippingThresholdCents).toBe(3500);
    expect(data.promos.shipping).toBeNull();
  });

  test("formatShippingThreshold: whole dollars drop .00, cents kept, invalid → null", () => {
    expect(formatShippingThreshold(3500)).toBe("$35");
    expect(formatShippingThreshold(3550)).toBe("$35.50");
    expect(formatShippingThreshold(0)).toBeNull();
    expect(formatShippingThreshold(-1)).toBeNull();
    expect(formatShippingThreshold(1.5)).toBeNull();
    expect(formatShippingThreshold(1000, "NOPE")).toBeNull();
  });
});

describe("loadHomeData v3 (T165) — recently viewed", () => {
  test("no session: null and the reader is never called", async () => {
    const { deps, recentlyViewed } = spiedDeps();
    const data = await loadHomeData({ sessionId: null }, deps);
    expect(data.recentlyViewed).toBeNull();
    expect(recentlyViewed).not.toHaveBeenCalled();
  });

  test("owner-scoped, in stock only, content title and see-all, no owner key in the data", async () => {
    const [a, b, c] = productIds(3) as [string, string, string];
    const t = Date.now() - 60_000;
    view(SESSION, a, t);
    view(SESSION, b, t + 1);
    view(OTHER, c, t + 2);
    db.query("UPDATE products SET stock = 0 WHERE id = ?").run(b);
    const data = await loadHomeData({ sessionId: SESSION }, createHomeDeps(db));
    expect(data.recentlyViewed?.products.map((p) => p.id)).toEqual([a]);
    expect(data.recentlyViewed?.title).toBe(HOME_CONTENT.recentlyViewed.title);
    expect(data.recentlyViewed?.seeAllHref).toBe("/account/history");
    expect(JSON.stringify(data)).not.toMatch(UUID_RE);
  });

  test("a session with no views: null", async () => {
    const data = await loadHomeData({ sessionId: SESSION }, createHomeDeps(db));
    expect(data.recentlyViewed).toBeNull();
  });
});

describe("loadHomeData v3 (T165) — invariants", () => {
  test("read-only and no owner key in the full v3 object with every field populated", async () => {
    const before = totalChanges();
    const data = await loadHomeData({ sessionId: SESSION, rail: "deals" }, fakeDeps());
    expect(totalChanges()).toBe(before);
    expect(JSON.stringify(data)).not.toContain(SESSION);
    expect(data.recentlyViewed?.products.length).toBeGreaterThan(0);
  });

  test("now is read once: two catalog readers see the same value without an injected now", async () => {
    const d = fakeDeps();
    const seen: unknown[] = [];
    await loadHomeData(
      { sessionId: null },
      {
        ...d,
        listing: {
          ...d.listing,
          deals: (_l, now) => { seen.push(now); return []; },
          categoryTree: (now) => { seen.push(now); return []; },
        },
        brands: { listWithCounts: (now) => { seen.push(now); return []; } },
      },
    );
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(1);
    expect(typeof seen[0]).toBe("number");
  });

  test("every href in the v3 object passes isAllowedInternalHref", async () => {
    const data = await loadHomeData({ sessionId: SESSION }, createHomeDeps(db));
    const hrefs = [
      ...data.heroSlides.flatMap((s) => (s.cta ? [s.cta.href] : [])),
      ...(data.topPicks?.tabs.map((t) => t.href) ?? []),
      ...(data.promos.shipping ? [data.promos.shipping.cta.href] : []),
      ...(data.promos.lifestyleBanner ? [data.promos.lifestyleBanner.cta.href] : []),
      ...data.promos.pair.map((p) => p.cta.href),
      ...(data.lifestyle.explore?.items.map((i) => i.cta.href) ?? []),
      ...(data.lifestyle.makeRoom?.items.map((i) => i.cta.href) ?? []),
    ];
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) expect({ href, ok: isAllowedInternalHref(href) }).toEqual({ href, ok: true });
  });
});
