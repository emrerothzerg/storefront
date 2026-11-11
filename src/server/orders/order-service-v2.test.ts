import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ok, type AppError, type Result } from "@/lib/result";
import type { FulfillmentStatus } from "@/lib/types";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createCartService, type CartServiceV2 } from "@/server/cart/cart-service";
import { MOCK_CARDS, createMockPaymentProvider, type MockPaymentProvider } from "@/server/payments/mock-payment-provider";
import type { PaymentProvider } from "@/server/payments/payment-provider";
import { estimateDelivery } from "@/server/pricing/shipping-service";
import { DELETED_OWNER_KEY } from "@/server/auth/account-repository";
import { FULFILLMENT_SEQUENCE, SIMULATED_TRACKING_NOTICE, statusAt } from "@/server/fulfillment/fulfillment";
import { createCouponService } from "@/server/pricing/coupon-service";
import { createShippingService } from "@/server/pricing/shipping-service";
import { SqliteCartRepository } from "@/server/cart/cart-repository";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { SqliteOrderRepository } from "./order-repository";
import {
  DEFAULT_ORDERS_RANGE,
  DefaultOrderServiceV2,
  ORDERS_PAGE_SIZE,
  REFUND_PENDING_NOTE,
  createOrderService,
  getOrderService,
  rangeCutoff,
  type OrderServiceV2,
  type OrderView,
  type PlaceOrderInputV2,
} from "./order-service";

const NOW = Date.parse("2026-11-04T10:00:00.000Z"); // Wednesday
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";

const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const PIN = "prod_enamel-pin-set"; // 50, stock 100
const PRINT = "prod_limited-print-no-1"; // 18000, stock 1

const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical Way",
  city: "London",
  region: "LDN",
  postalCode: "N1 9GU",
  country: "GB",
};

function card(number: string = MOCK_CARDS.success) {
  return { number, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" };
}

interface Harness {
  readonly db: Database;
  readonly svc: OrderServiceV2;
  readonly carts: CartServiceV2;
  readonly pay: MockPaymentProvider;
  readonly clock: { value: number };
}

function setup(options: { db?: Database; seed?: boolean; latencyMs?: number; payments?: PaymentProvider; pay?: MockPaymentProvider } = {}): Harness {
  const db = options.db ?? createDatabase(":memory:");
  if (options.seed !== false) {
    runMigrations(db);
    seedDatabase(db, { now: new Date(NOW) });
  }
  const clock = { value: NOW };
  const pay = options.pay ?? createMockPaymentProvider({ latencyMs: options.latencyMs ?? 0, now: () => new Date(clock.value) });
  const svc = createOrderService(db, { now: () => clock.value, payments: options.payments ?? pay, inFlight: new Map() });
  const carts = createCartService(db, { now: () => clock.value });
  return { db, svc, carts, pay, clock };
}

let keySeq = 0;
function key(): string {
  keySeq += 1;
  return "key-" + String(keySeq) + "-" + crypto.randomUUID();
}

function input(sessionId: string, extra: Partial<PlaceOrderInputV2> = {}): PlaceOrderInputV2 {
  return { sessionId, address: ADDRESS, card: card(), idempotencyKey: key(), ...extra };
}

function add(h: Harness, session: string, productId: string, qty: number): void {
  const r = h.carts.addItem(session, productId, qty);
  if (!r.ok) throw new Error("addItem failed: " + r.error.code);
}

function expectOk<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error("expected ok, got " + JSON.stringify(r.error));
  return r.value;
}

function expectErr<T>(r: Result<T, AppError>): AppError {
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

function stock(db: Database, id: string): number {
  return db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id)?.stock ?? -1;
}

function usedCount(db: Database, code: string): number {
  return db.query<{ used_count: number }, [string]>("SELECT used_count FROM coupons WHERE code = ?").get(code)?.used_count ?? -1;
}

function redemptions(db: Database, code: string): { session_id: string; order_id: string | null }[] {
  return db
    .query<{ session_id: string; order_id: string | null }, [string]>(
      "SELECT session_id, order_id FROM coupon_redemptions WHERE coupon_code = ?",
    )
    .all(code);
}

function orderCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orders").get()?.n ?? -1;
}

function events(db: Database, orderId: string): { id: number; status: string; at: string; note: string | null }[] {
  return db
    .query<{ id: number; status: string; at: string; note: string | null }, [string]>(
      "SELECT id, status, at, note FROM order_events WHERE order_id = ? ORDER BY id",
    )
    .all(orderId);
}

