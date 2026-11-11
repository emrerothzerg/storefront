import type { Metadata } from "next";

import type { ActiveFilterLabels } from "@/components/molecules/ActiveFilters";
import { hasActiveFilters, type ListingParams } from "@/components/molecules/_listing-url";
import type { ChipRowLinkItem } from "@/components/molecules/ChipRow";
import type { CategoryRailItem } from "@/components/organisms/CategoryGrid";
import type { ProductGridPromoSlot } from "@/components/organisms/ProductGrid";
import type {
  ListingTemplateBreadcrumbItem,
  ListingTemplateFeedback,
  ListingTemplateResult,
} from "@/components/templates/ListingTemplate";
import { SLUG_RE } from "@/app/_listing/parse-params";
import {
  categoryChips,
  categoryLinks,
  composeMetaDescription,
  filterLabels,
  getListingPageDeps,
  listingBreadcrumbJsonLd,
  listingFeedback,
  listingItemListJsonLd,
  listingMetadata,
  listingPromoSlots,
  listingRelLinks,
  loadListing,
  parseRouteParams,
  templateBreadcrumb,
  templateResult,
  withoutParams,
  type Crumb,
  type ListingPageDeps,
  type ListingRouteConfig,
  type PageLink,
} from "@/app/_listing/listing-page";
import type { BreadcrumbListJsonLd, ItemListJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { SITE_NAME } from "@/lib/seo/site";
import type { Category, Product } from "@/lib/types";
import type { FacetCounts, ListingSort } from "@/server/catalog/listing-service";

/**
 * /category/[slug] data (T106). Departments (parent) list their children's
 * products (listing service scope), show subcategory tiles and the category
 * facet; child categories hide the category facet (siblings are linked from
 * the empty state and the breadcrumb). The URL's `dept` is always dropped and
 * `category` is kept only when it names a child of this department, so the
 * route scope cannot be swapped for an unrelated category.
 */

/** Products in the "Top sellers in <name>" rail. */
export const TOP_SELLERS_LIMIT = 12;

export function topSellersTitle(name: string): string {
  return `Top sellers in ${name}`;
}

export function emptyCategoryTitle(name: string): string {
  return `No products in ${name} yet`;
}

export interface CategoryPageView {
  readonly category: Category;
  readonly isDepartment: boolean;
  readonly title: string;
  readonly description: string;
  readonly base: string;
  readonly breadcrumb: readonly ListingTemplateBreadcrumbItem[];
  readonly params: ListingParams;
  readonly facets: FacetCounts;
  readonly result: ListingTemplateResult;
  readonly sort: ListingSort;
  readonly labels: ActiveFilterLabels;
  readonly showCategoryFacet: boolean;
  /** Child categories of a department, for the `CategoryRail` (circle tiles, department-art fallback). */
  readonly subcategories: readonly CategoryRailItem[];
  readonly topSellers: readonly Product[];
  /** Sibling links for the empty state (no products and no filters), else null. */
  readonly emptySiblings: readonly PageLink[] | null;
  readonly jsonLd: readonly (ItemListJsonLd | BreadcrumbListJsonLd)[];
  readonly rel: { readonly prev?: string; readonly next?: string };
  /** The request clock (read once by the loader) for the cards' "New" badge. */
  readonly now: Date;
  /**
   * Sibling categories as chips (other departments for a department; the
   * department's other children for a child). Empty while the empty state
   * (which lists the same siblings) is shown.
   */
  readonly relatedSearches: readonly ChipRowLinkItem[];
  /** Grid promo tiles (`listingPromoSlots`); empty off page 1, under 8 results or with a facet. */
  readonly promoSlots: readonly ProductGridPromoSlot[];
  readonly feedback: Exclude<ListingTemplateFeedback, boolean>;
}

export type CategoryPageResult = { readonly found: false } | { readonly found: true; readonly view: CategoryPageView };

/** `[department]` or `[department, child]` for a valid published slug, else null. */
export function categoryPath(deps: Pick<ListingPageDeps, "listing">, slug: string): readonly Category[] | null {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return null;
  const path = deps.listing.breadcrumb(slug);
  return path.length === 0 ? null : path;
}

/** Drops `dept` and any `category` that is not a child of this department (route scope wins). */
export function scopeCategoryParams(
  params: ListingParams,
  children: readonly { readonly slug: string }[],
): ListingParams {
  const drop: (keyof ListingParams)[] = [];
  if (params.dept !== undefined) drop.push("dept");
  if (params.category !== undefined && !children.some((c) => c.slug === params.category)) drop.push("category");
  return drop.length === 0 ? params : withoutParams(params, drop);
}

function crumbsFor(path: readonly Category[]): Crumb[] {
  const crumbs: Crumb[] = [{ label: "Home", href: "/" }];
  path.forEach((c, i) => crumbs.push(i === path.length - 1 ? { label: c.name } : { label: c.name, href: `/category/${c.slug}` }));
  return crumbs;
}

export function loadCategoryPage(
  slug: string,
  searchParams: unknown,
  deps: ListingPageDeps = getListingPageDeps(),
): CategoryPageResult {
  const path = categoryPath(deps, slug);
  const category = path?.[path.length - 1];
  const department = path?.[0];
  if (path === null || category === undefined || department === undefined) return { found: false };

  const now = deps.now();
  const isDepartment = path.length === 1;
  const base = `/category/${category.slug}`;
  const tree = deps.listing.categoryTree(now);
  const departmentNode = tree.find((d) => d.id === department.id);
  const children = isDepartment ? (departmentNode?.children ?? []) : [];

  const route: ListingRouteConfig = { base, categorySlug: category.slug };
  let params = scopeCategoryParams(parseRouteParams(searchParams, route), children);
  const loaded = loadListing(deps, params, route, now);
  const result = loaded.result;
  params = loaded.params;

  const siblings = isDepartment
    ? tree.filter((d) => d.id !== category.id)
    : (departmentNode?.children ?? []).filter((c) => c.id !== category.id);
  const crumbs = crumbsFor(path);
  const itemList = listingItemListJsonLd(result.items);
  const emptySiblings = result.total === 0 && !hasActiveFilters(params) ? categoryLinks(siblings) : null;

  return {
    found: true,
    view: {
      category,
      isDepartment,
      title: category.name,
      description: category.description,
      base,
      breadcrumb: templateBreadcrumb(crumbs),
      params,
      facets: result.facets,
      result: templateResult(result),
      sort: result.sort,
      labels: filterLabels(deps, params, result.facets),
      showCategoryFacet: isDepartment,
      subcategories: children.map((c) => ({ slug: c.slug, name: c.name, imageUrl: c.imageUrl, productCount: c.productCount })),
      topSellers: deps.listing.bestSellers(TOP_SELLERS_LIMIT, { categoryId: category.id, now }),
      emptySiblings,
      jsonLd: [...(itemList !== null ? [itemList] : []), listingBreadcrumbJsonLd(crumbs, base)],
      rel: listingRelLinks(base, params, result.pageCount),
      now: new Date(now),
      // The empty state already lists the siblings: no duplicate chip row there.
      relatedSearches: emptySiblings === null ? categoryChips(siblings) : [],
      promoSlots: listingPromoSlots({ base, params, total: result.total }),
      feedback: listingFeedback(base),
    },
  };
}

/** Second sentence of every category meta description. */
export const CATEGORY_DESCRIPTION_TAIL =
  "Compare prices, ratings and customer reviews, and filter by brand, price and availability.";

/**
 * Meta description (70-160 characters, T112 audit) composed from the
 * category's own seed copy plus store context: "<description> Shop <name>
 * [in <department>] at <store>. <tail>" (context sentences only while they
 * fit). The seed taxonomy is not edited.
 */
export function categoryDescription(path: readonly Category[]): string {
  const category = path[path.length - 1];
  if (category === undefined) return composeMetaDescription("", [CATEGORY_DESCRIPTION_TAIL]);
  const department = path.length > 1 ? path[0] : undefined;
  const shop =
    department !== undefined
      ? `Shop ${category.name} in ${department.name} at ${SITE_NAME}.`
      : `Shop every ${category.name} category at ${SITE_NAME}.`;
  return composeMetaDescription(category.description, [shop, CATEGORY_DESCRIPTION_TAIL]);
}

/** Metadata from the category row (no `list()` call); unknown slug -> generic `noindex`. `now` read once. */
export function categoryMetadata(
  slug: string,
  searchParams: unknown,
  deps: Pick<ListingPageDeps, "listing" | "now"> = getListingPageDeps(),
): Metadata {
  const path = categoryPath(deps, slug);
  const category = path?.[path.length - 1];
  if (path === null || category === undefined) {
    return buildMetadata({ title: "Category not found", description: "This category does not exist.", noindex: true });
  }
  const base = `/category/${category.slug}`;
  const children =
    path.length === 1 ? (deps.listing.categoryTree(deps.now()).find((d) => d.id === category.id)?.children ?? []) : [];
  const params = scopeCategoryParams(parseRouteParams(searchParams, { base, categorySlug: category.slug }), children);
  return listingMetadata({
    title: category.name,
    description: categoryDescription(path),
    base,
    params,
  });
}
