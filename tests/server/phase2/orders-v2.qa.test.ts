/**
 * QA-W3-T55: order service v2 (totals, coupon redemption, snapshots, order
 * events, history, cancel, buy-again). Owned by QA; implementer files are not
 * edited. Criteria: BACKLOG-phase2.md "### T55" (AC1-AC9) + STATE.md errata
 * (ORDER_NOT_CANCELLABLE replaces CANCEL_NOT_ALLOWED; COUPON_EXHAUSTED = max
 * uses reached) + ruling R-1 (no owner key in views).
 *
 * Isolation: every DB is ":memory:" or a file under an OS temp dir that is
 * removed in `finally`. The last test asserts ./data holds only .gitkeep.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppError, Result } from "@/lib/result";
import { ERROR_CODES, type ErrorCode } from "@/lib/types";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { SHIPPING_METHOD_DROPPED_NOTICE, createCartService, type CartServiceV2 } from "@/server/cart/cart-service";
import { MOCK_CARDS, createMockPaymentProvider, type MockPaymentProvider } from "@/server/payments/mock-payment-provider";
import { DELETED_OWNER_KEY } from "@/server/auth/account-repository";
import { createMergeRepository } from "@/server/auth/merge-repository";
import { FULFILLMENT_SEQUENCE } from "@/server/fulfillment/fulfillment";
import {
  MAX_BUY_AGAIN_LIMIT,
  MAX_DELIVERY_NOTE_LENGTH,
  ORDERS_PAGE_SIZE,
  REFUND_PENDING_NOTE,
  createOrderService,
  rangeCutoff,
  type OrderServiceV2,
  type OrderView,
  type PlaceOrderInputV2,
} from "@/server/orders/order-service";
import type { OrdersRaceJob, OrdersRaceResult } from "./orders-v2-race.qa.worker";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-11-04T10:00:00.000Z"); // Wednesday 10:00 UTC
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";

const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const PIN = "prod_enamel-pin-set"; // 50, stock 100

const ADDRESS = {
  fullName: "Grace Hopper",
  email: "grace.qa@example.com",
  line1: "99 Compiler Lane",
  city: "Arlington",
  region: "VA",
  postalCode: "22201",
  country: "US",
};

function card(number: string = MOCK_CARDS.success) {
  return { number, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Grace Hopper" };
}

/** Every error code any test observed; checked against ERROR_CODES at the end. */
const seenCodes = new Set<string>();

interface Harness {
  readonly db: Database;
  readonly svc: OrderServiceV2;
  readonly carts: CartServiceV2;
  readonly pay: MockPaymentProvider;
}

function setup(db: Database = createDatabase(":memory:"), opts: { latencyMs?: number; seed?: boolean } = {}): Harness {
  if (opts.seed !== false) {
    runMigrations(db);
    seedDatabase(db, { now: new Date(NOW) });
  }
  const pay = createMockPaymentProvider({ latencyMs: opts.latencyMs ?? 0, now: () => new Date(NOW) });
  const svc = createOrderService(db, { now: () => NOW, payments: pay, inFlight: new Map() });
  const carts = createCartService(db, { now: () => NOW });
  return { db, svc, carts, pay };
}

let keySeq = 0;
function key(): string {
  keySeq += 1;
  return `qa-key-${keySeq}-${crypto.randomUUID()}`;
}

function input(sessionId: string, extra: Partial<PlaceOrderInputV2> = {}): PlaceOrderInputV2 {
  return { sessionId, address: ADDRESS, card: card(), idempotencyKey: key(), ...extra };
}

function add(h: Harness, session: string, productId: string, qty: number): void {
  const r = h.carts.addItem(session, productId, qty);
  if (!r.ok) throw new Error(`addItem ${productId} failed: ${r.error.code}`);
}

function okv<T>(r: Result<T, AppError>): T {
  if (!r.ok) {
    seenCodes.add(r.error.code);
    throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  }
  return r.value;
}

function errv<T>(r: Result<T, AppError>): AppError {
  if (r.ok) throw new Error("expected an error result");
  seenCodes.add(r.error.code);
  return r.error;
}

async function place(h: Harness, session: string, productId: string, qty = 1, extra: Partial<PlaceOrderInputV2> = {}, now?: number): Promise<OrderView> {
  add(h, session, productId, qty);
  return okv(await h.svc.placeOrderV2(input(session, extra), now));
}

function stock(db: Database, id: string): number {
  return db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id)?.stock ?? -1;
}
function usedCount(db: Database, code: string): number {
  return db.query<{ n: number }, [string]>("SELECT used_count AS n FROM coupons WHERE code = ?").get(code)?.n ?? -1;
}
function redemptionRows(db: Database, code: string): { session_id: string; order_id: string | null }[] {
  return db
    .query<{ session_id: string; order_id: string | null }, [string]>(
      "SELECT session_id, order_id FROM coupon_redemptions WHERE coupon_code = ? ORDER BY session_id",
    )
    .all(code);
}
function orderRows(db: Database, sessionIds: readonly string[]): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM orders WHERE session_id IN (SELECT value FROM json_each(?))")
      .get(JSON.stringify(sessionIds))?.n ?? -1
  );
}
function eventRows(db: Database, orderId: string): { id: number; order_id: string; status: string; at: string; note: string | null }[] {
  return db
    .query<{ id: number; order_id: string; status: string; at: string; note: string | null }, [string]>(
      "SELECT id, order_id, status, at, note FROM order_events WHERE order_id = ? ORDER BY id",
    )
    .all(orderId);
}
function addCoupon(
  db: Database,
  code: string,
  f: { kind?: "percent" | "fixed" | "free_shipping"; value?: number; min?: number; maxUses?: number | null; used?: number; expires?: string | null } = {},
): void {
  db.query(
    "INSERT INTO coupons (code, kind, value, min_subtotal_cents, max_uses, used_count, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(code, f.kind ?? "fixed", f.value ?? 100, f.min ?? 0, f.maxUses ?? null, f.used ?? 0, f.expires ?? null);
}

/** Every UUID-shaped substring of a JSON string. */
function uuidsIn(json: string): string[] {
  return json.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g) ?? [];
}

/** R-1 privacy assertions on any value that may reach a client. */
function expectNoOwnerLeak(value: unknown, owner: string): void {
  const json = JSON.stringify(value);
  expect(json.includes(owner)).toBe(false);
  expect(json.toLowerCase().includes(owner.toLowerCase())).toBe(false);
  expect(json).not.toMatch(/"(sessionId|session_id|ownerKey|owner_key|passwordHash|password_hash|password|token|tokenHash|token_hash|payment_ref|paymentRef)"/i);
  expect(uuidsIn(json).map((u) => u.toLowerCase())).not.toContain(owner.toLowerCase());
  expect(json.includes(MOCK_CARDS.success)).toBe(false);
  expect(json.includes(DELETED_OWNER_KEY)).toBe(false);
}

// Worker helpers ------------------------------------------------------------

function runWorkers(jobs: readonly Omit<OrdersRaceJob, "start">[]): Promise<OrdersRaceResult[]> {
  const start = new Int32Array(new SharedArrayBuffer(4));
  const pending = Promise.all(
    jobs.map(
      (job) =>
        new Promise<OrdersRaceResult>((resolve, reject) => {
          const w = new Worker(new URL("./orders-v2-race.qa.worker.ts", import.meta.url).href);
          w.onmessage = (e: MessageEvent<OrdersRaceResult>) => {
            resolve(e.data);
            w.terminate();
          };
          w.onerror = (e) => reject(new Error(String(e.message)));
          w.postMessage({ ...job, start });
        }),
    ),
  );
  // Workers open their connections, then block on the barrier; release all at once.
  setTimeout(() => {
    Atomics.store(start, 0, 1);
    Atomics.notify(start, 0);
  }, 50);
  return pending;
}

