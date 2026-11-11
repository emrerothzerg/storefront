import { ACCOUNT_NAV, AUTH_NAV, FOOTER_COLUMNS, FOOTER_QUICK_LINKS, PRIMARY_NAV, type NavLink } from "@/content/navigation";
import { isAllowedInternalHref } from "@/content/routes";

/** Labels for internal paths, taken from the typed navigation content (first label wins). */
const NAV_LABELS: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const all: readonly NavLink[] = [
    ...ACCOUNT_NAV,
    ...AUTH_NAV,
    ...FOOTER_COLUMNS.flatMap((column) => column.links),
    // After the account nav: "/orders" keeps "Your orders"; "/contact" gets "Contact us".
    ...FOOTER_QUICK_LINKS,
    ...PRIMARY_NAV,
  ];
  for (const link of all) if (!map.has(link.href)) map.set(link.href, link.label);
  return map;
})();

function humanize(segment: string): string {
  const words = segment.replace(/[-_]+/g, " ").trim();
  return words.length === 0 ? "Home" : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Visible label for a related FAQ link: the navigation label for that path
 * ("/signup" -> "Create account"), else the humanized last path segment
 * ("/checkout" -> "Checkout"). Query and fragment are ignored for lookup.
 */
export function faqRelatedLinkLabel(href: string): string {
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  const known = NAV_LABELS.get(path);
  if (known !== undefined) return known;
  const segments = path.split("/").filter(Boolean);
  return humanize(segments[segments.length - 1] ?? "");
}

/** Related hrefs that pass `isAllowedInternalHref`, de-duplicated, in order. */
export function safeRelatedHrefs(hrefs: readonly string[] | undefined): string[] {
  if (hrefs === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const href of hrefs) {
    if (typeof href !== "string" || seen.has(href) || !isAllowedInternalHref(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}
