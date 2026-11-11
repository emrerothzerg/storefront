import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// QA-W3-T72: adversarial tests for the order server actions (cancelOrder,
// buyAgain, buyAgainFromForm).
//
// Part 1 drives `createOrderActions` (orders-core) with the real order
// service v2, real cart service v2 and real T31 limiter over in-memory
// SQLite, plus recording fakes (session reader, revalidatePath, logger).
// Part 2 drives the `'use server'` wrappers with `next/headers` and
// `next/cache` mocked (registered before anything imports them).
// The cross-connection race uses an OS temp dir that is removed afterwards.
// No test touches ./data.
// ---------------------------------------------------------------------------

interface SetCall {
  readonly name: string;
  readonly value: string;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];
  readonly deleteCalls: string[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  getAll(): { name: string; value: string }[] {
    return [...this.jar].map(([name, value]) => ({ name, value }));
  }
  has(name: string): boolean {
    return this.jar.has(name);
  }
  set(name: string, value: string): void {
    this.setCalls.push({ name, value });
    this.jar.set(name, value);
  }
  delete(name: string): void {
    this.deleteCalls.push(name);
    this.jar.delete(name);
  }
}

let fakeStore = new FakeCookieStore();
const wiredRevalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath: wiredRevalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
type OrderActionState = import("@/components/molecules/_contracts/order-actions").OrderActionState;
type OrderLineResult = import("@/components/molecules/_contracts/order-actions").OrderLineResult;
const { ORDER_FIELD } = await import("@/components/molecules/_contracts/order-actions");
const core = await import("@/app/actions/orders-core");
const { createOrderActions, ORDER_MESSAGES } = core;
type OrderActionDeps = import("@/app/actions/orders-core").OrderActionDeps;
const { createCartService } = await import("@/server/cart/cart-service");
type CartServiceV2 = import("@/server/cart/cart-service").CartServiceV2;
const { createOrderService } = await import("@/server/orders/order-service");
const { SqliteOrderRepository } = await import("@/server/orders/order-repository");
type OrderServiceV2 = import("@/server/orders/order-service").OrderServiceV2;
type OrderView = import("@/server/orders/order-service").OrderView;
const { createRateLimiter } = await import("@/server/security/rate-limiter");
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;
const { createDatabase, closeDatabase, getDatabase } = await import("@/server/db/client");
const { runMigrations } = await import("@/server/db/schema");
const { seedDatabase } = await import("@/server/db/seed");
const { MOCK_CARDS, createMockPaymentProvider } = await import("@/server/payments/mock-payment-provider");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { DELETED_OWNER_KEY } = await import("@/server/auth/account-repository");

const wired = await import("@/app/actions/orders");

const ROOT = join(import.meta.dir, "..", "..", "..");
const NOW = Date.parse("2026-11-04T10:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";
const TOTE = "prod_canvas-tote-bag";
const PIN = "prod_enamel-pin-set";
const PRINT = "prod_limited-print-no-1";
const UNKNOWN_ORDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical Way",
  city: "London",
  region: "LDN",
  postalCode: "N1 9GU",
  country: "GB",
};
const CARD = { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" };

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

// Console spies: every console.* line produced during a test is checked for
// ids / PII / tokens in afterEach.
const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
  spyOn(console, m).mockImplementation(() => undefined),
);
const FORBIDDEN_IN_LOGS = [S1, S2, S3, UNKNOWN_ORDER, "ada@example.com", "Ada Lovelace", "Analytical", MOCK_CARDS.success, "987"];
let extraForbidden: string[] = [];

beforeEach(() => {
  for (const s of consoleSpies) s.mockClear();
  extraForbidden = [];
});

afterEach(() => {
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) {
      const line = call.map((a) => (typeof a === "string" ? a : JSON.stringify(a) ?? String(a))).join(" ");
      for (const needle of [...FORBIDDEN_IN_LOGS, ...extraForbidden]) expect(line).not.toContain(needle);
      expect(line).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);
    }
  }
});

// ---------------------------------------------------------------------------
// Harness (part 1)
// ---------------------------------------------------------------------------

type RevalidateCall = readonly [string] | readonly [string, "page" | "layout"];

interface Harness {
  readonly db: Database;
  readonly svc: OrderServiceV2;
  readonly carts: CartServiceV2;
  readonly clock: { value: number };
  readonly revalidateCalls: RevalidateCall[];
  readonly limiterKeys: string[];
  readonly sessionReads: { n: number };
  readonly serviceCalls: string[];
  readonly logs: string[];
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
  const realLimiter = createRateLimiter(db, { now: () => clock.value });
  const h: Harness = {
    db,
    svc,
    carts,
    clock,
    revalidateCalls: [],
    limiterKeys: [],
    sessionReads: { n: 0 },
    serviceCalls: [],
    logs: [],
    session: S1,
    deps: undefined as unknown as OrderActionDeps,
  };
  const limiter: RateLimiter = {
    check: (key, rule) => {
      h.limiterKeys.push(key);
      return realLimiter.check(key, rule);
    },
  };
  h.deps = {
    orders: {
      cancelOrder: (orderId, sessionId, now) => {
        h.serviceCalls.push("cancelOrder");
        return svc.cancelOrder(orderId, sessionId, now);
      },
      getOrderView: (orderId, sessionId, now) => {
        h.serviceCalls.push("getOrderView");
        return svc.getOrderView(orderId, sessionId, now);
      },
    },
    cart: {
      addItem: (sessionId, productId, quantity) => {
        h.serviceCalls.push("addItem");
        return carts.addItem(sessionId, productId, quantity);
      },
      getCart: (sessionId) => carts.getCart(sessionId),
    },
    catalog: new SqliteOrderRepository(db),
    limiter,
    readSessionId: async () => {
      h.sessionReads.n += 1;
      return h.session;
    },
    revalidatePath: (path, type) => {
      h.revalidateCalls.push(type === undefined ? [path] : [path, type]);
    },
    now: () => clock.value,
    logger: { error: (...args: unknown[]) => void h.logs.push(args.map(String).join(" ")) },
    ...overrides,
  };
  return h;
}

function actions(h: Harness) {
  return createOrderActions(h.deps);
}

