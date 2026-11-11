import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, type AppError, type Result } from "@/lib/result";
import type { ErrorCode } from "@/lib/types";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { SqliteCartRepository } from "@/server/cart/cart-repository";
import { CartService, createCartService } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { MOCK_CARDS, createMockPaymentProvider } from "@/server/payments/mock-payment-provider";
import type { ChargeRequest, PaymentProvider, PaymentResult } from "@/server/payments/payment-provider";
import { SqliteOrderRepository } from "./order-repository";
import {
  OrderService,
  PENDING_CLAIM_WAIT_MS,
  PENDING_PAYMENT_REF,
  createOrderService,
  type OrderServiceV2,
  type PlaceOrderInputV2,
} from "./order-service";

/**
 * FIX-checkout-v2 (D-T71-2 / D-T71-3): the idempotency key is claimed by a
 * pending order row inside the reservation transaction; a same-key attempt on
 * another connection waits for the finalized row and replays it (never a
 * second reservation or charge); every pre-charge failure re-checks the key.
 */

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
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

function v2Input(key: string, extra: Partial<PlaceOrderInputV2> = {}): PlaceOrderInputV2 {
  return { sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: key, ...extra };
}

function okv<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error("expected ok, got " + JSON.stringify(r.error));
  return r.value;
}

function errv<T>(r: Result<T, AppError>, code: ErrorCode): AppError {
  if (r.ok) throw new Error("expected " + code + ", got ok");
  expect(r.error.code).toBe(code);
  return r.error;
}

function stockOf(db: Database): number {
  return db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(TOTE)?.stock ?? -1;
}

function orderRows(db: Database): { id: string; status: string; failure_code: string | null; payment_ref: string | null }[] {
  return db
    .query<{ id: string; status: string; failure_code: string | null; payment_ref: string | null }, []>(
      "SELECT id, status, failure_code, payment_ref FROM orders ORDER BY rowid",
    )
    .all();
}

/** A provider whose charges resolve only when `release` is called; counts calls. */
function gatedProvider() {
  const inner = createMockPaymentProvider({ now: () => new Date(NOW) });
  const waiting: (() => void)[] = [];
  const calls: ChargeRequest[] = [];
  const provider: PaymentProvider = {
    charge: (request) => {
      calls.push(request);
      return new Promise<PaymentResult>((resolve) => {
        waiting.push(() => {
          inner.charge(request).then(resolve, () => resolve(err({ code: "PROCESSING_ERROR", message: "x" })));
        });
      });
    },
  };
  return {
    provider,
    calls,
    release: () => {
      for (const go of waiting.splice(0)) go();
    },
  };
}

/** Resolves once `predicate` holds (polls the event loop; bounded). */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) await Bun.sleep(2);
  expect(predicate()).toBe(true);
}

function v2Setup(payments: PaymentProvider, db: Database = createDatabase(":memory:"), claimWaitMs?: number) {
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  const svc = createOrderService(db, {
    now: () => NOW,
    payments,
    inFlight: new Map(),
    ...(claimWaitMs === undefined ? {} : { claimWaitMs }),
  });
  const carts = createCartService(db, { now: () => NOW });
  return { db, svc, carts };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "orders-claim-"));
  tempDirs.push(dir);
  return join(dir, "claim.sqlite");
}

