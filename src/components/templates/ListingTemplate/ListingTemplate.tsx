import type { ReactNode } from "react";
import { Breadcrumb, type BreadcrumbItem } from "@/components/atoms/Breadcrumb";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { Pagination } from "@/components/atoms/Pagination";
import { Heading, Text } from "@/components/atoms/Typography";
import type { ActiveFilterLabels } from "@/components/molecules/ActiveFilters";
import { ChipRow, type ChipRowItem } from "@/components/molecules/ChipRow";
import { FeedbackBlock, type FeedbackSuggestion } from "@/components/molecules/FeedbackBlock";
import type { ProductCardVariant } from "@/components/molecules/ProductCard";
import { SortSelect, type SortOption } from "@/components/molecules/SortSelect";
import type { CartActionFn } from "@/components/molecules/_contracts/cart-actions";
import {
  buildListingHref,
  hasActiveFilters,
  type ListingHrefOptions,
  type ListingParams,
} from "@/components/molecules/_listing-url";
import { FilterSidebar } from "@/components/organisms/FilterSidebar";
import {
  ProductGrid,
  type ProductGridCardExtras,
  type ProductGridPromoSlot,
} from "@/components/organisms/ProductGrid";
import { isAllowedInternalHref } from "@/content/routes";
import type { FacetCounts, ListingSort, ProductListItem } from "@/server/catalog/listing-service";
import {
  clearFiltersHref,
  formatResultCount,
  promoPaging,
  resolveSort,
  showListingFeedback,
  viewHrefs,
} from "./listing-template-utils";

export const LISTING_HEADING_ID = "listing-title";
export const LISTING_COUNT_ID = "listing-result-count";
export const LISTING_PAGINATION_LABEL = "Listing pages";
/** Default accessible name (and visible label) of the related-searches chip row. */
export const LISTING_RELATED_LABEL = "Related searches";

/**
 * Feedback block request (T158): `true` = default heading and suggestions;
 * an object = the page's own heading and/or 2–3 suggestion links. Absent or
 * `false` = no block.
 */
export type ListingTemplateFeedback =
  | boolean
  | {
      readonly heading?: string;
      readonly suggestions?: ReadonlyArray<FeedbackSuggestion>;
    };

export interface ListingTemplateBreadcrumbItem {
  readonly label: string;
  /** Omit for the current page. Hrefs failing `isAllowedInternalHref` render as plain text. */
  readonly href?: string;
}

export interface ListingTemplateResult {
  readonly items: readonly ProductListItem[];
  readonly total: number;
  readonly page: number;
  readonly pageCount: number;
  readonly pageSize: number;
}

export interface ListingTemplateProps {
  /** The page's only `<h1>` (plain text; a search query is rendered escaped). */
  title: string;
  breadcrumb: readonly ListingTemplateBreadcrumbItem[];
  /** Parsed params (`parseListingParams(...).params`). MUST be the same object the service query was built from. */
  params: ListingParams;
  /** `ListingResult.facets` from the SAME `list()` call as `result` (T91 page-parser rule). */
  facets: FacetCounts;
  result: ListingTemplateResult;
  /** Listing path, e.g. "/search", "/category/desks" (a literal from the page). */
  base: string;
  /** Slug -> name for the active-filter chips. */
  labels: ActiveFilterLabels;
  /** Category facet links. Defaults to true. */
  showCategoryFacet?: boolean;
  /**
   * Render the FilterSidebar. Defaults to: there are results, or a filter is
   * applied (so 0-result filtered pages can still clear filters).
   */
  showFilters?: boolean;
  /** Resolved sort (`ListingResult.sort`); defaults to the URL's sort, then `defaultSort`, then the default for `q`. */
  sort?: ListingSort;
  /**
   * The ROUTE default sort (e.g. `best_selling` on /best-sellers, `newest` on
   * /new-arrivals). Only this value is omitted from the template's links
   * (pagination, view toggles, filter form, sort form, "last page"), so a
   * user-chosen `featured` survives on those routes. Absent = `featured`
   * (`relevance` with a query). Must match the route config the page loader
   * used (`rel` links and canonical follow the same rule).
   */
  defaultSort?: ListingSort;
  sortOptions?: readonly SortOption[];
  /** Replaces the default 0-results state ("No results" + "Clear filters"). */
  emptyState?: ReactNode;
  /** Only level 1 is supported (the template owns the page `<h1>`). */
  headingLevel?: 1;
  /** Slot between the header and the results (category description, rails...). */
  children?: ReactNode;
  /** Per-card extras for `ProductGrid` (badges, rank, wishlist, compare...). No default. Wins over `addToCart`/`cardVariant`. */
  cardProps?: (product: ProductListItem, index: number) => ProductGridCardExtras;
  /**
   * Related-search chips under the heading (`ChipRow`, `nav` named by
   * `relatedSearchesLabel`). The page builds them (search suggestions, child
   * categories, brands); none / none valid = nothing rendered.
   */
  relatedSearches?: ReadonlyArray<ChipRowItem>;
  /** Accessible name and visible label of the chip row. Defaults to "Related searches". */
  relatedSearchesLabel?: string;
  /**
   * Promo tiles in the grid, passed through to `ProductGrid` with
   * `page = params.page` and `pageSize = result.pageSize` (fallback 24): page 1
   * only, max 3, grid layout only. The template never invents promos, and
   * drops them when a facet filter is applied (CONTRACTS L-15).
   */
  promoSlots?: readonly ProductGridPromoSlot[];
  /**
   * `FeedbackBlock` after the results. Rendered only when the page asks for it
   * AND there is at least one result or a non-blank `q` (CONTRACTS L-20).
   */
  feedback?: ListingTemplateFeedback;
  /** `addToCart` server action: every card gets the one-unit "+ Add" quick-add form. Absent = no quick add. */
  addToCart?: CartActionFn;
  /** Card variant for every card (`compact` for dense grids). Absent = the card default. */
  cardVariant?: ProductCardVariant;
  /**
   * The page's one clock (read once per request), forwarded to `ProductGrid`
   * for the cards' "New" badge. Absent = no "New" badge (cards never read the
   * clock). A `now` returned by `cardProps` still wins for that card.
   */
  now?: Date;
  className?: string;
}

