/**
 * Route policy table (T112): one entry per `src/app/**\/page.tsx` route.
 * Pure data, framework-free. It drives the sitemap's static entries and the
 * dynamic-route sources (`app/sitemap.ts`), and it is the contract the SEO
 * audit tests check every page's metadata and robots.txt against.
 *
 * Adding a page: add an entry here (the route test enumerates the files on
 * disk and fails for a page without an entry, or an entry without a page).
 * See `README.md` in this folder.
 */

/**
 * - `indexable`: no `robots` metadata (inherits the layout's index, follow).
 * - `noindex`: `robots: { index: false, follow: false }`.
 * - `noindex-follow`: `robots: { index: false, follow: true }` (links stay crawlable).
 */
export type RouteIndexing = "indexable" | "noindex" | "noindex-follow";

/**
 * - `self`: canonical is the absolute URL of the route's own path, query ignored.
 * - `listing`: plain page 1 -> base path; plain page N -> itself (`?page=N`);
 *   faceted or re-sorted -> page-1 base path plus `noindex, follow`.
 * - `search`: `/search?q=<q>` (facets and page dropped).
 * - `none`: no canonical and no `og:url` (the URL carries a private id/token).
 */
export type CanonicalRule = "self" | "listing" | "search" | "none";

/** Where the sitemap gets the slugs of a dynamic route. */
export type SitemapSource = "products" | "categories" | "brands" | "help-topics";

/** A query-string variant whose policy differs from the base route. */
export interface RouteVariantPolicy {
  readonly description: string;
  /** Representative query used by the audit test. */
  readonly sampleSearchParams: Readonly<Record<string, string>>;
  readonly indexing: RouteIndexing;
}

export interface RoutePolicy {
  /** App Router pattern, e.g. `/category/[slug]`. */
  readonly route: string;
  /** Page file relative to the app root, e.g. `src/app/category/[slug]/page.tsx`. */
  readonly file: string;
  readonly indexing: RouteIndexing;
  /** Listed in /sitemap.xml (static path, or every slug of `sitemapSource`). */
  readonly sitemap: boolean;
  /** Required when a dynamic route is in the sitemap. */
  readonly sitemapSource?: SitemapSource;
  readonly canonical: CanonicalRule;
  /** Disallowed in robots.txt (by a prefix in `ROBOTS_DISALLOW`). */
  readonly robotsDisallowed: boolean;
  /** Query variants with a different indexing class (faceted listings, help search). */
  readonly variants?: readonly RouteVariantPolicy[];
}

const FACETED: readonly RouteVariantPolicy[] = [
  { description: "faceted (filter applied)", sampleSearchParams: { rating: "4" }, indexing: "noindex-follow" },
];

const COLLECTION_VARIANTS: readonly RouteVariantPolicy[] = [
  ...FACETED,
  { description: "re-sorted", sampleSearchParams: { sort: "price_asc" }, indexing: "noindex-follow" },
];

function indexable(route: string, file: string, canonical: CanonicalRule = "self"): RoutePolicy {
  return { route, file, indexing: "indexable", sitemap: true, canonical, robotsDisallowed: false };
}

function privatePage(route: string, file: string, canonical: CanonicalRule): RoutePolicy {
  return { route, file, indexing: "noindex", sitemap: false, canonical, robotsDisallowed: true };
}

