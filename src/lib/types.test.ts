import { describe, expect, test } from "bun:test";
import {
  ERROR_CODES,
  type Address,
  type Cart,
  type CartItemStatus,
  type CouponKind,
  type FulfillmentStatus,
  type ListKind,
  type ProductDetail,
  type ReviewSummary,
  type StarRating,
  type ErrorCode,
  type Order,
  type OrderStatus,
  type PaymentFailureCode,
  type PaymentFailure,
  type Product,
} from "./types";

const address: Address = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical St",
  city: "London",
  region: "Greater London",
  postalCode: "N1 1AA",
  country: "GB",
};

describe("types", () => {
  test("ERROR_CODES lists every backlog error code exactly once", () => {
    const expected: readonly ErrorCode[] = [
      "PRODUCT_NOT_FOUND",
      "OUT_OF_STOCK",
      "INSUFFICIENT_STOCK",
      "INVALID_QUANTITY",
      "INVALID_INPUT",
      "VALIDATION_FAILED",
      "EMPTY_CART",
      "STOCK_CHANGED",
      "ORDER_NOT_FOUND",
      "PAYMENT_FAILED",
      "MONEY_OVERFLOW",
      "NOT_FOUND",
      "DUPLICATE",
      "ALREADY_VOTED",
      "COUPON_INVALID",
      "COUPON_EXPIRED",
      "COUPON_MIN_SUBTOTAL",
      "COUPON_EXHAUSTED",
      "COUPON_USED",
      "LIST_NOT_FOUND",
      "ORDER_NOT_CANCELLABLE",
      "LIMIT_REACHED",
      "TOO_LONG",
      "RATE_LIMITED",
      "FORBIDDEN",
      // Accounts
      "INVALID_CREDENTIALS",
      "EMAIL_TAKEN",
      "UNAUTHENTICATED",
      "ACCOUNT_LOCKED",
      "INTERNAL_ERROR",
    ];
    expect([...ERROR_CODES].sort()).toEqual([...expected].sort());
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  test("Order status is limited to paid | payment_failed (compile-time)", () => {
    const statuses: readonly OrderStatus[] = ["paid", "payment_failed"];
    // @ts-expect-error "pending" is not an OrderStatus
    const bad: OrderStatus = "pending";
    expect(statuses).toHaveLength(2);
    expect(String(bad)).toBe("pending");
  });

  test("CartItem status and payment failure codes are string-literal unions", () => {
    // @ts-expect-error "gone" is not a CartItemStatus
    const badStatus: CartItemStatus = "gone";
    const failure: PaymentFailure = { code: "DECLINED", message: "Your card was declined." };
    // @ts-expect-error "STOLEN" is not a PaymentFailureCode
    const badFailure: PaymentFailure = { code: "STOLEN", message: "x" };
    expect([badStatus, failure.code, badFailure.code].map(String)).toEqual([
      "gone",
      "DECLINED",
      "STOLEN",
    ]);
  });

  test("domain objects are plain JSON-serializable data", () => {
    const product: Product = {
      id: "p1",
      slug: "mug",
      name: "Mug",
      description: "A mug",
      priceCents: 1299,
      currency: "USD",
      imageUrl: "/mug.png",
      stock: 3,
    };
    const cart: Cart = {
      sessionId: "s1",
      items: [{ productId: "p1", quantity: 2, unitPriceCents: 1299, status: "ok" }],
      subtotalCents: 2598,
      currency: "USD",
    };
    const order: Order = {
      id: "o1",
      sessionId: "s1",
      status: "paid",
      items: [{ productId: "p1", name: "Mug", unitPriceCents: 1299, quantity: 2 }],
      subtotalCents: 2598,
      shippingCents: 0,
      totalCents: 2598,
      currency: "USD",
      address,
      cardLast4: "4242",
      idempotencyKey: "k1",
      createdAt: "2026-11-06T12:00:00.000Z",
    };
    for (const value of [product, cart, order]) {
      expect(JSON.parse(JSON.stringify(value))).toEqual(value);
    }
  });

  test("Order failureCode is an optional PaymentFailureCode (compile-time)", () => {
    const failed: Pick<Order, "status" | "failureCode"> = {
      status: "payment_failed",
      failureCode: "INSUFFICIENT_FUNDS",
    };
    const paid: Pick<Order, "status" | "failureCode"> = { status: "paid" };
    const code: PaymentFailureCode | undefined = failed.failureCode;
    // @ts-expect-error "STOLEN" is not a PaymentFailureCode
    const bad: Pick<Order, "failureCode"> = { failureCode: "STOLEN" };
    expect(code).toBe("INSUFFICIENT_FUNDS");
    expect("failureCode" in paid).toBe(false);
    expect(JSON.parse(JSON.stringify(failed))).toEqual(failed);
    expect(String(bad.failureCode)).toBe("STOLEN");
  });

  test("Order shippingCents is any amount since phase 2 shipping methods (compile-time)", () => {
    const free: Pick<Order, "shippingCents"> = { shippingCents: 0 };
    const express: Pick<Order, "shippingCents"> = { shippingCents: 999 };
    // @ts-expect-error shipping is still integer minor units, not a string
    const bad: Pick<Order, "shippingCents"> = { shippingCents: "9.99" };
    expect([free.shippingCents, express.shippingCents, String(bad.shippingCents)]).toEqual([0, 999, "9.99"]);
  });

  test("phase 2 Order fields are optional; fulfillmentStatus is a closed union", () => {
    const statuses: readonly FulfillmentStatus[] = [
      "processing",
      "packed",
      "shipped",
      "out_for_delivery",
      "delivered",
      "cancelled",
    ];
    const withLifecycle: Pick<Order, "fulfillmentStatus" | "discountCents" | "couponCode"> = {
      fulfillmentStatus: "shipped",
      discountCents: 500,
      couponCode: "SAVE5",
    };
    const legacy: Pick<Order, "fulfillmentStatus"> = {};
    // @ts-expect-error "pending" was dropped in favour of "processing"
    const pending: FulfillmentStatus = "pending";
    // @ts-expect-error "returned" is not a FulfillmentStatus
    const bad: FulfillmentStatus = "returned";
    expect(statuses).toHaveLength(6);
    expect(withLifecycle.fulfillmentStatus).toBe("shipped");
    expect("fulfillmentStatus" in legacy).toBe(false);
    expect([String(bad), String(pending)]).toEqual(["returned", "pending"]);
  });

  test("Product keeps its eight required keys; ProductDetail requires the rich fields (compile-time)", () => {
    const card: Product = {
      id: "p1",
      slug: "mug",
      name: "Mug",
      description: "",
      priceCents: 1299,
      currency: "USD",
      imageUrl: "/mug.svg",
      stock: 1,
    };
    const detail: ProductDetail = {
      ...card,
      bullets: ["Dishwasher safe"],
      specs: [{ label: "Capacity", value: "350 ml" }],
      images: [{ url: "/mug.svg", alt: "Mug, front" }],
      listPriceCents: null,
      ratingCount: 0,
      ratingAvg: 0,
      brand: null,
      category: null,
      publishedAt: "2026-11-06T12:00:00.000Z",
      updatedAt: "2026-11-06T12:00:00.000Z",
    };
    // @ts-expect-error ProductDetail requires bullets/specs/images/etc.
    const incomplete: ProductDetail = { ...card };
    const asCard: Product = detail;
    expect(asCard.id).toBe("p1");
    expect(Object.keys(incomplete)).toHaveLength(8);
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);
  });

  test("review ratings and list/coupon kinds are closed unions (compile-time)", () => {
    const summary: ReviewSummary = { count: 2, avg: 4.5, histogram: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 1 } };
    // @ts-expect-error 6 is not a StarRating
    const badRating: StarRating = 6;
    // @ts-expect-error "cart" is not a ListKind
    const badList: ListKind = "cart";
    // @ts-expect-error "bogo" is not a CouponKind
    const badCoupon: CouponKind = "bogo";
    expect(summary.histogram[5]).toBe(1);
    expect([badRating, badList, badCoupon].map(String)).toEqual(["6", "cart", "bogo"]);
  });
});
