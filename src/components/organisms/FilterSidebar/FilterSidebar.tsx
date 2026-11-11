import type { ReactNode } from "react";
import { Badge } from "@/components/atoms/Badge";
import { Button, buttonClassName } from "@/components/atoms/Button";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { ActiveFilters, activeFilterChips, type ActiveFilterLabels } from "@/components/molecules/ActiveFilters";
import { FacetGroup, PriceFacet } from "@/components/molecules/FacetGroup";
import {
  buildListingHref,
  listingEntries,
  safeListingBase,
  type ListingHrefOptions,
  type ListingParams,
} from "@/components/molecules/_listing-url";
import type { FacetBucket, FacetCounts, ListingSort } from "@/server/catalog/listing-service";
import { FilterDrawerToggle } from "./FilterDrawerToggle";

export interface FilterSidebarProps {
  /** Facet counts from the listing service (`ListingResult.facets`). */
  facets: FacetCounts;
  /** Current, normalised listing state (T91 parser). */
  params: ListingParams;
  /** Listing path the form submits to and links point at, e.g. "/search". */
  base: string;
  /** Slug -> display name, used by the active-filter chips. */
  labels: ActiveFilterLabels;
  /** Render the category facet (links). Defaults to true. */
  showCategoryFacet?: boolean;
  /** Result count shown next to "Active filters". */
  resultCount?: number;
  /**
   * Number of matching products on deal (pass `facets.deals`). The "Deals"
   * group renders only when this is > 0 (or `deals` is applied, so it can be
   * cleared). Absent = `facets.deals` (required on `FacetCounts` since CONS-B5).
   */
  dealsCount?: number;
  /**
   * Route default sort (e.g. `best_selling` on /best-sellers): only this sort
   * is omitted from the hidden inputs and the Reset link, so a user-chosen
   * `featured` survives Apply/Reset there. Absent = `defaultSortFor(q)`.
   */
  defaultSort?: ListingSort;
  /**
   * Level of the "Filters" heading at the top of the inline panel. Absent =
   * no heading (the pill and the `aside` label name the panel, and the
   * listing toolbar adds no headings: contract L-5). The mobile Drawer always
   * has its own "Filters" title.
   */
  headingLevel?: FilterHeadingLevel;
  /**
   * Rendered after the Filter pill in the same row, right-aligned (the
   * listing toolbar: `SortSelect`, view toggle). Must not contain the filter
   * form (it sits outside the details, so forms never nest).
   */
  toolbarEnd?: ReactNode;
  /** id of the outer wrapper (not repeated inside the form). */
  id?: string;
  className?: string;
}

export type FilterHeadingLevel = 2 | 3 | 4 | 5 | 6;

/** Visible text of the Filter pill (contract L-6). */
export const FILTER_SUMMARY_LABEL = "Filter";

/** Every facet the form controls; all of them, plus `page`, are dropped by Reset. */
const FACET_RESET: Partial<ListingParams> = {
  brand: undefined,
  min: undefined,
  max: undefined,
  rating: undefined,
  instock: undefined,
  deals: undefined,
  category: undefined,
  page: undefined,
};

/** Params the form's own controls post (so they are not duplicated as hidden inputs), plus `page`. */
const HIDDEN_RESET: Partial<ListingParams> = {
  brand: undefined,
  min: undefined,
  max: undefined,
  rating: undefined,
  instock: undefined,
  deals: undefined,
  page: undefined,
};

/**
 * Hidden inputs of the GET form: everything the form's controls do NOT post
 * (`q`, `dept`, `sort`, `view`, `extra`) survives Apply. `category` is kept
 * too: the category facet is links (it navigates on its own), so the form
 * has no category control and Apply must not drop the current category.
 * `page` is dropped (new filters start at page 1).
 */
export function filterHiddenEntries(params: ListingParams, opts: ListingHrefOptions = {}): Array<[string, string]> {
  return listingEntries(params, HIDDEN_RESET, opts);
}

/** Reset: drops every facet and `page`; keeps `q`, `sort`, `view`, `dept` and `extra`. */
export function filterResetHref(base: string, params: ListingParams, opts: ListingHrefOptions = {}): string {
  return buildListingHref(base, params, FACET_RESET, opts);
}

/** Number of applied filters (one per active-filter chip; a price range counts once). */
export function activeFilterCount(params: ListingParams): number {
  return activeFilterChips(params, "/").length;
}

/**
 * "Filters" or "Filters (3)". Phase 2 toggle label, kept for callers; the v3
 * pill reads `FILTER_SUMMARY_LABEL` plus the `filterBadgeText` badge.
 */
export function filtersButtonLabel(count: number): string {
  return Number.isSafeInteger(count) && count > 0 ? `Filters (${count.toLocaleString("en-US")})` : "Filters";
}

/** Count badge text for the Filter pill: the applied-filter count, or null (no badge) at 0 / invalid. */
export function filterBadgeText(count: number): string | null {
  return Number.isSafeInteger(count) && count > 0 ? count.toLocaleString("en-US") : null;
}

const HEADINGS = { 2: "h2", 3: "h3", 4: "h4", 5: "h5", 6: "h6" } as const satisfies Record<FilterHeadingLevel, string>;

/** Outlined pill (secondary Button look) on the native `<summary>`; `cursor-pointer` because summary is not a button. */
const SUMMARY_CLASS = buttonClassName({ variant: "secondary", size: "sm", className: "cursor-pointer list-none" });

