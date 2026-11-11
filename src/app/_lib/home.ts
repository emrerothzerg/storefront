import type { Database } from "bun:sqlite";
import { unstable_rethrow } from "next/navigation";

import type { ChipRowSearchItem } from "@/components/molecules/ChipRow/chip-row-helpers";
import type { HeroSlide } from "@/components/molecules/HeroBanner";
import type { HomeHeroDeal } from "@/components/organisms/HomeHero";
import type { LifestyleBannerItem } from "@/components/organisms/LifestyleBanners";
import { resolveRailTab, type ProductRailTab } from "@/components/organisms/ProductRail/rail-tabs";
import type { PromoBannerContent } from "@/components/organisms/PromoBanner";
import {
  HOME_AMOUNT_TOKEN,
  HOME_CONTENT,
  HOME_POPULAR_SEARCH_MAX,
  topPicksTabHref,
  type HomeContent,
  type HomeCta,
  type HomePromoCopy,
  type HomeSectionCopy,
  type HomeTopPicksSource,
} from "@/content/home";
import { isAllowedInternalHref } from "@/content/routes";
import { formatMoney, isValidCents } from "@/lib/money";
import { itemListJsonLd, type ItemListJsonLd } from "@/lib/seo/json-ld";
import type { Product } from "@/lib/types";
import { SqliteBrandRepository, type BrandRepository } from "@/server/catalog/brand-repository";
import { createListingService, getListingService, type ListingService } from "@/server/catalog/listing-service";
import { getDatabase } from "@/server/db/client";
import { createShippingService, getShippingService, type ShippingService } from "@/server/pricing/shipping-service";
import {
  createRecommendationService,
  getRecommendationService,
  type RecommendationService,
} from "@/server/recommendations/recommendation-service";
import { isSessionId } from "@/server/session/session-id";

import { freeShippingThreshold } from "../_layout/header-data";

/**
 * Home page data loader (T96, v3 T165). One call per render; every reader
 * runs inside one `Promise.all` and is isolated:
 *
 * - A failing reader calls `unstable_rethrow` first (Next control-flow errors
 *   are never swallowed), then logs a CODE only (never ids, input or the
 *   error object) and falls back to "empty", so its section is omitted and
 *   the rest of the page still renders.
 * - When EVERY catalog reader fails (the database is unusable) the loader
 *   throws, so the route renders `error.tsx` (500) instead of an empty shell
 *   (T96 criterion 4 / MVP "repository failure rejects").
 * - The session-dependent reader (recently viewed) runs only for a valid
 *   owner key; without one it is not called at all.
 * - Read-only: nothing here writes to the database or touches cookies.
 * - Privacy (R-1): the owner key is used only for lookups and never appears
 *   in the returned data.
 * - `now` is read once (or injected), passed to every time-dependent reader
 *   and returned as `data.now`, so the page renders cards with the same clock
 *   and reads none itself (FIX-card-now).
 *
 * v3 (T165): copy and configuration come from `src/content/home.ts`; the
 * loader adds the data-driven parts (hero slides, deal, departments, category
 * discovery, the top-picks tab selected by `?rail=`, recently viewed, promos
 * with the free-shipping threshold, lifestyle sets, popular searches, brands,
 * services). T166 removed the Phase 2 fields (`banner`, `rails`, `coupon`)
 * and the readers only they used (promoted coupon, inspired by, buy again):
 * the coupon lives in the header benefits strip, and the v3 home has no
 * inspired/buy-again rails (contract H-order).
 */

/** Max products per rail (and in the deals ItemList). */
export const RAIL_LIMIT = 12;

/** Category discovery tiles (contract H-13: up to 6). */
export const DISCOVERY_LIMIT = 6;

/** Fewer valid lifestyle cards than this omits the set (T154 AC2, `LIFESTYLE_BANNERS_MIN_ITEMS`). */
export const LIFESTYLE_MIN_ITEMS = 2;