async function placeOrder(h: Harness, session: string, lines: readonly (readonly [string, number])[], coupon?: string): Promise<OrderView> {
  for (const [productId, qty] of lines) {
    const r = h.carts.addItem(session, productId, qty);
    if (!r.ok) throw new Error("addItem failed: " + r.error.code);
  }
  if (coupon !== undefined) {
    const c = h.carts.applyCoupon(session, coupon, h.clock.value);
    if (!c.ok) throw new Error("applyCoupon failed: " + c.error.code);
  }
  const placed = await h.svc.placeOrderV2(
    { sessionId: session, address: ADDRESS, card: CARD, idempotencyKey: "key-" + crypto.randomUUID() },
    h.clock.value,
  );
  if (!placed.ok) throw new Error("placeOrderV2 failed: " + placed.error.code);
  return placed.value;
}

function fd(entries: readonly (readonly [string, string])[]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

async function browserMultipart(entries: readonly (readonly [string, string])[]): Promise<FormData> {
  const f = fd([["$ACTION_REF_1", ""], ["$ACTION_1:0", '{"id":"abc","bound":"$@1"}'], ["$ACTION_KEY", "k1"], ...entries]);
  return new Request("http://localhost/orders", { method: "POST", body: f }).formData();
}

function stock(db: Database, id: string): number {
  return db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id)?.stock ?? -1;
}

function setStock(db: Database, id: string, value: number): void {
  db.run("UPDATE products SET stock = ? WHERE id = ?", [value, id]);
}

function cartQty(h: Harness, session: string, productId: string): number {
  return h.carts.getCart(session).items.find((i) => i.productId === productId)?.quantity ?? 0;
}

function orderRow(db: Database, id: string): { fulfillment_status: string; cancelled_at: string | null } | null {
  return db
    .query<{ fulfillment_status: string; cancelled_at: string | null }, [string]>(
      "SELECT fulfillment_status, cancelled_at FROM orders WHERE id = ?",
    )
    .get(id);
}

function cancelEvents(db: Database, id: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND status = 'cancelled'").get(id)?.n ?? -1;
}

function okOf(state: OrderActionState): Extract<OrderActionState, { ok: true }> {
  if (state === null || !state.ok) throw new Error("expected ok state, got " + JSON.stringify(state));
  return state;
}

function errOf(state: OrderActionState): Extract<OrderActionState, { ok: false }> {
  if (state === null || state.ok) throw new Error("expected error state, got " + JSON.stringify(state));
  expect(state.message).toBe(state.error.message);
  return state;
}

function results(state: OrderActionState): OrderLineResult[] {
  return (okOf(state).perLine ?? []).map((l) => l.result);
}

const NOT_FOUND_STATE: OrderActionState = {
  ok: false,
  error: { code: "ORDER_NOT_FOUND", message: ORDER_MESSAGES.notFound },
  message: ORDER_MESSAGES.notFound,
};

// ===========================================================================
// 1. cancelOrder: typed errors, no state change
// ===========================================================================

describe("QA T72 criterion 1: cancelOrder rejects without state change", () => {
  test("confirm variants other than exactly 'yes' -> INVALID_INPUT field confirm; nothing read, no token, no change", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 2]]);
    const stockBefore = stock(h.db, TOTE);
    const variants: (string | null)[] = ["", "YES", "yes ", " yes", "Yes", "true", "1", "on", "y", "yes\u0000", "ｙｅｓ", null];
    for (const v of variants) {
      const entries: [string, string][] = [["orderId", order.id]];
      if (v !== null) entries.push(["confirm", v]);
      const s = errOf(await actions(h).cancelOrder(null, fd(entries)));
      expect(s.error).toEqual({ code: "INVALID_INPUT", message: ORDER_MESSAGES.confirmRequired, details: { field: "confirm" } });
      expect(s.retryAfterSeconds).toBeUndefined();
    }
    expect(h.sessionReads.n).toBe(0);
    expect(h.limiterKeys).toEqual([]);
    expect(h.serviceCalls).toEqual([]);
    expect(h.revalidateCalls).toEqual([]);
    expect(orderRow(h.db, order.id)).toEqual({ fulfillment_status: "processing", cancelled_at: null });
    expect(stock(h.db, TOTE)).toBe(stockBefore);
    // Still cancellable afterwards: nothing was consumed.
    okOf(await actions(h).cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])));
  });

  test("foreign order and unknown id produce one identical ORDER_NOT_FOUND state; owner's order untouched", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    h.session = S2;
    const foreign = await actions(h).cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"], ["sessionId", S1]]));
    const unknown = await actions(h).cancelOrder(null, fd([["orderId", UNKNOWN_ORDER], ["confirm", "yes"]]));
    expect(foreign).toEqual(NOT_FOUND_STATE);
    expect(unknown).toEqual(NOT_FOUND_STATE);
    expect(JSON.stringify(foreign)).toBe(JSON.stringify(unknown));
    expect(orderRow(h.db, order.id)?.fulfillment_status).toBe("processing");
    expect(h.revalidateCalls).toEqual([]);
  });

  test("malformed ids -> INVALID_INPUT field orderId (same user text as not found), before session/limiter", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    const bad = ["", "   ", "abc", order.id.toUpperCase(), order.id.slice(0, -1), `${order.id}x`, "../orders", "x".repeat(5000), "11111111-1111-1111-8111-111111111111"];
    for (const id of bad) {
      const s = errOf(await actions(h).cancelOrder(null, fd([["orderId", id], ["confirm", "yes"]])));
      expect(s.error).toEqual({ code: "INVALID_INPUT", message: ORDER_MESSAGES.notFound, details: { field: "orderId" } });
    }
    const missing = errOf(await actions(h).cancelOrder(null, fd([["confirm", "yes"]])));
    expect(missing.error.details).toEqual({ field: "orderId" });
    const file = new FormData();
    file.append("orderId", new File([order.id], "id.txt"));
    file.append("confirm", "yes");
    expect(errOf(await actions(h).cancelOrder(null, file)).error.details).toEqual({ field: "orderId" });
    expect(h.sessionReads.n).toBe(0);
    expect(h.limiterKeys).toEqual([]);
    expect(orderRow(h.db, order.id)?.fulfillment_status).toBe("processing");
  });

  test("window: exactly 30 min is still cancellable, 30 min + 1 ms -> ORDER_NOT_CANCELLABLE with no change", async () => {
    const h = setup();
    const a = await placeOrder(h, S1, [[TOTE, 1]]);
    const b = await placeOrder(h, S1, [[PIN, 3]]);
    const pinBefore = stock(h.db, PIN);
    h.clock.value = NOW + 30 * MIN + 1;
    const late = errOf(await actions(h).cancelOrder(null, fd([["orderId", b.id], ["confirm", "yes"]])));
    expect(late.error).toEqual({ code: "ORDER_NOT_CANCELLABLE", message: ORDER_MESSAGES.notCancellable });
    expect(orderRow(h.db, b.id)?.cancelled_at).toBeNull();
    expect(stock(h.db, PIN)).toBe(pinBefore);
    expect(cancelEvents(h.db, b.id)).toBe(0);
    h.clock.value = NOW + 30 * MIN;
    okOf(await actions(h).cancelOrder(null, fd([["orderId", a.id], ["confirm", "yes"]])));
    expect(h.revalidateCalls).toEqual([["/orders"], [`/orders/${a.id}`], ["/", "layout"]]);
  });

  test("shipped (persisted) order inside the window -> ORDER_NOT_CANCELLABLE, stock untouched", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 2]]);
    h.db.run("UPDATE orders SET fulfillment_status = 'shipped' WHERE id = ?", [order.id]);
    const before = stock(h.db, TOTE);
    expect(errOf(await actions(h).cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]]))).error.code).toBe("ORDER_NOT_CANCELLABLE");
    expect(stock(h.db, TOTE)).toBe(before);
    expect(orderRow(h.db, order.id)?.fulfillment_status).toBe("shipped");
    expect(h.revalidateCalls).toEqual([]);
  });

  test("no session / garbage / tombstone owner key -> ORDER_NOT_FOUND, no limiter token, no service call", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    for (const session of [null, "not-a-uuid", "", DELETED_OWNER_KEY]) {
      h.session = session;
      expect(await actions(h).cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]]))).toEqual(NOT_FOUND_STATE);
      expect(await actions(h).buyAgain(null, fd([["orderId", order.id]]))).toEqual(NOT_FOUND_STATE);
    }
    expect(h.limiterKeys).toEqual([]);
    expect(h.serviceCalls).toEqual([]);
    expect(orderRow(h.db, order.id)?.fulfillment_status).toBe("processing");
  });
});

