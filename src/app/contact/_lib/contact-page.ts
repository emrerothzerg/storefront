/**
 * Data for `/contact` (T101). Read-only: the owner key comes from
 * `readSessionId()` (never `getOrCreateSessionId()`, so rendering never sets
 * a cookie, SR10). Query params are validated before they reach
 * ContactSection (Page-parser rule):
 *
 * - `topic`: must be a contact topic (`order` is accepted as an alias of
 *   `ordering`, the backlog's spelling); anything else is dropped.
 * - `order`: must be a canonical order id AND one of the visitor's own
 *   orders; a foreign, unknown or malformed id is ignored silently.
 * - `ref`: product slug shape (lower-case kebab-case, at most 128 chars),
 *   honoured only with `topic=product`.
 *
 * The order list carries ids and labels only: no owner key, email, address
 * or totals reach the page.
 */

import { unstable_rethrow } from "next/navigation";

import { CONTACT_TOPICS, type ContactTopic } from "@/server/contact/contact-service";
import { getOrderService, isOrderId, type OrderServiceV2, type OrderView } from "@/server/orders/order-service";
import { readCurrentUser, type CurrentUser } from "@/server/session/current-user";
import { readSessionId } from "@/server/session/session";

import { tokenParam, type RawSearchParams } from "../../help/_lib/search-params";

export const CONTACT_PATH = "/contact";
export const CONTACT_TITLE = "Contact us";
export const CONTACT_DESCRIPTION =
  "Send a message about an order, a product, your account or anything else. We reply within two business days.";

/** Orders offered in the "Which order?" select (newest first; one service page). */
export const MAX_CONTACT_ORDER_OPTIONS = 10;

/** Backlog links use `?topic=order`; the service topic is `ordering`. */
const TOPIC_ALIASES: Readonly<Record<string, ContactTopic>> = { order: "ordering" };

const TOPIC_SET: ReadonlySet<string> = new Set(CONTACT_TOPICS);

const MAX_REF_LENGTH = 128;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ContactOrderOptionView {
  readonly id: string;
  readonly label: string;
}

export interface ContactQuery {
  readonly topic: ContactTopic | undefined;
  /** Shape-valid order id; ownership is checked in `loadContactPage`. */
  readonly orderId: string | undefined;
  readonly productSlug: string | undefined;
}

export interface ContactPageData {
  readonly orders: readonly ContactOrderOptionView[];
  readonly initialTopic: ContactTopic | undefined;
  readonly initialOrderId: string | undefined;
  readonly productSlug: string | undefined;
  /** Display only (prefills the email field). Null for guests. */
  readonly signedInEmail: string | null;
}

export type ContactOrderReader = Pick<OrderServiceV2, "listOrders" | "getOrderView">;

export interface ContactPageDeps {
  /** Owner key or null; must never create a session. */
  readonly readOwnerKey: () => Promise<string | null>;
  readonly readUser: () => Promise<CurrentUser | null>;
  /** Called only when an owner key exists (so guests never open the database). */
  readonly orders: () => ContactOrderReader;
}

export const defaultContactPageDeps: ContactPageDeps = {
  readOwnerKey: readSessionId,
  readUser: readCurrentUser,
  orders: getOrderService,
};

export function isContactTopic(value: string): value is ContactTopic {
  return TOPIC_SET.has(value);
}

export function parseContactTopic(value: unknown): ContactTopic | undefined {
  const raw = tokenParam(value);
  if (raw === null) return undefined;
  const topic = TOPIC_ALIASES[raw] ?? raw;
  return isContactTopic(topic) ? topic : undefined;
}

export function isProductRef(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_REF_LENGTH && SLUG_PATTERN.test(value);
}

export function parseContactQuery(params: RawSearchParams | undefined): ContactQuery {
  const topic = parseContactTopic(params?.topic);
  const order = tokenParam(params?.order);
  const ref = tokenParam(params?.ref);
  return {
    topic,
    orderId: order !== null && isOrderId(order) ? order : undefined,
    productSlug: topic === "product" && isProductRef(ref) ? ref : undefined,
  };
}

const LABEL_DATE = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "Order #" + first 8 id characters upper-cased + " · Nov 7, 2026" (date omitted when unparsable). */
export function contactOrderLabel(order: Pick<OrderView, "id" | "createdAt">): string {
  const number = `Order #${order.id.slice(0, 8).toUpperCase()}`;
  const ms = Date.parse(order.createdAt);
  return Number.isFinite(ms) ? `${number} · ${LABEL_DATE.format(ms)}` : number;
}

function toOption(order: Pick<OrderView, "id" | "createdAt">): ContactOrderOptionView {
  return { id: order.id, label: contactOrderLabel(order) };
}

/**
 * The visitor's own orders (newest first) plus, when `requested` is one of
 * their older orders beyond the first page, that order too. Read errors fall
 * back to no orders: the contact form must stay usable.
 */
function loadOwnOrders(
  reader: () => ContactOrderReader,
  ownerKey: string,
  requested: string | undefined,
): ContactOrderOptionView[] {
  try {
    const service = reader();
    const page = service.listOrders(ownerKey, { tab: "all", range: "all", page: 1 });
    const options = page.items.slice(0, MAX_CONTACT_ORDER_OPTIONS).map(toOption);
    if (requested !== undefined && !options.some((option) => option.id === requested)) {
      const view = service.getOrderView(requested, ownerKey);
      if (view !== null) options.push(toOption(view));
    }
    return options;
  } catch (error) {
    unstable_rethrow(error);
    console.error("[contact-page] orders_unavailable");
    return [];
  }
}

export async function loadContactPage(
  params: RawSearchParams | undefined,
  deps: ContactPageDeps = defaultContactPageDeps,
): Promise<ContactPageData> {
  const query = parseContactQuery(params);
  const [ownerKey, user] = await Promise.all([deps.readOwnerKey(), deps.readUser()]);
  const orders = ownerKey === null ? [] : loadOwnOrders(deps.orders, ownerKey, query.orderId);
  const initialOrderId =
    query.orderId !== undefined && orders.some((order) => order.id === query.orderId)
      ? query.orderId
      : undefined;
  return {
    orders,
    initialTopic: query.topic ?? (initialOrderId !== undefined ? "ordering" : undefined),
    initialOrderId,
    productSlug: query.productSlug,
    signedInEmail: user?.email ?? null,
  };
}
