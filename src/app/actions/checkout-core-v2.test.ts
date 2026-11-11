import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  CHECKOUT_FIELD_V2,
  CHECKOUT_NOTICE,
  parseCheckoutNotice,
  type CheckoutActionStateV2,
} from "@/components/organisms/_contracts/checkout-actions";
import { validateCard } from "@/lib/validation";
import { AddressStorageError, createAddressService, type AddressService } from "@/server/addresses/address-service";
import { createCartService } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createOrderService, type OrderServiceV2 } from "@/server/orders/order-service";
import { MOCK_CARDS, createMockPaymentProvider } from "@/server/payments/mock-payment-provider";
import { createRateLimiter, type RateLimiter } from "@/server/security/rate-limiter";
import {
  CHECKOUT_ACTION_FAILED,
  CHECKOUT_MESSAGES,
  CHECKOUT_MESSAGES_V2,
  createCheckoutActionsV2,
  orderPlacedHref,
  parseCheckoutFieldsV2,
  toCardInput,
  toRetainedValuesV2,
  type CheckoutActionDepsV2,
} from "./checkout-core";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const TOTE = "prod_canvas-tote-bag"; // 1999 cents, stock 42
const PIN = "prod_enamel-pin-set"; // 50 cents, stock 100
const CVC = "737";
const YEAR = String(new Date().getUTCFullYear() + 2);

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

const SAVED = {
  fullName: "Grace Hopper",
  line1: "7 Compiler Road",
  line2: "Suite 9",
  city: "Arlington",
  region: "VA",
  postalCode: "22201",
  country: "US",
  label: "Work",
  phone: "+1 555 0100",
} as const;

function cardFields(number: string = MOCK_CARDS.success): Record<string, string> {
  return { nameOnCard: "Ada L", number, expMonth: "12", expYear: YEAR, cvc: CVC };
}

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** New-address post (MVP shape unless overridden). */
function newForm(overrides: Record<string, string | Blob> = {}, card: string = MOCK_CARDS.success): FormData {
  return form({ idempotencyKey: crypto.randomUUID(), ...ADDRESS, ...cardFields(card), ...overrides });
}

/** Saved-address post: only mode, id, email and card. */
function savedForm(addressId: string, overrides: Record<string, string | Blob> = {}, card: string = MOCK_CARDS.success): FormData {
  return form({
    idempotencyKey: crypto.randomUUID(),
    addressMode: "saved",
    addressId,
    email: "grace@example.com",
    ...cardFields(card),
    ...overrides,
  });
}

interface Harness {
  readonly db: Database;
  readonly cart: ReturnType<typeof createCartService>;
  readonly orders: OrderServiceV2;
  readonly addresses: AddressService;
  readonly charge: ReturnType<typeof mock>;
  readonly placeSpy: ReturnType<typeof mock>;
  readonly getSessionId: ReturnType<typeof mock>;
  readonly revalidate: ReturnType<typeof mock>;
  readonly redirect: ReturnType<typeof mock>;
  readonly rethrow: ReturnType<typeof mock>;
  readonly logs: string[];
  readonly placeOrderV2: (prev: CheckoutActionStateV2, fd: FormData) => Promise<CheckoutActionStateV2>;
}

interface SetupOptions {
  readonly session?: string | null;
  readonly addresses?: (real: AddressService) => Pick<AddressService, "get" | "create">;
  readonly orders?: (real: OrderServiceV2) => Pick<OrderServiceV2, "placeOrderV2">;
  readonly limiter?: (real: RateLimiter) => RateLimiter;
}

function setup(options: SetupOptions = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const cart = createCartService(db);
  const pay = createMockPaymentProvider({ latencyMs: 0 });
  const charge = mock(pay.charge.bind(pay));
  const orders = createOrderService(db, { payments: { charge }, inFlight: new Map() });
  const addresses = createAddressService({ db, logger: { error: () => undefined, warn: () => undefined } });
  const session = options.session === undefined ? S1 : options.session;
  const getSessionId = mock(async () => session);
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const redirect = mock((url: string): never => {
    throw new RedirectSentinel(url);
  });
  const rethrow = mock((error: unknown): void => {
    if (error instanceof RedirectSentinel) throw error;
  });
  const logs: string[] = [];
  const realOrders = options.orders ? options.orders(orders) : orders;
  const placeSpy = mock(realOrders.placeOrderV2.bind(realOrders));
  const limiter = createRateLimiter(db);
  const deps: CheckoutActionDepsV2 = {
    getSessionId,
    orders: { placeOrderV2: placeSpy },
    addresses: options.addresses ? options.addresses(addresses) : addresses,
    limiter: options.limiter ? options.limiter(limiter) : limiter,
    redirect,
    revalidate,
    rethrow,
    logError: (line) => logs.push(line),
  };
  const { placeOrderV2 } = createCheckoutActionsV2(deps);
  return { db, cart, orders, addresses, charge, placeSpy, getSessionId, revalidate, redirect, rethrow, logs, placeOrderV2 };
}