// ===========================================================================
// 2. Double submit
// ===========================================================================

describe("QA T72 criterion 2: double submit cancels once, stock restored once", () => {
  test("two sequential cancels: one success, second ORDER_NOT_CANCELLABLE; stock +qty exactly once; one cancelled event", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 3], [PIN, 2]]);
    const tote = stock(h.db, TOTE);
    const pin = stock(h.db, PIN);
    const first = await actions(h).cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]]));
    const second = await actions(h).cancelOrder(first, fd([["orderId", order.id], ["confirm", "yes"]]));
    expect(okOf(first)).toEqual({ ok: true, kind: "cancelled", message: ORDER_MESSAGES.cancelled });
    expect(errOf(second).error.code).toBe("ORDER_NOT_CANCELLABLE");
    expect(stock(h.db, TOTE)).toBe(tote + 3);
    expect(stock(h.db, PIN)).toBe(pin + 2);
    expect(cancelEvents(h.db, order.id)).toBe(1);
    // Revalidated only for the success.
    expect(h.revalidateCalls).toHaveLength(3);
  });

  test("two concurrent cancels (Promise.all), 10 rounds: exactly one success; stock restored exactly once", async () => {
    for (let round = 0; round < 10; round++) {
      const h = setup();
      const order = await placeOrder(h, S1, [[TOTE, 2]]);
      const before = stock(h.db, TOTE);
      const a = actions(h);
      const states = await Promise.all([
        a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])),
        a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])),
        createOrderActions(h.deps).cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])),
      ]);
      expect(states.filter((s) => s?.ok === true)).toHaveLength(1);
      for (const s of states) if (s?.ok !== true) expect(errOf(s).error.code).toBe("ORDER_NOT_CANCELLABLE");
      expect(stock(h.db, TOTE)).toBe(before + 2);
      expect(cancelEvents(h.db, order.id)).toBe(1);
      h.db.close();
    }
  });

  test("coupon redemption: released exactly once on cancel (README: releaseRedemption when the order had a coupon)", async () => {
    const h = setup();
    const usedCount = () => h.db.query<{ n: number }, []>("SELECT used_count AS n FROM coupons WHERE code = 'WELCOME10'").get()?.n ?? -1;
    const redemptions = () =>
      h.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon_code = 'WELCOME10' AND session_id = ?").get(S1)?.n ?? -1;
    const baseUsed = usedCount();
    const order = await placeOrder(h, S1, [[TOTE, 1]], "welcome10");
    expect(order.couponCode).toBe("WELCOME10");
    expect(usedCount()).toBe(baseUsed + 1);
    expect(redemptions()).toBe(1);
    const a = actions(h);
    const states = await Promise.all([
      a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])),
      a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])),
    ]);
    expect(states.filter((s) => s?.ok === true)).toHaveLength(1);
    expect(await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]]))).toMatchObject({ ok: false, error: { code: "ORDER_NOT_CANCELLABLE" } });
    expect(usedCount()).toBe(baseUsed);
    expect(redemptions()).toBe(0);
    // The session may use the coupon again (README).
    expect(h.carts.addItem(S1, PIN, 1).ok).toBe(true);
    expect(h.carts.applyCoupon(S1, "welcome10", h.clock.value).ok).toBe(true);
  });

  test("two file-DB connections in worker threads, barrier start: exactly one cancel wins, stock +qty once (12 rounds)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-t72-race-"));
    const path = join(dir, "race.sqlite");
    try {
      const db = createDatabase(path);
      runMigrations(db);
      seedDatabase(db, { now: new Date(NOW) });
      const pay = createMockPaymentProvider({ latencyMs: 0, now: () => new Date(NOW) });
      const svc = createOrderService(db, { now: () => NOW, payments: pay, inFlight: new Map() });
      const carts = createCartService(db, { now: () => NOW });
      for (let round = 0; round < 12; round++) {
        setStock(db, TOTE, 40);
        if (!carts.addItem(S1, TOTE, 3).ok) throw new Error("add failed");
        const placed = await svc.placeOrderV2({ sessionId: S1, address: ADDRESS, card: CARD, idempotencyKey: `race-${round}` }, NOW);
        if (!placed.ok) throw new Error("place failed " + placed.error.code);
        const orderId = placed.value.id;
        const before = stock(db, TOTE);
        const start = new Int32Array(new SharedArrayBuffer(4));
        const pending = Promise.all(
          [0, 1].map(
            () =>
              new Promise<{ op: string; ok: boolean; code: string }>((resolve, reject) => {
                const w = new Worker(new URL("./actions-orders-race.qa.worker.ts", import.meta.url).href);
                w.onmessage = (e: MessageEvent<{ op: string; ok: boolean; code: string }>) => {
                  resolve(e.data);
                  w.terminate();
                };
                w.onerror = (e) => reject(new Error(String(e.message)));
                w.postMessage({ path, op: "cancel", sessionId: S1, orderId, start, now: NOW + MIN });
              }),
          ),
        );
        Atomics.store(start, 0, 1);
        Atomics.notify(start, 0);
        const res = await pending;
        for (const r of res) expect(r.code).not.toMatch(/^THROW/);
        expect(res.filter((r) => r.ok)).toHaveLength(1);
        expect(res.filter((r) => !r.ok).map((r) => r.code)).toEqual(["ORDER_NOT_CANCELLABLE"]);
        expect(stock(db, TOTE)).toBe(before + 3);
        expect(cancelEvents(db, orderId)).toBe(1);
      }
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await Bun.file(path).exists()).toBe(false);
  }, 90_000);
});

