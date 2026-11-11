import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Order } from "@/lib/types";
import type { AppError, Result } from "@/lib/result";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedProducts } from "@/server/db/seed";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { SqliteCartRepository } from "@/server/cart/cart-repository";
import { CartService } from "@/server/cart/cart-service";
import {
  MOCK_CARDS,
  PAYMENT_FAILURE_MESSAGES,
  createMockPaymentProvider,
} from "@/server/payments/mock-payment-provider";
import type { PaymentProvider } from "@/server/payments/payment-provider";
import { SqliteOrderRepository, type OrderRepository } from "./order-repository";
import { OrderService, createOrderService, getPaymentProvider, isIdempotencyKey, isOrderId, type StockChangedLine } from "./order-service";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const CVC = "987";

const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const PIN = "prod_enamel-pin-set"; // 50, stock 100
const DESK = "prod_walnut-desk"; // 125000, stock 3
const PRINT = "prod_limited-print-no-1"; // 18000, stock 1

const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical Way",
  city: "London",
  region: "LDN",
  postalCode: "N1 9GU",
  country: "gb",
};

function card(number: string = MOCK_CARDS.success) {
  return { number, expMonth: 12, expYear: 2030, cvc: CVC, nameOnCard: "Ada Lovelace" };
}

function setup(options: { payments?: PaymentProvider; latencyMs?: number } = {}) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedProducts(db);
  const products = new SqliteProductRepository(db);
  const carts = new CartService({ db, carts: new SqliteCartRepository(db), products });
  const orders = new SqliteOrderRepository(db, { now: () => NOW });
  const provider = createMockPaymentProvider({ now: () => NOW, latencyMs: options.latencyMs ?? 0 });
  let n = 0;
  const service = new OrderService({
    db,
    carts,
    products,
    orders,
    payments: options.payments ?? provider,
    now: () => NOW,
    // Letters only after the counter so ids hold no long digit runs.
    idGenerator: () => `${(++n).toString(16).padStart(8, "e")}-eeee-4eee-8eee-eeeeeeeeeeee`,
  });
  return { db, carts, orders, provider, service };
}

function add(carts: CartService, session: string, productId: string, qty: number): void {
  const r = carts.addItem(session, productId, qty);
  if (!r.ok) throw new Error(`addItem failed: ${JSON.stringify(r.error)}`);
}

function stock(db: Database, id: string): number {
  const row = db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id);
  if (row === null) throw new Error(`no product ${id}`);
  return row.stock;
}

function orderCount(db: Database): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM orders").get()?.n ?? -1;
}

