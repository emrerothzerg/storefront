import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ORDER_FIELD, type OrderActionState, type OrderLineResult } from "@/components/molecules/_contracts/order-actions";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import { createCartService, type CartService, type CartServiceV2 } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { MOCK_CARDS, createMockPaymentProvider } from "@/server/payments/mock-payment-provider";
import { createRateLimiter, type RateLimiter } from "@/server/security/rate-limiter";
import { SqliteOrderRepository } from "@/server/orders/order-repository";
import { createOrderService, type OrderServiceV2, type OrderView, type OrderViewItem } from "@/server/orders/order-service";
import {
  ORDER_MESSAGES,
  ORDERS_MUTATE_RATE_LIMIT,
  addLine,
  buyAgainMessage,
  createOrderActions,
  parseOptionalProductId,
  parseOrderId,
  type OrderActionDeps,
} from "./orders-core";

const NOW = Date.parse("2026-11-04T10:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const TOTE = "prod_canvas-tote-bag"; // stock 42
const PIN = "prod_enamel-pin-set"; // stock 100
const PRINT = "prod_limited-print-no-1"; // stock 1
const MISSING_ORDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

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
  readonly clock: { value: number };
  readonly revalidate: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  readonly readSessionId: ReturnType<typeof mock<() => Promise<string | null>>>;
  readonly logger: { error: ReturnType<typeof mock<(...args: unknown[]) => void>> };
  session: string | null;
  deps: OrderActionDeps;
}

function setup(overrides: Partial<OrderActionDeps> = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  const clock = { value: NOW };
  const pay = createMockPaymentProvider({ latencyMs: 0, now: () => new Date(clock.value) });
  const svc = createOrderService(db, { now: () => clock.value, payments: pay, inFlight: new Map() });
  const carts = createCartService(db, { now: () => clock.value });
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const h: Harness = {
    db,
    svc,
    carts,
    clock,
    revalidate,
    logger,
    session: A,
    readSessionId: mock<() => Promise<string | null>>(async () => h.session),
    deps: undefined as unknown as OrderActionDeps,
  };
  h.deps = {
    orders: svc,
    cart: carts,
    catalog: new SqliteOrderRepository(db),
    limiter: createRateLimiter(db, { now: () => clock.value }),
    readSessionId: h.readSessionId,
    revalidatePath: revalidate,
    now: () => clock.value,
    logger,
    ...overrides,
  };
  return h;
}

function actions(h: Harness) {
  return createOrderActions(h.deps);
}

async function placeOrder(h: Harness, session: string, lines: readonly [string, number][]): Promise<OrderView> {
  for (const [productId, qty] of lines) {
    const r = h.carts.addItem(session, productId, qty);
    if (!r.ok) throw new Error("addItem failed: " + r.error.code);
  }
  const placed = await h.svc.placeOrderV2(
    {
      sessionId: session,
      address: ADDRESS,
      card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" },
      idempotencyKey: "key-" + crypto.randomUUID(),
    },
    h.clock.value,
  );
  if (!placed.ok) throw new Error("placeOrderV2 failed: " + placed.error.code);
  return placed.value;
}

function form(fields: Record<string, string | readonly string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string") fd.append(k, v);
    else for (const item of v) fd.append(k, item);
  }
  return fd;
}

/** Re-parses a FormData through a real multipart body, as a browser post arrives. */
async function multipart(fields: Record<string, string>): Promise<FormData> {
  const fd = form({ $ACTION_ID_abc: "", ...fields });
  return new Request("http://localhost/orders", { method: "POST", body: fd }).formData();
}

function stock(db: Database, id: string): number {
  return db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id)?.stock ?? -1;
}

function cartQty(h: Harness, session: string, productId: string): number {
  return h.carts.getCart(session).items.find((i) => i.productId === productId)?.quantity ?? 0;
}

function expectError(state: OrderActionState, code: AppError["code"]): Extract<OrderActionState, { ok: false }> {
  if (state === null || state.ok) throw new Error("expected error state, got " + JSON.stringify(state));
  expect(state.error.code).toBe(code);
  expect(state.message).toBe(state.error.message);
  return state;
}

