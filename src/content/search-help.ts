/**
 * Tiny in-memory filter over help topics and FAQ entries for the help centre
 * search box. Uses plain lower-cased `includes` (no RegExp built from user
 * input), so any query text is safe.
 */

import { FAQ_ENTRIES, type FaqEntry } from "./faq";
import { HELP_TOPICS, helpTopicHref, type HelpTopic } from "./help-topics";

/**
 * Product search help shown by /search with zero results (CONS-B1 item ar,
 * moved from `src/app/search/_lib/search-page.ts`). Plain text. Every
 * popular search must return results on the seeded catalogue (tested in
 * search-help.test.ts against the real search service).
 */
export const SEARCH_TIPS: readonly string[] = [
  "Check the spelling of your search words.",
  "Try fewer or more general words, for example “desk” instead of “walnut standing desk”.",
  "Search by product type, brand or department.",
  "Remove filters to see more results.",
];

/** Popular product searches, linked as `/search?q=<term>` (lower case, letters and spaces). */
export const POPULAR_SEARCHES: readonly string[] = ["headphones", "desk", "coffee", "yoga mat", "notebook", "candle"];

/** Queries are capped to this many characters before matching (search limit, BACKLOG section 0). */
export const HELP_QUERY_MAX_LENGTH = 100;
/** Only the first terms are used (search limit, BACKLOG section 0). */
export const HELP_QUERY_MAX_TERMS = 8;

export type HelpSearchResult =
  | {
      readonly kind: "topic";
      readonly title: string;
      readonly href: string;
      readonly score: number;
      readonly topic: HelpTopic;
    }
  | {
      readonly kind: "faq";
      readonly title: string;
      /** `/help/[topic]#[slug]`: the entry on its topic page. */
      readonly href: string;
      readonly score: number;
      readonly entry: FaqEntry;
    };

interface Candidate {
  readonly result: HelpSearchResult;
  readonly titleText: string;
  readonly bodyText: string;
  readonly order: number;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const CANDIDATES: readonly Candidate[] = [
  ...HELP_TOPICS.map((topic, index): Candidate => ({
    result: { kind: "topic", title: topic.title, href: helpTopicHref(topic.slug), score: 0, topic },
    titleText: normalize(topic.title),
    bodyText: normalize(topic.summary),
    order: index,
  })),
  ...FAQ_ENTRIES.map((entry, index): Candidate => ({
    result: {
      kind: "faq",
      title: entry.question,
      href: `${helpTopicHref(entry.topic)}#${entry.slug}`,
      score: 0,
      entry,
    },
    titleText: normalize(entry.question),
    bodyText: normalize(entry.answer.join(" ")),
    order: HELP_TOPICS.length + index,
  })),
];

/** Score tiers: higher ranks first. Title hits always outrank body-only hits. */
const SCORE_TITLE_PHRASE = 4;
const SCORE_TITLE_TERMS = 3;
const SCORE_BODY_PHRASE = 2;
const SCORE_ANY_TERMS = 1;

function scoreCandidate(candidate: Candidate, phrase: string, terms: readonly string[]): number {
  const { titleText, bodyText } = candidate;
  if (titleText.includes(phrase)) return SCORE_TITLE_PHRASE;
  if (terms.every((term) => titleText.includes(term))) return SCORE_TITLE_TERMS;
  if (bodyText.includes(phrase)) return SCORE_BODY_PHRASE;
  if (terms.every((term) => titleText.includes(term) || bodyText.includes(term))) return SCORE_ANY_TERMS;
  return 0;
}

/** Normalised query actually matched: capped, lower-cased, whitespace collapsed. */
export function normalizeHelpQuery(query: unknown): string {
  if (typeof query !== "string") return "";
  return normalize(query.slice(0, HELP_QUERY_MAX_LENGTH));
}

/**
 * Filters help topics and FAQ entries. Every query term must appear (in the
 * title or body); results rank title-phrase, title-terms, body-phrase, then
 * any-field matches, ties keeping content order (topics before FAQs). An
 * empty or whitespace-only (or non-string) query returns every topic and FAQ
 * entry in content order with score 0.
 */
export function searchHelp(query: string): HelpSearchResult[] {
  const phrase = normalizeHelpQuery(query);
  if (phrase === "") return CANDIDATES.map((candidate) => candidate.result);
  const terms = phrase.split(" ").slice(0, HELP_QUERY_MAX_TERMS);
  return CANDIDATES.map((candidate) => ({ candidate, score: scoreCandidate(candidate, phrase, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.candidate.order - b.candidate.order)
    .map(({ candidate, score }) => ({ ...candidate.result, score }));
}
