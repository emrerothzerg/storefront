/**
 * Data for `/help/[topic]` (T101). Unknown topics resolve to null (the page
 * calls `notFound()`); `?open=` is accepted only when it names one of the
 * topic's FAQ entries.
 */

import { getFaqEntries, type FaqEntry } from "@/content/faq";
import { getHelpTopic, helpTopicHref, type HelpTopic } from "@/content/help-topics";

import { HELP_PATH, HELP_TITLE } from "../../_lib/help-page";
import { parseOpenSlug, tokenParam, type RawSearchParams } from "../../_lib/search-params";

export interface HelpTopicPageData {
  readonly topic: HelpTopic;
  readonly path: string;
  readonly entries: readonly FaqEntry[];
  readonly openSlug: string | undefined;
  readonly breadcrumb: readonly { readonly label: string; readonly href?: string }[];
  /** Pre-selects the matching contact topic (every help topic slug is a contact topic). */
  readonly contactHref: string;
}

/** The topic for a raw route param, or null for anything unknown or malformed. */
export function resolveHelpTopic(raw: unknown): HelpTopic | null {
  const slug = tokenParam(raw);
  if (slug === null) return null;
  return getHelpTopic(slug) ?? null;
}

export function helpTopicTitle(topic: HelpTopic): string {
  return `${topic.title} help`;
}

export function loadHelpTopicPage(
  rawTopic: unknown,
  params: RawSearchParams | undefined,
): HelpTopicPageData | null {
  const topic = resolveHelpTopic(rawTopic);
  if (topic === null) return null;
  const entries = getFaqEntries(topic.faqSlugs);
  return {
    topic,
    path: helpTopicHref(topic.slug),
    entries,
    openSlug: parseOpenSlug(
      params?.open,
      entries.map((entry) => entry.slug),
    ),
    breadcrumb: [
      { label: "Home", href: "/" },
      { label: HELP_TITLE, href: HELP_PATH },
      { label: topic.title },
    ],
    contactHref: `/contact?topic=${topic.slug}`,
  };
}
