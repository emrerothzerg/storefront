import type { Metadata } from "next";

import type { ActiveFilterLabels } from "@/components/molecules/ActiveFilters";
import { CHIP_ROW_MAX_ITEMS, type ChipRowItem } from "@/components/molecules/ChipRow";
import type { FeedbackSuggestion } from "@/components/molecules/FeedbackBlock";
import type { ProductGridPromoSlot } from "@/components/organisms/ProductGrid";
import { hasActiveFilters, type ListingParams } from "@/components/molecules/_listing-url";
import type { ListingTemplateBreadcrumbItem, ListingTemplateResult } from "@/components/templates/ListingTemplate";
import type { FacetBucket, FacetCounts, ListingSort } from "@/server/catalog/listing-service";
import { MAX_PAGE_SIZE as SEARCH_MAX_PAGE_SIZE } from "@/server/catalog/search-service";
// Search tips + popular searches: content module (CONS-B1 item ar).
import { POPULAR_SEARCHES, SEARCH_TIPS } from "@/content/search-help";

import { buildListingUrl } from "@/app/_listing/parse-params";
import {
  allowedLinks,
  categoryLinks,
  filterLabels,
  getListingPageDeps,
  listingPromoSlots,
  ListingUnavailableError,
  listingMetadata,
  loadListing,
  parseRouteParams,
  templateBreadcrumb,
  templateResult,
  type ListingPageDeps,
  type ListingRouteConfig,
  type PageLink,
} from "@/app/_listing/listing-page";

/**
 * /search data (T105). Flow per request (no cookies, no writes, `now` read once):
 *
 * - Empty `q` (absent, blank, or cleaned to nothing) = BROWSE MODE: every
 *   published product, `<h1>` "All results" (documented choice, AC1).
 * - Otherwise the search service returns the matching ids (all pages, capped
 *   at `MAX_SEARCH_IDS`), and ONE `list({ ids, ...filters })` call provides
 *   items, facets and sort in relevance order (T91 page-parser rule). A
 *   query that normalises to no terms (e.g. only FTS operators) is a browse.
 * - Unknown `category`/`dept` slug: dropped before the single `list()` call
 *   (AC5, shared loader).
 * - "Did you mean": only when the final total is 0-2 AND the service has a
 *   suggestion (the service computes one only for zero raw matches).
 * - 0 results: tips, popular searches, department links (on Cards); the
 *   filter sidebar is omitted.
 * - v3 (T168): `<h1>` "Showing results for “q”" (the metadata title keeps
 *   "Results for “q”"); related-search chips (`{ query }` items, max 12,
 *   never the current query or the did-you-mean suggestion) go to the
 *   template's `relatedSearches` slot: on 0 results each single term of a
 *   multi-term query that has results, otherwise the category and brand
 *   names of the result facets (always in the FTS index, so they match);
 *   none in browse mode. Promo tiles (shared `listingPromoSlots`) only on page 1 with
 *   >= 8 results and no facet or `dept` (CONTRACTS L-15). Feedback block with
 *   a popular search, all products and help. `now` is exposed as a Date for
 *   the cards (one clock per request).
 * - A page beyond the last renders the template's "This page is empty" state
 *   with a link to the last page (200).
 */

export const SEARCH_BASE = "/search";
export const BROWSE_TITLE = "All results";
/** Upper bound on ids pulled from the search service for one query (the seeded catalogue is ~125 products). */
export const MAX_SEARCH_IDS = 1000;
/** "Did you mean" shows when the result count is at most this. */
export const DID_YOU_MEAN_MAX_RESULTS = 2;
export const MAX_RELATED_SEARCHES = 5;
/** Related-search chips under the heading (CONTRACTS L-4: at most 12). */
export const MAX_RELATED_CHIPS = CHIP_ROW_MAX_ITEMS;

export const NO_RESULTS_TITLE = "No results";

/** Metadata title (unchanged since T105). */
export function searchTitle(q: string | undefined): string {
  return q === undefined ? BROWSE_TITLE : `Results for “${q}”`;
}

/** The page `<h1>` (T168, listing reference L3). */
export function searchHeading(q: string | undefined): string {
  return q === undefined ? BROWSE_TITLE : `Showing results for “${q}”`;
}

