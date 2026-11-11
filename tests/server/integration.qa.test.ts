/**
 * T26 QA integration and failure-path tests: CartService -> OrderService ->
 * MockPaymentProvider over a real migrated in-memory SQLite DB.
 *
 * Every scenario wires its own DB, services, provider and in-flight registry.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedProducts, SEED_PRODUCTS } from "@/server/db/seed";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { SqliteCartRepository } from "@/server/cart/cart-repository";
import { CartService } from "@/server/cart/cart-service";
import { SqliteOrderRepository } from "@/server/orders/order-repository";
import { OrderService, type PlaceOrderInput } from "@/server/orders/order-service";
import {
  createMockPaymentProvider,
  MOCK_CARDS,
  type MockPaymentProvider,
  type PaymentLogEvent,
} from "@/server/payments/mock-payment-provider";
import type { Result } from "@/lib/result";
import { ERROR_CODES, type ErrorCode, type Order, type PaymentFailureCode } from "@/lib/types";

const TOTE = "prod_canvas-tote-bag"; // 1999, 42
const PIN = "prod_enamel-pin-set"; // 50, 100
const DESK = "prod_walnut-desk"; // 125000, 3
const POUR = "prod_ceramic-pour-over"; // 3400, 0
const PRINT = "prod_limited-print-no-1"; // 18000, 1
const BEANIE = "prod_merino-beanie"; // 2800, 64

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const CVC = "0007";
const CVC_ALT = "0913";
const ADDRESS = {
  fullName: "Grace Hopper",
  email: "grace@example.com",
  line1: "1 Compiler Ct",
  city: "Arlington",
  region: "VA",
  postalCode: "22201",
  country: "US",
} as const;

function card(number: string = MOCK_CARDS.success, cvc: string = CVC) {
  return { number, expMonth: 1, expYear: 2031, cvc, nameOnCard: "Grace Hopper" };
}

interface World {
  readonly db: Database;
  readonly products: SqliteProductRepository;
  readonly carts: CartService;
  readonly orders: OrderService;
  readonly pay: MockPaymentProvider;
  readonly logs: PaymentLogEvent[];
}

function world(opts: { pay?: MockPaymentProvider; latencyMs?: number } = {}): World {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedProducts(db);
  const products = new SqliteProductRepository(db);
  const carts = new CartService({ db, carts: new SqliteCartRepository(db), products });
  const logs: PaymentLogEvent[] = [];
  const pay =
    opts.pay ?? createMockPaymentProvider({ latencyMs: opts.latencyMs ?? 0, now: () => NOW, logger: (e) => logs.push(e) });
  const orders = new OrderService({
    db,
    carts,
    products,
    orders: new SqliteOrderRepository(db, { now: () => NOW }),
    payments: pay,
    inFlight: new Map(),
    now: () => NOW,
  });
  return { db, products, carts, orders, pay, logs };
}

function checkout(w: World, session: string | null, key: unknown, over: Partial<PlaceOrderInput> = {}): Promise<Result<Order>> {
  return w.orders.placeOrder({ sessionId: session, address: ADDRESS, card: card(), idempotencyKey: key, ...over });
}

function must<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function code(r: Result<unknown>): ErrorCode | "OK" {
  return r.ok ? "OK" : r.error.code;
}

function stock(db: Database, id: string): number {
  return db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id)?.stock ?? -1;
}

function n(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
}

const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
function leaks(text: string, cards: readonly string[], cvcs: readonly string[], opts = { fieldNames: true, longDigits: true }): string[] {
  const s = text.replace(UUID_ANY, "<uuid>");
  const out: string[] = [];
  for (const c of cards) {
    const spaced = c.replace(/(\d{4})(?=\d)/g, "$1 ");
    if (s.includes(c) || s.includes(spaced)) out.push(`card:${c}`);
  }
  for (const v of cvcs) if (new RegExp(`(?<!\\d)${v}(?!\\d)`).test(s)) out.push(`cvc:${v}`);
  if (opts.longDigits) for (const m of s.match(/\d{9,}/g) ?? []) out.push(`digits:${m}`);
  if (opts.fieldNames) for (const f of ["number", "cvc", "expMonth", "expYear"]) if (s.includes(`"${f}"`)) out.push(`field:${f}`);
  return out;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Console capture: no module under test may write to the console.
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
let consoleCalls: unknown[][] = [];
let spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  consoleCalls = [];
  spies = CONSOLE_METHODS.map((m) =>
    spyOn(console, m).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    }),
  );
});
afterEach(() => {
  for (const s of spies) s.mockRestore();
});

// ---------------------------------------------------------------------------
// Full flows
// ---------------------------------------------------------------------------

describe("T26 flows", () => {
  test("browse -> add -> update -> remove -> checkout success", async () => {
    const w = world();
    const list = w.products.list();
    expect(list).toHaveLength(15);
    const tote = w.products.getBySlug("canvas-tote-bag");
    expect(tote?.id).toBe(TOTE);
    must(w.carts.addItem(S1, TOTE, 2));
    must(w.carts.addItem(S1, BEANIE, 1));
    must(w.carts.setQuantity(S1, TOTE, 3));
    must(w.carts.addItem(S1, PIN, 5));
    must(w.carts.removeItem(S1, PIN));
    const view = w.carts.getCart(S1);
    expect(view.items.map((i) => [i.productId, i.quantity])).toEqual([
      [TOTE, 3],
      [BEANIE, 1],
    ]);
    expect(view.subtotalCents).toBe(3 * 1999 + 2800);
    expect(view.canCheckout).toBe(true);

    const order = must(await checkout(w, S1, "flow-1"));
    expect(order.status).toBe("paid");
    expect(order.totalCents).toBe(view.subtotalCents);
    expect(order.items.map((i) => [i.productId, i.name, i.unitPriceCents, i.quantity])).toEqual([
      [TOTE, "Canvas Tote Bag", 1999, 3],
      [BEANIE, "Merino Beanie", 2800, 1],
    ]);
    expect(w.carts.getTotals(S1)).toEqual({ subtotalCents: 0, itemCount: 0 });
    expect(stock(w.db, TOTE)).toBe(39);
    expect(stock(w.db, BEANIE)).toBe(63);
    expect(stock(w.db, PIN)).toBe(100);
    expect(w.orders.getOrder(order.id, S1)).toEqual(order);
    expect(w.pay.listCharges()).toEqual([
      expect.objectContaining({ idempotencyKey: "flow-1", amountCents: order.totalCents, outcome: "success", last4: "4242" }),
    ]);
    expect(consoleCalls).toEqual([]);
  });

  test("decline, then retry with a new key and 4242 succeeds; old key still replays the decline", async () => {
    const w = world();
    must(w.carts.addItem(S1, DESK, 2));
    const declined = await checkout(w, S1, "try-1", { card: card(MOCK_CARDS.declined) });
    expect(code(declined)).toBe("PAYMENT_FAILED");
    expect(w.carts.getCart(S1).items).toHaveLength(1);
    expect(stock(w.db, DESK)).toBe(3);
    const order = must(await checkout(w, S1, "try-2"));
    expect(stock(w.db, DESK)).toBe(1);
    expect(w.carts.getCart(S1).items).toEqual([]);
    expect(w.pay.listCharges().map((c) => c.outcome)).toEqual(["DECLINED", "success"]);
    const statuses = w.db.query<{ status: string; idempotency_key: string }, []>("SELECT status, idempotency_key FROM orders ORDER BY rowid").all();
    expect(statuses).toEqual([
      { status: "payment_failed", idempotency_key: "try-1" },
      { status: "paid", idempotency_key: "try-2" },
    ]);
    const replay = await checkout(w, S1, "try-1");
    expect(replay).toEqual(declined);
    expect(w.pay.listCharges()).toHaveLength(2);
    expect(w.orders.getOrder(order.id, S1)?.status).toBe("paid");
  });

  test("insufficient stock discovered at checkout; shopper fixes quantity and succeeds", async () => {
    const w = world();
    must(w.carts.addItem(S1, DESK, 3));
    must(w.carts.addItem(S1, TOTE, 1));
    w.db.query("UPDATE products SET stock = 1 WHERE id = ?").run(DESK);
    const r = await checkout(w, S1, "k1");
    expect(r.ok ? null : r.error.details).toEqual({
      lines: [{ productId: DESK, name: "Walnut Standing Desk", requested: 3, available: 1 }],
    });
    expect(w.pay.listCharges()).toHaveLength(0);
    expect(n(w.db, "orders")).toBe(0);
    expect(w.carts.getCart(S1).items.map((i) => i.quantity)).toEqual([3, 1]);
    must(w.carts.setQuantity(S1, DESK, 1));
    // The same key is reusable: STOCK_CHANGED burned nothing.
    const o = must(await checkout(w, S1, "k1"));
    expect(o.totalCents).toBe(125000 + 1999);
    expect(stock(w.db, DESK)).toBe(0);
  });

  test("sold-out line at checkout; shopper removes it and checks out the rest", async () => {
    const w = world();
    must(w.carts.addItem(S1, PRINT, 1));
    must(w.carts.addItem(S1, PIN, 4));
    w.db.query("UPDATE products SET stock = 0 WHERE id = ?").run(PRINT);
    expect(w.carts.getCart(S1).canCheckout).toBe(false);
    expect(code(await checkout(w, S1, "a"))).toBe("STOCK_CHANGED");
    must(w.carts.removeItem(S1, PRINT));
    expect(must(await checkout(w, S1, "b")).totalCents).toBe(200);
  });

  test("cross-session isolation of carts and orders", async () => {
    const w = world();
    must(w.carts.addItem(S1, TOTE, 1));
    must(w.carts.addItem(S2, BEANIE, 2));
    const o1 = must(await checkout(w, S1, "s1"));
    expect(w.carts.getCart(S2).items.map((i) => [i.productId, i.quantity])).toEqual([[BEANIE, 2]]);
    expect(w.orders.getOrder(o1.id, S2)).toBeNull();
    expect(w.orders.getOrder(o1.id, S3)).toBeNull();
    const o2 = must(await checkout(w, S2, "s2"));
    expect(o2.items.map((i) => i.productId)).toEqual([BEANIE]);
    expect(w.orders.getOrder(o2.id, S1)).toBeNull();
    expect(w.orders.getOrder(o1.id, S1)?.sessionId).toBe(S1);
    expect(w.orders.getOrder(o2.id, S2)?.sessionId).toBe(S2);
    expect(code(await checkout(w, S3, "s3"))).toBe("EMPTY_CART");
    // S3 cannot steal S1's key either.
    expect(code(await checkout(w, S3, "s1"))).toBe("INVALID_INPUT");
  });

  test("20 iterations of full-flow last-unit race (3 sessions, 2ms latency) and duplicate-key race: zero anomalies", async () => {
    const anomalies: string[] = [];
    for (let i = 0; i < 20; i++) {
      const w = world({ latencyMs: 2 });
      for (const s of [S1, S2, S3]) must(w.carts.addItem(s, PRINT, 1));
      const rs = await Promise.all([S1, S2, S3].map((s) => checkout(w, s, `r-${s}`)));
      const codes = rs.map(code).sort();
      if (codes.join() !== "OK,STOCK_CHANGED,STOCK_CHANGED") anomalies.push(`#${i} race ${codes.join()}`);
      if (stock(w.db, PRINT) !== 0) anomalies.push(`#${i} stock ${stock(w.db, PRINT)}`);
      if (w.pay.listCharges().length !== 1) anomalies.push(`#${i} race charges`);

      const w2 = world({ latencyMs: 2 });
      must(w2.carts.addItem(S1, DESK, 3));
      const dup = await Promise.all(Array.from({ length: 6 }, () => checkout(w2, S1, "dup")));
      const ids = new Set(dup.map((r) => (r.ok ? r.value.id : r.error.code)));
      if (ids.size !== 1 || !dup[0]?.ok) anomalies.push(`#${i} dup ids ${[...ids].join()}`);
      if (w2.pay.listCharges().length !== 1) anomalies.push(`#${i} dup charges`);
      if (stock(w2.db, DESK) !== 0) anomalies.push(`#${i} dup stock`);
      if (n(w2.db, "orders") !== 1) anomalies.push(`#${i} dup orders`);
    }
    expect(anomalies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Error-code coverage matrix
// ---------------------------------------------------------------------------

/** Codes that T09/T10/T11 cannot currently return (see report). */
const UNREACHABLE: readonly ErrorCode[] = [
  "ORDER_NOT_FOUND", // getOrder returns null by design; no API returns this code
];

