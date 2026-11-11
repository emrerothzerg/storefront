import {
  COMPARE_MAX,
  COMPARE_PARAM,
  COMPARE_PATH,
  normaliseCompareSlugs,
} from "@/components/molecules/CompareToggle/compare-path";
import type { ProductDetail } from "@/lib/types";

/** Query parameter that turns on "differences only" (`diff=1`). */
export const COMPARE_DIFF_PARAM = "diff";

/** One comparison row: one value per product column (null = not specified). */
export interface CompareRow {
  readonly label: string;
  readonly values: (string | null)[];
  /** True when every column holds the same value (nulls count as a value). */
  readonly allEqual: boolean;
}

/** True when every entry equals the first one (`null` only equals `null`). One or zero entries: true. */
export function valuesAllEqual(values: readonly (string | null)[]): boolean {
  if (values.length === 0) return true;
  const first = values[0];
  return values.every((value) => value === first);
}

function cleanText(value: string): string {
  return value.trim();
}

/**
 * Union of spec labels across `products` in first-seen order (labels compared
 * after trimming; empty labels skipped). A product without the label, or with
 * an empty value, gets `null`. When a product repeats a label the first value wins.
 */
export function specRows(products: readonly ProductDetail[]): CompareRow[] {
  const labels: string[] = [];
  const perProduct: Map<string, string>[] = products.map((product) => {
    const map = new Map<string, string>();
    for (const spec of product.specs) {
      const label = cleanText(spec.label);
      if (label === "") continue;
      if (!labels.includes(label)) labels.push(label);
      if (!map.has(label)) {
        const value = cleanText(spec.value);
        if (value !== "") map.set(label, value);
      }
    }
    return map;
  });
  return labels.map((label) => {
    const values = perProduct.map((map) => map.get(label) ?? null);
    return { label, values, allEqual: valuesAllEqual(values) };
  });
}

/** All rows, or only those whose values differ when `differencesOnly` is on. */
export function visibleRows<R extends { readonly allEqual: boolean }>(
  rows: readonly R[],
  differencesOnly: boolean,
): R[] {
  return differencesOnly ? rows.filter((row) => !row.allEqual) : [...rows];
}

/**
 * `basePath` reduced to a safe root-relative path (query and hash dropped);
 * anything else (absolute, protocol-relative, backslashes, empty) falls back
 * to `/compare`.
 */
export function safeCompareBase(basePath: string | undefined): string {
  if (typeof basePath !== "string") return COMPARE_PATH;
  const cut = basePath.search(/[?#]/);
  const path = (cut === -1 ? basePath : basePath.slice(0, cut)).trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return COMPARE_PATH;
  return path;
}

/**
 * `${basePath}?p=a&p=b[&diff=1]`: slugs normalised (trimmed, deduped, max 4)
 * and encoded with URLSearchParams. No slugs and no diff -> bare `basePath`.
 */
export function compareStateHref(
  basePath: string,
  slugs: readonly string[],
  differencesOnly: boolean = false,
): string {
  const params = new URLSearchParams();
  for (const slug of normaliseCompareSlugs(slugs, COMPARE_MAX)) params.append(COMPARE_PARAM, slug);
  if (differencesOnly) params.set(COMPARE_DIFF_PARAM, "1");
  const query = params.toString();
  const base = safeCompareBase(basePath);
  return query ? `${base}?${query}` : base;
}

/**
 * Link target of the "Differences only" toggle. `differencesOnly` is the
 * CURRENT state: off -> `?p=…&diff=1`, on -> `?p=…` (diff removed).
 */
export function toggleDifferencesHref(
  basePath: string,
  slugs: readonly string[],
  differencesOnly: boolean,
): string {
  return compareStateHref(basePath, slugs, !differencesOnly);
}

/**
 * Compare URL without `slug` (other slugs keep their order; never adds a slug
 * that is not selected). Keeps `diff=1` when `differencesOnly` is passed.
 *
 * removeHref("/compare", ["a", "b", "c"], "b") === "/compare?p=a&p=c"
 */
export function removeHref(
  basePath: string,
  slugs: readonly string[],
  slug: string,
  differencesOnly: boolean = false,
): string {
  const target = slug.trim();
  const remaining = normaliseCompareSlugs(slugs, COMPARE_MAX).filter((s) => s !== target);
  return compareStateHref(basePath, remaining, differencesOnly);
}

/**
 * Products deduplicated by id (first occurrence wins), then at most
 * `COMPARE_MAX` of them plus the deduplicated count (for the truncation notice).
 */
export function truncateProducts(products: readonly ProductDetail[]): {
  shown: ProductDetail[];
  total: number;
  truncated: boolean;
} {
  const seen = new Set<string>();
  const unique: ProductDetail[] = [];
  for (const product of products) {
    if (seen.has(product.id)) continue;
    seen.add(product.id);
    unique.push(product);
  }
  const shown = unique.slice(0, COMPARE_MAX);
  return { shown, total: unique.length, truncated: unique.length > COMPARE_MAX };
}

/**
 * Slugs to carry in Remove / "Differences only" links: the selected slugs
 * (normalised, selection order kept) that belong to a shown product, so a slug
 * matching no product never sticks in every link. Falls back to the shown
 * products' slugs when none of the selected ones match (or none were given).
 */
export function linkSlugs(selectedSlugs: readonly string[], shown: readonly ProductDetail[]): string[] {
  const shownSlugs = shown.map((p) => p.slug.trim()).filter((s) => s !== "");
  const allowed = new Set(shownSlugs);
  const kept = normaliseCompareSlugs(selectedSlugs, COMPARE_MAX).filter((s) => allowed.has(s));
  return kept.length > 0 ? kept : shownSlugs;
}