function expectOkState(state: OrderActionState): Extract<OrderActionState, { ok: true }> {
  if (state === null || !state.ok) throw new Error("expected ok state, got " + JSON.stringify(state));
  return state;
}

function orderStatus(db: Database, id: string): { fulfillment_status: string; cancelled_at: string | null } | null {
  return db
    .query<{ fulfillment_status: string; cancelled_at: string | null }, [string]>(
      "SELECT fulfillment_status, cancelled_at FROM orders WHERE id = ?",
    )
    .get(id);
}

// ---------------------------------------------------------------------------

describe("parsing helpers", () => {
  test("parseOrderId accepts canonical UUID v4 (trimmed) and rejects the rest", () => {
    expect(parseOrderId(form({ orderId: ` ${MISSING_ORDER} ` }))).toEqual({ ok: true, value: MISSING_ORDER });
    for (const bad of ["", "abc", MISSING_ORDER.toUpperCase(), "x".repeat(10_000), "1' OR 1=1 --"]) {
      const r = parseOrderId(form({ orderId: bad }));
      expect(r.ok).toBe(false);
    }
    expect(parseOrderId(new FormData()).ok).toBe(false);
    const file = new FormData();
    file.append("orderId", new Blob([MISSING_ORDER]), "x.txt");
    expect(parseOrderId(file).ok).toBe(false);
  });

  test("parseOptionalProductId: absent/blank -> null; long/file -> error", () => {
    expect(parseOptionalProductId(new FormData())).toEqual({ ok: true, value: null });
    expect(parseOptionalProductId(form({ productId: "  " }))).toEqual({ ok: true, value: null });
    expect(parseOptionalProductId(form({ productId: ` ${TOTE} ` }))).toEqual({ ok: true, value: TOTE });
    expect(parseOptionalProductId(form({ productId: "x".repeat(129) })).ok).toBe(false);
    const file = new FormData();
    file.append("productId", new Blob(["x"]), "x.txt");
    expect(parseOptionalProductId(file).ok).toBe(false);
  });

  test("buyAgainMessage", () => {
    expect(buyAgainMessage(2, 3)).toBe("Added 2 of 3 items to your cart.");
    expect(buyAgainMessage(1, 1)).toBe("Added 1 of 1 item to your cart.");
    expect(buyAgainMessage(0, 2)).toBe("Added 0 of 2 items to your cart.");
  });

  test("rate rule is 60 per hour", () => {
    expect(ORDERS_MUTATE_RATE_LIMIT).toEqual({ limit: 60, windowSeconds: 3600 });
  });
});

