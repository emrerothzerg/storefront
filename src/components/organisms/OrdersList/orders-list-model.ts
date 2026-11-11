import { isAllowedInternalHref } from "@/content/routes";
import type { OrderCardData } from "@/components/molecules/OrderCard";
import type { FulfillmentStatus } from "@/lib/types";

/**
 * Pure helpers for the order history (T94). Exported so the `/orders` page
 * (T110) parses search params and builds links exactly like the organism.
 * Never throw.
 */

export const ORDER_TABS = [
  { value: "orders", label: "Orders", serviceTab: "all" },
  { value: "buy-again", label: "Buy Again", serviceTab: null },
  { value: "not-shipped", label: "Not Yet Shipped", serviceTab: "not_shipped" },
  { value: "cancelled", label: "Cancelled", serviceTab: "cancelled" },
] as const;

export type OrderTab = (typeof ORDER_TABS)[number]["value"];
/** The order service's `listOrders` tab (`OrdersTab`), or null for the Buy Again tab. */
export type OrderServiceTab = (typeof ORDER_TABS)[number]["serviceTab"];
export const DEFAULT_ORDER_TAB: OrderTab = "orders";

/** Same values as the order service's `ORDERS_RANGES`. */
export const ORDER_RANGES = ["30d", "3m", "6m", "1y", "all"] as const;
export type OrderRange = (typeof ORDER_RANGES)[number];
export const DEFAULT_ORDER_RANGE: OrderRange = "3m";

export const ORDER_RANGE_LABELS: Readonly<Record<OrderRange, string>> = {
  "30d": "Last 30 days",
  "3m": "Past 3 months",
  "6m": "Past 6 months",
  "1y": "Past year",
  all: "All orders",
};

/** Search input limit (input-limit table: search query 100 chars). */
export const MAX_ORDER_QUERY_LENGTH = 100;
export const DEFAULT_ORDERS_BASE_PATH = "/orders";

/** Search params arrive as `string | string[] | undefined`; the first value wins. */
function firstString(value: unknown): string | null {
  const v = Array.isArray(value) ? (value as readonly unknown[])[0] : value;
  return typeof v === "string" ? v : null;
}

function isOneOf<T extends string>(list: readonly T[], value: string | null): value is T {
  return value !== null && (list as readonly string[]).includes(value);
}

const TAB_VALUES: readonly OrderTab[] = ORDER_TABS.map((tab) => tab.value);

/** Unknown, missing or garbage -> "orders". */
export function parseOrderTab(value: unknown): OrderTab {
  const v = firstString(value);
  return isOneOf(TAB_VALUES, v) ? v : DEFAULT_ORDER_TAB;
}

/** Unknown, missing or garbage -> "3m" (criterion 4). */
export function parseOrderRange(value: unknown): OrderRange {
  const v = firstString(value);
  return isOneOf(ORDER_RANGES, v) ? v : DEFAULT_ORDER_RANGE;
}

/** Trimmed, whitespace collapsed, control characters dropped, at most 100 characters. */
export function parseOrderQuery(value: unknown): string {
  const v = firstString(value);
  if (v === null) return "";
  const cleaned = v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(cleaned).slice(0, MAX_ORDER_QUERY_LENGTH).join("").trim();
}