// ===========================================================================
// 3. buyAgain per-line results
// ===========================================================================

describe("QA T72 criterion 3: buyAgain per-line results", () => {
  test("full add -> added at the snapshot quantity", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 2], [PIN, 5]]);
    const s = okOf(await actions(h).buyAgain(null, fd([["orderId", order.id]])));
    expect(s.kind).toBe("buy_again");
    expect(s.perLine).toEqual(order.items.map((i) => ({ productId: i.productId, name: i.name, result: "added" })));
    expect(s.message).toBe("Added 2 of 2 items to your cart.");
    expect(cartQty(h, S1, TOTE)).toBe(2);
    expect(cartQty(h, S1, PIN)).toBe(5);
  });

  test("partial: stock-limited -> capped; the retry adds exactly details.available", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[PIN, 10]]);
    setStock(h.db, PIN, 7);
    const calls: { q: number; ok: boolean; available?: unknown }[] = [];
    h.deps = {
      ...h.deps,
      cart: {
        getCart: (sid) => h.carts.getCart(sid),
        addItem: (sid, pid, q) => {
          const r = h.carts.addItem(sid, pid, q);
          calls.push(r.ok ? { q, ok: true } : { q, ok: false, available: r.error.details?.available });
          return r;
        },
      },
    };
    expect(results(await actions(h).buyAgain(null, fd([["orderId", order.id]])))).toEqual(["capped"]);
    expect(calls).toEqual([{ q: 10, ok: false, available: 7 }, { q: 7, ok: true }]);
    expect(cartQty(h, S1, PIN)).toBe(7);
    // Already holding all stock: capped, nothing more added, no revalidate.
    h.revalidateCalls.length = 0;
    const again = okOf(await actions(h).buyAgain(null, fd([["orderId", order.id]])));
    expect(results(again)).toEqual(["capped"]);
    expect(again.message).toBe("Added 0 of 1 item to your cart.");
    expect(cartQty(h, S1, PIN)).toBe(7);
    expect(h.revalidateCalls).toEqual([]);
  });

  test("cart already at 99 -> capped with nothing added and no revalidate", async () => {
    const h = setup();
    setStock(h.db, PIN, 1000);
    const order = await placeOrder(h, S1, [[PIN, 4]]);
    expect(h.carts.setQuantity(S1, PIN, 99).ok).toBe(true);
    expect(results(await actions(h).buyAgain(null, fd([["orderId", order.id]])))).toEqual(["capped"]);
    expect(cartQty(h, S1, PIN)).toBe(99);
    expect(h.revalidateCalls).toEqual([]);
  });

  test("zero stock -> out_of_stock; deleted product -> unavailable", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1], [PIN, 1], [PRINT, 1]]);
    setStock(h.db, TOTE, 0);
    h.db.run("PRAGMA foreign_keys = OFF");
    h.db.run("DELETE FROM products WHERE id = ?", [PIN]);
    setStock(h.db, PRINT, 5);
    const s = okOf(await actions(h).buyAgain(null, fd([["orderId", order.id]])));
    const byId = new Map((s.perLine ?? []).map((l) => [l.productId, l.result]));
    expect(byId.get(TOTE)).toBe("out_of_stock");
    expect(byId.get(PIN)).toBe("unavailable");
    expect(byId.get(PRINT)).toBe("added");
    expect(s.message).toBe("Added 1 of 3 items to your cart.");
    expect(h.carts.getCart(S1).items.map((i) => i.productId)).toEqual([PRINT]);
  });

  test("evidence D-T72-1 (fixed): the order service and the action agree an unpublished product is not purchasable", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    h.db.run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    // The order service itself says it is not purchasable:
    const line = h.svc.getBuyAgainLines(S1).find((l) => l.productId === TOTE);
    expect(line?.available).toBe(false);
    expect(line?.product).toBeNull();
    // ...and the action now agrees: unavailable, nothing written, addItem never called.
    h.serviceCalls.length = 0;
    expect(results(await actions(h).buyAgain(null, fd([["orderId", order.id]])))).toEqual(["unavailable"]);
    expect(cartQty(h, S1, TOTE)).toBe(0);
    expect(h.serviceCalls).not.toContain("addItem");
  });

  test("DEFECT D-T72-1 (fixed): unpublished product -> unavailable, nothing added", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    h.db.run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    expect(results(await actions(h).buyAgain(null, fd([["orderId", order.id]])))).toEqual(["unavailable"]);
    expect(cartQty(h, S1, TOTE)).toBe(0);
  });

  test("evidence D-T72-2 (fixed): cart holds 95 of a well-stocked product, order line 10 -> 'capped' and the 4 allowed units are added", async () => {
    const h = setup();
    setStock(h.db, PIN, 1000);
    const order = await placeOrder(h, S1, [[PIN, 10]]);
    expect(h.carts.setQuantity(S1, PIN, 95).ok).toBe(true);
    const s = okOf(await actions(h).buyAgain(null, fd([["orderId", order.id]])));
    expect(results(s)).toEqual(["capped"]);
    expect(cartQty(h, S1, PIN)).toBe(99);
    expect(s.message).toBe("Added 1 of 1 item to your cart.");
    // The cart is now full for this line:
    expect(h.carts.addItem(S1, PIN, 1).ok).toBe(false);
  });

  test("DEFECT D-T72-2 (fixed): per-line 99 cap -> capped adds up to 99 (95 in cart + order 10 -> 99)", async () => {
    const h = setup();
    setStock(h.db, PIN, 1000);
    const order = await placeOrder(h, S1, [[PIN, 10]]);
    expect(h.carts.setQuantity(S1, PIN, 95).ok).toBe(true);
    const s = okOf(await actions(h).buyAgain(null, fd([["orderId", order.id]])));
    expect(results(s)).toEqual(["capped"]);
    expect(cartQty(h, S1, PIN)).toBe(99);
    expect(h.revalidateCalls).toContainEqual(["/cart"]);
  });

  test("property (150 random orders/stock/cart states): never exceeds stock or 99; labels consistent with the cart delta", async () => {
    const h = setup();
    const template = await placeOrder(h, S1, [[TOTE, 1]]);
    const baseItem = template.items[0];
    if (baseItem === undefined) throw new Error("no item");
    // Published products only: the seed future-dates a few, and the cart (on the harness clock) rejects those.
    const ids = h.db
      .query<{ id: string }, [string]>("SELECT id FROM products WHERE published_at <= ? ORDER BY id")
      .all(new Date(h.clock.value).toISOString())
      .map((r) => r.id);
    let seed = 0x7a72;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const stocks = [0, 1, 2, 5, 42, 98, 99, 100, 150, 1000];
    const seen = new Set<OrderLineResult>();
    for (let iter = 0; iter < 150; iter++) {
      const session = crypto.randomUUID();
      const picked = new Set<string>();
      const n = 1 + rand(6);
      while (picked.size < n) picked.add(ids[rand(ids.length)] ?? TOTE);
      const lines = [...picked].map((productId) => ({ productId, qty: 1 + rand(99) }));
      if (rand(5) === 0) lines.push({ productId: `prod_qa-missing-${iter}`, qty: 1 + rand(10) });
      const before = new Map<string, { stock: number; existing: number }>();
      for (const l of lines) {
        if (l.productId.startsWith("prod_qa-missing")) continue;
        const st = stocks[rand(stocks.length)] ?? 0;
        setStock(h.db, l.productId, Math.max(st, 1));
        const existing = rand(3) === 0 ? 0 : rand(Math.min(99, Math.max(st, 1)) + 1);
        if (existing > 0) expect(h.carts.setQuantity(session, l.productId, existing).ok).toBe(true);
        setStock(h.db, l.productId, st);
        before.set(l.productId, { stock: st, existing });
      }
      const view: OrderView = {
        ...template,
        items: lines.map((l) => ({ ...baseItem, productId: l.productId, name: `Line ${l.productId}`, quantity: l.qty })),
      };
      h.session = session;
      const a = createOrderActions({ ...h.deps, orders: { cancelOrder: h.svc.cancelOrder.bind(h.svc), getOrderView: () => view } });
      const s = okOf(await a.buyAgain(null, fd([["orderId", template.id], ["quantity", "99"], ["price", "1"]])));
      expect(s.perLine).toHaveLength(lines.length);
      let addedLines = 0;
      for (const [i, l] of lines.entries()) {
        const r = s.perLine?.[i]?.result;
        if (r === undefined) throw new Error("missing perLine");
        seen.add(r);
        const after = cartQty(h, session, l.productId);
        const b = before.get(l.productId);
        if (b === undefined) {
          expect(r).toBe("unavailable");
          expect(after).toBe(0);
          continue;
        }
        const delta = after - b.existing;
        expect(delta).toBeGreaterThanOrEqual(0);
        expect(after).toBeLessThanOrEqual(99);
        if (delta > 0) expect(after).toBeLessThanOrEqual(b.stock);
        if (r === "added") expect(delta).toBe(l.qty);
        if (r === "capped") expect(delta).toBeLessThan(l.qty);
        if (r === "out_of_stock") {
          expect(b.stock).toBe(0);
          expect(delta).toBe(0);
        }
        if (r === "unavailable") expect(delta).toBe(0);
        if (delta > 0) addedLines += 1;
      }
      expect(s.message).toBe(`Added ${addedLines} of ${lines.length} ${lines.length === 1 ? "item" : "items"} to your cart.`);
    }
    expect([...seen].sort()).toEqual(["added", "capped", "out_of_stock", "unavailable"]);
  });

  test("forged price / unitPriceCents / quantity / sessionId / totals are ignored; only ORDER_FIELD names are read", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 2]]);
    const priceBefore = h.carts.getCart(S1).items.length;
    expect(priceBefore).toBe(0);

    const read: string[] = [];
    // Recording proxy over a real FormData: logs every accessor and the field name it asks for.
    const record = (target: FormData): FormData =>
      new Proxy(target, {
        get(t, prop, receiver) {
          const value: unknown = Reflect.get(t, prop, receiver);
          if (typeof value !== "function") return value;
          const fn = value as (...args: unknown[]) => unknown;
          if (prop === "append") return fn.bind(t);
          return (...args: unknown[]) => {
            read.push(typeof args[0] === "string" ? `${String(prop)}:${args[0]}` : String(prop));
            return fn.apply(t, args);
          };
        },
      });
    const make = (extra: readonly (readonly [string, string])[]): FormData => {
      const f = new FormData();
      for (const [k, v] of [
        ["price", "1"],
        ["priceCents", "1"],
        ["unitPriceCents", "1"],
        ["quantity", "50"],
        ["sessionId", S2],
        ["totalCents", "0"],
        ["subtotalCents", "0"],
        ["ownerKey", S2],
        ...extra,
      ] as const)
        f.append(k, v);
      return record(f);
    };
    const s = okOf(await actions(h).buyAgain(null, make([["orderId", order.id]])));
    expect(results(s)).toEqual(["added"]);
    expect(cartQty(h, S1, TOTE)).toBe(2);
    expect(cartQty(h, S2, TOTE)).toBe(0);
    const line = h.carts.getCart(S1).items[0];
    expect(line?.unitPriceCents).toBe(order.items[0]?.unitPriceCents);
    okOf(await actions(h).cancelOrder(null, make([["orderId", order.id], ["confirm", "yes"]])));
    const allowed = new Set<string>(Object.values(ORDER_FIELD));
    expect(read).toContain("get:orderId");
    expect(read).toContain("get:productId");
    expect(read).toContain("get:confirm");
    for (const r of read) {
      const [, name] = r.split(":");
      expect(name === undefined ? r : allowed.has(name) ? "ok" : r).toBe("ok");
    }
  });

  test("productId restricts to that line only; blank productId = every line; not-in-order / too long -> INVALID_INPUT field productId", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 2], [PIN, 3]]);
    const one = okOf(await actions(h).buyAgain(null, fd([["orderId", order.id], ["productId", ` ${PIN} `]])));
    expect(one.perLine?.map((l) => l.productId)).toEqual([PIN]);
    expect(one.message).toBe("Added 1 of 1 item to your cart.");
    expect(cartQty(h, S1, PIN)).toBe(3);
    expect(cartQty(h, S1, TOTE)).toBe(0);

    const all = okOf(await actions(h).buyAgain(null, fd([["orderId", order.id], ["productId", "   "]])));
    expect(all.perLine).toHaveLength(2);

    h.revalidateCalls.length = 0;
    for (const pid of [PRINT, "prod_does-not-exist", "x".repeat(129), "x".repeat(600)]) {
      const s = errOf(await actions(h).buyAgain(null, fd([["orderId", order.id], ["productId", pid]])));
      expect(s.error).toEqual({ code: "INVALID_INPUT", message: ORDER_MESSAGES.lineNotFound, details: { field: "productId" } });
    }
    expect(cartQty(h, S1, PRINT)).toBe(0);
    expect(h.revalidateCalls).toEqual([]);
  });

  test("buyAgain on a foreign order: ORDER_NOT_FOUND identical to unknown, nothing written to either cart", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    h.session = S2;
    const foreign = await actions(h).buyAgain(null, fd([["orderId", order.id], ["sessionId", S1]]));
    const unknown = await actions(h).buyAgain(null, fd([["orderId", UNKNOWN_ORDER]]));
    expect(foreign).toEqual(NOT_FOUND_STATE);
    expect(unknown).toEqual(NOT_FOUND_STATE);
    expect(cartQty(h, S1, TOTE)).toBe(0);
    expect(cartQty(h, S2, TOTE)).toBe(0);
    expect(h.revalidateCalls).toEqual([]);
  });

  test("concurrent buyAgain on a stock-limited line (Promise.all x4) never exceeds stock", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[PIN, 6]]);
    setStock(h.db, PIN, 10);
    const a = actions(h);
    const states = await Promise.all([0, 1, 2, 3].map(() => a.buyAgain(null, fd([["orderId", order.id]]))));
    expect(states.map((s) => results(s)[0])).toEqual(["added", "capped", "capped", "capped"]);
    expect(cartQty(h, S1, PIN)).toBe(10);
  });
});