function fill(h: Harness, session: string = S1): void {
  expect(h.cart.addItem(session, TOTE, 2).ok).toBe(true); // 3998
}

function saveFor(h: Harness, session: string, overrides: Partial<Record<keyof typeof SAVED, string>> = {}): string {
  const r = h.addresses.create(session, { ...SAVED, email: undefined, ...overrides });
  if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r.error)}`);
  return r.value.id;
}

function orderCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
}

function stockOf(db: Database, id: string): number {
  return (db.query("SELECT stock FROM products WHERE id = ?").get(id) as { stock: number }).stock;
}

interface OrderRow {
  id: string;
  session_id: string;
  status: string;
  full_name: string;
  email: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  total_cents: number;
  coupon_code: string | null;
  shipping_method_id: string | null;
  delivery_note: string | null;
}

function orderRow(db: Database, id: string): OrderRow {
  const row = db.query("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | null;
  if (row === null) throw new Error(`no order ${id}`);
  return row;
}

function expectFailure(state: CheckoutActionStateV2, code: string) {
  if (state === null || state.ok !== false) throw new Error(`expected ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code as typeof state.error.code);
  expect(state.error.message.trim()).not.toBe("");
  return state;
}

async function expectRedirect(promise: Promise<CheckoutActionStateV2>): Promise<string> {
  try {
    const state = await promise;
    throw new Error(`expected redirect, got ${JSON.stringify(state)}`);
  } catch (e) {
    if (e instanceof RedirectSentinel) return e.url;
    throw e;
  }
}

function orderIdOf(url: string): string {
  const match = /^\/orders\/([0-9a-f-]{36})\?placed=1(?:&notice=[a-z_]+)?$/.exec(url);
  if (match?.[1] === undefined) throw new Error(`unexpected url ${url}`);
  return match[1];
}

/** JSON with UUIDs (order/address ids) masked: a random UUID contains "737" ~0.5% of the time. */
function scrubbedJson(value: unknown): string {
  return JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>");
}

