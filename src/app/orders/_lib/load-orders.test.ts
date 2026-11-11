import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createCartService, type CartServiceV2 } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { PENDING_PAYMENT_REF, createOrderService, type OrderServiceV2, type OrderView } from "@/server/orders/order-service";
import { MOCK_CARDS, createMockPaymentProvider } from "@/server/payments/mock-payment-provider";

import {
  loadInvoice,
  loadOrderDetail,
  loadOrdersPage,
  toBuyAgainProducts,
  type OrdersReader,
} from "./load-orders";

const NOW = Date.parse("2026-11-04T10:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const TOTE = "prod_canvas-tote-bag"; // 1999
const PIN = "prod_enamel-pin-set"; // 50

const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical Way",
  city: "London",
  region: "LDN",
  postalCode: "N1 9GU",
  country: "GB",
};

let db: Database;
let svc: OrderServiceV2;
let carts: CartServiceV2;
const clock = { value: NOW };
let seq = 0;

function card(number: string = MOCK_CARDS.success) {
  return { number, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" };
}

async function place(owner: string, lines: [string, number][], at: number, extra: { coupon?: string; ship?: string } = {}): Promise<OrderView> {
  clock.value = at;
  for (const [id, qty] of lines) {
    const r = carts.addItem(owner, id, qty);
    if (!r.ok) throw new Error(`addItem ${r.error.code}`);
  }
  if (extra.coupon) {
    const r = carts.applyCoupon(owner, extra.coupon, at);
    if (!r.ok) throw new Error(`coupon ${r.error.code}`);
  }
  if (extra.ship) {
    const r = carts.selectShippingMethod(owner, extra.ship);
    if (!r.ok) throw new Error(`ship ${r.error.code}`);
  }
  seq += 1;
  const r = await svc.placeOrderV2({ sessionId: owner, address: ADDRESS, card: card(), idempotencyKey: `t110-${seq}` }, at);
  if (!r.ok) throw new Error(`place ${r.error.code}`);
  return r.value;
}

let recent: OrderView; // A, 5 min ago, cancellable, tote + coupon + express
let week: OrderView; // A, 7 days ago, pins
let old: OrderView; // A, 100 days ago (outside 3m, inside 6m)
let foreign: OrderView; // B
let failedId = "";

function deps(now = NOW, reader: OrdersReader = svc) {
  return { now, getOrders: () => reader };
}

function eventCounts(orderId: string): { status: string; n: number }[] {
  return db
    .query<{ status: string; n: number }, [string]>(
      "SELECT status, COUNT(*) AS n FROM order_events WHERE order_id = ? GROUP BY status",
    )
    .all(orderId);
}

beforeAll(async () => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW - 400 * DAY) });
  const pay = createMockPaymentProvider({ latencyMs: 0, now: () => new Date(clock.value) });
  svc = createOrderService(db, { now: () => clock.value, payments: pay, inFlight: new Map() });
  carts = createCartService(db, { now: () => clock.value });

  old = await place(A, [[PIN, 2]], NOW - 100 * DAY);
  week = await place(A, [[PIN, 3]], NOW - 7 * DAY);
  recent = await place(A, [[TOTE, 1]], NOW - 5 * MIN, { coupon: "welcome10", ship: "express" });
  foreign = await place(B, [[TOTE, 4]], NOW - 1 * DAY);

  clock.value = NOW;
  const added = carts.addItem(A, TOTE, 1);
  if (!added.ok) throw new Error("add");
  const failed = await svc.placeOrderV2({ sessionId: A, address: ADDRESS, card: card(MOCK_CARDS.declined), idempotencyKey: "t110-declined" }, NOW);
  if (failed.ok) throw new Error("expected decline");
  const fid = failed.error.details?.orderId;
  if (typeof fid !== "string") throw new Error("no failed id");
  failedId = fid;
});