// ===========================================================================
// 4. Sessions and revalidation
// ===========================================================================

describe("QA T72 criterion 4: no session minted; exact revalidation", () => {
  test("cancel success revalidates exactly /orders, /orders/<id>, ('/', 'layout') in that order", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    okOf(await actions(h).cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])));
    expect(h.revalidateCalls).toEqual([["/orders"], [`/orders/${order.id}`], ["/", "layout"]]);
  });

  test("buy again with something added revalidates exactly /cart + ('/', 'layout'), once each", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1], [PIN, 1]]);
    okOf(await actions(h).buyAgain(null, fd([["orderId", order.id]])));
    expect(h.revalidateCalls).toEqual([["/cart"], ["/", "layout"]]);
  });

  test("failures never revalidate (every error path); buy again with nothing added never revalidates", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    const a = actions(h);
    await a.cancelOrder(null, fd([["orderId", order.id]]));
    await a.cancelOrder(null, fd([["orderId", "bad"], ["confirm", "yes"]]));
    await a.cancelOrder(null, fd([["orderId", UNKNOWN_ORDER], ["confirm", "yes"]]));
    await a.buyAgain(null, fd([["orderId", "bad"]]));
    await a.buyAgain(null, fd([["orderId", order.id], ["productId", PIN]]));
    h.clock.value = NOW + HOUR;
    await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]]));
    setStock(h.db, TOTE, 0);
    expect(results(await a.buyAgain(null, fd([["orderId", order.id]])))).toEqual(["out_of_stock"]);
    h.session = null;
    await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]]));
    expect(h.revalidateCalls).toEqual([]);
  });
});

