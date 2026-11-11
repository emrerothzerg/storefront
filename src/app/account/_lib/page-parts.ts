import type { Metadata } from "next";

import type { BreadcrumbItem } from "@/components/atoms/Breadcrumb";
import { isAllowedInternalHref } from "@/content/routes";
import { buildMetadata } from "@/lib/seo/metadata";
import type { ContactTopic } from "@/server/contact/contact-service";

/** Copy, paths, metadata and small pure helpers shared by the account pages (T98). */

export type AccountPageKey = "hub" | "addresses" | "history" | "contributions" | "alerts" | "messages";

export interface AccountPageInfo {
  readonly path: string;
  /** Metadata title and breadcrumb label. */
  readonly title: string;
  readonly description: string;
}

export const ACCOUNT_PAGES: Readonly<Record<AccountPageKey, AccountPageInfo>> = {
  hub: {
    path: "/account",
    title: "Your Account",
    description: "Orders, lists, addresses, browsing history, reviews, stock alerts and messages in one place.",
  },
  addresses: {
    path: "/account/addresses",
    title: "Your Addresses",
    description: "Add, edit and remove the delivery addresses saved to your account.",
  },
  history: {
    path: "/account/history",
    title: "Browsing History",
    description: "Products you viewed recently. Remove single items or clear your history.",
  },
  contributions: {
    path: "/account/contributions",
    title: "Your Reviews & Questions",
    description: "The product reviews and questions you have posted.",
  },
  alerts: {
    path: "/account/alerts",
    title: "Stock Alerts",
    description: "Products you are watching and items that are back in stock.",
  },
  messages: {
    path: "/account/messages",
    title: "Messages",
    description: "Messages you have sent to customer service.",
  },
};

/** Every account page is private: `robots: { index: false, follow: false }` (criterion 5). */
export function accountMetadata(key: AccountPageKey): Metadata {
  const page = ACCOUNT_PAGES[key];
  return buildMetadata({ title: page.title, description: page.description, path: page.path, noindex: true });
}

/** Home › Your Account (hub) or Home › Your Account › <page> (criterion 5). */
export function accountBreadcrumb(key: AccountPageKey): BreadcrumbItem[] {
  const home: BreadcrumbItem = { label: "Home", href: "/" };
  if (key === "hub") return [home, { label: ACCOUNT_PAGES.hub.title }];
  return [home, { label: ACCOUNT_PAGES.hub.title, href: ACCOUNT_PAGES.hub.path }, { label: ACCOUNT_PAGES[key].title }];
}

/**
 * `/signin?next=<page path>` or `/signup?next=<page path>` (URL-encoded, the
 * `requireUser()` convention) so a guest returns to the account page after
 * signing in (D-T98-1). The paths are constants; each result is still checked
 * with `isAllowedInternalHref` and falls back to the bare auth page.
 */
export function accountAuthHref(auth: "/signin" | "/signup", key: AccountPageKey): string {
  const href = `${auth}?next=${encodeURIComponent(ACCOUNT_PAGES[key].path)}`;
  return isAllowedInternalHref(href) ? href : auth;
}

const SLUG = /^[a-z0-9-]{1,100}$/;

/** `/products/<slug>` (+ optional `#fragment`) when the slug is well formed and the route allowed, else null. */
export function productHref(slug: unknown, fragment?: string): string | null {
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  const href = `/products/${slug}${fragment === undefined ? "" : `#${fragment}`}`;
  return isAllowedInternalHref(href) ? href : null;
}

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** "November 7, 2026" (UTC, so server and client agree) for an ISO date-time with zone; null otherwise. */
export function formatAccountDate(iso: unknown): string | null {
  if (typeof iso !== "string" || iso.length > 40 || !ISO_WITH_ZONE.test(iso)) return null;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : DATE_FORMAT.format(new Date(time));
}

/** Machine-readable `dateTime` for `<time>`; null when {@link formatAccountDate} would be null. */
export function isoForTimeElement(iso: unknown): string | null {
  if (formatAccountDate(iso) === null) return null;
  return new Date(Date.parse(iso as string)).toISOString();
}

/**
 * Topic labels for `/account/messages`. Mirrors `CONTACT_TOPIC_LABELS` in the
 * ContactForm molecule (a `"use client"` module, so its values cannot be read
 * from a Server Component); a drift test pins the two together.
 */
export const CONTACT_TOPIC_TEXT: Readonly<Record<ContactTopic, string>> = {
  ordering: "Placing an order",
  payments: "Payments and billing",
  shipping: "Shipping and delivery",
  returns: "Returns and refunds",
  lists: "Wish lists and saved items",
  reviews: "Reviews and questions",
  account: "Your account",
  accessibility: "Accessibility",
  product: "A product",
  feedback: "Feedback about the site",
  other: "Something else",
};

/** Alert status label (criterion 4 wording on the alerts page). */
export function alertStatusText(status: "waiting" | "back_in_stock"): string {
  return status === "back_in_stock" ? "Back in stock" : "Watching";
}
