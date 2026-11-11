import type { Metadata } from "next";

import {
  getListingPageDeps,
  listingBreadcrumbJsonLd,
  templateBreadcrumb,
  type Crumb,
  type ListingPageDeps,
} from "@/app/_listing/listing-page";
import type { ListingTemplateBreadcrumbItem } from "@/components/templates/ListingTemplate";
import { isAllowedInternalHref } from "@/content/routes";
import type { BreadcrumbListJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import type { BrandWithCount } from "@/lib/types";

/** /brands index data (T106): every brand grouped A–Z ("#" for names not starting with a Latin letter). */

export const BRANDS_TITLE = "Brands";
export const BRANDS_DESCRIPTION =
  "Shop every brand in the store, A to Z. See how many products each brand has and browse its full range in one place.";
export const BRANDS_PATH = "/brands";
/** Group key for names that do not start with A–Z after removing diacritics. */
export const OTHER_GROUP = "#";

export interface BrandIndexEntry {
  readonly slug: string;
  readonly name: string;
  readonly productCount: number;
  readonly href: string;
}

export interface BrandIndexGroup {
  readonly letter: string;
  readonly brands: readonly BrandIndexEntry[];
}

export interface BrandsPageView {
  readonly title: string;
  readonly breadcrumb: readonly ListingTemplateBreadcrumbItem[];
  readonly groups: readonly BrandIndexGroup[];
  /** Every brand in one alphabetical list (the groups flattened, "#" last), for the tile grid (T177/U05). */
  readonly brands: readonly BrandIndexEntry[];
  readonly jsonLd: BreadcrumbListJsonLd;
}

/** "A"–"Z" from the first letter (diacritics stripped: "Émile" -> "E"), else "#". */
export function groupLetter(name: string): string {
  const first = name.trim().normalize("NFD").replace(/\p{M}/gu, "").charAt(0).toUpperCase();
  return first >= "A" && first <= "Z" ? first : OTHER_GROUP;
}

/** Groups in A–Z order ("#" last), brands by name within a group; invalid slugs/hrefs dropped. */
export function groupBrands(brands: readonly BrandWithCount[]): BrandIndexGroup[] {
  const groups = new Map<string, BrandIndexEntry[]>();
  for (const brand of brands) {
    const name = brand.name.trim();
    const href = `/brand/${brand.slug}`;
    if (name === "" || !isAllowedInternalHref(href)) continue;
    const letter = groupLetter(name);
    const list = groups.get(letter) ?? [];
    list.push({ slug: brand.slug, name, productCount: Math.max(0, brand.productCount), href });
    groups.set(letter, list);
  }
  const collator = new Intl.Collator("en", { sensitivity: "base" });
  return [...groups.entries()]
    .sort(([a], [b]) => (a === OTHER_GROUP ? 1 : b === OTHER_GROUP ? -1 : a.localeCompare(b)))
    .map(([letter, list]) => ({ letter, brands: list.sort((x, y) => collator.compare(x.name, y.name)) }));
}

export function brandCountLabel(count: number): string {
  return `${count} ${count === 1 ? "product" : "products"}`;
}

/** "12 brands" / "1 brand": the count shown next to the grid heading. */
export function brandTotalLabel(count: number): string {
  return `${count} ${count === 1 ? "brand" : "brands"}`;
}

/** Id of the single grid section's h2 (T177/U05). */
export const BRANDS_GRID_HEADING_ID = "brands-all";
export const BRANDS_GRID_HEADING = "All brands";

/** Product counts are published-only at `deps.now()` (read once per request). */
export function loadBrandsPage(deps: Pick<ListingPageDeps, "brands" | "now"> = getListingPageDeps()): BrandsPageView {
  const crumbs: Crumb[] = [{ label: "Home", href: "/" }, { label: BRANDS_TITLE }];
  const groups = groupBrands(deps.brands.listWithCounts(deps.now()));
  return {
    title: BRANDS_TITLE,
    breadcrumb: templateBreadcrumb(crumbs),
    groups,
    brands: groups.flatMap((group) => group.brands),
    jsonLd: listingBreadcrumbJsonLd(crumbs, BRANDS_PATH),
  };
}

/** Indexable, canonical `/brands`. */
export function brandsMetadata(): Metadata {
  return buildMetadata({ title: BRANDS_TITLE, description: BRANDS_DESCRIPTION, path: BRANDS_PATH });
}