// ===========================================================================
// 5. Rate limit
// ===========================================================================

describe("QA T72 criterion 5: 60 order mutations / hour per owner, shared", () => {
  test("cancel + buyAgain share one budget; 61st -> RATE_LIMITED, retryAfterSeconds in (0, 3600], no service call", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    const a = actions(h);
    for (let i = 0; i < 60; i++) {
      const s = i % 2 === 0
        ? await a.buyAgain(null, fd([["orderId", UNKNOWN_ORDER]]))
        : await a.cancelOrder(null, fd([["orderId", UNKNOWN_ORDER], ["confirm", "yes"]]));
      expect(errOf(s).error.code).toBe("ORDER_NOT_FOUND");
    }
    expect(new Set(h.limiterKeys)).toEqual(new Set([`orders.mutate:${S1}`]));
    h.serviceCalls.length = 0;
    h.clock.value = NOW + 10 * MIN;
    for (const s of [
      await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])),
      await a.buyAgain(null, fd([["orderId", order.id]])),
    ]) {
      const e = errOf(s);
      expect(e.error.code).toBe("RATE_LIMITED");
      expect(typeof e.retryAfterSeconds).toBe("number");
      expect(e.retryAfterSeconds ?? 0).toBeGreaterThan(0);
      expect(e.retryAfterSeconds ?? 0).toBeLessThanOrEqual(3600);
      expect(e.error.details).toEqual({ retryAfterSeconds: e.retryAfterSeconds });
      expect(e.message).toMatch(/^You have made several order changes recently\. Please try again in \d+ minutes?\.$/);
    }
    expect(h.serviceCalls).toEqual([]);
    expect(orderRow(h.db, order.id)?.fulfillment_status).toBe("processing");
    expect(h.revalidateCalls).toEqual([]);
  });

  test("validation failures spend no token (confirm, orderId, productId too long)", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    const a = actions(h);
    for (let i = 0; i < 100; i++) {
      await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "no"]]));
      await a.cancelOrder(null, fd([["orderId", "nope"], ["confirm", "yes"]]));
      await a.buyAgain(null, fd([["orderId", "nope"]]));
      await a.buyAgain(null, fd([["orderId", order.id], ["productId", "x".repeat(200)]]));
    }
    expect(h.limiterKeys).toEqual([]);
    okOf(await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])));
  });

  test("budgets are per owner; window resets in the next hour", async () => {
    const h = setup();
    const a = actions(h);
    for (let i = 0; i < 60; i++) await a.buyAgain(null, fd([["orderId", UNKNOWN_ORDER]]));
    expect(errOf(await a.buyAgain(null, fd([["orderId", UNKNOWN_ORDER]]))).error.code).toBe("RATE_LIMITED");
    h.session = S2;
    expect(errOf(await a.buyAgain(null, fd([["orderId", UNKNOWN_ORDER]]))).error.code).toBe("ORDER_NOT_FOUND");
    h.session = S1;
    h.clock.value = NOW + HOUR;
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    okOf(await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])));
  });

  test("limiter fault (fails closed) -> RATE_LIMITED state, no service call", async () => {
    const h = setup();
    const broken = createDatabase(":memory:");
    broken.close();
    const a = createOrderActions({ ...h.deps, limiter: createRateLimiter(broken, { now: () => h.clock.value, logger: { error: () => undefined } }) });
    const e = errOf(await a.buyAgain(null, fd([["orderId", UNKNOWN_ORDER]])));
    expect(e.error.code).toBe("RATE_LIMITED");
    expect(e.retryAfterSeconds).toBe(3600);
    expect(e.message).toBe("You have made several order changes recently. Please try again in 60 minutes.");
    expect(h.serviceCalls).toEqual([]);
  });
});