function expectOk(r: Result<Order>): Order {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function expectErr(r: Result<Order>, code: AppError["code"]): AppError {
  if (r.ok) throw new Error(`expected ${code}, got ok`);
  expect(r.error.code).toBe(code);
  return r.error;
}

describe("validation and empty cart", () => {
  test("empty cart returns EMPTY_CART; no order, no charge", async () => {
    const { db, provider, service } = setup();
    expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" }), "EMPTY_CART");
    expectErr(await service.placeOrder({ sessionId: null, address: ADDRESS, card: card(), idempotencyKey: "k2" }), "EMPTY_CART");
    expectErr(await service.placeOrder({ sessionId: "not-a-uuid", address: ADDRESS, card: card(), idempotencyKey: "k3" }), "EMPTY_CART");
    expect(orderCount(db)).toBe(0);
    expect(provider.listCharges()).toHaveLength(0);
  });

  test("invalid address and card return VALIDATION_FAILED with merged per-field errors, no card values", async () => {
    const { db, carts, provider, service } = setup();
    add(carts, S1, TOTE, 1);
    const badCard = { number: "4242424242424241", expMonth: 13, expYear: 2030, cvc: "12", nameOnCard: "" };
    const error = expectErr(
      await service.placeOrder({ sessionId: S1, address: { ...ADDRESS, email: "nope", city: "" }, card: badCard, idempotencyKey: "k1" }),
      "VALIDATION_FAILED",
    );
    const fields = error.details?.fields as Record<string, { code: string; message: string }>;
    expect(Object.keys(fields).sort()).toEqual(["city", "cvc", "email", "expMonth", "nameOnCard", "number"]);
    expect(fields.email?.code).toBe("INVALID_EMAIL");
    expect(fields.number?.code).toBe("FAILED_CHECKSUM");
    expect(JSON.stringify(error)).not.toContain("4242424242424241");
    expect(orderCount(db)).toBe(0);
    expect(provider.listCharges()).toHaveLength(0);
    expect(stock(db, TOTE)).toBe(42);
    expect(carts.getCart(S1).items).toHaveLength(1);
  });

  test("empty cart takes precedence over invalid fields", async () => {
    const { service } = setup();
    expectErr(await service.placeOrder({ sessionId: S1, address: null, card: null, idempotencyKey: "k1" }), "EMPTY_CART");
  });

  test("address/card validation runs outside any transaction", async () => {
    const { db, carts, orders, provider } = setup();
    add(carts, S1, TOTE, 1);
    const products = new SqliteProductRepository(db);
    const seen: boolean[] = [];
    const service = new OrderService({
      db, carts, products, orders, payments: provider, now: () => {
        // `now` is read by validateCard; record whether a transaction is open.
        seen.push(db.inTransaction);
        return NOW;
      },
    });
    expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: null, idempotencyKey: "k1" }), "VALIDATION_FAILED");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((t) => !t)).toBe(true);
  });

  test("only-card and only-address failures report just their fields", async () => {
    const { carts, service } = setup();
    add(carts, S1, TOTE, 1);
    const a = expectErr(await service.placeOrder({ sessionId: S1, address: null, card: card(), idempotencyKey: "k1" }), "VALIDATION_FAILED");
    expect(Object.keys(a.details?.fields as object)).toContain("fullName");
    expect(Object.keys(a.details?.fields as object)).not.toContain("number");
    const c = expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: "x", idempotencyKey: "k2" }), "VALIDATION_FAILED");
    expect(Object.keys(c.details?.fields as object).sort()).toEqual(["cvc", "expMonth", "expYear", "nameOnCard", "number"]);
  });

  test("bad idempotency keys return INVALID_INPUT", async () => {
    const { carts, provider, service } = setup();
    add(carts, S1, TOTE, 1);
    for (const key of [undefined, null, 42, "", "   ", "a".repeat(129), "tab\tkey", "ключ"]) {
      expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: key }), "INVALID_INPUT");
    }
    expect(provider.listCharges()).toHaveLength(0);
    expect(isIdempotencyKey("a".repeat(128))).toBe(true);
    expect(isIdempotencyKey("checkout 1 ~!")).toBe(true);
  });
});

describe("money overflow", () => {
  test("a cart total above MAX_SAFE_INTEGER returns MONEY_OVERFLOW; nothing reserved or charged", async () => {
    const { db, carts, provider, service } = setup();
    add(carts, S1, TOTE, 2);
    db.run("UPDATE products SET price_cents = 9007199254740991 WHERE id = ?", [TOTE]);
    const error = expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" }), "MONEY_OVERFLOW");
    expect(error).toEqual({ code: "MONEY_OVERFLOW", message: "This order total is too large to process." });
    expect(orderCount(db)).toBe(0);
    expect(provider.listCharges()).toHaveLength(0);
    expect(stock(db, TOTE)).toBe(42);
  });
});

