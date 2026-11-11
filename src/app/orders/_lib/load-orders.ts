import { toServiceTab, type BuyAgainProduct, type OrderRange, type OrderTab } from "@/components/organisms/OrdersList";
import type { OrderDetailOrder } from "@/components/organisms/OrderDetail";
import type { OrderSummaryProps } from "@/components/organisms/OrderSummary";
import type { CheckoutNotice } from "@/components/organisms/_contracts/checkout-actions";
import type { Address, OrderItem, PaymentFailureCode } from "@/lib/types";
import {
  getOrderService,
  type BuyAgainLine,
  type OrderServiceV2,
  type OrderView,
} from "@/server/orders/order-service";

import {
  isOrderIdShape,
  parseOrderDetailParams,
  parseOrdersListParams,
  type OrderDetailVariant,
  type SearchParamsRecord,
} from "./params";

/**
 * Server-only loaders for the order pages (T110). Pages stay thin: they read
 * the owner key with `readSessionId()` (never minted during render, SR10) and
 * hand it here. `now` is taken ONCE per request inside these loaders (render
 * stays pure, react-hooks/purity). The order service is resolved lazily, so a
 * request without an owner key never opens the database.
 *
 * Nothing returned here carries the owner key, the idempotency key or the
 * shopper's email (R-1): views are copied field by field.
 */

/** The order service methods these loaders use (tests pass a spy or a `:memory:` service). */
export type OrdersReader = Pick<OrderServiceV2, "listOrders" | "getBuyAgainLines" | "getOrderView" | "getOrder">;

export interface LoaderDeps {
  /** Defaults to the app singleton `getOrderService()`; called only when there is an owner key. */
  readonly getOrders?: () => OrdersReader;
  /** Epoch ms; defaults to `Date.now()` (read once per call). */
  readonly now?: number;
}

function resolveNow(now: number | undefined): number {
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now();
}

// ---------------------------------------------------------------------------
// /orders
// ---------------------------------------------------------------------------

export interface OrdersPageData {
  readonly tab: OrderTab;
  readonly range: OrderRange;
  readonly query: string;
  readonly page: number;
  readonly pageCount: number;
  readonly orders: readonly OrderView[];
  readonly buyAgainProducts: readonly BuyAgainProduct[];
}

/**
 * Buy Again grid entries from `getBuyAgainLines`: lines whose product was
 * deleted or unpublished (`product === null`) are dropped; name, slug, price
 * and currency come from the CURRENT product (what "Add to cart" will add),
 * the image falls back to the order snapshot.
 */
export function toBuyAgainProducts(lines: readonly BuyAgainLine[]): BuyAgainProduct[] {
  const out: BuyAgainProduct[] = [];
  for (const line of lines) {
    const product = line.product;
    if (product === null) continue;
    out.push({
      productId: product.id,
      slug: product.slug,
      name: product.name,
      imageUrl: product.imageUrl || line.imageUrl,
      priceCents: product.priceCents,
      currency: product.currency,
      inStock: line.available,
    });
  }
  return out;
}

/**
 * Data for `/orders`. No owner key -> the empty state for the requested tab
 * (no service call, no DB). Order tabs -> one `listOrders` page; Buy Again ->
 * `getBuyAgainLines`.
 */
export function loadOrdersPage(
  input: { readonly ownerKey: string | null; readonly searchParams: SearchParamsRecord | null | undefined },
  deps: LoaderDeps = {},
): OrdersPageData {
  const params = parseOrdersListParams(input.searchParams);
  const empty: OrdersPageData = { ...params, page: 1, pageCount: 0, orders: [], buyAgainProducts: [] };
  if (input.ownerKey === null) return empty;

  const orders = (deps.getOrders ?? getOrderService)();
  const serviceTab = toServiceTab(params.tab);
  if (serviceTab === null) {
    return { ...empty, buyAgainProducts: toBuyAgainProducts(orders.getBuyAgainLines(input.ownerKey)) };
  }
  const result = orders.listOrders(
    input.ownerKey,
    {
      tab: serviceTab,
      range: params.range,
      ...(params.query === "" ? {} : { query: params.query }),
      page: params.page,
    },
    resolveNow(deps.now),
  );
  return {
    ...params,
    page: result.page,
    pageCount: result.pageCount,
    orders: result.items,
    buyAgainProducts: [],
  };
}

// ---------------------------------------------------------------------------
// /orders/[id]
// ---------------------------------------------------------------------------

/** Explicit copy of the fields OrderDetail reads (no email, idempotency key or events). */
export function toDetailOrder(view: OrderView): OrderDetailOrder {
  return {
    id: view.id,
    status: view.status,
    createdAt: view.createdAt,
    items: view.items.map((item) => ({
      productId: item.productId,
      productSlug: item.productSlug,
      name: item.name,
      imageUrl: item.imageUrl,
      unitPriceCents: item.unitPriceCents,
      quantity: item.quantity,
    })),
    subtotalCents: view.subtotalCents,
    discountCents: view.discountCents,
    couponCode: view.couponCode,
    shippingCents: view.shippingCents,
    shippingMethodName: view.shippingMethodName,
    totalCents: view.totalCents,
    currency: view.currency,
    address: shipTo(view.address),
    cardLast4: view.cardLast4,
    fulfillmentStatus: view.fulfillmentStatus,
    timeline: view.timeline,
    cancellable: view.cancellable,
    cancellableUntil: view.cancellableUntil,
    estimatedDelivery: view.estimatedDelivery,
    deliveryNote: view.deliveryNote,
    ...(view.cancelledAt === undefined ? {} : { cancelledAt: view.cancelledAt }),
  };
}

