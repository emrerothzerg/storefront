/**
 * QA adversarial tests for T11 (order repository + service).
 * src/server/orders/order-repository.ts, src/server/orders/order-service.ts
 *
 * Every test wires its own `createDatabase(":memory:")` + `runMigrations` +
 * `seedProducts`, a fresh `MockPaymentProvider` (unless a stub is injected) and
 * a fresh `InFlightRegistry`. Persistence is asserted by querying the tables
 * directly, never by trusting the returned value alone.
 *
 * Defect reproductions use `test.failing` (they pass while the defect exists).
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedProducts } from "@/server/db/seed";
import { SqliteProductRepository, type ProductRepository } from "@/server/catalog/product-repository";
import { SqliteCartRepository } from "@/server/cart/cart-repository";
import { CartService } from "@/server/cart/cart-service";
import {
  DuplicateIdempotencyKeyError,
  SqliteOrderRepository,
  type OrderRepository,
} from "@/server/orders/order-repository";
import {
  isIdempotencyKey,
  isOrderId,
  OrderService,
  type InFlightRegistry,
  type PlaceOrderInput,
} from "@/server/orders/order-service";
import {
  createMockPaymentProvider,
  MOCK_CARDS,
  PAYMENT_FAILURE_MESSAGES,
  type MockPaymentProvider,
} from "@/server/payments/mock-payment-provider";
import type { PaymentProvider, PaymentResult } from "@/server/payments/payment-provider";
import type { Result } from "@/lib/result";
import type { ErrorCode, Order, PaymentFailureCode } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const PIN = "prod_enamel-pin-set"; // 50, stock 100
const DESK = "prod_walnut-desk"; // 125000, stock 3
const PRINT = "prod_limited-print-no-1"; // 18000, stock 1
const BEANIE = "prod_merino-beanie"; // 2800, stock 64

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";

const NOW = new Date("2026-11-06T12:00:00.000Z");
/** CVCs start with 0 so they can never appear inside a JSON number. */
const CVC = "0007";
const CVC_ALT = "0913";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "12 Analytical Way",
  city: "London",
  region: "Greater London",
  postalCode: "N1 9GU",
  country: "gb",
} as const;

function card(number: string = MOCK_CARDS.success, cvc: string = CVC): Record<string, unknown> {
  return { number, expMonth: 12, expYear: 2030, cvc, nameOnCard: "Ada Lovelace" };
}

interface Harness {
  readonly db: Database;
  readonly carts: CartService;
  readonly products: SqliteProductRepository;
  readonly orders: SqliteOrderRepository;
  readonly pay: MockPaymentProvider;
  readonly inFlight: InFlightRegistry;
  readonly svc: OrderService;
}

interface SetupOptions {
  readonly payments?: PaymentProvider;
  readonly products?: (real: SqliteProductRepository, db: Database) => ProductRepository;
  readonly orders?: (real: SqliteOrderRepository) => OrderRepository;
  readonly latencyMs?: number;
  readonly db?: Database;
}

function setup(opts: SetupOptions = {}): Harness {
  const db = opts.db ?? createDatabase(":memory:");
  if (opts.db === undefined) {
    runMigrations(db);
    seedProducts(db);
  }
  const products = new SqliteProductRepository(db);
  const carts = new CartService({ db, carts: new SqliteCartRepository(db), products });
  const orders = new SqliteOrderRepository(db, { now: () => NOW });
  const pay = createMockPaymentProvider({ latencyMs: opts.latencyMs ?? 0, now: () => NOW });
  const inFlight: InFlightRegistry = new Map();
  const svc = new OrderService({
    db,
    carts,
    products: opts.products ? opts.products(products, db) : products,
    orders: opts.orders ? opts.orders(orders) : orders,
    payments: opts.payments ?? pay,
    inFlight,
    now: () => NOW,
  });
  return { db, carts, products, orders, pay, inFlight, svc };
}

function add(h: Harness, session: string, productId: string, qty: number): void {
  const r = h.carts.addItem(session, productId, qty);
  if (!r.ok) throw new Error(`fixture addItem failed: ${r.error.code}`);
}

function input(session: string | null, key: unknown, overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput {
  return { sessionId: session, address: ADDRESS, card: card(), idempotencyKey: key, ...overrides };
}

function stock(db: Database, id: string): number {
  const row = db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id);
  if (row === null) throw new Error(`no product ${id}`);
  return row.stock;
}

function stocks(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.query<{ id: string; stock: number }, []>("SELECT id, stock FROM products ORDER BY id").all()) {
    out[r.id] = r.stock;
  }
  return out;
}

function cartRows(db: Database): unknown[] {
  return [
    ...db.query("SELECT * FROM carts ORDER BY session_id").all(),
    ...db.query("SELECT * FROM cart_items ORDER BY cart_session_id, product_id").all(),
  ];
}

interface OrderRowDb {
  id: string;
  session_id: string;
  status: string;
  failure_code: string | null;
  subtotal_cents: number;
  shipping_cents: number;
  total_cents: number;
  card_last4: string;
  payment_ref: string | null;
  idempotency_key: string;
}

function orderRows(db: Database): OrderRowDb[] {
  return db.query<OrderRowDb, []>("SELECT * FROM orders ORDER BY rowid").all();
}

function countOrders(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orders").get()?.n ?? -1;
}

function codeOf(r: Result<unknown>): ErrorCode | "OK" {
  return r.ok ? "OK" : r.error.code;
}

function okValue<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

function errOf(r: Result<unknown>) {
  if (r.ok) throw new Error("expected an error result");
  return r.error;
}

/** Shape invariants every Order must satisfy. */
function assertOrderShape(o: Order): void {
  expect(o.id).toMatch(UUID_V4);
  expect(o.shippingCents).toBe(0);
  expect(o.totalCents).toBe(o.subtotalCents);
  expect(Number.isSafeInteger(o.totalCents)).toBe(true);
  expect(o.cardLast4).toMatch(/^\d{4}$/);
  if (o.status === "payment_failed") {
    expect(o.failureCode).toBeDefined();
    expect(Object.keys(PAYMENT_FAILURE_MESSAGES)).toContain(o.failureCode as string);
  } else {
    expect(o.status).toBe("paid");
    expect("failureCode" in o).toBe(false);
  }
  const expected = o.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
  expect(o.subtotalCents).toBe(expected);
}

const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Leak scan per the orchestrator ruling (exact cards, CVCs, 9+ digit runs, field names; UUIDs stripped). */
function leaks(text: string, cards: readonly string[], cvcs: readonly string[], fieldNames = true): string[] {
  const s = text.replace(UUID_ANY, "<uuid>");
  const found: string[] = [];
  for (const c of cards) {
    const spaced = c.replace(/(\d{4})(?=\d)/g, "$1 ");
    if (s.includes(c) || s.includes(spaced)) found.push(`card:${c}`);
  }
  for (const v of cvcs) if (new RegExp(`(?<!\\d)${v}(?!\\d)`).test(s)) found.push(`cvc:${v}`);
  for (const m of s.match(/\d{9,}/g) ?? []) found.push(`digits:${m}`);
  if (fieldNames) for (const f of ["number", "cvc", "expMonth", "expYear"]) if (s.includes(`"${f}"`)) found.push(`field:${f}`);
  return found;
}