function addCoupon(db: Database, code: string, f: { kind?: string; value?: number; min?: number; maxUses?: number | null; used?: number; expires?: string | null } = {}): void {
  db.query(
    "INSERT INTO coupons (code, kind, value, min_subtotal_cents, max_uses, used_count, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(code, f.kind ?? "fixed", f.value ?? 100, f.min ?? 0, f.maxUses ?? null, f.used ?? 0, f.expires ?? null);
}

async function place(h: Harness, session: string, productId: string, qty = 1, extra: Partial<PlaceOrderInputV2> = {}, now?: number): Promise<OrderView> {
  add(h, session, productId, qty);
  return expectOk(await h.svc.placeOrderV2(input(session, extra), now));
}

// ---------------------------------------------------------------------------

describe("placeOrderV2: totals, snapshots, redemption", () => {
  test("charges the server total (discount + shipping) and ignores forged client totals", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    expectOk(h.carts.applyCoupon(S1, "welcome10", NOW));
    expectOk(h.carts.selectShippingMethod(S1, "express"));
    const forged = { ...input(S1, { deliveryNote: "  Leave at the\u0000 back   door " }), totalCents: 1, subtotalCents: 1, discountCents: 1999, shippingCents: 0 };

    const view = expectOk(await h.svc.placeOrderV2(forged));

    // 1999 - floor(199.9) + 999
    expect(view.subtotalCents).toBe(1999);
    expect(view.discountCents).toBe(199);
    expect(view.shippingCents).toBe(999);
    expect(view.totalCents).toBe(2799);
    expect(h.pay.listCharges().map((c) => c.amountCents)).toEqual([2799]);
    expect(view.couponCode).toBe("WELCOME10");
    expect(view.shippingMethodId).toBe("express");
    expect(view.shippingMethodName).toBe("Express");
    expect(view.deliveryNote).toBe("Leave at the back door");
    expect(view.status).toBe("paid");
    expect(view.fulfillmentStatus).toBe("processing");
    expect(view.cancellable).toBe(true);
    expect(view.cancellableUntil).toBe(new Date(NOW + 30 * MIN).toISOString());
    expect(view.simulatedTrackingNotice).toBe(SIMULATED_TRACKING_NOTICE);
    const estimate = estimateDelivery({ minDays: 2, maxDays: 3 }, NOW, NOW);
    expect(view.estimatedDelivery).toEqual(estimate);
    expect(view.estimatedDeliveryStart).toBe(estimate.start);
    expect(view.items).toEqual([
      { productId: TOTE, name: "Canvas Tote Bag", unitPriceCents: 1999, quantity: 1, productSlug: "canvas-tote-bag", imageUrl: "/images/products/canvas-tote-bag.svg" },
    ]);
    expect(view.timeline.map((s) => [s.status, s.state])).toEqual([
      ["processing", "current"],
      ["packed", "upcoming"],
      ["shipped", "upcoming"],
      ["out_for_delivery", "upcoming"],
      ["delivered", "upcoming"],
    ]);
    expect("sessionId" in view).toBe(false);

    const row = h.db
      .query<Record<string, unknown>, [string]>(
        "SELECT total_cents, discount_cents, shipping_cents, coupon_code, fulfillment_status, payment_ref FROM orders WHERE id = ?",
      )
      .get(view.id);
    expect(row).toMatchObject({ total_cents: 2799, discount_cents: 199, shipping_cents: 999, coupon_code: "WELCOME10", fulfillment_status: "processing" });
    expect(typeof row?.payment_ref).toBe("string");
    expect(events(h.db, view.id).map((e) => [e.status, e.at])).toEqual([["processing", new Date(NOW).toISOString()]]);
    expect(usedCount(h.db, "WELCOME10")).toBe(1);
    expect(redemptions(h.db, "WELCOME10")).toEqual([{ session_id: S1, order_id: view.id }]);
    expect(stock(h.db, TOTE)).toBe(41);
    expect(expectOk(h.carts.getCartView(S1, NOW)).items).toEqual([]);
  });

  test("shipping defaults to the cart selection, else the cheapest; explicit id wins", async () => {
    const h = setup();
    const cheapest = await place(h, S1, TOTE, 1);
    expect([cheapest.shippingMethodId, cheapest.shippingCents]).toEqual(["standard", 499]);

    const free = await place(h, S1, TOTE, 2); // 3998 >= 3500: standard is free
    expect([free.shippingMethodId, free.shippingCents, free.totalCents]).toEqual(["standard", 0, 3998]);

    add(h, S1, PIN, 1);
    expectOk(h.carts.selectShippingMethod(S1, "next_day"));
    const selected = expectOk(await h.svc.placeOrderV2(input(S1)));
    expect([selected.shippingMethodId, selected.shippingCents, selected.totalCents]).toEqual(["next_day", 1999, 2049]);

    add(h, S1, PIN, 1);
    expectOk(h.carts.selectShippingMethod(S1, "next_day"));
    const explicit = expectOk(await h.svc.placeOrderV2(input(S1, { shippingMethodId: "express" })));
    expect([explicit.shippingMethodId, explicit.totalCents]).toEqual(["express", 1049]);
  });

  test("unknown, inactive or malformed shipping method -> INVALID_INPUT, nothing charged or reserved", async () => {
    const h = setup();
    add(h, S1, TOTE, 2);
    expectOk(h.carts.applyCoupon(S1, "WELCOME10", NOW));

    for (const bad of ["nope", "", "x".repeat(65)]) {
      const e = expectErr(await h.svc.placeOrderV2(input(S1, { shippingMethodId: bad })));
      expect([e.code, e.details?.field]).toEqual(["INVALID_INPUT", "shippingMethodId"]);
    }
    const typed = { ...input(S1), shippingMethodId: 42 as unknown as string };
    expect(expectErr(await h.svc.placeOrderV2(typed)).code).toBe("INVALID_INPUT");

    // Selected in the cart, then deactivated before submit.
    expectOk(h.carts.selectShippingMethod(S1, "express"));
    h.db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    expect(expectErr(await h.svc.placeOrderV2(input(S1))).code).toBe("INVALID_INPUT");
    expect(expectErr(await h.svc.placeOrderV2(input(S1, { shippingMethodId: "express" }))).code).toBe("INVALID_INPUT");

    expect(h.pay.listCharges()).toEqual([]);
    expect(orderCount(h.db)).toBe(0);
    expect(stock(h.db, TOTE)).toBe(42);
    expect(usedCount(h.db, "WELCOME10")).toBe(0);
    expect(redemptions(h.db, "WELCOME10")).toEqual([]);
    expect(expectOk(h.carts.getCartView(S1, NOW)).items.length).toBe(1);
  });

  test("no active shipping method at all -> INVALID_INPUT", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    h.db.run("UPDATE shipping_methods SET is_active = 0");
    const e = expectErr(await h.svc.placeOrderV2(input(S1)));
    expect([e.code, e.details?.field]).toEqual(["INVALID_INPUT", "shippingMethodId"]);
    expect(h.pay.listCharges()).toEqual([]);
  });

  test("coupon invalidated between cart view and submit -> its typed error, no charge, coupon kept on the cart", async () => {
    const h = setup();
    addCoupon(h.db, "SOON", { expires: new Date(NOW + HOUR).toISOString() });
    add(h, S1, TOTE, 1);
    expectOk(h.carts.applyCoupon(S1, "SOON", NOW));

    const e = expectErr(await h.svc.placeOrderV2(input(S1), NOW + 2 * HOUR));
    expect(e.code).toBe("COUPON_EXPIRED");
    expect(h.pay.listCharges()).toEqual([]);
    expect(orderCount(h.db)).toBe(0);
    expect(stock(h.db, TOTE)).toBe(42);
    expect(usedCount(h.db, "SOON")).toBe(0);
    // The failed attempt rolled back the view's silent drop.
    expect(h.db.query<{ coupon_code: string | null }, [string]>("SELECT coupon_code FROM carts WHERE session_id = ?").get(S1)?.coupon_code).toBe("SOON");
  });

  test("coupon minimum no longer met / exhausted by someone else / deactivated -> typed errors", async () => {
    const h = setup();
    add(h, S1, TOTE, 2); // 3998
    expectOk(h.carts.applyCoupon(S1, "SAVE5", NOW)); // $5 off $25+
    h.db.run("UPDATE coupons SET min_subtotal_cents = 5000 WHERE code = 'SAVE5'");
    expect(expectErr(await h.svc.placeOrderV2(input(S1))).code).toBe("COUPON_MIN_SUBTOTAL");

    addCoupon(h.db, "ONE", { maxUses: 1 });
    expectOk(h.carts.applyCoupon(S1, "ONE", NOW));
    h.db.run("UPDATE coupons SET used_count = 1 WHERE code = 'ONE'");
    expect(expectErr(await h.svc.placeOrderV2(input(S1))).code).toBe("COUPON_EXHAUSTED");

    expectOk(h.carts.applyCoupon(S1, "WELCOME10", NOW));
    h.db.run("UPDATE coupons SET is_active = 0 WHERE code = 'WELCOME10'");
    expect(expectErr(await h.svc.placeOrderV2(input(S1))).code).toBe("COUPON_INVALID");

    expect(h.pay.listCharges()).toEqual([]);
    expect(orderCount(h.db)).toBe(0);
    expect(stock(h.db, TOTE)).toBe(42);
  });

  test("a declined payment does not consume the coupon; stock restored; retry with a new key succeeds", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    expectOk(h.carts.applyCoupon(S1, "WELCOME10", NOW));
    const declinedKey = key();
    const declined = expectErr(await h.svc.placeOrderV2({ ...input(S1), idempotencyKey: declinedKey, card: card(MOCK_CARDS.declined) }));
    expect(declined.code).toBe("PAYMENT_FAILED");
    const failedId = declined.details?.orderId;
    expect(typeof failedId).toBe("string");

    expect(usedCount(h.db, "WELCOME10")).toBe(0);
    expect(redemptions(h.db, "WELCOME10")).toEqual([]);
    expect(stock(h.db, TOTE)).toBe(42);
    expect(h.db.query<{ status: string; failure_code: string }, [string]>("SELECT status, failure_code FROM orders WHERE id = ?").get(String(failedId))).toEqual({ status: "payment_failed", failure_code: "DECLINED" });
    expect(events(h.db, String(failedId))).toEqual([]);

    // Same key replays the decline (same order id), no second charge.
    const replayed = expectErr(await h.svc.placeOrderV2({ ...input(S1), idempotencyKey: declinedKey }));
    expect(replayed.details?.orderId).toBe(failedId);
    expect(h.pay.listCharges().length).toBe(1);

    // payment_failed orders are never viewable or listed.
    expect(h.svc.getOrderView(String(failedId), S1)).toBeNull();
    expect(h.svc.listOrders(S1).total).toBe(0);

    const paid = expectOk(await h.svc.placeOrderV2(input(S1)));
    expect([paid.couponCode, paid.discountCents, paid.totalCents]).toEqual(["WELCOME10", 199, 1999 - 199 + 499]);
    expect(usedCount(h.db, "WELCOME10")).toBe(1);
  });

  test("a throwing provider is a PROCESSING_ERROR and releases stock and coupon", async () => {
    const throwing: PaymentProvider = { charge: () => Promise.reject(new Error("boom")) };
    const h = setup({ payments: throwing });
    add(h, S1, TOTE, 1);
    expectOk(h.carts.applyCoupon(S1, "WELCOME10", NOW));
    const e = expectErr(await h.svc.placeOrderV2(input(S1)));
    expect([e.code, e.details?.failureCode]).toEqual(["PAYMENT_FAILED", "PROCESSING_ERROR"]);
    expect(stock(h.db, TOTE)).toBe(42);
    expect(usedCount(h.db, "WELCOME10")).toBe(0);
  });

  test("idempotency: same key -> same order and one charge; concurrent duplicates share; foreign key -> INVALID_INPUT", async () => {
    const h = setup({ latencyMs: 5 });
    add(h, S1, TOTE, 1);
    const k = key();
    const [a, b] = await Promise.all([
      h.svc.placeOrderV2({ ...input(S1), idempotencyKey: k }),
      h.svc.placeOrderV2({ ...input(S1), idempotencyKey: k }),
    ]);
    expect(expectOk(a).id).toBe(expectOk(b).id);
    const again = expectOk(await h.svc.placeOrderV2({ ...input(S1), idempotencyKey: k }));
    expect(again.id).toBe(expectOk(a).id);
    expect(h.pay.listCharges().length).toBe(1);
    expect(stock(h.db, TOTE)).toBe(41);
    // The MVP entry point shares the registry and the stored outcome.
    expect(expectOk(await h.svc.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: k })).id).toBe(again.id);

    const foreign = expectErr(await h.svc.placeOrderV2({ ...input(S2), idempotencyKey: k }));
    expect([foreign.code, foreign.details?.field]).toEqual(["INVALID_INPUT", "idempotencyKey"]);
    expect(expectErr(await h.svc.placeOrderV2({ ...input(S1), idempotencyKey: "" })).code).toBe("INVALID_INPUT");
  });

  test("validation order and failures: EMPTY_CART, VALIDATION_FAILED, STOCK_CHANGED (no redemption)", async () => {
    const h = setup();
    expect(expectErr(await h.svc.placeOrderV2(input(S1))).code).toBe("EMPTY_CART");
    expect(expectErr(await h.svc.placeOrderV2(input("not-a-uuid"))).code).toBe("EMPTY_CART");
    expect(expectErr(await h.svc.placeOrderV2(input(DELETED_OWNER_KEY))).code).toBe("EMPTY_CART");

    add(h, S1, PRINT, 1);
    expectOk(h.carts.applyCoupon(S1, "WELCOME10", NOW));
    const invalid = expectErr(await h.svc.placeOrderV2({ ...input(S1), address: { ...ADDRESS, email: "nope" } }));
    expect(invalid.code).toBe("VALIDATION_FAILED");

    h.db.run("UPDATE products SET stock = 0 WHERE id = ?", [PRINT]);
    expect(expectErr(await h.svc.placeOrderV2(input(S1))).code).toBe("STOCK_CHANGED");
    expect(usedCount(h.db, "WELCOME10")).toBe(0);
    expect(h.pay.listCharges()).toEqual([]);
  });

  test("delivery note: cleaned, capped at 200 (TOO_LONG), non-string INVALID_INPUT, blank -> null", async () => {
    const h = setup();
    add(h, S1, PIN, 1);
    const tooLong = expectErr(await h.svc.placeOrderV2(input(S1, { deliveryNote: "x".repeat(201) })));
    expect([tooLong.code, tooLong.details?.field]).toEqual(["TOO_LONG", "deliveryNote"]);
    const notText = expectErr(await h.svc.placeOrderV2(input(S1, { deliveryNote: { evil: true } })));
    expect([notText.code, notText.details?.field]).toEqual(["INVALID_INPUT", "deliveryNote"]);
    expect(h.pay.listCharges()).toEqual([]);

    const max = expectOk(await h.svc.placeOrderV2(input(S1, { deliveryNote: "y".repeat(200) })));
    expect(max.deliveryNote).toBe("y".repeat(200));
    const html = await place(h, S1, PIN, 1, { deliveryNote: "<b>ring</b>\n\tbell" });
    expect(html.deliveryNote).toBe("<b>ring</b> bell");
    const blank = await place(h, S1, PIN, 1, { deliveryNote: "   \n " });
    expect(blank.deliveryNote).toBeNull();
  });

  test("fully discounted order with free shipping is paid without a charge", async () => {
    const h = setup();
    addCoupon(h.db, "FULL", { kind: "percent", value: 100 });
    add(h, S1, TOTE, 2); // standard free over 3500
    expectOk(h.carts.applyCoupon(S1, "FULL", NOW));
    const view = expectOk(await h.svc.placeOrderV2(input(S1)));
    expect([view.status, view.totalCents, view.discountCents]).toEqual(["paid", 0, 3998]);
    expect(h.pay.listCharges()).toEqual([]);
  });
});

