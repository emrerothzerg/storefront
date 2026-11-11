import type { OrderView } from "@/server/orders/order-service";

/** Test-only OrderView fixtures shared by the OrderDetail and OrdersList tests. */

export const ORDER_ID = "7d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6";
export const PRODUCT_A = "1a2b3c4d-1111-4222-8333-444455556666";
export const PRODUCT_B = "9f8e7d6c-aaaa-4bbb-8ccc-ddddeeeeffff";
/** Must never appear in markup (R-1 / MVP rule). Not on `OrderView` since FIX-orders-pages (ag); kept as a leak sentinel. */
export const IDEMPOTENCY_KEY = "0f0e0d0c-0b0a-4909-8807-060504030201";
export const SECRET_EMAIL = "jane.secret@example.com";
export const PLACED_AT = "2026-11-07T10:00:00.000Z";
export const PLACED_MS = Date.parse(PLACED_AT);

export function makeOrderView(overrides: Partial<OrderView> = {}): OrderView {
  return {
    id: ORDER_ID,
    status: "paid",
    items: [
      {
        productId: PRODUCT_A,
        name: "Trail Mug",
        unitPriceCents: 1500,
        quantity: 2,
        productSlug: "trail-mug",
        imageUrl: "/images/products/trail-mug.svg",
      },
      {
        productId: PRODUCT_B,
        name: "Wool Socks",
        unitPriceCents: 999,
        quantity: 1,
        productSlug: "wool-socks",
        imageUrl: null,
      },
    ],
    subtotalCents: 3999,
    discountCents: 400,
    couponCode: "WELCOME10",
    shippingCents: 599,
    shippingMethodName: "Standard Shipping",
    totalCents: 4198,
    currency: "USD",
    address: {
      fullName: "Jane Doe",
      email: SECRET_EMAIL,
      line1: "1 Main St",
      line2: "Apt 2",
      city: "Springfield",
      region: "IL",
      postalCode: "62701",
      country: "US",
    },
    cardLast4: "4242",
    createdAt: PLACED_AT,
    events: [{ id: 1, orderId: ORDER_ID, status: "processing", at: PLACED_AT, note: null }],
    fulfillmentStatus: "processing",
    timeline: [
      { status: "processing", at: PLACED_AT, state: "current", label: "Order placed" },
      { status: "packed", at: null, state: "upcoming", label: "Packed" },
      { status: "shipped", at: null, state: "upcoming", label: "Shipped" },
      { status: "delivered", at: null, state: "upcoming", label: "Delivered" },
    ],
    cancellable: true,
    cancellableUntil: "2026-11-07T10:30:00.000Z",
    estimatedDelivery: { start: "2026-11-12T00:00:00.000Z", end: "2026-11-14T00:00:00.000Z" },
    deliveryNote: null,
    simulatedTrackingNotice: "Tracking is simulated in this demo store.",
    ...overrides,
  };
}

export function makeCancelledOrderView(overrides: Partial<OrderView> = {}): OrderView {
  return makeOrderView({
    fulfillmentStatus: "cancelled",
    cancellable: false,
    cancellableUntil: null,
    cancelledAt: "2026-11-07T10:10:00.000Z",
    timeline: [
      { status: "processing", at: PLACED_AT, state: "complete", label: "Order placed" },
      { status: "cancelled", at: "2026-11-07T10:10:00.000Z", state: "cancelled", label: "Cancelled" },
    ],
    ...overrides,
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every UUID in a string, lower-cased and deduplicated. */
export function uuidsIn(text: string): string[] {
  return [...new Set((text.match(UUID) ?? []).map((u) => u.toLowerCase()))];
}
