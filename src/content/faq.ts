/**
 * Frequently asked questions. Plain-text content only: answers are arrays of
 * paragraphs (render each as its own `<p>` as a React text child). Copy states
 * the store's real behaviour (BACKLOG-phase2.md section 7): guest checkout,
 * mock payments, business-day estimates, simulated tracking, the 30-minute
 * cancellation window, and accounts: guest data is device-bound until you
 * sign in; email and password accounts with no password reset by email.
 *
 * Feed the FAQPage JSON-LD builder with:
 *   faqPageJsonLd(toFaqJsonLdInput(FAQ_ENTRIES))
 */

import { SITE_NAME } from "@/lib/seo/site";
import type { HelpTopicSlug } from "./help-topics";

export interface FaqEntry {
  /** Unique, URL-safe id (also usable as an in-page anchor). */
  readonly slug: string;
  readonly question: string;
  /** Plain-text paragraphs, never empty. */
  readonly answer: readonly string[];
  readonly topic: HelpTopicSlug;
  /** Root-relative internal links; each passes `isAllowedInternalHref`. */
  readonly relatedHrefs?: readonly string[];
}

/** Input shape of `faqPageJsonLd` in `src/lib/seo/json-ld.ts`. */
export interface FaqJsonLdInput {
  readonly question: string;
  readonly answer: string;
}