export const ROUTE_POLICIES: readonly RoutePolicy[] = [
  // --- Indexable, in the sitemap -------------------------------------------
  indexable("/", "src/app/page.tsx"),
  { ...indexable("/products", "src/app/products/page.tsx", "listing"), variants: COLLECTION_VARIANTS },
  { ...indexable("/deals", "src/app/deals/page.tsx", "listing"), variants: COLLECTION_VARIANTS },
  { ...indexable("/best-sellers", "src/app/best-sellers/page.tsx", "listing"), variants: COLLECTION_VARIANTS },
  { ...indexable("/new-arrivals", "src/app/new-arrivals/page.tsx", "listing"), variants: COLLECTION_VARIANTS },
  {
    ...indexable("/top-rated", "src/app/top-rated/page.tsx", "listing"),
    variants: [
      ...COLLECTION_VARIANTS,
      // The route default sort spelled out is dropped by the route normaliser: still the canonical page.
      { description: "default sort in the URL", sampleSearchParams: { sort: "rating" }, indexing: "indexable" },
    ],
  },
  indexable("/brands", "src/app/brands/page.tsx"),
  {
    ...indexable("/brand/[slug]", "src/app/brand/[slug]/page.tsx", "listing"),
    sitemapSource: "brands",
    variants: FACETED,
  },
  {
    ...indexable("/category/[slug]", "src/app/category/[slug]/page.tsx", "listing"),
    sitemapSource: "categories",
    variants: FACETED,
  },
  { ...indexable("/products/[slug]", "src/app/products/[slug]/page.tsx"), sitemapSource: "products" },
  {
    ...indexable("/help", "src/app/help/page.tsx"),
    variants: [{ description: "help search (?q=)", sampleSearchParams: { q: "refund" }, indexing: "noindex" }],
  },
  { ...indexable("/help/[topic]", "src/app/help/[topic]/page.tsx"), sitemapSource: "help-topics" },
  indexable("/faq", "src/app/faq/page.tsx"),
  indexable("/about", "src/app/about/page.tsx"),
  indexable("/shipping", "src/app/shipping/page.tsx"),
  indexable("/returns", "src/app/returns/page.tsx"),
  indexable("/privacy", "src/app/privacy/page.tsx"),
  indexable("/terms", "src/app/terms/page.tsx"),
  indexable("/accessibility", "src/app/accessibility/page.tsx"),

  // --- noindex, follow (crawl blocked by robots.txt) ------------------------
  {
    route: "/search",
    file: "src/app/search/page.tsx",
    indexing: "noindex-follow",
    sitemap: false,
    canonical: "search",
    robotsDisallowed: true,
  },
  {
    route: "/compare",
    file: "src/app/compare/page.tsx",
    indexing: "noindex-follow",
    sitemap: false,
    canonical: "self",
    robotsDisallowed: true,
  },

  // --- noindex, crawlable so the noindex is seen (T127 ruling; /contact by the orchestrator ruling) ---
  { route: "/contact", file: "src/app/contact/page.tsx", indexing: "noindex", sitemap: false, canonical: "self", robotsDisallowed: false },
  { route: "/signin", file: "src/app/signin/page.tsx", indexing: "noindex", sitemap: false, canonical: "self", robotsDisallowed: false },
  { route: "/signup", file: "src/app/signup/page.tsx", indexing: "noindex", sitemap: false, canonical: "self", robotsDisallowed: false },

  // --- noindex, disallowed in robots.txt ------------------------------------
  privatePage("/cart", "src/app/cart/page.tsx", "self"),
  privatePage("/checkout", "src/app/checkout/page.tsx", "self"),
  privatePage("/account", "src/app/account/page.tsx", "self"),
  privatePage("/account/addresses", "src/app/account/addresses/page.tsx", "self"),
  privatePage("/account/alerts", "src/app/account/alerts/page.tsx", "self"),
  privatePage("/account/contributions", "src/app/account/contributions/page.tsx", "self"),
  privatePage("/account/history", "src/app/account/history/page.tsx", "self"),
  privatePage("/account/messages", "src/app/account/messages/page.tsx", "self"),
  privatePage("/account/settings", "src/app/account/settings/page.tsx", "self"),
  privatePage("/lists", "src/app/lists/page.tsx", "self"),
  privatePage("/lists/[id]", "src/app/lists/[id]/page.tsx", "none"),
  privatePage("/lists/shared/[token]", "src/app/lists/shared/[token]/page.tsx", "none"),
  privatePage("/orders", "src/app/orders/page.tsx", "self"),
  privatePage("/orders/[id]", "src/app/orders/[id]/page.tsx", "none"),
  privatePage("/orders/[id]/invoice", "src/app/orders/[id]/invoice/page.tsx", "none"),
];

/** True when the route pattern has a dynamic segment (`[x]`). */
export function isDynamicRoute(route: string): boolean {
  return /\[[^\]]+\]/.test(route);
}

/** Static routes listed in the sitemap, in table order. */
export function staticSitemapRoutes(policies: readonly RoutePolicy[] = ROUTE_POLICIES): string[] {
  return policies.filter((p) => p.sitemap && !isDynamicRoute(p.route)).map((p) => p.route);
}

/** Dynamic sitemap routes with their slug source, in table order. */
export function dynamicSitemapRoutes(
  policies: readonly RoutePolicy[] = ROUTE_POLICIES,
): { readonly route: string; readonly source: SitemapSource }[] {
  const out: { route: string; source: SitemapSource }[] = [];
  for (const p of policies) {
    if (p.sitemap && isDynamicRoute(p.route) && p.sitemapSource !== undefined) {
      out.push({ route: p.route, source: p.sitemapSource });
    }
  }
  return out;
}

/** Fills the single dynamic segment of `route` with an encoded slug. */
export function fillRoute(route: string, slug: string): string {
  return route.replace(/\[[^\]]+\]/, encodeURIComponent(slug));
}

/** Route pattern for a page file path relative to the project root (`src/app/a/[b]/page.tsx` -> `/a/[b]`). */
export function routeFromPageFile(file: string): string {
  const normalized = file.replace(/\\/g, "/");
  const inner = normalized.replace(/^src\/app/, "").replace(/\/page\.tsx$/, "");
  // Route groups `(x)` do not appear in the URL.
  const segments = inner.split("/").filter((s) => s !== "" && !/^\(.*\)$/.test(s));
  return `/${segments.join("/")}`;
}

/** The policy for an App Router pattern, or `undefined`. */
export function policyFor(route: string, policies: readonly RoutePolicy[] = ROUTE_POLICIES): RoutePolicy | undefined {
  return policies.find((p) => p.route === route);
}

/**
 * robots.txt prefix matching (RFC 9309, no wildcards): true when `path`
 * starts with any disallow rule.
 */
export function isDisallowedPath(path: string, disallow: readonly string[]): boolean {
  return disallow.some((rule) => rule !== "" && path.startsWith(rule));
}