describe("cancelOrder", () => {
  test("success: cancels, restores stock, revalidates /orders paths + layout, browser-shaped multipart", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 2], [PIN, 3]]);
    const toteAfterOrder = stock(h.db, TOTE);
    const pinAfterOrder = stock(h.db, PIN);
    h.clock.value = NOW + 5 * MIN;

    const state = await actions(h).cancelOrder(null, await multipart({ orderId: order.id, confirm: "yes" }));
    expect(state).toEqual({ ok: true, kind: "cancelled", message: ORDER_MESSAGES.cancelled });
    expect(ORDER_MESSAGES.cancelled).toBe("Your order was cancelled. Stock has been released and a refund is pending.");
    expect(stock(h.db, TOTE)).toBe(toteAfterOrder + 2);
    expect(stock(h.db, PIN)).toBe(pinAfterOrder + 3);
    expect(orderStatus(h.db, order.id)?.fulfillment_status).toBe("cancelled");
    expect(h.revalidate.mock.calls).toEqual([["/orders"], [`/orders/${order.id}`], ["/", "layout"]]);
  });

  test("double submit cancels once; second -> ORDER_NOT_CANCELLABLE; stock restored once", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 2]]);
    const before = stock(h.db, TOTE);
    const act = actions(h);
    const fd = () => form({ orderId: order.id, confirm: "yes" });
    const [first, second] = await Promise.all([act.cancelOrder(null, fd()), act.cancelOrder(null, fd())]);
    const states = [first, second];
    expect(states.filter((s) => s !== null && s.ok)).toHaveLength(1);
    const failed = states.find((s) => s !== null && !s.ok) ?? null;
    expectError(failed, "ORDER_NOT_CANCELLABLE");
    expect(stock(h.db, TOTE)).toBe(before + 2);
    const third = await act.cancelOrder(null, fd());
    expect(expectError(third, "ORDER_NOT_CANCELLABLE").message).toBe(ORDER_MESSAGES.notCancellable);
    expect(stock(h.db, TOTE)).toBe(before + 2);
  });

  test("without confirm=yes: INVALID_INPUT field confirm, nothing read, no state change", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 1]]);
    const before = stock(h.db, TOTE);
    const variants: Record<string, string>[] = [{ orderId: order.id }, { orderId: order.id, confirm: "YES" }, { orderId: order.id, confirm: " yes" }, { orderId: order.id, confirm: "true" }];
    for (const fields of variants) {
      const state = expectError(await actions(h).cancelOrder(null, form(fields)), "INVALID_INPUT");
      expect(state.error.details).toEqual({ field: ORDER_FIELD.confirm });
    }
    expect(h.readSessionId).not.toHaveBeenCalled();
    expect(stock(h.db, TOTE)).toBe(before);
    expect(orderStatus(h.db, order.id)?.cancelled_at).toBeNull();
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("malformed id -> INVALID_INPUT field orderId; unknown id -> ORDER_NOT_FOUND", async () => {
    const h = setup();
    const bad = expectError(await actions(h).cancelOrder(null, form({ orderId: "nope", confirm: "yes" })), "INVALID_INPUT");
    expect(bad.error.details).toEqual({ field: ORDER_FIELD.orderId });
    const missing = expectError(
      await actions(h).cancelOrder(null, form({ orderId: MISSING_ORDER, confirm: "yes" })),
      "ORDER_NOT_FOUND",
    );
    expect(missing.message).toBe("We couldn't find that order.");
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("outside the window / shipped -> ORDER_NOT_CANCELLABLE, stock untouched", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 1]]);
    const before = stock(h.db, TOTE);
    h.clock.value = NOW + 31 * MIN;
    expectError(await actions(h).cancelOrder(null, form({ orderId: order.id, confirm: "yes" })), "ORDER_NOT_CANCELLABLE");
    h.clock.value = NOW + 3 * DAY; // shipped by now
    expectError(await actions(h).cancelOrder(null, form({ orderId: order.id, confirm: "yes" })), "ORDER_NOT_CANCELLABLE");
    expect(stock(h.db, TOTE)).toBe(before);
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("two-session isolation: B cannot cancel A's order (ORDER_NOT_FOUND), forged sessionId ignored", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 1]]);
    h.session = B;
    const state = await actions(h).cancelOrder(null, form({ orderId: order.id, confirm: "yes", sessionId: A }));
    expectError(state, "ORDER_NOT_FOUND");
    expect(orderStatus(h.db, order.id)?.cancelled_at).toBeNull();
  });

  test("no session: ORDER_NOT_FOUND, limiter untouched, service untouched", async () => {
    const check = mock<RateLimiter["check"]>(() => ok({ remaining: 1 }));
    const cancel = mock<OrderServiceV2["cancelOrder"]>(() => fail("ORDER_NOT_FOUND", "x"));
    const h = setup({ limiter: { check } });
    h.deps = { ...h.deps, orders: { cancelOrder: cancel, getOrderView: () => null } };
    h.session = null;
    expectError(await actions(h).cancelOrder(null, form({ orderId: MISSING_ORDER, confirm: "yes" })), "ORDER_NOT_FOUND");
    h.session = "not-a-uuid";
    expectError(await actions(h).cancelOrder(null, form({ orderId: MISSING_ORDER, confirm: "yes" })), "ORDER_NOT_FOUND");
    expect(check).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  test("rate limited: 61st mutation in an hour -> RATE_LIMITED + retryAfterSeconds, before the service", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 1]]);
    const act = actions(h);
    for (let i = 0; i < 60; i++) {
      const s = await act.cancelOrder(null, form({ orderId: MISSING_ORDER, confirm: "yes" }));
      expectError(s, "ORDER_NOT_FOUND");
    }
    const limited = expectError(await act.cancelOrder(null, form({ orderId: order.id, confirm: "yes" })), "RATE_LIMITED");
    expect(limited.retryAfterSeconds).toBeGreaterThan(0);
    expect(limited.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(limited.message).toMatch(/try again in \d+ minutes?\./);
    expect(orderStatus(h.db, order.id)?.cancelled_at).toBeNull();
    // shared budget: buy again is limited too
    expectError(await act.buyAgain(null, form({ orderId: order.id })), "RATE_LIMITED");
    // other session unaffected
    h.session = B;
    expectError(await act.cancelOrder(null, form({ orderId: order.id, confirm: "yes" })), "ORDER_NOT_FOUND");
  });

  test("unexpected exception -> INTERNAL_ERROR, PII-free log", async () => {
    const h = setup();
    h.deps = {
      ...h.deps,
      orders: {
        cancelOrder: () => {
          throw new Error(`boom ${A} ada@example.com`);
        },
        getOrderView: () => null,
      },
    };
    const state = expectError(await actions(h).cancelOrder(null, form({ orderId: MISSING_ORDER, confirm: "yes" })), "INTERNAL_ERROR");
    expect(state.message).toBe(ORDER_MESSAGES.unexpected);
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(h.logger.error.mock.calls);
    expect(logged).toContain("ORDER_ACTION_FAILED");
    expect(logged).not.toContain(A);
    expect(logged).not.toContain("ada@");
    expect(logged).not.toContain(MISSING_ORDER);
  });

  test("readSessionId rejecting still settles", async () => {
    const h = setup({ readSessionId: async () => Promise.reject(new Error("cookies")) });
    expectError(await actions(h).cancelOrder(null, form({ orderId: MISSING_ORDER, confirm: "yes" })), "INTERNAL_ERROR");
  });

  test("unexpected service error code maps to INTERNAL_ERROR without echoing details", async () => {
    const h = setup();
    h.deps = {
      ...h.deps,
      orders: { cancelOrder: () => fail("PAYMENT_FAILED", "provider said secret", { raw: "x" }), getOrderView: () => null },
    };
    const state = expectError(await actions(h).cancelOrder(null, form({ orderId: MISSING_ORDER, confirm: "yes" })), "INTERNAL_ERROR");
    expect(state.error.details).toBeUndefined();
  });
});

