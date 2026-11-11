import { isAllowedInternalHref } from "@/content/routes";
import type { ListAddAllItemResult } from "@/components/molecules/_contracts/list-actions";
import { formatMoney, isValidCents } from "@/lib/money";
// Type-only: organisms never import server code at runtime.
import type { ListItemView, ListSort } from "@/server/lists/list-service";

/** Query parameter the lists pages read for the sort (unknown values are ignored by the page). */
export const LIST_SORT_PARAM = "sort";
export const LISTS_INDEX_PATH = "/lists";
export const BROWSE_PRODUCTS_PATH = "/products";
export const BEST_SELLERS_PATH = "/best-sellers";
export const LIST_EMPTY_MESSAGE = "This list is empty";

/** Display order and labels; the first entry is the service default (`DEFAULT_LIST_SORT`). */
export const LIST_SORT_OPTIONS: ReadonlyArray<{ readonly value: ListSort; readonly label: string }> = [
  { value: "added_desc", label: "Recently added" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "priority", label: "Priority" },
];

const SORT_VALUES: ReadonlySet<string> = new Set(LIST_SORT_OPTIONS.map((o) => o.value));

/** Falls back to "added_desc" for anything that is not a known sort. */
export function normaliseListSort(value: unknown): ListSort {
  return typeof value === "string" && SORT_VALUES.has(value) ? (value as ListSort) : "added_desc";
}

/**
 * Path part of `basePath` when it is an allowed internal route (query/hash
 * dropped), else `fallback` (which may be null = "no safe base").
 */
export function safeListBase(basePath: string, fallback: string | null): string | null {
  if (typeof basePath === "string" && isAllowedInternalHref(basePath)) {
    const cut = basePath.search(/[?#]/);
    return cut === -1 ? basePath : basePath.slice(0, cut);
  }
  return fallback;
}

/** `/lists/<id>` when the result is an allowed internal href, else null. */
export function listHref(id: string): string | null {
  if (typeof id !== "string" || id.trim() === "") return null;
  const href = `${LISTS_INDEX_PATH}/${encodeURIComponent(id)}`;
  return isAllowedInternalHref(href) ? href : null;
}

/** `/products/<slug>` when allowed, else null. */
export function productHref(slug: string): string | null {
  if (typeof slug !== "string" || slug.trim() === "") return null;
  const href = `/products/${encodeURIComponent(slug)}`;
  return isAllowedInternalHref(href) ? href : null;
}

/** `<base>?sort=<value>`; the default sort is omitted (canonical URL). */
export function sortHref(base: string, sort: ListSort): string {
  return sort === "added_desc" ? base : `${base}?${new URLSearchParams({ [LIST_SORT_PARAM]: sort }).toString()}`;
}

/** Items "Add all to cart" will try: the product exists and is in stock (mirrors the action). */
export function addableCount(items: readonly ListItemView[]): number {
  return items.filter((item) => item.product !== null && item.available).length;
}

export function pluralItems(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Currency of the first item whose product still exists; "USD" otherwise. */
export function listCurrency(items: readonly ListItemView[]): string {
  const withProduct = items.find((item) => item.product !== null);
  return withProduct?.product?.currency ?? "USD";
}

/** "3 items · $45.00" (total omitted when it cannot be formatted). */
export function listTotalText(itemCount: number, totalCents: number, currency: string): string {
  const count = pluralItems(safeCount(itemCount));
  if (!isValidCents(totalCents)) return count;
  try {
    return `${count} · ${formatMoney(totalCents, currency)}`;
  } catch {
    return count;
  }
}

const RESULT_GROUPS: ReadonlyArray<{ readonly result: ListAddAllItemResult; readonly label: string }> = [
  { result: "added", label: "Added" },
  { result: "capped", label: "Limited by stock or the cart limit" },
  { result: "out_of_stock", label: "Out of stock" },
  { result: "unavailable", label: "Unavailable" },
];

export const UNKNOWN_ITEM_NAME = "Unnamed item";

/**
 * Per-item text for an addAllToCart result, in list order within each group:
 * "Added: A, B. Out of stock: C." Returns "" when there is nothing to describe.
 */
export function describeAddAllResults(
  perItem: readonly { readonly productId: string; readonly result: ListAddAllItemResult }[] | undefined,
  names: ReadonlyMap<string, string>,
): string {
  if (!perItem || perItem.length === 0) return "";
  const sentences: string[] = [];
  for (const group of RESULT_GROUPS) {
    const matching = perItem
      .filter((entry) => entry.result === group.result)
      .map((entry) => names.get(entry.productId) ?? UNKNOWN_ITEM_NAME);
    if (matching.length > 0) sentences.push(`${group.label}: ${matching.join(", ")}.`);
  }
  return sentences.join(" ");
}

/** productId -> product name for the items that still have a product. */
export function itemNames(items: readonly ListItemView[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    if (item.product !== null) map.set(item.productId, item.product.name);
  }
  return map;
}