describe("loadOrdersPage", () => {
  test("no owner key: empty data for the requested tab, service never resolved", () => {
    const getOrders = mock(() => svc as OrdersReader);
    const data = loadOrdersPage({ ownerKey: null, searchParams: { tab: "buy-again", page: "4" } }, { now: NOW, getOrders });
    expect(data).toEqual({ tab: "buy-again", range: "3m", query: "", page: 1, pageCount: 0, orders: [], buyAgainProducts: [] });
    expect(getOrders).not.toHaveBeenCalled();
  });

  test("tab/range/q table (owner A only; B's order never listed)", () => {
    const table: [Record<string, string>, string[]][] = [
      [{}, [recent.id, week.id]],
      [{ range: "garbage" }, [recent.id, week.id]],
      [{ range: "6m" }, [recent.id, week.id, old.id]],
      [{ range: "all" }, [recent.id, week.id, old.id]],
      [{ range: "30d" }, [recent.id, week.id]],
      [{ range: "all", q: "TOTE" }, [recent.id]],
      [{ range: "all", q: "enamel pin" }, [week.id, old.id]],
      [{ range: "all", q: "nothing-matches" }, []],
      [{ tab: "nonsense", range: "all" }, [recent.id, week.id, old.id]],
      [{ tab: "cancelled", range: "all" }, []],
      [{ tab: "not-shipped" }, [recent.id]],
    ];
    for (const [sp, ids] of table) {
      const data = loadOrdersPage({ ownerKey: A, searchParams: sp }, deps());
      expect({ sp, ids: data.orders.map((o) => o.id) }).toEqual({ sp, ids });
      expect(data.orders.some((o) => o.id === foreign.id)).toBe(false);
      expect(data.buyAgainProducts).toEqual([]);
    }
    const b = loadOrdersPage({ ownerKey: B, searchParams: { range: "all" } }, deps());
    expect(b.orders.map((o) => o.id)).toEqual([foreign.id]);
  });

  test("page beyond the last is clamped by the service; pageCount passed through", () => {
    const data = loadOrdersPage({ ownerKey: A, searchParams: { range: "all", page: "999" } }, deps());
    expect(data.page).toBe(1);
    expect(data.pageCount).toBe(1);
    const none = loadOrdersPage({ ownerKey: A, searchParams: { range: "all", q: "zzz" } }, deps());
    expect(none.pageCount).toBe(0);
    expect(none.page).toBe(1);
  });

  test("passes toServiceTab + parsed params to listOrders, and now", () => {
    const listOrders = mock<OrdersReader["listOrders"]>(() => ({ items: [], total: 0, page: 1, pageCount: 0, tab: "all", range: "3m" }));
    const reader = { ...stubReader(), listOrders };
    loadOrdersPage({ ownerKey: A, searchParams: { tab: "not-shipped", range: "1y", q: " desk ", page: "2" } }, deps(NOW, reader));
    expect(listOrders).toHaveBeenCalledWith(A, { tab: "not_shipped", range: "1y", query: "desk", page: 2 }, NOW);
    loadOrdersPage({ ownerKey: A, searchParams: {} }, deps(NOW, reader));
    expect(listOrders).toHaveBeenLastCalledWith(A, { tab: "all", range: "3m", page: 1 }, NOW);
  });

  test("buy again: current product data; unpublished/deleted products dropped", () => {
    const before = loadOrdersPage({ ownerKey: A, searchParams: { tab: "buy-again" } }, deps());
    expect(before.orders).toEqual([]);
    expect(before.buyAgainProducts.map((p) => p.productId).sort()).toEqual([PIN, TOTE].sort());
    const tote = before.buyAgainProducts.find((p) => p.productId === TOTE);
    expect(tote).toMatchObject({ slug: "canvas-tote-bag", name: "Canvas Tote Bag", priceCents: 1999, currency: "USD", inStock: true });

    db.run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    try {
      const after = loadOrdersPage({ ownerKey: A, searchParams: { tab: "buy-again" } }, deps());
      expect(after.buyAgainProducts.map((p) => p.productId)).toEqual([PIN]);
    } finally {
      db.run("UPDATE products SET published_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    }
  });

  test("toBuyAgainProducts: null products dropped, stock flag from `available`, snapshot image fallback", () => {
    const product = { id: "p1", slug: "s", name: "Now", description: "", priceCents: 500, currency: "USD", imageUrl: "", stock: 0 };
    const out = toBuyAgainProducts([
      { productId: "gone", productSlug: "g", name: "Gone", imageUrl: null, lastOrderedAt: "2026-01-01T00:00:00.000Z", available: false, product: null },
      { productId: "p1", productSlug: "old", name: "Then", imageUrl: "/snap.svg", lastOrderedAt: "2026-01-01T00:00:00.000Z", available: false, product },
    ]);
    expect(out).toEqual([{ productId: "p1", slug: "s", name: "Now", imageUrl: "/snap.svg", priceCents: 500, currency: "USD", inStock: false }]);
  });
});

function stubReader(): OrdersReader {
  return {
    listOrders: () => ({ items: [], total: 0, page: 1, pageCount: 0, tab: "all", range: "3m" }),
    getBuyAgainLines: () => [],
    getOrderView: () => null,
    getOrder: () => null,
  };
}

describe("loadOrderDetail", () => {
  test("own order: detail by default, confirmation only with placed=1; now passed through", () => {
    const d = loadOrderDetail({ id: recent.id, ownerKey: A, searchParams: {} }, deps());
    if (d === null || d.kind !== "order") throw new Error("expected order");
    expect(d.variant).toBe("detail");
    expect(d.now).toBe(NOW);
    expect(d.notice).toBeNull();
    expect(d.order.id).toBe(recent.id);
    expect(d.order.cancellable).toBe(true);
    const c = loadOrderDetail({ id: recent.id, ownerKey: A, searchParams: { placed: "1", notice: "address_full" } }, deps());
    if (c === null || c.kind !== "order") throw new Error("expected order");
    expect(c.variant).toBe("confirmation");
    expect(c.notice).toBe("address_full");
  });

  test("detail order carries no email, idempotency key or owner key", () => {
    const d = loadOrderDetail({ id: recent.id, ownerKey: A }, deps());
    const json = JSON.stringify(d);
    expect(json).not.toContain("ada@example.com");
    expect(json).not.toContain(A);
    expect(json).not.toContain("t110-");
  });

  test("cross-owner, unknown, malformed, no owner -> null", () => {
    expect(loadOrderDetail({ id: foreign.id, ownerKey: A }, deps())).toBeNull();
    expect(loadOrderDetail({ id: recent.id, ownerKey: B }, deps())).toBeNull();
    expect(loadOrderDetail({ id: failedId, ownerKey: B }, deps())).toBeNull();
    expect(loadOrderDetail({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ownerKey: A }, deps())).toBeNull();
    const getOrders = mock(() => svc as OrdersReader);
    for (const id of ["nope", recent.id.toUpperCase(), `${recent.id} `, "", 7, null, undefined]) {
      expect(loadOrderDetail({ id, ownerKey: A }, { now: NOW, getOrders })).toBeNull();
    }
    expect(loadOrderDetail({ id: recent.id, ownerKey: null }, { now: NOW, getOrders })).toBeNull();
    expect(getOrders).not.toHaveBeenCalled();
  });

  test("own declined order -> payment_failed data (MVP page), no secrets", () => {
    const d = loadOrderDetail({ id: failedId, ownerKey: A }, deps());
    if (d === null || d.kind !== "payment_failed") throw new Error("expected payment_failed");
    expect(d.order.failureCode).toBe("DECLINED");
    expect(d.order.cardLast4).toBe("0002");
    const json = JSON.stringify(d);
    expect(json).not.toContain("ada@example.com");
    expect(json).not.toContain(A);
  });

  test("D-T110-2: a pending-claim row (charge in flight) is never rendered: detail and invoice -> null", async () => {
    clock.value = NOW;
    const added = carts.addItem(A, PIN, 1);
    if (!added.ok) throw new Error("add");
    const r = await svc.placeOrderV2({ sessionId: A, address: ADDRESS, card: card(MOCK_CARDS.declined), idempotencyKey: "t110-pending" }, NOW);
    if (r.ok) throw new Error("expected decline");
    const id = r.error.details?.orderId;
    if (typeof id !== "string") throw new Error("no id");
    // Put the row back into the FIX-checkout-v2 pending-claim state.
    const pend = (ref: string | null, code: string) =>
      db.run("UPDATE orders SET status = 'payment_failed', failure_code = ?, payment_ref = ? WHERE id = ?", [code, ref, id]);
    pend(PENDING_PAYMENT_REF, "PROCESSING_ERROR");
    try {
      expect(loadOrderDetail({ id, ownerKey: A }, deps())).toBeNull();
      expect(loadInvoice({ id, ownerKey: A }, deps())).toBeNull();
      expect(loadOrdersPage({ ownerKey: A, searchParams: { range: "all" } }, deps()).orders.map((o) => o.id)).not.toContain(id);
    } finally {
      pend(null, "DECLINED");
    }
    // Once finalized as a decline, the MVP failure page data is back.
    expect(loadOrderDetail({ id, ownerKey: A }, deps())?.kind).toBe("payment_failed");
  });

  test("fulfilment events persisted at most once per status across repeated loads", () => {
    for (let i = 0; i < 4; i++) {
      for (const at of [NOW, NOW + 3 * DAY, NOW + 30 * DAY]) loadOrderDetail({ id: week.id, ownerKey: A }, deps(at));
    }
    const counts = eventCounts(week.id);
    expect(counts.length).toBeGreaterThan(1);
    for (const row of counts) expect(row.n).toBe(1);
  });
});

describe("loadInvoice", () => {
  test("own order: invoice summary with snapshot totals, discount, shipping, last4, header", () => {
    db.run("UPDATE products SET price_cents = 1 WHERE id = ?", [TOTE]);
    const inv = loadInvoice({ id: recent.id, ownerKey: A }, deps());
    if (inv === null) throw new Error("expected invoice");
    expect(inv.orderId).toBe(recent.id);
    expect(inv.summary).toMatchObject({
      variant: "invoice",
      subtotalCents: 1999,
      discountCents: 199,
      couponCode: "WELCOME10",
      shippingCents: 999,
      isFreeShipping: false,
      totalCents: 2799,
      currency: "USD",
    });
    expect(inv.summary.items).toEqual([{ productId: TOTE, name: "Canvas Tote Bag", quantity: 1, unitPriceCents: 1999 }]);
    expect(inv.summary.invoice).toMatchObject({ orderId: recent.id, placedAt: recent.createdAt, status: "paid", paymentLast4: "4242", billToName: "Ada Lovelace" });
    expect(JSON.stringify(inv)).not.toContain("ada@example.com");
    db.run("UPDATE products SET price_cents = 1999 WHERE id = ?", [TOTE]);
  });

  test("free shipping -> shippingCents 0 + isFreeShipping", () => {
    const inv = loadInvoice({ id: week.id, ownerKey: A }, deps());
    if (inv === null) throw new Error("expected invoice");
    expect(inv.summary.shippingCents === 0).toBe(inv.summary.isFreeShipping === true);
  });

  test("not owner / failed / malformed / no owner -> null", () => {
    expect(loadInvoice({ id: foreign.id, ownerKey: A }, deps())).toBeNull();
    expect(loadInvoice({ id: failedId, ownerKey: A }, deps())).toBeNull();
    expect(loadInvoice({ id: "x", ownerKey: A }, deps())).toBeNull();
    expect(loadInvoice({ id: recent.id, ownerKey: null }, deps())).toBeNull();
  });

  test("cancelled order: status Cancelled, no estimate", () => {
    const r = svc.cancelOrder(recent.id, A, NOW);
    if (!r.ok) throw new Error(r.error.code);
    const inv = loadInvoice({ id: recent.id, ownerKey: A }, deps());
    expect(inv?.summary.invoice?.status).toBe("cancelled");
    expect(inv?.summary.estimatedDelivery).toBeNull();
    const cancelledTab = loadOrdersPage({ ownerKey: A, searchParams: { tab: "cancelled" } }, deps());
    expect(cancelledTab.orders.map((o) => o.id)).toEqual([recent.id]);
  });
});