describe("claim inside the reservation transaction (v2)", () => {
  test("while the charge is in flight the row exists as a pending claim, invisible to views and history", async () => {
    const gate = gatedProvider();
    const { db, svc, carts } = v2Setup(gate.provider);
    expect(carts.addItem(S1, TOTE, 2).ok).toBe(true);
    const placing = svc.placeOrderV2(v2Input("k-pending"), NOW);
    await until(() => gate.calls.length === 1);

    const [row] = orderRows(db);
    expect(row).toMatchObject({ status: "payment_failed", payment_ref: PENDING_PAYMENT_REF });
    expect(stockOf(db)).toBe(40); // reserved before the charge
    expect(svc.getOrderView(row?.id ?? "", S1, NOW)).toBeNull();
    expect(svc.listOrders(S1, { range: "all" }, NOW).total).toBe(0);

    gate.release();
    const view = okv(await placing);
    expect(orderRows(db)).toEqual([{ id: view.id, status: "paid", failure_code: null, payment_ref: expect.stringMatching(/^mock_/) }]);
    expect(svc.listOrders(S1, { range: "all" }, NOW).total).toBe(1);
  });

  test("D-T110-2: getOrder never returns a pending claim (v2 and MVP); finalized rows read normally", async () => {
    const gate = gatedProvider();
    const { db, svc, carts } = v2Setup(gate.provider);

    // v2 attempt that will be paid
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    const paying = svc.placeOrderV2(v2Input("k-get-paid"), NOW);
    await until(() => gate.calls.length === 1);
    const [pendingPaid] = orderRows(db);
    expect(pendingPaid).toMatchObject({ status: "payment_failed", failure_code: "PROCESSING_ERROR", payment_ref: PENDING_PAYMENT_REF });
    expect(svc.getOrder(pendingPaid?.id, S1)).toBeNull();
    gate.release();
    const paid = okv(await paying);
    expect(svc.getOrder(paid.id, S1)).toMatchObject({ id: paid.id, status: "paid" });

    // v2 attempt that will be declined: the finalized decline IS readable (MVP failure page)
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    const declining = svc.placeOrderV2(v2Input("k-get-declined", { card: card(MOCK_CARDS.declined) }), NOW);
    await until(() => gate.calls.length === 2);
    const pendingDeclined = orderRows(db).find((r) => r.payment_ref === PENDING_PAYMENT_REF);
    expect(pendingDeclined).toBeDefined();
    expect(svc.getOrder(pendingDeclined?.id, S1)).toBeNull();
    gate.release();
    const declined = errv(await declining, "PAYMENT_FAILED");
    expect(declined.details?.orderId).toBe(pendingDeclined?.id);
    expect(svc.getOrder(pendingDeclined?.id, S1)).toMatchObject({ status: "payment_failed", failureCode: "DECLINED" });

    // MVP placeOrder shares the claim: pending row is null, the paid order is readable after finalize
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    const mvp = svc.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k-get-mvp" });
    await until(() => gate.calls.length === 3);
    const pendingMvp = orderRows(db).find((r) => r.payment_ref === PENDING_PAYMENT_REF);
    expect(svc.getOrder(pendingMvp?.id, S1)).toBeNull();
    gate.release();
    const mvpOrder = okv(await mvp);
    expect(svc.getOrder(mvpOrder.id, S1)).toMatchObject({ id: mvpOrder.id, status: "paid" });
    // Ownership still applies to finalized rows.
    expect(svc.getOrder(mvpOrder.id, S2)).toBeNull();
  });

  test("two connections to one file DB, separate providers, same key: one reservation, one charge, same order", async () => {
    const path = tempDbPath();
    const gateA = gatedProvider();
    const gateB = gatedProvider();
    const a = v2Setup(gateA.provider, createDatabase(path));
    const dbB = createDatabase(path);
    const svcB = createOrderService(dbB, { now: () => NOW, payments: gateB.provider, inFlight: new Map() });
    expect(a.carts.addItem(S1, TOTE, 1).ok).toBe(true);

    const first = a.svc.placeOrderV2(v2Input("k-two-conn"), NOW);
    await until(() => gateA.calls.length === 1);
    // B arrives while A's charge is pending: it must wait, not reserve/charge.
    const second = svcB.placeOrderV2(v2Input("k-two-conn"), NOW);
    await Bun.sleep(30);
    expect(gateB.calls).toHaveLength(0);
    expect(stockOf(a.db)).toBe(41);

    gateA.release();
    const [ra, rb] = await Promise.all([first, second]);
    expect(okv(rb).id).toBe(okv(ra).id);
    expect(gateA.calls.length + gateB.calls.length).toBe(1);
    expect(stockOf(a.db)).toBe(41);
    expect(orderRows(a.db)).toHaveLength(1);
    a.db.close();
    dbB.close();
  });

  test("still pending after the wait: INTERNAL_ERROR (key kept), no reservation, no charge; a later retry replays", async () => {
    const path = tempDbPath();
    const gateA = gatedProvider();
    const gateB = gatedProvider();
    const a = v2Setup(gateA.provider, createDatabase(path));
    const dbB = createDatabase(path);
    const svcB = createOrderService(dbB, { now: () => NOW, payments: gateB.provider, inFlight: new Map(), claimWaitMs: 40 });
    expect(a.carts.addItem(S1, TOTE, 1).ok).toBe(true);

    const first = a.svc.placeOrderV2(v2Input("k-slow"), NOW);
    await until(() => gateA.calls.length === 1);
    const timedOut = errv(await svcB.placeOrderV2(v2Input("k-slow"), NOW), "INTERNAL_ERROR");
    expect(timedOut.details).toBeUndefined();
    expect(gateB.calls).toHaveLength(0);
    expect(stockOf(a.db)).toBe(41);

    gateA.release();
    const placed = okv(await first);
    expect(okv(await svcB.placeOrderV2(v2Input("k-slow"), NOW)).id).toBe(placed.id);
    expect(gateB.calls).toHaveLength(0);
    a.db.close();
    dbB.close();
  });

  test("another owner's key while pending: INVALID_INPUT at once (no wait)", async () => {
    const gate = gatedProvider();
    const { svc, carts } = v2Setup(gate.provider);
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    const first = svc.placeOrderV2(v2Input("k-owner"), NOW);
    await until(() => gate.calls.length === 1);
    const started = Date.now();
    errv(await svc.placeOrderV2(v2Input("k-owner", { sessionId: S2 }), NOW), "INVALID_INPUT");
    expect(Date.now() - started).toBeLessThan(PENDING_CLAIM_WAIT_MS);
    gate.release();
    okv(await first);
    expect(gate.calls).toHaveLength(1);
  });

  test("a declined charge finalizes the claim as payment_failed (no pending marker); the replay is the same PAYMENT_FAILED", async () => {
    const { db, svc, carts } = v2Setup(createMockPaymentProvider({ now: () => new Date(NOW) }));
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    const failed = errv(await svc.placeOrderV2(v2Input("k-declined", { card: card(MOCK_CARDS.declined) }), NOW), "PAYMENT_FAILED");
    expect(orderRows(db)).toEqual([{ id: String(failed.details?.orderId), status: "payment_failed", failure_code: "DECLINED", payment_ref: null }]);
    expect(stockOf(db)).toBe(42);
    const again = errv(await svc.placeOrderV2(v2Input("k-declined", { card: card(MOCK_CARDS.declined) }), NOW), "PAYMENT_FAILED");
    expect(again.details).toEqual(failed.details);
  });

  test("finalize failure withdraws the claim and releases stock + coupon; the same key then succeeds", async () => {
    const pay = createMockPaymentProvider({ now: () => new Date(NOW) });
    const { db, svc, carts } = v2Setup(pay);
    expect(carts.addItem(S1, TOTE, 2).ok).toBe(true);
    expect(carts.applyCoupon(S1, "WELCOME10", NOW).ok).toBe(true);
    const internals = svc as unknown as { carts: { clear: (s: string) => Result<void, AppError> } };
    const realClear = internals.carts.clear.bind(internals.carts);
    internals.carts.clear = () => err({ code: "INTERNAL_ERROR", message: "boom" });

    errv(await svc.placeOrderV2(v2Input("k-finalize"), NOW), "INTERNAL_ERROR");
    expect(orderRows(db)).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS n FROM order_items").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM coupon_redemptions").get()).toEqual({ n: 0 });
    expect(stockOf(db)).toBe(42);

    internals.carts.clear = realClear;
    const view = okv(await svc.placeOrderV2(v2Input("k-finalize"), NOW));
    expect(view.couponCode).toBe("WELCOME10");
    expect(stockOf(db)).toBe(40);
    expect(pay.listCharges()).toHaveLength(1); // provider replayed the key's first charge
  });
});

