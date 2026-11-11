/**
 * Data for `/faq` (T101). The page renders `entries` (grouped by help topic)
 * and builds the FAQPage JSON-LD from the SAME flattened array, so the
 * structured data matches the visible questions one-to-one (criterion 3).
 */

import { FAQ_ENTRIES, toFaqJsonLdInput, type FaqEntry } from "@/content/faq";
import { HELP_TOPICS, type HelpTopicSlug } from "@/content/help-topics";
import { faqPageJsonLd, type FaqPageJsonLd } from "@/lib/seo/json-ld";

import { parseOpenSlug, type RawSearchParams } from "../../help/_lib/search-params";

export const FAQ_PATH = "/faq";
export const FAQ_TITLE = "Frequently asked questions";
export const FAQ_DESCRIPTION =
  "Quick answers about ordering, demo payments, shipping, cancellations and returns, lists, reviews, accounts and accessibility.";

export interface FaqGroup {
  readonly topic: HelpTopicSlug;
  readonly title: string;
  /** In-page anchor of the group heading; prefixed so it never equals an FAQ slug. */
  readonly id: string;
  readonly entries: readonly FaqEntry[];
}

export interface FaqPageData {
  readonly groups: readonly FaqGroup[];
  /** Every rendered entry, in render order (the JSON-LD source). */
  readonly entries: readonly FaqEntry[];
  readonly openSlug: string | undefined;
  readonly jsonLd: FaqPageJsonLd;
}

/** First occurrence of each slug wins (FaqList renders duplicates once too). */
function uniqueBySlug(entries: readonly FaqEntry[]): FaqEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.slug)) return false;
    seen.add(entry.slug);
    return true;
  });
}

/** Entries grouped in help-topic order; empty groups are dropped. */
export function groupFaqEntries(source: readonly FaqEntry[] = FAQ_ENTRIES): FaqGroup[] {
  const unique = uniqueBySlug(source);
  return HELP_TOPICS.map((topic) => ({
    topic: topic.slug,
    title: topic.title,
    id: `faq-topic-${topic.slug}`,
    entries: unique.filter((entry) => entry.topic === topic.slug),
  })).filter((group) => group.entries.length > 0);
}

export function loadFaqPage(
  params: RawSearchParams | undefined,
  source: readonly FaqEntry[] = FAQ_ENTRIES,
): FaqPageData {
  const groups = groupFaqEntries(source);
  const entries = groups.flatMap((group) => group.entries);
  return {
    groups,
    entries,
    openSlug: parseOpenSlug(
      params?.open,
      entries.map((entry) => entry.slug),
    ),
    jsonLd: faqPageJsonLd(toFaqJsonLdInput(entries)),
  };
}
