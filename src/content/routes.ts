/**
 * Route allowlist for the Phase 2 site. Static content (FAQ links, header and
 * footer navigation, help topic links) may only point at routes listed here;
 * the colocated tests fail if a link targets a route that is not planned.
 *
 * Pattern syntax mirrors the App Router: a segment written as `[name]` matches
 * exactly one non-empty path segment; every other segment matches literally.
 */

export const PLANNED_ROUTES = [
  "/",
  "/products",
  "/products/[slug]",
  "/search",
  "/category/[slug]",
  "/brand/[slug]",
  "/brands",
  "/deals",
  "/best-sellers",
  "/new-arrivals",
  "/top-rated",
  "/cart",
  "/checkout",
  "/orders",
  "/orders/[id]",
  "/orders/[id]/invoice",
  "/account",
  "/account/addresses",
  "/account/history",
  "/account/contributions",
  "/account/alerts",
  "/account/messages",
  "/account/settings",
  "/signin",
  "/signup",
  "/lists",
  "/lists/[id]",
  "/lists/shared/[token]",
  "/compare",
  "/help",
  "/help/[topic]",
  "/faq",
  "/contact",
  "/about",
  "/shipping",
  "/returns",
  "/privacy",
  "/terms",
  "/accessibility",
] as const;

export type PlannedRoute = (typeof PLANNED_ROUTES)[number];

/** Allowed characters inside one dynamic path segment (URL-safe, percent-encoded allowed). */
const DYNAMIC_SEGMENT = /^[A-Za-z0-9._~%-]+$/;

const COMPILED: readonly (readonly string[])[] = PLANNED_ROUTES.map((route) =>
  route === "/" ? [] : route.slice(1).split("/"),
);

function isDynamic(patternSegment: string): boolean {
  return patternSegment.startsWith("[") && patternSegment.endsWith("]");
}

/**
 * URL parsers decode percent-encoded dots, so `%2e%2e` resolves like `..`.
 * Rejects malformed escapes and segments that decode to `.`, `..` or contain
 * a slash or backslash.
 */
function isSafeDecoded(segment: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return false;
  }
  return decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\");
}

function matches(pattern: readonly string[], segments: readonly string[]): boolean {
  if (pattern.length !== segments.length) return false;
  return pattern.every((part, index) => {
    const segment = segments[index];
    if (segment === undefined) return false;
    if (isDynamic(part)) {
      return segment !== "." && segment !== ".." && DYNAMIC_SEGMENT.test(segment) && isSafeDecoded(segment);
    }
    return part === segment;
  });
}

/**
 * True when `href` is a root-relative internal link whose path matches a
 * planned route. Query strings and hashes are ignored. Static paths must match
 * exactly (no trailing slash except `/` itself); protocol-relative (`//x`),
 * absolute (`https://...`) and relative (`foo`) hrefs are rejected.
 */
export function isAllowedInternalHref(href: string): boolean {
  if (typeof href !== "string" || href.length === 0 || href.length > 2048) return false;
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return false;
  if (path === "/") return true;
  if (path.endsWith("/")) return false;
  const segments = path.slice(1).split("/");
  return COMPILED.some((pattern) => matches(pattern, segments));
}