describe("stock problems", () => {
  test("insufficient (reduced) and unavailable lines return STOCK_CHANGED; nothing changes", async () => {
    const { db, carts, provider, service } = setup();
    add(carts, S1, TOTE, 2);
    add(carts, S1, DESK, 3);
    add(carts, S1, PRINT, 1);
    db.run("UPDATE products SET stock = 1 WHERE id = ?", [DESK]);
    db.run("UPDATE products SET stock = 0 WHERE id = ?", [PRINT]);

    const error = expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" }), "STOCK_CHANGED");
    expect(error.details?.lines).toEqual([
      { productId: DESK, name: "Walnut Standing Desk", requested: 3, available: 1 },
      { productId: PRINT, name: "Limited Print No. 1", requested: 1, available: 0 },
    ] satisfies StockChangedLine[]);
    expect(provider.listCharges()).toHaveLength(0);
    expect(orderCount(db)).toBe(0);
    expect(stock(db, TOTE)).toBe(42);
    expect(stock(db, DESK)).toBe(1);
    expect(carts.getCart(S1).items.map((i) => [i.productId, i.quantity])).toEqual([
      [TOTE, 2],
      [DESK, 3],
      [PRINT, 1],
    ]);
  });

  test("a decrementStock failure mid-reservation rolls back earlier decrements", async () => {
    const { db, carts, provider, orders } = setup();
    add(carts, S1, TOTE, 2);
    add(carts, S1, DESK, 2);
    // Cart view says "ok", but stock disappears when the decrement runs.
    const products = new SqliteProductRepository(db);
    const flaky = new OrderService({
      db,
      carts,
      orders,
      payments: provider,
      now: () => NOW,
      products: {
        list: () => products.list(),
        getBySlug: (s) => products.getBySlug(s),
        getById: (id) => products.getById(id),
        getManyByIds: (ids) => products.getManyByIds(ids),
        decrementStock: (id, qty) => {
          if (id === DESK) db.run("UPDATE products SET stock = 1 WHERE id = ?", [DESK]);
          return products.decrementStock(id, qty);
        },
      },
    });
    const error = expectErr(await flaky.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" }), "STOCK_CHANGED");
    expect(error.details?.lines).toEqual([{ productId: DESK, name: "Walnut Standing Desk", requested: 2, available: 1 }]);
    expect(stock(db, TOTE)).toBe(42); // tote decrement rolled back
    expect(stock(db, DESK)).toBe(3); // the stub's own UPDATE rolled back too
    expect(provider.listCharges()).toHaveLength(0);
    expect(orderCount(db)).toBe(0);
    expect(carts.getCart(S1).items).toHaveLength(2);
  });
});

describe("successful checkout", () => {
  test("paid order, stock decremented, cart cleared, snapshot of names and prices", async () => {
    const { db, carts, provider, service } = setup();
    add(carts, S1, TOTE, 2);
    add(carts, S1, PIN, 3);
    const order = expectOk(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" }));

    expect(isOrderId(order.id)).toBe(true);
    expect(order).toMatchObject({
      sessionId: S1,
      status: "paid",
      subtotalCents: 2 * 1999 + 3 * 50,
      shippingCents: 0,
      totalCents: 2 * 1999 + 3 * 50,
      currency: "USD",
      cardLast4: "4242",
      idempotencyKey: "k1",
      createdAt: NOW.toISOString(),
      address: { ...ADDRESS, country: "GB" },
    });
    expect(order.failureCode).toBeUndefined();
    expect(order.items).toEqual([
      { productId: TOTE, name: "Canvas Tote Bag", unitPriceCents: 1999, quantity: 2 },
      { productId: PIN, name: "Enamel Pin Set", unitPriceCents: 50, quantity: 3 },
    ]);
    expect(stock(db, TOTE)).toBe(40);
    expect(stock(db, PIN)).toBe(97);
    expect(carts.getCart(S1).items).toHaveLength(0);
    expect(service.getOrder(order.id, S1)).toEqual(order);

    const charges = provider.listCharges();
    expect(charges).toHaveLength(1);
    expect(charges[0]?.amountCents).toBe(order.totalCents);
    expect(charges[0]?.idempotencyKey).toBe("k1");
    const ref = db.query<{ payment_ref: string | null }, [string]>("SELECT payment_ref FROM orders WHERE id = ?").get(order.id);
    expect(ref?.payment_ref).toBe(charges[0]?.providerRef ?? "missing");

    // Snapshot survives later catalogue edits.
    db.run("UPDATE products SET name = 'Renamed', price_cents = 1 WHERE id = ?", [TOTE]);
    expect(service.getOrder(order.id, S1)?.items[0]).toEqual({ productId: TOTE, name: "Canvas Tote Bag", unitPriceCents: 1999, quantity: 2 });
  });

  test("charged total is the server cart total, ignoring client-supplied totals", async () => {
    const { carts, provider, service } = setup();
    add(carts, S1, DESK, 1);
    const input = { sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1", totalCents: 1, amountCents: 1 };
    const order = expectOk(await service.placeOrder(input));
    expect(order.totalCents).toBe(125000);
    expect(provider.listCharges()[0]?.amountCents).toBe(125000);
  });
});

describe("payment failures", () => {
  const cases = [
    [MOCK_CARDS.declined, "DECLINED"],
    [MOCK_CARDS.insufficientFunds, "INSUFFICIENT_FUNDS"],
    [MOCK_CARDS.processingError, "PROCESSING_ERROR"],
  ] as const;

  for (const [number, code] of cases) {
    test(`${code}: stock and cart unchanged, payment_failed recorded, user-safe message`, async () => {
      const { db, carts, provider, service } = setup();
      add(carts, S1, TOTE, 2);
      const error = expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(number), idempotencyKey: "k1" }), "PAYMENT_FAILED");
      expect(error.message).toBe(PAYMENT_FAILURE_MESSAGES[code]);
      const orderId = error.details?.orderId;
      expect(error.details).toEqual({ orderId, failureCode: code });
      expect(stock(db, TOTE)).toBe(42);
      expect(carts.getCart(S1).items.map((i) => i.quantity)).toEqual([2]);
      expect(provider.listCharges()).toHaveLength(1);

      const stored = service.getOrder(orderId, S1);
      expect(stored).toMatchObject({ status: "payment_failed", failureCode: code, totalCents: 3998, cardLast4: number.slice(-4) });
      const rows = db.query<{ status: string; failure_code: string | null; payment_ref: string | null }, []>(
        "SELECT status, failure_code, payment_ref FROM orders",
      ).all();
      expect(rows).toEqual([{ status: "payment_failed", failure_code: code, payment_ref: null }]);
    });
  }

  test("same key after a decline replays the decline; new key with the success card succeeds", async () => {
    const { db, carts, provider, service } = setup();
    add(carts, S1, TOTE, 1);
    const first = expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(MOCK_CARDS.declined), idempotencyKey: "k1" }), "PAYMENT_FAILED");
    const replay = expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" }), "PAYMENT_FAILED");
    expect(replay).toEqual(first);
    expect(provider.listCharges()).toHaveLength(1);
    expect(orderCount(db)).toBe(1);

    const order = expectOk(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k2" }));
    expect(order.status).toBe("paid");
    expect(order.id).not.toBe(first.details?.orderId);
    expect(stock(db, TOTE)).toBe(41);
    expect(carts.getCart(S1).items).toHaveLength(0);
    expect(provider.listCharges().map((c) => c.outcome)).toEqual(["DECLINED", "success"]);
  });

  test("a throwing provider is recorded as PROCESSING_ERROR and releases stock", async () => {
    const throwing: PaymentProvider = {
      charge: () => Promise.reject(new Error(`network down ${MOCK_CARDS.success}`)),
    };
    const { db, carts, service } = setup({ payments: throwing });
    add(carts, S1, DESK, 2);
    const error = expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" }), "PAYMENT_FAILED");
    expect(error.message).toBe(PAYMENT_FAILURE_MESSAGES.PROCESSING_ERROR);
    expect(error.details?.failureCode).toBe("PROCESSING_ERROR");
    expect(JSON.stringify(error)).not.toContain(MOCK_CARDS.success);
    expect(stock(db, DESK)).toBe(3);
    expect(carts.getCart(S1).items).toHaveLength(1);
    expect(service.getOrder(error.details?.orderId, S1)?.status).toBe("payment_failed");
  });
});