describe("placeOrderV2: coupon race for the last redemption", () => {
  test("recordRedemption's own guard aborts the reservation even when validate passed (cross-process race)", async () => {
    const h = setup();
    addCoupon(h.db, "LAST", { maxUses: 1 });
    add(h, S1, TOTE, 1);
    expectOk(h.carts.applyCoupon(S1, "LAST", NOW));
    h.db.run("UPDATE coupons SET used_count = 1 WHERE code = 'LAST'"); // another process won
    const real = createCouponService({ db: h.db, now: () => NOW });
    const stale = { ...real, validate: (code: unknown) => ok({ code: String(code), kind: "fixed" as const, value: 100, promoted: false, description: "" }) };
    const svc = new DefaultOrderServiceV2({
      db: h.db,
      carts: h.carts,
      products: new SqliteProductRepository(h.db),
      orders: new SqliteOrderRepository(h.db),
      payments: h.pay,
      coupons: stale,
      shipping: createShippingService({ db: h.db }),
      cartSettings: new SqliteCartRepository(h.db),
      clock: () => NOW,
    });
    expect(expectErr(await svc.placeOrderV2(input(S1))).code).toBe("COUPON_EXHAUSTED");
    expect(h.pay.listCharges()).toEqual([]);
    expect(stock(h.db, TOTE)).toBe(42);
    expect(redemptions(h.db, "LAST")).toEqual([]);
    expect(orderCount(h.db)).toBe(0);
  });

  test("20+ iterations: exactly one order, the other COUPON_EXHAUSTED/USED with no charge", async () => {
    for (let i = 0; i < 24; i++) {
      const twoConnections = i % 2 === 1;
      let h1: Harness;
      let h2: Harness;
      let extra: Database | null = null;
      if (twoConnections) {
        const uri = "file:orders-race-" + crypto.randomUUID() + "?mode=memory&cache=shared";
        const a = new Database(uri, { strict: true });
        extra = new Database(uri, { strict: true });
        h1 = setup({ db: a, latencyMs: 3 });
        h2 = setup({ db: extra, seed: false, pay: h1.pay });
      } else {
        h1 = setup({ latencyMs: 3 });
        h2 = h1;
      }
      addCoupon(h1.db, "LAST", { maxUses: 1 });
      add(h1, S1, TOTE, 1);
      add(h2, S2, TOTE, 1);
      expectOk(h1.carts.applyCoupon(S1, "LAST", NOW));
      expectOk(h2.carts.applyCoupon(S2, "LAST", NOW));

      const results = await Promise.all(
        i % 4 < 2
          ? [h1.svc.placeOrderV2(input(S1)), h2.svc.placeOrderV2(input(S2))]
          : [h2.svc.placeOrderV2(input(S2)), h1.svc.placeOrderV2(input(S1))],
      );
      const wins = results.filter((r) => r.ok);
      const losses = results.filter((r) => !r.ok).map((r) => expectErr(r).code);
      expect(wins.length).toBe(1);
      expect(losses.length).toBe(1);
      expect(["COUPON_EXHAUSTED", "COUPON_USED"]).toContain(losses[0] as string);
      expect(h1.pay.listCharges().length).toBe(1);
      expect(usedCount(h1.db, "LAST")).toBe(1);
      expect(redemptions(h1.db, "LAST").length).toBe(1);
      expect(stock(h1.db, TOTE)).toBe(41);
      expect(orderCount(h1.db)).toBe(1);
      extra?.close();
      if (twoConnections) h1.db.close();
    }
  });

  test("one session racing itself with two keys: second gets COUPON_USED", async () => {
    const h = setup({ latencyMs: 3 });
    add(h, S1, TOTE, 1);
    expectOk(h.carts.applyCoupon(S1, "WELCOME10", NOW));
    const [a, b] = await Promise.all([h.svc.placeOrderV2(input(S1)), h.svc.placeOrderV2(input(S1))]);
    expect([a.ok, b.ok]).toEqual([true, false]);
    expect(expectErr(b).code).toBe("COUPON_USED");
    expect(h.pay.listCharges().length).toBe(1);
    expect(stock(h.db, TOTE)).toBe(41);
  });
});

