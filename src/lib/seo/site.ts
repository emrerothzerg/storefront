/**
 * Site-wide SEO configuration. Pure and framework-free (safe on server and
 * client). Rename the store by changing `SITE_NAME` only.
 *
 * Environment:
 * - `NEXT_PUBLIC_SITE_URL`: public origin (optionally with a base path) used
 *   for canonical URLs, Open Graph URLs, JSON-LD, sitemap and robots, e.g.
 *   `https://shop.example.com`. Trimmed; trailing slashes, query and hash are
 *   dropped. Anything that is not an absolute http(s) URL falls back to
 *   `DEFAULT_SITE_URL`. `NEXT_PUBLIC_*` values are inlined by `next build`,
 *   so set it at build time as well as at runtime.
 */

/** Placeholder store name; the one constant to change when renaming. */
export const SITE_NAME = "Northwind Goods";

/** Short name for the web app manifest (home-screen label). */
export const SITE_SHORT_NAME = "Northwind";

export const SITE_DESCRIPTION =
  "Shop quality everyday goods at Northwind Goods: browse the catalog, add products to your cart and check out as a guest.";

export const DEFAULT_SITE_URL = "http://localhost:3000";

/**
 * Brand colours for the manifest and `viewport.themeColor` (light only; there
 * is no dark theme). They mirror the raw token values documented in
 * `src/app/globals.css`: the primary `--accent` (#1d4ed8) as the theme colour
 * and `--surface-page` (#ffffff, white) as the splash background. Kept here,
 * outside `src/app`, because the manifest and viewport need raw colour
 * strings and `check:tokens` forbids raw hex under `src/app`. Update both
 * together with the tokens (asserted by site.test.ts, manifest.test.ts and
 * the G08 redesign guard).
 */
export const THEME_COLOR = "#1d4ed8";
export const BACKGROUND_COLOR = "#ffffff";

/**
 * The public site URL without a trailing slash, e.g. `https://shop.example.com`
 * or `https://example.com/store`. Read on every call so tests and runtime
 * configuration changes are honoured.
 */
export function getSiteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return DEFAULT_SITE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return DEFAULT_SITE_URL;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_SITE_URL;
  if (url.username || url.password) return DEFAULT_SITE_URL;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Absolute URL for a site path. `path` may omit the leading slash; an already
 * absolute http(s) URL is returned unchanged (e.g. a CDN image).
 *
 * absoluteUrl("/products/x") === "https://shop.example.com/products/x"
 * absoluteUrl("/")           === "https://shop.example.com/"
 */
export function absoluteUrl(path: string): string {
  const trimmed = path.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const normalized = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return `${getSiteUrl()}${normalized}`;
}

/**
 * Private, per-session or low-value routes kept out of crawling (robots.txt).
 * Prefix rules: "/account" also covers "/account/settings", "/lists" covers
 * "/lists/shared/<token>". `/signin`, `/signup` and `/contact` are
 * deliberately absent: they are noindex and must stay crawlable so the
 * noindex is seen (T127 ruling; /contact by orchestrator ruling).
 * Never add "/_next/", CSS/JS or image paths here. Kept in sync with
 * `robotsDisallowed` in `routes.ts` (asserted by `routes.test.ts`).
 */
export const ROBOTS_DISALLOW: readonly string[] = [
  "/cart",
  "/checkout",
  "/orders",
  "/orders/",
  "/account",
  "/lists",
  "/search",
  "/api/",
  "/compare",
];
