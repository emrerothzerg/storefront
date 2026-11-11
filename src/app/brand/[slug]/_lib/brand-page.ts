import type { Metadata } from "next";

import type { ActiveFilterLabels } from "@/components/molecules/ActiveFilters";
import { hasActiveFilters, type ListingParams } from "@/components/molecules/_listing-url";
import type { ChipRowLinkItem } from "@/components/molecules/ChipRow";
import type { ProductGridPromoSlot } from "@/components/organisms/ProductGrid";
import type {
  ListingTemplateBreadcrumbItem,
  ListingTemplateFeedback,
  ListingTemplateResult,
} from "@/components/templates/ListingTemplate";
import { SLUG_RE } from "@/app/_listing/parse-params";
import {
  allowedLinks,
  brandChips,
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
  type Crumb,
  type ListingPageDeps,
  type ListingRouteConfig,
  type PageLink,
} from "@/app/_listing/listing-page";
import type { BreadcrumbListJsonLd, ItemListJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { SITE_NAME } from "@/lib/seo/site";
import type { Brand } from "@/lib/types";
import type { FacetCounts, ListingSort } from "@/server/catalog/listing-service";

/**
 * /brand/[slug] data (T106): the category-page shape scoped to one brand.
 * The brand scope is a route config (`brandSlugs: [slug]` on the query), so
 * the URL's `brand` param is dropped and the brand facet is hidden: the
 * template gets a shallow copy of the facets from the single `list()` call
 * with only `brands` emptied; every other bucket is the very object `list()`
 * returned (ruling D-T106-1, accepted). Category facet links stay on.
 */

/** Second sentence of every brand meta description. */
export const BRAND_DESCRIPTION_TAIL =
  "Compare prices, ratings and customer reviews, and filter by department, price and availability.";

/**
 * Meta description (70-160 characters, T112 audit) composed from the
 * brand's own seed copy plus store context: "<description> Shop <name>
 * products at <store>. <tail>" (context sentences only while they fit).
 */
export function brandDescription(brand: Pick<Brand, "name" | "description">): string {
  return composeMetaDescription(brand.description, [`Shop ${brand.name} products at ${SITE_NAME}.`, BRAND_DESCRIPTION_TAIL]);
}

export function emptyBrandTitle(name: string): string {
  return `No products from ${name} yet`;
}

export const EMPTY_BRAND_LINKS: readonly PageLink[] = [
  { label: "See all brands", href: "/brands" },
  { label: "Browse all products", href: "/products" },
];

export interface BrandPageView {
  readonly brand: Brand;
  readonly title: string;
  readonly description: string;
  readonly base: string;
  readonly breadcrumb: readonly ListingTemplateBreadcrumbItem[];
  readonly params: ListingParams;
  readonly facets: FacetCounts;
  readonly result: ListingTemplateResult;
  readonly sort: ListingSort;
  readonly labels: ActiveFilterLabels;
  readonly emptyLinks: readonly PageLink[] | null;
  readonly jsonLd: readonly (ItemListJsonLd | BreadcrumbListJsonLd)[];
  readonly rel: { readonly prev?: string; readonly next?: string };
  /** The request clock (read once by the loader) for the cards' "New" badge. */
  readonly now: Date;
  /** Other brands with published products as chips (`brandChips`, at most 12). */
  readonly relatedSearches: readonly ChipRowLinkItem[];
  /** Grid promo tiles (`listingPromoSlots`); empty off page 1, under 8 results or with a facet. */
  readonly promoSlots: readonly ProductGridPromoSlot[];
  readonly feedback: Exclude<ListingTemplateFeedback, boolean>;
}

export type BrandPageResult = { readonly found: false } | { readonly found: true; readonly view: BrandPageView };

export function findBrand(deps: Pick<ListingPageDeps, "brands">, slug: string): Brand | null {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return null;
  return deps.brands.getBySlug(slug);
}

function crumbsFor(brand: Brand): Crumb[] {
  return [{ label: "Home", href: "/" }, { label: "Brands", href: "/brands" }, { label: brand.name }];
}

export function loadBrandPage(
  slug: string,
  searchParams: unknown,
  deps: ListingPageDeps = getListingPageDeps(),
): BrandPageResult {
  const brand = findBrand(deps, slug);
  if (brand === null) return { found: false };
  const now = deps.now();
  const base = `/brand/${brand.slug}`;
  const route: ListingRouteConfig = { base, brandSlug: brand.slug };
  const { params, result } = loadListing(deps, parseRouteParams(searchParams, route), route, now);
  const facets: FacetCounts = { ...result.facets, brands: [] };
  const crumbs = crumbsFor(brand);
  const itemList = listingItemListJsonLd(result.items);
  return {
    found: true,
    view: {
      brand,
      title: brand.name,
      description: brand.description,
      base,
      breadcrumb: templateBreadcrumb(crumbs),
      params,
      facets,
      result: templateResult(result),
      sort: result.sort,
      labels: filterLabels(deps, params, result.facets),
      emptyLinks: result.total === 0 && !hasActiveFilters(params) ? allowedLinks(EMPTY_BRAND_LINKS) : null,
      jsonLd: [...(itemList !== null ? [itemList] : []), listingBreadcrumbJsonLd(crumbs, base)],
      rel: listingRelLinks(base, params, result.pageCount),
      now: new Date(now),
      relatedSearches: brandChips(deps.brands.listWithCounts(now), brand.slug),
      promoSlots: listingPromoSlots({ base, params, total: result.total }),
      feedback: listingFeedback(base),
    },
  };
}

/** Metadata from the brand row (no `list()` call); unknown slug -> generic `noindex`. */
export function brandMetadata(
  slug: string,
  searchParams: unknown,
  deps: Pick<ListingPageDeps, "brands"> = getListingPageDeps(),
): Metadata {
  const brand = findBrand(deps, slug);
  if (brand === null) {
    return buildMetadata({ title: "Brand not found", description: "This brand does not exist.", noindex: true });
  }
  const base = `/brand/${brand.slug}`;
  return listingMetadata({
    title: brand.name,
    description: brandDescription(brand),
    base,
    params: parseRouteParams(searchParams, { base, brandSlug: brand.slug }),
  });
}
