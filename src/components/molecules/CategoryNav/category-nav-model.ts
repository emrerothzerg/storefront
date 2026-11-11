import { isAllowedInternalHref } from "@/content/routes";

/**
 * Pure model for CategoryNav (T143): validates the department list, builds
 * `/category/<slug>` hrefs and splits it into the visible row and the "More"
 * overflow. Every href passes `isAllowedInternalHref`; rejected ones are
 * omitted and reported in `rejected` (development warning only).
 */

/** One department, e.g. an entry of `DEPARTMENT_NAV` or a `categoryTree()` root. */
export interface CategoryNavItem {
  /** Category slug; the link goes to `/category/<slug>` (percent-encoded). */
  readonly slug: string;
  /** Visible link text (rendered as text, never HTML). */
  readonly label: string;
}

export interface CategoryNavLink {
  readonly slug: string;
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

/** Optional non-department link shown first in the row (e.g. Deals). */
export interface CategoryNavLeading {
  readonly label: string;
  /** Internal route; must pass `isAllowedInternalHref`, otherwise the link is omitted. */
  readonly href: string;
}

export interface CategoryNavModel {
  /** Validated leading link, or `null`. Not counted toward `maxVisible`. */
  readonly leading: CategoryNavLeading | null;
  readonly visible: readonly CategoryNavLink[];
  readonly overflow: readonly CategoryNavLink[];
  /** Hrefs that failed validation (for a development warning only). */
  readonly rejected: readonly string[];
}

/** Direct links shown before the "More" overflow when `maxVisible` is omitted or invalid. */
export const CATEGORY_NAV_DEFAULT_MAX_VISIBLE = 9;
/** Accessible name of the nav landmark (unique per page; DepartmentMenu uses "Departments"). */
export const CATEGORY_NAV_LABEL = "Primary";
/** Summary text of the overflow `<details>`. */
export const CATEGORY_NAV_MORE_LABEL = "More";

/** `/category/<slug>` with the slug percent-encoded so `?`, `#` or `/` cannot change the path. */
export function categoryNavHref(slug: string): string {
  return `/category/${encodeURIComponent(slug)}`;
}

/** Integer >= 1, otherwise the default (NaN, Infinity, 0, negatives, non-numbers). */
export function normalizeMaxVisible(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return CATEGORY_NAV_DEFAULT_MAX_VISIBLE;
  const whole = Math.floor(value);
  return whole >= 1 ? whole : CATEGORY_NAV_DEFAULT_MAX_VISIBLE;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function buildCategoryNavModel(input: {
  departments: readonly CategoryNavItem[] | null | undefined;
  currentSlug?: string | null;
  maxVisible?: number;
  leading?: CategoryNavLeading | null;
}): CategoryNavModel {
  const rejected: string[] = [];
  let leading: CategoryNavLeading | null = null;
  const lead = input.leading;
  if (lead && hasText(lead.label) && hasText(lead.href)) {
    const href = lead.href.trim();
    if (isAllowedInternalHref(href)) leading = { label: lead.label.trim(), href };
    else rejected.push(href);
  }
  const links: CategoryNavLink[] = [];
  const seen = new Set<string>();
  const current = hasText(input.currentSlug) ? input.currentSlug.trim() : null;
  for (const item of input.departments ?? []) {
    if (!item || !hasText(item.slug) || !hasText(item.label)) continue;
    const slug = item.slug.trim();
    const href = categoryNavHref(slug);
    if (!isAllowedInternalHref(href)) {
      rejected.push(href);
      continue;
    }
    if (seen.has(href)) continue;
    seen.add(href);
    links.push({ slug, label: item.label.trim(), href, current: current !== null && slug === current });
  }
  const max = normalizeMaxVisible(input.maxVisible);
  return { leading, visible: links.slice(0, max), overflow: links.slice(max), rejected };
}