export function searchHref(q: string): string {
  return buildListingUrl(SEARCH_BASE, { q });
}

export interface NoResultsView {
  readonly tips: readonly string[];
  readonly popular: readonly PageLink[];
  readonly departments: readonly PageLink[];
  /** "Clear filters" link when filters narrowed the results to zero, else null. */
  readonly clearFiltersHref: string | null;
}

export interface SearchPageView {
  readonly mode: "browse" | "results";
  readonly title: string;
  readonly base: string;
  readonly breadcrumb: readonly ListingTemplateBreadcrumbItem[];
  readonly params: ListingParams;
  readonly facets: FacetCounts;
  readonly result: ListingTemplateResult;
  readonly sort: ListingSort;
  readonly labels: ActiveFilterLabels;
  readonly showFilters: boolean;
  readonly didYouMean: PageLink | null;
  readonly noResults: NoResultsView | null;
  /** Chips for the template's `relatedSearches` slot; empty = no chip row. */
  readonly relatedSearches: readonly ChipRowItem[];
  /** Empty unless page 1, >= 8 results, no facet and no `dept`. */
  readonly promoSlots: readonly ProductGridPromoSlot[];
  readonly feedback: { readonly suggestions: readonly FeedbackSuggestion[] };
  /** The request clock (read once) for the product cards. */
  readonly now: Date;
}

interface SearchIds {
  readonly ids: readonly string[];
  readonly didYouMean: string | null;
  readonly browseAll: boolean;
  readonly terms: readonly string[];
}

/** Every matching id in relevance order (paged through the service, capped). Throws on service failure. */
export function searchAllIds(deps: Pick<ListingPageDeps, "search">, q: string, now: number): SearchIds {
  const ids: string[] = [];
  let didYouMean: string | null = null;
  let browseAll = false;
  let terms: readonly string[] = [];
  const maxPages = Math.ceil(MAX_SEARCH_IDS / SEARCH_MAX_PAGE_SIZE);
  for (let page = 1; page <= maxPages; page++) {
    const r = deps.search.search(q, { page, pageSize: SEARCH_MAX_PAGE_SIZE, now });
    if (!r.ok) throw new ListingUnavailableError(r.error.code);
    if (page === 1) {
      didYouMean = r.value.didYouMean;
      browseAll = r.value.browseAll;
      terms = r.value.terms;
      if (browseAll) break;
    }
    ids.push(...r.value.ids);
    if (r.value.ids.length === 0 || ids.length >= r.value.total || ids.length >= MAX_SEARCH_IDS) break;
  }
  return { ids: ids.slice(0, MAX_SEARCH_IDS), didYouMean, browseAll, terms };
}

/** Single terms of a multi-term query that find something on their own (max 5). */
export function relatedSearches(
  deps: Pick<ListingPageDeps, "search">,
  terms: readonly string[],
  exclude: readonly string[],
  now: number,
): PageLink[] {
  if (terms.length < 2) return [];
  const skip = new Set(exclude.map((s) => s.toLowerCase()));
  const out: PageLink[] = [];
  for (const term of new Set(terms)) {
    if (out.length >= MAX_RELATED_SEARCHES) break;
    if (skip.has(term)) continue;
    const r = deps.search.search(term, { page: 1, pageSize: 1, now });
    if (r.ok && r.value.total > 0) out.push({ label: term, href: searchHref(term) });
  }
  return allowedLinks(out);
}