describe("buyAgain", () => {
  test("adds every line at the snapshot quantity; ignores forged price/quantity/sessionId; revalidates /cart + layout", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 2], [PIN, 3]]);
    expect(cartQty(h, A, TOTE)).toBe(0); // cart emptied by the order
    const state = expectOkState(
      await actions(h).buyAgain(
        null,
        await multipart({ orderId: order.id, price: "1", unitPriceCents: "1", quantity: "50", sessionId: B }),
      ),
    );
    expect(state.kind).toBe("buy_again");
    expect(state.message).toBe("Added 2 of 2 items to your cart.");
    expect(state.perLine).toEqual([
      { productId: TOTE, name: order.items.find((i) => i.productId === TOTE)?.name ?? "", result: "added" },
      { productId: PIN, name: order.items.find((i) => i.productId === PIN)?.name ?? "", result: "added" },
    ]);
    expect(cartQty(h, A, TOTE)).toBe(2);
    expect(cartQty(h, A, PIN)).toBe(3);
    expect(cartQty(h, B, TOTE)).toBe(0);
    // cart prices come from the catalog, never from the form
    const tote = h.carts.getCart(A).items.find((i) => i.productId === TOTE);
    expect(tote?.unitPriceCents).toBe(1999);
    expect(h.revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
  });

  test("productId restricts to one line; a productId not in the order -> INVALID_INPUT", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 2], [PIN, 3]]);
    const one = expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id, productId: PIN })));
    expect(one.perLine?.map((l) => [l.productId, l.result])).toEqual([[PIN, "added"]]);
    expect(one.message).toBe("Added 1 of 1 item to your cart.");
    expect(cartQty(h, A, TOTE)).toBe(0);
    const bad = expectError(await actions(h).buyAgain(null, form({ orderId: order.id, productId: PRINT })), "INVALID_INPUT");
    expect(bad.error.details).toEqual({ field: ORDER_FIELD.productId });
  });

  test("capped at stock (never exceeds), out_of_stock and unavailable per line", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 5], [PIN, 2], [PRINT, 1]]);
    // PRINT stock is now 0 -> out_of_stock. TOTE stock reduced to 3 -> capped. PIN deleted -> unavailable.
    h.db.run("UPDATE products SET stock = 3 WHERE id = ?", [TOTE]);
    h.db.run("PRAGMA foreign_keys = OFF");
    h.db.run("DELETE FROM products WHERE id = ?", [PIN]);
    h.db.run("PRAGMA foreign_keys = ON");
    expect(stock(h.db, PRINT)).toBe(0);
    const state = expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id })));
    const results = Object.fromEntries((state.perLine ?? []).map((l) => [l.productId, l.result]));
    expect(results).toEqual({ [TOTE]: "capped", [PIN]: "unavailable", [PRINT]: "out_of_stock" });
    expect(state.message).toBe("Added 1 of 3 items to your cart.");
    expect(cartQty(h, A, TOTE)).toBe(3);
    expect(cartQty(h, A, PRINT)).toBe(0);
    // again: cart already holds all stock -> capped, nothing more added, nothing revalidated
    h.revalidate.mockClear();
    const again = expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id, productId: TOTE })));
    expect(again.perLine).toEqual([{ productId: TOTE, name: expect.any(String), result: "capped" }]);
    expect(again.message).toBe("Added 0 of 1 item to your cart.");
    expect(cartQty(h, A, TOTE)).toBe(3);
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("works on a cancelled order", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 2]]);
    expectOkState(await actions(h).cancelOrder(null, form({ orderId: order.id, confirm: "yes" })));
    const state = expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id })));
    expect(state.perLine?.[0]?.result).toBe("added");
    expect(cartQty(h, A, TOTE)).toBe(2);
  });

  test("works on a shipped order", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 1]]);
    h.clock.value = NOW + 3 * DAY;
    expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id })));
    expect(cartQty(h, A, TOTE)).toBe(1);
  });

  test("two-session isolation: B cannot buy again from A's order", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 1]]);
    h.session = B;
    expectError(await actions(h).buyAgain(null, form({ orderId: order.id, sessionId: A })), "ORDER_NOT_FOUND");
    expect(cartQty(h, B, TOTE)).toBe(0);
    expect(cartQty(h, A, TOTE)).toBe(0);
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("no session: ORDER_NOT_FOUND, nothing read or written", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 1]]);
    h.session = null;
    expectError(await actions(h).buyAgain(null, form({ orderId: order.id })), "ORDER_NOT_FOUND");
    const rows = h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rate_limits").get()?.n;
    expect(rows).toBe(0);
  });

  test("malformed orderId -> INVALID_INPUT before session read", async () => {
    const h = setup();
    expectError(await actions(h).buyAgain(null, form({ orderId: "../etc" })), "INVALID_INPUT");
    expect(h.readSessionId).not.toHaveBeenCalled();
  });

  test("exception mid-way still settles and revalidates when something was added", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 1], [PIN, 1]]);
    let calls = 0;
    const cart: Pick<CartService, "addItem" | "getCart"> = {
      getCart: (s) => h.carts.getCart(s),
      addItem: (s, p, q) => {
        calls += 1;
        if (calls === 2) throw new Error("db down " + A);
        return h.carts.addItem(s, p, q);
      },
    };
    h.deps = { ...h.deps, cart };
    const state = expectError(await actions(h).buyAgain(null, form({ orderId: order.id })), "INTERNAL_ERROR");
    expect(state.message).toBe(ORDER_MESSAGES.unexpected);
    expect(h.revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain(A);
  });
});