/** Promo pair renders only with two valid promos (contract H-order 12). */
export const PROMO_PAIR_MIN_ITEMS = 2;

/** Store currency used to format the free-shipping threshold. */
export const HOME_CURRENCY = "USD";

/** Page title segment (the layout template appends the site name). */
export const HOME_TITLE = "Deals, best sellers and new arrivals";

export const DEPARTMENTS_TITLE = HOME_CONTENT.categories.title;
export const BRANDS_TITLE = HOME_CONTENT.brands.title;

export type HomeRailId = "deals" | "recently-viewed" | "best-sellers" | "new-arrivals" | "top-rated";

/** Rail titles (distinct, so every section heading/landmark name is unique). */
export const RAIL_TITLES: Readonly<Record<HomeRailId, string>> = {
  deals: "Today's Deals",
  "recently-viewed": HOME_CONTENT.recentlyViewed.title,
  "best-sellers": "Best Sellers",
  "new-arrivals": "New Arrivals",
  "top-rated": "Top Rated",
};

/**
 * Candidate "See all" targets. Each is checked with `isAllowedInternalHref`
 * at load time; a target that is not a planned route is dropped instead of
 * rendering a broken link (`/top-rated` exists since CONS-B1).
 */
export const RAIL_SEE_ALL: Readonly<Record<HomeRailId, string | null>> = {
  deals: "/deals",
  "recently-viewed": HOME_CONTENT.recentlyViewed.seeAllHref,
  "best-sellers": "/best-sellers",
  "new-arrivals": "/new-arrivals",
  "top-rated": "/top-rated",
};

/** Which rail (title/see-all) and which reader feed each top-picks source. */
const TOP_PICKS_RAIL: Readonly<Record<HomeTopPicksSource, HomeRailId>> = {
  bestSellers: "best-sellers",
  deals: "deals",
  newArrivals: "new-arrivals",
  topRated: "top-rated",
};

export interface HomeRail {
  readonly id: HomeRailId;
  readonly title: string;
  /** Present only when it passes `isAllowedInternalHref`. */
  readonly seeAllHref?: string;
  /** 1..RAIL_LIMIT products, each with an allowed PDP href. */
  readonly products: readonly Product[];
}

export interface HomeDepartment {
  readonly slug: string;
  readonly name: string;
  readonly imageUrl: string | null;
  /** Published products in the department's categories (> 0). */
  readonly productCount: number;
}

/** A child category for the discovery rail (`/category/<slug>`). */
export interface HomeDiscoveryCategory {
  readonly slug: string;
  readonly name: string;
  /** Published products (> 0). */
  readonly productCount: number;
}

export interface HomeBrand {
  readonly slug: string;
  readonly name: string;
}

/** "Top picks" tabbed rail (contract H-14..H-16). Only the active tab's products are loaded into the page. */
export interface HomeTopPicks {
  readonly id: string;
  readonly title: string;
  readonly eyebrow: string;
  readonly tabsLabel: string;
  /** Tabs whose reader succeeded, in content order; each links `/?rail=<id>#top-picks`. */
  readonly tabs: readonly ProductRailTab[];
  /**
   * `?rail=` resolved with `resolveRailTab` against `tabs`. Default (missing or
   * invalid `rail`): the content default when it has products, else the first
   * tab with products (T165 ruling), else the content default / first tab.
   */
  readonly activeId: string;
  /** 0..RAIL_LIMIT products of the active tab (an empty tab keeps its link; the rail shows its status line). */
  readonly products: readonly Product[];
  /** Listing page of the active tab, when allowed. */
  readonly seeAllHref?: string;
}

export interface HomePromos {
  /** Shipping promo with the threshold in its heading; null when there is no free-shipping threshold. */
  readonly shipping: (PromoBannerContent & { readonly id: string }) | null;
  /** Split lifestyle (beauty) banner; null when its CTA is not allowed. */
  readonly lifestyleBanner: (PromoBannerContent & { readonly id: string }) | null;
  /** Exactly two promos, or empty (the pair is then omitted). */
  readonly pair: readonly PromoBannerContent[];
}