describe("getOrderView and fulfilment events", () => {
  test("null for foreign, unknown, malformed, tombstone-keyed and payment_failed orders", async () => {
    const h = setup();
    const view = await place(h, S1, TOTE);
    expect(h.svc.getOrderView(view.id, S1)?.id).toBe(view.id);
    expect(h.svc.getOrderView(view.id, S2)).toBeNull();
    expect(h.svc.getOrderView(crypto.randomUUID(), S1)).toBeNull();
    expect(h.svc.getOrderView(view.id.toUpperCase(), S1)).toBeNull();
    expect(h.svc.getOrderView("' OR 1=1 --", S1)).toBeNull();
    expect(h.svc.getOrderView(view.id, "nope")).toBeNull();

    h.db.run("UPDATE orders SET session_id = ? WHERE id = ?", [DELETED_OWNER_KEY, view.id]);
    expect(h.svc.getOrderView(view.id, S1)).toBeNull();
    expect(h.svc.getOrderView(view.id, DELETED_OWNER_KEY)).toBeNull();
    expect(h.svc.getOrder(view.id, DELETED_OWNER_KEY)).toBeNull();
    expect(h.svc.listOrders(DELETED_OWNER_KEY, { range: "all" }).items).toEqual([]);
    expect(h.svc.getBuyAgainLines(DELETED_OWNER_KEY)).toEqual([]);
    expect(expectErr(h.svc.cancelOrder(view.id, DELETED_OWNER_KEY)).code).toBe("ORDER_NOT_FOUND");
  });

  test("events are persisted lazily, once per status, in order, with derived timestamps; status never regresses", async () => {
    const h = setup();
    const view = await place(h, S1, TOTE); // Wed 10:00, standard
    expect(h.svc.getOrderView(view.id, S1, NOW + 3 * HOUR)?.fulfillmentStatus).toBe("packed");
    expect(events(h.db, view.id).map((e) => e.status)).toEqual(["processing", "packed"]);
    expect(h.svc.getOrderView(view.id, S1, NOW + DAY)?.fulfillmentStatus).toBe("shipped");
    const late = h.svc.getOrderView(view.id, S1, NOW + 20 * DAY);
    expect(late?.fulfillmentStatus).toBe("delivered");
    expect(late?.cancellable).toBe(false);
    expect(late?.cancellableUntil).toBeNull();

    const rows = events(h.db, view.id);
    expect(rows.map((e) => e.status)).toEqual([...FULFILLMENT_SEQUENCE]);
    const input = { createdAt: view.createdAt, status: "paid" as const, method: { id: "standard", minDays: 5, maxDays: 8 } };
    for (const row of rows) {
      expect(row.at).toBe(statusAt(input, row.status as FulfillmentStatus, { estimateDelivery }) ?? "");
    }
    const persisted = h.db
      .query<{ fulfillment_status: string; shipped_at: string; delivered_at: string }, [string]>(
        "SELECT fulfillment_status, shipped_at, delivered_at FROM orders WHERE id = ?",
      )
      .get(view.id);
    expect(persisted).toEqual({ fulfillment_status: "delivered", shipped_at: rows[2]?.at ?? "", delivered_at: rows[4]?.at ?? "" });

    // Reading with an earlier clock does not regress.
    expect(h.svc.getOrderView(view.id, S1, NOW + HOUR)?.fulfillmentStatus).toBe("delivered");
    expect(events(h.db, view.id).length).toBe(5);
  });

  test("concurrent reads (same and second connection) never duplicate events", async () => {
    const uri = "file:orders-events-" + crypto.randomUUID() + "?mode=memory&cache=shared";
    const a = new Database(uri, { strict: true });
    const b = new Database(uri, { strict: true });
    try {
      const h1 = setup({ db: a });
      const h2 = setup({ db: b, seed: false });
      const view = await place(h1, S1, TOTE);
      const reads: Promise<unknown>[] = [];
      for (let i = 0; i < 30; i++) {
        const svc = i % 2 === 0 ? h1.svc : h2.svc;
        const at = NOW + (i % 3 === 0 ? 20 * DAY : (i + 1) * 4 * HOUR);
        reads.push(Promise.resolve().then(() => svc.getOrderView(view.id, S1, at)));
        reads.push(Promise.resolve().then(() => svc.listOrders(S1, { range: "all" }, at)));
      }
      await Promise.all(reads);
      const rows = events(a, view.id);
      expect(rows.map((e) => e.status)).toEqual([...FULFILLMENT_SEQUENCE]);
      const ids = rows.map((e) => e.id);
      expect([...ids].sort((x, y) => x - y)).toEqual(ids);
    } finally {
      a.close();
      b.close();
    }
  });

  test("snapshots survive product edits and deletion; delivery window survives shipping-method edits", async () => {
    const h = setup();
    const view = await place(h, S1, TOTE, 2, { shippingMethodId: "express" });
    h.db.run("UPDATE products SET name = 'Renamed Bag', price_cents = 1, slug = 'renamed-bag', image_url = '/x.svg' WHERE id = ?", [TOTE]);
    h.db.run("UPDATE shipping_methods SET min_days = 7, max_days = 9, name = 'Slow' WHERE id = 'express'");
    const after = h.svc.getOrderView(view.id, S1);
    expect(after?.items).toEqual(view.items);
    expect(after?.shippingMethodName).toBe("Express");
    expect(after?.estimatedDelivery).toEqual(view.estimatedDelivery);
    expect(h.svc.listOrders(S1, { query: "canvas tote" }).total).toBe(1);
    expect(h.svc.listOrders(S1, { query: "renamed" }).total).toBe(0);

    h.db.run("DELETE FROM products WHERE id = ?", [TOTE]);
    expect(h.svc.getOrderView(view.id, S1)?.items).toEqual(view.items);
    expect(h.svc.getOrderView(view.id, S1)?.totalCents).toBe(view.totalCents);
  });

  test("MVP-placed orders get a view (no shipping snapshot) and lazy events", async () => {
    const h = setup();
    add(h, S1, PIN, 2);
    const order = expectOk(await h.svc.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: key() }));
    const view = h.svc.getOrderView(order.id, S1, NOW + 3 * HOUR);
    expect(view?.fulfillmentStatus).toBe("packed");
    expect([view?.shippingCents, view?.couponCode, view?.shippingMethodName, view?.items[0]?.productSlug]).toEqual([0, null, null, null]);
    expect(events(h.db, order.id).map((e) => e.status)).toEqual(["processing", "packed"]);
  });
});