describe("pre-charge failures re-check the key (D-T71-3)", () => {
  function staleFirstLookup(svc: OrderServiceV2 | OrderService): void {
    const repo = (svc as unknown as { orders: { findByIdempotencyKey: (k: string) => unknown } }).orders;
    const real = repo.findByIdempotencyKey.bind(repo);
    let calls = 0;
    repo.findByIdempotencyKey = (k: string) => (calls++ === 0 ? null : real(k));
  }

  test("v2: EMPTY_CART after a stale lookup replays the placed order", async () => {
    const pay = createMockPaymentProvider({ now: () => new Date(NOW) });
    const { svc, carts } = v2Setup(pay);
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    const placed = okv(await svc.placeOrderV2(v2Input("k-stale"), NOW));
    staleFirstLookup(svc);
    expect(okv(await svc.placeOrderV2(v2Input("k-stale"), NOW)).id).toBe(placed.id);
    expect(pay.listCharges()).toHaveLength(1);
  });

  test("v2: a refilled cart with no stock left (would be STOCK_CHANGED) still replays; nothing reserved", async () => {
    const pay = createMockPaymentProvider({ now: () => new Date(NOW) });
    const { db, svc, carts } = v2Setup(pay);
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    const placed = okv(await svc.placeOrderV2(v2Input("k-stale-stock"), NOW));
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    db.query("UPDATE products SET stock = 0 WHERE id = ?").run(TOTE);
    staleFirstLookup(svc);
    expect(okv(await svc.placeOrderV2(v2Input("k-stale-stock"), NOW)).id).toBe(placed.id);
    expect(stockOf(db)).toBe(0);
    expect(carts.getCart(S1).itemCount).toBe(1); // the refilled cart is untouched
    expect(pay.listCharges()).toHaveLength(1);
  });

  test("v2: a validation failure after a stale lookup also replays (the key wins)", async () => {
    const pay = createMockPaymentProvider({ now: () => new Date(NOW) });
    const { svc, carts } = v2Setup(pay);
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    const placed = okv(await svc.placeOrderV2(v2Input("k-stale-invalid"), NOW));
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    staleFirstLookup(svc);
    expect(okv(await svc.placeOrderV2(v2Input("k-stale-invalid", { card: "nope" }), NOW)).id).toBe(placed.id);
  });

  test("a fresh key keeps the ordinary failures (EMPTY_CART, STOCK_CHANGED) and leaves no claim behind", async () => {
    const pay = createMockPaymentProvider({ now: () => new Date(NOW) });
    const { db, svc, carts } = v2Setup(pay);
    errv(await svc.placeOrderV2(v2Input("k-empty"), NOW), "EMPTY_CART");
    expect(carts.addItem(S1, TOTE, 2).ok).toBe(true);
    db.query("UPDATE products SET stock = 1 WHERE id = ?").run(TOTE);
    errv(await svc.placeOrderV2(v2Input("k-stock"), NOW), "STOCK_CHANGED");
    expect(orderRows(db)).toHaveLength(0);
    expect(pay.listCharges()).toHaveLength(0);
  });
});

