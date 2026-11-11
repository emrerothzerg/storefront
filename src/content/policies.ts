/**
 * Policy and company pages (`/about`, `/shipping`, `/returns`, `/privacy`,
 * `/terms`, `/accessibility`). Plain-text content only. Every page carries the
 * visible sample notice `SAMPLE_POLICY_NOTICE` as the first paragraph of its
 * first section, and `sampleNotice: true` so pages can also render it in a
 * Notice atom. Copy states the store's real behaviour (BACKLOG-phase2.md
 * section 7).
 */

import { SITE_NAME } from "@/lib/seo/site";

export const SAMPLE_POLICY_NOTICE =
  "This is sample policy text for a demo store and is not legal advice.";

export const POLICY_LAST_UPDATED = "2026-11-07";

export const POLICY_SLUGS = [
  "about",
  "shipping",
  "returns",
  "privacy",
  "terms",
  "accessibility",
] as const;

export type PolicySlug = (typeof POLICY_SLUGS)[number];

export interface PolicySection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export interface PolicyPage {
  readonly slug: PolicySlug;
  readonly title: string;
  /** ISO date (YYYY-MM-DD) for a "Last updated" line. */
  readonly lastUpdated: typeof POLICY_LAST_UPDATED;
  readonly sampleNotice: true;
  readonly sections: readonly PolicySection[];
}