describe("cancelOrder", () => {
  test("within the window: cancels, restores stock once, releases the coupon, records refund_pending", async () => {
    const h = setup();
    add(h, S1, TOTE, 3);
    expectOk(h.carts.applyCoupon(S1, "WELCOME10", NOW));
    const view = expectOk(await h.svc.placeOrderV2(input(S1)));
    expect(stock(h.db, TOTE)).toBe(39);

    const cancelled = expectOk(h.svc.cancelOrder(view.id, S1, NOW + 10 * MIN));
    expect(cancelled.fulfillmentStatus).toBe("cancelled");
    expect(cancelled.cancelledAt).toBe(new Date(NOW + 10 * MIN).toISOString());
    expect(cancelled.cancellable).toBe(false);
    expect(cancelled.estimatedDelivery).toBeNull();
    expect(cancelled.timeline.map((s) => s.status)).toEqual(["processing", "cancelled"]);
    expect(stock(h.db, TOTE)).toBe(42);
    expect(usedCount(h.db, "WELCOME10")).toBe(0);
    expect(redemptions(h.db, "WELCOME10")).toEqual([]);
    expect(events(h.db, view.id).map((e) => [e.status, e.note])).toEqual([
      ["processing", null],
      ["cancelled", REFUND_PENDING_NOTE],
    ]);

    const again = expectErr(h.svc.cancelOrder(view.id, S1, NOW + 11 * MIN));
    expect(again.code).toBe("ORDER_NOT_CANCELLABLE");
    expect(stock(h.db, TOTE)).toBe(42);
    expect(usedCount(h.db, "WELCOME10")).toBe(0);
    // Later reads add nothing to a cancelled order.
    h.svc.getOrderView(view.id, S1, NOW + 20 * DAY);
    expect(events(h.db, view.id).length).toBe(2);
    // The session may use the coupon again.
    add(h, S1, PIN, 1);
    expectOk(h.carts.applyCoupon(S1, "WELCOME10", NOW + HOUR));
  });

  test("window boundary: exactly 30 min ok, 30 min + 1 ms not", async () => {
    const h = setup();
    const a = await place(h, S1, PIN);
    const b = await place(h, S1, PIN);
    expect(expectOk(h.svc.cancelOrder(a.id, S1, NOW + 30 * MIN)).fulfillmentStatus).toBe("cancelled");
    expect(expectErr(h.svc.cancelOrder(b.id, S1, NOW + 30 * MIN + 1)).code).toBe("ORDER_NOT_CANCELLABLE");
    expect(stock(h.db, PIN)).toBe(99);
  });

  test("shipped / delivered / persisted packed -> ORDER_NOT_CANCELLABLE", async () => {
    const h = setup();
    const a = await place(h, S1, PIN);
    expect(expectErr(h.svc.cancelOrder(a.id, S1, NOW + 2 * DAY)).code).toBe("ORDER_NOT_CANCELLABLE");
    expect(expectErr(h.svc.cancelOrder(a.id, S1, NOW + 20 * DAY)).code).toBe("ORDER_NOT_CANCELLABLE");
    const b = await place(h, S1, PIN);
    h.db.run("UPDATE orders SET fulfillment_status = 'packed' WHERE id = ?", [b.id]);
    expect(expectErr(h.svc.cancelOrder(b.id, S1, NOW + MIN)).code).toBe("ORDER_NOT_CANCELLABLE");
    expect(stock(h.db, PIN)).toBe(98);
  });

  test("foreign, unknown, malformed and payment_failed -> ORDER_NOT_FOUND", async () => {
    const h = setup();
    const view = await place(h, S1, PIN);
    expect(expectErr(h.svc.cancelOrder(view.id, S2, NOW)).code).toBe("ORDER_NOT_FOUND");
    expect(expectErr(h.svc.cancelOrder(crypto.randomUUID(), S1, NOW)).code).toBe("ORDER_NOT_FOUND");
    expect(expectErr(h.svc.cancelOrder("nope", S1, NOW)).code).toBe("ORDER_NOT_FOUND");
    add(h, S1, PIN, 1);
    const failed = expectErr(await h.svc.placeOrderV2(input(S1, { card: card(MOCK_CARDS.insufficientFunds) })));
    expect(expectErr(h.svc.cancelOrder(String(failed.details?.orderId), S1, NOW)).code).toBe("ORDER_NOT_FOUND");
    expect(stock(h.db, PIN)).toBe(99);
  });

  test("a product deleted after the order does not break cancellation", async () => {
    const h = setup();
    const view = await place(h, S1, TOTE);
    h.db.run("DELETE FROM products WHERE id = ?", [TOTE]);
    expect(expectOk(h.svc.cancelOrder(view.id, S1, NOW + MIN)).fulfillmentStatus).toBe("cancelled");
  });
});