// ===========================================================================
// 6. Privacy / robustness (core)
// ===========================================================================

describe("QA T72 criterion 6: robustness and privacy (core)", () => {
  test("throwing service / cart / session reader / limiter -> settled generic INTERNAL_ERROR; log carries no ids or messages", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    const secret = `SQLITE_BUSY near ${order.id} ada@example.com`;
    extraForbidden = [order.id, "SQLITE_BUSY"];
    const boom = (): never => {
      throw new Error(secret);
    };
    const variants: Partial<OrderActionDeps>[] = [
      { orders: { cancelOrder: boom, getOrderView: boom } },
      { cart: { addItem: boom, getCart: boom } },
      { readSessionId: async () => boom() },
      { limiter: { check: boom } },
    ];
    for (const v of variants) {
      const a = createOrderActions({ ...h.deps, ...v });
      for (const s of [
        await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])),
        await a.buyAgain(null, fd([["orderId", order.id]])),
      ]) {
        if (s?.ok === true) continue; // e.g. cart throwing does not affect cancel
        expect(s).toEqual({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: ORDER_MESSAGES.unexpected },
          message: ORDER_MESSAGES.unexpected,
        });
        expect(JSON.parse(JSON.stringify(s))).toEqual(s);
      }
    }
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) {
      expect(line).toMatch(/^\[orders\] ORDER_ACTION_FAILED action=(cancelOrder|buyAgain)$/);
    }
  });

  test("a non-Error throw (string / undefined / object) still settles", async () => {
    const h = setup();
    for (const thrown of ["x", undefined, { toString: () => { throw new Error("nested"); } }]) {
      const a = createOrderActions({
        ...h.deps,
        orders: {
          cancelOrder: () => {
            throw thrown;
          },
          getOrderView: () => {
            throw thrown;
          },
        },
      });
      expect(errOf(await a.cancelOrder(null, fd([["orderId", UNKNOWN_ORDER], ["confirm", "yes"]]))).error.code).toBe("INTERNAL_ERROR");
      expect(errOf(await a.buyAgain(null, fd([["orderId", UNKNOWN_ORDER]]))).error.code).toBe("INTERNAL_ERROR");
    }
  });

  test("unexpected service error codes never leak details (mapped to INTERNAL_ERROR)", async () => {
    const h = setup();
    const a = createOrderActions({
      ...h.deps,
      orders: {
        cancelOrder: () => ({ ok: false, error: { code: "VALIDATION_FAILED", message: `secret ${S1}`, details: { sessionId: S1 } } }),
        getOrderView: () => null,
      },
    });
    const s = errOf(await a.cancelOrder(null, fd([["orderId", UNKNOWN_ORDER], ["confirm", "yes"]])));
    expect(s.error).toEqual({ code: "INTERNAL_ERROR", message: ORDER_MESSAGES.unexpected });
    expect(JSON.stringify(s)).not.toContain(S1);
  });

  test("observation: revalidatePath throwing after a committed cancel reports INTERNAL_ERROR though the cancel persisted (consistency pass item c)", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    const a = createOrderActions({
      ...h.deps,
      revalidatePath: () => {
        throw new Error("revalidate failed");
      },
    });
    expect(errOf(await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]]))).error.code).toBe("INTERNAL_ERROR");
    expect(orderRow(h.db, order.id)?.fulfillment_status).toBe("cancelled");
  });

  test("states are plain JSON-serialisable and carry no owner key", async () => {
    const h = setup();
    const order = await placeOrder(h, S1, [[TOTE, 1]]);
    const a = actions(h);
    const states = [
      await a.buyAgain(null, fd([["orderId", order.id]])),
      await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])),
      await a.cancelOrder(null, fd([["orderId", order.id], ["confirm", "yes"]])),
    ];
    for (const s of states) {
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
      expect(JSON.stringify(s)).not.toContain(S1);
    }
  });
});

// ===========================================================================
// Part 2: wired 'use server' wrappers (next/headers + next/cache mocked)
// ===========================================================================

async function wiredPlace(session: string, lines: readonly (readonly [string, number])[]): Promise<string> {
  const { getCartService } = await import("@/server/cart/cart-service");
  const { getOrderService } = await import("@/server/orders/order-service");
  for (const [p, q] of lines) if (!getCartService().addItem(session, p, q).ok) throw new Error("add failed");
  const placed = await getOrderService().placeOrderV2({ sessionId: session, address: ADDRESS, card: CARD, idempotencyKey: "key-" + crypto.randomUUID() });
  if (!placed.ok) throw new Error("place failed " + placed.error.code);
  return placed.value.id;
}

function wiredStock(id: string): number {
  return getDatabase().query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id)?.stock ?? -1;
}

