import type { Address, Order, OrderStatus, PaymentFailureCode } from "@/lib/types";
import { createOrderService, isOrderId, type OrderService } from "@/server/orders/order-service";

/**
 * Server-only helpers for the order confirmation page (`/orders/[id]`).
 * Read-only: nothing here writes to the database.
 */

/** The subset of `OrderService` the page needs (lets tests pass a spy). */
export type OrderReader = Pick<OrderService, "getOrder">;

/**
 * The session's order, or `null` for a malformed id, an unknown id, a
 * missing session or another session's order (indistinguishable to callers).
 * Malformed ids are rejected here, before the service is touched.
 */
export function loadOrderPage(
  orderId: unknown,
  sessionId: string | null,
  orders: OrderReader = createOrderService(),
): Order | null {
  if (!isOrderId(orderId) || sessionId === null) return null;
  return orders.getOrder(orderId, sessionId);
}

/**
 * Short, human-friendly order reference: the first 8 characters of the id,
 * upper-cased. DISPLAY ONLY: it is not unique and must never be used to look
 * an order up.
 */
export function formatOrderNumber(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

export interface OrderStatusLabel {
  readonly label: string;
  readonly tone: "success" | "danger";
}

export function orderStatusLabel(status: OrderStatus): OrderStatusLabel {
  return status === "paid" ? { label: "Paid", tone: "success" } : { label: "Payment failed", tone: "danger" };
}

const FAILURE_SENTENCES: Readonly<Record<PaymentFailureCode, string>> = {
  DECLINED: "Your card was declined, so it was not charged.",
  INSUFFICIENT_FUNDS: "Your card has insufficient funds, so it was not charged.",
  PROCESSING_ERROR: "We couldn't process your payment, so your card was not charged.",
  INVALID_AMOUNT: "The payment amount was invalid, so your card was not charged.",
};

/** User-safe explanation for a failed payment; the card was never charged. */
export function paymentFailureSentence(code: PaymentFailureCode | undefined): string {
  return code === undefined ? FAILURE_SENTENCES.PROCESSING_ERROR : FAILURE_SENTENCES[code];
}

/** Postal address as display lines; an empty `line2` is omitted. */
export function formatAddress(address: Address): string[] {
  const line2 = address.line2?.trim();
  return [
    address.fullName,
    address.line1,
    ...(line2 ? [line2] : []),
    `${address.city}, ${address.region} ${address.postalCode}`,
    address.country,
  ];
}