describe("MVP placeOrder uses the same claim", () => {
  function mvpSetup(db: Database, payments: PaymentProvider, claimWaitMs?: number) {
    const products = new SqliteProductRepository(db);
    const carts = new CartService({ db, carts: new SqliteCartRepository(db), products });
    const service = new OrderService({
      db,
      carts,
      products,
      orders: new SqliteOrderRepository(db),
      payments,
      now: () => new Date(NOW),
      ...(claimWaitMs === undefined ? {} : { claimWaitMs }),
    });
    return { carts, service };
  }

  test("two connections, same key: one charge, one decrement, same order; stale lookup + empty cart replays", async () => {
    const path = tempDbPath();
    const dbA = createDatabase(path);
    runMigrations(dbA);
    seedDatabase(dbA, { now: new Date(NOW) });
    const dbB = createDatabase(path);
    const gateA = gatedProvider();
    const gateB = gatedProvider();
    const a = mvpSetup(dbA, gateA.provider);
    const b = mvpSetup(dbB, gateB.provider);
    expect(a.carts.addItem(S1, TOTE, 1).ok).toBe(true);
    const input = { sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "mvp-two-conn" };

    const first = a.service.placeOrder(input);
    await until(() => gateA.calls.length === 1);
    expect(orderRows(dbA)[0]?.payment_ref).toBe(PENDING_PAYMENT_REF);
    const second = b.service.placeOrder(input);
    await Bun.sleep(20);
    gateA.release();
    const [ra, rb] = await Promise.all([first, second]);
    expect(okv(rb).id).toBe(okv(ra).id);
    expect(gateB.calls).toHaveLength(0);
    expect(stockOf(dbA)).toBe(41);

    staleFirstLookup(b.service);
    expect(okv(await b.service.placeOrder(input)).id).toBe(okv(ra).id);
    dbA.close();
    dbB.close();
  });

  test("finalize failure withdraws the claim and restores stock; the same key then succeeds", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db, { now: new Date(NOW) });
    const pay = createMockPaymentProvider({ now: () => new Date(NOW) });
    const { carts, service } = mvpSetup(db, pay);
    expect(carts.addItem(S1, TOTE, 1).ok).toBe(true);
    const realClear = carts.clear.bind(carts);
    carts.clear = () => err({ code: "INTERNAL_ERROR", message: "boom" });
    const input = { sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "mvp-finalize" };
    errv(await service.placeOrder(input), "INTERNAL_ERROR");
    expect(orderRows(db)).toHaveLength(0);
    expect(stockOf(db)).toBe(42);
    carts.clear = realClear;
    okv(await service.placeOrder(input));
    expect(stockOf(db)).toBe(41);
  });

  function staleFirstLookup(svc: OrderService): void {
    const repo = (svc as unknown as { orders: { findByIdempotencyKey: (k: string) => unknown } }).orders;
    const real = repo.findByIdempotencyKey.bind(repo);
    let calls = 0;
    repo.findByIdempotencyKey = (k: string) => (calls++ === 0 ? null : real(k));
  }
});
