import {
  buildListingHref,
  elidedSort,
  hasActiveFilters,
  isListingSort,
  type ListingHrefOptions,
  type ListingParams,
  type ListingSortValue,
} from "@/components/molecules/_listing-url";
import type { ListingQuery, ListingSort } from "@/server/catalog/listing-service";

/**
 * Listing search-params parser and URL helpers (T91). Pure: no `next/*`, no
 * DB, never throws. Every listing page (T105 search, T106 category/brand,
 * T107 collections) parses `searchParams` here once, passes the resulting
 * `ListingParams` to the listing service (via `toListingQuery`) AND to the
 * template, so organisms only ever see validated values (page-parser rule).
 *
 * Units follow the T63 molecules: `min` / `max` are WHOLE DOLLARS in the URL
 * and in `ListingParams`; `toListingQuery` converts to cents
 * (`min * 100`, `max * 100 + 99`). URL building reuses `_listing-url.ts`
 * (`buildListingHref`), so key order, default omission and encoding are
 * identical to every link the molecules/organisms emit.
 */

export type SearchParamValue = string | string[] | undefined;
export type ListingSearchParams = Readonly<Record<string, SearchParamValue>>;

export interface IgnoredParam {
  readonly key: string;
  /** Raw value, shortened to `IGNORED_VALUE_MAX` code units (non-strings described as `[type]`). */
  readonly value: string;
  readonly reason: string;
}

export interface ParsedListingParams {
  readonly params: ListingParams;
  readonly ignored: readonly IgnoredParam[];
}

export interface ParseListingOptions {
  /** When given, `brand` slugs outside this set are dropped ("unknown brand"). */
  readonly allowedBrands?: ReadonlySet<string>;
  /**
   * Non-listing keys kept verbatim in `params.extra` (single value each).
   * Defaults to `DEFAULT_PRESERVED_KEYS`. Pass `[]` to drop every unknown key.
   */
  readonly preserve?: readonly string[];
}

export const MAX_QUERY_LENGTH = 100;
/** Input past this many code units is never looked at (cheap on 1 MB values). */
export const MAX_QUERY_SCAN = 1000;
export const MAX_BRANDS = 10;
export const MAX_PAGE = 1000;
/** Largest accepted `min`/`max` (whole dollars); cents stay far below MAX_SAFE_INTEGER. */
export const MAX_PRICE_DOLLARS = 1_000_000;
export const MAX_EXTRA_VALUE_LENGTH = 200;
export const IGNORED_VALUE_MAX = 64;
/** At most this many `ignored` entries are reported (the rest are dropped silently). */
export const MAX_IGNORED = 50;
/** Array values beyond this length are not inspected. */
export const MAX_VALUES_PER_KEY = 100;
export const SLUG_RE = /^[a-z0-9-]{1,64}$/;

/**
 * Non-listing params preserved on every listing link (T63 `extra`): `p`
 * (compare selection, first value only), `ref` and the five `utm_*` tags.
 */
export const DEFAULT_PRESERVED_KEYS: readonly string[] = [
  "p",
  "ref",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
];

const MANAGED_SINGLE = ["q", "dept", "category", "min", "max", "rating", "instock", "deals", "sort", "page", "view"] as const;
type ManagedSingle = (typeof MANAGED_SINGLE)[number];
const MANAGED_SINGLE_SET: ReadonlySet<string> = new Set(MANAGED_SINGLE);

const CONTROL_RE = /\p{Cc}/gu;
const FORMAT_RE = /\p{Cf}/gu;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const DIGITS_RE = /^[0-9]{1,9}$/;

function describe(value: unknown): string {
  if (typeof value === "string") return value.length > IGNORED_VALUE_MAX ? `${value.slice(0, IGNORED_VALUE_MAX)}…` : value;
  if (Array.isArray(value)) return "[array]";
  if (value === null) return "[null]";
  return `[${typeof value}]`;
}

/** Cuts `text` to at most `max` code units without splitting a surrogate pair. */
function cutCodeUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Search query cleaning: control chars -> space, zero-width/bidi (`\p{Cf}`)
 * and lone surrogates removed, whitespace collapsed, trimmed, cut to 100
 * code units (never mid surrogate pair). Idempotent. `undefined` when empty.
 */
