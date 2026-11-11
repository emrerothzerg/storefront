/**
 * Pure helper for the header cart badge (T20). No server imports, so it is
 * trivially unit-testable.
 */
export interface HeaderCartTotals {
  readonly itemCount: number;
}

/**
 * Maps cart totals (or their absence) to the count shown in the site header.
 * Missing totals, non-finite, non-integer or negative counts all become 0.
 */
export function resolveHeaderCartCount(totals: HeaderCartTotals | null | undefined): number {
  if (totals === null || totals === undefined) return 0;
  const { itemCount } = totals;
  if (typeof itemCount !== "number" || !Number.isFinite(itemCount) || itemCount < 0) return 0;
  return Math.floor(itemCount);
}