/** A group is shown when at least one bucket can be chosen or is applied (criterion 2). */
export function hasAvailableBucket<T>(buckets: readonly FacetBucket<T>[]): boolean {
  return buckets.some((b) => b.selected || (Number.isSafeInteger(b.count) && b.count > 0));
}

function safeCount(value: number | undefined): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * Listing filters (T79). ONE `<form method="get">` with hidden inputs for the
 * preserved params, the facet groups (category links, brand checkboxes,
 * rating radios, price presets + min/max, availability, deals), a single
 * "Apply filters" submit and a "Reset" link. Groups with nothing to choose
 * are omitted. v3 (T157): the panel sits behind a "Filter" pill (icon +
 * applied-count badge) in a toolbar row whose end holds `toolbarEnd` (sort).
 * The pill is a native `<details>` summary, closed by default, so it works
 * without JS at every width; after hydration it opens a left `Drawer` below
 * `lg` and toggles the details panel in place from `lg` (Escape closes both
 * and returns focus to the pill).
 */
export function FilterSidebar({
  facets,
  params,
  base,
  labels,
  showCategoryFacet = true,
  resultCount,
  dealsCount,
  defaultSort,
  headingLevel,
  toolbarEnd,
  id,
  className,
}: FilterSidebarProps) {
  const action = safeListingBase(base);
  const hrefOpts: ListingHrefOptions = defaultSort !== undefined ? { defaultSort } : {};
  /** Forwarded to the facet molecules so their links keep a user-chosen sort. */
  const sortProp: { defaultSort?: ListingSort } = defaultSort !== undefined ? { defaultSort } : {};
  const groupClass = "border-b border-border-default pb-4";

  const availability: FacetBucket<string>[] = [
    { value: "1", label: "In stock only", count: safeCount(facets.inStock), selected: params.instock === true },
  ];
  const deals: FacetBucket<string>[] = [
    { value: "1", label: "Deals only", count: safeCount(dealsCount === undefined ? facets.deals : dealsCount), selected: params.deals === true },
  ];
  const showPrice = hasAvailableBucket(facets.price) || params.min !== undefined || params.max !== undefined;

  const panel = (
    <div className="flex min-w-0 flex-col gap-4">
      <ActiveFilters params={params} base={base} labels={labels} resultCount={resultCount} {...sortProp} />
      <form method="get" action={action} className="flex min-w-0 flex-col gap-4">
        {filterHiddenEntries(params, hrefOpts).map(([name, value], index) => (
          <input key={`${name}-${index}`} type="hidden" name={name} value={value} />
        ))}
        {showCategoryFacet && hasAvailableBucket(facets.categories) ? (
          <FacetGroup
            legend="Category"
            name="category"
            kind="links"
            buckets={facets.categories}
            base={base}
            params={params}
            className={groupClass}
            {...sortProp}
          />
        ) : null}
        {hasAvailableBucket(facets.brands) ? (
          <FacetGroup
            legend="Brand"
            name="brand"
            kind="checkbox"
            buckets={facets.brands}
            base={base}
            params={params}
            className={groupClass}
            {...sortProp}
          />
        ) : null}
        {hasAvailableBucket(facets.rating) ? (
          <FacetGroup
            legend="Customer review"
            name="rating"
            kind="radio"
            buckets={facets.rating}
            base={base}
            params={params}
            className={groupClass}
            {...sortProp}
          />
        ) : null}
        {showPrice ? (
          <PriceFacet
            legend="Price"
            presets={facets.price}
            base={base}
            params={params}
            className={groupClass}
            {...sortProp}
          />
        ) : null}
        {hasAvailableBucket(availability) ? (
          <FacetGroup
            legend="Availability"
            name="instock"
            kind="checkbox"
            buckets={availability}
            base={base}
            params={params}
            className={groupClass}
            {...sortProp}
          />
        ) : null}
        {hasAvailableBucket(deals) ? (
          <FacetGroup
            legend="Deals"
            name="deals"
            kind="checkbox"
            buckets={deals}
            base={base}
            params={params}
            className={groupClass}
            {...sortProp}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" fullWidth>
            Apply filters
          </Button>
          <Link variant="nav" href={filterResetHref(base, params, hrefOpts)} className="text-small underline">
            Reset
          </Link>
        </div>
      </form>
    </div>
  );

  const badge = filterBadgeText(activeFilterCount(params));
  const summary = (
    <>
      <Icon name="filter" size="sm" />
      <span>{FILTER_SUMMARY_LABEL}</span>{" "}
      {badge !== null ? (
        <Badge tone="accent" emphasis="solid" shape="pill" data-filter-badge="">
          {badge}
        </Badge>
      ) : null}
    </>
  );
  const Heading = headingLevel !== undefined ? HEADINGS[headingLevel] : null;
  const heading = Heading !== null ? <Heading className="m-0 text-h3 text-text-primary">Filters</Heading> : undefined;

  return (
    <div id={id} className={["min-w-0", className].filter(Boolean).join(" ")}>
      <FilterDrawerToggle summary={summary} summaryClassName={SUMMARY_CLASS} heading={heading} toolbarEnd={toolbarEnd}>
        {panel}
      </FilterDrawerToggle>
    </div>
  );
}
