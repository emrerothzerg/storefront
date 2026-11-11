import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { CheckoutActionState } from "@/components/organisms/_contracts/checkout-actions";
import { createCartService } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedProducts } from "@/server/db/seed";
import { createOrderService } from "@/server/orders/order-service";
import { MOCK_CARDS } from "@/server/payments/mock-payment-provider";
import {
  CHECKOUT_MESSAGES,
  createCheckoutActions,
  parseCheckoutForm,
  toRetainedValues,
  toUserSafeCheckoutError,
} from "./checkout-core";

const SESSION = "66666666-6666-4666-8666-666666666666";
const TOTE = "prod_canvas-tote-bag"; // 1999 cents, stock 42
const DESK = "prod_walnut-desk"; // 125000 cents, stock 3
const CVC = "737";

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical Way",
  line2: "",
  city: "London",
  region: "Greater London",
  postalCode: "N1 9GU",
  country: "GB",
} as const;

function cardFields(number: string): Record<string, string> {
  return { nameOnCard: "Ada L", number, expMonth: "12", expYear: String(new Date().getUTCFullYear() + 2), cvc: CVC };
}

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function checkoutForm(
  overrides: Record<string, string | Blob> = {},
  card: string = MOCK_CARDS.success,
  key: string = crypto.randomUUID(),
): FormData {
  return form({ idempotencyKey: key, ...ADDRESS, ...cardFields(card), ...overrides });
}

function setup(options: { session?: string | null } = {}) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedProducts(db);
  const cart = createCartService(db);
  const session = options.session === undefined ? SESSION : options.session;
  const getSessionId = mock(async () => session);
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const redirect = mock((url: string): never => {
    throw new RedirectSentinel(url);
  });
  const orders = createOrderService(db);
  const placeOrderSpy = mock(orders.placeOrder.bind(orders));
  const actions = createCheckoutActions({ getSessionId, orders: { placeOrder: placeOrderSpy }, redirect, revalidate });
  return { db, cart, getSessionId, revalidate, redirect, placeOrderSpy, ...actions };
}

function fill(cart: ReturnType<typeof createCartService>): void {
  expect(cart.addItem(SESSION, TOTE, 2).ok).toBe(true);
  expect(cart.addItem(SESSION, DESK, 1).ok).toBe(true);
}

function orderCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
}

function stockOf(db: Database, id: string): number {
  return (db.query("SELECT stock FROM products WHERE id = ?").get(id) as { stock: number }).stock;
}

function cartLines(db: Database) {
  return db.query("SELECT product_id AS p, quantity AS q FROM cart_items ORDER BY p").all();
}

