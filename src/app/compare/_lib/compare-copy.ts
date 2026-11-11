/** Page copy (kept out of page.tsx: Next allows only route exports there). */
export const COMPARE_TITLE = "Compare products";
export const COMPARE_DESCRIPTION =
  "Compare prices, ratings and specifications of up to four products side by side.";
/**
 * Intro line under the heading: only when there is something to compare
 * (>= 2 products). With fewer, CompareTable's own "Add at least two
 * products to compare" notice is the single guidance (CONS-B4 aw).
 */
export function compareIntro(count: number): string | null {
  return Number.isInteger(count) && count >= 2 ? `Comparing ${count} products.` : null;
}
export const COMPARE_BREADCRUMB_LABEL = "Compare";
/** Shown when malformed, unknown or unpublished selections were dropped (the values are never echoed). */
export const COMPARE_UNAVAILABLE_NOTICE =
  "Some selected products are unavailable and were removed from the comparison.";
/** Shown when more than 4 products were requested. */
export const COMPARE_CAPPED_NOTICE = "You can compare up to 4 products at a time. Only the first 4 are shown.";
