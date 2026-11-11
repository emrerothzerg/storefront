import type { ListingSort } from "@/server/catalog/listing-service";
import { listingEntries, safeListingBase, type ListingParams } from "../_listing-url";
import { SortSelectControls } from "./SortSelectControls";

export interface SortOption {
  value: ListingSort;
  label: string;
}

export interface SortSelectProps {
  /** Current sort (resolved by the listing service, so never undefined). */
  value: ListingSort;
  /** Defaults to `DEFAULT_SORT_OPTIONS` ("Relevance" only when `params.q` is present). */
  options?: readonly SortOption[];
  /** Listing path the form GETs, e.g. "/search". */
  base: string;
  /** Current state, replayed as hidden inputs (except `sort` and `page`). */
  params: ListingParams;
  /**
   * Route default sort (e.g. `best_selling` on /best-sellers). Passed to
   * `listingEntries` so the hidden inputs follow the same omission rule as
   * every other listing link on the route. Absent = `defaultSortFor(q)`.
   */
  defaultSort?: ListingSort;
  /** Defaults to "Sort by". */
  label?: string;
  className?: string;
}

/** Default labels, in display order. */
export const DEFAULT_SORT_OPTIONS: readonly SortOption[] = [
  { value: "featured", label: "Featured" },
  { value: "relevance", label: "Relevance" },
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "rating", label: "Avg. Customer Review" },
  { value: "newest", label: "Newest Arrivals" },
  { value: "best_selling", label: "Best Sellers" },
];

/** Options to show: "Relevance" only with a search query (or when it is the current value). */
export function visibleSortOptions(
  options: readonly SortOption[],
  q: string | undefined,
  value: ListingSort,
): SortOption[] {
  const hasQuery = typeof q === "string" && q.trim() !== "";
  return options.filter((o) => o.value !== "relevance" || hasQuery || value === "relevance");
}

/**
 * Sort control: a self-contained `<form method="get" action={base}>` with
 * the current listing params as hidden inputs (minus `sort`/`page`, so a new
 * sort starts at page 1), a labelled `select name="sort"` and an "Apply"
 * button. Without JS the button submits; with JS the select auto-submits and
 * the button is visually hidden. Server-safe (the controls are a small client
 * component taking serialisable props).
 */
export function SortSelect({
  value,
  options = DEFAULT_SORT_OPTIONS,
  base,
  params,
  defaultSort,
  label,
  className,
}: SortSelectProps) {
  const hidden = listingEntries(
    params,
    { sort: undefined, page: undefined },
    defaultSort !== undefined ? { defaultSort } : {},
  );
  const shown = visibleSortOptions(options, params.q, value);
  return (
    <form
      method="get"
      action={safeListingBase(base)}
      className={["min-w-0", className].filter(Boolean).join(" ")}
    >
      {hidden.map(([name, v], index) => (
        <input key={`${name}-${index}`} type="hidden" name={name} value={v} />
      ))}
      <SortSelectControls
        value={value}
        label={label}
        options={shown.map((o) => ({ value: o.value, label: o.label }))}
      />
    </form>
  );
}