export interface ShipToAddress {
  readonly fullName: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
}

/** Postal fields only: the order email is never passed to markup. */
export function shipTo(address: Address): ShipToAddress {
  return {
    fullName: address.fullName,
    line1: address.line1,
    line2: address.line2 ?? null,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country,
  };
}

/** A declined order (MVP T25 confirmation): only what the failure page shows. */
export interface FailedOrder {
  readonly id: string;
  readonly items: readonly OrderItem[];
  readonly subtotalCents: number;
  readonly shippingCents: number;
  readonly totalCents: number;
  readonly currency: string;
  readonly address: ShipToAddress;
  readonly cardLast4: string;
  readonly failureCode: PaymentFailureCode | undefined;
}

export type OrderDetailData =
  | {
      readonly kind: "order";
      readonly order: OrderDetailOrder;
      readonly variant: OrderDetailVariant;
      readonly notice: CheckoutNotice | null;
      /** The request clock for OrderDetail's cancel window (taken once). */
      readonly now: number;
    }
  | { readonly kind: "payment_failed"; readonly order: FailedOrder };

/**
 * Data for `/orders/[id]`, or `null` for every "not yours" case (malformed id,
 * no owner key, unknown id, another owner's order, anonymised order): the page
 * maps null to ONE `notFound()` call, so existence never leaks. Malformed ids
 * and missing owner keys return before the service (and the DB) is touched.
 *
 * Paid orders -> `getOrderView` (persists newly reached fulfilment events at
 * most once per status). The owner's own declined order is not an order view
 * (T55), so it falls back to the MVP `getOrder` and renders the T25
 * "Payment failed" page. A pending claim (charge in flight) is excluded by
 * `getOrder` itself, so it is `null` here (404), never "Payment failed"
 * (D-T110-2).
 */
export function loadOrderDetail(
  input: {
    readonly id: unknown;
    readonly ownerKey: string | null;
    readonly searchParams?: SearchParamsRecord | null | undefined;
  },
  deps: LoaderDeps = {},
): OrderDetailData | null {
  if (!isOrderIdShape(input.id) || input.ownerKey === null) return null;
  const orders = (deps.getOrders ?? getOrderService)();
  const now = resolveNow(deps.now);
  const view = orders.getOrderView(input.id, input.ownerKey, now);
  if (view !== null) {
    const params = parseOrderDetailParams(input.searchParams);
    return { kind: "order", order: toDetailOrder(view), variant: params.variant, notice: params.notice, now };
  }
  const order = orders.getOrder(input.id, input.ownerKey);
  if (order === null || order.status !== "payment_failed") return null;
  return {
    kind: "payment_failed",
    order: {
      id: order.id,
      items: order.items.map((item) => ({
        productId: item.productId,
        name: item.name,
        unitPriceCents: item.unitPriceCents,
        quantity: item.quantity,
      })),
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      totalCents: order.totalCents,
      currency: order.currency,
      address: shipTo(order.address),
      cardLast4: order.cardLast4,
      failureCode: order.failureCode,
    },
  };
}

// ---------------------------------------------------------------------------
// /orders/[id]/invoice
// ---------------------------------------------------------------------------

export type InvoiceSummaryProps = Omit<OrderSummaryProps, "className" | "heading" | "headingLevel">;

/**
 * `OrderSummary variant="invoice"` props from a view: server totals as stored
 * (snapshot prices, never re-priced), free shipping as `shippingCents={0}` +
 * `isFreeShipping`, the invoice header with order id, placed date, status
 * ("Cancelled" for a cancelled order, else the payment status), last 4,
 * bill-to name and ship-to postal lines (no email).
 */
export function toInvoiceSummary(view: OrderView): InvoiceSummaryProps {
  const isFree = view.shippingCents === 0;
  const cancelled = view.fulfillmentStatus === "cancelled";
  const address = shipTo(view.address);
  return {
    variant: "invoice",
    items: view.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
    })),
    subtotalCents: view.subtotalCents,
    discountCents: view.discountCents,
    couponCode: view.couponCode,
    shippingCents: isFree ? 0 : view.shippingCents,
    isFreeShipping: isFree,
    shippingMethodName: view.shippingMethodName,
    totalCents: view.totalCents,
    currency: view.currency,
    deliveryNote: view.deliveryNote,
    estimatedDelivery: cancelled ? null : view.estimatedDelivery,
    invoice: {
      orderId: view.id,
      placedAt: view.createdAt,
      status: cancelled ? "cancelled" : view.status,
      paymentLast4: view.cardLast4,
      billToName: address.fullName,
      shipTo: address,
    },
  };
}

export interface InvoiceData {
  readonly orderId: string;
  readonly summary: InvoiceSummaryProps;
}

/** Same ownership path as the detail page: anything not owned (or not paid) -> null -> 404. */
export function loadInvoice(
  input: { readonly id: unknown; readonly ownerKey: string | null },
  deps: LoaderDeps = {},
): InvoiceData | null {
  if (!isOrderIdShape(input.id) || input.ownerKey === null) return null;
  const orders = (deps.getOrders ?? getOrderService)();
  const view = orders.getOrderView(input.id, input.ownerKey, resolveNow(deps.now));
  return view === null ? null : { orderId: view.id, summary: toInvoiceSummary(view) };
}