function join(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const toggleClasses =
  "gap-1 rounded-full border border-border-default px-3 text-small no-underline hover:no-underline";

/**
 * Pill look for the Pagination atom's page/prev/next items (each `li`'s only
 * element child). Scoped to the listing pager; a `shape="pill"` prop on the
 * atom would replace this (designer request).
 */
const pagerClasses = "[&_li>*]:rounded-full";

function DefaultEmptyState({ base, params, opts }: { base: string; params: ListingParams; opts: ListingHrefOptions }) {
  const clear = clearFiltersHref(base, params);
  const showClear = clear !== buildListingHref(base, params, {}, opts);
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 rounded-lg bg-surface-sunken p-8 text-center">
      <Heading level={2} size="h3">
        No results
      </Heading>
      <Text>Try different words, check the spelling, or remove a filter.</Text>
      {showClear ? (
        <Link variant="nav" href={clear}>
          Clear filters
        </Link>
      ) : null}
    </div>
  );
}

function PastLastPage({
  base,
  params,
  pageCount,
  opts,
}: {
  base: string;
  params: ListingParams;
  pageCount: number;
  opts: ListingHrefOptions;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 rounded-lg bg-surface-sunken p-8 text-center">
      <Heading level={2} size="h3">
        This page is empty
      </Heading>
      <Text>There are fewer results than this page number.</Text>
      <Link variant="nav" href={buildListingHref(base, params, { page: pageCount }, opts)}>
        Go to the last page
      </Link>
    </div>
  );
}

/**
 * Listing page layout (T91, v3 T158), server-safe: Breadcrumb, the `<h1>`
 * title and result count, optional related-search chips, an optional slot,
 * then ONE toolbar row (FilterSidebar's "Filter" pill on the left, SortSelect
 * GET form + grid/list toggle LINKS on the right via `toolbarEnd`; below md
 * the row is Filter + a compact icon-labelled Sort and the view toggle is
 * hidden (T179 U07), so it never wraps at 320 px; the filter
 * panel opens above the full-width grid), ProductGrid (promo slots on page 1),
 * pill Pagination (`<nav aria-label="Listing pages">`) and an optional
 * FeedbackBlock. Every link is built from the same `params` with
 * `buildListingHref`, so filters survive sort, view and page changes. Exactly
 * two GET forms (sort + filters), never nested.
 */
