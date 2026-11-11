/** Compare page route. Its query string is the whole compare state (D9). */
export const COMPARE_PATH = "/compare";
/** Default maximum number of compared products (input limits table). */
export const COMPARE_MAX = 4;
/** Query parameter holding one product slug per occurrence. */
export const COMPARE_PARAM = "p";

function normaliseMax(max: number): number {
  return Number.isFinite(max) && max >= 1 ? Math.floor(max) : COMPARE_MAX;
}

/**
 * Trims, drops empty values, removes duplicates (first occurrence wins) and
 * keeps at most `max` slugs. Pure.
 */
export function normaliseCompareSlugs(
  slugs: readonly string[],
  max: number = COMPARE_MAX,
): string[] {
  const limit = normaliseMax(max);
  const out: string[] = [];
  for (const raw of slugs) {
    if (typeof raw !== "string") continue;
    const slug = raw.trim();
    if (slug === "" || out.includes(slug)) continue;
    out.push(slug);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * The slugs after toggling `toggleSlug`: removed when present, appended when
 * absent and there is room, otherwise unchanged (a 5th selection is refused).
 */
export function toggleCompareSlugs(
  selected: readonly string[],
  toggleSlug: string,
  max: number = COMPARE_MAX,
): string[] {
  const limit = normaliseMax(max);
  const current = normaliseCompareSlugs(selected, limit);
  const slug = toggleSlug.trim();
  if (slug === "") return current;
  if (current.includes(slug)) return current.filter((s) => s !== slug);
  if (current.length >= limit) return current;
  return [...current, slug];
}

/** `/compare?p=a&p=b` for the given slugs (encoded with URLSearchParams); `/compare` when empty. */
export function compareHref(slugs: readonly string[]): string {
  const params = new URLSearchParams();
  for (const slug of slugs) params.append(COMPARE_PARAM, slug);
  const query = params.toString();
  return query ? `${COMPARE_PATH}?${query}` : COMPARE_PATH;
}

/**
 * Compare URL after toggling `toggleSlug` in `selected`: dedupes, caps at
 * `max` (default 4), removes the slug when it is already selected, refuses to
 * add beyond the cap, and encodes every slug with URLSearchParams.
 *
 * buildComparePath(["a"], "b")      === "/compare?p=a&p=b"
 * buildComparePath(["a", "b"], "a") === "/compare?p=b"
 */
export function buildComparePath(
  selected: readonly string[],
  toggleSlug: string,
  max: number = COMPARE_MAX,
): string {
  return compareHref(toggleCompareSlugs(selected, toggleSlug, max));
}
