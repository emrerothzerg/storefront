import { isAllowedInternalHref } from "@/content/routes";

/** Rendered in place of any href that fails the route allowlist. */
export const UNSAFE_HREF_FALLBACK = "#";

/**
 * Returns `href` when it is a root-relative link to a planned route
 * (`isAllowedInternalHref`), otherwise `"#"`. Rejected hrefs (`javascript:`,
 * `//evil.example`, absolute URLs, unknown paths) log a warning outside
 * production so the bad caller is easy to find; production stays silent.
 * Server-safe: runs during render, no effects.
 */
export function resolveInternalHref(href: string, component: string): string {
  if (isAllowedInternalHref(href)) return href;
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `${component}: href ${JSON.stringify(href)} is not an allowed internal route; rendering "${UNSAFE_HREF_FALLBACK}" instead.`,
    );
  }
  return UNSAFE_HREF_FALLBACK;
}
