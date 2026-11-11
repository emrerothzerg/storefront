import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AppError, Result } from "@/lib/result";
import { createMergeRepository } from "@/server/auth/merge-repository";
import { createCartService, type CartServiceV2 } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { MOCK_CARDS, createMockPaymentProvider } from "@/server/payments/mock-payment-provider";
import { createOrderService, type OrderServiceV2, type PlaceOrderInputV2 } from "./order-service";

/** D-T55-1: cancel / payment failure release only the redemption recorded for THAT order. */

const NOW = Date.parse("2026-11-04T10:00:00.000Z");
const MIN = 60_000;
const U = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // account owner key
const G = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb"; // guest session
const TOTE = "prod_canvas-tote-bag";
const CODE = "ONCEONLY";

const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical Way",
  city: "London",
  region: "LDN",
  postalCode: "N1 9GU",
  country: "GB",
};

interface Harness {
  readonly db: Database;
  readonly svc: OrderServiceV2;
  readonly carts: CartServiceV2;
}

function setup(): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  db.query("INSERT INTO coupons (code, kind, value, min_subtotal_cents, max_uses, used_count) VALUES (?, 'fixed', 500, 0, 100, 0)").run(CODE);
  const pay = createMockPaymentProvider({ latencyMs: 0, now: () => new Date(NOW) });
  return { db, svc: createOrderService(db, { now: () => NOW, payments: pay, inFlight: new Map() }), carts: createCartService(db, { now: () => NOW }) };
}

function input(sessionId: string, cardNumber: string = MOCK_CARDS.success): PlaceOrderInputV2 {
  return {
    sessionId,
    address: ADDRESS,
    card: { number: cardNumber, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" },
    idempotencyKey: crypto.randomUUID(),
  };
}

function okv<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error("expected ok, got " + JSON.stringify(r.error));
  return r.value;
}

function codeOf<T>(r: Result<T, AppError>): string {
  return r.ok ? "OK" : r.error.code;
}

function rows(db: Database): { session_id: string; order_id: string | null }[] {
  return db
    .query<{ session_id: string; order_id: string | null }, [string]>(
      "SELECT session_id, order_id FROM coupon_redemptions WHERE coupon_code = ? ORDER BY session_id",
    )
    .all(CODE);
}

function usedCount(db: Database): number {
  return db.query<{ used_count: number }, [string]>("SELECT used_count FROM coupons WHERE code = ?").get(CODE)?.used_count ?? -1;
}

async function placeWithCoupon(h: Harness, session: string, at: number): Promise<string> {
  okv(h.carts.addItem(session, TOTE, 1));
  okv(h.carts.applyCoupon(session, CODE, at));
  const view = okv(await h.svc.placeOrderV2(input(session), at));
  expect(view.couponCode).toBe(CODE);
  return view.id;
}

describe("cancelOrder releases only this order's redemption (D-T55-1)", () => {
  test("two orders of one owner carry the same coupon (guest order re-keyed, its row dropped per R-5): cancelling one keeps the other's row and used_count", async () => {
    const h = setup();
    const orderB = await placeWithCoupon(h, U, NOW);
    const orderA = await placeWithCoupon(h, G, NOW + MIN);
    expect(usedCount(h.db)).toBe(2);
    // Direct SQL re-keying (what a merge does): A moves to U; G's conflicting row is DELETED.
    h.db.query("UPDATE orders SET session_id = ? WHERE id = ?").run(U, orderA);
    h.db.query("DELETE FROM coupon_redemptions WHERE coupon_code = ? AND session_id = ?").run(CODE, G);
    expect(rows(h.db)).toEqual([{ session_id: U, order_id: orderB }]);
    const usedBefore = usedCount(h.db);

    expect(okv(h.svc.cancelOrder(orderA, U, NOW + 5 * MIN)).fulfillmentStatus).toBe("cancelled");
    expect(rows(h.db)).toEqual([{ session_id: U, order_id: orderB }]);
    expect(usedCount(h.db)).toBe(usedBefore);
    okv(h.carts.addItem(U, TOTE, 1));
    expect(codeOf(h.carts.applyCoupon(U, CODE, NOW + 6 * MIN))).toBe("COUPON_USED");

    // Cancelling the order that owns the row releases it exactly once.
    expect(okv(h.svc.cancelOrder(orderB, U, NOW + 7 * MIN)).fulfillmentStatus).toBe("cancelled");
    expect(rows(h.db)).toEqual([]);
    expect(usedCount(h.db)).toBe(usedBefore - 1);
    expect(codeOf(h.svc.cancelOrder(orderB, U, NOW + 8 * MIN))).toBe("ORDER_NOT_CANCELLABLE");
    expect(usedCount(h.db)).toBe(usedBefore - 1);
    expect(codeOf(h.carts.applyCoupon(U, CODE, NOW + 9 * MIN))).toBe("OK");
  });

  test("merge repository scenario (QA repro): cancel the merged guest order -> the user's order keeps its redemption; re-apply is COUPON_USED", async () => {
    const h = setup();
    const orderB = await placeWithCoupon(h, U, NOW);
    const orderA = await placeWithCoupon(h, G, NOW + MIN);
    const merge = createMergeRepository(h.db);
    merge.mergeOrders(G, U);
    merge.mergeCouponRedemptions(G, U);
    expect(rows(h.db)).toEqual([{ session_id: U, order_id: orderB }]);
    const usedBefore = usedCount(h.db);

    okv(h.svc.cancelOrder(orderA, U, NOW + 5 * MIN));
    expect(rows(h.db)).toEqual([{ session_id: U, order_id: orderB }]);
    expect(usedCount(h.db)).toBe(usedBefore);
    okv(h.carts.addItem(U, TOTE, 1));
    expect(codeOf(h.carts.applyCoupon(U, CODE, NOW + 6 * MIN))).toBe("COUPON_USED");
    expect(h.svc.getOrderView(orderB, U, NOW + 6 * MIN)?.couponCode).toBe(CODE);
  });

  test("single order, no merge: cancel still releases its own redemption (coupon reusable)", async () => {
    const h = setup();
    const id = await placeWithCoupon(h, U, NOW);
    expect(usedCount(h.db)).toBe(1);
    okv(h.svc.cancelOrder(id, U, NOW + MIN));
    expect(rows(h.db)).toEqual([]);
    expect(usedCount(h.db)).toBe(0);
  });

  test("declined payment releases the reservation's own redemption", async () => {
    const h = setup();
    okv(h.carts.addItem(U, TOTE, 1));
    okv(h.carts.applyCoupon(U, CODE, NOW));
    expect(codeOf(await h.svc.placeOrderV2(input(U, MOCK_CARDS.declined), NOW))).toBe("PAYMENT_FAILED");
    expect(rows(h.db)).toEqual([]);
    expect(usedCount(h.db)).toBe(0);
  });
});