describe("listOrders", () => {
  test("isolates sessions, lists paid only, newest first, defaults for hostile params", async () => {
    const h = setup();
    const a = await place(h, S1, PIN, 1, {}, NOW - 2 * HOUR);
    const b = await place(h, S1, TOTE, 1, {}, NOW - HOUR);
    await place(h, S2, PIN, 1, {}, NOW - HOUR);
    add(h, S1, PIN, 1);
    expectErr(await h.svc.placeOrderV2(input(S1, { card: card(MOCK_CARDS.declined) })));

    const page = h.svc.listOrders(S1, {}, NOW);
    expect(page.items.map((o) => o.id)).toEqual([b.id, a.id]);
    expect([page.total, page.page, page.pageCount, page.tab, page.range]).toEqual([2, 1, 1, "all", DEFAULT_ORDERS_RANGE]);
    expect(h.svc.listOrders(S2, {}, NOW).total).toBe(1);

    const hostile = h.svc.listOrders(S1, { tab: "x'; DROP TABLE orders; --", range: "forever", page: Number.NaN, query: { length: 5 } }, NOW);
    expect([hostile.total, hostile.page, hostile.tab, hostile.range]).toEqual([2, 1, "all", DEFAULT_ORDERS_RANGE]);
    expect(h.svc.listOrders(S1, { query: "p".repeat(101) }, NOW).total).toBe(2);
    expect(h.svc.listOrders(S1, null as unknown as undefined, NOW).total).toBe(2);
    expect(h.svc.listOrders("nope", {}, NOW)).toEqual({ items: [], total: 0, page: 1, pageCount: 0, tab: "all", range: DEFAULT_ORDERS_RANGE });
  });

  test("page size 10 with clamping", async () => {
    const h = setup();
    for (let i = 0; i < 23; i++) await place(h, S1, PIN, 1, {}, NOW - (23 - i) * MIN);
    const p1 = h.svc.listOrders(S1, { page: 1 }, NOW);
    const p3 = h.svc.listOrders(S1, { page: 3 }, NOW);
    expect([p1.items.length, p1.total, p1.pageCount]).toEqual([ORDERS_PAGE_SIZE, 23, 3]);
    expect(h.svc.listOrders(S1, { page: 2 }, NOW).items.length).toBe(10);
    expect(p3.items.length).toBe(3);
    expect(h.svc.listOrders(S1, { page: 99 }, NOW).page).toBe(3);
    for (const bad of [0, -1, 1.5, Number.POSITIVE_INFINITY]) expect(h.svc.listOrders(S1, { page: bad }, NOW).page).toBe(1);
    const all = [...p1.items, ...h.svc.listOrders(S1, { page: 2 }, NOW).items, ...p3.items];
    expect(new Set(all.map((o) => o.id)).size).toBe(23);
    const times = all.map((o) => o.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  test("range boundaries are inclusive", async () => {
    const h = setup();
    const placedAt = Date.parse("2026-08-04T10:00:00.000Z");
    const view = await place(h, S1, PIN, 1, {}, placedAt);
    const in3m = Date.parse("2026-11-04T10:00:00.000Z");
    expect(h.svc.listOrders(S1, { range: "3m" }, in3m).items.map((o) => o.id)).toEqual([view.id]);
    expect(h.svc.listOrders(S1, { range: "3m" }, in3m + 1).total).toBe(0);
    expect(h.svc.listOrders(S1, { range: "30d" }, placedAt + 30 * DAY).total).toBe(1);
    expect(h.svc.listOrders(S1, { range: "30d" }, placedAt + 30 * DAY + 1).total).toBe(0);
    expect(h.svc.listOrders(S1, { range: "6m" }, Date.parse("2027-02-04T10:00:00.000Z")).total).toBe(1);
    expect(h.svc.listOrders(S1, { range: "6m" }, Date.parse("2027-02-04T10:00:00.001Z")).total).toBe(0);
    expect(h.svc.listOrders(S1, { range: "1y" }, Date.parse("2027-08-04T10:00:00.000Z")).total).toBe(1);
    expect(h.svc.listOrders(S1, { range: "1y" }, Date.parse("2027-08-04T10:00:00.001Z")).total).toBe(0);
    expect(h.svc.listOrders(S1, { range: "all" }, Date.parse("2030-01-01T00:00:00.000Z")).total).toBe(1);
  });

  test("rangeCutoff clamps month ends", () => {
    expect(rangeCutoff("3m", Date.parse("2026-05-31T12:00:00.000Z"))).toBe("2026-02-28T12:00:00.000Z");
    expect(rangeCutoff("1y", Date.parse("2028-02-29T00:00:00.000Z"))).toBe("2027-02-28T00:00:00.000Z");
    expect(rangeCutoff("6m", Date.parse("2026-01-15T00:00:00.000Z"))).toBe("2025-07-15T00:00:00.000Z");
    expect(rangeCutoff("all", NOW)).toBeNull();
  });

  test("tabs: not_shipped excludes shipped, delivered and cancelled; cancelled lists only cancelled", async () => {
    const h = setup();
    const delivered = await place(h, S1, PIN, 1, {}, NOW - 20 * DAY);
    const shipped = await place(h, S1, PIN, 1, {}, NOW - 2 * DAY);
    const packed = await place(h, S1, PIN, 1, {}, NOW - 3 * HOUR);
    const cancelled = await place(h, S1, PIN, 1, {}, NOW - 5 * MIN);
    expectOk(h.svc.cancelOrder(cancelled.id, S1, NOW));
    const processing = await place(h, S1, PIN, 1, {}, NOW);

    const ids = (tab: string) => h.svc.listOrders(S1, { tab, range: "all" }, NOW).items.map((o) => o.id);
    expect(ids("not_shipped")).toEqual([processing.id, packed.id]);
    expect(ids("cancelled")).toEqual([cancelled.id]);
    expect(ids("all")).toEqual([processing.id, cancelled.id, packed.id, shipped.id, delivered.id]);
    expect(h.svc.listOrders(S1, { tab: "all", range: "all" }, NOW).items.map((o) => o.fulfillmentStatus)).toEqual([
      "processing",
      "cancelled",
      "packed",
      "shipped",
      "delivered",
    ]);
    // Listing persisted the reached events.
    expect(events(h.db, delivered.id).length).toBe(5);
  });

  test("query matches snapshot product names only (case-insensitive substring)", async () => {
    const h = setup();
    const tote = await place(h, S1, TOTE);
    await place(h, S1, PIN);
    expect(h.svc.listOrders(S1, { query: "TOTE" }).items.map((o) => o.id)).toEqual([tote.id]);
    expect(h.svc.listOrders(S1, { query: "  canvas   tote " }).total).toBe(1);
    expect(h.svc.listOrders(S1, { query: "canvas-tote-bag" }).total).toBe(0); // slug is not a name
    expect(h.svc.listOrders(S1, { query: "%" }).total).toBe(0);
    const none = h.svc.listOrders(S1, { query: "zzz" });
    expect([none.total, none.page, none.pageCount]).toEqual([0, 1, 0]);
  });
});

describe("getBuyAgainLines", () => {
  test("each product once, newest first, from paid non-cancelled orders; availability", async () => {
    const h = setup();
    await place(h, S1, PIN, 1, {}, NOW - 3 * DAY);
    await place(h, S1, TOTE, 1, {}, NOW - 2 * DAY);
    await place(h, S1, PIN, 2, {}, NOW - DAY);
    const cancelled = await place(h, S1, PRINT, 1, {}, NOW);
    expectOk(h.svc.cancelOrder(cancelled.id, S1, NOW));
    add(h, S1, "prod_walnut-desk", 1);
    expectErr(await h.svc.placeOrderV2(input(S1, { card: card(MOCK_CARDS.declined) })));
    await place(h, S2, "prod_walnut-desk", 1);

    const lines = h.svc.getBuyAgainLines(S1);
    expect(lines.map((l) => [l.productId, l.lastOrderedAt, l.available])).toEqual([
      [PIN, new Date(NOW - DAY).toISOString(), true],
      [TOTE, new Date(NOW - 2 * DAY).toISOString(), true],
    ]);
    expect(lines[0]?.product?.id).toBe(PIN);
    expect(lines[0]?.productSlug).toBe("enamel-pin-set");
    expect(h.svc.getBuyAgainLines(S1, 1).length).toBe(1);
    expect(h.svc.getBuyAgainLines(S1, -5).length).toBe(2);

    h.db.run("UPDATE products SET stock = 0 WHERE id = ?", [PIN]);
    h.db.run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    const after = h.svc.getBuyAgainLines(S1);
    expect(after.map((l) => [l.available, l.product === null])).toEqual([
      [false, false],
      [false, true],
    ]);
    expect(after[1]?.name).toBe("Canvas Tote Bag");

    h.db.run("DELETE FROM products WHERE id = ?", [PIN]);
    const gone = h.svc.getBuyAgainLines(S1)[0];
    expect([gone?.productId, gone?.product, gone?.available, gone?.name]).toEqual([PIN, null, false, "Enamel Pin Set"]);
    expect(h.svc.getBuyAgainLines("nope")).toEqual([]);
  });
});

describe("wiring", () => {
  test("getOrderService is a singleton over the shared DB and exposes the v2 API", () => {
    const a = getOrderService();
    expect(getOrderService()).toBe(a);
    expect(typeof a.placeOrderV2).toBe("function");
    expect(typeof a.placeOrder).toBe("function");
  });
});