export interface HomeLifestyleSet {
  readonly id: string;
  readonly heading: string;
  readonly eyebrow: string;
  readonly columns: 3 | 4;
  /** At least `LIFESTYLE_MIN_ITEMS` cards with allowed CTAs. */
  readonly items: readonly LifestyleBannerItem[];
}

export interface HomeLifestyle {
  /** 4-column "explore" set (`#home-lifestyle-cards`); null when fewer than 2 valid cards. */
  readonly explore: HomeLifestyleSet | null;
  /** 3-column "make room" set; null when fewer than 2 valid cards. */
  readonly makeRoom: HomeLifestyleSet | null;
}

export interface HomePopularSearches {
  readonly id: string;
  readonly label: string;
  /** ChipRow search chips (`/search?q=`); empty omits the section. */
  readonly items: readonly ChipRowSearchItem[];
}

/** ServicesBand overrides; tiles and notice are the organism defaults. */
export interface HomeServices {
  readonly id: string;
  readonly heading: string;
  readonly noticePlacement: "before" | "after";
}

/** Section ids, titles and eyebrows for sections whose data is a plain list. */
export interface HomeSections {
  readonly hero: { readonly id: string; readonly label: string };
  readonly categories: HomeSectionCopy;
  readonly discovery: HomeSectionCopy;
  readonly recentlyViewed: HomeSectionCopy;
  readonly brands: HomeSectionCopy;
}

export interface HomeData {
  /** v3 hero slides (≤ 3) from content; CTAs that fail the allow-list are dropped (the slide stays). */
  readonly heroSlides: readonly HeroSlide[];
  readonly deal: HomeHeroDeal | null;
  /** Departments with published products, taxonomy order (category rail). */
  readonly departments: readonly HomeDepartment[];
  /** Up to `DISCOVERY_LIMIT` child categories, departments by product count first. */
  readonly discoveryCategories: readonly HomeDiscoveryCategory[];
  /** Null when every tab reader failed or every tab is empty (section omitted). */
  readonly topPicks: HomeTopPicks | null;
  /** Owner-scoped, in stock only; null without a session or views. */
  readonly recentlyViewed: HomeRail | null;
  readonly promos: HomePromos;
  readonly lifestyle: HomeLifestyle;
  readonly popularSearches: HomePopularSearches;
  readonly brands: readonly HomeBrand[];
  readonly services: HomeServices;
  /** Lowest active free-shipping threshold (minor units), null when none or unreadable. */
  readonly freeShippingThresholdCents: number | null;
  readonly sections: HomeSections;
  /** ItemList of the deals rail; null when there are no deals. */
  readonly dealsJsonLd: ItemListJsonLd | null;
  /** The request clock (epoch ms) read once here; the page renders cards with `new Date(now)` and reads no clock. */
  readonly now: number;
}

/** Readers the loader needs; tests build them over a `:memory:` DB or fake them. */
export interface HomeDeps {
  readonly listing: Pick<ListingService, "deals" | "bestSellers" | "newArrivals" | "topRated" | "categoryTree">;
  readonly brands: Pick<BrandRepository, "listWithCounts">;
  readonly shipping: Pick<ShippingService, "listMethods">;
  readonly recommendations: Pick<RecommendationService, "recentlyViewed">;
  /** Receives a code only (e.g. `home.read_failed.deals`). Default: `console.error`. */
  readonly logError?: (code: string) => void;
  /** Content override (tests). Defaults to `HOME_CONTENT`. */
  readonly content?: HomeContent;
}

