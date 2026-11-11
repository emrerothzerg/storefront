/**
 * Pure helpers for StaticPage: heading slugs, unique section ids and the
 * "Last updated" date. No React, no DOM, so they are safe anywhere.
 */

/** Table of contents renders only when there are MORE than this many sections. */
export const STATIC_PAGE_TOC_THRESHOLD = 3;

const MAX_SLUG_LENGTH = 64;

/**
 * Lower-case, ASCII letters/digits joined by single hyphens. Anything else
 * (markup, quotes, emoji) is dropped, so the result is always a safe id and
 * URL fragment. Returns "" when nothing usable is left.
 */
export function slugifyHeading(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/**
 * One unique id per section, in order: the provided `id` (slugified) or the
 * slugified heading, falling back to `section-<n>`; repeats get `-2`, `-3`...
 * `reserved` ids (e.g. other ids on the page) are treated as already taken.
 */
export function buildSectionIds(
  sections: readonly { readonly id?: string; readonly heading: string }[],
  reserved: readonly string[] = [],
): string[] {
  const taken = new Set<string>(reserved);
  return sections.map((section, index) => {
    const base =
      slugifyHeading(section.id ?? "") || slugifyHeading(section.heading) || `section-${index + 1}`;
    let candidate = base;
    let n = 2;
    while (taken.has(candidate)) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    taken.add(candidate);
    return candidate;
  });
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/;

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * "2026-11-07" (or an ISO date-time; only the date part is used) ->
 * `{ dateTime: "2026-11-07", label: "November 7, 2026" }`. Invalid or
 * impossible dates (2026-02-30) return null so the page omits the line.
 */
export function formatLastUpdated(iso: string): { dateTime: string; label: string } | null {
  const match = ISO_DATE.exec(iso.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { dateTime: `${y}-${m}-${d}`, label: DATE_FORMAT.format(date) };
}