export function cleanListingQuery(raw: string): string | undefined {
  const text = raw
    .slice(0, MAX_QUERY_SCAN)
    .replace(CONTROL_RE, " ")
    .replace(FORMAT_RE, "")
    .replace(LONE_SURROGATE_RE, "")
    .replace(/\s+/gu, " ")
    .trim();
  const cut = cutCodeUnits(text, MAX_QUERY_LENGTH).trim();
  return cut === "" ? undefined : cut;
}

function cleanExtraValue(raw: string): string | undefined {
  const text = raw
    .slice(0, MAX_EXTRA_VALUE_LENGTH * 4)
    .replace(CONTROL_RE, "")
    .replace(FORMAT_RE, "")
    .replace(LONE_SURROGATE_RE, "")
    .trim();
  if (text === "" || text.length > MAX_EXTRA_VALUE_LENGTH) return undefined;
  return text;
}

class Collector {
  readonly ignored: IgnoredParam[] = [];
  add(key: string, value: unknown, reason: string): void {
    if (this.ignored.length < MAX_IGNORED) {
      this.ignored.push({ key: describe(key), value: describe(value), reason });
    }
  }
}

/** String values of one param (arrays flattened one level); non-strings reported. */
function stringsOf(key: string, raw: unknown, out: Collector): string[] {
  if (typeof raw === "string") return [raw];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    out.add(key, raw, "not a string");
    return [];
  }
  const values: string[] = [];
  const list = raw as readonly unknown[];
  const limit = Math.min(list.length, MAX_VALUES_PER_KEY);
  for (let i = 0; i < limit; i++) {
    const item = list[i];
    if (typeof item === "string") values.push(item);
    else out.add(key, item, "not a string");
  }
  if (list.length > MAX_VALUES_PER_KEY) out.add(key, `${list.length} values`, "too many values");
  return values;
}

/** First string value; extra values are reported as "repeated". */
function single(key: string, raw: unknown, out: Collector): string | undefined {
  const values = stringsOf(key, raw, out);
  for (let i = 1; i < values.length; i++) out.add(key, values[i], "repeated");
  return values[0];
}

function parseWhole(key: string, raw: string, out: Collector, min: number, max: number): number | undefined {
  if (!DIGITS_RE.test(raw)) {
    out.add(key, raw, raw.length > 9 && /^[0-9]+$/.test(raw.slice(0, 1000)) ? "out of range" : "not a whole number");
    return undefined;
  }
  const n = Number(raw);
  if (n < min || n > max) {
    out.add(key, raw, "out of range");
    return undefined;
  }
  return n;
}