function expectNoCardData(value: unknown, number: string): void {
  const json = scrubbedJson(value);
  expect(json).not.toContain(number);
  expect(json).not.toContain(CVC);
  expect(json).not.toMatch(/"(number|cvc|expMonth|expYear)":\s*("|-?\d)/);
}

// ---------------------------------------------------------------------------

describe("parseCheckoutFieldsV2 / toRetainedValuesV2", () => {
  test("absent addressMode = new (MVP shape); forged price/total/discount/coupon/sessionId are not read", () => {
    const r = parseCheckoutFieldsV2(
      newForm({ total: "1", discount: "999", price: "1", couponCode: "WELCOME10", sessionId: S2, fullName: "  Ada  " }),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.mode).toBe("new");
    expect(r.value.address.fullName).toBe("Ada");
    expect(r.value.saveAddress).toBe(false);
    expect(JSON.stringify(r.value)).not.toContain("WELCOME10");
    expect(JSON.stringify(r.value)).not.toContain(S2);
  });

  test("saved mode reads only addressId + email; saveAddress is ignored there", () => {
    const r = parseCheckoutFieldsV2(savedForm(" abc ", { saveAddress: "on", line1: "forged" }));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.mode).toBe("saved");
    expect(r.value.addressId).toBe("abc");
    expect(r.value.address.line1).toBe("");
    expect(r.value.address.email).toBe("grace@example.com");
    expect(r.value.saveAddress).toBe(false);
  });

  test("a missing line2 reads as '' in v2 (some multipart encoders drop empty parts)", () => {
    const fd = newForm();
    fd.delete("line2");
    const r = parseCheckoutFieldsV2(fd);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.address.line2).toBe("");
  });

  test("saveAddress is true only for exactly 'on' in new mode", () => {
    for (const [value, expected] of [["on", true], ["true", false], ["", false], ["ON", false]] as const) {
      const r = parseCheckoutFieldsV2(newForm({ saveAddress: value }));
      if (!r.ok) throw new Error("parse failed");
      expect(r.value.saveAddress).toBe(expected);
    }
  });

  test("unknown addressMode, File values or a missing new-address field are INVALID_INPUT", () => {
    const missing = newForm();
    missing.delete("city");
    const cases = [
      newForm({ addressMode: "other" }),
      newForm({ deliveryNote: new File(["x"], "n.txt") }),
      newForm({ shippingMethodId: new File(["x"], "s.txt") }),
      newForm({ line2: new File(["x"], "l.txt") }),
      savedForm("id", { addressId: new File(["x"], "a.txt") }),
      savedForm("id", { email: new File(["x"], "e.txt") }),
      missing,
    ];
    for (const fd of cases) {
      const r = parseCheckoutFieldsV2(fd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
  });

  test("retained values never hold card number/expiry/cvc and are truncated to their caps", () => {
    const r = parseCheckoutFieldsV2(newForm({ deliveryNote: "n".repeat(500), phone: "1".repeat(50), addressLabel: "L".repeat(90) }));
    if (!r.ok) throw new Error("parse failed");
    const values = toRetainedValuesV2(r.value);
    expect(values.deliveryNote).toHaveLength(200);
    expect(values.phone).toHaveLength(20);
    expect(values.addressLabel).toHaveLength(40);
    const record: Record<string, unknown> = { ...values };
    for (const key of ["number", "cvc", "expMonth", "expYear"]) expect(record[key]).toBeUndefined();
    expectNoCardData(values, MOCK_CARDS.success);
  });
});

describe("toCardInput", () => {
  test("produces the same validateCard verdict and field codes as the raw strings", () => {
    const now = new Date();
    const months = ["12", " 1 ", "01", "13", "0", "", "1e1", "abc", "123", "1".repeat(200)];
    const years = [YEAR, YEAR.slice(2), "030", "0030", "0999", "", "x", "20" + YEAR, "1".repeat(200)];
    for (const expMonth of months) {
      for (const expYear of years) {
        const raw = { number: MOCK_CARDS.success, cvc: CVC, nameOnCard: "A", expMonth, expYear };
        const a = validateCard(raw, now);
        const b = validateCard(toCardInput(raw), now);
        expect(b.ok).toBe(a.ok);
        if (!a.ok && !b.ok) {
          const codes = (r: typeof a) =>
            r.ok ? {} : { m: r.error.details.fields.expMonth !== undefined, y: r.error.details.fields.expYear !== undefined };
          expect(codes(b)).toEqual(codes(a));
        }
      }
    }
  });
});

describe("placeOrderV2: new address (MVP shape)", () => {
  test("success: browser-shaped fields, server totals, revalidates cart/layout/orders, redirects", async () => {
    const h = setup();
    fill(h);
    const fd = newForm({
      $ACTION_REF_1: "",
      "$ACTION_1:0": '{"id":"abc","bound":"$@1"}',
      "$ACTION_1:1": "[null]",
      $ACTION_KEY: "k0",
      total: "1",
      discount: "3998",
      price: "0",
      sessionId: S2,
      couponCode: "WELCOME10",
    });
    // Field set of a no-JS browser post of the form (React's $ACTION_* keys, empty
    // line2, unticked checkbox absent). Not round-tripped through Request: the
    // happy-dom Request registered for tests drops empty-string parts (the
    // wrapper test covers a real multipart body).
    fd.append("$ACTION_ID_7f3a9c", "");
    const url = await expectRedirect(h.placeOrderV2(null, fd));
    const row = orderRow(h.db, orderIdOf(url));
    expect(url).toBe(`/orders/${row.id}?placed=1`);
    expect(row.status).toBe("paid");
    expect(row.session_id).toBe(S1);
    expect(row.subtotal_cents).toBe(3998);
    expect(row.discount_cents).toBe(0);
    expect(row.coupon_code).toBeNull();
    expect(row.shipping_method_id).toBe("standard"); // no selection: cheapest (free over $35)
    expect(row.total_cents).toBe(row.subtotal_cents + row.shipping_cents);
    expect(row.full_name).toBe(ADDRESS.fullName);
    expect(h.revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"], ["/orders"]]);
    const input = h.placeSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(["address", "card", "idempotencyKey", "sessionId"]);
    expect(input.sessionId).toBe(S1);
    expect(h.charge.mock.calls[0]?.[0]).toMatchObject({ amountCents: row.total_cents });
  });

  test("no session: EMPTY_CART, nothing read from the services", async () => {
    const h = setup({ session: null });
    const state = expectFailure(await h.placeOrderV2(null, newForm()), "EMPTY_CART");
    expect(state.error.message).toBe(CHECKOUT_MESSAGES.emptyCart);
    expect(state.values?.email).toBe(ADDRESS.email);
    expect(h.placeSpy).not.toHaveBeenCalled();
  });

  test("empty cart, STOCK_CHANGED, declined card keep the MVP mapping; no card data in the state", async () => {
    const h = setup();
    expectFailure(await h.placeOrderV2(null, newForm()), "EMPTY_CART");

    fill(h);
    h.db.run("UPDATE products SET stock = 1 WHERE id = ?", [TOTE]);
    const changed = expectFailure(await h.placeOrderV2(null, newForm()), "STOCK_CHANGED");
    expect(changed.error.message).toBe(CHECKOUT_MESSAGES.stockChanged);
    expect(changed.error.details?.lines).toEqual([{ productId: TOTE, name: "Canvas Tote Bag", requested: 2, available: 1 }]);
    h.db.run("UPDATE products SET stock = 42 WHERE id = ?", [TOTE]);

    const declined = expectFailure(await h.placeOrderV2(null, newForm({}, MOCK_CARDS.declined)), "PAYMENT_FAILED");
    expect(declined.error.message).toBe("Your card was declined.");
    expectNoCardData(declined, MOCK_CARDS.declined);
    expect(stockOf(h.db, TOTE)).toBe(42);
    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("validation failures: details.fields (MVP) + fieldErrors for address fields only", async () => {
    const h = setup();
    fill(h);
    const bad = "4242424242424241";
    const state = expectFailure(
      await h.placeOrderV2(null, newForm({ email: "nope", city: " ", cvc: "1" }, bad)),
      "VALIDATION_FAILED",
    );
    const fields = state.error.details?.fields as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(["city", "cvc", "email", "number"]);
    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual(["city", "email"]);
    expectNoCardData(state, bad);
    expect(orderCount(h.db)).toBe(0);
  });

  test("missing key: INVALID_INPUT with values, no session read", async () => {
    const h = setup();
    const fd = newForm();
    fd.delete("idempotencyKey");
    const state = expectFailure(await h.placeOrderV2(null, fd), "INVALID_INPUT");
    expect(state.values?.fullName).toBe(ADDRESS.fullName);
    expect(h.getSessionId).not.toHaveBeenCalled();
  });

  test("AC6: same key replays the same order (sequential and concurrent); one charge", async () => {
    const h = setup();
    fill(h);
    const key = crypto.randomUUID();
    const [a, b] = await Promise.all([
      expectRedirect(h.placeOrderV2(null, newForm({ idempotencyKey: key }))),
      expectRedirect(h.placeOrderV2(null, newForm({ idempotencyKey: key }))),
    ]);
    expect(a).toBe(b);
    const again = await expectRedirect(h.placeOrderV2(null, newForm({ idempotencyKey: key })));
    expect(again).toBe(a);
    expect(orderCount(h.db)).toBe(1);
    expect(h.charge).toHaveBeenCalledTimes(1);
  });

  test("a key used by another session is INVALID_INPUT for the second session (owner-key rule)", async () => {
    const h = setup();
    fill(h);
    const key = crypto.randomUUID();
    await expectRedirect(h.placeOrderV2(null, newForm({ idempotencyKey: key })));
    const h2Session = mock(async () => S2);
    const other = createCheckoutActionsV2({
      getSessionId: h2Session,
      orders: h.orders,
      addresses: h.addresses,
      limiter: createRateLimiter(h.db),
      redirect: (url: string): never => {
        throw new RedirectSentinel(url);
      },
      revalidate: () => undefined,
      logError: () => undefined,
    });
    fill(h, S2);
    const state = expectFailure(await other.placeOrderV2(null, newForm({ idempotencyKey: key })), "INVALID_INPUT");
    expect(state.error.message).toBe(CHECKOUT_MESSAGES.invalidRequest);
    expect(orderCount(h.db)).toBe(1);
  });
});

describe("placeOrderV2: saved address (AC2)", () => {
  test("own saved address becomes the order address; posted address fields are ignored", async () => {
    const h = setup();
    fill(h);
    const id = saveFor(h, S1);
    const url = await expectRedirect(h.placeOrderV2(null, savedForm(id, { line1: "forged street", fullName: "Mallory" })));
    const row = orderRow(h.db, orderIdOf(url));
    expect(row).toMatchObject({
      full_name: SAVED.fullName,
      email: "grace@example.com",
      line1: SAVED.line1,
      line2: SAVED.line2,
      city: SAVED.city,
      region: SAVED.region,
      postal_code: SAVED.postalCode,
      country: SAVED.country,
    });
    expect(url).not.toContain("Grace");
  });

  test("D-T71-1: the saved address's phone goes on the order; a posted phone is ignored in saved mode", async () => {
    const h = setup();
    fill(h);
    const id = saveFor(h, S1);
    const url = await expectRedirect(h.placeOrderV2(null, savedForm(id, { phone: "not a phone!" })));
    const db = h.db.query<{ phone: string | null }, [string]>("SELECT phone FROM orders WHERE id = ?").get(orderIdOf(url));
    expect(db?.phone).toBe(SAVED.phone);
    expect((h.placeSpy.mock.calls[0]?.[0] as Record<string, unknown>).phone).toBe(SAVED.phone);
  });

  test("D-T71-1: a saved address without a phone places the order with no phone", async () => {
    const h = setup();
    fill(h);
    const id = saveFor(h, S1, { phone: "" });
    const url = await expectRedirect(h.placeOrderV2(null, savedForm(id)));
    const db = h.db.query<{ phone: string | null }, [string]>("SELECT phone FROM orders WHERE id = ?").get(orderIdOf(url));
    expect(db?.phone).toBeNull();
    expect(Object.keys(h.placeSpy.mock.calls[0]?.[0] as Record<string, unknown>)).not.toContain("phone");
  });

  test("two sessions: another session's id is NOT_FOUND on addressId; no order, no charge", async () => {
    const h = setup();
    fill(h);
    const theirs = saveFor(h, S2);
    const state = expectFailure(await h.placeOrderV2(null, savedForm(theirs)), "NOT_FOUND");
    expect(state.fieldErrors).toEqual({ addressId: CHECKOUT_MESSAGES_V2.chooseSavedAddress });
    expect(state.values?.addressId).toBe(theirs);
    expect(state.values?.addressMode).toBe("saved");
    expect(JSON.stringify(state)).not.toContain(SAVED.line1);
    expect(h.placeSpy).not.toHaveBeenCalled();
    expect(h.charge).not.toHaveBeenCalled();
    expect(orderCount(h.db)).toBe(0);
    expect(stockOf(h.db, TOTE)).toBe(42);

    // S2 itself may use it.
    const h2 = setup({ session: S2 });
    fill(h2, S2);
    const id2 = saveFor(h2, S2);
    await expectRedirect(h2.placeOrderV2(null, savedForm(id2)));
  });

  test("malformed / unknown / blank ids and no session are NOT_FOUND on addressId", async () => {
    const h = setup();
    fill(h);
    for (const id of ["", "   ", "x".repeat(65), "' OR 1=1 --", crypto.randomUUID()]) {
      const state = expectFailure(await h.placeOrderV2(null, savedForm(id)), "NOT_FOUND");
      expect(state.fieldErrors?.addressId).toBe(CHECKOUT_MESSAGES_V2.chooseSavedAddress);
    }
    const missing = savedForm("x");
    missing.delete("addressId");
    expectFailure(await h.placeOrderV2(null, missing), "NOT_FOUND");
    expect(orderCount(h.db)).toBe(0);

    const anon = setup({ session: null });
    expectFailure(await anon.placeOrderV2(null, savedForm(crypto.randomUUID())), "NOT_FOUND");
  });

  test("saved mode without email: VALIDATION_FAILED on email", async () => {
    const h = setup();
    fill(h);
    const id = saveFor(h, S1);
    const fd = savedForm(id);
    fd.delete("email");
    const state = expectFailure(await h.placeOrderV2(null, fd), "VALIDATION_FAILED");
    expect(state.fieldErrors).toEqual({ email: expect.any(String) });
  });

  test("an address-book storage failure on get settles with INTERNAL_ERROR and a PII-free log line", async () => {
    const h = setup({
      addresses: (real) => ({
        create: real.create.bind(real),
        get: () => {
          throw new AddressStorageError("get", "SQLITE_BUSY");
        },
      }),
    });
    fill(h);
    const state = expectFailure(await h.placeOrderV2(null, savedForm(crypto.randomUUID())), "INTERNAL_ERROR");
    expect(state.error.message).toBe(CHECKOUT_MESSAGES_V2.unexpected);
    expect(h.logs).toEqual([`[checkout] ${CHECKOUT_ACTION_FAILED} step=address code=SQLITE_BUSY`]);
    expect(h.rethrow).toHaveBeenCalledTimes(1);
    expect(orderCount(h.db)).toBe(0);
  });
});

describe("placeOrderV2: save address (AC3)", () => {
  test("saveAddress=on stores the new address (label + phone) after the order; no notice", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(
      h.placeOrderV2(null, newForm({ saveAddress: "on", addressLabel: "Home", phone: "+44 20 7946 0000" })),
    );
    expect(url).toMatch(/^\/orders\/[0-9a-f-]{36}\?placed=1$/);
    const book = h.addresses.list(S1);
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ fullName: ADDRESS.fullName, label: "Home", phone: "+44 20 7946 0000", postalCode: "N1 9GU" });
    expect(h.revalidate.mock.calls).toContainEqual(["/account/addresses"]);
  });

  test("without saveAddress nothing is stored and the label is not validated", async () => {
    const h = setup();
    fill(h);
    await expectRedirect(h.placeOrderV2(null, newForm({ addressLabel: "L".repeat(41) })));
    expect(h.addresses.list(S1)).toHaveLength(0);
  });

  test("D-T71-1: a valid phone posted with a new address is written to the order (no save needed); blank -> NULL", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ phone: " +44 20 7946 0000 " })));
    const row = h.db.query<{ phone: string | null }, [string]>("SELECT phone FROM orders WHERE id = ?").get(orderIdOf(url));
    expect(row?.phone).toBe("+44 20 7946 0000");
    fill(h);
    const blank = await expectRedirect(h.placeOrderV2(null, newForm({ phone: "   " })));
    expect(h.db.query<{ phone: string | null }, [string]>("SELECT phone FROM orders WHERE id = ?").get(orderIdOf(blank))?.phone).toBeNull();
    expect(h.addresses.list(S1)).toHaveLength(0);
  });

  test("D-T71-1: an invalid phone fails with fieldErrors.phone even without saveAddress; no order", async () => {
    const h = setup();
    fill(h);
    const state = expectFailure(await h.placeOrderV2(null, newForm({ phone: "not a phone!" })), "VALIDATION_FAILED");
    expect(Object.keys(state.fieldErrors ?? {})).toEqual(["phone"]);
    expect(h.placeSpy).not.toHaveBeenCalled();
    expect(h.addresses.list(S1)).toHaveLength(0);
  });

  test("a failed order never saves the address", async () => {
    const h = setup();
    fill(h);
    expectFailure(await h.placeOrderV2(null, newForm({ saveAddress: "on" }, MOCK_CARDS.declined)), "PAYMENT_FAILED");
    expect(h.addresses.countFor(S1)).toBe(0);
  });

  test("full address book: order succeeds, redirect carries ?placed=1&notice=address_full", async () => {
    const h = setup();
    fill(h);
    for (let i = 0; i < 10; i += 1) saveFor(h, S1, { line1: `${i} Full Street` });
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on" })));
    expect(url).toMatch(/^\/orders\/[0-9a-f-]{36}\?placed=1&notice=address_full$/);
    expect(parseCheckoutNotice(new URL(url, "http://x").searchParams.get("notice"))).toBe(CHECKOUT_NOTICE.addressFull);
    expect(orderRow(h.db, orderIdOf(url)).status).toBe("paid");
    expect(h.addresses.countFor(S1)).toBe(10);
  });

  test("duplicate address: no notice; same-key replay with saveAddress stays quiet and stores one address", async () => {
    const h = setup();
    fill(h);
    const key = crypto.randomUUID();
    const first = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on", idempotencyKey: key })));
    const replay = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on", idempotencyKey: key })));
    expect(replay).toBe(first);
    expect(h.addresses.countFor(S1)).toBe(1);
    expect(orderCount(h.db)).toBe(1);
  });

  test("AddressStorageError on create: order succeeds, notice address_not_saved, log holds only the code", async () => {
    const h = setup({
      addresses: (real) => ({
        get: real.get.bind(real),
        create: () => {
          throw new AddressStorageError("create", "SQLITE_FULL");
        },
      }),
    });
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on", phone: "+1 555 0100" })));
    expect(url).toMatch(/\?placed=1&notice=address_not_saved$/);
    expect(orderRow(h.db, orderIdOf(url)).status).toBe("paid");
    expect(h.logs).toEqual([`[checkout] ${CHECKOUT_ACTION_FAILED} step=save_address code=SQLITE_FULL`]);
  });

  test("rate-limited save: order succeeds with address_not_saved", async () => {
    const h = setup({
      limiter: () => ({
        check: () => ({ ok: false, error: { code: "RATE_LIMITED", message: "slow", details: { retryAfterSeconds: 60 } } }),
      }),
    });
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on" })));
    expect(url).toMatch(/\?placed=1&notice=address_not_saved$/);
    expect(h.addresses.countFor(S1)).toBe(0);
  });

  test("invalid phone / over-long label with saveAddress: field errors before any order", async () => {
    const h = setup();
    fill(h);
    const state = expectFailure(
      await h.placeOrderV2(null, newForm({ saveAddress: "on", phone: "call me", addressLabel: "L".repeat(41) })),
      "VALIDATION_FAILED",
    );
    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual(["addressLabel", "phone"]);
    expect(state.values?.saveAddress).toBe(true);
    expect(h.placeSpy).not.toHaveBeenCalled();
  });
});