const ALL_CARDS = Object.values(MOCK_CARDS);

const PENDING = Symbol("pending");
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof PENDING>((resolve) => {
    timer = setTimeout(() => resolve(PENDING), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

describe("T11 static", () => {
  test("orders module has no any / ts-ignore / eslint-disable / console / interpolated SQL from input", async () => {
    for (const f of ["order-repository.ts", "order-service.ts"]) {
      const src = await Bun.file(`${import.meta.dir}/../../src/server/orders/${f}`).text();
      expect(src).not.toMatch(/:\s*any\b|as any\b|@ts-ignore|@ts-expect-error|eslint-disable|console\./);
      // Only the constant column list is interpolated into SQL.
      for (const m of src.matchAll(/\$\{([^}]+)\}/g)) {
        expect(["ORDER_COLUMNS", "value"]).toContain(m[1] as string);
      }
    }
  });

  test("orders and order_items have no column that could hold card number, CVC or expiry", () => {
    const h = setup();
    const cols = [
      ...h.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('orders')").all(),
      ...h.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('order_items')").all(),
    ].map((c) => c.name);
    expect(cols).toContain("card_last4");
    for (const c of cols) expect(c).not.toMatch(/number|cvc|cvv|exp|pan/i);
  });
});

// ---------------------------------------------------------------------------
// Criterion 1: empty cart, validation
// ---------------------------------------------------------------------------

describe("T11 c1: EMPTY_CART and VALIDATION_FAILED never create an order or charge", () => {
  test("session with no cart -> EMPTY_CART, nothing written, nothing charged", async () => {
    const h = setup();
    const before = stocks(h.db);
    const r = await h.svc.placeOrder(input(S1, "k-empty"));
    expect(codeOf(r)).toBe("EMPTY_CART");
    expect(countOrders(h.db)).toBe(0);
    expect(h.pay.listCharges()).toHaveLength(0);
    expect(stocks(h.db)).toEqual(before);
  });

  test("cart emptied by removeItem -> EMPTY_CART", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    h.carts.removeItem(S1, TOTE);
    expect(codeOf(await h.svc.placeOrder(input(S1, "k")))).toBe("EMPTY_CART");
    expect(countOrders(h.db)).toBe(0);
  });

  test.each([
    ["null", null],
    ["empty string", ""],
    ["upper-case UUID of a session that has a cart", S3.toUpperCase()],
    ["UUID v1", "11111111-1111-1111-8111-111111111111"],
    ["SQL-shaped", "' OR 1=1 --"],
    ["huge", "a".repeat(100_000)],
  ])("null/invalid session (%s) -> EMPTY_CART", async (_label, session) => {
    const h = setup();
    add(h, S1, TOTE, 1);
    add(h, S3, TOTE, 1);
    const r = await h.svc.placeOrder(input(session as string | null, "k"));
    expect(codeOf(r)).toBe("EMPTY_CART");
    expect(countOrders(h.db)).toBe(0);
    expect(h.pay.listCharges()).toHaveLength(0);
  });

  test("empty cart wins over invalid address and card (documented check order)", async () => {
    const h = setup();
    const r = await h.svc.placeOrder(input(S1, "k", { address: null, card: null }));
    expect(codeOf(r)).toBe("EMPTY_CART");
  });

  const hostileAddresses: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["array", [ADDRESS]],
    ["string", "12 Analytical Way"],
    ["number", 42],
    ["empty object", {}],
    ["prototype-less empty", Object.create(null)],
    ["fields are arrays", { ...ADDRESS, fullName: ["Ada"], city: ["London"] }],
    ["fields are objects", { ...ADDRESS, email: { toString: () => "ada@example.com" } }],
    ["huge strings", { ...ADDRESS, line1: "x".repeat(50_000), fullName: "y".repeat(10_000) }],
    ["bad email + country", { ...ADDRESS, email: "not-an-email", country: "GBR" }],
    ["whitespace-only and zero-width", { ...ADDRESS, fullName: " ​\t ", city: "﻿" }],
  ];

  test.each(hostileAddresses)("hostile address (%s) -> VALIDATION_FAILED with per-field errors; no order, no charge, no stock change", async (_l, address) => {
    const h = setup();
    add(h, S1, TOTE, 2);
    const beforeStock = stocks(h.db);
    const beforeCart = cartRows(h.db);
    const r = await h.svc.placeOrder(input(S1, "k-addr", { address }));
    const e = errOf(r);
    expect(e.code).toBe("VALIDATION_FAILED");
    const fields = (e.details as { fields: Record<string, { code: string; message: string }> }).fields;
    expect(Object.keys(fields).length).toBeGreaterThan(0);
    for (const [, fe] of Object.entries(fields)) {
      expect(Object.keys(fe).sort()).toEqual(["code", "message"]);
      expect(typeof fe.code).toBe("string");
    }
    expect(countOrders(h.db)).toBe(0);
    expect(h.pay.listCharges()).toHaveLength(0);
    expect(stocks(h.db)).toEqual(beforeStock);
    expect(cartRows(h.db)).toEqual(beforeCart);
    // The key is not burned: a corrected retry with the same key succeeds.
    expect(codeOf(await h.svc.placeOrder(input(S1, "k-addr")))).toBe("OK");
  });

  const hostileCards: [string, unknown, string[]][] = [
    ["null", null, ["number", "expMonth", "expYear", "cvc", "nameOnCard"]],
    ["array", [card()], ["number", "expMonth", "expYear", "cvc", "nameOnCard"]],
    ["prototype-less empty", Object.create(null), ["number", "expMonth", "expYear", "cvc", "nameOnCard"]],
    ["non-Luhn", card("4242424242424241"), ["number"]],
    ["letters", card("4242-4242-abcd-4242"), ["number"]],
    ["too long", card("4".repeat(5000)), ["number"]],
    ["all same digit", card("0000000000000000"), ["number"]],
    ["expired", { ...card(), expMonth: 10, expYear: 2026 }, ["expMonth"]],
    ["month 13", { ...card(), expMonth: 13 }, ["expMonth"]],
    ["year far future", { ...card(), expYear: 2099 }, ["expYear"]],
    ["cvc 2 digits", card(MOCK_CARDS.success, "12"), ["cvc"]],
    ["cvc as number", { ...card(), cvc: 123 }, ["cvc"]],
    ["number as number", { ...card(), number: 4242424242424242 }, ["number"]],
    ["huge name", { ...card(), nameOnCard: "n".repeat(100_000) }, ["nameOnCard"]],
  ];

  test.each(hostileCards)("hostile card (%s) -> VALIDATION_FAILED on the right fields, card values never echoed", async (_l, c, expectedFields) => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const beforeStock = stocks(h.db);
    const r = await h.svc.placeOrder(input(S1, "k-card", { card: c }));
    const e = errOf(r);
    expect(e.code).toBe("VALIDATION_FAILED");
    const fields = (e.details as { fields: Record<string, unknown> }).fields;
    for (const f of expectedFields) expect(Object.keys(fields)).toContain(f);
    const json = JSON.stringify(r);
    expect(leaks(json, [...ALL_CARDS, "4242424242424241"], [CVC], false)).toEqual([]);
    expect(json).not.toContain("4".repeat(20));
    expect(countOrders(h.db)).toBe(0);
    expect(h.pay.listCharges()).toHaveLength(0);
    expect(stocks(h.db)).toEqual(beforeStock);
  });

  test("invalid address AND invalid card -> fields from both merged flat", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const r = await h.svc.placeOrder(input(S1, "k", { address: { ...ADDRESS, email: "x" }, card: card("1234") }));
    const fields = (errOf(r).details as { fields: Record<string, unknown> }).fields;
    expect(Object.keys(fields).sort()).toEqual(["email", "number"]);
  });

  test("prototype-less but valid address and card are accepted", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const address = Object.assign(Object.create(null) as object, ADDRESS);
    const c = Object.assign(Object.create(null) as object, card());
    const o = okValue(await h.svc.placeOrder(input(S1, "k", { address, card: c })));
    expect(o.address.country).toBe("GB");
  });

  test("JSON-parsed __proto__ keys in address are inert", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const address: unknown = JSON.parse(JSON.stringify(ADDRESS).replace("{", '{"__proto__":{"fullName":"Evil"},'));
    const o = okValue(await h.svc.placeOrder(input(S1, "k", { address })));
    expect(o.address.fullName).toBe("Ada Lovelace");
    expect(({} as Record<string, unknown>).fullName).toBeUndefined();
  });

  test("documented: a card object whose getter throws makes placeOrder reject; nothing is written and the key is released", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const evil = new Proxy(
      {},
      {
        get() {
          throw new Error("getter boom");
        },
      },
    );
    await expect(h.svc.placeOrder(input(S1, "k-proxy", { card: evil }))).rejects.toThrow("getter boom");
    expect(countOrders(h.db)).toBe(0);
    expect(stock(h.db, TOTE)).toBe(42);
    expect(h.inFlight.size).toBe(0);
    expect(codeOf(await h.svc.placeOrder(input(S1, "k-proxy")))).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: STOCK_CHANGED
// ---------------------------------------------------------------------------

describe("T11 c2: STOCK_CHANGED lists lines; no charge, no order, cart preserved", () => {
  test("product sold out after add -> line listed with available 0", async () => {
    const h = setup();
    add(h, S1, TOTE, 2);
    add(h, S1, BEANIE, 1);
    h.db.query("UPDATE products SET stock = 0 WHERE id = ?").run(TOTE);
    const beforeCart = cartRows(h.db);
    const r = await h.svc.placeOrder(input(S1, "k"));
    const e = errOf(r);
    expect(e.code).toBe("STOCK_CHANGED");
    expect((e.details as { lines: unknown[] }).lines).toEqual([
      { productId: TOTE, name: "Canvas Tote Bag", requested: 2, available: 0 },
    ]);
    expect(h.pay.listCharges()).toHaveLength(0);
    expect(countOrders(h.db)).toBe(0);
    expect(cartRows(h.db)).toEqual(beforeCart);
    expect(stock(h.db, BEANIE)).toBe(64);
  });

  test("insufficient (reduced) and sold-out lines are both listed; ok lines are not", async () => {
    const h = setup();
    add(h, S1, DESK, 3);
    add(h, S1, TOTE, 5);
    add(h, S1, PIN, 1);
    h.db.query("UPDATE products SET stock = 1 WHERE id = ?").run(DESK);
    h.db.query("UPDATE products SET stock = 0 WHERE id = ?").run(TOTE);
    const lines = (errOf(await h.svc.placeOrder(input(S1, "k"))).details as { lines: { productId: string }[] }).lines;
    expect(lines).toEqual([
      { productId: DESK, name: "Walnut Standing Desk", requested: 3, available: 1 },
      { productId: TOTE, name: "Canvas Tote Bag", requested: 5, available: 0 },
    ] as never);
    expect(stock(h.db, PIN)).toBe(100);
    expect(stock(h.db, DESK)).toBe(1);
  });

  test("stock exactly equal to quantity is not a change", async () => {
    const h = setup();
    add(h, S1, DESK, 3);
    const o = okValue(await h.svc.placeOrder(input(S1, "k")));
    expect(o.items[0]?.quantity).toBe(3);
    expect(stock(h.db, DESK)).toBe(0);
  });

  test("validation runs before the stock check (documented order)", async () => {
    const h = setup();
    add(h, S1, TOTE, 2);
    h.db.query("UPDATE products SET stock = 0 WHERE id = ?").run(TOTE);
    expect(codeOf(await h.svc.placeOrder(input(S1, "k", { card: card("1") })))).toBe("VALIDATION_FAILED");
  });

  test("decrementStock failing mid-reservation rolls back earlier decrements and returns STOCK_CHANGED", async () => {
    const h = setup({
      products: (real, db) => ({
        list: () => real.list(),
        getBySlug: (s) => real.getBySlug(s),
        getById: (id) => real.getById(id),
        getManyByIds: (ids) => real.getManyByIds(ids),
        decrementStock: (id, q) => {
          // Simulate a competing writer draining the second line just before its decrement.
          if (id === BEANIE) db.query("UPDATE products SET stock = 0 WHERE id = ?").run(id);
          return real.decrementStock(id, q);
        },
      }),
    });
    add(h, S1, TOTE, 4);
    add(h, S1, BEANIE, 2);
    const e = errOf(await h.svc.placeOrder(input(S1, "k")));
    expect(e.code).toBe("STOCK_CHANGED");
    expect((e.details as { lines: unknown[] }).lines).toEqual([
      { productId: BEANIE, name: "Merino Beanie", requested: 2, available: 0 },
    ]);
    expect(stock(h.db, TOTE)).toBe(42);
    expect(h.pay.listCharges()).toHaveLength(0);
    expect(countOrders(h.db)).toBe(0);
    expect(h.db.query("SELECT COUNT(*) AS n FROM cart_items").get()).toEqual({ n: 2 });
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: payment failures
// ---------------------------------------------------------------------------

const FAILURES: [string, string, PaymentFailureCode][] = [
  ["declined", MOCK_CARDS.declined, "DECLINED"],
  ["insufficient funds", MOCK_CARDS.insufficientFunds, "INSUFFICIENT_FUNDS"],
  ["processing error", MOCK_CARDS.processingError, "PROCESSING_ERROR"],
];

describe("T11 c3: declines leave stock and cart unchanged, record payment_failed, return the provider message", () => {
  test.each(FAILURES)("%s", async (_l, number, code) => {
    const h = setup();
    add(h, S1, TOTE, 2);
    add(h, S1, PRINT, 1);
    const beforeStock = stocks(h.db);
    const beforeCart = cartRows(h.db);
    const r = await h.svc.placeOrder(input(S1, "k-fail", { card: card(number) }));
    const e = errOf(r);
    expect(e.code).toBe("PAYMENT_FAILED");
    expect(e.message).toBe(PAYMENT_FAILURE_MESSAGES[code]);
    const details = e.details as { orderId: string; failureCode: string };
    expect(details.failureCode).toBe(code);
    expect(details.orderId).toMatch(UUID_V4);
    expect(stocks(h.db)).toEqual(beforeStock);
    expect(cartRows(h.db)).toEqual(beforeCart);
    const rows = orderRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: details.orderId,
      session_id: S1,
      status: "payment_failed",
      failure_code: code,
      idempotency_key: "k-fail",
      payment_ref: null,
      card_last4: number.slice(-4),
      subtotal_cents: 2 * 1999 + 18000,
      total_cents: 2 * 1999 + 18000,
      shipping_cents: 0,
    });
    const stored = h.svc.getOrder(details.orderId, S1);
    expect(stored?.status).toBe("payment_failed");
    expect(stored?.failureCode).toBe(code);
    assertOrderShape(stored as Order);
    expect(h.pay.listCharges().map((c) => c.outcome)).toEqual([code]);
  });

  test.each(FAILURES)("%s: retry with SAME key replays the decline (same orderId, no new charge, no new row)", async (_l, number, code) => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const first = errOf(await h.svc.placeOrder(input(S1, "k", { card: card(number) })));
    // Even with a good card, the same key replays.
    const again = errOf(await h.svc.placeOrder(input(S1, "k")));
    expect(again).toEqual(first);
    expect((again.details as { failureCode: string }).failureCode).toBe(code);
    expect(countOrders(h.db)).toBe(1);
    expect(h.pay.listCharges()).toHaveLength(1);
    expect(stock(h.db, TOTE)).toBe(42);
  });

  test.each(FAILURES)("%s: retry with a NEW key and 4242 succeeds", async (_l, number) => {
    const h = setup();
    add(h, S1, TOTE, 3);
    const failed = errOf(await h.svc.placeOrder(input(S1, "k1", { card: card(number) })));
    const o = okValue(await h.svc.placeOrder(input(S1, "k2")));
    expect(o.id).not.toBe((failed.details as { orderId: string }).orderId);
    expect(o.status).toBe("paid");
    expect(stock(h.db, TOTE)).toBe(39);
    expect(orderRows(h.db).map((r) => r.status)).toEqual(["payment_failed", "paid"]);
    expect(h.db.query("SELECT COUNT(*) AS n FROM cart_items").get()).toEqual({ n: 0 });
  });

  test("provider that throws synchronously -> PROCESSING_ERROR, stock restored, thrown text not leaked", async () => {
    const provider: PaymentProvider = {
      charge: () => {
        throw new Error(`boom ${MOCK_CARDS.success} cvc ${CVC}`);
      },
    };
    const h = setup({ payments: provider });
    add(h, S1, DESK, 2);
    const r = await h.svc.placeOrder(input(S1, "k"));
    const e = errOf(r);
    expect(e.code).toBe("PAYMENT_FAILED");
    expect(e.message).toBe(PAYMENT_FAILURE_MESSAGES.PROCESSING_ERROR);
    expect((e.details as { failureCode: string }).failureCode).toBe("PROCESSING_ERROR");
    expect(stock(h.db, DESK)).toBe(3);
    expect(orderRows(h.db)[0]?.status).toBe("payment_failed");
    expect(JSON.stringify(r)).not.toContain("boom");
  });

  test("provider that rejects -> PROCESSING_ERROR, stock restored", async () => {
    const h = setup({ payments: { charge: () => Promise.reject(new Error("network")) } });
    add(h, S1, DESK, 3);
    expect((errOf(await h.svc.placeOrder(input(S1, "k"))).details as { failureCode: string }).failureCode).toBe("PROCESSING_ERROR");
    expect(stock(h.db, DESK)).toBe(3);
  });

  test("provider's own user-safe message is passed through verbatim", async () => {
    const h = setup({
      payments: { charge: () => Promise.resolve({ ok: false, error: { code: "DECLINED", message: "Bank says no." } }) },
    });
    add(h, S1, TOTE, 1);
    expect(errOf(await h.svc.placeOrder(input(S1, "k"))).message).toBe("Bank says no.");
  });

  test("documented: a provider that never resolves keeps stock reserved and the key in flight; releasing it completes the order", async () => {
    let release: ((r: PaymentResult) => void) | undefined;
    const hung = new Promise<PaymentResult>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const h = setup({
      payments: {
        charge: () => {
          calls += 1;
          return hung;
        },
      },
    });
    add(h, S1, PRINT, 1);
    add(h, S2, PRINT, 1);
    const p1 = h.svc.placeOrder(input(S1, "k-hang"));
    expect(await settleWithin(p1, 50)).toBe(PENDING);
    // Reserved while pending: stock is 0 and the key is claimed by a pending row
    // (FIX-checkout-v2: payment_failed / PROCESSING_ERROR / payment_ref "pending:claim").
    expect(stock(h.db, PRINT)).toBe(0);
    expect(countOrders(h.db)).toBe(1);
    expect(orderRows(h.db)[0]).toMatchObject({ payment_ref: "pending:claim", failure_code: "PROCESSING_ERROR" });
    expect(h.inFlight.has("k-hang")).toBe(true);
    // Same key, same session: shares the pending promise (no second charge).
    expect(h.svc.placeOrder(input(S1, "k-hang"))).toBe(p1);
    // Same key, other session: rejected immediately.
    expect(codeOf(await h.svc.placeOrder(input(S2, "k-hang")))).toBe("INVALID_INPUT");
    // Another session wanting the last unit sees it as gone.
    expect(codeOf(await h.svc.placeOrder(input(S2, "k-other")))).toBe("STOCK_CHANGED");
    expect(calls).toBe(1);
    release?.({ ok: true, value: { providerRef: "mock_x", last4: "4242" } });
    const o = okValue(await p1);
    expect(o.status).toBe("paid");
    expect(stock(h.db, PRINT)).toBe(0);
    expect(h.inFlight.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: success
// ---------------------------------------------------------------------------

describe("T11 c4: success", () => {
  test("paid order, stock decremented, cart cleared, snapshots of names and prices", async () => {
    const h = setup();
    add(h, S1, TOTE, 2);
    add(h, S1, DESK, 1);
    add(h, S1, PIN, 7);
    const o = okValue(await h.svc.placeOrder(input(S1, "k-ok")));
    expect(o.status).toBe("paid");
    expect(o.sessionId).toBe(S1);
    expect(o.idempotencyKey).toBe("k-ok");
    expect(o.cardLast4).toBe("4242");
    expect(o.createdAt).toBe(NOW.toISOString());
    expect(o.currency).toBe("USD");
    expect(o.address).toEqual({ ...ADDRESS, country: "GB" });
    expect(o.items).toEqual([
      { productId: TOTE, name: "Canvas Tote Bag", unitPriceCents: 1999, quantity: 2 },
      { productId: DESK, name: "Walnut Standing Desk", unitPriceCents: 125000, quantity: 1 },
      { productId: PIN, name: "Enamel Pin Set", unitPriceCents: 50, quantity: 7 },
    ]);
    expect(o.subtotalCents).toBe(2 * 1999 + 125000 + 7 * 50);
    assertOrderShape(o);
    expect(stock(h.db, TOTE)).toBe(40);
    expect(stock(h.db, DESK)).toBe(2);
    expect(stock(h.db, PIN)).toBe(93);
    expect(cartRows(h.db)).toEqual([]);
    expect(h.carts.getCart(S1).items).toEqual([]);
    const row = orderRows(h.db)[0];
    expect(row?.payment_ref).toMatch(/^mock_/);
    expect(row?.failure_code).toBeNull();
    expect(h.svc.getOrder(o.id, S1)).toEqual(o);
  });

  test("order is immutable after product rename, price change and deletion", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    add(h, S1, BEANIE, 2);
    const o = okValue(await h.svc.placeOrder(input(S1, "k")));
    h.db.query("UPDATE products SET name = 'Renamed', price_cents = 1 WHERE id = ?").run(TOTE);
    h.db.query("DELETE FROM products WHERE id = ?").run(BEANIE);
    const again = h.svc.getOrder(o.id, S1);
    expect(again).toEqual(o);
    expect(again?.items[0]).toEqual({ productId: TOTE, name: "Canvas Tote Bag", unitPriceCents: 1999, quantity: 1 });
  });

  test("returned Order objects are not shared with storage (mutating a copy does not change getOrder)", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const o = okValue(await h.svc.placeOrder(input(S1, "k")));
    const copy = JSON.parse(JSON.stringify(o)) as { items: { name: string }[] };
    (copy.items[0] as { name: string }).name = "tampered";
    expect(h.svc.getOrder(o.id, S1)?.items[0]?.name).toBe("Canvas Tote Bag");
  });

  test("line2 is snapshotted when present and omitted when blank", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const o = okValue(await h.svc.placeOrder(input(S1, "k", { address: { ...ADDRESS, line2: "  Flat 3 " } })));
    expect(h.svc.getOrder(o.id, S1)?.address.line2).toBe("Flat 3");
    add(h, S1, TOTE, 1);
    const o2 = okValue(await h.svc.placeOrder(input(S1, "k2", { address: { ...ADDRESS, line2: "   " } })));
    expect("line2" in (h.svc.getOrder(o2.id, S1)?.address ?? {})).toBe(false);
  });

  test("documented: if inserting the order (the key claim, now before the charge) throws, stock is released, cart kept, nothing charged, call rejects; same-key retry succeeds with one charge", async () => {
    let failNext = true;
    const h = setup({
      orders: (real) => ({
        insertOrder: (order, ref) => {
          if (failNext) {
            failNext = false;
            throw new Error("disk full");
          }
          real.insertOrder(order, ref);
        },
        findById: (id) => real.findById(id),
        findByIdempotencyKey: (k) => real.findByIdempotencyKey(k),
        restoreStock: (lines) => real.restoreStock(lines),
      }),
    });
    add(h, S1, DESK, 2);
    await expect(h.svc.placeOrder(input(S1, "k"))).rejects.toThrow("disk full");
    expect(stock(h.db, DESK)).toBe(3);
    expect(countOrders(h.db)).toBe(0);
    expect(h.db.query("SELECT COUNT(*) AS n FROM cart_items").get()).toEqual({ n: 1 });
    // The claim is inserted inside the reservation, before the charge: nothing charged.
    expect(h.pay.listCharges()).toHaveLength(0);
    const o = okValue(await h.svc.placeOrder(input(S1, "k")));
    expect(o.status).toBe("paid");
    expect(h.pay.listCharges()).toHaveLength(1);
    expect(stock(h.db, DESK)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: double submit
// ---------------------------------------------------------------------------

describe("T11 c5: duplicate idempotency key", () => {
  test("sequential: same order id, one charge, one stock decrement, one row", async () => {
    const h = setup();
    add(h, S1, DESK, 2);
    const a = okValue(await h.svc.placeOrder(input(S1, "dup")));
    const b = okValue(await h.svc.placeOrder(input(S1, "dup")));
    expect(b.id).toBe(a.id);
    expect(b).toEqual(a);
    expect(h.pay.listCharges()).toHaveLength(1);
    expect(stock(h.db, DESK)).toBe(1);
    expect(countOrders(h.db)).toBe(1);
  });

  test.each([2, 10])("Promise.all x%d (latency 0 and 5ms): one order, one charge", async (n) => {
    for (const latencyMs of [0, 5]) {
      const h = setup({ latencyMs });
      add(h, S1, DESK, 3);
      const results = await Promise.all(Array.from({ length: n }, () => h.svc.placeOrder(input(S1, "dup"))));
      const ids = new Set(results.map((r) => okValue(r).id));
      expect(ids.size).toBe(1);
      expect(h.pay.listCharges()).toHaveLength(1);
      expect(stock(h.db, DESK)).toBe(0);
      expect(countOrders(h.db)).toBe(1);
    }
  });

  test("replay after paid ignores a refilled cart (returns the original order, charges nothing, leaves new cart alone)", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const a = okValue(await h.svc.placeOrder(input(S1, "dup")));
    add(h, S1, BEANIE, 4);
    const b = okValue(await h.svc.placeOrder(input(S1, "dup")));
    expect(b.id).toBe(a.id);
    expect(h.carts.getCart(S1).items.map((i) => i.productId)).toEqual([BEANIE]);
    expect(stock(h.db, BEANIE)).toBe(64);
    expect(h.pay.listCharges()).toHaveLength(1);
  });

  test("documented: concurrent duplicates share the first attempt even if the second carries a different card", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const [a, b] = await Promise.all([
      h.svc.placeOrder(input(S1, "dup")),
      h.svc.placeOrder(input(S1, "dup", { card: card(MOCK_CARDS.declined) })),
    ]);
    expect(okValue(a).id).toBe(okValue(b).id);
  });

  test("cross-process race (two services, separate in-flight maps, shared DB + provider) still yields one order and one net decrement", async () => {
    const h = setup({ latencyMs: 2 });
    const other = new OrderService({
      db: h.db,
      carts: h.carts,
      products: h.products,
      orders: h.orders,
      payments: h.pay,
      inFlight: new Map(),
      now: () => NOW,
    });
    add(h, S1, TOTE, 2);
    const [a, b] = await Promise.all([h.svc.placeOrder(input(S1, "dup")), other.placeOrder(input(S1, "dup"))]);
    expect(okValue(a).id).toBe(okValue(b).id);
    expect(h.pay.listCharges()).toHaveLength(1);
    expect(stock(h.db, TOTE)).toBe(40);
    expect(countOrders(h.db)).toBe(1);
  });

  test("cross-process race at stock == quantity: the duplicate replays the winner's order (key claimed in the reservation); one order, one charge", async () => {
    const h = setup({ latencyMs: 2 });
    const other = new OrderService({
      db: h.db,
      carts: h.carts,
      products: h.products,
      orders: h.orders,
      payments: h.pay,
      inFlight: new Map(),
      now: () => NOW,
    });
    add(h, S1, PRINT, 1);
    const [a, b] = await Promise.all([h.svc.placeOrder(input(S1, "dup")), other.placeOrder(input(S1, "dup"))]);
    expect(codeOf(a)).toBe("OK");
    expect(codeOf(b)).toBe("OK");
    expect(okValue(b).id).toBe(okValue(a).id);
    expect(h.pay.listCharges()).toHaveLength(1);
    expect(stock(h.db, PRINT)).toBe(0);
    expect(countOrders(h.db)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Idempotency key format and cross-session reuse
// ---------------------------------------------------------------------------

describe("T11 idempotency key validation and cross-session reuse", () => {
  test.each([
    ["0 chars", ""],
    ["129 chars", "k".repeat(129)],
    ["whitespace only", "   "],
    ["non-ASCII accent", "clé-1"],
    ["emoji", "key-\u{1F600}"],
    ["newline", "a\nb"],
    ["NUL", "a\u0000b"],
    ["number", 123],
    ["null", null],
    ["object", { toString: () => "k" }],
    ["array", ["k"]],
  ])("bad key (%s) -> INVALID_INPUT { field: idempotencyKey }, nothing charged", async (_l, key) => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const e = errOf(await h.svc.placeOrder(input(S1, key)));
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.details).toEqual({ field: "idempotencyKey" });
    expect(h.pay.listCharges()).toHaveLength(0);
    expect(countOrders(h.db)).toBe(0);
    expect(isIdempotencyKey(key)).toBe(false);
  });

  test.each([
    ["1 char", "k"],
    ["128 chars", "k".repeat(128)],
    ["printable punctuation", "~!@#$%^&*()_+{}|:\"<>?`-=[]\\;',./ "],
    ["SQL-shaped", "'; DROP TABLE orders; --"],
  ])("good key (%s) is accepted and stored verbatim", async (_l, key) => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const o = okValue(await h.svc.placeOrder(input(S1, key)));
    expect(o.idempotencyKey).toBe(key);
    expect(orderRows(h.db)[0]?.idempotency_key).toBe(key);
  });

  test("key reused by another session after paid -> INVALID_INPUT; other session's cart untouched, no charge", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    add(h, S2, BEANIE, 1);
    okValue(await h.svc.placeOrder(input(S1, "shared")));
    const before = cartRows(h.db);
    expect(codeOf(await h.svc.placeOrder(input(S2, "shared")))).toBe("INVALID_INPUT");
    expect(cartRows(h.db)).toEqual(before);
    expect(h.pay.listCharges()).toHaveLength(1);
    expect(stock(h.db, BEANIE)).toBe(64);
  });

  test("key reused by another session after payment_failed -> INVALID_INPUT (does not leak the decline)", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    add(h, S2, TOTE, 1);
    errOf(await h.svc.placeOrder(input(S1, "shared", { card: card(MOCK_CARDS.declined) })));
    const e = errOf(await h.svc.placeOrder(input(S2, "shared")));
    expect(e.code).toBe("INVALID_INPUT");
    expect(JSON.stringify(e)).not.toContain("DECLINED");
  });

  test("key used concurrently by two sessions: first proceeds, second INVALID_INPUT", async () => {
    const h = setup({ latencyMs: 3 });
    add(h, S1, TOTE, 1);
    add(h, S2, TOTE, 1);
    const [a, b] = await Promise.all([h.svc.placeOrder(input(S1, "shared")), h.svc.placeOrder(input(S2, "shared"))]);
    expect(codeOf(a)).toBe("OK");
    expect(codeOf(b)).toBe("INVALID_INPUT");
    expect(h.pay.listCharges()).toHaveLength(1);
    expect(stock(h.db, TOTE)).toBe(41);
  });

  test("a key whose first attempt failed validation (no row, no charge) is free for another session", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    add(h, S2, TOTE, 1);
    expect(codeOf(await h.svc.placeOrder(input(S1, "k", { address: null })))).toBe("VALIDATION_FAILED");
    expect(codeOf(await h.svc.placeOrder(input(S2, "k")))).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: last unit race
// ---------------------------------------------------------------------------

async function lastUnitRace(latencyMs: number, sessions: readonly string[]): Promise<string[]> {
  const anomalies: string[] = [];
  const h = setup({ latencyMs });
  for (const s of sessions) add(h, s, PRINT, 1);
  const results = await Promise.all(sessions.map((s, i) => h.svc.placeOrder(input(s, `race-${i}`))));
  const codes = results.map(codeOf);
  if (codes.filter((c) => c === "OK").length !== 1) anomalies.push(`ok count ${codes.join(",")}`);
  if (codes.filter((c) => c === "STOCK_CHANGED").length !== sessions.length - 1) anomalies.push(`stock_changed ${codes.join(",")}`);
  const s = stock(h.db, PRINT);
  if (s !== 0) anomalies.push(`stock ${s}`);
  if (h.pay.listCharges().length !== 1) anomalies.push(`charges ${h.pay.listCharges().length}`);
  if (countOrders(h.db) !== 1) anomalies.push(`orders ${countOrders(h.db)}`);
  return anomalies;
}

async function duplicateKeyRace(latencyMs: number, n: number): Promise<string[]> {
  const anomalies: string[] = [];
  const h = setup({ latencyMs });
  add(h, S1, DESK, 2);
  const results = await Promise.all(Array.from({ length: n }, () => h.svc.placeOrder(input(S1, "same"))));
  const ids = new Set(results.map((r) => (r.ok ? r.value.id : `err:${r.error.code}`)));
  if (ids.size !== 1 || [...ids][0]?.startsWith("err:")) anomalies.push(`ids ${[...ids].join(",")}`);
  if (h.pay.listCharges().length !== 1) anomalies.push(`charges ${h.pay.listCharges().length}`);
  if (stock(h.db, DESK) !== 1) anomalies.push(`stock ${stock(h.db, DESK)}`);
  if (countOrders(h.db) !== 1) anomalies.push(`orders ${countOrders(h.db)}`);
  return anomalies;
}

describe("T11 c6: last-unit contention", () => {
  test("two sessions: exactly one wins, the other gets STOCK_CHANGED listing the line", async () => {
    const h = setup();
    add(h, S1, PRINT, 1);
    add(h, S2, PRINT, 1);
    const [a, b] = await Promise.all([h.svc.placeOrder(input(S1, "a")), h.svc.placeOrder(input(S2, "b"))]);
    expect([codeOf(a), codeOf(b)].sort()).toEqual(["OK", "STOCK_CHANGED"]);
    const loser = a.ok ? b : a;
    expect((errOf(loser).details as { lines: unknown[] }).lines).toEqual([
      { productId: PRINT, name: "Limited Print No. 1", requested: 1, available: 0 },
    ]);
    expect(stock(h.db, PRINT)).toBe(0);
    // Loser's cart is preserved.
    const loserSession = a.ok ? S2 : S1;
    expect(h.carts.getCart(loserSession).items).toHaveLength(1);
  });

  test("documented: if the reserving session's payment is declined, the concurrent loser still got STOCK_CHANGED and stock returns to 1", async () => {
    const h = setup({ latencyMs: 2 });
    add(h, S1, PRINT, 1);
    add(h, S2, PRINT, 1);
    const [a, b] = await Promise.all([
      h.svc.placeOrder(input(S1, "a", { card: card(MOCK_CARDS.declined) })),
      h.svc.placeOrder(input(S2, "b")),
    ]);
    expect(codeOf(a)).toBe("PAYMENT_FAILED");
    expect(codeOf(b)).toBe("STOCK_CHANGED");
    expect(stock(h.db, PRINT)).toBe(1);
    // S2 can now retry and win.
    expect(codeOf(await h.svc.placeOrder(input(S2, "b2")))).toBe("OK");
  });

  test("20 iterations x {2 sessions latency 0, 3 sessions latency 2ms}: zero anomalies", async () => {
    const anomalies: string[] = [];
    for (let i = 0; i < 20; i++) {
      anomalies.push(...(await lastUnitRace(0, [S1, S2])).map((a) => `#${i} l0 ${a}`));
      anomalies.push(...(await lastUnitRace(2, [S1, S2, S3])).map((a) => `#${i} l2 ${a}`));
    }
    expect(anomalies).toEqual([]);
  });

  test("stock CHECK constraint holds: products.stock is never negative after the races", () => {
    const h = setup();
    expect(() => h.db.query("UPDATE products SET stock = -1 WHERE id = ?").run(PRINT)).toThrow();
  });
});

describe("T11 c5 repeated: duplicate-key race", () => {
  test("20 iterations x {5 calls latency 0, 5 calls latency 2ms}: zero anomalies", async () => {
    const anomalies: string[] = [];
    for (let i = 0; i < 20; i++) {
      anomalies.push(...(await duplicateKeyRace(0, 5)).map((a) => `#${i} l0 ${a}`));
      anomalies.push(...(await duplicateKeyRace(2, 5)).map((a) => `#${i} l2 ${a}`));
    }
    expect(anomalies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 7: server-computed total
// ---------------------------------------------------------------------------

describe("T11 c7: charged total is the server cart total", () => {
  test("client-supplied amount fields are ignored", async () => {
    const h = setup();
    add(h, S1, TOTE, 3);
    add(h, S1, DESK, 1);
    const hostile = { ...input(S1, "k"), amountCents: 1, totalCents: 1, subtotalCents: 1, items: [] } as PlaceOrderInput;
    const o = okValue(await h.svc.placeOrder(hostile));
    const expected = 3 * 1999 + 125000;
    expect(o.totalCents).toBe(expected);
    expect(h.pay.listCharges()[0]?.amountCents).toBe(expected);
  });

  test("price changed between add and checkout -> charged and snapshotted at the current price", async () => {
    const h = setup();
    add(h, S1, TOTE, 2);
    h.db.query("UPDATE products SET price_cents = 2500 WHERE id = ?").run(TOTE);
    const o = okValue(await h.svc.placeOrder(input(S1, "k")));
    expect(o.items[0]?.unitPriceCents).toBe(2500);
    expect(o.totalCents).toBe(5000);
    expect(h.pay.listCharges()[0]?.amountCents).toBe(5000);
  });

  test("charged amount equals cart view subtotal and order total for the same cart", async () => {
    const h = setup();
    add(h, S1, PIN, 99);
    add(h, S1, BEANIE, 3);
    const viewSubtotal = h.carts.getCart(S1).subtotalCents;
    const o = okValue(await h.svc.placeOrder(input(S1, "k")));
    expect(o.totalCents).toBe(viewSubtotal);
    expect(h.pay.listCharges()[0]?.amountCents).toBe(viewSubtotal);
  });
});

// ---------------------------------------------------------------------------
// Criterion 8: getOrder isolation
// ---------------------------------------------------------------------------

describe("T11 c8: getOrder not-found cases", () => {
  test("own order found; foreign/unknown/malformed/upper-case/SQL-shaped ids and bad sessions all null", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const o = okValue(await h.svc.placeOrder(input(S1, "k")));
    expect(isOrderId(o.id)).toBe(true);
    expect(h.svc.getOrder(o.id, S1)).toEqual(o);
    const bad: unknown[] = [
      o.id.toUpperCase(),
      `${o.id} `,
      ` ${o.id}`,
      `${o.id}\u0000`,
      "00000000-0000-4000-8000-000000000000",
      "",
      "abc",
      "' OR '1'='1",
      `${o.id}' OR '1'='1`,
      o.id.replace(/-/g, ""),
      null,
      undefined,
      123,
      {},
      [o.id],
      { toString: () => o.id },
    ];
    for (const id of bad) expect(h.svc.getOrder(id, S1)).toBeNull();
    for (const s of [S2, null, "", "' OR 1=1 --"]) expect(h.svc.getOrder(o.id, s)).toBeNull();
    // Upper-cased session id of the real owner (S3 contains hex letters).
    add(h, S3, TOTE, 1);
    const o3 = okValue(await h.svc.placeOrder(input(S3, "k3")));
    expect(h.svc.getOrder(o3.id, S3)).toEqual(o3);
    expect(h.svc.getOrder(o3.id, S3.toUpperCase())).toBeNull();
  });

  test("failed orders are also scoped to their session", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const id = (errOf(await h.svc.placeOrder(input(S1, "k", { card: card(MOCK_CARDS.declined) }))).details as { orderId: string }).orderId;
    expect(h.svc.getOrder(id, S1)?.status).toBe("payment_failed");
    expect(h.svc.getOrder(id, S2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Criterion 9: card data never persisted
// ---------------------------------------------------------------------------

describe("T11 c9: only last4 persisted", () => {
  test("full DB dump after success, each decline and a validation failure contains no card number, CVC, 9+ digit run or card field names", async () => {
    const h = setup();
    const results: unknown[] = [];
    add(h, S1, TOTE, 1);
    results.push(await h.svc.placeOrder(input(S1, "ok", { card: card("4242 4242 4242 4242", CVC) })));
    for (const [i, [, number]] of FAILURES.entries()) {
      add(h, S2, TOTE, 1);
      results.push(await h.svc.placeOrder(input(S2, `f${i}`, { card: card(number, CVC_ALT) })));
    }
    const validation = await h.svc.placeOrder(input(S2, "v", { card: card("4242424242424241", CVC) }));
    const dump: unknown[] = [];
    for (const t of ["products", "carts", "cart_items", "orders", "order_items"]) dump.push(h.db.query(`SELECT * FROM ${t}`).all());
    expect(leaks(JSON.stringify(dump), [...ALL_CARDS, "4242424242424241"], [CVC, CVC_ALT])).toEqual([]);
    expect(leaks(JSON.stringify(results), [...ALL_CARDS], [CVC, CVC_ALT])).toEqual([]);
    expect(leaks(JSON.stringify(h.pay.listCharges()), [...ALL_CARDS], [CVC, CVC_ALT])).toEqual([]);
    // VALIDATION_FAILED legitimately names card fields as keys; it must not carry values.
    expect(leaks(JSON.stringify(validation), ["4242424242424241"], [CVC], false)).toEqual([]);
    expect(orderRows(h.db).map((r) => r.card_last4).sort()).toEqual(["0002", "0119", "4242", "9995"]);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe("T11 JSON round-trip", () => {
  test("success, PAYMENT_FAILED, STOCK_CHANGED, VALIDATION_FAILED, EMPTY_CART and INVALID_INPUT results survive JSON unchanged", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const all: Result<Order>[] = [];
    all.push(await h.svc.placeOrder(input(S1, "ok", { address: { ...ADDRESS, line2: "Flat 1" } })));
    add(h, S1, TOTE, 1);
    all.push(await h.svc.placeOrder(input(S1, "f", { card: card(MOCK_CARDS.insufficientFunds) })));
    h.db.query("UPDATE products SET stock = 0 WHERE id = ?").run(TOTE);
    all.push(await h.svc.placeOrder(input(S1, "s")));
    all.push(await h.svc.placeOrder(input(S1, "v", { address: {} })));
    all.push(await h.svc.placeOrder(input(S2, "e")));
    all.push(await h.svc.placeOrder(input(S1, "")));
    expect(all.map(codeOf)).toEqual(["OK", "PAYMENT_FAILED", "STOCK_CHANGED", "VALIDATION_FAILED", "EMPTY_CART", "INVALID_INPUT"]);
    for (const r of all) expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    const ok = all[0];
    if (ok?.ok) expect(JSON.parse(JSON.stringify(h.svc.getOrder(ok.value.id, S1)))).toEqual(ok.value);
  });
});

// ---------------------------------------------------------------------------
// Repository edges
// ---------------------------------------------------------------------------

describe("T11 repository edges", () => {
  test("insertOrder with a duplicate key throws DuplicateIdempotencyKeyError and writes no items", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const o = okValue(await h.svc.placeOrder(input(S1, "k")));
    expect(() => h.orders.insertOrder({ ...o, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, null)).toThrow(DuplicateIdempotencyKeyError);
    expect(h.db.query("SELECT COUNT(*) AS n FROM order_items").get()).toEqual({ n: 1 });
  });

  test("restoreStock rejects non-positive / non-integer quantities and skips unknown products", () => {
    const h = setup();
    for (const q of [0, -1, 1.5, Number.NaN]) expect(() => h.orders.restoreStock([{ productId: TOTE, quantity: q }])).toThrow(RangeError);
    h.orders.restoreStock([{ productId: "nope", quantity: 3 }]);
    expect(stock(h.db, TOTE)).toBe(42);
  });

  test("an unknown failure_code in the DB is read back as PROCESSING_ERROR; null failure_code on paid stays absent", () => {
    const h = setup();
    h.db
      .query(
        `INSERT INTO orders (id, session_id, status, failure_code, subtotal_cents, total_cents, currency, full_name, email,
           line1, city, region, postal_code, country, card_last4, idempotency_key)
         VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', ?, 'payment_failed', 'WEIRD', 0, 0, 'USD', 'A', 'a@b.co', 'L', 'C', 'R', 'P', 'US', '4242', 'x')`,
      )
      .run(S1);
    expect(h.svc.getOrder("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", S1)?.failureCode).toBe("PROCESSING_ERROR");
  });
});

// ---------------------------------------------------------------------------
// Defect reproductions (pass while the defect exists)
// ---------------------------------------------------------------------------

describe("T11 defect regressions (D-T11-1, D-T11-2: fixed)", () => {
  const OVERFLOW = { code: "MONEY_OVERFLOW" as const, message: "This order total is too large to process." };

  test("D-T11-1 regression: line total above MAX_SAFE_INTEGER -> MONEY_OVERFLOW; nothing reserved, charged or ordered; cart kept", async () => {
    const h = setup();
    add(h, S1, TOTE, 2);
    add(h, S1, BEANIE, 1);
    h.db.query("UPDATE products SET price_cents = ? WHERE id = ?").run(Number.MAX_SAFE_INTEGER, TOTE);
    const beforeStock = stocks(h.db);
    const beforeCart = cartRows(h.db);
    const r = await h.svc.placeOrder(input(S1, "k"));
    expect(r).toEqual({ ok: false, error: OVERFLOW });
    expect(stocks(h.db)).toEqual(beforeStock);
    expect(cartRows(h.db)).toEqual(beforeCart);
    expect(h.pay.listCharges()).toHaveLength(0);
    expect(countOrders(h.db)).toBe(0);
    expect(h.inFlight.size).toBe(0);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    // Key not burned: after the price is fixed the same key succeeds.
    h.db.query("UPDATE products SET price_cents = 1999 WHERE id = ?").run(TOTE);
    expect(codeOf(await h.svc.placeOrder(input(S1, "k")))).toBe("OK");
  });

  test("D-T11-1 regression: subtotal overflow across lines (each line safe) -> MONEY_OVERFLOW, nothing written", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    add(h, S1, BEANIE, 1);
    const half = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
    h.db.query("UPDATE products SET price_cents = ? WHERE id IN (?, ?)").run(half, TOTE, BEANIE);
    const beforeStock = stocks(h.db);
    expect(await h.svc.placeOrder(input(S1, "k"))).toEqual({ ok: false, error: OVERFLOW });
    expect(stocks(h.db)).toEqual(beforeStock);
    expect(h.pay.listCharges()).toHaveLength(0);
    expect(countOrders(h.db)).toBe(0);
  });

  test("D-T11-1 regression: overflow is reported even with invalid address/card (cart read precedes validation), empty cart still wins", async () => {
    const h = setup();
    expect(codeOf(await h.svc.placeOrder(input(S1, "e", { address: null })))).toBe("EMPTY_CART");
    add(h, S1, TOTE, 2);
    h.db.query("UPDATE products SET price_cents = ? WHERE id = ?").run(Number.MAX_SAFE_INTEGER, TOTE);
    expect(codeOf(await h.svc.placeOrder(input(S1, "k", { address: null, card: null })))).toBe("MONEY_OVERFLOW");
  });

  test("D-T11-2 regression: whitespace-padded 80k-char fullName handled in under 250ms with TOO_LONG, nothing written", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const pad = " ".repeat(40_000);
    const t0 = performance.now();
    const r = await h.svc.placeOrder(input(S1, "k", { address: { ...ADDRESS, fullName: `${pad}x${pad}y` } }));
    expect(performance.now() - t0).toBeLessThan(250);
    expect((errOf(r).details as { fields: Record<string, { code: string }> }).fields.fullName?.code).toBe("TOO_LONG");
    expect(countOrders(h.db)).toBe(0);
    expect(stock(h.db, TOTE)).toBe(42);
  });

  test("D-T11-2 regression: 1 MB padded strings in every address and card field stay under 250ms", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    const big = `${" ".repeat(500_000)}x${" ".repeat(500_000)}y`;
    const address = Object.fromEntries(Object.keys(ADDRESS).map((k) => [k, big]));
    const c = { number: big, expMonth: big, expYear: big, cvc: big, nameOnCard: big };
    const t0 = performance.now();
    const r = await h.svc.placeOrder(input(S1, "k", { address, card: c }));
    expect(performance.now() - t0).toBeLessThan(250);
    expect(codeOf(r)).toBe("VALIDATION_FAILED");
  });

  test("D-T11-2 regression: validation no longer holds the write lock (a slow-looking address does not run inside a transaction)", async () => {
    const h = setup();
    add(h, S1, TOTE, 1);
    let inTx: boolean | undefined;
    const address = new Proxy({ ...ADDRESS }, {
      get(target, prop) {
        if (prop === "fullName") inTx = h.db.inTransaction;
        return Reflect.get(target, prop);
      },
    });
    okValue(await h.svc.placeOrder(input(S1, "k", { address })));
    expect(inTx).toBe(false);
  });
});