/** Own property only (no prototype keys); a throwing getter/proxy counts as absent. */
function ownValue(record: object, key: string): unknown {
  try {
    return Object.prototype.hasOwnProperty.call(record, key) ? (record as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses untrusted `searchParams` into normalised `ListingParams`. Never
 * throws (non-object input = no params). See the README "T91" table for the
 * per-key rules; every dropped value is listed in `ignored`.
 */
export function parseListingParams(searchParams: unknown, opts: ParseListingOptions = {}): ParsedListingParams {
  const out = new Collector();
  const params: ListingParams = {};
  if (searchParams === null || typeof searchParams !== "object" || Array.isArray(searchParams)) {
    return { params, ignored: out.ignored };
  }
  const record = searchParams as object;
  const raw = (key: ManagedSingle): string | undefined => single(key, ownValue(record, key), out);

  const q = raw("q");
  if (q !== undefined) {
    const cleaned = cleanListingQuery(q);
    if (cleaned !== undefined) params.q = cleaned;
    else out.add("q", q, "empty");
  }

  for (const key of ["dept", "category"] as const) {
    const value = raw(key);
    if (value === undefined) continue;
    if (value.length <= 64 && SLUG_RE.test(value)) params[key] = value;
    else out.add(key, value, value === "" ? "empty" : "not a slug");
  }

  const brandValues = stringsOf("brand", ownValue(record, "brand"), out);
  if (brandValues.length > 0) {
    const brands = new Set<string>();
    for (const value of brandValues) {
      if (value.length > 64 || !SLUG_RE.test(value)) {
        out.add("brand", value, value === "" ? "empty" : "not a slug");
      } else if (opts.allowedBrands !== undefined && !opts.allowedBrands.has(value)) {
        out.add("brand", value, "unknown brand");
      } else if (brands.has(value)) {
        // Duplicate: harmless, collapsed silently.
      } else if (brands.size >= MAX_BRANDS) {
        out.add("brand", value, `too many brands (max ${MAX_BRANDS})`);
      } else {
        brands.add(value);
      }
    }
    if (brands.size > 0) params.brand = [...brands].sort();
  }

  const minRaw = raw("min");
  const maxRaw = raw("max");
  const min = minRaw === undefined || minRaw === "" ? undefined : parseWhole("min", minRaw, out, 0, MAX_PRICE_DOLLARS);
  const max = maxRaw === undefined || maxRaw === "" ? undefined : parseWhole("max", maxRaw, out, 0, MAX_PRICE_DOLLARS);
  if (minRaw === "") out.add("min", "", "empty");
  if (maxRaw === "") out.add("max", "", "empty");
  if (min !== undefined && max !== undefined && min > max) {
    out.add("min", minRaw, "min greater than max");
    out.add("max", maxRaw, "min greater than max");
  } else {
    if (min !== undefined) params.min = min;
    if (max !== undefined) params.max = max;
  }

  const rating = raw("rating");
  if (rating !== undefined) {
    if (rating.length === 1 && rating >= "1" && rating <= "4") params.rating = Number(rating);
    else out.add("rating", rating, rating === "" ? "empty" : "not 1-4");
  }

  for (const key of ["instock", "deals"] as const) {
    const value = raw(key);
    if (value === undefined) continue;
    if (value === "1") params[key] = true;
    else out.add(key, value, value === "" ? "empty" : "only 1 is accepted");
  }

  const sort = raw("sort");
  if (sort !== undefined) {
    if (isListingSort(sort)) params.sort = sort;
    else out.add("sort", sort, sort === "" ? "empty" : "unknown sort");
  }

  const page = raw("page");
  if (page !== undefined) {
    const n = page === "" ? undefined : parseWhole("page", page, out, 1, MAX_PAGE);
    if (page === "") out.add("page", "", "empty");
    if (n !== undefined) params.page = n;
  }

  const view = raw("view");
  if (view !== undefined) {
    if (view === "grid" || view === "list") params.view = view;
    else out.add("view", view, view === "" ? "empty" : "not grid or list");
  }

  const preserve = new Set(opts.preserve ?? DEFAULT_PRESERVED_KEYS);
  const extra: Record<string, string> = {};
  let keys: string[];
  try {
    keys = Object.keys(record);
  } catch {
    keys = [];
  }
  for (const key of keys) {
    if (key === "brand" || MANAGED_SINGLE_SET.has(key)) continue;
    const value = ownValue(record, key);
    if (!preserve.has(key)) {
      out.add(key, value, "unknown parameter");
      continue;
    }
    const first = single(key, value, out);
    if (first === undefined) continue;
    const cleaned = cleanExtraValue(first);
    if (cleaned === undefined) out.add(key, first, first.trim() === "" ? "empty" : "too long");
    else extra[key] = cleaned;
  }
  if (Object.keys(extra).length > 0) params.extra = extra;

  return { params, ignored: out.ignored };
}

/**
 * `base` + the query for `params` (T63 `buildListingHref`): managed keys in
 * fixed order (`q, dept, category, brand…, min, max, rating, instock, deals,
 * sort, page, view`), then preserved extras sorted by key; defaults omitted.
 */
export function buildListingUrl(
  base: string,
  params: ListingParams,
  patch?: Partial<ListingParams>,
  opts: ListingHrefOptions = {},
): string {
  return buildListingHref(base, params, patch, opts);
}

/** A sort other than the route default (`opts.defaultSort`, else `defaultSortFor(q)`). */
function hasNonDefaultSort(params: ListingParams, opts: ListingHrefOptions): boolean {
  return isListingSort(params.sort) && params.sort !== elidedSort(params.q, opts);
}

/**
 * True when the URL narrows or re-orders the canonical list: any facet
 * (`dept`, `category`, `brand`, price, `rating`, `instock`, `deals`) or a
 * non-default `sort` (the route's `opts.defaultSort`, else `defaultSortFor(q)`,
 * the same value `buildListingHref` omits). Pages use it for
 * `robots: noindex, follow` (T106 AC2).
 */
export function isFacetedListing(params: ListingParams, opts: ListingHrefOptions = {}): boolean {
  return (
    hasActiveFilters(params) || (typeof params.dept === "string" && params.dept !== "") || hasNonDefaultSort(params, opts)
  );
}

/**
 * Canonical path for a listing page (criterion 5). There is no listing
 * helper in `src/lib/seo` (P2-S only offers `buildMetadata({ path })`), so
 * the P2-S rule lives here: keep `q` and `page` (page 1 omitted), strip
 * facets, `dept`, `sort`, `view` and preserved extras. When the URL is
 * faceted or re-sorted (`isFacetedListing`) its page N is not page N of the
 * canonical list, so `page` is dropped too (canonical = page-1 base, T106
 * AC2). Pass the result as `buildMetadata({ path })`.
 */
export function canonicalListingUrl(base: string, params: ListingParams, opts: ListingHrefOptions = {}): string {
  const keepPage = !isFacetedListing(params, opts);
  const canonical: ListingParams = {
    ...(params.q !== undefined ? { q: params.q } : {}),
    ...(keepPage && params.page !== undefined ? { page: params.page } : {}),
  };
  return buildListingHref(base, canonical);
}

/**
 * Root-relative `prev` / `next` hrefs for `<link rel>` (criterion 3), every
 * filter preserved (same URLs as the Pagination links). A page beyond the
 * last gets `prev` = last page and no `next`; fewer than 2 pages = `{}`.
 * Pass the route `defaultSort` so a non-default `sort` (e.g. `featured` on
 * /best-sellers) is kept on the targets.
 */
export function paginationRel(
  base: string,
  params: ListingParams,
  pageCount: number,
  opts: ListingHrefOptions = {},
): { prev?: string; next?: string } {
  const count = Number.isSafeInteger(pageCount) && pageCount > 0 ? pageCount : 0;
  if (count < 2) return {};
  const page = typeof params.page === "number" && Number.isSafeInteger(params.page) && params.page >= 1 ? params.page : 1;
  const rel: { prev?: string; next?: string } = {};
  if (page > 1) rel.prev = buildListingHref(base, params, { page: Math.min(page - 1, count) }, opts);
  if (page < count) rel.next = buildListingHref(base, params, { page: page + 1 }, opts);
  return rel;
}

export interface ToListingQueryOptions {
  /** Route scope, e.g. the `/category/[slug]` slug; `params.category` (a child) wins, `params.dept` is the fallback. */
  readonly categorySlug?: string;
  /** Sort when the URL has none (e.g. `best_selling` on /best-sellers). */
  readonly defaultSort?: ListingSort;
  readonly pageSize?: number;
  readonly ids?: readonly string[];
  readonly dealsOnly?: boolean;
  readonly now?: number;
}

/**
 * Listing-service query for parsed params: category = `params.category ??
 * opts.categorySlug ?? params.dept`; dollars -> cents (`min * 100`,
 * `max * 100 + 99`); `instock`/`deals` -> booleans; `opts.dealsOnly` forces
 * deals (the /deals page).
 */
export function toListingQuery(params: ListingParams, opts: ToListingQueryOptions = {}): ListingQuery {
  const categorySlug = params.category ?? opts.categorySlug ?? params.dept;
  const sort: ListingSortValue | undefined = isListingSort(params.sort) ? params.sort : opts.defaultSort;
  const rating = params.rating;
  return {
    ...(categorySlug !== undefined ? { categorySlug } : {}),
    ...(params.brand !== undefined && params.brand.length > 0 ? { brandSlugs: [...params.brand] } : {}),
    ...(params.min !== undefined ? { minPriceCents: params.min * 100 } : {}),
    ...(params.max !== undefined ? { maxPriceCents: params.max * 100 + 99 } : {}),
    ...(rating === 1 || rating === 2 || rating === 3 || rating === 4 ? { minRating: rating } : {}),
    ...(params.instock === true ? { inStockOnly: true } : {}),
    ...(params.deals === true || opts.dealsOnly === true ? { dealsOnly: true } : {}),
    ...(sort !== undefined ? { sort } : {}),
    ...(params.page !== undefined ? { page: params.page } : {}),
    ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
    ...(opts.ids !== undefined ? { ids: opts.ids } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  };
}

/** `URLSearchParams` -> the record shape Next passes to pages (repeated keys -> arrays). */
export function searchParamsToRecord(search: URLSearchParams): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
  for (const [key, value] of search) {
    const current = record[key];
    if (current === undefined) record[key] = value;
    else if (Array.isArray(current)) current.push(value);
    else record[key] = [current, value];
  }
  return record;
}