describe("placeOrderV2: shipping method (AC4)", () => {
  test("unknown, inactive or over-long id: INVALID_INPUT on shippingMethodId; nothing reserved or charged", async () => {
    const h = setup();
    fill(h);
    h.db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    for (const id of ["teleport", "express", "s".repeat(65)]) {
      const state = expectFailure(await h.placeOrderV2(null, newForm({ shippingMethodId: id })), "INVALID_INPUT");
      expect(state.fieldErrors).toEqual({ shippingMethodId: CHECKOUT_MESSAGES_V2.shippingInvalid });
      expect(state.error.details).toEqual({ field: "shippingMethodId" });
    }
    expect(orderCount(h.db)).toBe(0);
    expect(stockOf(h.db, TOTE)).toBe(42);
    expect(h.charge).not.toHaveBeenCalled();
  });

  test("missing (or blank) id uses the cart's selection; an explicit id wins", async () => {
    const h = setup();
    fill(h);
    expect(h.cart.selectShippingMethod(S1, "express").ok).toBe(true);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ shippingMethodId: "  " })));
    const row = orderRow(h.db, orderIdOf(url));
    expect(row.shipping_method_id).toBe("express");
    expect(row.shipping_cents).toBe(999);

    fill(h);
    expect(h.cart.selectShippingMethod(S1, "express").ok).toBe(true);
    const url2 = await expectRedirect(h.placeOrderV2(null, newForm({ shippingMethodId: "next_day" })));
    expect(orderRow(h.db, orderIdOf(url2)).shipping_method_id).toBe("next_day");
  });
});