export const FAQ_ENTRIES: readonly FaqEntry[] = [
  // Ordering -----------------------------------------------------------------
  {
    slug: "how-do-i-place-an-order",
    question: "How do I place an order?",
    answer: [
      "Add products to your cart, open the cart and select Proceed to checkout. Enter your email address, a shipping address and the card details, choose a shipping option and place the order.",
      `You can use guest checkout without creating an account, or sign in first so the order is saved to your account. ${SITE_NAME} is a demo store, so payments are simulated and no real money is taken.`,
    ],
    topic: "ordering",
    relatedHrefs: ["/cart", "/checkout"],
  },
  {
    slug: "do-i-need-an-account",
    question: "Do I need to create an account?",
    answer: [
      "No. You can shop and check out as a guest. As a guest, your cart, orders, lists and other activity are linked to this browser on this device through a session cookie: guest data is device-bound until you sign in.",
      "Creating an account with your email address and a password lets you sign in on any browser or device and keeps everything in one place.",
    ],
    topic: "ordering",
    relatedHrefs: ["/signup", "/account"],
  },
  {
    slug: "what-does-buy-now-do",
    question: "What does Buy Now do?",
    answer: [
      "Buy Now adds the product to your cart and takes you straight to checkout. Checkout always includes everything in your cart, so move any items you do not want to buy yet to Save for later first.",
    ],
    topic: "ordering",
    relatedHrefs: ["/cart", "/checkout"],
  },
  {
    slug: "how-do-promo-codes-work",
    question: "How do promo codes work?",
    answer: [
      "Enter a promo code in your cart. Valid codes take a percentage or a fixed amount off, or remove the shipping charge, and the discount is shown before you check out.",
      "A code can be used once per shopper: once per device as a guest, or once per account when you are signed in. Some codes need a minimum subtotal, have an expiry date or are limited to a set number of uses, and the cart tells you which rule a code did not meet.",
    ],
    topic: "ordering",
    relatedHrefs: ["/cart", "/deals"],
  },
  {
    slug: "where-can-i-see-my-orders",
    question: "Where can I see my orders?",
    answer: [
      "Open Orders to see your orders, newest first: the orders placed from this device as a guest, or every order in your account when you are signed in. Each order has a detail page with its items, totals, shipping address, delivery estimate and status timeline, plus a printable invoice and a Buy again option.",
      "The store does not send confirmation emails, so the Orders page is the place to check an order.",
    ],
    topic: "ordering",
    relatedHrefs: ["/orders"],
  },
  {
    slug: "how-do-i-compare-products",
    question: "How do I compare products?",
    answer: [
      "Select Compare on up to 4 products to see their prices, ratings and specifications side by side. The comparison lives in the page address, so you can bookmark or share it.",
    ],
    topic: "ordering",
    relatedHrefs: ["/compare", "/products"],
  },

  // Payments -----------------------------------------------------------------
  {
    slug: "which-payment-methods-do-you-accept",
    question: "Which payment methods do you accept?",
    answer: [
      `${SITE_NAME} is a demo store and uses a mock payment provider. The checkout card form accepts test card numbers only; no real card is charged and no money changes hands.`,
      "Do not enter a real card number. Use one of the test cards listed in the next question.",
    ],
    topic: "payments",
    relatedHrefs: ["/checkout", "/terms"],
  },
  {
    slug: "which-test-card-numbers-can-i-use",
    question: "Which test card numbers can I use?",
    answer: [
      "Use any future expiry date and any 3-digit security code with these numbers.",
      "4242 4242 4242 4242: the payment succeeds.",
      "4000 0000 0000 0002: the card is declined.",
      "4000 0000 0000 9995: the payment fails for insufficient funds.",
      "4000 0000 0000 0119: the payment fails with a processing error.",
    ],
    topic: "payments",
    relatedHrefs: ["/checkout"],
  },
  {
    slug: "why-was-my-card-declined",
    question: "Why was my card declined?",
    answer: [
      "The mock payment provider declines the test numbers that simulate a decline, insufficient funds or a processing error. When a payment fails, no order is created, nothing is charged and your cart stays as it was, so you can try again with 4242 4242 4242 4242.",
    ],
    topic: "payments",
    relatedHrefs: ["/checkout"],
  },
  {
    slug: "do-you-store-my-card-details",
    question: "Do you store my card details?",
    answer: [
      "No full card number or security code is stored. The order keeps only the last 4 digits of the card so you can recognise it on the order page and invoice.",
    ],
    topic: "payments",
    relatedHrefs: ["/privacy"],
  },

  // Shipping -----------------------------------------------------------------
  {
    slug: "what-shipping-options-are-there",
    question: "What shipping options are there and what do they cost?",
    answer: [
      "Standard costs $4.99 and arrives in 5 to 8 business days. It is free on orders of $35 or more.",
      "Express costs $9.99 and arrives in 2 to 3 business days.",
      "Next Day costs $19.99 and arrives the next business day.",
    ],
    topic: "shipping",
    relatedHrefs: ["/shipping", "/cart"],
  },
  {
    slug: "how-does-free-shipping-work",
    question: "How does free shipping work?",
    answer: [
      "Standard shipping is free when your order subtotal is $35 or more. The cart shows how much more you need to add to qualify. Express and Next Day are always charged at their listed price unless a free shipping promo code applies.",
    ],
    topic: "shipping",
    relatedHrefs: ["/cart", "/shipping"],
  },
  {
    slug: "how-are-delivery-dates-estimated",
    question: "How are delivery dates estimated?",
    answer: [
      "Delivery dates are business-day estimates: the store counts Monday to Friday from the day you order, using the range of the shipping option you chose. They are estimates, not guarantees.",
    ],
    topic: "shipping",
    relatedHrefs: ["/shipping"],
  },
  {
    slug: "how-do-i-track-my-order",
    question: "How do I track my order?",
    answer: [
      "Open the order from Orders to see its status timeline: processing, packed, shipped, out for delivery and delivered.",
      "Tracking is simulated. Each step is calculated from fixed time offsets after the order was placed; no real carrier or parcel is involved, and there is no carrier tracking number.",
    ],
    topic: "shipping",
    relatedHrefs: ["/orders"],
  },
  {
    slug: "can-i-add-delivery-instructions",
    question: "Can I add delivery instructions?",
    answer: [
      "Yes. Checkout has an optional delivery note of up to 200 characters. It is saved with the order and shown on the order page.",
    ],
    topic: "shipping",
    relatedHrefs: ["/checkout"],
  },

  // Cancellations and returns -------------------------------------------------
  {
    slug: "how-do-i-cancel-an-order",
    question: "How do I cancel an order?",
    answer: [
      "Open the order from Orders and select Cancel order. You can cancel within 30 minutes of placing the order while it is still processing.",
      "Cancelling puts the items back in stock, releases any promo code you used and records a refund in the store's mock payment ledger.",
    ],
    topic: "returns",
    relatedHrefs: ["/orders", "/returns"],
  },
  {
    slug: "why-can-i-no-longer-cancel",
    question: "Why can I no longer cancel my order?",
    answer: [
      "Cancellation closes 30 minutes after the order is placed, or earlier once the order is no longer processing. After that the Cancel order option is no longer shown.",
    ],
    topic: "returns",
    relatedHrefs: ["/orders", "/returns"],
  },
  {
    slug: "what-is-the-returns-policy",
    question: "What is the returns policy?",
    answer: [
      "The returns page describes a sample 30-day returns policy for this demo store. Returns are not processed online, so there is no return request form.",
    ],
    topic: "returns",
    relatedHrefs: ["/returns", "/contact"],
  },
  {
    slug: "how-do-refunds-work",
    question: "How do refunds work?",
    answer: [
      "Because payments are mock payments, refunds are mock too. When you cancel an order the refund is recorded in the store's mock payment ledger and no money moves.",
    ],
    topic: "returns",
    relatedHrefs: ["/returns"],
  },

  // Lists -----------------------------------------------------------------------
  {
    slug: "how-do-wish-lists-work",
    question: "How do wish lists work?",
    answer: [
      "Select Add to List on a product to save it to a list. You can keep up to 20 lists with up to 200 items each, and add a note, priority and desired quantity to each item.",
      "You do not need an account to use lists. As a guest, your lists are kept on this device until you sign in; once you sign in they move to your account."
    ],
    topic: "lists",
    relatedHrefs: ["/lists"],
  },
  {
    slug: "how-do-i-share-a-list",
    question: "How do I share a list?",
    answer: [
      "Open the list and copy its share link. Anyone with the link can view the list, but only you can change it. The store does not send the link for you and never asks for anyone's email address.",
    ],
    topic: "lists",
    relatedHrefs: ["/lists"],
  },
  {
    slug: "what-is-save-for-later",
    question: "What is Save for later?",
    answer: [
      "Save for later moves an item out of your cart into a separate list below it, so it is not included at checkout. Move it back to the cart whenever you are ready. Saved items are kept with your cart: on this device as a guest, or in your account when you are signed in.",
    ],
    topic: "lists",
    relatedHrefs: ["/cart"],
  },

  // Reviews and questions -----------------------------------------------------
  {
    slug: "how-do-i-write-a-review",
    question: "How do I write a review?",
    answer: [
      "Open the product page and select Write a review. Choose a rating from 1 to 5 stars, add a title and your review, and pick the name shown with it; if you leave the name empty it shows as Anonymous shopper.",
      "You can write one review per product, as a guest from this device or from your account, and reviews are published straight away. When you are signed in, your account display name is shown. You can also mark other reviews as helpful, once per review.",
    ],
    topic: "reviews",
    relatedHrefs: ["/account/contributions"],
  },
  {
    slug: "what-does-verified-purchase-mean",
    question: "What does Verified Purchase mean?",
    answer: [
      "A review shows the Verified Purchase badge when the shopper who wrote it, as a guest on that device or through their account, has a paid order containing that product that was not cancelled. The badge is worked out by the store, not chosen by the reviewer.",
    ],
    topic: "reviews",
  },
  {
    slug: "how-do-product-questions-work",
    question: "How do product questions and answers work?",
    answer: [
      "Use the Questions and answers section on a product page to ask about the product or answer someone else's question. Questions can be up to 300 characters and answers up to 1000.",
      "Your questions, answers and reviews are listed under Your account: on this device as a guest, or on any device once you sign in."
    ],
    topic: "reviews",
    relatedHrefs: ["/account/contributions"],
  },

  // Account and privacy -------------------------------------------------------
  {
    slug: "how-does-my-account-work",
    question: "How does my account work?",
    answer: [
      "You can shop as a guest or with an account. As a guest, a session cookie in this browser links you to your cart, orders, addresses, lists, alerts, reviews and browsing history. Guest data is device-bound until you sign in: another browser or device starts a separate, empty guest session.",
      "With an account, the same things are saved to your account instead, so you can sign in with your email address and password on any browser or device and find them there.",
    ],
    topic: "account",
    relatedHrefs: ["/account", "/signup", "/privacy"],
  },
  {
    slug: "how-do-i-create-an-account",
    question: "How do I create an account?",
    answer: [
      "Select Create account and enter your email address, a display name and a password of 8 to 128 characters. There are no rules about symbols or numbers, but very common passwords are rejected.",
      "Your account is ready straight away, and anything you did as a guest in this browser moves into it. You can change your display name and password later in Settings.",
    ],
    topic: "account",
    relatedHrefs: ["/signup", "/account/settings"],
  },
  {
    slug: "how-do-i-sign-in",
    question: "How do I sign in?",
    answer: [
      "Select Sign in and enter the email address and password of your account. You stay signed in on that browser for 30 days unless you sign out.",
      "If the details do not match, the store says the email or password is incorrect without saying which. After 10 incorrect attempts, sign-in for that account is paused for 15 minutes.",
    ],
    topic: "account",
    relatedHrefs: ["/signin"],
  },
  {
    slug: "what-happens-to-my-guest-data-when-i-sign-in",
    question: "What happens to my guest cart and orders when I sign in?",
    answer: [
      "When you sign in or create an account, everything from this browser's guest session moves into your account: cart, saved items, lists, orders, saved addresses, alerts, reviews, questions and answers, contact messages and browsing history.",
      "Cart quantities for the same product are added together, up to the stock available. Duplicate addresses and list items are combined, and if you reviewed the same product as a guest and in your account, the account review is kept.",
      "When you sign out, this browser starts a new, empty guest session. Your data stays in your account until you sign in again.",
    ],
    topic: "account",
    relatedHrefs: ["/signin", "/cart", "/orders"],
  },
  {
    slug: "how-do-i-sign-out-everywhere",
    question: "How do I sign out everywhere?",
    answer: [
      "Open Settings and select Sign out everywhere. It ends every sign-in session for your account on every browser and device, including this one.",
      "Use it if you signed in on a shared computer or think someone else knows your password, and then sign in again and change your password. Changing your password also signs out your other browsers and devices.",
    ],
    topic: "account",
    relatedHrefs: ["/account/settings", "/signin"],
  },
  {
    slug: "how-do-i-delete-my-account",
    question: "How do I delete my account?",
    answer: [
      "Open Settings and use Delete account, confirming with your password. Deletion cannot be undone.",
      "It removes your account and its personal data: email address, display name, password hash, sign-in sessions, cart, lists, saved addresses, reviews, helpful votes, alerts, contact messages and browsing history.",
      "Questions and answers you posted stay on the product pages, so other shoppers' answers to them are not lost, but their text and display name are replaced with “[deleted]”.",
      "Orders are kept as anonymised records: your name, email address and shipping address are removed, while the items, amounts and dates stay. You can later create a new account with the same email address, but it starts empty.",
    ],
    topic: "account",
    relatedHrefs: ["/account/settings", "/privacy"],
  },
  {
    slug: "i-cannot-reset-my-password",
    question: "Why can't I reset my password?",
    answer: [
      "Password reset is not available. This demo store does not send email, and the password itself is never stored, only a one-way hash of it, so there is no way to recover a forgotten password.",
      "If you are signed in, you can change your password in Settings. If you have forgotten it, contact us through the contact form and we will try to help, or create a new account. Keeping your password in a password manager avoids this.",
    ],
    topic: "account",
    relatedHrefs: ["/contact", "/account/settings", "/signup"],
  },
  {
    slug: "what-happens-if-i-clear-my-cookies",
    question: "What happens if I clear my cookies?",
    answer: [
      "If you are signed in, clearing cookies signs you out of that browser. Your data stays in your account; sign in again to get it back.",
      "If you shop as a guest, clearing cookies removes the guest session cookie and there is no way to recover it. You lose access to the guest cart, orders, saved addresses, lists and alerts on that device, and reviews, questions and answers you posted stay on the product pages but are no longer linked to you. Sign in before clearing cookies to keep them in your account.",
    ],
    topic: "account",
    relatedHrefs: ["/account", "/privacy"],
  },
  {
    slug: "how-do-back-in-stock-alerts-work",
    question: "How do back-in-stock alerts work?",
    answer: [
      "On a product that is out of stock, select Notify me. When it is back in stock, the alert shows in the store itself, on the product page and in Your account. You can keep up to 20 alerts.",
      "Alerts are in-app only. The store does not collect an email address for them and does not send email or push notifications.",
    ],
    topic: "account",
    relatedHrefs: ["/account/alerts"],
  },
  {
    slug: "what-data-do-you-store",
    question: "What data do you store about me?",
    answer: [
      "The store keeps a guest session cookie named sf_session in your browser, plus a sign-in cookie when you are signed in. Linked to them, a local database stores your cart, orders with the shipping address, email address and last 4 card digits, saved addresses, lists, reviews and questions, contact messages and the products you viewed.",
      "If you create an account, it also stores your email address, display name, a password hash (never the password itself) and records of your sign-in sessions. Recent searches are kept only in your browser. The privacy notice lists everything in detail.",
    ],
    topic: "account",
    relatedHrefs: ["/privacy", "/account/history"],
  },
  {
    slug: "how-do-i-contact-you",
    question: "How do I contact you?",
    answer: [
      "Use the contact form. Messages you send are listed under Your account, on this device as a guest or in your account when you are signed in. This demo store does not send email replies.",
    ],
    topic: "account",
    relatedHrefs: ["/contact", "/account/messages"],
  },

  // Accessibility ---------------------------------------------------------------
  {
    slug: "is-the-store-accessible",
    question: "Is the store accessible?",
    answer: [
      "The store aims to meet WCAG 2.2 level AA. Every page works with a keyboard and a visible focus indicator, uses headings and landmarks for screen readers, reflows down to 320 pixels wide and keeps touch targets at least 44 pixels. Forms and buttons also work with JavaScript turned off.",
    ],
    topic: "accessibility",
    relatedHrefs: ["/accessibility"],
  },
  {
    slug: "how-do-i-report-an-accessibility-problem",
    question: "How do I report an accessibility problem?",
    answer: [
      "Tell us through the contact form which page you were on, what you were trying to do and which browser or assistive technology you used.",
    ],
    topic: "accessibility",
    relatedHrefs: ["/contact", "/accessibility"],
  },
];

const FAQ_BY_SLUG: ReadonlyMap<string, FaqEntry> = new Map(
  FAQ_ENTRIES.map((entry) => [entry.slug, entry]),
);

/** The FAQ entry for a slug, or `undefined`. */
export function getFaqEntry(slug: string): FaqEntry | undefined {
  return FAQ_BY_SLUG.get(slug);
}

/** Resolves slugs to entries in order, skipping unknown slugs. */
export function getFaqEntries(slugs: readonly string[]): readonly FaqEntry[] {
  return slugs.flatMap((slug) => {
    const entry = FAQ_BY_SLUG.get(slug);
    return entry ? [entry] : [];
  });
}

/** Maps entries to the `faqPageJsonLd` input, joining paragraphs with a space. */
export function toFaqJsonLdInput(entries: readonly FaqEntry[]): FaqJsonLdInput[] {
  return entries.map((entry) => ({
    question: entry.question,
    answer: entry.answer.join(" "),
  }));
}
