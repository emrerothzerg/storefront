import type { Database } from "bun:sqlite";
import type { Metadata } from "next";

import type {
  ListingTemplateBreadcrumbItem,
  ListingTemplateFeedback,
  ListingTemplateResult,
} from "@/components/templates/ListingTemplate";
import type { ActiveFilterLabels } from "@/components/molecules/ActiveFilters";
import type { ChipRowLinkItem } from "@/components/molecules/ChipRow";
import type { FeedbackSuggestion } from "@/components/molecules/FeedbackBlock";
import { hasActiveFilters, type ListingParams } from "@/components/molecules/_listing-url";
import type { ProductGridCardExtras, ProductGridPromoSlot } from "@/components/organisms/ProductGrid";
import { LISTING_FEEDBACK_SUGGESTIONS, LISTING_PROMOS, type ListingPromoCopy } from "@/content/listing-promos";
import { isAllowedInternalHref } from "@/content/routes";
import {
  breadcrumbListJsonLd,
  itemListJsonLd,
  type BreadcrumbListJsonLd,
  type ItemListJsonLd,
} from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { absoluteUrl } from "@/lib/seo/site";
import { SqliteBrandRepository, type BrandRepository } from "@/server/catalog/brand-repository";
import {
  createListingService,
  getListingService,
  type FacetCounts,
  type ListingResult,
  type ListingService,
  type ListingSort,
} from "@/server/catalog/listing-service";
import { createSearchService, getSearchService, type SearchService } from "@/server/catalog/search-service";
import { getDatabase } from "@/server/db/client";
import type { BrandWithCount } from "@/lib/types";

import {
  buildListingUrl,
  canonicalListingUrl,
  isFacetedListing,
  paginationRel,
  parseListingParams,
  toListingQuery,
} from "./parse-params";

/**
 * Shared loader for the nine listing routes (T105 /search, T106
 * /category/[slug] + /brand/[slug], T107 /products, /deals, /best-sellers,
 * /new-arrivals, CONS-B1 /top-rated). Pure server code, no `next/*` runtime
 * imports, no cookies, no writes. Each request:
 *
 *   searchParams -> parseListingParams -> route normalisation
 *     -> unknown category/dept slugs dropped (slug lookup)
 *     -> toListingQuery -> exactly ONE listing.list() call -> template props
 *
 * The template receives `params` and `facets` from that same call (T91
 * page-parser rule). `q` is a /search-only parameter: other routes drop it
 * (`allowQuery`). Each route declares its default sort (`defaultSort`;
 * absent = `featured`, or `relevance` with a query on /search) and only that
 * value is omitted from its URLs. `now` is read once per request by the
 * route loader and passed down.
 */

/** Products per listing page (matches the listing service default). */
export const LISTING_PAGE_SIZE = 24;
/** Max entries in the ItemList JSON-LD (T106 AC4). */
export const ITEM_LIST_MAX = 24;
/** `robots` for faceted / search pages: keep links crawlable, keep the URL out of the index. */
export const NOINDEX_FOLLOW = { index: false, follow: true } as const;

export interface ListingPageDeps {
  readonly listing: Pick<ListingService, "list" | "categoryTree" | "breadcrumb" | "bestSellers">;
  readonly search: Pick<SearchService, "search">;
  readonly brands: Pick<BrandRepository, "getBySlug" | "listWithCounts">;
  /** Epoch ms; called once per request by the route loaders. */
  readonly now: () => number;
}

/** Deps over an explicit database (tests use a seeded `:memory:` DB). */
export function createListingPageDeps(db: Database, now: () => number = Date.now): ListingPageDeps {
  return {
    listing: createListingService({ db }),
    search: createSearchService({ db, now }),
    brands: new SqliteBrandRepository(db),
    now,
  };
}

/** App deps: the cached service singletons over `getDatabase()`. */
export function getListingPageDeps(): ListingPageDeps {
  return {
    listing: getListingService(),
    search: getSearchService(),
    brands: new SqliteBrandRepository(getDatabase()),
    now: Date.now,
  };
}

/** Thrown when the single `list()` call fails (renders error.tsx, 500). */
export class ListingUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`Listing unavailable (${code})`);
    this.name = "ListingUnavailableError";
  }
}

