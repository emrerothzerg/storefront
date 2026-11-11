import type { IconName } from "@/components/atoms/Icon";
import { isAllowedInternalHref } from "@/content/routes";
import type { StockAlertView } from "@/server/alerts/stock-alert-service";

/**
 * Pure view-model helpers for AccountHub (no React, no server imports beyond
 * types). Kept separate so they can be unit-tested directly.
 */

/** Counts shown on the hub cards. Non-finite or negative values count as 0. */
export interface AccountHubCounts {
  readonly orders: number;
  readonly lists: number;
  readonly addresses: number;
  readonly history: number;
  readonly reviews: number;
  readonly questions: number;
  readonly alerts: number;
  readonly messages: number;
}

/** One unacknowledged back-in-stock alert (map with {@link toBackInStockItems}). */
export interface AccountHubBackInStockItem {
  readonly alertId: string;
  readonly productSlug: string;
  readonly productName: string;
  /**
   * false when the product is no longer offered (unpublished at the read's
   * `now`, D-T98-4): the hub renders the name as text with "No longer
   * available" and only the Acknowledge form. Absent = available.
   */
  readonly available?: boolean;
}

export type AccountHubCardKey =
  | "orders"
  | "lists"
  | "addresses"
  | "history"
  | "contributions"
  | "alerts"
  | "messages"
  | "help";

export interface AccountHubCardDef {
  readonly key: AccountHubCardKey;
  readonly title: string;
  readonly href: string;
  readonly icon: IconName;
  /** Count line, or the invitation when the count is zero. */
  readonly describe: (counts: AccountHubCounts) => string;
}

export interface AccountHubCard {
  readonly key: AccountHubCardKey;
  readonly title: string;
  readonly href: string;
  readonly icon: IconName;
  readonly description: string;
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/** Non-negative integer; NaN, Infinity, negatives and non-numbers become 0. */
export function safeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** "1 order", "2 orders", "1,234 orders". */
export function pluralize(count: number, singular: string, plural: string): string {
  const n = safeCount(count);
  return `${NUMBER_FORMAT.format(n)} ${n === 1 ? singular : plural}`;
}

/** Returns a copy of `counts` with every value passed through {@link safeCount}. */
export function normalizeCounts(counts: AccountHubCounts): AccountHubCounts {
  return {
    orders: safeCount(counts.orders),
    lists: safeCount(counts.lists),
    addresses: safeCount(counts.addresses),
    history: safeCount(counts.history),
    reviews: safeCount(counts.reviews),
    questions: safeCount(counts.questions),
    alerts: safeCount(counts.alerts),
    messages: safeCount(counts.messages),
  };
}

function countOrInvite(count: number, singular: string, plural: string, invitation: string): string {
  return count > 0 ? pluralize(count, singular, plural) : invitation;
}

/** The eight hub cards in display order (criterion 1). */
export const ACCOUNT_HUB_CARDS: readonly AccountHubCardDef[] = [
  {
    key: "orders",
    title: "Your Orders",
    href: "/orders",
    icon: "package",
    describe: (c) => countOrInvite(c.orders, "order", "orders", "No orders yet. Start shopping"),
  },
  {
    key: "lists",
    title: "Your Lists",
    href: "/lists",
    icon: "heart",
    describe: (c) => countOrInvite(c.lists, "list", "lists", "Save something you love"),
  },
  {
    key: "addresses",
    title: "Addresses",
    href: "/account/addresses",
    icon: "location",
    describe: (c) => countOrInvite(c.addresses, "saved address", "saved addresses", "Add an address"),
  },
  {
    key: "history",
    title: "Browsing History",
    href: "/account/history",
    icon: "clock",
    describe: (c) => countOrInvite(c.history, "item", "items", "Start browsing to see items here"),
  },
  {
    key: "contributions",
    title: "Your Reviews & Questions",
    href: "/account/contributions",
    icon: "star",
    describe: (c) =>
      c.reviews > 0 || c.questions > 0
        ? `${pluralize(c.reviews, "review", "reviews")}, ${pluralize(c.questions, "question", "questions")}`
        : "Share your first review",
  },
  {
    key: "alerts",
    title: "Stock Alerts",
    href: "/account/alerts",
    icon: "info",
    describe: (c) => countOrInvite(c.alerts, "alert", "alerts", "Get told when items are back in stock"),
  },
  {
    key: "messages",
    title: "Messages",
    href: "/account/messages",
    icon: "mail",
    describe: (c) => countOrInvite(c.messages, "message", "messages", "Contact us any time"),
  },
  {
    key: "help",
    title: "Help",
    href: "/help",
    icon: "question-circle",
    describe: () => "Orders, returns, shipping and more",
  },
];

export function devWarn(message: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`AccountHub: ${message}`);
  }
}

/**
 * Resolves card definitions against the counts. Cards whose href fails
 * `isAllowedInternalHref` are omitted with a dev warning.
 */
export function buildAccountHubCards(
  counts: AccountHubCounts,
  defs: readonly AccountHubCardDef[] = ACCOUNT_HUB_CARDS,
): AccountHubCard[] {
  const safe = normalizeCounts(counts);
  const cards: AccountHubCard[] = [];
  for (const def of defs) {
    if (!isAllowedInternalHref(def.href)) {
      devWarn(`dropped card "${def.title}" with disallowed href "${def.href}".`);
      continue;
    }
    cards.push({ key: def.key, title: def.title, href: def.href, icon: def.icon, description: def.describe(safe) });
  }
  return cards;
}

const SLUG = /^[a-z0-9-]{1,100}$/;
const ALERT_ID = /^[A-Za-z0-9-]{1,100}$/;

/** `/products/<slug>` when the slug is well formed and the route allowed, else null. */
export function productHref(slug: string): string | null {
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  const href = `/products/${slug}`;
  return isAllowedInternalHref(href) ? href : null;
}

export function isPostableAlertId(alertId: string): boolean {
  return typeof alertId === "string" && ALERT_ID.test(alertId);
}

/**
 * Maps `stockAlertService.listBackInStock(...)` output to the hub's item
 * shape (drops alerts whose product is gone). An unpublished product
 * (`available: false`) maps to `productSlug: ""` and `available: false`
 * (the key is only present then). Carries no owner key.
 */
export function toBackInStockItems(views: readonly StockAlertView[]): AccountHubBackInStockItem[] {
  const items: AccountHubBackInStockItem[] = [];
  for (const view of views) {
    if (view.product === null) continue;
    if (view.available === false) {
      items.push({ alertId: view.id, productSlug: "", productName: view.product.name, available: false });
    } else {
      items.push({ alertId: view.id, productSlug: view.product.slug, productName: view.product.name });
    }
  }
  return items;
}