describe("QA T72 wired actions (module shape, cookies, multipart)", () => {
  beforeEach(() => {
    env.DATABASE_PATH = ":memory:";
    closeDatabase();
    seedDatabase(getDatabase());
    fakeStore = new FakeCookieStore();
    wiredRevalidatePath.mockClear();
  });

  test("orders.ts: 'use server' first, exports only async functions (source + runtime)", () => {
    const src = readFileSync(join(ROOT, "src/app/actions/orders.ts"), "utf8");
    expect(src.trimStart().startsWith('"use server";')).toBe(true);
    const exportLines = src.split("\n").filter((l) => l.startsWith("export"));
    for (const l of exportLines) expect(l).toMatch(/^export async function \w+\(/);
    expect(Object.keys(wired).sort()).toEqual(["buyAgain", "buyAgainFromForm", "cancelOrder"]);
    for (const v of Object.values(wired)) expect((v as () => unknown).constructor.name).toBe("AsyncFunction");
  });

  test("importing orders.ts in a fresh process opens no database", async () => {
    const probeDb = join(tmpdir(), `qa-t72-probe-${process.pid}.sqlite`);
    const script = [
      `const before = globalThis.__storefrontDb;`,
      `await import(${JSON.stringify(join(ROOT, "src/app/actions/orders.ts"))});`,
      `console.log(JSON.stringify({ before: before === undefined, after: globalThis.__storefrontDb === undefined }));`,
    ].join("\n");
    const proc = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, env: { ...process.env, DATABASE_PATH: probeDb }, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString().trim().split("\n").pop() ?? "")).toEqual({ before: true, after: true });
    expect(await Bun.file(probeDb).exists()).toBe(false);
  });

  test("no cookie: all three actions -> ORDER_NOT_FOUND; cookies().set never called; garbage cookie not rewritten", async () => {
    const orderId = await wiredPlace(S1, [[TOTE, 1]]);
    expect(await wired.cancelOrder(null, fd([["orderId", orderId], ["confirm", "yes"]]))).toEqual(NOT_FOUND_STATE);
    expect(await wired.buyAgain(null, fd([["orderId", orderId]]))).toEqual(NOT_FOUND_STATE);
    expect(await wired.buyAgainFromForm(fd([["orderId", orderId]]))).toEqual(NOT_FOUND_STATE);
    fakeStore.jar.set(SESSION_COOKIE_NAME, "garbage");
    expect(await wired.cancelOrder(null, fd([["orderId", orderId], ["confirm", "yes"], ["sessionId", S1]]))).toEqual(NOT_FOUND_STATE);
    expect(await wired.buyAgainFromForm(fd([["orderId", orderId], ["sessionId", S1]]))).toEqual(NOT_FOUND_STATE);
    expect(fakeStore.setCalls).toEqual([]);
    expect(fakeStore.deleteCalls).toEqual([]);
    expect(wiredRevalidatePath).not.toHaveBeenCalled();
    const sessions = getDatabase().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM carts").get()?.n;
    expect(sessions).toBe(0);
  });

  test("browser multipart with $ACTION_* fields: buyAgain, buyAgainFromForm, cancelOrder succeed; exact revalidate args; no cookie set", async () => {
    const orderId = await wiredPlace(S1, [[TOTE, 2]]);
    fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
    const before = wiredStock(TOTE);
    const b = okOf(await wired.buyAgain(null, await browserMultipart([["orderId", orderId], ["sessionId", S2], ["price", "1"]])));
    expect(results(b)).toEqual(["added"]);
    expect(wiredRevalidatePath.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    wiredRevalidatePath.mockClear();
    const f = okOf(await wired.buyAgainFromForm(await browserMultipart([["orderId", orderId]])));
    expect(results(f)).toEqual(["added"]);
    expect(wiredRevalidatePath.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    wiredRevalidatePath.mockClear();
    const c = okOf(await wired.cancelOrder(null, await browserMultipart([["orderId", orderId], ["confirm", "yes"]])));
    expect(c.kind).toBe("cancelled");
    expect(wiredRevalidatePath.mock.calls).toEqual([["/orders"], [`/orders/${orderId}`], ["/", "layout"]]);
    expect(wiredStock(TOTE)).toBe(before + 2);
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("wired double submit (Promise.all): exactly one cancel, stock restored once", async () => {
    const orderId = await wiredPlace(S1, [[PIN, 4]]);
    fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
    const before = wiredStock(PIN);
    const states = await Promise.all([
      wired.cancelOrder(null, fd([["orderId", orderId], ["confirm", "yes"]])),
      wired.cancelOrder(null, fd([["orderId", orderId], ["confirm", "yes"]])),
    ]);
    expect(states.filter((s) => s?.ok === true)).toHaveLength(1);
    expect(wiredStock(PIN)).toBe(before + 4);
  });

  test("buyAgainFromForm shares the 60/hour budget with cancel and buyAgain; validation errors identical to buyAgain", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, S3);
    for (let i = 0; i < 20; i++) await wired.buyAgainFromForm(fd([["orderId", UNKNOWN_ORDER]]));
    for (let i = 0; i < 20; i++) await wired.buyAgain(null, fd([["orderId", UNKNOWN_ORDER]]));
    for (let i = 0; i < 20; i++) await wired.cancelOrder(null, fd([["orderId", UNKNOWN_ORDER], ["confirm", "yes"]]));
    expect(errOf(await wired.buyAgainFromForm(fd([["orderId", UNKNOWN_ORDER]]))).error.code).toBe("RATE_LIMITED");
    expect(errOf(await wired.cancelOrder(null, fd([["orderId", UNKNOWN_ORDER], ["confirm", "yes"]]))).error.code).toBe("RATE_LIMITED");
    expect(await wired.buyAgainFromForm(fd([["orderId", "bad"]]))).toEqual(await wired.buyAgain(null, fd([["orderId", "bad"]])));
    expect(errOf(await wired.cancelOrder(null, fd([["orderId", UNKNOWN_ORDER]]))).error.details).toEqual({ field: "confirm" });
  });

  test("database cannot open: every wrapper settles with the generic INTERNAL_ERROR state; clean log lines", async () => {
    closeDatabase();
    env.DATABASE_PATH = "/dev/null/qa-t72/cannot.sqlite";
    try {
      fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
      const generic: OrderActionState = { ok: false, error: { code: "INTERNAL_ERROR", message: ORDER_MESSAGES.unexpected }, message: ORDER_MESSAGES.unexpected };
      expect(await wired.cancelOrder(null, fd([["orderId", UNKNOWN_ORDER], ["confirm", "yes"]]))).toEqual(generic);
      expect(await wired.buyAgain(null, fd([["orderId", UNKNOWN_ORDER]]))).toEqual(generic);
      expect(await wired.buyAgainFromForm(fd([["orderId", UNKNOWN_ORDER]]))).toEqual(generic);
      let lines = 0;
      for (const spy of consoleSpies) {
        for (const call of spy.mock.calls) {
          lines += 1;
          expect(call).toHaveLength(1);
          expect(String(call[0])).toMatch(/^\[orders\] ORDER_ACTION_FAILED action=(cancelOrder|buyAgain) stage=init$/);
        }
      }
      expect(lines).toBe(3);
      expect(fakeStore.setCalls).toEqual([]);
    } finally {
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});

// ===========================================================================
// 7. Isolation
// ===========================================================================

describe("QA T72 isolation", () => {
  test("data/ holds only .gitkeep (no test touched the real database)", async () => {
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(ROOT, "data")).filter((n) => !n.startsWith("storefront.sqlite")).sort()).toEqual([".gitkeep"]); // dev DB allowed
  });
});