export interface ListingRouteConfig {
  /** Literal route path, e.g. "/deals" or `/category/${slug}`. */
  readonly base: string;
  /**
   * Keep the URL's `q` (only /search sets this). Every other listing route
   * drops `q` from params, links and canonical: it does not filter there
   * (D-T107-1).
   */
  readonly allowQuery?: boolean;
  /**
   * Route default sort when the URL has none (/best-sellers `best_selling`,
   * /new-arrivals `newest`, /top-rated `rating`). Absent = `featured` (or
   * `relevance` with a query on /search). Only this value is omitted from
   * the route's URLs and counts as "not re-sorted" (D-T107-2).
   */
  readonly defaultSort?: ListingSort;
  /** Route category scope (/category/[slug]). */
  readonly categorySlug?: string;
  /** Route brand scope (/brand/[slug]); the URL's `brand` param is dropped. */
  readonly brandSlug?: string;
  /** Forces discounted products only (/deals); the URL's `deals` param is dropped. */
  readonly dealsOnly?: boolean;
  /** Search result ids (relevance order). */
  readonly ids?: readonly string[];
}

/** Copy of `params` without `keys` (the parser's object is never mutated). */
export function withoutParams(params: ListingParams, keys: readonly (keyof ListingParams)[]): ListingParams {
  const next: ListingParams = { ...params };
  for (const key of keys) delete next[key];
  return next;
}

/**
 * Route-level normalisation on top of the shared parser: params that the
 * route already implies are dropped so they neither duplicate the scope nor
 * mark the page as faceted (a redundant `sort=best_selling` on /best-sellers,
 * `deals=1` on /deals, `brand=` on a brand page), and `q` is dropped on every
 * route without `allowQuery` (it would not filter there).
 */
export function normaliseRouteParams(params: ListingParams, config: ListingRouteConfig): ListingParams {
  const drop: (keyof ListingParams)[] = [];
  if (config.allowQuery !== true && params.q !== undefined) drop.push("q");
  if (config.defaultSort !== undefined && params.sort === config.defaultSort) drop.push("sort");
  if (config.dealsOnly === true && params.deals === true) drop.push("deals");
  if (config.brandSlug !== undefined && params.brand !== undefined) drop.push("brand");
  return drop.length === 0 ? params : withoutParams(params, drop);
}

/**
 * True when the URL narrows or re-orders the route's canonical list: any
 * facet, `dept`, or a sort that differs from the ROUTE default (e.g.
 * `sort=featured` on /best-sellers). Same rule as `buildListingHref`'s sort
 * omission: the sort it keeps in a URL is exactly the one that counts here.
 */
export function isFacetedForRoute(params: ListingParams, defaultSort?: ListingSort): boolean {
  return isFacetedListing(params, defaultSort !== undefined ? { defaultSort } : {});
}

export interface ListingSeo {
  /** Root-relative canonical path (pass to `buildMetadata({ path })`). */
  readonly canonicalPath: string;
  readonly faceted: boolean;
}

/**
 * Canonical rules (T106 AC2): plain page 1 -> base; plain page N -> itself;
 * faceted / re-sorted -> page-1 base (q kept). Search pages drop `page` too
 * (`dropPage`: canonical is `/search?q=<q>`).
 */
export function listingSeo(
  base: string,
  params: ListingParams,
  opts: { readonly defaultSort?: ListingSort; readonly dropPage?: boolean } = {},
): ListingSeo {
  const faceted = isFacetedForRoute(params, opts.defaultSort);
  const qOnly: ListingParams = params.q !== undefined ? { q: params.q } : {};
  const canonicalPath =
    faceted || opts.dropPage === true
      ? buildListingUrl(base, qOnly)
      : canonicalListingUrl(base, params, opts.defaultSort !== undefined ? { defaultSort: opts.defaultSort } : {});
  return { canonicalPath, faceted };
}

export interface ListingMetadataInput {
  readonly title: string;
  readonly description: string;
  readonly base: string;
  readonly params: ListingParams;
  readonly defaultSort?: ListingSort;
  /** Always `noindex, follow` (search). */
  readonly noindex?: boolean;
  readonly dropPage?: boolean;
}