describe("buyAgain: D-T72-1 publication guard", () => {
  test("unpublished product -> unavailable, cart untouched, no revalidate; published lines still added", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 1], [PIN, 2]]);
    h.db.run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    const addItem = mock<CartService["addItem"]>((s, p, q) => h.carts.addItem(s, p, q));
    h.deps = { ...h.deps, cart: { addItem, getCart: (s) => h.carts.getCart(s) } };
    const state = expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id })));
    const results = Object.fromEntries((state.perLine ?? []).map((l) => [l.productId, l.result]));
    expect(results).toEqual({ [TOTE]: "unavailable", [PIN]: "added" });
    expect(state.message).toBe("Added 1 of 2 items to your cart.");
    expect(cartQty(h, A, TOTE)).toBe(0);
    expect(cartQty(h, A, PIN)).toBe(2);
    expect(addItem.mock.calls.map((c) => c[1])).toEqual([PIN]);

    h.revalidate.mockClear();
    const only = expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id, productId: TOTE })));
    expect(only.perLine?.map((l) => l.result)).toEqual(["unavailable"]);
    expect(only.message).toBe("Added 0 of 1 item to your cart.");
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("publication uses the injected clock: published exactly at now counts, one ms later does not", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[TOTE, 1]]);
    const at = new Date(h.clock.value + 60 * MIN).toISOString();
    h.db.run("UPDATE products SET published_at = ? WHERE id = ?", [at, TOTE]);
    h.clock.value += 60 * MIN - 1;
    expect(expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id }))).perLine?.[0]?.result).toBe("unavailable");
    h.clock.value += 1;
    expect(expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id }))).perLine?.[0]?.result).toBe("added");
    expect(cartQty(h, A, TOTE)).toBe(1);
  });

  test("deleted product -> unavailable without calling addItem", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[PIN, 1]]);
    h.db.run("PRAGMA foreign_keys = OFF");
    h.db.run("DELETE FROM products WHERE id = ?", [PIN]);
    h.db.run("PRAGMA foreign_keys = ON");
    const addItem = mock<CartService["addItem"]>((s, p, q) => h.carts.addItem(s, p, q));
    h.deps = { ...h.deps, cart: { addItem, getCart: (s) => h.carts.getCart(s) } };
    expect(expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id }))).perLine?.[0]?.result).toBe("unavailable");
    expect(addItem).not.toHaveBeenCalled();
  });
});

