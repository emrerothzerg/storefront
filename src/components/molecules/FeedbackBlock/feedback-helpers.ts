import { isAllowedInternalHref } from "@/content/routes";
import { chipLabel } from "../ChipRow/chip-row-helpers";

/** Pure helpers for FeedbackBlock (T142). No React, no `src/server/**` imports. */

/** The only target of the "Give feedback" link (BACKLOG-phase3 Q6, CONTRACTS L-19). */
export const FEEDBACK_HREF = "/contact?topic=feedback";

export const FEEDBACK_COPY = {
  heading: "Did you find what you were looking for?",
  suggestionsIntro: "You could also try:",
  band: "We would love to hear what you think of this page.",
  button: "Give feedback",
} as const;

export interface FeedbackSuggestion {
  readonly label: string;
  readonly href: string;
}

/** Used to fill up to the minimum when the caller passes fewer than two valid links. */
export const DEFAULT_FEEDBACK_SUGGESTIONS: ReadonlyArray<FeedbackSuggestion> = [
  { label: "Browse all products", href: "/products" },
  { label: "See today's deals", href: "/deals" },
  { label: "Search help and FAQs", href: "/help" },
];

export const FEEDBACK_SUGGESTIONS_MIN = 2;
export const FEEDBACK_SUGGESTIONS_MAX = 3;
/** Longest visible suggestion label (code points, ellipsis included). */
export const FEEDBACK_LABEL_MAX = 60;
/** Longest heading (code points, ellipsis included). */
export const FEEDBACK_HEADING_MAX = 80;

export interface ResolvedSuggestion {
  readonly href: string;
  readonly text: string;
  /** Full label when `text` was truncated. */
  readonly title: string | undefined;
}

function resolveOne(item: FeedbackSuggestion): ResolvedSuggestion | null {
  if (item === null || typeof item !== "object") return null;
  const { href } = item;
  if (typeof href !== "string" || !isAllowedInternalHref(href) || href === FEEDBACK_HREF) return null;
  const label = chipLabel(item.label, FEEDBACK_LABEL_MAX);
  if (label === null) return null;
  return { href, text: label.text, title: label.truncated ? label.full : undefined };
}

/**
 * Two or three suggestion links: the caller's valid ones first (allow-listed
 * internal hrefs, non-empty labels, no duplicates by href, never the
 * feedback link itself), topped up from {@link DEFAULT_FEEDBACK_SUGGESTIONS}
 * to two when only one remains, or all three defaults when none remain.
 */
export function resolveFeedbackSuggestions(
  suggestions: ReadonlyArray<FeedbackSuggestion> | null | undefined,
): ResolvedSuggestion[] {
  const list: ReadonlyArray<FeedbackSuggestion> = Array.isArray(suggestions as unknown)
    ? (suggestions as ReadonlyArray<FeedbackSuggestion>)
    : [];
  const seen = new Set<string>();
  const out: ResolvedSuggestion[] = [];
  const push = (item: FeedbackSuggestion) => {
    if (out.length >= FEEDBACK_SUGGESTIONS_MAX) return;
    const resolved = resolveOne(item);
    if (resolved === null || seen.has(resolved.href)) return;
    seen.add(resolved.href);
    out.push(resolved);
  };
  for (const item of list) push(item);
  // None usable: all three defaults. One usable: top up to two.
  const target = out.length === 0 ? FEEDBACK_SUGGESTIONS_MAX : FEEDBACK_SUGGESTIONS_MIN;
  for (const item of DEFAULT_FEEDBACK_SUGGESTIONS) {
    if (out.length >= target) break;
    push(item);
  }
  return out;
}

/** Cleaned heading text; the default when empty. */
export function feedbackHeading(raw: unknown): { text: string; title: string | undefined } {
  const label = chipLabel(raw, FEEDBACK_HEADING_MAX);
  if (label === null) return { text: FEEDBACK_COPY.heading, title: undefined };
  return { text: label.text, title: label.truncated ? label.full : undefined };
}