/** Deps over an explicit database (tests). */
export function createHomeDeps(db: Database, options: { now?: () => number } = {}): HomeDeps {
  return {
    listing: createListingService({ db }),
    brands: new SqliteBrandRepository(db),
    shipping: createShippingService({ db }),
    recommendations: createRecommendationService(options.now === undefined ? { db } : { db, now: options.now }),
  };
}

/** App deps: the shared database and the service singletons. */
export function defaultHomeDeps(): HomeDeps {
  return {
    listing: getListingService(),
    brands: new SqliteBrandRepository(getDatabase()),
    shipping: getShippingService(),
    recommendations: getRecommendationService(),
  };
}

export interface HomeLoadInput {
  /** Owner key from `readSessionId()`; `null` (or anything not a UUID v4) = no session. */
  readonly sessionId: string | null;
  /** Epoch ms for publication/expiry checks. Defaults to the request time, read here (not in render). */
  readonly now?: number;
  /** Raw `searchParams.rail` (unvalidated); resolved with `resolveRailTab`. */
  readonly rail?: string | readonly string[] | null;
}

export type HomeReader =
  | "deals"
  | "bestSellers"
  | "newArrivals"
  | "topRated"
  | "categories"
  | "brands"
  | "shipping"
  | "recentlyViewed";

/** Readers whose joint failure means the database is unusable (personal and shipping readers excluded). */
export const CATALOG_READERS: readonly HomeReader[] = [
  "deals",
  "bestSellers",
  "newArrivals",
  "topRated",
  "categories",
  "brands",
];

export function homeReadErrorCode(reader: HomeReader): string {
  return `home.read_failed.${reader}`;
}

/** Thrown when every catalog reader failed; `cause` is the first failure. */
export class HomeDataUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Home page data is unavailable", { cause });
    this.name = "HomeDataUnavailableError";
  }
}

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

async function attempt<T>(read: () => T): Promise<Outcome<T>> {
  try {
    return { ok: true, value: read() };
  } catch (error: unknown) {
    unstable_rethrow(error);
    return { ok: false, error };
  }
}

const SKIPPED: Promise<Outcome<never[]>> = Promise.resolve({ ok: true, value: [] });

/** `/products/<slug>` when it passes `isAllowedInternalHref`, else null. */
export function productHref(product: Pick<Product, "slug">): string | null {
  if (typeof product.slug !== "string" || product.slug === "") return null;
  const href = `/products/${encodeURIComponent(product.slug)}`;
  return isAllowedInternalHref(href) ? href : null;
}

function railProducts(products: readonly Product[], options: { inStockOnly: boolean }): Product[] {
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const product of products) {
    if (out.length >= RAIL_LIMIT) break;
    if (seen.has(product.id) || productHref(product) === null) continue;
    if (options.inStockOnly && !(product.stock > 0)) continue;
    seen.add(product.id);
    out.push(product);
  }
  return out;
}

function seeAllFor(id: HomeRailId): string | undefined {
  const href = RAIL_SEE_ALL[id];
  return href !== null && isAllowedInternalHref(href) ? href : undefined;
}

function toDeal(product: Product | undefined): HomeHeroDeal | null {
  if (product === undefined) return null;
  const href = productHref(product);
  if (href === null) return null;
  return {
    title: product.name,
    priceCents: product.priceCents,
    listPriceCents: product.listPriceCents ?? null,
    currency: product.currency,
    href,
    imageUrl: product.imageUrl,
  };
}

type CategoryTree = ReturnType<ListingService["categoryTree"]>;

