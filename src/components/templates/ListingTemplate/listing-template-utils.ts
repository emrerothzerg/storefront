import {
  buildListingHref,
  elidedSort,
  isListingSort,
  type ListingHrefOptions,
  type ListingParams,
} from "@/components/molecules/_listing-url";
import type { ListingSort } from "@/server/catalog/listing-service";

/** Pure helpers for `ListingTemplate` (T91). Exported for tests and pages. */

const numberFormat = new Intl.NumberFormat("en-US");

function safeNonNegative(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Result count line (criterion 3): "1–16 of 48 results" (en dash), last
 * partial page "33–48 of 48 results", "1 result", "0 results". A page beyond
 * the last (no items, total > 0) reads "48 results".
 */
export function formatResultCount(page: number, pageSize: number, total: number, itemCount: number): string {
  const t = safeNonNegative(total);
  const noun = t === 1 ? "result" : "results";
  if (t === 0) return "0 results";
  if (t === 1 && safeNonNegative(itemCount) === 1) return "1 result";
  const size = safeNonNegative(pageSize);
  const p = Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const items = safeNonNegative(itemCount);
  if (size === 0 || items === 0) return `${numberFormat.format(t)} ${noun}`;
  const start = (p - 1) * size + 1;
  if (start > t) return `${numberFormat.format(t)} ${noun}`;
  const end = Math.min(t, start + items - 1);
  return `${numberFormat.format(start)}–${numberFormat.format(end)} of ${numberFormat.format(t)} ${noun}`;
}

/**
 * Resolved sort for the toolbar: explicit `sort` prop, else the URL's, else
 * the route `defaultSort`, else the default for `q`.
 */
export function resolveSort(
  params: ListingParams,
  sort: ListingSort | undefined,
  defaultSort?: ListingSort,
): ListingSort {
  if (sort !== undefined && isListingSort(sort)) return sort;
  return isListingSort(params.sort) ? params.sort : elidedSort(params.q, defaultSort !== undefined ? { defaultSort } : {});
}

/** Grid/list toggle hrefs (criterion 4): same URL with `view` switched, page and a non-default sort kept. */
export function viewHrefs(
  base: string,
  params: ListingParams,
  opts: ListingHrefOptions = {},
): { grid: string; list: string } {
  return {
    grid: buildListingHref(base, params, { view: "grid" }, opts),
    list: buildListingHref(base, params, { view: "list" }, opts),
  };
}

/** Default empty-state "Clear filters" link: only the search query survives. */
export function clearFiltersHref(base: string, params: ListingParams): string {
  return buildListingHref(base, params.q !== undefined ? { q: params.q } : {});
}

/**
 * `cardProps` for best-seller style pages (T107 /best-sellers): "#N" from the
 * position in the sorted result, continuing across pages. Not the template
 * default: `ProductListItem.rank` from `list()` is the SEARCH position, which
 * must not be shown as a best-seller rank.
 */
export function positionRankCardProps(page: number, pageSize: number): (product: unknown, index: number) => { rank: number } {
  const p = Number.isSafeInteger(page) && page >= 1 ? page : 1;
  const size = Number.isSafeInteger(pageSize) && pageSize >= 1 ? pageSize : 1;
  return (_product, index) => ({ rank: (p - 1) * size + index + 1 });
}

/**
 * Fallback page size for promo placement when `result.pageSize` is not a
 * positive integer. Mirrors `LISTING_PAGE_SIZE` in `src/app/_listing/listing-page.ts`
 * (ruling O-2: 24 = 6 rows of 4); components must not import from `src/app`.
 */
export const LISTING_TEMPLATE_PAGE_SIZE = 24;

/**
 * Paging fed to `ProductGrid` for promo placement (T158): `page` is the URL
 * page (`params.page`, absent = 1) so promos appear on page 1 only; `pageSize`
 * is the result's page size (a trailing promo is kept only on a full page).
 */
export function promoPaging(paramsPage: number | undefined, resultPageSize: number): { page: number; pageSize: number } {
  const page = paramsPage === undefined ? 1 : paramsPage;
  const pageSize =
    Number.isSafeInteger(resultPageSize) && resultPageSize > 0 ? resultPageSize : LISTING_TEMPLATE_PAGE_SIZE;
  return { page, pageSize };
}

/**
 * Feedback block visibility (T158 AC3, CONTRACTS L-20): at least one result,
 * or a non-blank search query. A 0-result category without a query gets none.
 */
export function showListingFeedback(total: number, q: string | undefined): boolean {
  if (Number.isSafeInteger(total) && total > 0) return true;
  return typeof q === "string" && q.trim() !== "";
}