function expectFailure(state: CheckoutActionState, code: string) {
  if (state === null || state.ok !== false) throw new Error(`expected ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code as typeof state.error.code);
  expect(state.error.message.trim()).not.toBe("");
  return state;
}

async function expectRedirect(promise: Promise<CheckoutActionState>): Promise<string> {
  try {
    await promise;
  } catch (e) {
    if (e instanceof RedirectSentinel) return e.url;
    throw e;
  }
  throw new Error("expected redirect");
}

function expectNoCardData(state: CheckoutActionState, number: string): void {
  const json = JSON.stringify(state);
  expect(json).not.toContain(number);
  expect(json).not.toContain(CVC);
  // Field-error maps may be keyed by "number"/"cvc" (value is { code, message });
  // no such key may ever carry a raw string or number value.
  expect(json).not.toMatch(/"(number|cvc|expMonth|expYear)":\s*("|-?\d)/);
  if (state !== null) {
    const values: Record<string, unknown> = { ...state.values };
    for (const key of ["number", "cvc", "expMonth", "expYear"]) expect(values[key]).toBeUndefined();
  }
}

describe("parseCheckoutForm", () => {
  test("trims address/name/expiry/key, passes number and cvc as-is, ignores extra fields", () => {
    const r = parseCheckoutForm(
      checkoutForm(
        { fullName: "  Ada  ", number: " 4242 4242 4242 4242 ", cvc: " 737 ", expMonth: " 12 ", price: "1", total: "1", sessionId: "x" },
        MOCK_CARDS.success,
        "  key-1  ",
      ),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.idempotencyKey).toBe("key-1");
    expect(r.value.address.fullName).toBe("Ada");
    expect(r.value.card.number).toBe(" 4242 4242 4242 4242 ");
    expect(r.value.card.cvc).toBe(" 737 ");
    expect(r.value.card.expMonth).toBe("12");
    expect(Object.keys(r.value).sort()).toEqual(["address", "card", "idempotencyKey"]);
    expect(Object.keys(r.value.address)).not.toContain("price");
    expect(Object.keys(r.value.card)).not.toContain("sessionId");
  });

  test("missing/blank key, missing field or File value is INVALID_INPUT", () => {
    const missingKey = checkoutForm();
    missingKey.delete("idempotencyKey");
    const missingCity = checkoutForm();
    missingCity.delete("city");
    const cases = [
      missingKey,
      checkoutForm({ idempotencyKey: "   " }),
      missingCity,
      checkoutForm({ number: new File(["x"], "x.txt") }),
      checkoutForm({ idempotencyKey: new File(["k"], "k.txt") }),
    ];
    for (const fd of cases) {
      const r = parseCheckoutForm(fd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
  });
});

describe("toRetainedValues / toUserSafeCheckoutError", () => {
  test("retains address fields and nameOnCard only", () => {
    const parsed = parseCheckoutForm(checkoutForm());
    if (!parsed.ok) throw new Error("parse failed");
    const values = toRetainedValues(parsed.value.address, parsed.value.card);
    expect(Object.keys(values).sort()).toEqual(
      ["city", "country", "email", "fullName", "line1", "line2", "nameOnCard", "postalCode", "region"].sort(),
    );
  });

  test("keeps code and details, fills messages", () => {
    expect(toUserSafeCheckoutError({ code: "EMPTY_CART", message: "" }).message).toBe(CHECKOUT_MESSAGES.emptyCart);
    expect(toUserSafeCheckoutError({ code: "MONEY_OVERFLOW", message: "raw" }).message).toBe(
      CHECKOUT_MESSAGES.moneyOverflow,
    );
    expect(toUserSafeCheckoutError({ code: "INVALID_INPUT", message: "internal", details: { field: "k" } })).toEqual({
      code: "INVALID_INPUT",
      message: CHECKOUT_MESSAGES.invalidRequest,
      details: { field: "k" },
    });
    expect(toUserSafeCheckoutError({ code: "PAYMENT_FAILED", message: "Your card was declined." }).message).toBe(
      "Your card was declined.",
    );
    expect(toUserSafeCheckoutError({ code: "PAYMENT_FAILED", message: " " }).message).toBe(
      CHECKOUT_MESSAGES.paymentFailed,
    );
    expect(toUserSafeCheckoutError({ code: "VALIDATION_FAILED", message: "" }).message).toBe(
      CHECKOUT_MESSAGES.validationFailed,
    );
  });
});

describe("placeOrder action", () => {
  test("AC1: missing idempotency key returns INVALID_INPUT with values; no order, no session read", async () => {
    const s = setup();
    fill(s.cart);
    const fd = checkoutForm();
    fd.delete("idempotencyKey");
    const state = expectFailure(await s.placeOrder(null, fd), "INVALID_INPUT");
    expect(state.values?.fullName).toBe(ADDRESS.fullName);
    expect(s.getSessionId).not.toHaveBeenCalled();
    expect(s.placeOrderSpy).not.toHaveBeenCalled();
    expect(orderCount(s.db)).toBe(0);
    expect(s.revalidate).not.toHaveBeenCalled();
  });

  test("AC1: malformed form data (File, missing field) returns INVALID_INPUT without values", async () => {
    const s = setup();
    fill(s.cart);
    const state = expectFailure(await s.placeOrder(null, checkoutForm({ cvc: new File(["1"], "c.txt") })), "INVALID_INPUT");
    expect(state.values).toBeUndefined();
    const fd = checkoutForm();
    fd.delete("country");
    expectFailure(await s.placeOrder(null, fd), "INVALID_INPUT");
    expect(s.placeOrderSpy).not.toHaveBeenCalled();
    expect(orderCount(s.db)).toBe(0);
  });

  test("AC1: an over-long key is rejected by the service as INVALID_INPUT", async () => {
    const s = setup();
    fill(s.cart);
    expectFailure(await s.placeOrder(null, checkoutForm({}, MOCK_CARDS.success, "k".repeat(129))), "INVALID_INPUT");
    expect(orderCount(s.db)).toBe(0);
  });

  test("AC2: validation failures map every invalid field and keep only non-sensitive values", async () => {
    const s = setup();
    fill(s.cart);
    const badNumber = "4242424242424241";
    const state = expectFailure(
      await s.placeOrder(null, checkoutForm({ email: "nope", city: "  ", expMonth: "13", cvc: "1" }, badNumber)),
      "VALIDATION_FAILED",
    );
    const fields = state.error.details?.fields as Record<string, { code: string; message: string }>;
    expect(Object.keys(fields).sort()).toEqual(["city", "cvc", "email", "expMonth", "number"]);
    expect(state.values).toEqual({ ...ADDRESS, email: "nope", city: "", nameOnCard: "Ada L" });
    expectNoCardData(state, badNumber);
    expect(orderCount(s.db)).toBe(0);
    expect(s.revalidate).not.toHaveBeenCalled();
  });

  test("AC3: declined card returns the user-safe message; cart and stock unchanged; no redirect", async () => {
    const s = setup();
    fill(s.cart);
    const before = { cart: cartLines(s.db), tote: stockOf(s.db, TOTE), desk: stockOf(s.db, DESK) };
    const state = expectFailure(await s.placeOrder(null, checkoutForm({}, MOCK_CARDS.declined)), "PAYMENT_FAILED");
    expect(state.error.message).toBe("Your card was declined.");
    expect(state.error.details).toEqual({ orderId: expect.any(String), failureCode: "DECLINED" });
    expect(state.values?.nameOnCard).toBe("Ada L");
    expectNoCardData(state, MOCK_CARDS.declined);
    expect(cartLines(s.db)).toEqual(before.cart);
    expect(stockOf(s.db, TOTE)).toBe(before.tote);
    expect(stockOf(s.db, DESK)).toBe(before.desk);
    expect(s.redirect).not.toHaveBeenCalled();
    expect(s.revalidate).not.toHaveBeenCalled();
  });

  test("declined, then retry with a NEW key succeeds; the old key replays the decline", async () => {
    const s = setup();
    fill(s.cart);
    const declinedKey = crypto.randomUUID();
    expectFailure(await s.placeOrder(null, checkoutForm({}, MOCK_CARDS.declined, declinedKey)), "PAYMENT_FAILED");
    const replay = expectFailure(
      await s.placeOrder(null, checkoutForm({}, MOCK_CARDS.success, declinedKey)),
      "PAYMENT_FAILED",
    );
    expect(replay.error.message).toBe("Your card was declined.");
    const url = await expectRedirect(s.placeOrder(null, checkoutForm({}, MOCK_CARDS.success)));
    expect(url).toMatch(/^\/orders\/[0-9a-f-]{36}$/);
    expect(cartLines(s.db)).toEqual([]);
  });

  test("AC4: success revalidates and redirects to /orders/{id}; replaying the same key redirects to the same order", async () => {
    const s = setup();
    fill(s.cart);
    const key = crypto.randomUUID();
    const url = await expectRedirect(s.placeOrder(null, checkoutForm({}, MOCK_CARDS.success, key)));
    const row = s.db.query("SELECT id, status FROM orders").get() as { id: string; status: string };
    expect(url).toBe(`/orders/${row.id}`);
    expect(row.status).toBe("paid");
    expect(s.revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(stockOf(s.db, TOTE)).toBe(40);
    expect(stockOf(s.db, DESK)).toBe(2);
    expect(cartLines(s.db)).toEqual([]);

    const again = await expectRedirect(s.placeOrder(null, checkoutForm({}, MOCK_CARDS.success, key)));
    expect(again).toBe(url);
    expect(orderCount(s.db)).toBe(1);
    expect(stockOf(s.db, TOTE)).toBe(40);
  });

  test("AC4: two concurrent submits with the same key create exactly one order", async () => {
    const s = setup();
    fill(s.cart);
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([
      expectRedirect(s.placeOrder(null, checkoutForm({}, MOCK_CARDS.success, key))),
      expectRedirect(s.placeOrder(null, checkoutForm({}, MOCK_CARDS.success, key))),
    ]);
    expect(a).toBe(b);
    expect(orderCount(s.db)).toBe(1);
  });

  test("AC5: the redirect URL and all revalidate args carry no card data", async () => {
    const s = setup();
    fill(s.cart);
    const url = await expectRedirect(s.placeOrder(null, checkoutForm({}, MOCK_CARDS.success)));
    const everything = JSON.stringify({ url, revalidate: s.revalidate.mock.calls, redirect: s.redirect.mock.calls });
    expect(everything).not.toContain(MOCK_CARDS.success);
    expect(everything).not.toContain("4242");
    expect(everything).not.toContain(CVC);
  });

  test("AC5: nothing card-related is logged", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      Object.assign(mock(() => undefined), { method: m, original: console[m] }),
    );
    for (const spy of spies) console[spy.method] = spy;
    try {
      const s = setup();
      fill(s.cart);
      await s.placeOrder(null, checkoutForm({}, MOCK_CARDS.declined));
      await expectRedirect(s.placeOrder(null, checkoutForm({}, MOCK_CARDS.success)));
      await s.placeOrder(null, checkoutForm({ cvc: "x" }, "1234"));
    } finally {
      for (const spy of spies) console[spy.method] = spy.original;
    }
    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    expect(logged).not.toContain(MOCK_CARDS.success);
    expect(logged).not.toContain(MOCK_CARDS.declined);
    expect(logged).not.toContain(CVC);
  });

  test("STOCK_CHANGED after stock drops below the cart quantity names the lines; nothing charged", async () => {
    const s = setup();
    fill(s.cart);
    s.db.run("UPDATE products SET stock = 1 WHERE id = ?", [TOTE]);
    const state = expectFailure(await s.placeOrder(null, checkoutForm()), "STOCK_CHANGED");
    expect(state.error.message).toBe(CHECKOUT_MESSAGES.stockChanged);
    expect(state.error.details?.lines).toEqual([
      { productId: TOTE, name: "Canvas Tote Bag", requested: 2, available: 1 },
    ]);
    expect(orderCount(s.db)).toBe(0);
    expect(stockOf(s.db, DESK)).toBe(3);
    expect(cartLines(s.db)).toHaveLength(2);
    expectNoCardData(state, MOCK_CARDS.success);
  });

  test("no session returns EMPTY_CART (checkout never creates a session)", async () => {
    const s = setup({ session: null });
    const state = expectFailure(await s.placeOrder(null, checkoutForm()), "EMPTY_CART");
    expect(state.error.message).toBe(CHECKOUT_MESSAGES.emptyCart);
    expect(state.values?.email).toBe(ADDRESS.email);
    expect(s.getSessionId).toHaveBeenCalledTimes(1);
    expect(orderCount(s.db)).toBe(0);
  });

  test("a session with an empty cart returns EMPTY_CART", async () => {
    const s = setup();
    expectFailure(await s.placeOrder(null, checkoutForm()), "EMPTY_CART");
  });

  test("unexpected exceptions are rethrown, not returned", async () => {
    const boom = new Error("db down");
    const actions = createCheckoutActions({
      getSessionId: async () => SESSION,
      orders: { placeOrder: () => Promise.reject(boom) },
      redirect: (url: string): never => {
        throw new RedirectSentinel(url);
      },
      revalidate: () => undefined,
    });
    await expect(actions.placeOrder(null, checkoutForm())).rejects.toBe(boom);
  });

  test("never passes client price/total/sessionId to the service", async () => {
    const s = setup();
    fill(s.cart);
    await expectRedirect(
      s.placeOrder(null, checkoutForm({ price: "1", total: "1", sessionId: "77777777-7777-4777-8777-777777777777" })),
    );
    const input = s.placeOrderSpy.mock.calls[0]?.[0];
    expect(input?.sessionId).toBe(SESSION);
    expect(Object.keys(input ?? {}).sort()).toEqual(["address", "card", "idempotencyKey", "sessionId"]);
    expect(JSON.stringify(input?.address)).not.toContain("price");
  });
});