describe("buyAgain: D-T72-2 per-line cap headroom", () => {
  function bigStock(h: Harness): void {
    h.db.run("UPDATE products SET stock = 1000 WHERE id = ?", [PIN]);
  }

  test("95 in cart + order line 10 -> capped, tops up to 99, revalidates", async () => {
    const h = setup();
    bigStock(h);
    const order = await placeOrder(h, A, [[PIN, 10]]);
    expect(h.carts.setQuantity(A, PIN, 95).ok).toBe(true);
    const state = expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id })));
    expect(state.perLine?.map((l) => l.result)).toEqual(["capped"]);
    expect(state.message).toBe("Added 1 of 1 item to your cart.");
    expect(cartQty(h, A, PIN)).toBe(99);
    expect(h.revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
  });

  test("cart already at 99 -> capped, nothing added, no revalidate", async () => {
    const h = setup();
    bigStock(h);
    const order = await placeOrder(h, A, [[PIN, 3]]);
    expect(h.carts.setQuantity(A, PIN, 99).ok).toBe(true);
    const state = expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id })));
    expect(state.perLine?.map((l) => l.result)).toEqual(["capped"]);
    expect(state.message).toBe("Added 0 of 1 item to your cart.");
    expect(cartQty(h, A, PIN)).toBe(99);
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("headroom that fits the whole line -> added", async () => {
    const h = setup();
    bigStock(h);
    const order = await placeOrder(h, A, [[PIN, 4]]);
    expect(h.carts.setQuantity(A, PIN, 95).ok).toBe(true);
    const state = expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id })));
    expect(state.perLine?.map((l) => l.result)).toEqual(["added"]);
    expect(cartQty(h, A, PIN)).toBe(99);
  });

  test("both limits: headroom then stock -> never exceeds stock or 99", async () => {
    const h = setup();
    const order = await placeOrder(h, A, [[PIN, 10]]);
    h.db.run("UPDATE products SET stock = 92 WHERE id = ?", [PIN]);
    expect(h.carts.setQuantity(A, PIN, 90).ok).toBe(true);
    const state = expectOkState(await actions(h).buyAgain(null, form({ orderId: order.id })));
    expect(state.perLine?.map((l) => l.result)).toEqual(["capped"]);
    expect(cartQty(h, A, PIN)).toBe(92);
  });
});

