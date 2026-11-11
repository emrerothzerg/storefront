/**
 * Listing URL helper (T63). Pure, server- and client-safe; no `src/server`
 * runtime import (molecules never import server modules; the sort list is
 * mirrored below and pinned to `LISTING_SORTS` by a test).
 *
 * Listing state lives in the URL (D9). The managed parameters (T91) are
 * `q, dept, category, brand (repeated), min, max, rating, instock, deals,
 * sort, page, view`, always emitted in that order. Every other parameter the
 * page received is passed in `params.extra` and preserved verbatim after the
 * managed ones, sorted by key (criterion 5). See molecules/README.md (T63).
 *
 * Units: `min` / `max` are WHOLE DOLLARS in the URL. The page/organism
 * converts to cents for the listing service (min * 100; max * 100 + 99 so
 * "Up to $49" includes $49.99).
 */

/** Mirror of `LISTING_SORTS` (src/server/catalog/listing-service.ts); a test pins equality. */
export const LISTING_SORT_VALUES = [
  "relevance",
  "featured",
  "price_asc",
  "price_desc",
  "rating",
  "newest",
  "best_selling",
] as const;

export type ListingSortValue = (typeof LISTING_SORT_VALUES)[number];

export type ListingView = "grid" | "list";

export interface ListingParams {
  q?: string;
  dept?: string;
  category?: string;
  brand?: readonly string[];
  /** Whole dollars. */
  min?: number;
  /** Whole dollars. */
  max?: number;
  /** 1-4 ("N stars & up"). */
  rating?: number;
  instock?: boolean;
  deals?: boolean;
  sort?: string;
  page?: number;
  view?: ListingView;
  /**
   * Unknown (non-listing) query params to preserve, e.g. `p` (compare
   * selection, T67) or campaign tags. Managed keys and `_rsc` are ignored here.
   */
  extra?: Readonly<Record<string, string>>;
}

/** Managed keys, in emission order. */
export const LISTING_PARAM_KEYS = [
  "q",
  "dept",
  "category",
  "brand",
  "min",
  "max",
  "rating",
  "instock",
  "deals",
  "sort",
  "page",
  "view",
] as const;

export type ListingParamKey = (typeof LISTING_PARAM_KEYS)[number];

/** Keys whose change does NOT reset pagination. */
const PAGE_PRESERVING_KEYS: ReadonlySet<string> = new Set(["page", "view", "extra"]);
/** Never preserved from `extra` (managed keys, Next.js internals). */
const RESERVED_EXTRA_KEYS: ReadonlySet<string> = new Set<string>([...LISTING_PARAM_KEYS, "_rsc"]);
const SORT_SET: ReadonlySet<string> = new Set(LISTING_SORT_VALUES);

export const DEFAULT_VIEW: ListingView = "grid";

/** Default sort: `relevance` with a search query, else `featured` (omitted from URLs). */
export function defaultSortFor(q: string | undefined): ListingSortValue {
  return cleanString(q) !== undefined ? "relevance" : "featured";
}

/**
 * Href options. `defaultSort` is the ROUTE default sort (e.g. `best_selling`
 * on /best-sellers, `newest` on /new-arrivals): only that value is omitted
 * from URLs, so a user-chosen `featured` survives on those routes. When
 * absent, `defaultSortFor(q)` applies (`relevance` with a query, else
 * `featured`).
 */
export interface ListingHrefOptions {
  readonly defaultSort?: ListingSortValue;
}

/** The sort omitted from URLs: the route default when given, else `defaultSortFor(q)`. */
export function elidedSort(q: string | undefined, opts: ListingHrefOptions = {}): ListingSortValue {
  return opts.defaultSort !== undefined && isListingSort(opts.defaultSort) ? opts.defaultSort : defaultSortFor(q);
}

export function isListingSort(value: unknown): value is ListingSortValue {
  return typeof value === "string" && SORT_SET.has(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function wholeNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function cleanBrands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value as readonly unknown[]) {
    const slug = cleanString(item);
    if (slug !== undefined) seen.add(slug);
  }
  return [...seen].sort();
}