/**
 * Reachable only via Phase 2 services (reviews, Q&A, lists, coupons, order
 * lifecycle, rate limiting, accounts, text guard), covered by their own
 * tests. The MVP flow exercised here must NOT produce them.
 */
const PHASE2_ONLY: readonly ErrorCode[] = [
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
  "INVALID_CREDENTIALS",
  "EMAIL_TAKEN",
  "UNAUTHENTICATED",
  "ACCOUNT_LOCKED",
  "INTERNAL_ERROR",
];

describe("T26 error-code coverage matrix", () => {
  test("every reachable ErrorCode and every PaymentFailureCode is produced at least once", async () => {
    const seen = new Map<string, string>();
    const record = (label: string, r: Result<unknown>) => {
      if (!r.ok) seen.set(r.error.code, seen.get(r.error.code) ?? label);
    };
    const w = world();
    // T09
    record("cart.addItem unknown product", w.carts.addItem(S1, "prod_nope", 1));
    record("cart.addItem stock 0", w.carts.addItem(S1, POUR, 1));
    record("cart.addItem above stock", w.carts.addItem(S1, DESK, 4));
    record("cart.addItem qty 0", w.carts.addItem(S1, TOTE, 0));
    record("cart.addItem null qty (D1 regression)", w.carts.addItem(S1, TOTE, null as unknown as number));
    record("cart.addItem invalid session", w.carts.addItem("bad", TOTE, 1));
    // T11
    record("placeOrder empty cart", await checkout(w, S1, "e"));
    record("placeOrder bad key", await checkout(w, S1, ""));
    must(w.carts.addItem(S1, TOTE, 2));
    record("placeOrder invalid address", await checkout(w, S1, "v", { address: {} }));
    w.db.query("UPDATE products SET stock = 1 WHERE id = ?").run(TOTE);
    record("placeOrder stock changed", await checkout(w, S1, "s"));
    w.db.query("UPDATE products SET stock = 42 WHERE id = ?").run(TOTE);
    const failureCodes = new Set<PaymentFailureCode>();
    for (const [i, num] of [MOCK_CARDS.declined, MOCK_CARDS.insufficientFunds, MOCK_CARDS.processingError].entries()) {
      const r = await checkout(w, S1, `p${i}`, { card: card(num) });
      record("placeOrder decline", r);
      if (!r.ok) failureCodes.add((r.error.details as { failureCode: PaymentFailureCode }).failureCode);
    }
    // INVALID_AMOUNT: only reachable with an all-zero-price cart (see questionable list).
    const z = world();
    must(z.carts.addItem(S1, TOTE, 1));
    z.db.query("UPDATE products SET price_cents = 0 WHERE id = ?").run(TOTE);
    const zr = await checkout(z, S1, "zero");
    if (!zr.ok) failureCodes.add((zr.error.details as { failureCode: PaymentFailureCode }).failureCode);
    // T10 direct
    const direct = await createMockPaymentProvider().charge({
      amountCents: 0,
      currency: "USD",
      card: { ...card(), last4: "4242" },
      idempotencyKey: "x",
    });
    if (!direct.ok) failureCodes.add(direct.error.code);

    // MONEY_OVERFLOW (D-T11-1 fixed): cart mutation and checkout both report it.
    const o = world();
    must(o.carts.addItem(S1, TOTE, 2));
    o.db.query("UPDATE products SET price_cents = ? WHERE id = ?").run(Number.MAX_SAFE_INTEGER, TOTE);
    record("cart.addItem on overflowing cart", o.carts.addItem(S1, BEANIE, 1));
    record("placeOrder overflowing cart", await checkout(o, S1, "ovf"));

    // Every allow-listed code must exist, so the list cannot hide typos.
    for (const c of PHASE2_ONLY) expect(ERROR_CODES).toContain(c);
    const reachable = ERROR_CODES.filter((c) => !UNREACHABLE.includes(c) && !PHASE2_ONLY.includes(c));
    expect([...seen.keys()].sort()).toEqual([...reachable].sort());
    expect([...failureCodes].sort()).toEqual(["DECLINED", "INSUFFICIENT_FUNDS", "INVALID_AMOUNT", "PROCESSING_ERROR"]);
  });

  test("unreachable ORDER_NOT_FOUND -> getOrder null; overflowing cart -> MONEY_OVERFLOW result through the full flow", async () => {
    const w = world();
    expect(w.orders.getOrder("00000000-0000-4000-8000-000000000000", S1)).toBeNull();
    must(w.carts.addItem(S1, TOTE, 2));
    w.db.query("UPDATE products SET price_cents = ? WHERE id = ?").run(Number.MAX_SAFE_INTEGER, TOTE);
    expect(await checkout(w, S1, "k")).toEqual({
      ok: false,
      error: { code: "MONEY_OVERFLOW", message: "This order total is too large to process." },
    });
    expect(stock(w.db, TOTE)).toBe(42);
    expect(w.carts.addItem(S1, PIN, 1)).toEqual(expect.objectContaining({ ok: false, error: expect.objectContaining({ code: "MONEY_OVERFLOW" }) }));
    expect(n(w.db, "cart_items")).toBe(1);
    expect(n(w.db, "orders")).toBe(0);
    expect(w.pay.listCharges()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Totals property test
// ---------------------------------------------------------------------------

describe("T26 totals property test", () => {
  test("250 seeded random carts: integer exact totals, subtotal = sum(unit x qty), charge = order total", async () => {
    const rand = rng(0x5eed_2611);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const pay = createMockPaymentProvider({ now: () => NOW });
    const orders: Order[] = [];
    const sellable = SEED_PRODUCTS.filter((p) => p.stock > 0).map((p) => p.id);
    const MAX_UNIT = Math.floor(Number.MAX_SAFE_INTEGER / (8 * 99));
    const failures: string[] = [];
    for (let i = 0; i < 250; i++) {
      const w = world({ pay });
      const pool = [...sellable];
      const lines = int(1, 8);
      const expected: { id: string; unit: number; qty: number }[] = [];
      for (let l = 0; l < lines; l++) {
        const id = pool.splice(int(0, pool.length - 1), 1)[0] as string;
        const mode = rand();
        if (mode >= 0.35) {
          const unit = mode < 0.8 ? int(1, 10_000_000) : int(1, MAX_UNIT);
          w.db.query("UPDATE products SET price_cents = ? WHERE id = ?").run(unit, id);
        }
        const qty = int(1, 99);
        if (stock(w.db, id) < qty) w.db.query("UPDATE products SET stock = ? WHERE id = ?").run(qty, id);
        if (qty > 1 && rand() < 0.4) {
          must(w.carts.addItem(S1, id, 1));
          must(w.carts.setQuantity(S1, id, qty));
        } else {
          must(w.carts.addItem(S1, id, qty));
        }
        const unit = w.products.getById(id)?.priceCents ?? -1;
        expected.push({ id, unit, qty });
      }
      const exact = expected.reduce((s, e) => s + BigInt(e.unit) * BigInt(e.qty), 0n);
      const view = w.carts.getCart(S1);
      const r = await checkout(w, S1, `prop-${i}`);
      if (!r.ok) {
        failures.push(`#${i} ${r.error.code}`);
        continue;
      }
      const o = r.value;
      orders.push(o);
      const checks: [string, boolean][] = [
        ["safe subtotal", Number.isSafeInteger(o.subtotalCents)],
        ["safe total", Number.isSafeInteger(o.totalCents)],
        ["safe units", o.items.every((it) => Number.isSafeInteger(it.unitPriceCents) && Number.isSafeInteger(it.quantity))],
        ["exact subtotal", BigInt(o.subtotalCents) === exact],
        ["sum items", o.subtotalCents === o.items.reduce((s, it) => s + it.unitPriceCents * it.quantity, 0)],
        ["total = subtotal", o.totalCents === o.subtotalCents && o.shippingCents === 0],
        ["view = order", view.subtotalCents === o.subtotalCents],
        ["items match", JSON.stringify(o.items.map((it) => [it.productId, it.unitPriceCents, it.quantity])) === JSON.stringify(expected.map((e) => [e.id, e.unit, e.qty]))],
      ];
      for (const [name, okay] of checks) if (!okay) failures.push(`#${i} ${name}`);
    }
    const charges = pay.listCharges();
    expect(charges).toHaveLength(orders.length);
    orders.forEach((o, i) => {
      if (charges[i]?.amountCents !== o.totalCents || charges[i]?.idempotencyKey !== o.idempotencyKey) failures.push(`charge ${i}`);
    });
    expect(failures).toEqual([]);
    expect(orders).toHaveLength(250);
    // Card scan without the 9+ digit rule (random totals legitimately exceed 9 digits).
    expect(leaks(JSON.stringify({ orders, charges }), [MOCK_CARDS.success], [CVC], { fieldNames: true, longDigits: false })).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Leak scan
// ---------------------------------------------------------------------------

describe("T26 leak scan", () => {
  test("orders, order_items, all results, listCharges and provider logs contain no card number or CVC after success and failure", async () => {
    const w = world();
    const results: Result<Order>[] = [];
    const validationResults: Result<Order>[] = [];
    must(w.carts.addItem(S1, TOTE, 1));
    must(w.carts.addItem(S1, DESK, 1));
    results.push(await checkout(w, S1, "ok-1", { card: card("4242 4242 4242 4242", CVC) }));
    results.push(await checkout(w, S1, "ok-1", { card: card(MOCK_CARDS.success, CVC_ALT) })); // replay
    const fails = [MOCK_CARDS.declined, MOCK_CARDS.insufficientFunds, MOCK_CARDS.processingError];
    for (const [i, num] of fails.entries()) {
      must(w.carts.addItem(S2, BEANIE, 1 + i));
      results.push(await checkout(w, S2, `f-${i}`, { card: card(num, i % 2 ? CVC : CVC_ALT) }));
      results.push(await checkout(w, S2, `f-${i}`, { card: card(num, CVC) })); // replay
    }
    results.push(await checkout(w, S2, "f-ok", { card: card("4000-0000-0000-0077", CVC) })); // other Luhn-valid: success
    validationResults.push(await checkout(w, S3, "v0", { card: card("4242424242424241", CVC) }));
    must(w.carts.addItem(S3, PIN, 1));
    validationResults.push(await checkout(w, S3, "v1", { card: { ...card(), cvc: "12345" } }));
    validationResults.push(await checkout(w, S3, "v2", { card: card("4242424242424241", CVC) }));
    expect(results.map(code)).toEqual(["OK", "OK", "PAYMENT_FAILED", "PAYMENT_FAILED", "PAYMENT_FAILED", "PAYMENT_FAILED", "PAYMENT_FAILED", "PAYMENT_FAILED", "OK"]);
    expect(validationResults.map(code)).toEqual(["EMPTY_CART", "VALIDATION_FAILED", "VALIDATION_FAILED"]);

    const cards = [...Object.values(MOCK_CARDS), "4000000000000077", "4242424242424241"];
    const cvcs = [CVC, CVC_ALT, "12345"];
    const rows = {
      orders: w.db.query("SELECT * FROM orders").all(),
      order_items: w.db.query("SELECT * FROM order_items").all(),
    };
    const sources: Record<string, string> = {
      rows: JSON.stringify(rows),
      results: JSON.stringify(results),
      charges: JSON.stringify(w.pay.listCharges()),
      logs: JSON.stringify(w.logs),
      console: JSON.stringify(consoleCalls),
      inspect: Bun.inspect(w.orders),
    };
    const found: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(sources)) {
      const hits = leaks(v, cards, cvcs);
      if (hits.length > 0) found[k] = hits;
    }
    // VALIDATION_FAILED names card fields as keys (legitimate); check values only.
    const vHits = leaks(JSON.stringify(validationResults), cards, cvcs, { fieldNames: false, longDigits: true });
    if (vHits.length > 0) found.validation = vHits;
    expect(found).toEqual({});
    expect(w.logs.length).toBeGreaterThan(0);
    expect(consoleCalls).toEqual([]);
    expect((rows.orders as { card_last4: string }[]).map((r) => r.card_last4).sort()).toEqual(["0002", "0077", "0119", "4242", "9995"]);
  });
});

describe("T26 leak scanner negative control", () => {
  test("the scanner flags planted card numbers, spaced numbers, CVCs, long digit runs and field names, and ignores UUIDs", () => {
    expect(leaks(`{"x":"${MOCK_CARDS.success}"}`, [MOCK_CARDS.success], [])).toEqual(["card:4242424242424242", "digits:4242424242424242"]);
    expect(leaks(`"4242 4242 4242 4242"`, [MOCK_CARDS.success], [])).toEqual(["card:4242424242424242"]);
    expect(leaks(`{"c":"${CVC}"}`, [], [CVC])).toEqual([`cvc:${CVC}`]);
    expect(leaks(`{"cvc":1,"number":2,"expMonth":3,"expYear":4}`, [], [])).toHaveLength(4);
    expect(leaks(`"123456789"`, [], [])).toEqual(["digits:123456789"]);
    expect(leaks(`"12345678-1234-4123-8123-123456789012" 375000`, [], [CVC])).toEqual([]);
  });
});