describe("addLine", () => {
  const item: OrderViewItem = { productId: "p1", name: "P", unitPriceCents: 100, quantity: 4, productSlug: null, imageUrl: null };

  function cartReturning(...results: Result<unknown>[]): { cart: Pick<CartService, "addItem">; calls: [string, string, number][] } {
    const calls: [string, string, number][] = [];
    const cart = {
      addItem: (s: string, p: string, q: number) => {
        calls.push([s, p, q]);
        return results.shift() as ReturnType<CartService["addItem"]>;
      },
    };
    return { cart, calls };
  }

  test("INSUFFICIENT_STOCK retries with details.available", () => {
    const { cart, calls } = cartReturning(fail("INSUFFICIENT_STOCK", "x", { available: 2 }), ok({}));
    expect(addLine(cart, A, item)).toEqual({ result: "capped", addedQuantity: 2 });
    expect(calls).toEqual([[A, "p1", 4], [A, "p1", 2]]);
  });

  test("INSUFFICIENT_STOCK with available 0 or garbage -> capped, no retry", () => {
    for (const available of [0, -1, "3", 1.5, undefined]) {
      const { cart, calls } = cartReturning(fail("INSUFFICIENT_STOCK", "x", { available }));
      expect(addLine(cart, A, item)).toEqual({ result: "capped", addedQuantity: 0 });
      expect(calls).toHaveLength(1);
    }
  });

  test("retry racing to OUT_OF_STOCK -> out_of_stock", () => {
    const { cart } = cartReturning(fail("INSUFFICIENT_STOCK", "x", { available: 1 }), fail("OUT_OF_STOCK", "x"));
    expect(addLine(cart, A, item)).toEqual({ result: "out_of_stock", addedQuantity: 0 });
  });

  test("headroom under the per-line cap: requests min(qty, max - inCart); added only for the full quantity", () => {
    const full = cartReturning(ok({}));
    expect(addLine(full.cart, A, item, 95)).toEqual({ result: "added", addedQuantity: 4 });
    expect(full.calls).toEqual([[A, "p1", 4]]);
    const part = cartReturning(ok({}));
    expect(addLine(part.cart, A, item, 97)).toEqual({ result: "capped", addedQuantity: 2 });
    expect(part.calls).toEqual([[A, "p1", 2]]);
    const custom = cartReturning(ok({}));
    expect(addLine(custom.cart, A, item, 8, 10)).toEqual({ result: "capped", addedQuantity: 2 });
  });

  test("no headroom (cart at or above the cap) -> capped without calling addItem", () => {
    for (const inCart of [99, 120]) {
      const { cart, calls } = cartReturning();
      expect(addLine(cart, A, item, inCart)).toEqual({ result: "capped", addedQuantity: 0 });
      expect(calls).toEqual([]);
    }
  });

  test("headroom request still retries on INSUFFICIENT_STOCK, below the headroom", () => {
    const { cart, calls } = cartReturning(fail("INSUFFICIENT_STOCK", "x", { available: 1 }), ok({}));
    expect(addLine(cart, A, item, 96)).toEqual({ result: "capped", addedQuantity: 1 });
    expect(calls).toEqual([[A, "p1", 3], [A, "p1", 1]]);
  });

  test("error code mapping", () => {
    const cases: [AppError["code"], OrderLineResult][] = [
      ["OUT_OF_STOCK", "out_of_stock"],
      ["PRODUCT_NOT_FOUND", "unavailable"],
      ["INVALID_QUANTITY", "capped"],
      ["MONEY_OVERFLOW", "unavailable"],
    ];
    for (const [code, result] of cases) {
      const { cart } = cartReturning(fail(code, "x"));
      expect(addLine(cart, A, item).result).toBe(result);
    }
  });
});