/** Applies `patch` to `params`; a key present in the patch with `undefined` removes it. */
export function mergeListingParams(params: ListingParams, patch: Partial<ListingParams> = {}): ListingParams {
  const merged: ListingParams = { ...params };
  const target = merged as Record<string, unknown>;
  let resetsPage = false;
  for (const key of Object.keys(patch)) {
    target[key] = (patch as Record<string, unknown>)[key];
    if (!PAGE_PRESERVING_KEYS.has(key)) resetsPage = true;
  }
  if (resetsPage && !Object.prototype.hasOwnProperty.call(patch, "page")) delete merged.page;
  return merged;
}

/**
 * Normalised `[name, value]` pairs for `params` after `patch`, defaults
 * omitted, stable order. Use for hidden inputs in GET forms (T79 / SortSelect).
 */
export function listingEntries(
  params: ListingParams,
  patch: Partial<ListingParams> = {},
  opts: ListingHrefOptions = {},
): Array<[string, string]> {
  const p = mergeListingParams(params, patch);
  const out: Array<[string, string]> = [];
  const q = cleanString(p.q);
  if (q !== undefined) out.push(["q", q]);
  const dept = cleanString(p.dept);
  if (dept !== undefined) out.push(["dept", dept]);
  const category = cleanString(p.category);
  if (category !== undefined) out.push(["category", category]);
  for (const brand of cleanBrands(p.brand)) out.push(["brand", brand]);
  const min = wholeNonNegative(p.min);
  if (min !== undefined) out.push(["min", String(min)]);
  const max = wholeNonNegative(p.max);
  if (max !== undefined) out.push(["max", String(max)]);
  if (typeof p.rating === "number" && Number.isInteger(p.rating) && p.rating >= 1 && p.rating <= 4) {
    out.push(["rating", String(p.rating)]);
  }
  if (p.instock === true) out.push(["instock", "1"]);
  if (p.deals === true) out.push(["deals", "1"]);
  if (isListingSort(p.sort) && p.sort !== elidedSort(q, opts)) out.push(["sort", p.sort]);
  const page = wholeNonNegative(p.page);
  if (page !== undefined && page > 1) out.push(["page", String(page)]);
  if (p.view === "list") out.push(["view", "list"]);
  if (p.extra !== undefined && p.extra !== null && typeof p.extra === "object") {
    for (const key of Object.keys(p.extra).sort()) {
      const value = p.extra[key];
      if (key === "" || RESERVED_EXTRA_KEYS.has(key) || typeof value !== "string") continue;
      out.push([key, value]);
    }
  }
  return out;
}

/** Same-site path only; query and hash of `base` are dropped. Anything else falls back to "/". */
export function safeListingBase(base: string): string {
  if (typeof base !== "string") return "/";
  const path = base.trim().split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
  return path;
}

/**
 * `base` + the query for `params` with `patch` applied. Omits defaults
 * (empty strings, page 1, view grid, default sort, false booleans), drops
 * `page` when anything other than `page`/`view` changes, repeats `brand=`,
 * encodes with `URLSearchParams`, preserves `params.extra`. Pass the route's
 * `defaultSort` (see `ListingHrefOptions`) on routes whose default is not
 * `featured`.
 */
export function buildListingHref(
  base: string,
  params: ListingParams,
  patch: Partial<ListingParams> = {},
  opts: ListingHrefOptions = {},
): string {
  const search = new URLSearchParams(listingEntries(params, patch, opts)).toString();
  const path = safeListingBase(base);
  return search === "" ? path : `${path}?${search}`;
}

/** True when any filter (not q/dept/sort/page/view) is applied. */
export function hasActiveFilters(params: ListingParams): boolean {
  return listingEntries(params).some(([key]) =>
    ["category", "brand", "min", "max", "rating", "instock", "deals"].includes(key),
  );
}

const USD_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

/** "$25" from whole dollars. */
export function formatWholeDollars(dollars: number): string {
  return USD_WHOLE.format(dollars);
}

/** URL dollars for a price bucket in cents: floor(min/100), floor(max/100) (max null = open-ended). */
export function priceBucketToParams(bucket: { minCents: number; maxCents: number | null }): {
  min: number | undefined;
  max: number | undefined;
} {
  const min = Math.floor(bucket.minCents / 100);
  return {
    min: min > 0 ? min : undefined,
    max: bucket.maxCents === null ? undefined : Math.floor(bucket.maxCents / 100),
  };
}