function facetNames(buckets: readonly FacetBucket[]): string[] {
  return [...buckets]
    .filter((b) => !b.selected && b.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((b) => b.label);
}

/**
 * Related-search chips: `candidates` in order, cleaned of blanks, case-
 * insensitive duplicates and every `exclude` entry (the current query, the
 * did-you-mean suggestion), capped at {@link MAX_RELATED_CHIPS}.
 */
export function relatedSearchChips(candidates: readonly string[], exclude: readonly string[]): ChipRowItem[] {
  const seen = new Set(exclude.map((s) => s.trim().toLowerCase()));
  const out: ChipRowItem[] = [];
  for (const raw of candidates) {
    if (out.length >= MAX_RELATED_CHIPS) break;
    const query = raw.replace(/\s+/g, " ").trim();
    const key = query.toLowerCase();
    if (query === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({ query });
  }
  return out;
}

/**
 * Promo tiles via the shared listing helper (T167 `listingPromoSlots`):
 * page 1, >= 8 results, no facet and no `dept` (CONTRACTS L-15).
 */
export function searchPromoSlots(params: ListingParams, total: number): ProductGridPromoSlot[] {
  return listingPromoSlots({ base: SEARCH_BASE, params, total });
}

/** Feedback suggestions: one popular search (not the current query), all products, help. */
export function searchFeedbackSuggestions(q: string | undefined): FeedbackSuggestion[] {
  const current = q?.toLowerCase();
  const term = POPULAR_SEARCHES.find((t) => t !== current);
  return [
    ...(term !== undefined ? [{ label: `Search for “${term}”`, href: searchHref(term) }] : []),
    { label: "Browse all products", href: "/products" },
    { label: "Search help and FAQs", href: "/help" },
  ];
}

/** The only listing route that keeps `q` (D-T107-1). */
const SEARCH_ROUTE: ListingRouteConfig = { base: SEARCH_BASE, allowQuery: true };

export function loadSearchPage(searchParams: unknown, deps: ListingPageDeps = getListingPageDeps()): SearchPageView {
  const now = deps.now();
  const parsed = parseRouteParams(searchParams, SEARCH_ROUTE);
  const q = parsed.q;

  let found: SearchIds | null = null;
  if (q !== undefined) found = searchAllIds(deps, q, now);
  const route: ListingRouteConfig =
    found !== null && !found.browseAll ? { ...SEARCH_ROUTE, ids: found.ids } : SEARCH_ROUTE;

  const { params, result } = loadListing(deps, parsed, route, now);
  const suggestion = found?.didYouMean ?? null;
  const didYouMean =
    q !== undefined && suggestion !== null && suggestion !== q.toLowerCase() && result.total <= DID_YOU_MEAN_MAX_RESULTS
      ? { label: suggestion, href: searchHref(suggestion) }
      : null;

  let noResults: NoResultsView | null = null;
  if (result.total === 0) {
    const departments = categoryLinks(deps.listing.categoryTree(now));
    noResults = {
      tips: SEARCH_TIPS,
      popular: allowedLinks(POPULAR_SEARCHES.map((term) => ({ label: term, href: searchHref(term) }))),
      departments,
      clearFiltersHref: hasActiveFilters(params) || params.dept !== undefined
        ? buildListingUrl(SEARCH_BASE, q !== undefined ? { q } : {})
        : null,
    };
  }

  const exclude = [...(q !== undefined ? [q] : []), ...(suggestion !== null ? [suggestion] : [])];
  let relatedCandidates: string[] = [];
  if (q !== undefined && found !== null && !found.browseAll) {
    relatedCandidates =
      result.total === 0
        ? relatedSearches(deps, found.terms, exclude, now).map((link) => link.label)
        : [...facetNames(result.facets.categories), ...facetNames(result.facets.brands)];
  }

  return {
    mode: q === undefined ? "browse" : "results",
    title: searchHeading(q),
    base: SEARCH_BASE,
    breadcrumb: templateBreadcrumb([{ label: "Home", href: "/" }, { label: q === undefined ? "All results" : "Search" }]),
    params,
    facets: result.facets,
    result: templateResult(result),
    sort: result.sort,
    labels: filterLabels(deps, params, result.facets),
    showFilters: result.total > 0,
    didYouMean,
    noResults,
    relatedSearches: relatedSearchChips(relatedCandidates, exclude),
    promoSlots: searchPromoSlots(params, result.total),
    feedback: { suggestions: searchFeedbackSuggestions(q) },
    now: new Date(now),
  };
}

/** `noindex, follow`; canonical `/search?q=<q>` (facets, sort and page stripped). No DB access. */
export function searchMetadata(searchParams: unknown): Metadata {
  const params = parseRouteParams(searchParams, SEARCH_ROUTE);
  return listingMetadata({
    title: searchTitle(params.q),
    description:
      params.q === undefined ? "Browse every product in the store." : `Search results for “${params.q}”.`,
    base: SEARCH_BASE,
    params,
    noindex: true,
    dropPage: true,
  });
}
