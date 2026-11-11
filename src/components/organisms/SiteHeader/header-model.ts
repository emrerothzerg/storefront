import { isAllowedInternalHref } from "@/content/routes";

/**
 * Pure helpers for SiteHeader (T17, T80). No React, no server imports.
 */

export interface HeaderLink {
  readonly label: string;
  readonly href: string;
}

/** Visible badge cap: 100+ items show "99+". */
export const MAX_VISIBLE_CART_COUNT = 99;

/** Normalises a raw cart count: negative, non-integer or non-finite values become 0. */
export function normalizeCartCount(count: number): number {
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/** "Cart, 0 items" / "Cart, 1 item" / "Cart, 3 items" (uses the normalised count). */
export function cartAccessibleName(count: number): string {
  const n = normalizeCartCount(count);
  return `Cart, ${n} ${n === 1 ? "item" : "items"}`;
}

/** Badge text: the count, or "99+" above the cap. */
export function visibleCartCount(count: number): string {
  const n = normalizeCartCount(count);
  return n > MAX_VISIBLE_CART_COUNT ? `${MAX_VISIBLE_CART_COUNT}+` : String(n);
}

/**
 * Display-name helpers moved to the neutral `src/lib/display-name.ts`
 * (CONS-B4 bh) so molecules can use them without importing an organism;
 * re-exported here so existing imports keep working.
 */
export { MAX_VISIBLE_NAME_LENGTH, cleanDisplayName, truncateDisplayName } from "@/lib/display-name";

/** Keeps links with a non-empty label whose href passes `isAllowedInternalHref`; drops duplicates by href. */
export function allowedLinks<T extends HeaderLink>(links: readonly T[] | undefined): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const link of links ?? []) {
    if (typeof link?.label !== "string" || link.label.trim() === "") continue;
    if (typeof link.href !== "string" || !isAllowedInternalHref(link.href)) continue;
    if (seen.has(link.href)) continue;
    seen.add(link.href);
    out.push(link);
  }
  return out;
}

/** True when `href` is the current page or an ancestor section of it ("/" only matches itself). */
export function isCurrentPath(href: string, currentPath: string | undefined): boolean {
  if (currentPath === undefined) return false;
  if (href === "/") return currentPath === "/";
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

const CATEGORY_PATH = /^\/category\/([^/?#]+)(?:[/?#]|$)/;

/**
 * Department slug for CategoryNav's `aria-current` (T148): `/category/<slug>`
 * (and anything below it) gives the decoded slug; any other path, a missing
 * path or a malformed escape gives `null`.
 */
export function categorySlugFromPath(currentPath: string | undefined): string | null {
  if (typeof currentPath !== "string") return null;
  const match = CATEGORY_PATH.exec(currentPath);
  if (match === null || match[1] === undefined) return null;
  try {
    const slug = decodeURIComponent(match[1]).trim();
    return slug === "" ? null : slug;
  } catch {
    return null;
  }
}

export interface PromoCoupon {
  readonly code: string;
  /** Coupon service text, e.g. "10% off", "Free shipping on orders of $20.00 or more". */
  readonly description: string;
}

const COUPON_CODE = /^[A-Z0-9_-]{1,32}$/;

/**
 * "Use code WELCOME10 for 10% off". Returns null for a missing coupon, an
 * empty description or a code outside the coupon charset (upper case,
 * `[A-Z0-9_-]`, 1..32).
 */
export function couponPromoParts(coupon: PromoCoupon | null | undefined): { code: string; tail: string } | null {
  if (coupon === null || coupon === undefined) return null;
  const code = typeof coupon.code === "string" ? coupon.code.trim() : "";
  const description = typeof coupon.description === "string" ? coupon.description.trim() : "";
  if (!COUPON_CODE.test(code) || description === "") return null;
  const lowered = /^Free shipping/.test(description) ? `f${description.slice(1)}` : description;
  return { code, tail: ` for ${lowered}` };
}