describe("placeOrderV2: delivery note + coupons (AC5)", () => {
  test("note over 200 chars: TOO_LONG on deliveryNote without calling the service", async () => {
    const h = setup();
    fill(h);
    const state = expectFailure(await h.placeOrderV2(null, newForm({ deliveryNote: "n".repeat(201) })), "TOO_LONG");
    expect(state.fieldErrors).toEqual({ deliveryNote: CHECKOUT_MESSAGES_V2.deliveryNoteTooLong });
    expect(h.placeSpy).not.toHaveBeenCalled();
  });

  test("a 200-char note is stored; control characters are cleaned by the service", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ deliveryNote: "  Leave\u0000 at\n\tthe  door " })));
    expect(orderRow(h.db, orderIdOf(url)).delivery_note).toBe("Leave at the door");
    fill(h);
    const url2 = await expectRedirect(h.placeOrderV2(null, newForm({ deliveryNote: "d".repeat(200) })));
    expect(orderRow(h.db, orderIdOf(url2)).delivery_note).toBe("d".repeat(200));
  });

  test("service TOO_LONG on the note maps to the field error too", async () => {
    const h = setup({
      orders: () => ({
        placeOrderV2: async () => ({
          ok: false,
          error: { code: "TOO_LONG", message: "x", details: { field: "deliveryNote", max: 200 } },
        }),
      }),
    });
    const state = expectFailure(await h.placeOrderV2(null, newForm()), "TOO_LONG");
    expect(state.fieldErrors).toEqual({ deliveryNote: CHECKOUT_MESSAGES_V2.deliveryNoteTooLong });
  });

  test("a valid cart coupon is applied and redeemed server-side", async () => {
    const h = setup();
    fill(h);
    expect(h.cart.applyCoupon(S1, "WELCOME10").ok).toBe(true);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ discount: "3998" })));
    const row = orderRow(h.db, orderIdOf(url));
    expect(row.coupon_code).toBe("WELCOME10");
    expect(row.discount_cents).toBe(399); // floor(10% of 3998)
    const redemption = h.db
      .query("SELECT order_id AS o FROM coupon_redemptions WHERE coupon_code = 'WELCOME10' AND session_id = ?")
      .get(S1) as { o: string } | null;
    expect(redemption?.o).toBe(row.id);
  });

  const couponCases: readonly { name: string; code: string; arrange: (h: Harness) => void }[] = [
    {
      name: "expired",
      code: "COUPON_EXPIRED",
      arrange: (h) => {
        expect(h.cart.applyCoupon(S1, "WELCOME10").ok).toBe(true);
        h.db.run("UPDATE coupons SET expires_at = '2020-01-01T00:00:00.000Z' WHERE code = 'WELCOME10'");
      },
    },
    {
      name: "exhausted",
      code: "COUPON_EXHAUSTED",
      arrange: (h) => {
        expect(h.cart.applyCoupon(S1, "WELCOME10").ok).toBe(true);
        h.db.run("UPDATE coupons SET max_uses = 1, used_count = 1 WHERE code = 'WELCOME10'");
      },
    },
    {
      name: "already used",
      code: "COUPON_USED",
      arrange: (h) => {
        expect(h.cart.applyCoupon(S1, "WELCOME10").ok).toBe(true);
        h.db.run("INSERT INTO coupon_redemptions (coupon_code, session_id) VALUES ('WELCOME10', ?)", [S1]);
      },
    },
    {
      name: "deactivated",
      code: "COUPON_INVALID",
      arrange: (h) => {
        expect(h.cart.applyCoupon(S1, "WELCOME10").ok).toBe(true);
        h.db.run("UPDATE coupons SET is_active = 0 WHERE code = 'WELCOME10'");
      },
    },
    {
      name: "below minimum",
      code: "COUPON_MIN_SUBTOTAL",
      arrange: (h) => {
        expect(h.cart.applyCoupon(S1, "SAVE5").ok).toBe(true);
        expect(h.cart.setQuantity(S1, TOTE, 1).ok).toBe(true); // 1999 + 50 < 2500
      },
    },
  ];

  for (const c of couponCases) {
    test(`coupon ${c.name}: form-level ${c.code} with the service message; nothing reserved or charged`, async () => {
      const h = setup();
      fill(h);
      expect(h.cart.addItem(S1, PIN, 1).ok).toBe(true);
      c.arrange(h);
      const before = { tote: stockOf(h.db, TOTE), pin: stockOf(h.db, PIN) };
      const state = expectFailure(await h.placeOrderV2(null, newForm()), c.code);
      expect(state.fieldErrors).toBeUndefined();
      expect(state.error.message).not.toBe(CHECKOUT_MESSAGES_V2.couponFallback);
      if (c.code === "COUPON_MIN_SUBTOTAL") {
        expect(state.error.details).toEqual({ shortfallCents: 2500 - 2049, minSubtotalCents: 2500 });
      }
      expect(h.charge).not.toHaveBeenCalled();
      expect(orderCount(h.db)).toBe(0);
      expect(stockOf(h.db, TOTE)).toBe(before.tote);
      expect(stockOf(h.db, PIN)).toBe(before.pin);
    });
  }
});

