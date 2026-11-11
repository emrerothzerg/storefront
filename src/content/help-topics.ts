/**
 * Help centre topics. Plain-text content only (no HTML, no React). Each topic
 * lists the FAQ entries shown on `/help/[topic]` by slug; the colocated tests
 * check that every slug resolves to an entry in `faq.ts`.
 */

export const HELP_TOPIC_SLUGS = [
  "ordering",
  "payments",
  "shipping",
  "returns",
  "lists",
  "reviews",
  "account",
  "accessibility",
] as const;

export type HelpTopicSlug = (typeof HELP_TOPIC_SLUGS)[number];

/** Icon names used by help topics; a subset of the atoms Icon set (`ICON_NAMES`). */
export const HELP_TOPIC_ICONS = [
  "package",
  "truck",
  "refresh",
  "lock",
  "heart",
  "star",
  "question-circle",
  "user",
  "mail",
  "info",
] as const;

export type HelpTopicIcon = (typeof HELP_TOPIC_ICONS)[number];

export interface HelpTopic {
  readonly slug: HelpTopicSlug;
  readonly title: string;
  readonly summary: string;
  readonly icon: HelpTopicIcon;
  /** FAQ entry slugs from `faq.ts`, in display order. */
  readonly faqSlugs: readonly string[];
}

export const HELP_TOPICS: readonly HelpTopic[] = [
  {
    slug: "ordering",
    title: "Ordering",
    summary: "Placing an order as a guest, Buy Now, promo codes and finding your orders.",
    icon: "package",
    faqSlugs: [
      "how-do-i-place-an-order",
      "do-i-need-an-account",
      "what-does-buy-now-do",
      "how-do-promo-codes-work",
      "where-can-i-see-my-orders",
      "how-do-i-compare-products",
    ],
  },
  {
    slug: "payments",
    title: "Payments",
    summary: "How the demo card payment works, test card numbers and what happens when a card is declined.",
    icon: "lock",
    faqSlugs: [
      "which-payment-methods-do-you-accept",
      "which-test-card-numbers-can-i-use",
      "why-was-my-card-declined",
      "do-you-store-my-card-details",
    ],
  },
  {
    slug: "shipping",
    title: "Shipping and delivery",
    summary: "Shipping options and costs, free shipping, delivery estimates and simulated tracking.",
    icon: "truck",
    faqSlugs: [
      "what-shipping-options-are-there",
      "how-does-free-shipping-work",
      "how-are-delivery-dates-estimated",
      "how-do-i-track-my-order",
      "can-i-add-delivery-instructions",
    ],
  },
  {
    slug: "returns",
    title: "Cancellations and returns",
    summary: "The 30-minute cancellation window, the sample returns policy and how refunds are recorded.",
    icon: "refresh",
    faqSlugs: [
      "how-do-i-cancel-an-order",
      "why-can-i-no-longer-cancel",
      "what-is-the-returns-policy",
      "how-do-refunds-work",
    ],
  },
  {
    slug: "lists",
    title: "Lists and saved items",
    summary: "Wish lists, sharing a list with anyone by link, and saving cart items for later so you can buy them another time.",
    icon: "heart",
    faqSlugs: ["how-do-wish-lists-work", "how-do-i-share-a-list", "what-is-save-for-later"],
  },
  {
    slug: "reviews",
    title: "Reviews and questions",
    summary: "Writing a review, the Verified Purchase badge and asking or answering product questions.",
    icon: "star",
    faqSlugs: [
      "how-do-i-write-a-review",
      "what-does-verified-purchase-mean",
      "how-do-product-questions-work",
    ],
  },
  {
    slug: "account",
    title: "Your account and privacy",
    summary: "Creating an account, signing in and out, what happens to guest data, deleting your account, alerts, privacy and contact.",
    icon: "user",
    faqSlugs: [
      "how-does-my-account-work",
      "how-do-i-create-an-account",
      "how-do-i-sign-in",
      "what-happens-to-my-guest-data-when-i-sign-in",
      "how-do-i-sign-out-everywhere",
      "how-do-i-delete-my-account",
      "i-cannot-reset-my-password",
      "what-happens-if-i-clear-my-cookies",
      "how-do-back-in-stock-alerts-work",
      "what-data-do-you-store",
      "how-do-i-contact-you",
    ],
  },
  {
    slug: "accessibility",
    title: "Accessibility",
    summary: "How the store supports keyboard, screen reader and zoom users, and how to report a barrier.",
    icon: "info",
    faqSlugs: ["is-the-store-accessible", "how-do-i-report-an-accessibility-problem"],
  },
];

const TOPICS_BY_SLUG: ReadonlyMap<string, HelpTopic> = new Map(
  HELP_TOPICS.map((topic) => [topic.slug, topic]),
);

/** Type guard for route params such as `/help/[topic]`. */
export function isHelpTopicSlug(value: string): value is HelpTopicSlug {
  return TOPICS_BY_SLUG.has(value);
}

/** The topic for a slug, or `undefined` (render `notFound()` in the page). */
export function getHelpTopic(slug: string): HelpTopic | undefined {
  return TOPICS_BY_SLUG.get(slug);
}

/** Root-relative link to a topic page, e.g. `/help/shipping`. */
export function helpTopicHref(slug: HelpTopicSlug): string {
  return `/help/${slug}`;
}