export const POLICY_PAGES: { readonly [K in PolicySlug]: PolicyPage & { readonly slug: K } } = {
  about: {
    slug: "about",
    title: `About ${SITE_NAME}`,
    lastUpdated: POLICY_LAST_UPDATED,
    sampleNotice: true,
    sections: [
      {
        heading: "Who we are",
        paragraphs: [
          SAMPLE_POLICY_NOTICE,
          `${SITE_NAME} is a demo online store for quality everyday goods. It shows how a complete shop works, from browsing and search to checkout and order tracking, without real payments or real deliveries.`,
        ],
      },
      {
        heading: "How the store works",
        paragraphs: [
          "You can shop as a guest or create an account with your email address and a password. Guest data is device-bound until you sign in: your cart, orders, lists and other activity are linked to this browser by a session cookie and kept in a local database. Signing in moves them into your account so you can use them on any device.",
          "Payments are mock payments made with test card numbers, so no money is taken. Order tracking is simulated from the time the order was placed, and you can cancel an order within 30 minutes while it is still processing.",
        ],
      },
      {
        heading: "Get in touch",
        paragraphs: ["Questions or feedback are welcome through the contact form."],
      },
    ],
  },

  shipping: {
    slug: "shipping",
    title: "Shipping policy",
    lastUpdated: POLICY_LAST_UPDATED,
    sampleNotice: true,
    sections: [
      {
        heading: "Shipping options",
        paragraphs: [
          SAMPLE_POLICY_NOTICE,
          "Standard: $4.99, delivered in 5 to 8 business days. Standard shipping is free on orders of $35 or more.",
          "Express: $9.99, delivered in 2 to 3 business days.",
          "Next Day: $19.99, delivered the next business day.",
          "There is no sales tax in this demo store. The shipping charge is shown in your cart and at checkout before you pay.",
        ],
      },
      {
        heading: "Delivery estimates",
        paragraphs: [
          "Delivery dates are business-day estimates. They count Monday to Friday from the day you order, using the range of the shipping option you chose, and are not guaranteed.",
        ],
      },
      {
        heading: "Simulated tracking",
        paragraphs: [
          "Tracking is simulated. The status timeline on each order (processing, packed, shipped, out for delivery, delivered) advances on fixed time offsets after the order is placed. No real carrier ships the order and there is no carrier tracking number.",
        ],
      },
      {
        heading: "Changing or cancelling an order",
        paragraphs: [
          "You can cancel an order within 30 minutes of placing it while it is still processing. Cancelling restores the items to stock and records a refund in the mock payment ledger. Orders cannot be edited after they are placed.",
        ],
      },
    ],
  },

  returns: {
    slug: "returns",
    title: "Returns and refunds policy",
    lastUpdated: POLICY_LAST_UPDATED,
    sampleNotice: true,
    sections: [
      {
        heading: "Cancelling an order",
        paragraphs: [
          SAMPLE_POLICY_NOTICE,
          "You can cancel an order from its order page within 30 minutes of placing it while it is still processing. Cancelling restores the items to stock and releases any promo code used on the order.",
        ],
      },
      {
        heading: "Returns",
        paragraphs: [
          "As a sample policy, unused items in their original packaging could be returned within 30 days of delivery. Because this is a demo store with simulated tracking and no real deliveries, returns are not processed online and there is no return request form.",
        ],
      },
      {
        heading: "Refunds",
        paragraphs: [
          "Payments are mock payments, so refunds are mock as well. A refund for a cancelled order is recorded in the store's mock payment ledger; no money is taken or returned.",
        ],
      },
    ],
  },

  privacy: {
    slug: "privacy",
    title: "Privacy notice",
    lastUpdated: POLICY_LAST_UPDATED,
    sampleNotice: true,
    sections: [
      {
        heading: "Summary",
        paragraphs: [
          SAMPLE_POLICY_NOTICE,
          `${SITE_NAME} works for guests and for account holders. Guest data is device-bound until you sign in: it is linked to a session cookie in this browser. Account data is linked to your account. Everything is kept in a local database on the store's server, is not shared with or sold to anyone, and no third-party analytics, advertising or payment services are used.`,
        ],
      },
      {
        heading: "What we store",
        paragraphs: [
          "A session cookie named sf_session, holding a random identifier. It is set only when you first do something that needs it, such as adding to your cart.",
          "If you create an account: your email address, your display name, a password hash (never the password itself) and your sign-in session records, plus a sign-in cookie named sf_auth while you are signed in.",
          "Your cart and the items you saved for later.",
          "Your orders, including the shipping address, the email address you entered at checkout, the last 4 digits of the card and any delivery note. The full card number and security code are never stored.",
          "Addresses you save to your address book.",
          "Your lists and the items, notes and priorities in them.",
          "Reviews, questions and answers you post, with the display name you chose, and your helpful votes.",
          "Back-in-stock alerts you set.",
          "Messages you send through the contact form, including the name and email address you enter there.",
          "Your browsing history: the most recent 50 products you viewed, used for recently viewed items and recommendations.",
          "Recent searches are kept only in your browser's local storage and are never sent to the store's database.",
        ],
      },
      {
        heading: "Your account",
        paragraphs: [
          "If you create an account, it stores your email address, your display name, a password hash and records of your sign-in sessions. The password itself is never stored, only a one-way hash of it, so it cannot be read back by anyone.",
          "A sign-in cookie holding a random token keeps you signed in for 30 days; the store keeps only a hash of that token, with the session's creation, last-use and expiry times and your browser's user agent.",
          "There is no password recovery: password reset is not available because the store does not send email. If you lose your password, contact us through the contact form.",
        ],
      },
      {
        heading: "Guest data is device-bound until you sign in",
        paragraphs: [
          "As a guest, your data is tied to this browser on this device. If you clear this site's cookies or switch browsers before signing in, you lose access to it and there is no way to recover it; reviews, questions and answers you posted stay published but are no longer linked to you.",
          "When you sign in or create an account, this browser's guest data moves into your account. When you sign out, the browser starts a new, empty guest session.",
        ],
      },
      {
        heading: "Deleting your account",
        paragraphs: [
          "You can delete your account in Settings. Deletion removes your email address, display name, password hash, sign-in sessions, cart, lists, saved addresses, reviews, helpful votes, alerts, contact messages and browsing history. Questions and answers you posted stay on the product pages with their text and display name replaced by “[deleted]”.",
          "Orders are kept as financial records but anonymised: your name, email address and shipping address are removed, while the items, amounts and dates are kept.",
        ],
      },
      {
        heading: "Email",
        paragraphs: [
          "The store asks for an email address only when you create an account, at checkout and in the contact form. It does not send marketing or notification emails, and wish lists and stock alerts never ask for an email address.",
        ],
      },
    ],
  },

  terms: {
    slug: "terms",
    title: "Terms of use",
    lastUpdated: POLICY_LAST_UPDATED,
    sampleNotice: true,
    sections: [
      {
        heading: "About these terms",
        paragraphs: [
          SAMPLE_POLICY_NOTICE,
          `${SITE_NAME} is a demonstration store. By using it you accept that products, prices, stock levels, orders and deliveries are simulated.`,
        ],
      },
      {
        heading: "Orders and payments",
        paragraphs: [
          "You can check out as a guest or signed in to an account; orders placed while signed in are saved to your account. Payments are mock payments processed by a test payment provider: only test card numbers should be used, no real card is charged and no money changes hands. Please do not enter real card details.",
          "There is no sales tax. Shipping charges and the free shipping threshold are shown on the shipping policy page.",
        ],
      },
      {
        heading: "Cancellation and tracking",
        paragraphs: [
          "You can cancel an order within 30 minutes of placing it while it is still processing. Order tracking is simulated from timestamps and does not reflect a real shipment.",
        ],
      },
      {
        heading: "Your account and content",
        paragraphs: [
          "You can shop as a guest or with an account. Guest data is device-bound until you sign in: it lives in a session cookie in this browser, with the data kept in a local database, and clearing cookies ends access to it.",
          "If you create an account, you are responsible for keeping your password secret and for activity under your account. Choose a password you do not use elsewhere. Password reset is not available, so keep your password safe; if you think someone else knows it, change it and use Sign out everywhere in Settings. You can delete your account at any time.",
          "Reviews, questions and answers are published under the display name you choose. Please keep them honest and relevant, and do not include personal information.",
        ],
      },
    ],
  },

  accessibility: {
    slug: "accessibility",
    title: "Accessibility statement",
    lastUpdated: POLICY_LAST_UPDATED,
    sampleNotice: true,
    sections: [
      {
        heading: "Our commitment",
        paragraphs: [
          SAMPLE_POLICY_NOTICE,
          `${SITE_NAME} aims to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA.`,
        ],
      },
      {
        heading: "What we do",
        paragraphs: [
          "Every page can be used with a keyboard alone and shows a visible focus indicator.",
          "Pages use one main heading, a logical heading order and landmarks, and images have text alternatives.",
          "Layouts reflow down to 320 pixels wide and touch targets are at least 44 pixels.",
          "Forms, the cart and checkout work with JavaScript turned off.",
          "Colours follow the system light or dark preference and are chosen for readable contrast. Nothing moves or rotates automatically.",
        ],
      },
      {
        heading: "Feedback",
        paragraphs: [
          "If something is hard to use, tell us through the contact form which page you were on, what you were trying to do and which browser or assistive technology you used.",
        ],
      },
    ],
  },
};

/** Pages in footer order. */
export const POLICY_PAGE_LIST: readonly PolicyPage[] = POLICY_SLUGS.map((slug) => POLICY_PAGES[slug]);

/** Type guard for policy slugs. */
export function isPolicySlug(value: string): value is PolicySlug {
  return POLICY_SLUGS.some((slug) => slug === value);
}

/** The policy page for a slug, or `undefined`. */
export function getPolicyPage(slug: string): PolicyPage | undefined {
  return isPolicySlug(slug) ? POLICY_PAGES[slug] : undefined;
}

/** Root-relative link to a policy page, e.g. `/privacy`. */
export function policyHref(slug: PolicySlug): `/${PolicySlug}` {
  return `/${slug}`;
}