function withTempDb<T>(prefix: string, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "orders.sqlite");
  return fn(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// PRNG ------------------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function uuidFrom(rand: () => number): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(rand() * 4)]}${hex(3)}-${hex(12)}`;
}
function int(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

// ---------------------------------------------------------------------------
// 1. Totals (AC2) — property test with an independent oracle
// ---------------------------------------------------------------------------

interface MethodRow {
  id: string;
  name: string;
  price_cents: number;
  free_over_cents: number | null;
  sort_order: number;
  is_active: number;
}

describe("QA T55 AC2: totals = subtotal - discount + shipping (property, independent oracle)", () => {
  test("250 seeded random carts x coupons x shipping configs: order == oracle == cart view at placement == charged amount", async () => {
    const h = setup();
    h.db.run("UPDATE products SET stock = 1000000");
    const nowIso = new Date(NOW).toISOString();
    const products = h.db
      .query<{ id: string }, [string]>("SELECT id FROM products WHERE published_at <= ? ORDER BY id")
      .all(nowIso)
      .map((r) => r.id);
    expect(products.length).toBeGreaterThan(20);
    const methodIds = h.db.query<{ id: string }, []>("SELECT id FROM shipping_methods ORDER BY sort_order").all().map((r) => r.id);

    const rand = prng(0x7155);
    let zeroTotals = 0;
    let withCoupon = 0;
    let freeThresholdHits = 0;
    for (let i = 0; i < 250; i++) {
      const session = uuidFrom(rand);

      // Random shipping configuration (at least one active method).
      for (const id of methodIds) {
        const free = rand() < 0.4 ? null : int(rand, 0, 15_000);
        h.db.run("UPDATE shipping_methods SET price_cents = ?, free_over_cents = ?, is_active = ? WHERE id = ?", [
          rand() < 0.1 ? 0 : int(rand, 1, 2_500),
          free,
          rand() < 0.8 ? 1 : 0,
          id,
        ]);
      }
      if (h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM shipping_methods WHERE is_active = 1").get()?.n === 0) {
        h.db.run("UPDATE shipping_methods SET is_active = 1 WHERE id = ?", [methodIds[int(rand, 0, methodIds.length - 1)] ?? "standard"]);
      }

      // Random cart with random current prices (incl. 0 and very large).
      const lineCount = int(rand, 1, 4);
      const chosen = new Set<string>();
      while (chosen.size < lineCount) chosen.add(products[int(rand, 0, products.length - 1)] ?? TOTE);
      for (const id of chosen) {
        const r = rand();
        const price = r < 0.08 ? 0 : r < 0.15 ? int(rand, 1_000_000_000, 99_000_000_000) : int(rand, 1, 25_000);
        h.db.run("UPDATE products SET price_cents = ?, list_price_cents = NULL WHERE id = ?", [price, id]);
        add(h, session, id, int(rand, 1, 5));
      }

      // Random coupon (applied only through the cart service, so only valid ones stick).
      let couponCode: string | null = null;
      if (rand() < 0.7) {
        const code = `PROP${i}`;
        const kindRoll = rand();
        const kind = kindRoll < 0.4 ? "percent" : kindRoll < 0.8 ? "fixed" : "free_shipping";
        const value = kind === "percent" ? int(rand, 1, 100) : kind === "fixed" ? int(rand, 1, 60_000) : 0;
        addCoupon(h.db, code, { kind, value, min: rand() < 0.6 ? 0 : int(rand, 1, 30_000) });
        const applied = h.carts.applyCoupon(session, code, NOW);
        if (applied.ok) couponCode = code;
        else expect(errv(applied).code).toBe("COUPON_MIN_SUBTOTAL");
      }

      // Shipping selection mode: none / stored / explicit / stored + different explicit.
      const active = h.db
        .query<MethodRow, []>("SELECT id, name, price_cents, free_over_cents, sort_order, is_active FROM shipping_methods WHERE is_active = 1 ORDER BY sort_order, id")
        .all();
      const mode = int(rand, 0, 3);
      const pickActive = () => active[int(rand, 0, active.length - 1)]?.id ?? "standard";
      let stored: string | null = null;
      let explicit: string | null = null;
      if (mode === 1 || mode === 3) {
        stored = pickActive();
        okv(h.carts.selectShippingMethod(session, stored));
      }
      if (mode === 2 || mode === 3) explicit = pickActive();

      // ---- independent oracle (raw SQL + arithmetic, no service code) ----
      const lines = h.db
        .query<{ product_id: string; quantity: number; price_cents: number }, [string]>(
          "SELECT ci.product_id, ci.quantity, p.price_cents FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.cart_session_id = ?",
        )
        .all(session);
      const subtotal = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
      expect(Number.isSafeInteger(subtotal)).toBe(true);
      const coupon = couponCode === null
        ? null
        : h.db.query<{ kind: string; value: number }, [string]>("SELECT kind, value FROM coupons WHERE code = ?").get(couponCode);
      let discount = 0;
      if (coupon?.kind === "percent") discount = Math.min(Math.floor((subtotal * coupon.value) / 100), subtotal);
      if (coupon?.kind === "fixed") discount = Math.min(coupon.value, subtotal);
      if (coupon?.kind === "percent" && subtotal * coupon.value > Number.MAX_SAFE_INTEGER) {
        discount = Number((BigInt(subtotal) * BigInt(coupon.value)) / 100n);
      }
      const priceAt = (m: MethodRow) => (m.free_over_cents !== null && subtotal >= m.free_over_cents ? 0 : m.price_cents);
      const cheapest = [...active].sort((a, b) => priceAt(a) - priceAt(b) || a.sort_order - b.sort_order)[0];
      const methodId = explicit ?? stored ?? cheapest?.id ?? "";
      const method = active.find((m) => m.id === methodId);
      if (method === undefined) throw new Error("oracle: no method");
      const shipping = coupon?.kind === "free_shipping" ? 0 : priceAt(method);
      if (method.free_over_cents !== null && subtotal >= method.free_over_cents) freeThresholdHits += 1;
      const total = subtotal - discount + shipping;

      // Cart view at placement (same instant, same cart).
      const view = okv(h.carts.getCartView(session, NOW));
      const chargesBefore = h.pay.listCharges().length;
      const order = okv(
        await h.svc.placeOrderV2(
          // Forged client totals must be ignored.
          { ...input(session, explicit === null ? {} : { shippingMethodId: explicit }), totalCents: 1, discountCents: 999_999, shippingCents: 0 } as PlaceOrderInputV2,
          NOW,
        ),
      );

      const got = [order.subtotalCents, order.discountCents, order.shippingCents, order.totalCents];
      expect(got).toEqual([subtotal, discount, shipping, total]);
      for (const n of got) {
        expect(Number.isSafeInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(0);
      }
      expect(order.discountCents).toBeLessThanOrEqual(order.subtotalCents);
      expect(order.couponCode).toBe(couponCode);
      expect(order.shippingMethodId).toBe(methodId);
      expect(order.shippingMethodName).toBe(method.name);
      if (explicit === null || explicit === view.shipping?.method.id) {
        expect([view.totals.subtotalCents, view.totals.discountCents, view.totals.shippingCents, view.totals.totalCents]).toEqual(got);
      }
      // Snapshot line prices equal the oracle prices.
      const priceById = new Map(lines.map((l) => [l.product_id, l.price_cents]));
      for (const item of order.items) expect(item.unitPriceCents).toBe(priceById.get(item.productId) ?? -1);

      // Charged amount == server total (0 is never sent to the provider).
      const charges = h.pay.listCharges();
      const row = h.db
        .query<{ total_cents: number; discount_cents: number; shipping_cents: number; payment_ref: string | null }, [string]>(
          "SELECT total_cents, discount_cents, shipping_cents, payment_ref FROM orders WHERE id = ?",
        )
        .get(order.id);
      expect([row?.total_cents, row?.discount_cents, row?.shipping_cents]).toEqual([total, discount, shipping]);
      if (total === 0) {
        zeroTotals += 1;
        expect(charges.length).toBe(chargesBefore);
        expect(row?.payment_ref).toBeNull();
      } else {
        expect(charges.length).toBe(chargesBefore + 1);
        expect(charges[charges.length - 1]?.amountCents).toBe(total);
      }
      if (couponCode !== null) {
        withCoupon += 1;
        expect(redemptionRows(h.db, couponCode)).toEqual([{ session_id: session, order_id: order.id }]);
      }
    }
    // The generator actually exercised the interesting regions.
    expect(withCoupon).toBeGreaterThan(80);
    expect(zeroTotals).toBeGreaterThan(0);
    expect(freeThresholdHits).toBeGreaterThan(10);
  }, 120_000);

  test("MONEY_OVERFLOW: a subtotal beyond MAX_SAFE_INTEGER is refused before any charge or reservation", async () => {
    const h = setup();
    h.db.run("UPDATE products SET stock = 1000 WHERE id = ?", [TOTE]);
    add(h, S1, TOTE, 2);
    // Price raised after the line was added (the cart refuses overflowing adds itself).
    h.db.run("UPDATE products SET price_cents = ?, list_price_cents = NULL WHERE id = ?", [Number.MAX_SAFE_INTEGER - 10, TOTE]);
    const e = errv(await h.svc.placeOrderV2(input(S1)));
    expect(e.code).toBe("MONEY_OVERFLOW");
    expect(h.pay.listCharges()).toEqual([]);
    expect(stock(h.db, TOTE)).toBe(1000);
    expect(orderRows(h.db, [S1])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Coupon redemption (AC3, AC4)
// ---------------------------------------------------------------------------

describe("QA T55 AC3/AC4: coupon redemption", () => {
  test("an order with a coupon writes exactly one coupon_redemptions row (code, owner, order id) and bumps used_count once", async () => {
    const h = setup();
    addCoupon(h.db, "QAONE", { kind: "percent", value: 15 });
    add(h, S1, TOTE, 2);
    okv(h.carts.applyCoupon(S1, "qaone", NOW));
    const first = input(S1);
    const view = okv(await h.svc.placeOrderV2(first));
    expect(view.couponCode).toBe("QAONE");
    expect(view.discountCents).toBe(Math.floor((2 * 1999 * 15) / 100));
    expect(redemptionRows(h.db, "QAONE")).toEqual([{ session_id: S1, order_id: view.id }]);
    expect(usedCount(h.db, "QAONE")).toBe(1);
    // An idempotent replay of the same submit does not redeem again.
    const again = okv(await h.svc.placeOrderV2({ ...input(S1), idempotencyKey: first.idempotencyKey }));
    expect(again.id).toBe(view.id);
    expect(redemptionRows(h.db, "QAONE").length).toBe(1);
    expect(usedCount(h.db, "QAONE")).toBe(1);
  });

  test("same owner cannot redeem twice: stale stored code at placement -> COUPON_USED, no order, no charge, no stock change", async () => {
    const h = setup();
    addCoupon(h.db, "QAUSE", { kind: "fixed", value: 300 });
    add(h, S1, TOTE, 1);
    okv(h.carts.applyCoupon(S1, "QAUSE", NOW));
    okv(await h.svc.placeOrderV2(input(S1)));
    // The cart service already refuses a second apply...
    add(h, S1, TOTE, 1);
    expect(errv(h.carts.applyCoupon(S1, "QAUSE", NOW)).code).toBe("COUPON_USED");
    // ...and a code that is still stored on the cart (stale tab) fails the order.
    h.db.run("UPDATE carts SET coupon_code = 'QAUSE' WHERE session_id = ?", [S1]);
    const charges = h.pay.listCharges().length;
    const before = stock(h.db, TOTE);
    const e = errv(await h.svc.placeOrderV2(input(S1)));
    expect(e.code).toBe("COUPON_USED");
    expect(orderRows(h.db, [S1])).toBe(1);
    expect(h.pay.listCharges().length).toBe(charges);
    expect(stock(h.db, TOTE)).toBe(before);
    expect(usedCount(h.db, "QAUSE")).toBe(1);
  });

  test("in-process Promise.all: 8 owners race for the last redemption -> exactly 1 order, 7 x COUPON_EXHAUSTED, no extra charge", async () => {
    for (let round = 0; round < 5; round++) {
      const h = setup(createDatabase(":memory:"), { latencyMs: 3 });
      addCoupon(h.db, "QALAST", { maxUses: 3, used: 2 });
      const sessions = Array.from({ length: 8 }, () => crypto.randomUUID());
      for (const s of sessions) {
        add(h, s, PIN, 1);
        okv(h.carts.applyCoupon(s, "QALAST", NOW));
      }
      const results = await Promise.all(sessions.map((s) => h.svc.placeOrderV2(input(s))));
      const wins = results.filter((r) => r.ok);
      const losses = results.filter((r) => !r.ok).map((r) => errv(r).code);
      expect(wins.length).toBe(1);
      expect(losses).toEqual(Array.from({ length: 7 }, () => "COUPON_EXHAUSTED"));
      expect(usedCount(h.db, "QALAST")).toBe(3);
      expect(redemptionRows(h.db, "QALAST").length).toBe(1);
      expect(h.pay.listCharges().length).toBe(1);
      expect(orderRows(h.db, sessions)).toBe(1);
      expect(stock(h.db, PIN)).toBe(99);
      h.db.close();
    }
  });

  test("worker threads on a temp file DB, barrier start: 4 owners race for the last redemption (10 rounds) -> never over-redeemed", async () => {
    await withTempDb("qa-t55-coupon-race-", async (path) => {
      const db = createDatabase(path);
      const h = setup(db);
      try {
        for (let round = 0; round < 10; round++) {
          const code = `QARACE${round}`;
          addCoupon(db, code, { maxUses: 1 });
          const sessions = Array.from({ length: 4 }, () => crypto.randomUUID());
          for (const s of sessions) {
            add(h, s, TOTE, 1);
            okv(h.carts.applyCoupon(s, code, NOW));
          }
          const before = stock(db, TOTE);
          const results = await runWorkers(sessions.map((sessionId) => ({ path, op: "place", sessionId, now: NOW, idempotencyKey: key() })));
          for (const r of results) expect(r.code).not.toMatch(/^THROW/);
          expect(results.filter((r) => r.ok).length).toBe(1);
          for (const r of results.filter((x) => !x.ok)) {
            seenCodes.add(r.code);
            expect(r.code).toBe("COUPON_EXHAUSTED");
            expect(r.charges).toBe(0);
          }
          expect(results.reduce((n, r) => n + r.charges, 0)).toBe(1);
          expect(usedCount(db, code)).toBe(1);
          const rows = redemptionRows(db, code);
          expect(rows.length).toBe(1);
          expect(rows[0]?.order_id).toBe(results.find((r) => r.ok)?.orderId ?? "");
          expect(orderRows(db, sessions)).toBe(1);
          expect(stock(db, TOTE)).toBe(before - 1);
        }
      } finally {
        db.close();
      }
    });
  }, 60_000);

  test("worker threads: one owner racing itself with 3 keys for a single-use-per-customer coupon -> 1 order, others COUPON_USED", async () => {
    await withTempDb("qa-t55-coupon-self-", async (path) => {
      const db = createDatabase(path);
      const h = setup(db);
      try {
        addCoupon(db, "QASELF", { kind: "percent", value: 20 });
        add(h, S1, PIN, 3);
        okv(h.carts.applyCoupon(S1, "QASELF", NOW));
        const results = await runWorkers([0, 1, 2].map(() => ({ path, op: "place" as const, sessionId: S1, now: NOW, idempotencyKey: key() })));
        for (const r of results) expect(r.code).not.toMatch(/^THROW/);
        expect(results.filter((r) => r.ok).length).toBe(1);
        // Losers: COUPON_USED (redemption guard) or EMPTY_CART (winner already cleared the cart).
        for (const r of results.filter((x) => !x.ok)) {
          seenCodes.add(r.code);
          expect(["COUPON_USED", "EMPTY_CART"]).toContain(r.code);
          expect(r.charges).toBe(0);
        }
        expect(redemptionRows(db, "QASELF").length).toBe(1);
        expect(usedCount(db, "QASELF")).toBe(1);
        expect(orderRows(db, [S1])).toBe(1);
        expect(stock(db, PIN)).toBe(97);
      } finally {
        db.close();
      }
    });
  }, 30_000);

  test("coupon expired between cart view and submit -> COUPON_EXPIRED, no order/charge/redemption; afterwards the view drops it with a notice and the next order has NO stale discount", async () => {
    const h = setup();
    const expires = new Date(NOW + MIN).toISOString();
    addCoupon(h.db, "QAEXP", { kind: "percent", value: 50, expires });
    add(h, S1, TOTE, 1);
    okv(h.carts.applyCoupon(S1, "QAEXP", NOW));
    expect(okv(h.carts.getCartView(S1, NOW)).totals.discountCents).toBe(999);

    const later = NOW + 2 * MIN;
    const e = errv(await h.svc.placeOrderV2(input(S1), later));
    expect(e.code).toBe("COUPON_EXPIRED");
    expect(h.pay.listCharges()).toEqual([]);
    expect(orderRows(h.db, [S1])).toBe(0);
    expect(redemptionRows(h.db, "QAEXP")).toEqual([]);
    expect(stock(h.db, TOTE)).toBe(42);

    const view = okv(h.carts.getCartView(S1, later));
    expect(view.coupon).toBeNull();
    expect(view.couponNotice).toContain("QAEXP");
    expect(view.totals.discountCents).toBe(0);
    const placed = okv(await h.svc.placeOrderV2(input(S1), later));
    expect(placed.couponCode).toBeNull();
    expect(placed.discountCents).toBe(0);
    expect(placed.totalCents).toBe(view.totals.totalCents);
    expect(h.pay.listCharges()[0]?.amountCents).toBe(view.totals.totalCents);
  });

  test("deactivated / min-subtotal-no-longer-met coupons fail the order with their typed codes (pinned)", async () => {
    const h = setup();
    addCoupon(h.db, "QAOFF", { value: 100 });
    add(h, S1, TOTE, 1);
    okv(h.carts.applyCoupon(S1, "QAOFF", NOW));
    h.db.run("UPDATE coupons SET is_active = 0 WHERE code = 'QAOFF'");
    expect(errv(await h.svc.placeOrderV2(input(S1))).code).toBe("COUPON_INVALID");

    addCoupon(h.db, "QAMIN", { value: 100, min: 3000 });
    add(h, S2, TOTE, 2);
    okv(h.carts.applyCoupon(S2, "QAMIN", NOW));
    h.db.run("UPDATE products SET price_cents = 1000 WHERE id = ?", [TOTE]);
    const e = errv(await h.svc.placeOrderV2(input(S2)));
    expect(e.code).toBe("COUPON_MIN_SUBTOTAL");
    expect(e.details?.shortfallCents).toBe(1000);
    expect(h.pay.listCharges()).toEqual([]);
    expect(orderRows(h.db, [S1, S2])).toBe(0);
  });

  test("declined payment does not consume the coupon (rows, used_count) and the same owner can then succeed", async () => {
    const h = setup();
    addCoupon(h.db, "QADECL", { maxUses: 1 });
    add(h, S1, TOTE, 1);
    okv(h.carts.applyCoupon(S1, "QADECL", NOW));
    const e = errv(await h.svc.placeOrderV2(input(S1, { card: card(MOCK_CARDS.declined) })));
    expect(e.code).toBe("PAYMENT_FAILED");
    expect(redemptionRows(h.db, "QADECL")).toEqual([]);
    expect(usedCount(h.db, "QADECL")).toBe(0);
    expect(stock(h.db, TOTE)).toBe(42);
    const ok2 = okv(await h.svc.placeOrderV2(input(S1)));
    expect(ok2.couponCode).toBe("QADECL");
    expect(usedCount(h.db, "QADECL")).toBe(1);
  });

  test("shipping method invalidated between view and submit -> INVALID_INPUT details.field shippingMethodId, nothing charged/reserved", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    okv(h.carts.selectShippingMethod(S1, "express"));
    h.db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    const e = errv(await h.svc.placeOrderV2(input(S1)));
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.details?.field).toBe("shippingMethodId");
    expect(h.pay.listCharges()).toEqual([]);
    expect(stock(h.db, TOTE)).toBe(42);
    for (const bad of ["nope", "", "x".repeat(10_000), 42, { id: "standard" }] as unknown[]) {
      const r = errv(await h.svc.placeOrderV2(input(S1, { shippingMethodId: bad as string })));
      expect([r.code, r.details?.field]).toEqual(["INVALID_INPUT", "shippingMethodId"]);
    }
  });

  // D-T55-2 ---------------------------------------------------------------
  async function staleShippingScenario() {
    const h = setup();
    add(h, S1, TOTE, 1);
    okv(h.carts.selectShippingMethod(S1, "express"));
    h.db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    const first = await h.svc.placeOrderV2(input(S1));
    const view = okv(h.carts.getCartView(S1, NOW));
    const second = await h.svc.placeOrderV2(input(S1));
    return { first, view, second };
  }

  test("evidence D-T55-2 (fixed): the first placement fails INVALID_INPUT; the next cart view clears the stale method with a one-time notice and shows the cheapest", async () => {
    const { first, view, second } = await staleShippingScenario();
    expect(errv(first).code).toBe("INVALID_INPUT");
    expect(view.shipping?.method.id).toBe("standard");
    expect(view.couponNotice).toBeNull();
    expect(view.shippingNotice).toBe(SHIPPING_METHOD_DROPPED_NOTICE);
    expect(view.totals.totalCents).toBe(1999 + 499);
    expect(okv(second).totalCents).toBe(1999 + 499);
  });

  test("DEFECT D-T55-2 (fixed): cart view and placement agree after a stored shipping method is deactivated", async () => {
    const { view, second } = await staleShippingScenario();
    // Expected: either the view flags/clears the stale selection, or placement uses what the view shows.
    expect(okv(second).totalCents).toBe(view.totals.totalCents);
  });
});

// ---------------------------------------------------------------------------
// 3. Delivery note (AC5)
// ---------------------------------------------------------------------------

describe("QA T55 AC5: delivery note capped at 200, cleaned, stored as text", () => {
  test("200 chars accepted; 201 -> TOO_LONG field deliveryNote, no charge; markup stored verbatim as text; control chars/whitespace cleaned", async () => {
    const h = setup();
    const exact = "n".repeat(MAX_DELIVERY_NOTE_LENGTH);
    expect((await place(h, S1, PIN, 1, { deliveryNote: exact })).deliveryNote).toBe(exact);

    add(h, S1, PIN, 1);
    const e = errv(await h.svc.placeOrderV2(input(S1, { deliveryNote: "n".repeat(MAX_DELIVERY_NOTE_LENGTH + 1) })));
    expect([e.code, e.details?.field]).toEqual(["TOO_LONG", "deliveryNote"]);
    const huge = errv(await h.svc.placeOrderV2(input(S1, { deliveryNote: "x".repeat(1_000_000) })));
    expect(huge.code).toBe("TOO_LONG");
    expect(h.pay.listCharges().length).toBe(1);

    const markup = `<img src=x onerror="alert(1)"> & 'quotes'`;
    const v = okv(await h.svc.placeOrderV2(input(S1, { deliveryNote: markup })));
    expect(v.deliveryNote).toBe(markup);
    const raw = h.db.query<{ delivery_note: string; t: string }, [string]>("SELECT delivery_note, typeof(delivery_note) AS t FROM orders WHERE id = ?").get(v.id);
    expect(raw).toEqual({ delivery_note: markup, t: "text" });

    add(h, S1, PIN, 1);
    const dirty = okv(await h.svc.placeOrderV2(input(S1, { deliveryNote: "  Leave\u0000 at\u0007\tthe ‮back\n\ndoor  " })));
    expect(dirty.deliveryNote).not.toMatch(/[\p{Cc}‮]/u);
    expect(dirty.deliveryNote).not.toMatch(/\s{2,}|^\s|\s$/);
    expect(dirty.deliveryNote).toContain("Leave");
    expect(dirty.deliveryNote).toContain("door");

    add(h, S1, PIN, 1);
    expect(okv(await h.svc.placeOrderV2(input(S1, { deliveryNote: " \t\n " }))).deliveryNote).toBeNull();
    add(h, S1, PIN, 1);
    const typed = errv(await h.svc.placeOrderV2(input(S1, { deliveryNote: { toString: () => "hi" } })));
    expect([typed.code, typed.details?.field]).toEqual(["INVALID_INPUT", "deliveryNote"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Snapshots (AC8)
// ---------------------------------------------------------------------------

describe("QA T55 AC8: snapshots survive product edits, unpublish and deletion", () => {
  test("name/price/slug/image snapshot at placement; edits, unpublishing and deletion change neither the view nor totals; history query uses the snapshot name", async () => {
    const h = setup();
    add(h, S1, PIN, 3);
    const view = await place(h, S1, TOTE, 2);
    const tote = view.items.find((i) => i.productId === TOTE);
    expect(tote).toMatchObject({ name: "Canvas Tote Bag", unitPriceCents: 1999, quantity: 2, productSlug: "canvas-tote-bag" });
    expect(typeof tote?.imageUrl).toBe("string");
    const frozen = { items: view.items, sub: view.subtotalCents, total: view.totalCents, disc: view.discountCents, ship: view.shippingCents };
    const snap = () => {
      const v = h.svc.getOrderView(view.id, S1, NOW + MIN);
      return { items: v?.items, sub: v?.subtotalCents, total: v?.totalCents, disc: v?.discountCents, ship: v?.shippingCents };
    };

    h.db.run("UPDATE products SET name = 'Zebra Sack', price_cents = 7, slug = 'zebra-sack', image_url = '/zebra.svg' WHERE id = ?", [TOTE]);
    expect(snap()).toEqual(frozen);
    h.db.run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    expect(snap()).toEqual(frozen);
    h.db.run("DELETE FROM products WHERE id = ?", [TOTE]);
    expect(snap()).toEqual(frozen);
    // Totals are reproducible from the snapshot lines alone.
    const fromLines = view.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
    expect(fromLines).toBe(view.subtotalCents);
    expect(view.totalCents).toBe(view.subtotalCents - view.discountCents + view.shippingCents);

    expect(h.svc.listOrders(S1, { query: "tote bag", range: "all" }, NOW + MIN).total).toBe(1);
    expect(h.svc.listOrders(S1, { query: "zebra", range: "all" }, NOW + MIN).total).toBe(0);
    expect(h.svc.listOrders(S1, { query: "tote-bag", range: "all" }, NOW + MIN).total).toBe(0); // slug, not name
    expect(h.svc.listOrders(S1, { query: "%", range: "all" }, NOW + MIN).total).toBe(0);
    expect(h.svc.listOrders(S1, { query: "_", range: "all" }, NOW + MIN).total).toBe(0);
  });

  test("shipping method name and delivery window are snapshots (method renamed, retimed, deactivated)", async () => {
    const h = setup();
    const v = await place(h, S1, TOTE, 1, { shippingMethodId: "next_day" });
    h.db.run("UPDATE shipping_methods SET name = 'Snail', min_days = 30, max_days = 40, price_cents = 1, is_active = 0 WHERE id = 'next_day'");
    const after = h.svc.getOrderView(v.id, S1, NOW + MIN);
    expect(after?.shippingMethodName).toBe(v.shippingMethodName);
    expect(after?.shippingCents).toBe(v.shippingCents);
    expect(after?.estimatedDelivery).toEqual(v.estimatedDelivery);
  });
});

// ---------------------------------------------------------------------------
// 5. Events (AC9)
// ---------------------------------------------------------------------------

describe("QA T55 AC9: order events written once, in order, no PII", () => {
  test("placed -> processing event exactly once (replays and many reads add none); full sequence after delivery; stable timeline", async () => {
    const h = setup();
    const placedKey = key();
    const v = await place(h, S1, TOTE, 1, { idempotencyKey: placedKey });
    expect(eventRows(h.db, v.id).map((e) => e.status)).toEqual(["processing"]);
    okv(await h.svc.placeOrderV2({ ...input(S1), idempotencyKey: placedKey }));
    for (let i = 0; i < 10; i++) h.svc.getOrderView(v.id, S1, NOW + i * MIN);
    expect(eventRows(h.db, v.id).map((e) => e.status)).toEqual(["processing"]);

    const late = NOW + 20 * DAY;
    const a = h.svc.getOrderView(v.id, S1, late);
    const b = h.svc.getOrderView(v.id, S1, late);
    const c = h.svc.listOrders(S1, { range: "all" }, late).items[0];
    expect(a?.timeline).toEqual(b?.timeline ?? []);
    expect(c?.timeline).toEqual(a?.timeline ?? []);
    expect(a?.events).toEqual(b?.events ?? []);
    const rows = eventRows(h.db, v.id);
    expect(rows.map((e) => e.status)).toEqual([...FULFILLMENT_SEQUENCE]);
    const ats = rows.map((e) => e.at);
    expect([...ats].sort()).toEqual(ats);
    expect(new Set(rows.map((e) => e.status)).size).toBe(rows.length);
  });

  test("cancelled path: processing -> cancelled (note refund_pending); no later events ever appear; events carry no PII", async () => {
    const h = setup();
    const v = await place(h, S1, TOTE, 1, { deliveryNote: "ring the bell, Grace" });
    okv(h.svc.cancelOrder(v.id, S1, NOW + 5 * MIN));
    h.svc.getOrderView(v.id, S1, NOW + 30 * DAY);
    h.svc.listOrders(S1, { range: "all" }, NOW + 30 * DAY);
    const rows = eventRows(h.db, v.id);
    expect(rows.map((e) => [e.status, e.note])).toEqual([
      ["processing", null],
      ["cancelled", REFUND_PENDING_NOTE],
    ]);
    const json = JSON.stringify(rows);
    for (const pii of [ADDRESS.email, ADDRESS.fullName, ADDRESS.line1, ADDRESS.postalCode, "ring the bell", S1, "4242"]) {
      expect(json.includes(pii)).toBe(false);
    }
    const all = h.db.query<{ note: string | null }, []>("SELECT DISTINCT note FROM order_events").all().map((r) => r.note);
    for (const note of all) expect([null, REFUND_PENDING_NOTE]).toContain(note);
  });

  test("worker threads (separate connections), barrier start: 6 concurrent reads at mixed clocks never duplicate or reorder events", async () => {
    await withTempDb("qa-t55-events-race-", async (path) => {
      const db = createDatabase(path);
      const h = setup(db);
      try {
        for (let round = 0; round < 4; round++) {
          const s = crypto.randomUUID();
          const v = await place(h, s, PIN, 1);
          const clocks = [20 * DAY, 3 * HOUR, 20 * DAY, DAY + HOUR, 9 * DAY, 20 * DAY];
          const results = await runWorkers(
            clocks.map((offset, i) => ({ path, op: i % 3 === 2 ? ("list" as const) : ("view" as const), sessionId: s, orderId: v.id, now: NOW + offset })),
          );
          for (const r of results) expect(r.code).not.toMatch(/^THROW/);
          const rows = eventRows(db, v.id);
          expect(rows.map((e) => e.status)).toEqual([...FULFILLMENT_SEQUENCE]);
          const ats = rows.map((e) => e.at);
          expect([...ats].sort()).toEqual(ats);
          const persisted = db.query<{ f: string }, [string]>("SELECT fulfillment_status AS f FROM orders WHERE id = ?").get(v.id);
          expect(persisted?.f).toBe("delivered");
        }
      } finally {
        db.close();
      }
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 6. History (AC7) + detail
// ---------------------------------------------------------------------------

const HOSTILE_OWNERS: readonly unknown[] = [
  "",
  "nope",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(),
  "00000000-0000-0000-0000-000000000000",
  DELETED_OWNER_KEY,
  `${S1} `,
  "x".repeat(1_000_000),
  "' OR 1=1 --",
  null,
  undefined,
  42,
  {},
  [S1],
];

describe("QA T55 AC7: listOrders isolation, pagination, ranges, tabs, query", () => {
  test("25 orders: page size 10, newest first, no overlap, never another owner's order on any tab/range/page", async () => {
    const h = setup();
    const mine: string[] = [];
    for (let i = 0; i < 25; i++) {
      mine.push((await place(h, S1, PIN, 1, {}, NOW - (25 - i) * HOUR)).id);
      if (i % 5 === 0) await place(h, S2, PIN, 1, {}, NOW - (25 - i) * HOUR + 1);
    }
    add(h, S1, PIN, 1);
    errv(await h.svc.placeOrderV2(input(S1, { card: card(MOCK_CARDS.insufficientFunds) }), NOW));

    const at = NOW + MIN;
    const pages = [1, 2, 3].map((page) => h.svc.listOrders(S1, { page, range: "all" }, at));
    expect(pages.map((p) => p.items.length)).toEqual([ORDERS_PAGE_SIZE, ORDERS_PAGE_SIZE, 5]);
    expect(pages.map((p) => [p.total, p.pageCount])).toEqual([[25, 3], [25, 3], [25, 3]]);
    const ids = pages.flatMap((p) => p.items.map((o) => o.id));
    expect(ids).toEqual([...mine].reverse());
    expect(h.svc.listOrders(S1, { page: "2" as unknown as number, range: "all" }, at).items.map((o) => o.id)).toEqual(ids.slice(10, 20));

    const s2ids = new Set(h.svc.listOrders(S2, { range: "all" }, at).items.map((o) => o.id));
    expect(s2ids.size).toBe(5);
    for (const tab of ["all", "not_shipped", "cancelled"]) {
      for (const range of ["30d", "3m", "6m", "1y", "all"]) {
        for (let page = 1; page <= 3; page++) {
          for (const o of h.svc.listOrders(S1, { tab, range, page }, at).items) expect(s2ids.has(o.id)).toBe(false);
        }
      }
    }
    // payment_failed is never listed.
    expect(ids.length).toBe(25);
  });

  test("unknown / malformed / tombstone owner keys -> empty page, null view, ORDER_NOT_FOUND, [] buy-again; never throws", async () => {
    const h = setup();
    const v = await place(h, S1, PIN);
    const hexOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const hexOrder = await place(h, hexOwner, PIN);
    expect(h.svc.listOrders(hexOwner, { range: "all" }, NOW).total).toBe(1);
    h.db.run("INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city, region, postal_code, country, card_last4, idempotency_key, created_at) VALUES (?, ?, 'paid', 1, 1, 'USD', 'x', 'x@x.x', 'x', 'x', 'x', 'x', 'US', '4242', ?, ?)", [
      crypto.randomUUID(),
      DELETED_OWNER_KEY,
      key(),
      new Date(NOW).toISOString(),
    ]);
    for (const owner of HOSTILE_OWNERS) {
      const o = owner as string;
      const page = h.svc.listOrders(o, { range: "all" }, NOW);
      expect([page.items.length, page.total, page.page, page.pageCount]).toEqual([0, 0, 1, 0]);
      expect(h.svc.getOrderView(v.id, o, NOW)).toBeNull();
      expect(errv(h.svc.cancelOrder(v.id, o, NOW)).code).toBe("ORDER_NOT_FOUND");
      expect(h.svc.getBuyAgainLines(o)).toEqual([]);
      const placed = errv(await h.svc.placeOrderV2(input(o)));
      expect(placed.code).toBe("EMPTY_CART");
    }
    expect(h.svc.getOrderView(v.id, S1, NOW)?.id).toBe(v.id);
    expect(h.svc.getOrderView(hexOrder.id, hexOwner.toUpperCase(), NOW)).toBeNull();
  });

  test("one identical NOT_FOUND shape for foreign / unknown / malformed id / payment_failed / tombstone / bad owner", async () => {
    const h = setup();
    const mine = await place(h, S1, PIN);
    const foreign = await place(h, S2, PIN);
    add(h, S1, PIN, 1);
    const failed = errv(await h.svc.placeOrderV2(input(S1, { card: card(MOCK_CARDS.declined) })));
    const tomb = await place(h, S3, PIN);
    h.db.run("UPDATE orders SET session_id = ? WHERE id = ?", [DELETED_OWNER_KEY, tomb.id]);
    const cases = [
      h.svc.cancelOrder(foreign.id, S1, NOW),
      h.svc.cancelOrder(crypto.randomUUID(), S1, NOW),
      h.svc.cancelOrder(mine.id.toUpperCase(), S1, NOW),
      h.svc.cancelOrder("not-a-uuid", S1, NOW),
      h.svc.cancelOrder(String(failed.details?.orderId), S1, NOW),
      h.svc.cancelOrder(tomb.id, S3, NOW),
      h.svc.cancelOrder(mine.id, S2, NOW),
      h.svc.cancelOrder(mine.id, "bad", NOW),
    ].map(errv);
    for (const c of cases) expect(c).toEqual(cases[0] as AppError);
    expect(cases[0]?.code).toBe("ORDER_NOT_FOUND");
    expect(Object.keys(cases[0] ?? {}).sort()).toEqual(["code", "message"]);
    // Detail returns null for all of them (callers cannot tell them apart).
    for (const [id, owner] of [[foreign.id, S1], [String(failed.details?.orderId), S1], [tomb.id, S3], [mine.id, S2]] as const) {
      expect(h.svc.getOrderView(id, owner, NOW)).toBeNull();
    }
    // The foreign order was not touched by the attempts.
    expect(h.svc.getOrderView(foreign.id, S2, NOW)?.fulfillmentStatus).toBe("processing");
    expect(stock(h.db, PIN)).toBe(100 - 3);
  });

  test("ranges: inclusive boundaries for 30d / 3m / 6m / 1y incl. month-end clamping; all ignores time", async () => {
    const h = setup();
    const placedAt = Date.parse("2026-02-28T12:00:00.000Z");
    const v = await place(h, S1, PIN, 1, {}, placedAt);
    const may31 = Date.parse("2026-05-31T12:00:00.000Z"); // 3m cutoff clamps to Feb 28 12:00
    expect(rangeCutoff("3m", may31)).toBe(new Date(placedAt).toISOString());
    expect(h.svc.listOrders(S1, { range: "3m" }, may31).items.map((o) => o.id)).toEqual([v.id]);
    expect(h.svc.listOrders(S1, { range: "3m" }, may31 + 1).total).toBe(0); // cutoff Feb 28 12:00:00.001
    expect(h.svc.listOrders(S1, { range: "3m" }, Date.parse("2026-06-01T12:00:00.001Z")).total).toBe(0);
    expect(h.svc.listOrders(S1, { range: "1y" }, Date.parse("2027-02-28T12:00:00.000Z")).total).toBe(1);
    expect(h.svc.listOrders(S1, { range: "1y" }, Date.parse("2027-02-28T12:00:00.001Z")).total).toBe(0);
    expect(h.svc.listOrders(S1, { range: "6m" }, Date.parse("2026-08-28T12:00:00.000Z")).total).toBe(1);
    expect(h.svc.listOrders(S1, { range: "6m" }, Date.parse("2026-08-28T12:00:00.001Z")).total).toBe(0);
    expect(h.svc.listOrders(S1, { range: "30d" }, placedAt + 30 * DAY).total).toBe(1);
    expect(h.svc.listOrders(S1, { range: "30d" }, placedAt + 30 * DAY + 1).total).toBe(0);
    expect(h.svc.listOrders(S1, { range: "all" }, placedAt + 3650 * DAY).total).toBe(1);
  });

  test("tabs: not_shipped = processing|packed (excludes shipped, delivered, cancelled); cancelled lists only cancelled", async () => {
    const h = setup();
    const at = NOW + 20 * DAY;
    const delivered = await place(h, S1, PIN, 1, {}, NOW);
    const shipped = await place(h, S1, PIN, 1, {}, at - DAY - HOUR); // shipped 1 business day later
    const packed = await place(h, S1, PIN, 1, {}, at - 3 * HOUR);
    const processing = await place(h, S1, PIN, 1, {}, at - MIN);
    const cancelled = await place(h, S1, PIN, 1, {}, at - 2 * MIN);
    okv(h.svc.cancelOrder(cancelled.id, S1, at - MIN));
    const status = (id: string) => h.svc.getOrderView(id, S1, at)?.fulfillmentStatus;
    expect([status(delivered.id), status(packed.id), status(processing.id), status(cancelled.id)]).toEqual(["delivered", "packed", "processing", "cancelled"]);
    expect(["shipped", "out_for_delivery"]).toContain(status(shipped.id) ?? "");
    const ids = (tab: string) => new Set(h.svc.listOrders(S1, { tab, range: "all" }, at).items.map((o) => o.id));
    expect(ids("not_shipped")).toEqual(new Set([packed.id, processing.id]));
    expect(ids("cancelled")).toEqual(new Set([cancelled.id]));
    expect(ids("all").size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 7. Cancel (AC6)
// ---------------------------------------------------------------------------

describe("QA T55 AC6: cancelOrder", () => {
  test("within the window: cancelled, stock restored exactly once, coupon redemption released (owner may redeem again), refund_pending recorded", async () => {
    const h = setup();
    addCoupon(h.db, "QACAN", { maxUses: 1, kind: "fixed", value: 200 });
    add(h, S1, PIN, 4);
    okv(h.carts.applyCoupon(S1, "QACAN", NOW));
    const v = await place(h, S1, TOTE, 3);
    expect([stock(h.db, TOTE), stock(h.db, PIN), usedCount(h.db, "QACAN")]).toEqual([39, 96, 1]);
    const c = okv(h.svc.cancelOrder(v.id, S1, NOW + 10 * MIN));
    expect([c.fulfillmentStatus, c.cancellable, c.cancellableUntil]).toEqual(["cancelled", false, null]);
    expect(c.cancelledAt).toBe(new Date(NOW + 10 * MIN).toISOString());
    expect([stock(h.db, TOTE), stock(h.db, PIN)]).toEqual([42, 100]);
    expect(redemptionRows(h.db, "QACAN")).toEqual([]);
    expect(usedCount(h.db, "QACAN")).toBe(0);
    // Payment ledger untouched; refund is documented as refund_pending only.
    expect(h.pay.listCharges().length).toBe(1);
    expect(eventRows(h.db, v.id).at(-1)?.note).toBe(REFUND_PENDING_NOTE);

    // Double cancel: stable error, stock unchanged, no second event.
    const second = errv(h.svc.cancelOrder(v.id, S1, NOW + 11 * MIN));
    const third = errv(h.svc.cancelOrder(v.id, S1, NOW + 12 * MIN));
    expect(second).toEqual(third);
    expect(second.code).toBe("ORDER_NOT_CANCELLABLE");
    expect([stock(h.db, TOTE), stock(h.db, PIN)]).toEqual([42, 100]);
    expect(eventRows(h.db, v.id).filter((e) => e.status === "cancelled").length).toBe(1);

    // Owner can use the released coupon again.
    add(h, S1, TOTE, 1);
    okv(h.carts.applyCoupon(S1, "QACAN", NOW + 13 * MIN));
    expect(okv(await h.svc.placeOrderV2(input(S1), NOW + 13 * MIN)).couponCode).toBe("QACAN");
  });

  test("only while cancellable: window boundary, packed, shipped, delivered -> ORDER_NOT_CANCELLABLE with stock untouched", async () => {
    const h = setup();
    const edge = await place(h, S1, PIN);
    expect(okv(h.svc.cancelOrder(edge.id, S1, NOW + 30 * MIN)).fulfillmentStatus).toBe("cancelled");
    for (const offset of [30 * MIN + 1, 3 * HOUR, DAY + HOUR, 20 * DAY]) {
      const v = await place(h, S1, PIN);
      const before = stock(h.db, PIN);
      expect(errv(h.svc.cancelOrder(v.id, S1, NOW + offset)).code).toBe("ORDER_NOT_CANCELLABLE");
      expect(stock(h.db, PIN)).toBe(before);
      expect(h.svc.getOrderView(v.id, S1, NOW + offset)?.cancellable).toBe(false);
    }
  });

  test("in-process race of two cancels (Promise.all) -> exactly one succeeds, stock restored once", async () => {
    const h = setup();
    const v = await place(h, S1, TOTE, 2);
    const results = await Promise.all([0, 1].map(() => Promise.resolve().then(() => h.svc.cancelOrder(v.id, S1, NOW + MIN))));
    expect(results.filter((r) => r.ok).length).toBe(1);
    const loser = results.find((r) => !r.ok);
    if (loser === undefined) throw new Error("expected one losing cancel");
    expect(errv(loser).code).toBe("ORDER_NOT_CANCELLABLE");
    expect(stock(h.db, TOTE)).toBe(42);
  });

  test("worker threads on a temp file DB, barrier start: 3 concurrent cancels (8 rounds) -> exactly one succeeds; stock + coupon released once", async () => {
    await withTempDb("qa-t55-cancel-race-", async (path) => {
      const db = createDatabase(path);
      const h = setup(db);
      try {
        addCoupon(db, "QACR", { kind: "fixed", value: 100, maxUses: 1000 });
        for (let round = 0; round < 8; round++) {
          const s = crypto.randomUUID();
          add(h, s, PIN, 2);
          okv(h.carts.applyCoupon(s, "QACR", NOW));
          const before = stock(db, PIN);
          const used = usedCount(db, "QACR");
          const v = okv(await h.svc.placeOrderV2(input(s)));
          const results = await runWorkers([0, 1, 2].map(() => ({ path, op: "cancel" as const, sessionId: s, orderId: v.id, now: NOW + 2 * MIN })));
          for (const r of results) expect(r.code).not.toMatch(/^THROW/);
          expect(results.filter((r) => r.ok).length).toBe(1);
          for (const r of results.filter((x) => !x.ok)) {
            seenCodes.add(r.code);
            expect(r.code).toBe("ORDER_NOT_CANCELLABLE");
          }
          expect(stock(db, PIN)).toBe(before);
          expect(usedCount(db, "QACR")).toBe(used);
          expect(eventRows(db, v.id).filter((e) => e.status === "cancelled").length).toBe(1);
        }
      } finally {
        db.close();
      }
    });
  }, 60_000);

  test("foreign order -> ORDER_NOT_FOUND and the foreign order/stock are untouched", async () => {
    const h = setup();
    const v = await place(h, S2, TOTE);
    expect(errv(h.svc.cancelOrder(v.id, S1, NOW + MIN)).code).toBe("ORDER_NOT_FOUND");
    expect(stock(h.db, TOTE)).toBe(41);
    expect(h.svc.getOrderView(v.id, S2, NOW + MIN)?.fulfillmentStatus).toBe("processing");
  });

  // D-T55-1 -------------------------------------------------------------------
  /** User U redeemed QAMERGE on order B; as a guest G they redeemed it on order A; sign-in merges G into U. */
  async function mergedRedemptionScenario() {
    const h = setup();
    const U = S1;
    const G = S2;
    addCoupon(h.db, "QAMERGE", { kind: "fixed", value: 500 });
    add(h, U, TOTE, 1);
    okv(h.carts.applyCoupon(U, "QAMERGE", NOW));
    const orderB = okv(await h.svc.placeOrderV2(input(U), NOW));
    add(h, G, TOTE, 1);
    okv(h.carts.applyCoupon(G, "QAMERGE", NOW));
    const orderA = okv(await h.svc.placeOrderV2(input(G), NOW + MIN));
    const merge = createMergeRepository(h.db);
    merge.mergeOrders(G, U);
    merge.mergeCouponRedemptions(G, U); // U already redeemed -> G's row deleted (T120 rule)
    expect(redemptionRows(h.db, "QAMERGE")).toEqual([{ session_id: U, order_id: orderB.id }]);
    okv(h.svc.cancelOrder(orderA.id, U, NOW + 5 * MIN));
    add(h, U, TOTE, 1);
    const reapply = h.carts.applyCoupon(U, "QAMERGE", NOW + 6 * MIN);
    return { h, U, orderB, reapply };
  }

  // Evidence test for D-T55-1 retired by FIX-orders-redemption: it asserted the defective
  // behaviour (other order's redemption released, coupon reusable). The pin below is now a plain test.

  test("DEFECT D-T55-1 (fixed): cancelOrder must release only the redemption recorded for THIS order (order_id), not any row of the owner", async () => {
    const { h, U, orderB, reapply } = await mergedRedemptionScenario();
    expect(redemptionRows(h.db, "QAMERGE")).toEqual([{ session_id: U, order_id: orderB.id }]);
    expect(errv(reapply).code).toBe("COUPON_USED");
  });
});

// ---------------------------------------------------------------------------
// 8. Buy again (T55 getBuyAgainLines; per-line add statuses belong to T72)
// ---------------------------------------------------------------------------

describe("QA T55: getBuyAgainLines", () => {
  test("available only when published and in stock; unpublished/deleted -> product null; cancelled/payment_failed/foreign orders excluded; limit clamps", async () => {
    const h = setup();
    const nowIso = new Date(NOW).toISOString();
    h.db.run("UPDATE products SET stock = 1000");
    const published = h.db.query<{ id: string }, [string]>("SELECT id FROM products WHERE published_at <= ? ORDER BY id").all(nowIso).map((r) => r.id);
    expect(published.length).toBeGreaterThanOrEqual(55);
    // 55 distinct products over 11 orders of 5 lines.
    for (let o = 0; o < 11; o++) {
      for (const id of published.slice(o * 5, o * 5 + 5)) add(h, S1, id, 1);
      okv(await h.svc.placeOrderV2(input(S1), NOW - (11 - o) * HOUR));
    }
    const extra = published[55] ?? TOTE;
    const foreignOnly = published[56] ?? PIN;
    const cancelled = await place(h, S1, extra, 1, {}, NOW);
    okv(h.svc.cancelOrder(cancelled.id, S1, NOW + MIN));
    add(h, S1, foreignOnly, 1);
    errv(await h.svc.placeOrderV2(input(S1, { card: card(MOCK_CARDS.declined) })));
    h.carts.clear(S1);
    await place(h, S2, foreignOnly, 1);

    const lines = h.svc.getBuyAgainLines(S1);
    expect(lines.length).toBe(20);
    expect(h.svc.getBuyAgainLines(S1, 51).length).toBe(MAX_BUY_AGAIN_LIMIT);
    expect(h.svc.getBuyAgainLines(S1, 1000).length).toBe(MAX_BUY_AGAIN_LIMIT);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number]) {
      expect(h.svc.getBuyAgainLines(S1, bad).length).toBe(20);
    }
    const all = h.svc.getBuyAgainLines(S1, 50);
    const ids = all.map((l) => l.productId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(extra);
    expect(ids).not.toContain(foreignOnly);
    expect(ids.slice(0, 5).sort()).toEqual(published.slice(50, 55).sort()); // newest order first
    expect(all.every((l) => l.available && l.product !== null)).toBe(true);

    const [first, second, third] = ids;
    h.db.run("UPDATE products SET stock = 0 WHERE id = ?", [first ?? ""]);
    h.db.run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?", [second ?? ""]);
    h.db.run("DELETE FROM products WHERE id = ?", [third ?? ""]);
    const after = new Map(h.svc.getBuyAgainLines(S1, 50).map((l) => [l.productId, l]));
    expect([after.get(first ?? "")?.available, after.get(first ?? "")?.product === null]).toEqual([false, false]);
    expect([after.get(second ?? "")?.available, after.get(second ?? "")?.product]).toEqual([false, null]);
    expect([after.get(third ?? "")?.available, after.get(third ?? "")?.product]).toEqual([false, null]);
    expect(after.get(third ?? "")?.name.length).toBeGreaterThan(0); // snapshot name kept
    expectNoOwnerLeak([...after.values()], S1);
  });
});

// ---------------------------------------------------------------------------
// 9. Serialization / privacy (R-1)
// ---------------------------------------------------------------------------

describe("QA T55 R-1: no owner key / credentials in anything a client can receive", () => {
  test("placeOrderV2 view, getOrderView, listOrders page, cancel result and error details carry no owner key", async () => {
    const h = setup();
    addCoupon(h.db, "QAPRIV", { kind: "percent", value: 5 });
    add(h, S1, PIN, 1);
    okv(h.carts.applyCoupon(S1, "QAPRIV", NOW));
    const placed = await place(h, S1, TOTE, 1, { deliveryNote: "side gate" });
    expect("sessionId" in placed).toBe(false);
    expectNoOwnerLeak(placed, S1);
    expectNoOwnerLeak(h.svc.getOrderView(placed.id, S1, NOW + 20 * DAY), S1);
    expectNoOwnerLeak(h.svc.listOrders(S1, { range: "all" }, NOW + 20 * DAY), S1);
    const second = await place(h, S1, PIN, 1, {}, NOW + 21 * DAY);
    expectNoOwnerLeak(okv(h.svc.cancelOrder(second.id, S1, NOW + 21 * DAY + MIN)), S1);

    add(h, S1, PIN, 1);
    const declined = errv(await h.svc.placeOrderV2(input(S1, { card: card(MOCK_CARDS.declined) })));
    expectNoOwnerLeak(declined, S1);
    h.db.run("UPDATE products SET stock = 0 WHERE id = ?", [PIN]);
    const changed = errv(await h.svc.placeOrderV2(input(S1)));
    expect(changed.code).toBe("STOCK_CHANGED");
    expectNoOwnerLeak(changed, S1);
    // Only card_last4 survives.
    expect(placed.cardLast4).toBe("4242");
    expect(JSON.stringify(placed)).not.toContain('"987"');
  });
});

// ---------------------------------------------------------------------------
// 10. Error codes, storage failures, MVP regression
// ---------------------------------------------------------------------------

describe("QA T55: error codes and storage failures", () => {
  test("pinned codes per failure case (all members of ERROR_CODES)", async () => {
    const h = setup();
    const cases: [string, ErrorCode][] = [];
    const record = async (label: string, r: Promise<Result<unknown, AppError>> | Result<unknown, AppError>) => {
      cases.push([label, errv(await r).code as ErrorCode]);
    };
    await record("empty cart", h.svc.placeOrderV2(input(S1)));
    await record("bad key", h.svc.placeOrderV2(input(S1, { idempotencyKey: "" })));
    add(h, S1, PIN, 1);
    await record("bad address", h.svc.placeOrderV2(input(S1, { address: { ...ADDRESS, email: "nope" } })));
    await record("expired card", h.svc.placeOrderV2(input(S1, { card: { ...card(), expYear: 2020 } })));
    await record("declined", h.svc.placeOrderV2(input(S1, { card: card(MOCK_CARDS.declined) })));
    await record("unknown order", h.svc.cancelOrder(crypto.randomUUID(), S1, NOW));
    expect(cases).toEqual([
      ["empty cart", "EMPTY_CART"],
      ["bad key", "INVALID_INPUT"],
      ["bad address", "VALIDATION_FAILED"],
      ["expired card", "VALIDATION_FAILED"],
      ["declined", "PAYMENT_FAILED"],
      ["unknown order", "ORDER_NOT_FOUND"],
    ]);
  });

  test("evidence (observation, not promised by README): with a closed DB the read/cancel methods throw rather than return INTERNAL_ERROR", async () => {
    const h = setup();
    const v = await place(h, S1, PIN);
    h.db.close();
    expect(() => h.svc.listOrders(S1, {}, NOW)).toThrow();
    expect(() => h.svc.getOrderView(v.id, S1, NOW)).toThrow();
    expect(() => h.svc.cancelOrder(v.id, S1, NOW)).toThrow();
  });
});

afterAll(() => {
  // Every code observed in this file is a canonical ERROR_CODES member.
  const allowed = new Set<string>(ERROR_CODES);
  for (const code of seenCodes) {
    if (!allowed.has(code)) throw new Error(`non-canonical error code observed: ${code}`);
  }
});

describe("QA T55: isolation", () => {
  test("every error code observed so far is in ERROR_CODES", () => {
    const allowed = new Set<string>(ERROR_CODES);
    expect(seenCodes.size).toBeGreaterThan(8);
    for (const code of seenCodes) expect(allowed.has(code)).toBe(true);
  });

  test("./data contains only .gitkeep (no stray DB files from this suite)", () => {
    const dataDir = join(import.meta.dir, "../../../data");
    expect(readdirSync(dataDir).filter((n) => !n.startsWith("storefront.sqlite")).sort()).toEqual([".gitkeep"]); // dev DB allowed
  });
});
