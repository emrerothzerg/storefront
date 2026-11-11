import type { BreadcrumbItem } from "@/components/atoms/Breadcrumb";
import { isAllowedInternalHref } from "@/content/routes";

import { shortOrderNumber } from "./params";

/** Copy, titles and links shared by the order pages (T110). Pure. */

export const ORDERS_PATH = "/orders";
export const ORDERS_TITLE = "Your Orders";
export const ORDERS_DESCRIPTION = "Track, cancel or buy again from your orders.";
export const ORDER_DESCRIPTION = "Your order details.";
export const INVOICE_DESCRIPTION = "Printable invoice for your order.";

/** "Order #" + the first 8 id chars upper-cased; "Order" for anything that is not an order id. */
export function orderTitle(id: unknown): string {
  const short = shortOrderNumber(id);
  return short === null ? "Order" : `Order #${short}`;
}

/** "Invoice · Order #…" (first 8 id chars). */
export function invoiceTitle(id: unknown): string {
  return `Invoice · ${orderTitle(id)}`;
}

/** Invoice page h1: "Invoice for order #…" (first 8 id chars). */
export function invoiceHeading(id: unknown): string {
  const short = shortOrderNumber(id);
  return short === null ? "Invoice" : `Invoice for order #${short}`;
}

/** `/orders/<id>`; null unless the id is an order id and the path is allowed. */
export function orderHref(id: unknown): string | null {
  if (shortOrderNumber(id) === null) return null;
  const href = `${ORDERS_PATH}/${encodeURIComponent(String(id))}`;
  return isAllowedInternalHref(href) ? href : null;
}

export function ordersBreadcrumb(): BreadcrumbItem[] {
  return [{ label: "Home", href: "/" }, { label: ORDERS_TITLE }];
}

/** Home › Your Orders › Order #… (current page). */
export function orderBreadcrumb(id: unknown): BreadcrumbItem[] {
  return [{ label: "Home", href: "/" }, { label: ORDERS_TITLE, href: ORDERS_PATH }, { label: orderTitle(id) }];
}