function positiveCount(count: number): number {
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function toDepartments(tree: CategoryTree): HomeDepartment[] {
  const out: HomeDepartment[] = [];
  for (const dept of tree) {
    const productCount = dept.children.reduce((sum, child) => sum + positiveCount(child.productCount), 0);
    if (productCount === 0) continue;
    out.push({ slug: dept.slug, name: dept.name, imageUrl: dept.imageUrl, productCount });
  }
  return out;
}

function categoryHrefAllowed(slug: string): boolean {
  return typeof slug === "string" && slug !== "" && isAllowedInternalHref(`/category/${encodeURIComponent(slug)}`);
}

/**
 * Child categories with published products: departments ordered by product
 * count (desc, stable), then each department's children by count (desc,
 * stable), de-duplicated by slug, capped at `DISCOVERY_LIMIT`.
 */
export function toDiscoveryCategories(tree: CategoryTree): HomeDiscoveryCategory[] {
  const byCountDesc = <T>(items: readonly T[], count: (item: T) => number): T[] =>
    items
      .map((item, index) => ({ item, index, n: count(item) }))
      .sort((a, b) => b.n - a.n || a.index - b.index)
      .map((entry) => entry.item);

  const departments = byCountDesc(tree, (dept) => dept.children.reduce((sum, c) => sum + positiveCount(c.productCount), 0));
  const seen = new Set<string>();
  const out: HomeDiscoveryCategory[] = [];
  for (const dept of departments) {
    for (const child of byCountDesc(dept.children, (c) => positiveCount(c.productCount))) {
      if (out.length >= DISCOVERY_LIMIT) return out;
      const productCount = positiveCount(child.productCount);
      if (productCount === 0 || seen.has(child.slug) || !categoryHrefAllowed(child.slug)) continue;
      seen.add(child.slug);
      out.push({ slug: child.slug, name: child.name, productCount });
    }
  }
  return out;
}

function toDealsJsonLd(products: readonly Product[]): ItemListJsonLd | null {
  const entries: { path: string; name: string }[] = [];
  for (const product of products) {
    const href = productHref(product);
    if (href !== null) entries.push({ path: href, name: product.name });
  }
  return entries.length === 0 ? null : itemListJsonLd(entries);
}

/**
 * "$35" for 3500 USD ("$35.50" keeps its cents), matching the header strip.
 * Null for an invalid amount or currency. Never throws.
 */
export function formatShippingThreshold(cents: number, currency: string = HOME_CURRENCY): string | null {
  if (!isValidCents(cents) || cents <= 0) return null;
  try {
    const formatted = formatMoney(cents, currency);
    return cents % 100 === 0 ? formatted.replace(/\.00$/, "") : formatted;
  } catch {
    return null;
  }
}

function allowedCta(cta: HomeCta): HomeCta | null {
  return cta.label.trim() !== "" && isAllowedInternalHref(cta.href) ? cta : null;
}

function toPromo(copy: HomePromoCopy, heading: string = copy.heading): (PromoBannerContent & { id: string }) | null {
  const cta = allowedCta(copy.cta);
  if (cta === null || heading.trim() === "") return null;
  return {
    id: copy.id,
    heading,
    blurb: copy.blurb,
    cta: { label: cta.label, href: cta.href },
    image: copy.image,
    imagePosition: copy.imagePosition,
    tone: copy.tone,
  };
}

function toShippingPromo(content: HomeContent, thresholdCents: number | null): HomePromos["shipping"] {
  if (thresholdCents === null) return null;
  const amount = formatShippingThreshold(thresholdCents);
  const template = content.shippingPromo.heading;
  if (amount === null || template.split(HOME_AMOUNT_TOKEN).length !== 2) return null;
  return toPromo(content.shippingPromo, template.replace(HOME_AMOUNT_TOKEN, amount));
}

function toLifestyleSet(set: HomeContent["lifestyleExplore"]): HomeLifestyleSet | null {
  const items: LifestyleBannerItem[] = [];
  for (const card of set.items) {
    const cta = allowedCta(card.cta);
    if (cta === null) continue;
    items.push({ heading: card.heading, blurb: card.blurb, cta: { label: cta.label, href: cta.href }, image: card.image });
  }
  if (items.length < LIFESTYLE_MIN_ITEMS) return null;
  return { id: set.sectionId, heading: set.heading, eyebrow: set.eyebrow, columns: set.columns, items: items.slice(0, set.columns) };
}

function toHeroSlides(content: HomeContent): HeroSlide[] {
  return content.hero.slides.slice(0, 3).map((slide) => ({
    id: slide.id,
    headline: slide.headline,
    subline: slide.subline,
    cta: allowedCta(slide.cta),
    image: slide.image,
    tone: slide.tone,
  }));
}

function toPopularSearches(content: HomeContent): HomePopularSearches {
  const items: ChipRowSearchItem[] = [];
  for (const term of content.popularSearches.terms) {
    const query = term.trim();
    if (query !== "" && isAllowedInternalHref(`/search?q=${encodeURIComponent(query)}`)) items.push({ query });
  }
  return {
    id: content.popularSearches.sectionId,
    label: content.popularSearches.label,
    items: items.slice(0, HOME_POPULAR_SEARCH_MAX),
  };
}

export async function loadHomeData(input: HomeLoadInput, deps: HomeDeps = defaultHomeDeps()): Promise<HomeData> {
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const ownerKey = isSessionId(input.sessionId) ? input.sessionId : null;
  const content = deps.content ?? HOME_CONTENT;
  const reco = { limit: RAIL_LIMIT, now };

  const [
    deals,
    bestSellers,
    newArrivals,
    topRated,
    categories,
    brands,
    shipping,
    recentlyViewed,
  ] = await Promise.all([
    attempt(() => deps.listing.deals(RAIL_LIMIT, now)),
    attempt(() => deps.listing.bestSellers(RAIL_LIMIT, { now })),
    attempt(() => deps.listing.newArrivals(RAIL_LIMIT, now)),
    attempt(() => deps.listing.topRated(RAIL_LIMIT, now)),
    attempt(() => deps.listing.categoryTree(now)),
    attempt(() => deps.brands.listWithCounts(now)),
    attempt(() => freeShippingThreshold(deps.shipping.listMethods(0).map((quote) => quote.method))),
    ownerKey === null ? SKIPPED : attempt(() => deps.recommendations.recentlyViewed(ownerKey, reco)),
  ]);

  const outcomes: Readonly<Record<HomeReader, Outcome<unknown>>> = {
    deals,
    bestSellers,
    newArrivals,
    topRated,
    categories,
    brands,
    shipping,
    recentlyViewed,
  };

  const catalogFailures = CATALOG_READERS.map((reader) => outcomes[reader]).filter((o) => !o.ok);
  if (catalogFailures.length === CATALOG_READERS.length) {
    const first = catalogFailures[0];
    throw new HomeDataUnavailableError(first !== undefined && !first.ok ? first.error : undefined);
  }

  const logError = deps.logError ?? ((code: string) => console.error(`[home] ${code}`));
  for (const reader of Object.keys(outcomes) as HomeReader[]) {
    if (!outcomes[reader].ok) logError(homeReadErrorCode(reader));
  }

  function valueOf<T>(outcome: Outcome<T>, fallback: T): T {
    return outcome.ok ? outcome.value : fallback;
  }

  const dealProducts = railProducts(valueOf(deals, []), { inStockOnly: false });
  const recent = railProducts(valueOf(recentlyViewed, []), { inStockOnly: true });

  const railData: Readonly<Record<HomeRailId, Product[]>> = {
    deals: dealProducts,
    "recently-viewed": recent,
    "best-sellers": railProducts(valueOf(bestSellers, []), { inStockOnly: false }),
    "new-arrivals": railProducts(valueOf(newArrivals, []), { inStockOnly: false }),
    "top-rated": railProducts(valueOf(topRated, []), { inStockOnly: false }),
  };

  function railFor(id: HomeRailId): HomeRail | null {
    const products = railData[id];
    if (products.length === 0) return null;
    const seeAllHref = seeAllFor(id);
    const title = id === "recently-viewed" ? content.recentlyViewed.title : RAIL_TITLES[id];
    return { id, title, products, ...(seeAllHref === undefined ? {} : { seeAllHref }) };
  }

  // Top picks: a tab whose reader failed is dropped; an empty tab keeps its link.
  const sourceOutcomes: Readonly<Record<HomeTopPicksSource, Outcome<unknown>>> = { bestSellers, deals, newArrivals, topRated };
  const liveTabs = content.topPicks.tabs.filter((tab) => sourceOutcomes[tab.source].ok);
  const tabs: ProductRailTab[] = liveTabs.map((tab) => ({ id: tab.id, label: tab.label, href: topPicksTabHref(tab.id) }));
  const tabIds = tabs.map((tab) => tab.id);
  const tabHasProducts = (tab: (typeof liveTabs)[number]): boolean => railData[TOP_PICKS_RAIL[tab.source]].length > 0;
  // Default tab (T165 ruling): the content default when it has products, else the first non-empty tab.
  const contentDefault = liveTabs.find((tab) => tab.id === content.topPicks.defaultTabId);
  const firstNonEmpty = liveTabs.find(tabHasProducts);
  const defaultTabId =
    contentDefault !== undefined && tabHasProducts(contentDefault)
      ? contentDefault.id
      : (firstNonEmpty?.id ?? contentDefault?.id ?? tabIds[0] ?? "");
  const activeId = resolveRailTab(input.rail, tabIds, defaultTabId);
  const activeTab = liveTabs.find((tab) => tab.id === activeId);
  const anyTabHasProducts = firstNonEmpty !== undefined;
  let topPicks: HomeTopPicks | null = null;
  if (activeTab !== undefined && anyTabHasProducts) {
    const railId = TOP_PICKS_RAIL[activeTab.source];
    const seeAllHref = seeAllFor(railId);
    topPicks = {
      id: content.topPicks.sectionId,
      title: content.topPicks.title,
      eyebrow: content.topPicks.eyebrow,
      tabsLabel: content.topPicks.tabsLabel,
      tabs,
      activeId,
      products: railData[railId],
      ...(seeAllHref === undefined ? {} : { seeAllHref }),
    };
  }

  const freeShippingThresholdCents = valueOf(shipping, null);
  const pair = content.promoPair.items
    .map((item) => toPromo(item))
    .filter((promo): promo is PromoBannerContent & { id: string } => promo !== null)
    .slice(0, PROMO_PAIR_MIN_ITEMS);

  const categoryTree = valueOf(categories, []);

  return {
    heroSlides: toHeroSlides(content),
    deal: toDeal(dealProducts[0]),
    departments: toDepartments(categoryTree),
    discoveryCategories: toDiscoveryCategories(categoryTree),
    topPicks,
    recentlyViewed: railFor("recently-viewed"),
    promos: {
      shipping: toShippingPromo(content, freeShippingThresholdCents),
      lifestyleBanner: toPromo(content.lifestyleBanner),
      pair: pair.length < PROMO_PAIR_MIN_ITEMS ? [] : pair,
    },
    lifestyle: { explore: toLifestyleSet(content.lifestyleExplore), makeRoom: toLifestyleSet(content.lifestyleMakeRoom) },
    popularSearches: toPopularSearches(content),
    brands: valueOf(brands, [])
      .filter((brand) => brand.productCount > 0)
      .map((brand) => ({ slug: brand.slug, name: brand.name })),
    services: {
      id: content.services.sectionId,
      heading: content.services.heading,
      noticePlacement: content.services.noticePlacement,
    },
    freeShippingThresholdCents,
    sections: {
      hero: { id: content.hero.sectionId, label: content.hero.label },
      categories: content.categories,
      discovery: content.discovery,
      recentlyViewed: content.recentlyViewed,
      brands: content.brands,
    },
    dealsJsonLd: toDealsJsonLd(dealProducts),
    now,
  };
}
