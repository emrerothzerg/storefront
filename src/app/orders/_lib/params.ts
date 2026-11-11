import {
  parseOrderPage,
  parseOrderQuery,
  parseOrderRange,
  parseOrderTab,
  type OrderRange,
  type OrderTab,
} from "@/components/organisms/OrdersList";
import { parseCheckoutNotice, type CheckoutNotice } from "@/components/organisms/_contracts/checkout-actions";
import { isOrderId } from "@/server/orders/order-service";

/**
 * Route/query param parsing for the order pages (T110, page-parser rule):
 * every value is validated here before it reaches a loader or an organism.
 * No `next/*`, no DB access.
 */

export type SearchParamValue = string | string[] | undefined;
export type SearchParamsRecord = Readonly<Record<string, SearchParamValue>>;

export interface OrdersListParams {
  readonly tab: OrderTab;
  readonly range: OrderRange;
  readonly query: string;
  readonly page: number;
}

/** `/orders?tab&range&q&page`, parsed with the OrdersList helpers (garbage -> defaults). */
export function parseOrdersListParams(params: SearchParamsRecord | null | undefined): OrdersListParams {
  const sp: SearchParamsRecord = params ?? {};
  return {
    tab: parseOrderTab(sp.tab),
    range: parseOrderRange(sp.range),
    query: parseOrderQuery(sp.q),
    page: parseOrderPage(sp.page),
  };
}

/** Canonical lower-case UUID v4 (what `crypto.randomUUID()` produces); anything else is not an order id. */
export function isOrderIdShape(value: unknown): value is string {
  return isOrderId(value);
}

export type OrderDetailVariant = "confirmation" | "detail";

export interface OrderDetailParams {
  readonly variant: OrderDetailVariant;
  /** Checkout's post-order notice token (`?notice=`), fixed tokens only. */
  readonly notice: CheckoutNotice | null;
}

/** `?placed=1` (exactly, single value) -> confirmation; everything else -> detail. */
export function parseOrderDetailParams(params: SearchParamsRecord | null | undefined): OrderDetailParams {
  const sp: SearchParamsRecord = params ?? {};
  const placed = sp.placed;
  return {
    variant: placed === "1" ? "confirmation" : "detail",
    notice: typeof sp.notice === "string" ? parseCheckoutNotice(sp.notice) : null,
  };
}

/**
 * Display-only short order reference ("0F1E2D3C"): first 8 characters of a
 * valid order id, upper-cased; null for anything that is not an order id, so
 * arbitrary URL text never reaches a title or breadcrumb.
 */
export function shortOrderNumber(id: unknown): string | null {
  return isOrderIdShape(id) ? id.slice(0, 8).toUpperCase() : null;
}
