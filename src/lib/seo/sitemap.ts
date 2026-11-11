import type { MetadataRoute } from "next";

import { ROUTE_POLICIES, dynamicSitemapRoutes, fillRoute, staticSitemapRoutes, type RoutePolicy, type SitemapSource } from "./routes";
import { absoluteUrl } from "./site";

/**
 * A product as the sitemap needs it. `updatedAt` (ISO 8601, from
 * `listSlugsWithUpdatedAt()`) is optional: `lastModified` is only emitted for
 * a valid timestamp (an invented date would mislead crawlers).
 */
export interface SitemapProduct {
  readonly slug: string;
  readonly updatedAt?: string;
}

function validDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Reads an optional `updatedAt` from any product-like object at runtime, so
 * a catalogue row that gains the field later is picked up without a type
 * change here.
 */
export function toSitemapProduct(product: { readonly slug: string }): SitemapProduct {
  const updatedAt = "updatedAt" in product ? product.updatedAt : undefined;
  return typeof updatedAt === "string" ? { slug: product.slug, updatedAt } : { slug: product.slug };
}

/**
 * Sitemap entries: the home page plus one URL per product. Duplicate or
 * empty slugs are skipped. The home page's `lastModified` is the newest
 * product timestamp, when there is one.
 */
export function buildSitemapEntries(products: readonly SitemapProduct[]): MetadataRoute.Sitemap {
  const seen = new Set<string>();
  const productEntries: MetadataRoute.Sitemap = [];
  let newest: Date | undefined;

  for (const product of products) {
    const slug = product.slug.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const lastModified = validDate(product.updatedAt);
    if (lastModified && (!newest || lastModified > newest)) newest = lastModified;
    productEntries.push({
      url: absoluteUrl(`/products/${encodeURIComponent(slug)}`),
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: "weekly",
      priority: 0.8,
    });
  }

  return [
    {
      url: absoluteUrl("/"),
      ...(newest ? { lastModified: newest } : {}),
      changeFrequency: "daily",
      priority: 1,
    },
    ...productEntries,
  ];
}

// ---------------------------------------------------------------------------
// Full site sitemap (T112)
// ---------------------------------------------------------------------------

/**
 * Most URLs one sitemap file may hold (sitemaps.org protocol). The catalogue
 * cannot get near it (see README "Sitemap size"); `buildSiteSitemap` caps at
 * this number and reports the overflow instead of emitting an invalid file.
 */
export const SITEMAP_URL_LIMIT = 50_000;

/** A taxonomy row as the sitemap needs it; `updatedAt` only when the repository exposes one. */
export interface SitemapSlug {
  readonly slug: string;
  readonly updatedAt?: string;
}

/** Slugs per dynamic sitemap source. Products must already be filtered to published ones. */
export interface SiteSitemapData {
  readonly products: readonly SitemapProduct[];
  readonly categories: readonly SitemapSlug[];
  readonly brands: readonly SitemapSlug[];
  readonly helpTopics: readonly SitemapSlug[];
}

export interface SiteSitemapOptions {
  /** Defaults to `staticSitemapRoutes()` / `dynamicSitemapRoutes()` from the policy table. */
  readonly policies?: readonly RoutePolicy[];
  readonly limit?: number;
  /** Called once when entries were dropped to respect `limit`. */
  readonly onOverflow?: (total: number, limit: number) => void;
}

type ChangeFrequency = NonNullable<MetadataRoute.Sitemap[number]["changeFrequency"]>;

interface EntryStyle {
  readonly changeFrequency: ChangeFrequency;
  readonly priority: number;
}

const COLLECTION_ROUTES: ReadonlySet<string> = new Set(["/products", "/deals", "/best-sellers", "/new-arrivals", "/top-rated"]);

function staticStyle(route: string): EntryStyle {
  if (route === "/") return { changeFrequency: "daily", priority: 1 };
  if (COLLECTION_ROUTES.has(route)) return { changeFrequency: "daily", priority: 0.8 };
  if (route === "/brands") return { changeFrequency: "weekly", priority: 0.6 };
  return { changeFrequency: "monthly", priority: 0.3 };
}

const SOURCE_STYLE: { readonly [K in SitemapSource]: EntryStyle } = {
  products: { changeFrequency: "weekly", priority: 0.8 },
  categories: { changeFrequency: "weekly", priority: 0.7 },
  brands: { changeFrequency: "weekly", priority: 0.6 },
  "help-topics": { changeFrequency: "monthly", priority: 0.3 },
};

function slugsFor(source: SitemapSource, data: SiteSitemapData): readonly SitemapSlug[] {
  switch (source) {
    case "products":
      return data.products;
    case "categories":
      return data.categories;
    case "brands":
      return data.brands;
    case "help-topics":
      return data.helpTopics;
  }
}

function defaultOverflow(total: number, limit: number): void {
  console.error(`[sitemap] ${total} URLs exceed the ${limit} limit; extra entries dropped (see src/lib/seo/README.md)`);
}

/**
 * Every public indexable URL exactly once, absolute (`SITE_URL`): the static
 * sitemap routes of the policy table in table order, then each dynamic route
 * filled with its source's slugs. Blank slugs and duplicate URLs are skipped.
 * `lastModified` comes from `updatedAt` only when it is a valid date; the home
 * page gets the newest product timestamp. Pure: the caller loads the data.
 */
export function buildSiteSitemap(data: SiteSitemapData, options: SiteSitemapOptions = {}): MetadataRoute.Sitemap {
  const policies = options.policies ?? ROUTE_POLICIES;
  const limit = options.limit ?? SITEMAP_URL_LIMIT;
  const seen = new Set<string>();
  const entries: MetadataRoute.Sitemap = [];

  let newestProduct: Date | undefined;
  for (const product of data.products) {
    const date = validDate(product.updatedAt);
    if (date && (!newestProduct || date > newestProduct)) newestProduct = date;
  }

  const push = (path: string, style: EntryStyle, lastModified: Date | undefined): void => {
    const url = absoluteUrl(path);
    if (seen.has(url)) return;
    seen.add(url);
    entries.push({ url, ...(lastModified ? { lastModified } : {}), ...style });
  };

  for (const route of staticSitemapRoutes(policies)) {
    push(route, staticStyle(route), route === "/" ? newestProduct : undefined);
  }
  for (const { route, source } of dynamicSitemapRoutes(policies)) {
    for (const row of slugsFor(source, data)) {
      const slug = row.slug.trim();
      if (!slug) continue;
      push(fillRoute(route, slug), SOURCE_STYLE[source], validDate(row.updatedAt));
    }
  }

  if (entries.length > limit) {
    (options.onOverflow ?? defaultOverflow)(entries.length, limit);
    return entries.slice(0, limit);
  }
  return entries;
}