describe("idempotency", () => {
  test("sequential double submit: one order, one charge, one decrement, same id", async () => {
    const { db, carts, provider, service } = setup();
    add(carts, S1, DESK, 1);
    const input = { sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" };
    const a = expectOk(await service.placeOrder(input));
    const b = expectOk(await service.placeOrder(input));
    expect(b.id).toBe(a.id);
    expect(b).toEqual(a);
    expect(orderCount(db)).toBe(1);
    expect(provider.listCharges()).toHaveLength(1);
    expect(stock(db, DESK)).toBe(2);
  });

  test("concurrent double submit (Promise.all) shares one attempt", async () => {
    const { db, carts, provider, service } = setup({ latencyMs: 5 });
    add(carts, S1, DESK, 1);
    const input = { sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" };
    const [a, b, c] = await Promise.all([service.placeOrder(input), service.placeOrder(input), service.placeOrder(input)]);
    const ids = [expectOk(a).id, expectOk(b).id, expectOk(c).id];
    expect(new Set(ids).size).toBe(1);
    expect(orderCount(db)).toBe(1);
    expect(provider.listCharges()).toHaveLength(1);
    expect(stock(db, DESK)).toBe(2);
  });

  test("a key used by another session is INVALID_INPUT (sequential and concurrent)", async () => {
    const { db, carts, provider, service } = setup({ latencyMs: 5 });
    add(carts, S1, TOTE, 1);
    add(carts, S2, TOTE, 1);
    const [mine, theirs] = await Promise.all([
      service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "shared" }),
      service.placeOrder({ sessionId: S2, address: ADDRESS, card: card(), idempotencyKey: "shared" }),
    ]);
    expectOk(mine);
    expectErr(theirs, "INVALID_INPUT");
    expectErr(await service.placeOrder({ sessionId: S2, address: ADDRESS, card: card(), idempotencyKey: "shared" }), "INVALID_INPUT");
    expect(provider.listCharges()).toHaveLength(1);
    expect(orderCount(db)).toBe(1);
    expect(carts.getCart(S2).items).toHaveLength(1);
  });

  test("a same-key race that slips past the in-memory registry waits for the claim and replays (D-T71-2: the loser never reserves)", async () => {
    // Two service instances (separate registries) over one DB and provider,
    // standing in for two processes.
    const { db, carts, orders: realOrders, provider } = setup({ latencyMs: 5 });
    const products = new SqliteProductRepository(db);
    let restores = 0;
    const orders: OrderRepository = {
      insertOrder: (o, ref) => realOrders.insertOrder(o, ref),
      findById: (id) => realOrders.findById(id),
      findByIdempotencyKey: (k) => realOrders.findByIdempotencyKey(k),
      restoreStock: (lines) => {
        restores += 1;
        realOrders.restoreStock(lines);
      },
    };
    let n = 0;
    const make = () =>
      new OrderService({
        db, carts, products, orders, payments: provider, now: () => NOW,
        idGenerator: () => `${(++n).toString(16).padStart(8, "f")}-ffff-4fff-8fff-ffffffffffff`,
      });
    add(carts, S1, DESK, 1);
    const input = { sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" };
    const [a, b] = await Promise.all([make().placeOrder(input), make().placeOrder(input)]);
    expect(expectOk(a).id).toBe(expectOk(b).id);
    expect(restores).toBe(0); // the loser saw the pending claim: it never reserved, so nothing to release
    expect(orderCount(db)).toBe(1);
    expect(provider.listCharges()).toHaveLength(1);
    expect(stock(db, DESK)).toBe(2);
  });
});

describe("races between sessions", () => {
  test("two sessions racing for the last unit: one paid, one STOCK_CHANGED, stock never negative", async () => {
    const { db, carts, provider, service } = setup({ latencyMs: 5 });
    add(carts, S1, PRINT, 1);
    add(carts, S2, PRINT, 1);
    const results = await Promise.all([
      service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" }),
      service.placeOrder({ sessionId: S2, address: ADDRESS, card: card(), idempotencyKey: "k2" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok);
    if (loser === undefined || loser.ok) throw new Error("expected a loser");
    expect(loser.error.code).toBe("STOCK_CHANGED");
    expect(loser.error.details?.lines).toEqual([{ productId: PRINT, name: "Limited Print No. 1", requested: 1, available: 0 }]);
    expect(stock(db, PRINT)).toBe(0);
    expect(provider.listCharges()).toHaveLength(1);
    expect(orderCount(db)).toBe(1);
  });

  test("a failed payment releases the unit for the other session", async () => {
    const { db, carts, service } = setup();
    add(carts, S1, PRINT, 1);
    add(carts, S2, PRINT, 1);
    expectErr(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(MOCK_CARDS.declined), idempotencyKey: "k1" }), "PAYMENT_FAILED");
    expectOk(await service.placeOrder({ sessionId: S2, address: ADDRESS, card: card(), idempotencyKey: "k2" }));
    expect(stock(db, PRINT)).toBe(0);
  });
});

describe("getOrder", () => {
  test("returns null for another session, unknown, malformed ids and missing sessions", async () => {
    const { carts, service } = setup();
    add(carts, S1, TOTE, 1);
    const order = expectOk(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k1" }));
    expect(service.getOrder(order.id, S1)?.id).toBe(order.id);
    expect(service.getOrder(order.id, S2)).toBeNull();
    expect(service.getOrder(order.id, null)).toBeNull();
    expect(service.getOrder(order.id, "garbage")).toBeNull();
    expect(service.getOrder("cccccccc-cccc-4ccc-8ccc-cccccccccccc", S1)).toBeNull();
    for (const bad of [undefined, null, 1, "", "x", order.id.toUpperCase(), `${order.id} `, "' OR 1=1 --"]) {
      expect(service.getOrder(bad, S1)).toBeNull();
    }
  });
});

describe("card data", () => {
  test("full card number and CVC are never persisted or returned; only last4", async () => {
    const { db, carts, service } = setup();
    const results: unknown[] = [];
    add(carts, S1, TOTE, 1);
    results.push(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(MOCK_CARDS.declined), idempotencyKey: "k1" }));
    results.push(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card("4242 4242 4242 4242"), idempotencyKey: "k2" }));
    results.push(await service.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: "k2" }));

    const dump = JSON.stringify({
      results,
      orders: db.query("SELECT * FROM orders").all(),
      items: db.query("SELECT * FROM order_items").all(),
    });
    for (const secret of [MOCK_CARDS.success, MOCK_CARDS.declined, "4242 4242 4242 4242", CVC]) {
      expect(dump).not.toContain(secret);
    }
    // UUIDs (order ids, sessions, `mock_<uuid>` payment refs) can hold long
    // digit runs by chance; strip them before looking for card-like digits.
    const withoutUuids = dump.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>");
    expect(withoutUuids).not.toMatch(/\d{9,}/);
    expect(dump).not.toMatch(/"cvc"|"number"|"expMonth"|"expYear"|"nameOnCard"/);
    const last4 = db.query<{ card_last4: string }, []>("SELECT card_last4 FROM orders ORDER BY created_at, rowid").all();
    expect(last4.map((r) => r.card_last4)).toEqual(["0002", "4242"]);
  });
});

describe("createOrderService", () => {
  test("wires the SQLite repos and one shared provider", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedProducts(db);
    const a = createOrderService(db);
    const cart = new CartService({ db, carts: new SqliteCartRepository(db), products: new SqliteProductRepository(db) });
    add(cart, S1, TOTE, 1);
    const key = `wiring-${crypto.randomUUID()}`;
    const order = expectOk(await a.placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: key }));
    expect(order.status).toBe("paid");
    // A second instance shares the provider and DB: same key replays.
    expect(expectOk(await createOrderService(db).placeOrder({ sessionId: S1, address: ADDRESS, card: card(), idempotencyKey: key })).id).toBe(order.id);
    expect(getPaymentProvider().listCharges().filter((c) => c.idempotencyKey === key)).toHaveLength(1);
  });
});