describe("placeOrderV2: privacy and settling (AC6)", () => {
  test("no card data or address in logs, redirect URL or revalidate args", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((m) => console[m]);
    const calls: unknown[] = [];
    for (const m of methods) console[m] = (...args: unknown[]) => void calls.push(args);
    let urls: string[] = [];
    let h: Harness | undefined;
    try {
      h = setup({
        addresses: (real) => ({
          get: real.get.bind(real),
          create: () => {
            throw new AddressStorageError("create", "SQLITE_IOERR");
          },
        }),
      });
      fill(h);
      await h.placeOrderV2(null, newForm({}, MOCK_CARDS.declined));
      urls.push(await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on", deliveryNote: "Gate 4" }))));
      await h.placeOrderV2(null, newForm({ cvc: "x" }, "1234"));
    } finally {
      methods.forEach((m, i) => {
        console[m] = originals[i] as (typeof console)[typeof m];
      });
    }
    urls = urls.concat(h?.redirect.mock.calls.map((c) => String(c[0])) ?? []);
    const everything = scrubbedJson({ calls, urls, logs: h?.logs, revalidate: h?.revalidate.mock.calls });
    for (const secret of [MOCK_CARDS.success, MOCK_CARDS.declined, CVC, ADDRESS.line1, ADDRESS.fullName, ADDRESS.email, ADDRESS.postalCode, "Gate 4"]) {
      expect(everything).not.toContain(secret);
    }
  });

  test("an unexpected service exception settles with INTERNAL_ERROR (values kept, no card data)", async () => {
    const boom = new Error(`db down ${MOCK_CARDS.success}`);
    const h = setup({ orders: () => ({ placeOrderV2: () => Promise.reject(boom) }) });
    const state = expectFailure(await h.placeOrderV2(null, newForm()), "INTERNAL_ERROR");
    expect(state.values?.fullName).toBe(ADDRESS.fullName);
    expect(h.rethrow.mock.calls[0]?.[0]).toBe(boom);
    expect(h.logs).toEqual([`[checkout] ${CHECKOUT_ACTION_FAILED} step=order code=UNEXPECTED`]);
    expectNoCardData(state, MOCK_CARDS.success);
  });

  test("framework control-flow errors are rethrown, not swallowed", async () => {
    const control = new RedirectSentinel("/elsewhere");
    const h = setup({ orders: () => ({ placeOrderV2: () => Promise.reject(control) }) });
    await expect(h.placeOrderV2(null, newForm())).rejects.toBe(control);
  });

  test("the field name contract matches what the action reads", () => {
    expect(CHECKOUT_FIELD_V2).toMatchObject({
      idempotencyKey: "idempotencyKey",
      addressMode: "addressMode",
      addressId: "addressId",
      saveAddress: "saveAddress",
      addressLabel: "addressLabel",
      phone: "phone",
      shippingMethodId: "shippingMethodId",
      deliveryNote: "deliveryNote",
    });
    expect(parseCheckoutNotice("address_full")).toBe("address_full");
    expect(parseCheckoutNotice(["address_not_saved"])).toBe("address_not_saved");
    expect(parseCheckoutNotice("<script>")).toBeNull();
    expect(parseCheckoutNotice(undefined)).toBeNull();
  });
});