export function ListingTemplate({
  title,
  breadcrumb,
  params,
  facets,
  result,
  base,
  labels,
  showCategoryFacet = true,
  showFilters,
  sort,
  defaultSort,
  sortOptions,
  emptyState,
  children,
  cardProps,
  relatedSearches,
  relatedSearchesLabel = LISTING_RELATED_LABEL,
  promoSlots,
  feedback,
  addToCart,
  cardVariant,
  now,
  className,
}: ListingTemplateProps) {
  const crumbs: BreadcrumbItem[] = breadcrumb.map((item) =>
    item.href !== undefined && isAllowedInternalHref(item.href)
      ? { label: item.label, href: item.href }
      : { label: item.label },
  );
  const total = Number.isSafeInteger(result.total) && result.total > 0 ? result.total : 0;
  const pageCount = Number.isSafeInteger(result.pageCount) && result.pageCount > 0 ? result.pageCount : 0;
  const hasItems = result.items.length > 0;
  const filtered = hasActiveFilters(params);
  const filtersVisible = showFilters ?? (total > 0 || filtered);
  const view = params.view === "list" ? "list" : "grid";
  const hrefOpts: ListingHrefOptions = defaultSort !== undefined ? { defaultSort } : {};
  const views = viewHrefs(base, params, hrefOpts);
  const currentSort = resolveSort(params, sort, defaultSort);
  const paging = promoPaging(params.page, result.pageSize);

  const templateCardExtras: ProductGridCardExtras = {
    ...(addToCart !== undefined ? { quickAdd: { action: addToCart } } : {}),
    ...(cardVariant !== undefined ? { variant: cardVariant } : {}),
  };
  const hasTemplateExtras = Object.keys(templateCardExtras).length > 0;
  const gridCardProps =
    hasTemplateExtras || cardProps !== undefined
      ? (product: ProductListItem, index: number): ProductGridCardExtras => ({
          ...templateCardExtras,
          ...(cardProps !== undefined ? cardProps(product, index) : {}),
        })
      : undefined;

  let body: ReactNode;
  if (hasItems) {
    body = (
      <ProductGrid
        products={result.items}
        layout={view}
        cardProps={gridCardProps}
        promoSlots={filtered ? undefined : promoSlots}
        page={paging.page}
        pageSize={paging.pageSize}
        now={now}
      />
    );
  } else if (total > 0) {
    body = <PastLastPage base={base} params={params} pageCount={pageCount} opts={hrefOpts} />;
  } else {
    body =
      emptyState !== undefined && emptyState !== null && emptyState !== false ? (
        emptyState
      ) : (
        <DefaultEmptyState base={base} params={params} opts={hrefOpts} />
      );
  }

  const toolbarEnd: ReactNode =
    total > 0 ? (
      <>
        <SortSelect
          value={currentSort}
          options={sortOptions}
          base={base}
          params={params}
          {...(defaultSort !== undefined ? { defaultSort } : {})}
        />
        <div role="group" aria-label="View" className="hidden items-center gap-2 md:flex" data-slot="view-toggle">
          <Link
            variant="nav"
            href={views.grid}
            isCurrent={view === "grid"}
            aria-current={view === "grid" ? "true" : undefined}
            className={toggleClasses}
          >
            <Icon name="grid" size="sm" />
            <span>Grid</span>
          </Link>
          <Link
            variant="nav"
            href={views.list}
            isCurrent={view === "list"}
            aria-current={view === "list" ? "true" : undefined}
            className={toggleClasses}
          >
            <Icon name="list" size="sm" />
            <span>List</span>
          </Link>
        </div>
      </>
    ) : null;

  let toolbar: ReactNode = null;
  if (filtersVisible) {
    toolbar = (
      <FilterSidebar
        facets={facets}
        params={params}
        base={base}
        labels={labels}
        showCategoryFacet={showCategoryFacet}
        resultCount={total}
        dealsCount={facets.deals}
        {...(defaultSort !== undefined ? { defaultSort } : {})}
        {...(toolbarEnd !== null ? { toolbarEnd } : {})}
      />
    );
  } else if (toolbarEnd !== null) {
    toolbar = <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">{toolbarEnd}</div>;
  }

  const feedbackRequest = feedback === undefined || feedback === false ? null : feedback === true ? {} : feedback;
  const showFeedback = feedbackRequest !== null && showListingFeedback(total, params.q);

  return (
    <div className={join("flex min-w-0 flex-col gap-4", className)} data-listing-view={view}>
      {crumbs.length > 0 ? <Breadcrumb items={crumbs} /> : null}
      <header className="flex min-w-0 flex-col gap-1">
        <Heading level={1} id={LISTING_HEADING_ID} className="break-words">
          {title}
        </Heading>
        <Text id={LISTING_COUNT_ID} variant="small" tone="secondary">
          {formatResultCount(result.page, result.pageSize, total, result.items.length)}
        </Text>
      </header>
      {relatedSearches !== undefined && relatedSearches.length > 0 ? (
        <ChipRow label={relatedSearchesLabel} items={relatedSearches} showLabel />
      ) : null}
      {children}
      <div className="flex min-w-0 flex-col gap-4" data-listing-results="">
        <Heading level={2} className="sr-only">
          Results
        </Heading>
        {toolbar}
        {body}
        {hasItems ? (
          <Pagination
            page={result.page}
            pageCount={pageCount}
            hrefFor={(page) => buildListingHref(base, params, { page }, hrefOpts)}
            label={LISTING_PAGINATION_LABEL}
            className={pagerClasses}
          />
        ) : null}
      </div>
      {showFeedback && feedbackRequest !== null ? (
        <FeedbackBlock
          {...(feedbackRequest.heading !== undefined ? { heading: feedbackRequest.heading } : {})}
          {...(feedbackRequest.suggestions !== undefined ? { suggestions: feedbackRequest.suggestions } : {})}
        />
      ) : null}
    </div>
  );
}