/** `buildMetadata` + listing canonical + `robots: noindex, follow` for faceted (or forced) URLs. */
export function listingMetadata(input: ListingMetadataInput): Metadata {
  const seo = listingSeo(input.base, input.params, { defaultSort: input.defaultSort, dropPage: input.dropPage });
  const page = input.params.page ?? 1;
  const title = page > 1 && !seo.faceted && input.noindex !== true ? `${input.title} (page ${page})` : input.title;
  const metadata = buildMetadata({ title, description: input.description, path: seo.canonicalPath });
  if (seo.faceted || input.noindex === true) metadata.robots = { ...NOINDEX_FOLLOW };
  return metadata;
}

/** Meta description bounds (T112 metadata audit). */
export const META_DESCRIPTION_MIN = 70;
export const META_DESCRIPTION_MAX = 160;

/** Cuts `text` to at most `max` characters at a word boundary, ending with "…". */
function clipWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/u, "")}…`;
}

/**
 * Meta description from an entity's own copy (`lead`, e.g. a category or
 * brand description) plus store-context sentences: each context sentence is
 * appended while the result stays within 160 characters, and the result is
 * guaranteed 70-160 characters when the contexts can reach 70 (a lead over
 * 160 is clipped at a word boundary). Whitespace is collapsed.
 */
export function composeMetaDescription(lead: string, contexts: readonly string[]): string {
  const norm = (t: string) => t.replace(/\s+/gu, " ").trim();
  let out = clipWords(norm(lead), META_DESCRIPTION_MAX);
  for (const raw of contexts) {
    const sentence = norm(raw);
    if (sentence === "") continue;
    const next = out === "" ? sentence : `${out} ${sentence}`;
    if (next.length <= META_DESCRIPTION_MAX) out = next;
    else if (out.length < META_DESCRIPTION_MIN) out = clipWords(next, META_DESCRIPTION_MAX);
  }
  return out;
}

/**
 * Absolute `rel=prev/next` hrefs (filters and a non-default sort preserved;
 * React 19 hoists `<link>` into `<head>`). Pass the route `defaultSort`.
 */
export function listingRelLinks(
  base: string,
  params: ListingParams,
  pageCount: number,
  defaultSort?: ListingSort,
): { readonly prev?: string; readonly next?: string } {
  const rel = paginationRel(base, params, pageCount, defaultSort !== undefined ? { defaultSort } : {});
  return {
    ...(rel.prev !== undefined ? { prev: absoluteUrl(rel.prev) } : {}),
    ...(rel.next !== undefined ? { next: absoluteUrl(rel.next) } : {}),
  };
}

export interface LoadedListing {
  /** Params the query was built from (unknown `category`/`dept` slugs already dropped). */
  readonly params: ListingParams;
  readonly result: ListingResult;
  /** URL keys whose slug named no category and were dropped before the call. */
  readonly dropped: readonly ("category" | "dept")[];
}

/**
 * Drops a URL `category` / `dept` slug that names no category, checked with
 * one cheap slug lookup each (`breadcrumb(slug)` is `[]` for an unknown
 * slug, the same `getBySlug` test `list()` uses for NOT_FOUND). Route scopes
 * (`categorySlug`) are validated by the route itself.
 */
export function dropUnknownCategorySlugs(
  deps: Pick<ListingPageDeps["listing"], "breadcrumb">,
  params: ListingParams,
): { readonly params: ListingParams; readonly dropped: readonly ("category" | "dept")[] } {
  const dropped: ("category" | "dept")[] = [];
  for (const key of ["category", "dept"] as const) {
    const slug = params[key];
    if (slug !== undefined && deps.breadcrumb(slug).length === 0) dropped.push(key);
  }
  return { params: dropped.length === 0 ? params : withoutParams(params, dropped), dropped };
}

/**
 * Exactly one `list()` call for `params` under the route config. Unknown
 * `category`/`dept` URL slugs are dropped BEFORE the call
 * (`dropUnknownCategorySlugs`, T105 AC5 / T107 AC3 / D-T105-1); any failure
 * of the call throws `ListingUnavailableError`. Route scopes (`categorySlug`,
 * `brandSlug`) must be validated by the caller.
 */
export function loadListing(
  deps: { readonly listing: Pick<ListingPageDeps["listing"], "list" | "breadcrumb"> },
  params: ListingParams,
  config: ListingRouteConfig,
  now: number,
): LoadedListing {
  const checked = dropUnknownCategorySlugs(deps.listing, params);
  const query = toListingQuery(checked.params, {
    ...(config.categorySlug !== undefined ? { categorySlug: config.categorySlug } : {}),
    ...(config.defaultSort !== undefined ? { defaultSort: config.defaultSort } : {}),
    ...(config.ids !== undefined ? { ids: config.ids } : {}),
    ...(config.dealsOnly === true ? { dealsOnly: true } : {}),
    pageSize: LISTING_PAGE_SIZE,
    now,
  });
  const result = deps.listing.list(config.brandSlug !== undefined ? { ...query, brandSlugs: [config.brandSlug] } : query);
  if (!result.ok) throw new ListingUnavailableError(result.error.code);
  return { params: checked.params, result: result.value, dropped: checked.dropped };
}

/** Root-relative PDP path for a product slug, or null when it is not a valid internal href. */
export function productPath(slug: string): string | null {
  const path = `/products/${slug}`;
  return typeof slug === "string" && slug !== "" && isAllowedInternalHref(path) ? path : null;
}

/** ItemList JSON-LD of the current page: at most 24 entries, absolute PDP URLs. */
export function listingItemListJsonLd(
  items: readonly { readonly slug: string; readonly name: string }[],
): ItemListJsonLd | null {
  const entries: { path: string; name: string }[] = [];
  for (const item of items) {
    if (entries.length >= ITEM_LIST_MAX) break;
    const path = productPath(item.slug);
    if (path !== null) entries.push({ path, name: item.name });
  }
  return entries.length === 0 ? null : itemListJsonLd(entries);
}

export interface Crumb {
  readonly label: string;
  /** Root-relative path; omitted for the current page. */
  readonly href?: string;
}

/** Template breadcrumb items; hrefs failing `isAllowedInternalHref` become plain text. */
export function templateBreadcrumb(crumbs: readonly Crumb[]): ListingTemplateBreadcrumbItem[] {
  return crumbs.map((c) =>
    c.href !== undefined && isAllowedInternalHref(c.href) ? { label: c.label, href: c.href } : { label: c.label },
  );
}

/** BreadcrumbList JSON-LD; the current page (last crumb) uses `currentPath`. */
export function listingBreadcrumbJsonLd(crumbs: readonly Crumb[], currentPath: string): BreadcrumbListJsonLd {
  return breadcrumbListJsonLd(
    crumbs.map((c, i) => ({ name: c.label, path: i === crumbs.length - 1 ? currentPath : (c.href ?? currentPath) })),
  );
}

/**
 * Active-filter chip labels: brands from the facets of the same call (a
 * selected brand is always present there), the selected category from its
 * breadcrumb (it may be a department, which the facet list does not hold).
 */
export function filterLabels(
  deps: Pick<ListingPageDeps, "listing">,
  params: ListingParams,
  facets: FacetCounts,
): ActiveFilterLabels {
  const brand: Record<string, string> = {};
  for (const b of facets.brands) brand[b.value] = b.label;
  const category: Record<string, string> = {};
  for (const c of facets.categories) category[c.value] = c.label;
  if (params.category !== undefined && category[params.category] === undefined) {
    const path = deps.listing.breadcrumb(params.category);
    const last = path[path.length - 1];
    if (last !== undefined) category[last.slug] = last.name;
  }
  return { brand, category };
}

/** The `result` prop of the template (a `ListingResult` already fits; kept explicit for tests). */
export function templateResult(result: ListingResult): ListingTemplateResult {
  return { items: result.items, total: result.total, page: result.page, pageCount: result.pageCount, pageSize: result.pageSize };
}

/** Parse + route normalisation in one step (the parser never throws). */
export function parseRouteParams(searchParams: unknown, config: ListingRouteConfig): ListingParams {
  return normaliseRouteParams(parseListingParams(searchParams).params, config);
}

/** A link for content sections ("no results", empty states), dropped when the href is not allowed. */
export interface PageLink {
  readonly label: string;
  readonly href: string;
}

export function allowedLinks(links: readonly PageLink[]): PageLink[] {
  return links.filter((l) => l.label.trim() !== "" && isAllowedInternalHref(l.href));
}

/** Department (or sibling) links to `/category/<slug>`. */
export function categoryLinks(categories: readonly { readonly slug: string; readonly name: string }[]): PageLink[] {
  return allowedLinks(categories.map((c) => ({ label: c.name, href: `/category/${c.slug}` })));
}

// ---------------------------------------------------------------------------
// v3 listing extras (T167): promo slots, feedback, related chips, card clock
// ---------------------------------------------------------------------------

/** Promo tiles need at least this many results (CONTRACTS L-15). */
export const LISTING_PROMO_MIN_RESULTS = 8;
/** At most this many promo tiles per page (CONTRACTS L-13; `MAX_PROMO_SLOTS` in ProductGrid). */
export const LISTING_PROMO_MAX = 3;
/** Grid columns each listing promo tile spans. */
export const LISTING_PROMO_SPAN = 2;
/** Widest grid (lg): the even-cell rule below is checked against it. */
export const LISTING_PROMO_COLUMNS = 4;
/**
 * 0-based product index each tile follows: the tiles are the 3rd, 10th and
 * 17th grid `li` (CONTRACTS L-16 "positions 3, 10, 17"). Each span-2 tile
 * starts after an EVEN number of grid cells (2, 10, 18; see
 * `promoCellsBefore`), so at 4 columns it never straddles a row end and
 * never leaves a one-cell hole (T156 note).
 */
export const LISTING_PROMO_AFTER_INDEXES: readonly number[] = Object.freeze([1, 7, 13]);

/**
 * Grid cells taken before each tile when the tiles sit at `afterIndexes`
 * (sorted ascending) and each tile spans `span` cells: products up to and
 * including `afterIndex`, plus the earlier tiles.
 */
export function promoCellsBefore(afterIndexes: readonly number[], span: number = LISTING_PROMO_SPAN): number[] {
  return afterIndexes.map((afterIndex, k) => afterIndex + 1 + span * k);
}

/** Path part of an href ("/deals?x=1" -> "/deals"). */
function hrefPath(href: string): string {
  const cut = href.search(/[?#]/u);
  return cut === -1 ? href : href.slice(0, cut);
}

export interface ListingPromoInput {
  /** Route path; tiles whose CTA points at it are skipped (no "Shop deals" tile on /deals). */
  readonly base: string;
  /** The params the single `list()` call was built from. */
  readonly params: ListingParams;
  /** `result.total` of that call. */
  readonly total: number;
  /** Copy; defaults to `LISTING_PROMOS` (`src/content/listing-promos.ts`). */
  readonly promos?: readonly ListingPromoCopy[];
}

/**
 * Promo slots for a listing page (T167, CONTRACTS L-13..L-16). Returns `[]`
 * unless: page 1, `total >= LISTING_PROMO_MIN_RESULTS`, and no facet filter
 * (`hasActiveFilters`) or `dept` is active (a sort or the grid/list view
 * does not count). Otherwise up to 3 span-2 tiles from content (skipping
 * tiles whose CTA targets `base` or fails the allow-list), at
 * `LISTING_PROMO_AFTER_INDEXES`. ProductGrid still drops a tile past the
 * last product of a non-full page, and the template drops all of them when a
 * facet is active or the list view is on, so the rules hold twice.
 */
export function listingPromoSlots(input: ListingPromoInput): ProductGridPromoSlot[] {
  const page = input.params.page ?? 1;
  if (page !== 1) return [];
  if (!Number.isSafeInteger(input.total) || input.total < LISTING_PROMO_MIN_RESULTS) return [];
  if (hasActiveFilters(input.params) || input.params.dept !== undefined) return [];
  const base = hrefPath(input.base);
  const chosen = (input.promos ?? LISTING_PROMOS)
    .filter((p) => p.heading.trim() !== "" && isAllowedInternalHref(p.cta.href) && hrefPath(p.cta.href) !== base)
    .slice(0, Math.min(LISTING_PROMO_MAX, LISTING_PROMO_AFTER_INDEXES.length));
  return chosen.map((copy, k) => ({
    afterIndex: LISTING_PROMO_AFTER_INDEXES[k] ?? 0,
    tile: {
      heading: copy.heading,
      blurb: copy.blurb,
      cta: { label: copy.cta.label, href: copy.cta.href },
      image:
        copy.image === null
          ? null
          : { path: copy.image.path, width: copy.image.width, height: copy.image.height, alt: copy.image.alt, decorative: true },
      tone: copy.tone,
      span: LISTING_PROMO_SPAN,
      headingLevel: 3,
    },
  }));
}

/** Suggestions in the feedback block (FeedbackBlock renders 2-3). */
export const LISTING_FEEDBACK_MAX = 3;

/**
 * `feedback` prop for a listing page: up to 3 suggestion links from content,
 * skipping the current route. The template shows the block only when there
 * are results (or a query): CONTRACTS L-20.
 */
export function listingFeedback(
  base: string,
  suggestions: readonly FeedbackSuggestion[] = LISTING_FEEDBACK_SUGGESTIONS,
): Exclude<ListingTemplateFeedback, boolean> {
  const path = hrefPath(base);
  return {
    suggestions: suggestions
      .filter((s) => s.label.trim() !== "" && isAllowedInternalHref(s.href) && hrefPath(s.href) !== path)
      .slice(0, LISTING_FEEDBACK_MAX)
      .map((s) => ({ label: s.label, href: s.href })),
  };
}

/** Related chips per row (ChipRow's own cap is also 12). */
export const RELATED_CHIPS_MAX = 12;

/** Related-category chips (`{ label, href }` to `/category/<slug>`), allow-listed, at most 12. */
export function categoryChips(categories: readonly { readonly slug: string; readonly name: string }[]): ChipRowLinkItem[] {
  return categoryLinks(categories).slice(0, RELATED_CHIPS_MAX);
}

/**
 * "Other brands" chips for a brand page: brands with at least one published
 * product, excluding `currentSlug`, most products first (then name), at most 12.
 */
export function brandChips(brands: readonly BrandWithCount[], currentSlug: string): ChipRowLinkItem[] {
  const others = brands
    .filter((b) => b.slug !== currentSlug && b.productCount > 0)
    .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name, "en"));
  return allowedLinks(others.map((b) => ({ label: b.name, href: `/brand/${b.slug}` }))).slice(0, RELATED_CHIPS_MAX);
}

/**
 * `cardProps` carrying the page's single clock to every card (the template
 * does not forward ProductGrid's `now`), merged with an optional per-card
 * function (e.g. `positionRankCardProps` on /best-sellers). The inner
 * function wins for its own keys.
 */
export function listingCardProps<P>(
  now: Date,
  inner?: (product: P, index: number) => ProductGridCardExtras,
): (product: P, index: number) => ProductGridCardExtras {
  return (product, index) => ({ now, ...(inner !== undefined ? inner(product, index) : {}) });
}

// ---------------------------------------------------------------------------
// Collection routes (T107 + CONS-B1): /products, /deals, /best-sellers,
// /new-arrivals, /top-rated
// ---------------------------------------------------------------------------

export type CollectionKind = "products" | "deals" | "best-sellers" | "new-arrivals" | "top-rated";

export interface CollectionConfig {
  readonly base: "/products" | "/deals" | "/best-sellers" | "/new-arrivals" | "/top-rated";
  readonly title: string;
  /** Meta description, 70-160 characters (T112 metadata audit). */
  readonly description: string;
  /** Route default sort; absent = `featured`. Only this value is omitted from the route's URLs. */
  readonly defaultSort?: ListingSort;
  readonly dealsOnly?: boolean;
  /** "#N" ranks on cards while the list is in best-selling order. */
  readonly ranked?: boolean;
}

export const COLLECTIONS: Readonly<Record<CollectionKind, CollectionConfig>> = {
  products: {
    base: "/products",
    title: "All products",
    description: "Browse every product in the store. Filter by department, brand, price, rating and availability.",
  },
  deals: {
    base: "/deals",
    title: "Today's Deals",
    description: "Discounted products across every department, updated as prices change.",
    dealsOnly: true,
  },
  "best-sellers": {
    base: "/best-sellers",
    title: "Best Sellers",
    description: "Our most popular products, ranked by units sold. Filter by department, brand, price and rating.",
    defaultSort: "best_selling",
    ranked: true,
  },
  "new-arrivals": {
    base: "/new-arrivals",
    title: "New Arrivals",
    description: "The newest products in the store, most recent first. Filter by department, brand, price and rating.",
    defaultSort: "newest",
  },
  "top-rated": {
    base: "/top-rated",
    title: "Top Rated",
    description: "Products with the highest average customer rating, best first. Filter by department, brand and price.",
    defaultSort: "rating",
  },
};

export const NO_DEALS_TITLE = "No deals right now";
export const NO_DEALS_TEXT = "Check back soon, or browse these instead.";
export const NO_DEALS_LINKS: readonly PageLink[] = [
  { label: "Browse all products", href: "/products" },
  { label: "Best Sellers", href: "/best-sellers" },
  { label: "New Arrivals", href: "/new-arrivals" },
];

export interface CollectionPageView {
  readonly kind: CollectionKind;
  readonly title: string;
  readonly base: string;
  readonly breadcrumb: readonly ListingTemplateBreadcrumbItem[];
  readonly params: ListingParams;
  readonly facets: FacetCounts;
  readonly result: ListingTemplateResult;
  readonly sort: ListingSort;
  /** Route default sort for the template (`ListingTemplate defaultSort`); undefined = `featured`. */
  readonly defaultSort?: ListingSort;
  readonly labels: ActiveFilterLabels;
  /** True when cards show "#N" ranks (best-selling order). */
  readonly ranked: boolean;
  /** Links for the "No deals right now" state (/deals with no deals and no filters), else null. */
  readonly noDealsLinks: readonly PageLink[] | null;
  readonly jsonLd: readonly (ItemListJsonLd | BreadcrumbListJsonLd)[];
  readonly rel: { readonly prev?: string; readonly next?: string };
  /** The request clock (read once by the loader) for the cards' "New" badge. */
  readonly now: Date;
  /** Grid promo tiles (`listingPromoSlots`); empty off page 1, under 8 results or with a facet. */
  readonly promoSlots: readonly ProductGridPromoSlot[];
  /** Feedback block suggestions (`listingFeedback`). */
  readonly feedback: Exclude<ListingTemplateFeedback, boolean>;
}

function collectionCrumbs(config: CollectionConfig): Crumb[] {
  return [{ label: "Home", href: "/" }, { label: config.title }];
}

/** Route config of a collection (no `allowQuery`: `q` is dropped). */
export function collectionRoute(config: CollectionConfig): ListingRouteConfig {
  return {
    base: config.base,
    ...(config.defaultSort !== undefined ? { defaultSort: config.defaultSort } : {}),
    ...(config.dealsOnly === true ? { dealsOnly: true } : {}),
  };
}

/** Collection page data: exactly one `list()` call, no cookies, no writes. */
export function loadCollectionPage(
  kind: CollectionKind,
  searchParams: unknown,
  deps: ListingPageDeps = getListingPageDeps(),
): CollectionPageView {
  const config = COLLECTIONS[kind];
  const now = deps.now();
  const route = collectionRoute(config);
  const loaded = loadListing(deps, parseRouteParams(searchParams, route), route, now);
  const { params, result } = loaded;
  const crumbs = collectionCrumbs(config);
  const itemList = listingItemListJsonLd(result.items);
  const noDeals = config.dealsOnly === true && result.total === 0 && !isFacetedListing(params);
  return {
    kind,
    title: config.title,
    base: config.base,
    breadcrumb: templateBreadcrumb(crumbs),
    params,
    facets: result.facets,
    result: templateResult(result),
    sort: result.sort,
    ...(config.defaultSort !== undefined ? { defaultSort: config.defaultSort } : {}),
    labels: filterLabels(deps, params, result.facets),
    ranked: config.ranked === true && result.sort === "best_selling",
    noDealsLinks: noDeals ? allowedLinks(NO_DEALS_LINKS) : null,
    jsonLd: [...(itemList !== null ? [itemList] : []), listingBreadcrumbJsonLd(crumbs, config.base)],
    rel: listingRelLinks(config.base, params, result.pageCount, config.defaultSort),
    now: new Date(now),
    promoSlots: listingPromoSlots({ base: config.base, params, total: result.total }),
    feedback: listingFeedback(config.base),
  };
}

/** Collection metadata: indexable with canonical; faceted/re-sorted URLs `noindex, follow`. No DB access. */
export function collectionMetadata(kind: CollectionKind, searchParams: unknown): Metadata {
  const config = COLLECTIONS[kind];
  return listingMetadata({
    title: config.title,
    description: config.description,
    base: config.base,
    params: parseRouteParams(searchParams, collectionRoute(config)),
    ...(config.defaultSort !== undefined ? { defaultSort: config.defaultSort } : {}),
  });
}
