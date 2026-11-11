/**
 * Data and pure logic for `/help` (T101): topic tiles and the help search.
 * The query is validated here (trim, 100 chars, control/zero-width stripped);
 * `searchHelp` matches with lower-cased `includes`, so regex metacharacters
 * are literals. Garbage never throws: it yields results or an empty state.
 */

import { HELP_QUERY_MAX_LENGTH, searchHelp } from "@/content/search-help";
import { HELP_TOPICS, helpTopicHref, type HelpTopic } from "@/content/help-topics";
import { isAllowedInternalHref } from "@/content/routes";

import { cleanTextParam, hasParam, type RawSearchParams } from "./search-params";

export const HELP_PATH = "/help";
export const HELP_TITLE = "Help center";
export const HELP_DESCRIPTION =
  "Answers about ordering, payments, shipping, returns, lists, reviews, your account and accessibility, plus a search across every help topic.";
export const HELP_QUERY_PARAM = "q";

export const HELP_BREADCRUMB = [
  { label: "Home", href: "/" },
  { label: HELP_TITLE },
] as const;

export interface HelpResultView {
  readonly key: string;
  readonly kind: "topic" | "faq";
  readonly title: string;
  readonly href: string;
  /** Topic title for FAQ hits ("In Shipping and delivery"); the summary for topic hits. */
  readonly detail: string;
}

export interface HelpTileView {
  readonly slug: HelpTopic["slug"];
  readonly title: string;
  readonly summary: string;
  readonly icon: HelpTopic["icon"];
  readonly href: string;
}

export interface HelpPageData {
  /** Cleaned query, or null when absent/blank (no search performed). */
  readonly query: string | null;
  /** True when `?q` was present at all (drives `noindex`). */
  readonly searched: boolean;
  readonly results: readonly HelpResultView[];
  readonly topics: readonly HelpTileView[];
}

/** Validated `?q`: trimmed, invisible characters removed, at most 100 code points; null when blank. */
export function parseHelpQuery(value: unknown): string | null {
  return cleanTextParam(value, HELP_QUERY_MAX_LENGTH);
}

/** True when the URL carries `?q` (any value): such variants are not indexed. */
export function isHelpSearchRequest(params: RawSearchParams | undefined): boolean {
  return hasParam(params, HELP_QUERY_PARAM);
}

/** FAQ deep link that lands on the open answer: `/help/<topic>?open=<slug>#<slug>` (T89 ruling). */
export function faqDeepLink(topic: HelpTopic["slug"], slug: string): string {
  const encoded = encodeURIComponent(slug);
  return `${helpTopicHref(topic)}?open=${encoded}#${encoded}`;
}

const TOPIC_TITLES: ReadonlyMap<string, string> = new Map(HELP_TOPICS.map((t) => [t.slug, t.title]));

/** Search results as plain view data; hrefs that fail the route allowlist are dropped. */
export function runHelpSearch(query: string): HelpResultView[] {
  const views: HelpResultView[] = searchHelp(query).map((result) =>
    result.kind === "topic"
      ? {
          key: `topic:${result.topic.slug}`,
          kind: "topic",
          title: result.title,
          href: helpTopicHref(result.topic.slug),
          detail: result.topic.summary,
        }
      : {
          key: `faq:${result.entry.slug}`,
          kind: "faq",
          title: result.title,
          href: faqDeepLink(result.entry.topic, result.entry.slug),
          detail: `In ${TOPIC_TITLES.get(result.entry.topic) ?? "Help"}`,
        },
  );
  return views.filter((view) => isAllowedInternalHref(view.href));
}

export function helpTiles(): HelpTileView[] {
  return HELP_TOPICS.map((topic) => ({
    slug: topic.slug,
    title: topic.title,
    summary: topic.summary,
    icon: topic.icon,
    href: helpTopicHref(topic.slug),
  }));
}

export function loadHelpPage(params: RawSearchParams | undefined): HelpPageData {
  const query = parseHelpQuery(params?.[HELP_QUERY_PARAM]);
  return {
    query,
    searched: isHelpSearchRequest(params),
    results: query === null ? [] : runHelpSearch(query),
    topics: helpTiles(),
  };
}

/** "1 result" / "3 results". */
export function resultCountLabel(count: number): string {
  return count === 1 ? "1 result" : `${count} results`;
}