/** Positive integer (digits only) or 1. */
export function parseOrderPage(value: unknown): number {
  const v = typeof value === "number" ? String(value) : firstString(value);
  if (v === null || !/^\d{1,9}$/.test(v.trim())) return 1;
  const n = Number(v.trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

/** Maps the UI tab to the order service tab; null for Buy Again (use `getBuyAgainLines`). */
export function toServiceTab(tab: OrderTab): OrderServiceTab {
  const entry = ORDER_TABS.find((candidate) => candidate.value === tab);
  return entry === undefined ? "all" : entry.serviceTab;
}

/** Strips query/fragment; anything that is not an allowed internal path -> "/orders". */
export function normaliseBasePath(basePath: unknown): string {
  if (typeof basePath !== "string") return DEFAULT_ORDERS_BASE_PATH;
  const cut = basePath.search(/[?#]/);
  const path = cut === -1 ? basePath : basePath.slice(0, cut);
  return path !== "" && isAllowedInternalHref(path) ? path : DEFAULT_ORDERS_BASE_PATH;
}

export interface OrdersHrefParams {
  tab?: unknown;
  range?: unknown;
  q?: unknown;
  page?: unknown;
}

/**
 * `/orders?tab=…&range=…&q=…&page=…` with defaults dropped (tab "orders",
 * range "3m", empty query, page 1) and values re-parsed and encoded.
 */
export function buildOrdersHref(basePath: unknown, params: OrdersHrefParams = {}): string {
  const path = normaliseBasePath(basePath);
  const search = new URLSearchParams();
  const tab = parseOrderTab(params.tab);
  const range = parseOrderRange(params.range);
  const q = parseOrderQuery(params.q);
  const page = parseOrderPage(params.page);
  if (tab !== DEFAULT_ORDER_TAB) search.set("tab", tab);
  if (range !== DEFAULT_ORDER_RANGE) search.set("range", range);
  if (q !== "") search.set("q", q);
  if (page > 1) search.set("page", String(page));
  const qs = search.toString();
  return qs === "" ? path : `${path}?${qs}`;
}

/** The subset of the order service's `OrderView` the history needs (OrderView fits). */
export interface OrdersListOrder {
  readonly id: string;
  readonly createdAt: string;
  readonly totalCents: number;
  readonly currency: string;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly cancellable: boolean;
  readonly address: { readonly fullName: string };
  readonly items: readonly {
    readonly productId: string;
    readonly productSlug: string | null;
    readonly name: string;
    readonly imageUrl: string | null;
    readonly quantity: number;
  }[];
}

/** Explicit field copy: nothing else from the view (idempotency key, email, events) is passed on. */
export function toOrderCardData(order: OrdersListOrder): OrderCardData {
  const items = Array.isArray(order.items) ? order.items : [];
  return {
    id: order.id,
    createdAt: order.createdAt,
    totalCents: order.totalCents,
    currency: order.currency,
    shipToName: typeof order.address?.fullName === "string" ? order.address.fullName : "",
    fulfillmentStatus: order.fulfillmentStatus,
    cancellable: order.cancellable === true,
    items: items.map((item) => ({
      productId: item.productId,
      productSlug: item.productSlug,
      name: item.name,
      imageUrl: item.imageUrl,
      quantity: item.quantity,
    })),
  };
}

export interface BuyAgainProduct {
  readonly productId: string;
  readonly slug: string;
  readonly name: string;
  readonly imageUrl: string | null;
  readonly priceCents: number;
  readonly currency: string;
  readonly inStock: boolean;
}

/** Each product once (first occurrence wins); entries without an id or name are dropped. */
export function dedupeBuyAgainProducts(products: readonly BuyAgainProduct[]): BuyAgainProduct[] {
  const seen = new Set<string>();
  const out: BuyAgainProduct[] = [];
  for (const product of Array.isArray(products) ? products : []) {
    if (product == null || typeof product.productId !== "string" || product.productId.trim() === "") continue;
    if (typeof product.name !== "string" || product.name.trim() === "") continue;
    if (seen.has(product.productId)) continue;
    seen.add(product.productId);
    out.push(product);
  }
  return out;
}

export interface OrdersEmptyState {
  readonly title: string;
  readonly body: string;
  readonly links: readonly { readonly href: string; readonly label: string }[];
}

/** Copy and next-step links per tab (criterion 2). Filtered order tabs offer "Clear search". */
export function ordersEmptyState(
  tab: OrderTab,
  options: { basePath: string; range: OrderRange; query: string },
): OrdersEmptyState {
  const basePath = normaliseBasePath(options.basePath);
  const filtered = options.query !== "" || options.range !== DEFAULT_ORDER_RANGE;
  const clear = { href: buildOrdersHref(basePath, { tab }), label: "Clear search and filters" };
  let state: OrdersEmptyState;
  switch (tab) {
    case "buy-again":
      state = {
        title: "Nothing to buy again yet",
        body: "Products from your past orders will appear here.",
        links: [{ href: "/products", label: "Start shopping" }],
      };
      break;
    case "not-shipped":
      state = {
        title: "No orders waiting to ship",
        body: filtered
          ? "No unshipped orders match your search in this time range."
          : "Every order in this time range has shipped or was cancelled.",
        links: [...(filtered ? [clear] : []), { href: buildOrdersHref(basePath), label: "View all orders" }],
      };
      break;
    case "cancelled":
      state = {
        title: "No cancelled orders",
        body: filtered
          ? "No cancelled orders match your search in this time range."
          : "You have not cancelled any orders in this time range.",
        links: [
          ...(filtered ? [clear] : []),
          { href: "/help/ordering", label: "Learn about cancelling orders" },
        ],
      };
      break;
    default:
      state = filtered
        ? {
            title: "No orders found",
            body: "No orders match your search in this time range.",
            links: [clear, { href: "/products", label: "Start shopping" }],
          }
        : {
            title: "No orders yet",
            body: "Orders you place will appear here.",
            links: [{ href: "/products", label: "Start shopping" }],
          };
  }
  return { ...state, links: state.links.filter((link) => isAllowedInternalHref(link.href)) };
}