describe("success redirect (FIX-checkout-placed)", () => {
  test("orderPlacedHref: /orders/<id>?placed=1, notice appended with &", () => {
    const id = "0b9e8f62-3c1d-4a5e-9f70-2d6b1c8a4e11";
    expect(orderPlacedHref(id, null)).toBe(`/orders/${id}?placed=1`);
    expect(orderPlacedHref(id, CHECKOUT_NOTICE.addressFull)).toBe(`/orders/${id}?placed=1&notice=address_full`);
    expect(orderPlacedHref(id, CHECKOUT_NOTICE.addressNotSaved)).toBe(`/orders/${id}?placed=1&notice=address_not_saved`);
    expect(orderPlacedHref("a/b?c", null)).toBe("/orders/a%2Fb%3Fc?placed=1");
  });

  test("a successful order redirects to /orders/<id>?placed=1 (exactly one placed value)", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm()));
    const id = orderIdOf(url);
    expect(url).toBe(`/orders/${id}?placed=1`);
    const params = new URL(url, "http://x").searchParams;
    expect(params.getAll("placed")).toEqual(["1"]);
    expect(params.has("notice")).toBe(false);
    expect(orderRow(h.db, id).status).toBe("paid");
  });

  test("with a notice: /orders/<id>?placed=1&notice=address_full", async () => {
    const h = setup();
    fill(h);
    for (let i = 0; i < 10; i += 1) saveFor(h, S1, { line1: `${i} Placed Street` });
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on" })));
    const id = orderIdOf(url);
    expect(url).toBe(`/orders/${id}?placed=1&notice=address_full`);
    const params = new URL(url, "http://x").searchParams;
    expect(params.get("placed")).toBe("1");
    expect(parseCheckoutNotice(params.get("notice"))).toBe(CHECKOUT_NOTICE.addressFull);
  });

  test("a failed order does not redirect", async () => {
    const h = setup();
    fill(h);
    expectFailure(await h.placeOrderV2(null, newForm({}, MOCK_CARDS.declined)), "PAYMENT_FAILED");
  });
});
