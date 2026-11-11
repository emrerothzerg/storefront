/** Default maximum length (UTF-16 code units, ellipsis included) of a list-layout description excerpt. */
export const EXCERPT_MAX = 160;

const ELLIPSIS = "…";

/** Grapheme clusters when `Intl.Segmenter` exists, else code points (never splits a surrogate pair). */
function segments(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * Plain-text excerpt: whitespace collapsed and trimmed; when longer than `max`
 * UTF-16 code units it is cut on a grapheme boundary (preferring the last word
 * break in the second half) and ends with "…", so the result including the
 * ellipsis is never longer than `max`. The ellipsis is added only when the text
 * was actually truncated. Non-string input yields ""; an invalid `max` (NaN,
 * < 2, non-integer) falls back to 160.
 */
export function excerpt(text: string, max: number = EXCERPT_MAX): string {
  if (typeof text !== "string") return "";
  const limit = Number.isInteger(max) && max >= 2 ? max : EXCERPT_MAX;
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= limit) return clean;

  const budget = limit - ELLIPSIS.length;
  let cut = "";
  for (const segment of segments(clean)) {
    if (cut.length + segment.length > budget) break;
    cut += segment;
  }
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace >= Math.floor(budget / 2)) cut = cut.slice(0, lastSpace);
  cut = cut.trimEnd().replace(/[\s,.;:!?–—-]+$/u, "");
  return `${cut}${ELLIPSIS}`;
}
