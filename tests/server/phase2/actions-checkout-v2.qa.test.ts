import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// QA-W4-T71: adversarial tests for the checkout server action v2
// (`placeOrderV2`).
//
// Part 1 drives `createCheckoutActionsV2` (checkout-core) with the REAL order
// service v2, cart v2, address service and T31 limiter over in-memory SQLite,
// plus recording fakes (session reader, revalidate, redirect, logger).
// Part 2 drives the `'use server'` wrapper (checkout-v2.ts) with next/headers,
// next/navigation (real exports spread, so unstable_rethrow stays real) and
// next/cache mocked before anything imports them.
// The cross-connection race uses an OS temp dir that is removed afterwards.
// No test touches ./data.
//
// Pinned defects are `test.failing("DEFECT D-T71-n ...")`: flip to `test`
// once fixed.
// ---------------------------------------------------------------------------

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super("NEXT_REDIRECT (qa sentinel)");
  }
}

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
let cookiesImpl: () => Promise<FakeCookieStore> = async () => fakeStore;
const wiredRevalidate = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
const wiredRedirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => cookiesImpl(),
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/navigation", () => ({ ...realNavigation, redirect: wiredRedirect }));
mock.module("next/cache", () => ({ revalidatePath: wiredRevalidate }));

// The wrapper uses the app singletons over getDatabase(); the existing test
// setup points them at :memory: (restored in afterAll).
const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const contract = await import("@/components/organisms/_contracts/checkout-actions");
const { CHECKOUT_FIELD_V2, CHECKOUT_NOTICE, parseCheckoutNotice } = contract;
type CheckoutActionStateV2 = import("@/components/organisms/_contracts/checkout-actions").CheckoutActionStateV2;
type CheckoutActionFailureV2 = import("@/components/organisms/_contracts/checkout-actions").CheckoutActionFailureV2;
const core = await import("@/app/actions/checkout-core");
const { createCheckoutActionsV2, CHECKOUT_MESSAGES, CHECKOUT_MESSAGES_V2, ADDRESS_FIELDS, CARD_FIELDS, ORDER_PLACED_PARAM, orderPlacedHref } = core;
type CheckoutActionDepsV2 = import("@/app/actions/checkout-core").CheckoutActionDepsV2;
const { AddressStorageError, createAddressService, MAX_ADDRESSES_PER_SESSION } = await import("@/server/addresses/address-service");
type AddressService = import("@/server/addresses/address-service").AddressService;
const { createCartService } = await import("@/server/cart/cart-service");
type CartServiceV2 = import("@/server/cart/cart-service").CartServiceV2;
const { createDatabase, closeDatabase, getDatabase } = await import("@/server/db/client");
const { runMigrations } = await import("@/server/db/schema");
const { seedDatabase } = await import("@/server/db/seed");
const { createOrderService } = await import("@/server/orders/order-service");
type OrderServiceV2 = import("@/server/orders/order-service").OrderServiceV2;
const { MOCK_CARDS, createMockPaymentProvider } = await import("@/server/payments/mock-payment-provider");
const { createRateLimiter, limitAction } = await import("@/server/security/rate-limiter");
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;
const { SESSION_COOKIE_NAME, AUTH_COOKIE_NAME } = await import("@/server/session/session");

// Wrapper import with the shared DB closed: importing must open nothing.
closeDatabase();
const dbGlobal = globalThis as typeof globalThis & { __storefrontDb?: unknown };
const wired = await import("@/app/actions/checkout-v2");
const dbOpenedByImport = dbGlobal.__storefrontDb !== undefined;

const ROOT = join(import.meta.dir, "..", "..", "..");
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const MIN = 60_000;
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const UNKNOWN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOTE = "prod_canvas-tote-bag"; // 1999 cents, stock 42
const PIN = "prod_enamel-pin-set"; // 50 cents, stock 100
const CVC = "737";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const PLACED_URL_RE = /^\/orders\/([0-9a-f-]{36})\?placed=1(?:&notice=(address_full|address_not_saved))?$/;

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

const OTHER_SAVED = {
  fullName: "Mallory Other",
  line1: "13 Secret Lane",
  line2: "",
  city: "Paris",
  region: "IDF",
  postalCode: "75001",
  country: "FR",
  label: "Hideout",
  phone: "+33 1 23 45 67 89",
} as const;

function cardFields(number: string = MOCK_CARDS.success): Record<string, string> {
  return { nameOnCard: "Ada L", number, expMonth: "12", expYear: "2030", cvc: CVC };
}

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function newForm(overrides: Record<string, string | Blob> = {}, card: string = MOCK_CARDS.success): FormData {
  return form({ idempotencyKey: crypto.randomUUID(), ...ADDRESS, ...cardFields(card), ...overrides });
}

function savedForm(addressId: string, overrides: Record<string, string | Blob> = {}): FormData {
  return form({
    idempotencyKey: crypto.randomUUID(),
    addressMode: "saved",
    addressId,
    email: "grace@example.com",
    ...cardFields(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Console spies: every console.* line produced during a test is checked for
// owner keys / PII / card data in afterEach.
// ---------------------------------------------------------------------------

const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
  spyOn(console, m).mockImplementation(() => undefined),
);
const FORBIDDEN_IN_LOGS = [
  S1,
  S2,
  "ada@example.com",
  "grace@example.com",
  "Ada Lovelace",
  "Analytical",
  "Compiler Road",
  "Secret Lane",
  MOCK_CARDS.success,
  MOCK_CARDS.declined,
];
let extraForbidden: string[] = [];

beforeEach(() => {
  for (const s of consoleSpies) s.mockClear();
  extraForbidden = [];
});

afterEach(() => {
  for (const spy of consoleSpies) {
    for (const call of spy.mock.calls) {
      const line = call.map((a) => (typeof a === "string" ? a : (JSON.stringify(a) ?? String(a)))).join(" ");
      for (const needle of [...FORBIDDEN_IN_LOGS, ...extraForbidden]) expect(line).not.toContain(needle);
      expect(line.replace(UUID_RE, "<uuid>")).not.toContain(CVC);
    }
  }
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

// ---------------------------------------------------------------------------
// Harness (part 1)
// ---------------------------------------------------------------------------

type RevalidateCall = readonly [string] | readonly [string, "page" | "layout"];

interface Harness {
  readonly db: Database;
  readonly cart: CartServiceV2;
  readonly orders: OrderServiceV2;
  readonly addresses: AddressService;
  readonly clock: { value: number };
  readonly charges: { n: number; keys: string[] };
  readonly events: string[];
  readonly revalidateCalls: RevalidateCall[];
  readonly redirects: string[];
  readonly limiterKeys: string[];
  readonly placeCalls: { n: number };
  readonly getCalls: { n: number };
  readonly createCalls: { n: number };
  readonly sessionReads: { n: number };
  readonly logs: string[];
  session: string | null;
  placeOrderV2: (prev: CheckoutActionStateV2, fd: FormData) => Promise<CheckoutActionStateV2>;
}

interface SetupOptions {
  readonly addresses?: (real: AddressService) => Pick<AddressService, "get" | "create">;
  readonly orders?: (real: OrderServiceV2) => Pick<OrderServiceV2, "placeOrderV2">;
  readonly limiter?: (real: RateLimiter) => RateLimiter;
  readonly getSessionId?: () => Promise<string | null>;
  readonly revalidate?: (path: string, type?: "page" | "layout") => void;
  readonly rethrow?: (error: unknown) => void;
  readonly db?: Database;
}

function setup(options: SetupOptions = {}): Harness {
  const db = options.db ?? createDatabase(":memory:");
  if (options.db === undefined) {
    runMigrations(db);
    seedDatabase(db, { now: new Date(NOW) });
  }
  const clock = { value: NOW };
  const pay = createMockPaymentProvider({ latencyMs: 0, now: () => new Date(clock.value) });
  const charges = { n: 0, keys: [] as string[] };
  const events: string[] = [];
  const payments = {
    charge: (input: Parameters<typeof pay.charge>[0]) => {
      charges.n++;
      charges.keys.push(input.idempotencyKey);
      events.push("charge");
      return pay.charge(input);
    },
  };
  const orders = createOrderService(db, { now: () => clock.value, payments, inFlight: new Map() });
  const cart = createCartService(db, { now: () => clock.value });
  const addresses = createAddressService({ db, logger: { error: () => undefined, warn: () => undefined }, now: () => clock.value });
  const realLimiter = createRateLimiter(db, { now: () => clock.value });

  const h: Harness = {
    db,
    cart,
    orders,
    addresses,
    clock,
    charges,
    events,
    revalidateCalls: [],
    redirects: [],
    limiterKeys: [],
    placeCalls: { n: 0 },
    getCalls: { n: 0 },
    createCalls: { n: 0 },
    sessionReads: { n: 0 },
    logs: [],
    session: S1,
    placeOrderV2: async () => null,
  };

  const baseLimiter = options.limiter ? options.limiter(realLimiter) : realLimiter;
  const limiter: RateLimiter = {
    check: (key, rule) => {
      h.limiterKeys.push(key);
      h.events.push(`limiter:${key.split(":")[0] ?? ""}`);
      return baseLimiter.check(key, rule);
    },
  };
  const baseOrders = options.orders ? options.orders(orders) : orders;
  const baseAddresses = options.addresses ? options.addresses(addresses) : addresses;

  const deps: CheckoutActionDepsV2 = {
    getSessionId:
      options.getSessionId ??
      (async () => {
        h.sessionReads.n++;
        return h.session;
      }),
    orders: {
      placeOrderV2: async (input, now) => {
        h.placeCalls.n++;
        h.events.push("place:start");
        const result = await baseOrders.placeOrderV2(input, now);
        h.events.push(`place:end:${result.ok ? "ok" : result.error.code}`);
        return result;
      },
    },
    addresses: {
      get: (sessionId, addressId) => {
        h.getCalls.n++;
        h.events.push("address:get");
        return baseAddresses.get(sessionId, addressId);
      },
      create: (sessionId, input, now) => {
        h.createCalls.n++;
        h.events.push("address:create");
        return baseAddresses.create(sessionId, input, now);
      },
    },
    limiter,
    redirect: (url: string): never => {
      h.redirects.push(url);
      h.events.push("redirect");
      throw new RedirectSentinel(url);
    },
    revalidate:
      options.revalidate ??
      ((path, type) => {
        h.revalidateCalls.push(type === undefined ? [path] : [path, type]);
        h.events.push(`revalidate:${path}`);
      }),
    rethrow:
      options.rethrow ??
      ((error: unknown) => {
        if (error instanceof RedirectSentinel) throw error;
        realNavigation.unstable_rethrow(error);
      }),
    logError: (line) => {
      h.logs.push(line);
      console.error(line);
    },
    now: () => h.clock.value,
  };
  h.placeOrderV2 = createCheckoutActionsV2(deps).placeOrderV2;
  return h;
}

function fill(h: Harness, session: string = S1): void {
  expect(h.cart.addItem(session, TOTE, 2).ok).toBe(true); // 3998
}

function saveFor(h: Harness, session: string, data: Record<string, string> = SAVED): string {
  const r = h.addresses.create(session, { ...data, email: undefined } as Parameters<AddressService["create"]>[1]);
  if (!r.ok) throw new Error(`create failed: ${r.error.code}`);
  return r.value.id;
}

function count(db: Database, sql: string, ...params: string[]): number {
  return (db.query(sql).get(...params) as { n: number }).n;
}
const orderCount = (db: Database): number => count(db, "SELECT COUNT(*) AS n FROM orders");
const paidCount = (db: Database): number => count(db, "SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'");
const redemptions = (db: Database): number => count(db, "SELECT COUNT(*) AS n FROM coupon_redemptions");
const addressCount = (db: Database, s: string): number => count(db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?", s);
const stockOf = (db: Database, id: string): number =>
  (db.query("SELECT stock FROM products WHERE id = ?").get(id) as { stock: number }).stock;
const usedCount = (db: Database, code: string): number =>
  (db.query("SELECT used_count AS n FROM coupons WHERE code = ?").get(code) as { n: number }).n;

interface OrderRow {
  readonly id: string;
  readonly session_id: string;
  readonly status: string;
  readonly full_name: string;
  readonly email: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly region: string;
  readonly postal_code: string;
  readonly country: string;
  readonly subtotal_cents: number;
  readonly discount_cents: number;
  readonly shipping_cents: number;
  readonly total_cents: number;
  readonly coupon_code: string | null;
  readonly shipping_method_id: string | null;
  readonly delivery_note: string | null;
  readonly phone: string | null;
}

function orderRow(db: Database, id: string): OrderRow {
  const row = db.query("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | null;
  if (row === null) throw new Error("no such order");
  return row;
}

function snapshot(h: Harness): Record<string, number> {
  return {
    orders: orderCount(h.db),
    charges: h.charges.n,
    tote: stockOf(h.db, TOTE),
    pin: stockOf(h.db, PIN),
    redemptions: redemptions(h.db),
  };
}

function expectFailure(state: CheckoutActionStateV2, code: string): CheckoutActionFailureV2 {
  if (state === null || state.ok !== false) throw new Error(`expected ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code as typeof state.error.code);
  expect(state.error.message.trim()).not.toBe("");
  return state;
}

/** A failed attempt never revalidates or redirects. */
function expectNoSuccessSideEffects(h: Harness): void {
  expect(h.revalidateCalls).toEqual([]);
  expect(h.redirects).toEqual([]);
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

function parsePlaced(url: string): { orderId: string; notice: string | null } {
  const m = PLACED_URL_RE.exec(url);
  if (m?.[1] === undefined) throw new Error(`unexpected url ${url}`);
  const params = new URL(url, "http://x").searchParams;
  expect(params.getAll(ORDER_PLACED_PARAM)).toEqual(["1"]);
  expect(params.getAll("notice").length).toBeLessThanOrEqual(1);
  return { orderId: m[1], notice: m[2] ?? null };
}

function scrubbed(value: unknown): string {
  return (JSON.stringify(value) ?? "").replace(UUID_RE, "<uuid>");
}

function expectNoCardData(value: unknown, number: string = MOCK_CARDS.success): void {
  const json = scrubbed(value);
  expect(json).not.toContain(number);
  expect(json).not.toContain(CVC);
  expect(json).not.toMatch(/"(number|cvc|expMonth|expYear)":\s*("|-?\d)/);
}

function expectNoOwnerKey(value: unknown, ...owners: string[]): void {
  const json = JSON.stringify(value) ?? "";
  for (const o of owners) expect(json.toLowerCase()).not.toContain(o.toLowerCase());
  expect(json).not.toMatch(/"(sessionId|session_id|ownerKey|owner_key|token|tokenHash|idempotencyKey)":/);
}

function addCoupon(
  db: Database,
  code: string,
  f: { kind?: "percent" | "fixed" | "free_shipping"; value?: number; min?: number; maxUses?: number | null; expires?: string | null } = {},
): void {
  db.query(
    "INSERT INTO coupons (code, kind, value, min_subtotal_cents, max_uses, used_count, expires_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
  ).run(code, f.kind ?? "fixed", f.value ?? 100, f.min ?? 0, f.maxUses ?? null, f.expires ?? null);
}

/** FormData that records every field name the action reads and whether it enumerated the form. */
class RecordingFormData extends FormData {
  readonly read = new Set<string>();
  enumerated = false;
  override get(name: string): FormDataEntryValue | null {
    this.read.add(name);
    return super.get(name);
  }
  override getAll(name: string): FormDataEntryValue[] {
    this.read.add(name);
    return super.getAll(name);
  }
  override has(name: string): boolean {
    this.read.add(name);
    return super.has(name);
  }
  constructor() {
    super();
    const mark = (): void => {
      this.enumerated = true;
    };
    const entries = this.entries.bind(this);
    const keys = this.keys.bind(this);
    const values = this.values.bind(this);
    const forEach = this.forEach.bind(this);
    this.entries = ((...a: Parameters<typeof entries>) => (mark(), entries(...a))) as typeof entries;
    this.keys = ((...a: Parameters<typeof keys>) => (mark(), keys(...a))) as typeof keys;
    this.values = ((...a: Parameters<typeof values>) => (mark(), values(...a))) as typeof values;
    this.forEach = ((...a: Parameters<typeof forEach>) => (mark(), forEach(...a))) as typeof forEach;
  }
}

const ALLOWED_READS = new Set<string>([...Object.values(CHECKOUT_FIELD_V2), ...ADDRESS_FIELDS, ...CARD_FIELDS]);

// ===========================================================================
// 1. Saved-address mode
// ===========================================================================

describe("1. saved-address mode", () => {
  test("two owners: S2's addressId posted by S1 -> fieldErrors.addressId NOT_FOUND; no order, no charge, no reservation, no redemption", async () => {
    const h = setup();
    fill(h);
    expect(h.cart.applyCoupon(S1, "WELCOME10", NOW).ok).toBe(true);
    const theirs = saveFor(h, S2, OTHER_SAVED);
    const before = snapshot(h);
    const state = expectFailure(await h.placeOrderV2(null, savedForm(theirs)), "NOT_FOUND");
    expect(state.fieldErrors).toEqual({ addressId: CHECKOUT_MESSAGES_V2.chooseSavedAddress });
    expect(state.error.details).toEqual({ field: "addressId" });
    expect(snapshot(h)).toEqual(before);
    expect(usedCount(h.db, "WELCOME10")).toBe(0);
    expect(h.placeCalls.n).toBe(0);
    expectNoSuccessSideEffects(h);
    // Nothing of the other owner's address leaks back.
    const json = JSON.stringify(state);
    for (const v of ["Mallory", "Secret Lane", "Paris", "75001", "Hideout", "+33"]) expect(json).not.toContain(v);
    expectNoOwnerKey(state, S1, S2);
    // The other owner's book is untouched.
    expect(addressCount(h.db, S2)).toBe(1);
  });

  const badIds: readonly [string, string][] = [
    ["blank", ""],
    ["whitespace", "   "],
    ["malformed", "not-a-uuid"],
    ["path-ish", "../../etc/passwd"],
    ["sql-ish", "' OR 1=1 --"],
    ["65 chars", "a".repeat(65)],
    ["1 MB", "a".repeat(1_000_000)],
    ["unknown uuid", UNKNOWN_ID],
    ["NUL inside", `${UNKNOWN_ID}\u0000`],
  ];
  for (const [name, id] of badIds) {
    test(`addressId ${name} -> fieldErrors.addressId NOT_FOUND, no order`, async () => {
      const h = setup();
      fill(h);
      saveFor(h, S1);
      const before = snapshot(h);
      const state = expectFailure(await h.placeOrderV2(null, savedForm(id)), "NOT_FOUND");
      expect(state.fieldErrors?.addressId).toBe(CHECKOUT_MESSAGES_V2.chooseSavedAddress);
      expect(snapshot(h)).toEqual(before);
      expect(h.placeCalls.n).toBe(0);
      expectNoSuccessSideEffects(h);
      // Retained values are capped (a 1 MB id is not echoed back).
      expect((state.values?.addressId ?? "").length).toBeLessThanOrEqual(64);
    });
  }

  test("no session -> fieldErrors.addressId NOT_FOUND without reading the address book", async () => {
    const h = setup();
    const id = saveFor(h, S1);
    h.session = null;
    const state = expectFailure(await h.placeOrderV2(null, savedForm(id)), "NOT_FOUND");
    expect(state.fieldErrors?.addressId).toBe(CHECKOUT_MESSAGES_V2.chooseSavedAddress);
    expect(h.getCalls.n).toBe(0);
    expect(h.placeCalls.n).toBe(0);
    expectNoSuccessSideEffects(h);
  });

  test("valid own address -> order stores exactly the saved address + the posted email; posted address fields ignored", async () => {
    const h = setup();
    fill(h);
    const id = saveFor(h, S1);
    const url = await expectRedirect(
      h.placeOrderV2(null, savedForm(id, { fullName: "Mallory Forged", line1: "999 Forged St", country: "FR", saveAddress: "on" })),
    );
    const { orderId, notice } = parsePlaced(url);
    expect(notice).toBeNull();
    const row = orderRow(h.db, orderId);
    expect(row).toMatchObject({
      session_id: S1,
      status: "paid",
      full_name: SAVED.fullName,
      email: "grace@example.com",
      line1: SAVED.line1,
      line2: SAVED.line2,
      city: SAVED.city,
      region: SAVED.region,
      postal_code: SAVED.postalCode,
      country: SAVED.country,
    });
    // saveAddress is ignored in saved mode: nothing created, no limiter hit.
    expect(h.createCalls.n).toBe(0);
    expect(h.limiterKeys).toEqual([]);
    expect(addressCount(h.db, S1)).toBe(1);
  });

  for (const [name, email] of [
    ["missing", null],
    ["blank", "   "],
    ["invalid", "not-an-email"],
  ] as const) {
    test(`saved mode, email ${name} -> VALIDATION_FAILED with fieldErrors.email only; no order`, async () => {
      const h = setup();
      fill(h);
      const id = saveFor(h, S1);
      const fd = savedForm(id);
      fd.delete("email");
      if (email !== null) fd.append("email", email);
      const before = snapshot(h);
      const state = expectFailure(await h.placeOrderV2(null, fd), "VALIDATION_FAILED");
      expect(Object.keys(state.fieldErrors ?? {})).toEqual(["email"]);
      expect(Object.keys((state.error.details?.fields ?? {}) as object)).toEqual(["email"]);
      expect(snapshot(h)).toEqual(before);
      expectNoSuccessSideEffects(h);
    });
  }
});

// ===========================================================================
// 2. New address + save to the address book
// ===========================================================================

describe("2. new address + save", () => {
  test("save happens only AFTER a successful order, behind the address.write limit, then revalidate + redirect last", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on", addressLabel: "Home", phone: "+44 20 7946 0000" })));
    const { orderId, notice } = parsePlaced(url);
    expect(notice).toBeNull();
    expect(h.events).toEqual([
      "place:start",
      "charge",
      "place:end:ok",
      "revalidate:/cart",
      "revalidate:/",
      "revalidate:/orders",
      "limiter:address.write",
      "address:create",
      "revalidate:/account/addresses",
      "redirect",
    ]);
    expect(h.limiterKeys).toEqual([`address.write:${S1}`]);
    expect(h.revalidateCalls).toEqual([["/cart"], ["/", "layout"], ["/orders"], ["/account/addresses"]]);
    const book = h.addresses.list(S1);
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ fullName: ADDRESS.fullName, line1: ADDRESS.line1, label: "Home", phone: "+44 20 7946 0000" });
    expect(orderRow(h.db, orderId).status).toBe("paid");
  });

  test("a failed order (declined) never touches the limiter or the address book", async () => {
    const h = setup();
    fill(h);
    const state = expectFailure(await h.placeOrderV2(null, newForm({ saveAddress: "on" }, MOCK_CARDS.declined)), "PAYMENT_FAILED");
    expect(h.limiterKeys).toEqual([]);
    expect(h.createCalls.n).toBe(0);
    expect(addressCount(h.db, S1)).toBe(0);
    expectNoSuccessSideEffects(h);
    expectNoCardData(state, MOCK_CARDS.declined);
  });

  test("book full (10) -> order succeeds, redirect ?placed=1&notice=address_full, book unchanged", async () => {
    const h = setup();
    fill(h);
    for (let i = 0; i < MAX_ADDRESSES_PER_SESSION; i++) saveFor(h, S1, { ...SAVED, line1: `${i} Full Street` });
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on" })));
    const { orderId, notice } = parsePlaced(url);
    expect(notice).toBe("address_full");
    expect(url).toBe(orderPlacedHref(orderId, CHECKOUT_NOTICE.addressFull));
    expect(parseCheckoutNotice(new URL(url, "http://x").searchParams.get("notice"))).toBe("address_full");
    expect(orderRow(h.db, orderId).status).toBe("paid");
    expect(addressCount(h.db, S1)).toBe(MAX_ADDRESSES_PER_SESSION);
    expect(h.revalidateCalls).toEqual([["/cart"], ["/", "layout"], ["/orders"]]);
  });

  test("rate limited (20/day address.write spent) -> order succeeds with notice=address_not_saved, nothing stored", async () => {
    const h = setup();
    fill(h);
    const limiter = createRateLimiter(h.db, { now: () => NOW });
    for (let i = 0; i < 20; i++) expect(limitAction(limiter, "address.write", S1).ok).toBe(true);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on" })));
    const { orderId, notice } = parsePlaced(url);
    expect(notice).toBe("address_not_saved");
    expect(orderRow(h.db, orderId).status).toBe("paid");
    expect(h.createCalls.n).toBe(0);
    expect(addressCount(h.db, S1)).toBe(0);
  });

  test("storage error (AddressStorageError) -> order still places, notice=address_not_saved, log has only step + code", async () => {
    const h = setup({
      addresses: (real) => ({
        get: real.get.bind(real),
        create: () => {
          throw new AddressStorageError("create", "SQLITE_BUSY");
        },
      }),
    });
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on" })));
    expect(parsePlaced(url).notice).toBe("address_not_saved");
    expect(paidCount(h.db)).toBe(1);
    expect(h.logs).toEqual(["[checkout] CHECKOUT_ACTION_FAILED step=save_address code=SQLITE_BUSY"]);
  });

  test("a plain Error carrying PII from create -> notice=address_not_saved; the PII message is never logged", async () => {
    const h = setup({
      addresses: (real) => ({
        get: real.get.bind(real),
        create: () => {
          throw new Error(`boom for ada@example.com ${S1} ${MOCK_CARDS.success}`);
        },
      }),
    });
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on" })));
    expect(parsePlaced(url).notice).toBe("address_not_saved");
    expect(h.logs).toEqual(["[checkout] CHECKOUT_ACTION_FAILED step=save_address code=UNEXPECTED"]);
  });

  test("DUPLICATE (address already in the book) -> no notice, still one entry, /account/addresses not revalidated", async () => {
    const h = setup();
    fill(h);
    saveFor(h, S1, { ...ADDRESS, label: "", phone: "" });
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on" })));
    expect(parsePlaced(url).notice).toBeNull();
    expect(addressCount(h.db, S1)).toBe(1);
    expect(h.revalidateCalls).toEqual([["/cart"], ["/", "layout"], ["/orders"]]);
  });

  const badExtras: readonly [string, Record<string, string>, string][] = [
    ["label 41 chars", { addressLabel: "L".repeat(41) }, "addressLabel"],
    ["phone letters", { phone: "call me" }, "phone"],
    ["phone too few digits", { phone: "12-34" }, "phone"],
    ["phone 21 chars", { phone: "1".repeat(21) }, "phone"],
    ["phone 1 MB", { phone: "1".repeat(1_000_000) }, "phone"],
  ];
  for (const [name, extra, field] of badExtras) {
    test(`saveAddress + ${name} -> fieldErrors.${field} BEFORE any order (no session read, no limiter, no charge)`, async () => {
      const h = setup();
      fill(h);
      const before = snapshot(h);
      const state = await h.placeOrderV2(null, newForm({ saveAddress: "on", ...extra }));
      if (state === null) throw new Error("expected failure");
      expect(["VALIDATION_FAILED", "TOO_LONG"]).toContain(state.error.code);
      expect(Object.keys(state.fieldErrors ?? {})).toEqual([field]);
      expect(h.placeCalls.n).toBe(0);
      expect(h.sessionReads.n).toBe(0);
      expect(h.limiterKeys).toEqual([]);
      expect(snapshot(h)).toEqual(before);
      expectNoSuccessSideEffects(h);
    });
  }

  test("without saveAddress an over-long label alone is not validated: order placed, nothing stored, no limiter call", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ addressLabel: "L".repeat(41) })));
    const { orderId, notice } = parsePlaced(url);
    expect(url).toBe(`/orders/${orderId}?placed=1`);
    expect(notice).toBeNull();
    expect(addressCount(h.db, S1)).toBe(0);
    expect(h.limiterKeys).toEqual([]);
  });

  // Ruling D-T71-1: a NON-BLANK invalid phone fails in new mode whether or not "save" is ticked.
  for (const save of [false, true]) {
    test(`new mode, invalid phone "nope" (save ${save ? "ticked" : "not ticked"}) -> VALIDATION_FAILED, fieldErrors ["phone"]; no order, charge, limiter or stored address`, async () => {
      const h = setup();
      fill(h);
      const before = snapshot(h);
      const state = expectFailure(
        await h.placeOrderV2(null, newForm({ phone: "nope", ...(save ? { saveAddress: "on" } : {}) })),
        "VALIDATION_FAILED",
      );
      expect(Object.keys(state.fieldErrors ?? {})).toEqual(["phone"]);
      expect(h.placeCalls.n).toBe(0);
      expect(h.limiterKeys).toEqual([]);
      expect(addressCount(h.db, S1)).toBe(0);
      expect(snapshot(h)).toEqual(before);
      expectNoSuccessSideEffects(h);
    });
  }

  test("new mode, blank / whitespace phone without save -> order placed with orders.phone NULL", async () => {
    for (const phone of ["", "   "]) {
      const h = setup();
      fill(h);
      const url = await expectRedirect(h.placeOrderV2(null, newForm({ phone })));
      expect(orderRow(h.db, parsePlaced(url).orderId).phone).toBeNull();
    }
  });

  test("saved mode: a posted phone (even an invalid one) is ignored; the saved address's phone lands on orders.phone", async () => {
    const h = setup();
    fill(h);
    const id = saveFor(h, S1);
    const url = await expectRedirect(h.placeOrderV2(null, savedForm(id, { phone: "nope" })));
    expect(orderRow(h.db, parsePlaced(url).orderId).phone).toBe(SAVED.phone);
    fill(h);
    const url2 = await expectRedirect(h.placeOrderV2(null, savedForm(id, { phone: "+1 999 999 9999" })));
    expect(orderRow(h.db, parsePlaced(url2).orderId).phone).toBe(SAVED.phone);
  });

  test("saved mode: a saved address without a phone gives orders.phone NULL", async () => {
    const h = setup();
    fill(h);
    const id = saveFor(h, S1, { ...SAVED, phone: "" });
    const url = await expectRedirect(h.placeOrderV2(null, savedForm(id, { phone: "+1 555 0100" })));
    expect(orderRow(h.db, parsePlaced(url).orderId).phone).toBeNull();
  });

  test("saveAddress must be exactly 'on' (\"true\", \"1\", \"ON\" do not save)", async () => {
    for (const v of ["true", "1", "ON", "on "]) {
      const h = setup();
      fill(h);
      await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: v })));
      expect(h.createCalls.n).toBe(0);
    }
  });

  test("guests may save (the address book is owner-keyed, no account needed)", async () => {
    const guest = crypto.randomUUID();
    const h = setup();
    h.session = guest;
    fill(h, guest);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on" })));
    expect(parsePlaced(url).notice).toBeNull();
    expect(addressCount(h.db, guest)).toBe(1);
  });

  test("same-key replay with saveAddress: same order, one stored address, no notice (observation: each replay spends an address.write credit)", async () => {
    const h = setup();
    fill(h);
    const fd = newForm({ saveAddress: "on" });
    const first = await expectRedirect(h.placeOrderV2(null, fd));
    const second = await expectRedirect(h.placeOrderV2(null, fd));
    expect(second).toBe(first);
    expect(addressCount(h.db, S1)).toBe(1);
    expect(h.charges.n).toBe(1);
    expect(h.limiterKeys).toEqual([`address.write:${S1}`, `address.write:${S1}`]);
  });

  test("DEFECT D-T71-1: the phone posted with a new address is not written to the order (orders.phone stays NULL)", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ phone: "+44 20 7946 0000" })));
    expect(orderRow(h.db, parsePlaced(url).orderId).phone).toBe("+44 20 7946 0000");
  });
});

// ===========================================================================
// 3. Shipping method
// ===========================================================================

describe("3. shipping method", () => {
  for (const [name, posted] of [
    ["absent", null],
    ["blank", ""],
    ["whitespace", "   "],
  ] as const) {
    test(`${name} -> the cart's selection`, async () => {
      const h = setup();
      fill(h);
      expect(h.cart.selectShippingMethod(S1, "express").ok).toBe(true);
      const url = await expectRedirect(h.placeOrderV2(null, newForm(posted === null ? {} : { shippingMethodId: posted })));
      const row = orderRow(h.db, parsePlaced(url).orderId);
      expect(row.shipping_method_id).toBe("express");
      expect(row.shipping_cents).toBe(999);
      expect(row.total_cents).toBe(3998 + 999);
    });
  }

  test("blank with no cart selection -> cheapest active (standard, free over 3500)", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ shippingMethodId: "" })));
    const row = orderRow(h.db, parsePlaced(url).orderId);
    expect(row.shipping_method_id).toBe("standard");
    expect(row.shipping_cents).toBe(0);
  });

  test("an explicit valid id wins over the cart's selection", async () => {
    const h = setup();
    fill(h);
    expect(h.cart.selectShippingMethod(S1, "express").ok).toBe(true);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ shippingMethodId: "next_day" })));
    expect(orderRow(h.db, parsePlaced(url).orderId).shipping_method_id).toBe("next_day");
  });

  const badMethods: readonly [string, string, boolean][] = [
    ["unknown", "warp_drive", true],
    ["inactive", "express", true],
    ["wrong case", "EXPRESS", true],
    ["sql-ish", "standard' OR '1'='1", true],
    ["NUL suffix", "standard\u0000", true],
    ["65 chars", "s".repeat(65), false],
    ["1 MB", "s".repeat(1_000_000), false],
  ];
  for (const [name, id, reachesService] of badMethods) {
    test(`${name} -> fieldErrors.shippingMethodId INVALID_INPUT, nothing reserved or charged`, async () => {
      const h = setup();
      fill(h);
      expect(h.cart.applyCoupon(S1, "WELCOME10", NOW).ok).toBe(true);
      if (name === "inactive") h.db.query("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'").run();
      const before = snapshot(h);
      const state = expectFailure(await h.placeOrderV2(null, newForm({ shippingMethodId: id })), "INVALID_INPUT");
      expect(state.fieldErrors).toEqual({ shippingMethodId: CHECKOUT_MESSAGES_V2.shippingInvalid });
      expect(snapshot(h)).toEqual(before);
      expect(usedCount(h.db, "WELCOME10")).toBe(0);
      expect(h.placeCalls.n).toBe(reachesService ? 1 : 0);
      expectNoSuccessSideEffects(h);
      expect((state.values?.shippingMethodId ?? "").length).toBeLessThanOrEqual(64);
    });
  }

  test("observation: the cart's stored selection deactivated before submit + blank post -> field error (not a silent fallback)", async () => {
    const h = setup();
    fill(h);
    expect(h.cart.selectShippingMethod(S1, "express").ok).toBe(true);
    h.db.query("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'").run();
    const before = snapshot(h);
    const state = expectFailure(await h.placeOrderV2(null, newForm({ shippingMethodId: "" })), "INVALID_INPUT");
    expect(state.fieldErrors).toEqual({ shippingMethodId: CHECKOUT_MESSAGES_V2.shippingInvalid });
    expect(snapshot(h)).toEqual(before);
    // An explicit active choice then succeeds.
    await expectRedirect(h.placeOrderV2(null, newForm({ shippingMethodId: "standard" })));
  });
});

// ===========================================================================
// 4. Delivery note
// ===========================================================================

describe("4. delivery note", () => {
  test("200 characters -> stored verbatim", async () => {
    const h = setup();
    fill(h);
    const note = "n".repeat(200);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ deliveryNote: note })));
    expect(orderRow(h.db, parsePlaced(url).orderId).delivery_note).toBe(note);
  });

  for (const [name, note] of [
    ["201 chars", "n".repeat(201)],
    ["1 MB", "n".repeat(1_000_000)],
  ] as const) {
    test(`${name} -> fieldErrors.deliveryNote TOO_LONG before the service`, async () => {
      const h = setup();
      fill(h);
      const before = snapshot(h);
      const started = performance.now();
      const state = expectFailure(await h.placeOrderV2(null, newForm({ deliveryNote: note })), "TOO_LONG");
      expect(performance.now() - started).toBeLessThan(2000);
      expect(state.fieldErrors).toEqual({ deliveryNote: CHECKOUT_MESSAGES_V2.deliveryNoteTooLong });
      expect(state.error.details).toEqual({ field: "deliveryNote" });
      expect(h.placeCalls.n).toBe(0);
      expect(h.sessionReads.n).toBe(0);
      expect(snapshot(h)).toEqual(before);
      expectNoSuccessSideEffects(h);
      expect((state.values?.deliveryNote ?? "").length).toBeLessThanOrEqual(200);
    });
  }

  test("control characters, U+202E and line breaks are cleaned by the service (stored note asserted)", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ deliveryNote: "Leave\u0000 at‮ door\u0007\r\nback" })));
    const stored = orderRow(h.db, parsePlaced(url).orderId).delivery_note;
    expect(stored).toBe("Leave at door back");
    expect(stored ?? "").not.toMatch(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/);
  });

  test("whitespace-only note -> stored as NULL; HTML stays literal text (no sanitising into markup)", async () => {
    const h = setup();
    fill(h);
    const a = await expectRedirect(h.placeOrderV2(null, newForm({ deliveryNote: "   \t  " })));
    expect(orderRow(h.db, parsePlaced(a).orderId).delivery_note).toBeNull();
    fill(h);
    const b = await expectRedirect(h.placeOrderV2(null, newForm({ deliveryNote: "<img src=x onerror=alert(1)>" })));
    expect(orderRow(h.db, parsePlaced(b).orderId).delivery_note).toBe("<img src=x onerror=alert(1)>");
  });

  test("200 visible chars padded with 50 control chars -> accepted (limit counts the cleaned text)", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ deliveryNote: `${"n".repeat(200)}${"\u0000".repeat(50)}` })));
    expect(orderRow(h.db, parsePlaced(url).orderId).delivery_note).toBe("n".repeat(200));
  });
});

// ===========================================================================
// 5. Coupons
// ===========================================================================

describe("5. coupons", () => {
  interface CouponCase {
    readonly code: string;
    readonly coupon: string;
    readonly arrange: (h: Harness) => void;
  }
  const cases: readonly CouponCase[] = [
    {
      code: "COUPON_INVALID",
      coupon: "WELCOME10",
      arrange: (h) => {
        expect(h.cart.applyCoupon(S1, "WELCOME10", NOW).ok).toBe(true);
        h.db.query("UPDATE coupons SET is_active = 0 WHERE code = 'WELCOME10'").run();
      },
    },
    {
      code: "COUPON_EXPIRED",
      coupon: "QAEXP",
      arrange: (h) => {
        // Expired between viewing the cart and submitting.
        addCoupon(h.db, "QAEXP", { kind: "percent", value: 15, expires: new Date(NOW + MIN).toISOString() });
        expect(h.cart.applyCoupon(S1, "QAEXP", NOW).ok).toBe(true);
        h.clock.value = NOW + 2 * MIN;
      },
    },
    {
      code: "COUPON_EXHAUSTED",
      coupon: "QAONE",
      arrange: (h) => {
        addCoupon(h.db, "QAONE", { maxUses: 1 });
        expect(h.cart.applyCoupon(S1, "QAONE", NOW).ok).toBe(true);
        h.db.query("UPDATE coupons SET used_count = 1 WHERE code = 'QAONE'").run();
      },
    },
    {
      code: "COUPON_USED",
      coupon: "WELCOME10",
      arrange: (h) => {
        expect(h.cart.applyCoupon(S1, "WELCOME10", NOW).ok).toBe(true);
        h.db.query("INSERT INTO coupon_redemptions (coupon_code, session_id, order_id) VALUES ('WELCOME10', ?, NULL)").run(S1);
      },
    },
    {
      code: "COUPON_MIN_SUBTOTAL",
      coupon: "SAVE5",
      arrange: (h) => {
        expect(h.cart.applyCoupon(S1, "SAVE5", NOW).ok).toBe(true);
        expect(h.cart.setQuantity(S1, TOTE, 1).ok).toBe(true); // 1999 < 2500
      },
    },
  ];

  for (const c of cases) {
    test(`${c.code}: form-level, service message, nothing reserved/redeemed/charged`, async () => {
      const h = setup();
      fill(h);
      c.arrange(h);
      const before = { ...snapshot(h), used: usedCount(h.db, c.coupon) };
      const state = expectFailure(await h.placeOrderV2(null, newForm()), c.code);
      expect(state.fieldErrors).toBeUndefined();
      expect(state.error.message).not.toBe(CHECKOUT_MESSAGES_V2.couponFallback);
      expect(state.error.message).not.toBe(CHECKOUT_MESSAGES.invalidRequest);
      if (c.code === "COUPON_MIN_SUBTOTAL") {
        expect(state.error.details).toEqual({ shortfallCents: 501, minSubtotalCents: 2500 });
      } else {
        expect(state.error.details).toBeUndefined();
      }
      expect({ ...snapshot(h), used: usedCount(h.db, c.coupon) }).toEqual(before);
      expect(h.charges.n).toBe(0);
      expectNoSuccessSideEffects(h);
      expectNoOwnerKey(state, S1);
    });
  }

  test("valid cart coupon: redeemed exactly once against the new order; same-key replay does not redeem again", async () => {
    const h = setup();
    fill(h);
    expect(h.cart.applyCoupon(S1, "WELCOME10", NOW).ok).toBe(true);
    const fd = newForm();
    const url = await expectRedirect(h.placeOrderV2(null, fd));
    const { orderId } = parsePlaced(url);
    const row = orderRow(h.db, orderId);
    expect(row.coupon_code).toBe("WELCOME10");
    expect(row.discount_cents).toBe(399); // 10% of 3998, rounded down
    expect(row.total_cents).toBe(3998 - 399 + row.shipping_cents);
    const rows = h.db.query("SELECT order_id FROM coupon_redemptions WHERE coupon_code = 'WELCOME10'").all() as { order_id: string }[];
    expect(rows).toEqual([{ order_id: orderId }]);
    expect(usedCount(h.db, "WELCOME10")).toBe(1);
    expect(await expectRedirect(h.placeOrderV2(null, fd))).toBe(url);
    expect(redemptions(h.db)).toBe(1);
    expect(usedCount(h.db, "WELCOME10")).toBe(1);
    expect(h.charges.n).toBe(1);
  });

  test("forged couponCode / discount / total / price / sessionId fields are ignored; only allowed names are read", async () => {
    const h = setup();
    fill(h);
    const fd = new RecordingFormData();
    const fields: Record<string, string> = {
      idempotencyKey: crypto.randomUUID(),
      ...ADDRESS,
      ...cardFields(),
      couponCode: "WELCOME10",
      coupon: "SAVE5",
      discount: "99999",
      discountCents: "99999",
      total: "1",
      totalCents: "1",
      price: "0",
      subtotal: "0",
      shippingCents: "0",
      sessionId: S2,
      ownerKey: S2,
      status: "paid",
    };
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const url = await expectRedirect(h.placeOrderV2(null, fd));
    const row = orderRow(h.db, parsePlaced(url).orderId);
    expect(row).toMatchObject({ session_id: S1, coupon_code: null, discount_cents: 0, subtotal_cents: 3998, total_cents: 3998 + row.shipping_cents });
    expect(redemptions(h.db)).toBe(0);
    expect(fd.enumerated).toBe(false);
    for (const name of fd.read) expect(ALLOWED_READS.has(name)).toBe(true);
  });
});

// ===========================================================================
// 6. MVP invariants
// ===========================================================================

let raceCharges: number[] = [];

describe("6. MVP invariants", () => {
  test("same key sequentially x3 -> same order, one charge, one stock decrement", async () => {
    const h = setup();
    fill(h);
    const fd = newForm();
    const urls = [await expectRedirect(h.placeOrderV2(null, fd)), await expectRedirect(h.placeOrderV2(null, fd)), await expectRedirect(h.placeOrderV2(null, fd))];
    expect(new Set(urls).size).toBe(1);
    expect(h.charges.n).toBe(1);
    expect(orderCount(h.db)).toBe(1);
    expect(stockOf(h.db, TOTE)).toBe(40);
  });

  test("same key x6 via Promise.all -> all redirect to the same order, one charge", async () => {
    const h = setup();
    fill(h);
    const key = crypto.randomUUID();
    const urls = await Promise.all(
      Array.from({ length: 6 }, () => expectRedirect(h.placeOrderV2(null, newForm({ idempotencyKey: key })))),
    );
    expect(new Set(urls).size).toBe(1);
    parsePlaced(urls[0] ?? "");
    expect(h.charges.n).toBe(1);
    expect(orderCount(h.db)).toBe(1);
    expect(stockOf(h.db, TOTE)).toBe(40);
  });

  test("worker threads, two connections to a temp file DB, barrier start, same key (8 rounds): one order, one stock decrement, one charge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-t71-race-"));
    const path = join(dir, "race.sqlite");
    const results: { round: number; charges: number; outcomes: string[] }[] = [];
    try {
      const db = createDatabase(path);
      runMigrations(db);
      seedDatabase(db, { now: new Date(NOW) });
      const cart = createCartService(db, { now: () => NOW });
      for (let round = 0; round < 8; round++) {
        const session = crypto.randomUUID();
        expect(cart.addItem(session, TOTE, 1).ok).toBe(true);
        const before = stockOf(db, TOTE);
        const key = `race-key-${round}-${crypto.randomUUID()}`;
        const start = new Int32Array(new SharedArrayBuffer(4));
        type Res = import("./actions-checkout-v2-race.qa.worker").CheckoutRaceResult;
        const fields = Object.entries({ ...ADDRESS, ...cardFields() }) as [string, string][];
        const pending = Promise.all(
          [0, 1].map(
            () =>
              new Promise<Res>((resolve, reject) => {
                const w = new Worker(new URL("./actions-checkout-v2-race.qa.worker.ts", import.meta.url).href);
                w.onmessage = (e: MessageEvent<Res>) => {
                  resolve(e.data);
                  w.terminate();
                };
                w.onerror = (e) => reject(new Error(String(e.message)));
                w.postMessage({ path, sessionId: session, idempotencyKey: key, now: NOW, start, fields });
              }),
          ),
        );
        await Bun.sleep(30);
        Atomics.store(start, 0, 1);
        Atomics.notify(start, 0);
        const res = await pending;
        // Both racers redirect to the same order (D-T71-3 fixed: no EMPTY_CART).
        for (const r of res) expect(`${r.outcome}:${r.detail}`).toMatch(/^redirect:/);
        const redirects = res.filter((r) => r.outcome === "redirect").map((r) => r.detail);
        expect(redirects).toHaveLength(2);
        expect(new Set(redirects).size).toBe(1);
        expect(count(db, "SELECT COUNT(*) AS n FROM orders WHERE session_id = ?", session)).toBe(1);
        expect(stockOf(db, TOTE)).toBe(before - 1);
        for (const r of res) for (const k of r.chargeKeys) expect(k).toBe(key);
        const charges = res.reduce((n, r) => n + r.charges, 0);
        results.push({ round, charges, outcomes: res.map((r) => r.outcome) });
      }
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(existsSync(dir)).toBe(false);
    // Provider-level charges per round are pinned by DEFECT D-T71-2 below.
    raceCharges = results.map((r) => r.charges);
    expect(raceCharges).toHaveLength(8);
  }, 120_000);

  test("DEFECT D-T71-2: same key on two connections/processes -> the provider is charged twice (each with the same key); expected one charge per round", () => {
    expect(raceCharges).toHaveLength(8);
    expect(raceCharges.join(",")).toBe("1,1,1,1,1,1,1,1");
  });

  test("DEFECT D-T71-3: same-key retry whose key lookup ran before the first attempt committed returns EMPTY_CART instead of replaying the order", async () => {
    const h = setup();
    fill(h);
    const fd = newForm();
    const first = await expectRedirect(h.placeOrderV2(null, fd));
    // Simulate the cross-connection interleaving deterministically: the retry's
    // findByIdempotencyKey ran just before the first attempt's finalize committed.
    const repo = (h.orders as unknown as { orders: { findByIdempotencyKey: (k: string) => unknown } }).orders;
    const real = repo.findByIdempotencyKey.bind(repo);
    let calls = 0;
    repo.findByIdempotencyKey = (k: string) => (calls++ === 0 ? null : real(k));
    h.redirects.length = 0;
    expect(await expectRedirect(h.placeOrderV2(null, fd))).toBe(first);
  });

  test("another owner's key -> INVALID_INPUT for the second owner; their cart untouched, no order for them", async () => {
    const h = setup();
    fill(h, S1);
    fill(h, S2);
    const key = crypto.randomUUID();
    await expectRedirect(h.placeOrderV2(null, newForm({ idempotencyKey: key })));
    h.session = S2;
    h.revalidateCalls.length = 0;
    h.redirects.length = 0;
    const state = expectFailure(await h.placeOrderV2(null, newForm({ idempotencyKey: key })), "INVALID_INPUT");
    expectNoSuccessSideEffects(h);
    expectNoOwnerKey(state, S1, S2);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM orders WHERE session_id = ?", S2)).toBe(0);
    expect(h.cart.getCart(S2).itemCount).toBe(2);
    expect(h.charges.n).toBe(1);
  });

  test("PAYMENT_FAILED: details { orderId, failureCode }, no fieldErrors, no card data; a fresh key then succeeds", async () => {
    const h = setup();
    fill(h);
    const state = expectFailure(await h.placeOrderV2(null, newForm({}, MOCK_CARDS.declined)), "PAYMENT_FAILED");
    expect(Object.keys(state.error.details ?? {}).sort()).toEqual(["failureCode", "orderId"]);
    expect(state.fieldErrors).toBeUndefined();
    expectNoCardData(state, MOCK_CARDS.declined);
    expect(stockOf(h.db, TOTE)).toBe(42);
    expect(h.cart.getCart(S1).itemCount).toBe(2);
    expectNoSuccessSideEffects(h);
    await expectRedirect(h.placeOrderV2(null, newForm()));
  });

  test("STOCK_CHANGED: details.lines, nothing charged", async () => {
    const h = setup();
    fill(h);
    h.db.query("UPDATE products SET stock = 1 WHERE id = ?").run(TOTE);
    const state = expectFailure(await h.placeOrderV2(null, newForm()), "STOCK_CHANGED");
    const lines = state.error.details?.lines as { productId: string; requested: number; available: number }[];
    expect(lines.map((l) => [l.productId, l.requested, l.available])).toEqual([[TOTE, 2, 1]]);
    expect(h.charges.n).toBe(0);
    expect(state.fieldErrors).toBeUndefined();
    expectNoSuccessSideEffects(h);
  });

  test("R-CART-1: a cart line unpublished after it was added is declined (no paid order, no charge, stock unchanged)", async () => {
    const h = setup();
    fill(h);
    h.db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(TOTE);
    const state = await h.placeOrderV2(null, newForm());
    if (state === null) throw new Error("expected a failure");
    expect(["STOCK_CHANGED", "PRODUCT_NOT_FOUND", "EMPTY_CART"]).toContain(state.error.code);
    expect(paidCount(h.db)).toBe(0);
    expect(h.charges.n).toBe(0);
    expect(stockOf(h.db, TOTE)).toBe(42);
    expectNoSuccessSideEffects(h);
  });

  test("EMPTY_CART for an owner with no cart and for no session", async () => {
    const h = setup();
    expectFailure(await h.placeOrderV2(null, newForm()), "EMPTY_CART");
    h.session = null;
    expectFailure(await h.placeOrderV2(null, newForm()), "EMPTY_CART");
    expect(h.placeCalls.n).toBe(1);
    expectNoSuccessSideEffects(h);
  });

  test("VALIDATION_FAILED: details.fields holds address AND card names; fieldErrors only address names; no card values anywhere", async () => {
    const h = setup();
    fill(h);
    const bad = "4242424242424241";
    const fd = form({
      idempotencyKey: crypto.randomUUID(),
      ...ADDRESS,
      email: "nope",
      postalCode: "",
      ...cardFields(bad),
      cvc: "73",
      expMonth: "13",
    });
    const state = expectFailure(await h.placeOrderV2(null, fd), "VALIDATION_FAILED");
    const fields = Object.keys((state.error.details?.fields ?? {}) as object).sort();
    expect(fields).toEqual(expect.arrayContaining(["email", "postalCode", "number", "cvc", "expMonth"]));
    expect(Object.keys(state.fieldErrors ?? {}).sort()).toEqual(["email", "postalCode"]);
    expectNoCardData(state, bad);
    expect(JSON.stringify(state)).not.toContain('"73"');
    expect(state.values).not.toHaveProperty("number");
    expect(state.values).not.toHaveProperty("cvc");
    expect(state.values).not.toHaveProperty("expMonth");
    expect(state.values).not.toHaveProperty("expYear");
    expectNoSuccessSideEffects(h);
  });

  test("malformed posts: File values, unknown addressMode, missing card field, missing key -> INVALID_INPUT settled", async () => {
    const h = setup();
    fill(h);
    const file = new File(["x"], "x.txt");
    const cases: FormData[] = [
      newForm({ shippingMethodId: file }),
      newForm({ deliveryNote: file }),
      newForm({ addressMode: "both" }),
      newForm({ addressMode: file }),
      newForm({ email: file }),
      (() => {
        const fd = newForm();
        fd.delete("cvc");
        return fd;
      })(),
      (() => {
        const fd = newForm();
        fd.delete("idempotencyKey");
        return fd;
      })(),
      newForm({ idempotencyKey: "   " }),
    ];
    for (const fd of cases) {
      const state = expectFailure(await h.placeOrderV2(null, fd), "INVALID_INPUT");
      expectNoCardData(state);
    }
    expect(h.placeCalls.n).toBe(0);
    expect(orderCount(h.db)).toBe(0);
    expectNoSuccessSideEffects(h);
  });
});

// ===========================================================================
// 7. Success path
// ===========================================================================

describe("7. success path", () => {
  test("revalidates exactly /cart, ('/', 'layout'), /orders, then redirects last to /orders/<id>?placed=1", async () => {
    const h = setup();
    fill(h);
    const url = await expectRedirect(h.placeOrderV2(null, newForm()));
    const { orderId, notice } = parsePlaced(url);
    expect(notice).toBeNull();
    expect(url).toBe(orderPlacedHref(orderId, null));
    expect(url).toBe(`/orders/${orderId}?placed=1`);
    expect(h.revalidateCalls).toEqual([["/cart"], ["/", "layout"], ["/orders"]]);
    expect(h.events.at(-1)).toBe("redirect");
    expect(h.redirects).toEqual([url]);
  });

  test("revalidate throwing after the order placed -> INTERNAL_ERROR (key kept); the retry with the same key replays the order", async () => {
    let fail = true;
    const calls: string[] = [];
    const h = setup({
      revalidate: (path) => {
        calls.push(path);
        if (fail) throw new Error(`cache down ada@example.com ${S1}`);
      },
    });
    fill(h);
    const fd = newForm();
    const state = expectFailure(await h.placeOrderV2(null, fd), "INTERNAL_ERROR");
    expect(state.error.message).toBe(CHECKOUT_MESSAGES_V2.unexpected);
    expect(state.values?.fullName).toBe(ADDRESS.fullName);
    expectNoCardData(state);
    expect(h.logs).toEqual(["[checkout] CHECKOUT_ACTION_FAILED step=revalidate code=UNEXPECTED"]);
    fail = false;
    const url = await expectRedirect(h.placeOrderV2(null, fd));
    parsePlaced(url);
    expect(orderCount(h.db)).toBe(1);
    expect(h.charges.n).toBe(1);
  });
});

// ===========================================================================
// 8. Privacy / robustness (core)
// ===========================================================================

describe("8. privacy and robustness (core)", () => {
  test("no card data, owner key or address in redirect URL, revalidate args or logs on success with save + notice", async () => {
    const h = setup();
    fill(h);
    for (let i = 0; i < MAX_ADDRESSES_PER_SESSION; i++) saveFor(h, S1, { ...SAVED, line1: `${i} Full Street` });
    const url = await expectRedirect(h.placeOrderV2(null, newForm({ saveAddress: "on", deliveryNote: "Ring twice", phone: "+44 20 7946 0000" })));
    const outward = JSON.stringify({ url, revalidate: h.revalidateCalls, logs: h.logs });
    for (const needle of [S1, "ada", "Ada", "Analytical", "London", "N1", "Ring", "7946", MOCK_CARDS.success]) {
      expect(outward).not.toContain(needle);
    }
    expect(scrubbed(outward)).not.toContain(CVC);
  });

  test("a throwing order service -> INTERNAL_ERROR settled state, values kept, generic message, PII-free log", async () => {
    const h = setup({
      orders: () => ({
        placeOrderV2: () => Promise.reject(new Error(`db exploded ${S1} ada@example.com ${MOCK_CARDS.success} ${CVC}`)),
      }),
    });
    fill(h);
    const state = expectFailure(await h.placeOrderV2(null, newForm()), "INTERNAL_ERROR");
    expect(state.error.message).toBe(CHECKOUT_MESSAGES_V2.unexpected);
    expect(state.error.details).toBeUndefined();
    expect(state.values?.email).toBe(ADDRESS.email);
    expectNoCardData(state);
    expectNoOwnerKey(state, S1);
    expect(h.logs).toEqual(["[checkout] CHECKOUT_ACTION_FAILED step=order code=UNEXPECTED"]);
    expectNoSuccessSideEffects(h);
  });

  test("a throwing session reader (non-Next error) -> INTERNAL_ERROR, step=session", async () => {
    const h = setup({
      getSessionId: () => Promise.reject(new Error("cookie store broken")),
    });
    const state = expectFailure(await h.placeOrderV2(null, newForm()), "INTERNAL_ERROR");
    expect(state.error.message).toBe(CHECKOUT_MESSAGES_V2.unexpected);
    expect(h.logs).toEqual(["[checkout] CHECKOUT_ACTION_FAILED step=session code=UNEXPECTED"]);
  });

  test("AddressStorageError on get (saved mode) -> INTERNAL_ERROR step=address with the driver code only", async () => {
    const h = setup({
      addresses: (real) => ({
        get: () => {
          throw new AddressStorageError("get", "SQLITE_IOERR");
        },
        create: real.create.bind(real),
      }),
    });
    fill(h);
    const state = expectFailure(await h.placeOrderV2(null, savedForm(UNKNOWN_ID)), "INTERNAL_ERROR");
    expect(state.values?.addressId).toBe(UNKNOWN_ID);
    expect(h.logs).toEqual(["[checkout] CHECKOUT_ACTION_FAILED step=address code=SQLITE_IOERR"]);
    expect(h.placeCalls.n).toBe(0);
  });

  test("unstable_rethrow first: a NEXT_REDIRECT-digest error from the session reader propagates untouched", async () => {
    const nextRedirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/signin;307;" });
    const h = setup({ getSessionId: () => Promise.reject(nextRedirect) });
    let caught: unknown = null;
    try {
      await h.placeOrderV2(null, newForm());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(nextRedirect);
    expect(h.logs).toEqual([]);
  });

  test("unstable_rethrow inside the save step: a NEXT_REDIRECT from create propagates (not converted to a notice)", async () => {
    const nextRedirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/signin;307;" });
    const h = setup({
      addresses: (real) => ({
        get: real.get.bind(real),
        create: () => {
          throw nextRedirect;
        },
      }),
    });
    fill(h);
    let caught: unknown = null;
    try {
      await h.placeOrderV2(null, newForm({ saveAddress: "on" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(nextRedirect);
    expect(h.logs).toEqual([]);
  });

  test("every returned failure matches the contract shape (ok:false, error{code,message[,details]}, optional values/fieldErrors, no notices)", async () => {
    const h = setup();
    fill(h);
    const states: CheckoutActionStateV2[] = [
      await h.placeOrderV2(null, savedForm(UNKNOWN_ID)),
      await h.placeOrderV2(null, newForm({ shippingMethodId: "warp" })),
      await h.placeOrderV2(null, newForm({ deliveryNote: "n".repeat(201) })),
      await h.placeOrderV2(null, newForm({ email: "x" })),
      await h.placeOrderV2(null, newForm({}, MOCK_CARDS.declined)),
      await h.placeOrderV2(null, newForm({ addressMode: "zzz" })),
    ];
    const allowedTop = new Set(["ok", "error", "values", "fieldErrors"]);
    for (const s of states) {
      if (s === null) throw new Error("null state");
      expect(s.ok).toBe(false);
      for (const k of Object.keys(s)) expect(allowedTop.has(k)).toBe(true);
      expect(typeof s.error.code).toBe("string");
      expect(typeof s.error.message).toBe("string");
      for (const k of Object.keys(s.error)) expect(["code", "message", "details"]).toContain(k);
      if (s.fieldErrors !== undefined) for (const v of Object.values(s.fieldErrors)) expect(typeof v).toBe("string");
      expect(JSON.parse(JSON.stringify(s))).toEqual(JSON.parse(JSON.stringify(s)));
      expectNoCardData(s, MOCK_CARDS.declined);
      expectNoCardData(s);
      expectNoOwnerKey(s, S1);
    }
  });
});

// ===========================================================================
// Part 2: the 'use server' wrapper (checkout-v2.ts)
// ===========================================================================

async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryQaT71v2Xy";
  const all: (readonly [string, string])[] = [
    ["$ACTION_REF_1", ""],
    ["$ACTION_1:0", '{"id":"7f00aa","bound":"$@1"}'],
    ["$ACTION_1:1", "[]"],
    ["$ACTION_KEY", "k123"],
    ...fields,
  ];
  const body =
    all.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") +
    `--${boundary}--\r\n`;
  return new Request("http://localhost/checkout", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  }).formData();
}

function baseFields(key: string, card: string = MOCK_CARDS.success): [string, string][] {
  return [
    ["idempotencyKey", key],
    ...(Object.entries(ADDRESS) as [string, string][]),
    ...(Object.entries(cardFields(card)) as [string, string][]),
  ];
}

async function wiredRedirectUrl(fd: FormData): Promise<string> {
  try {
    const state = await wired.placeOrderV2(null, fd);
    throw new Error(`expected redirect, got ${JSON.stringify(state)}`);
  } catch (e) {
    if (e instanceof RedirectSentinel) return e.url;
    throw e;
  }
}

describe("8/9. wrapper (checkout-v2.ts)", () => {
  beforeEach(() => {
    closeDatabase();
    seedDatabase(getDatabase());
    fakeStore = new FakeCookieStore();
    cookiesImpl = async () => fakeStore;
    wiredRevalidate.mockClear();
    wiredRedirect.mockClear();
  });

  test("exports only the async placeOrderV2; importing it opened no DB", () => {
    expect(Object.keys(wired)).toEqual(["placeOrderV2"]);
    expect(wired.placeOrderV2.constructor.name).toBe("AsyncFunction");
    expect(dbOpenedByImport).toBe(false);
  });

  test("browser-shaped multipart with $ACTION_* fields: guest cookie, success redirect ?placed=1, exact revalidations, no cookie written", async () => {
    const guest = crypto.randomUUID();
    createCartService().addItem(guest, TOTE, 1);
    fakeStore.jar.set(SESSION_COOKIE_NAME, guest);
    const url = await wiredRedirectUrl(
      await browserMultipart([...baseFields(crypto.randomUUID()), ["shippingMethodId", "express"], ["deliveryNote", "Gate code 12"], ["total", "1"], ["sessionId", S2]]),
    );
    const { orderId } = parsePlaced(url);
    const row = getDatabase().query("SELECT session_id AS s, shipping_method_id AS m, total_cents AS t FROM orders WHERE id = ?").get(orderId) as {
      s: string;
      m: string;
      t: number;
    };
    expect(row).toEqual({ s: guest, m: "express", t: 1999 + 999 });
    expect(wiredRevalidate.mock.calls).toEqual([["/cart"], ["/", "layout"], ["/orders"]]);
    expect(wiredRedirect.mock.calls).toEqual([[url]]);
    expect(fakeStore.setCalls).toEqual([]);
    expect(fakeStore.deleteCalls).toEqual([]);
    expect(url).not.toContain(guest);
  });

  test("no cookies at all: EMPTY_CART, readSessionId never mints a cookie", async () => {
    const state = await wired.placeOrderV2(null, await browserMultipart(baseFields(crypto.randomUUID())));
    expect(state?.error.code).toBe("EMPTY_CART");
    expect(fakeStore.setCalls).toEqual([]);
    expect(wiredRevalidate).not.toHaveBeenCalled();
    expect(wiredRedirect).not.toHaveBeenCalled();
  });

  test("signed-in owner: order keyed to the owner key; email comes from the form (not the account); no owner key/token in state, URL or logs", async () => {
    const { getAuthService } = await import("@/server/auth/auth-service");
    const guest = crypto.randomUUID();
    const issued = await getAuthService().signUp(
      { email: "account-holder@example.com", password: "correct horse battery staple 42", displayName: "Acct" },
      { sessionKey: guest, now: Date.now() },
    );
    if (!issued.ok) throw new Error(`signUp failed: ${issued.error.code}`);
    const owner = issued.value.user.ownerKey;
    const token = issued.value.token;
    extraForbidden = [owner, token, "account-holder@example.com"];
    createCartService().addItem(owner, TOTE, 1);
    fakeStore.jar.set(SESSION_COOKIE_NAME, guest);
    fakeStore.jar.set(AUTH_COOKIE_NAME, token);

    // Saved mode without an email: not filled from the account.
    const book = createAddressService({ db: getDatabase() });
    const saved = book.create(owner, { ...SAVED, email: undefined } as Parameters<AddressService["create"]>[1]);
    if (!saved.ok) throw new Error("seed address failed");
    const missing = await browserMultipart([
      ["idempotencyKey", crypto.randomUUID()],
      ["addressMode", "saved"],
      ["addressId", saved.value.id],
      ...(Object.entries(cardFields()) as [string, string][]),
    ]);
    const failState = await wired.placeOrderV2(null, missing);
    expect(failState?.error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(failState?.fieldErrors ?? {})).toEqual(["email"]);
    expect(JSON.stringify(failState)).not.toContain("account-holder@example.com");
    expectNoOwnerKey(failState, owner, token, guest);

    // The guest's address id is not usable by the owner and vice versa (R-9).
    const guestAddr = book.create(guest, { ...OTHER_SAVED, email: undefined } as Parameters<AddressService["create"]>[1]);
    if (!guestAddr.ok) throw new Error("seed guest address failed");
    const foreign = await wired.placeOrderV2(
      null,
      await browserMultipart([["idempotencyKey", crypto.randomUUID()], ["addressMode", "saved"], ["addressId", guestAddr.value.id], ["email", "x@example.com"], ...(Object.entries(cardFields()) as [string, string][])]),
    );
    expect(foreign?.error.code).toBe("NOT_FOUND");
    expectNoOwnerKey(foreign, owner, token, guest);

    const url = await wiredRedirectUrl(
      await browserMultipart([
        ["idempotencyKey", crypto.randomUUID()],
        ["addressMode", "saved"],
        ["addressId", saved.value.id],
        ["email", "typed@example.com"],
        ...(Object.entries(cardFields()) as [string, string][]),
      ]),
    );
    const { orderId } = parsePlaced(url);
    const row = getDatabase().query("SELECT session_id AS s, email AS e FROM orders WHERE id = ?").get(orderId) as { s: string; e: string };
    expect(row).toEqual({ s: owner, e: "typed@example.com" });
    expect(url).not.toContain(owner);
    expect(JSON.stringify(wiredRevalidate.mock.calls)).not.toContain(owner);
    expect(fakeStore.setCalls).toEqual([]);
  }, 30_000);

  test("unstable_rethrow: a NEXT_REDIRECT-digest error thrown by cookies() propagates out of placeOrderV2", async () => {
    const nextRedirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/signin;307;" });
    cookiesImpl = () => Promise.reject(nextRedirect);
    let caught: unknown = null;
    try {
      await wired.placeOrderV2(null, await browserMultipart(baseFields(crypto.randomUUID())));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(nextRedirect);
    expect(wiredRevalidate).not.toHaveBeenCalled();
  });

  test("DB cannot open -> settles with INTERNAL_ERROR and a PII-free log line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-t71-nodb-"));
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    closeDatabase();
    env.DATABASE_PATH = join(blocker, "db.sqlite");
    try {
      const state = await wired.placeOrderV2(null, await browserMultipart(baseFields(crypto.randomUUID())));
      expect(state?.error.code).toBe("INTERNAL_ERROR");
      expect(state?.error.message).toBe(CHECKOUT_MESSAGES_V2.unexpected);
      expectNoCardData(state);
      const lines = consoleSpies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" ")));
      expect(lines).toContain("[checkout] CHECKOUT_ACTION_FAILED step=init code=UNEXPECTED");
    } finally {
      env.DATABASE_PATH = ":memory:";
      closeDatabase();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(existsSync(dir)).toBe(false);
  });

  test("declined card via the wrapper: PAYMENT_FAILED, no card data, no revalidate/redirect, cart kept", async () => {
    const guest = crypto.randomUUID();
    createCartService().addItem(guest, TOTE, 1);
    fakeStore.jar.set(SESSION_COOKIE_NAME, guest);
    const state = await wired.placeOrderV2(null, await browserMultipart(baseFields(crypto.randomUUID(), MOCK_CARDS.declined)));
    expect(state?.error.code).toBe("PAYMENT_FAILED");
    expectNoCardData(state, MOCK_CARDS.declined);
    expectNoOwnerKey(state, guest);
    expect(wiredRevalidate).not.toHaveBeenCalled();
    expect(wiredRedirect).not.toHaveBeenCalled();
    expect(createCartService().getCart(guest).itemCount).toBe(1);
  });

  test("card data is never persisted: no full number / CVC in any orders column", async () => {
    const guest = crypto.randomUUID();
    createCartService().addItem(guest, TOTE, 1);
    fakeStore.jar.set(SESSION_COOKIE_NAME, guest);
    const url = await wiredRedirectUrl(await browserMultipart(baseFields(crypto.randomUUID())));
    const { orderId } = parsePlaced(url);
    const row = getDatabase().query("SELECT * FROM orders WHERE id = ?").get(orderId) as Record<string, unknown>;
    const rest: Record<string, unknown> = { ...row };
    for (const k of ["id", "session_id", "idempotency_key", "payment_ref"]) delete rest[k];
    const json = JSON.stringify(rest).replace(UUID_RE, "<uuid>");
    expect(json).not.toContain(MOCK_CARDS.success);
    expect(json).not.toContain(CVC);
    expect(row.card_last4).toBe("4242");
  });
});

// ===========================================================================
// 10. Pending idempotency-key claim (FIX-checkout-v2), QA side
// ===========================================================================

type ChargeRequestT = import("@/server/payments/payment-provider").ChargeRequest;
type PaymentResultT = import("@/server/payments/payment-provider").PaymentResult;
type PaymentProviderT = import("@/server/payments/payment-provider").PaymentProvider;
const { PENDING_PAYMENT_REF, ORDERS_RANGES, ORDERS_TABS } = await import("@/server/orders/order-service");
const { createRecommendationService } = await import("@/server/recommendations/recommendation-service");
const { createListingService } = await import("@/server/catalog/listing-service");

/** Provider whose charges settle only on `release()`; counts calls. */
function gated(): { provider: PaymentProviderT; calls: ChargeRequestT[]; release: () => void } {
  const inner = createMockPaymentProvider({ latencyMs: 0, now: () => new Date(NOW) });
  const waiting: (() => void)[] = [];
  const calls: ChargeRequestT[] = [];
  return {
    calls,
    provider: {
      charge: (request) => {
        calls.push(request);
        return new Promise<PaymentResultT>((resolve, reject) => {
          waiting.push(() => {
            inner.charge(request).then(resolve, reject);
          });
        });
      },
    },
    release: () => {
      for (const go of waiting.splice(0)) go();
    },
  };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !predicate(); i++) await Bun.sleep(2);
  expect(predicate()).toBe(true);
}

function seededDb(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  return db;
}

const CARD_INPUT = { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: CVC, nameOnCard: "Ada L" };

interface ClaimRow {
  readonly id: string;
  readonly status: string;
  readonly failure_code: string | null;
  readonly payment_ref: string | null;
}
const claimRows = (db: Database): ClaimRow[] =>
  db.query("SELECT id, status, failure_code, payment_ref FROM orders ORDER BY rowid").all() as ClaimRow[];

describe("10. pending claim (FIX-checkout-v2)", () => {
  test("while the charge is in flight the pending row (payment_failed / PROCESSING_ERROR / pending:claim) is invisible to listOrders (every range x tab, with and without query), getOrderView, buy-again, recommendations, best sellers and cancel", async () => {
    const db = seededDb();
    const gate = gated();
    const svc = createOrderService(db, { now: () => NOW, payments: gate.provider, inFlight: new Map() });
    const carts = createCartService(db, { now: () => NOW });
    const recos = createRecommendationService({ db, now: () => NOW });
    const listing = createListingService({ db });
    expect(carts.addItem(S1, TOTE, 2).ok).toBe(true);
    const bestBefore = listing.bestSellers(50, { now: NOW }).map((p) => p.id);

    const placing = svc.placeOrderV2({ sessionId: S1, address: ADDRESS, card: CARD_INPUT, idempotencyKey: "qa-pending-1" }, NOW);
    await until(() => gate.calls.length === 1);

    const rows = claimRows(db);
    expect(rows).toHaveLength(1);
    const pending = rows[0];
    if (pending === undefined) throw new Error("no pending row");
    expect(pending).toMatchObject({ status: "payment_failed", failure_code: "PROCESSING_ERROR", payment_ref: PENDING_PAYMENT_REF });
    expect(PENDING_PAYMENT_REF).toBe("pending:claim");

    for (const range of ORDERS_RANGES) {
      for (const tab of ORDERS_TABS) {
        for (const query of [undefined, "tote", "Canvas"]) {
          const page = svc.listOrders(S1, { range, tab, ...(query === undefined ? {} : { query }) }, NOW);
          expect(`${range}/${tab}/${query ?? ""}:${page.total}:${page.items.length}`).toBe(`${range}/${tab}/${query ?? ""}:0:0`);
        }
      }
    }
    expect(svc.getOrderView(pending.id, S1, NOW)).toBeNull();
    expect(svc.getBuyAgainLines(S1)).toEqual([]);
    expect(recos.buyAgain(S1)).toEqual([]);
    expect(listing.bestSellers(50, { now: NOW }).map((p) => p.id)).toEqual(bestBefore);
    const cancel = svc.cancelOrder(pending.id, S1, NOW);
    expect(cancel.ok ? "OK" : cancel.error.code).toBe("ORDER_NOT_FOUND");
    expect(claimRows(db)[0]).toEqual(pending);
    expect(stockOf(db, TOTE)).toBe(40);

    gate.release();
    const placed = await placing;
    if (!placed.ok) throw new Error(placed.error.code);
    expect(placed.value.id).toBe(pending.id);
    expect(claimRows(db)[0]).toMatchObject({ status: "paid", failure_code: null });
    expect(claimRows(db)[0]?.payment_ref).not.toBe(PENDING_PAYMENT_REF);
    expect(svc.listOrders(S1, { range: "all" }, NOW).total).toBe(1);
    expect(svc.getBuyAgainLines(S1).map((l) => l.productId)).toEqual([TOTE]);
    db.close();
  });

  test("D-T110-2 (FIX-orders-pages): the MVP getOrder reader returns null for a pending claim row (owner and others); the finalized order reads normally", async () => {
    const db = seededDb();
    const gate = gated();
    const svc = createOrderService(db, { now: () => NOW, payments: gate.provider, inFlight: new Map() });
    expect(createCartService(db, { now: () => NOW }).addItem(S1, TOTE, 1).ok).toBe(true);
    const placing = svc.placeOrderV2({ sessionId: S1, address: ADDRESS, card: CARD_INPUT, idempotencyKey: "qa-pending-mvp" }, NOW);
    await until(() => gate.calls.length === 1);
    const id = claimRows(db)[0]?.id ?? "";
    // Pending claim rows are never rendered: getOrder hides them for everyone (D-T110-2).
    expect(svc.getOrder(id, S1)).toBeNull();
    expect(svc.getOrder(id, S2)).toBeNull();
    gate.release();
    await placing;
    expect(svc.getOrder(id, S1)).not.toBeNull();
    expect(svc.getOrder(id, S2)).toBeNull();
    db.close();
  });

  test("through the action: a same-key waiter that times out settles INTERNAL_ERROR (values kept, no charge, no reservation, no revalidate/redirect); the later retry replays the winner", async () => {
    const db = seededDb();
    const gateA = gated();
    const gateB = gated();
    const svcA = createOrderService(db, { now: () => NOW, payments: gateA.provider, inFlight: new Map() });
    const svcB = createOrderService(db, { now: () => NOW, payments: gateB.provider, inFlight: new Map(), claimWaitMs: 40 });
    const h = setup({ db, orders: () => svcB });
    fill(h);
    const key = "qa-waiter-1";
    const first = svcA.placeOrderV2({ sessionId: S1, address: ADDRESS, card: CARD_INPUT, idempotencyKey: key }, NOW);
    await until(() => gateA.calls.length === 1);
    expect(stockOf(db, TOTE)).toBe(40);

    const fd = newForm({ idempotencyKey: key });
    const started = Date.now();
    const state = expectFailure(await h.placeOrderV2(null, fd), "INTERNAL_ERROR");
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(state.error.message).toBe(CHECKOUT_MESSAGES_V2.unexpected);
    expect(state.error.details).toBeUndefined();
    expect(state.fieldErrors).toBeUndefined();
    expect(state.values?.fullName).toBe(ADDRESS.fullName);
    expectNoCardData(state);
    expectNoOwnerKey(state, S1);
    expect(gateB.calls).toHaveLength(0);
    expect(stockOf(db, TOTE)).toBe(40);
    expect(claimRows(db)).toHaveLength(1);
    expectNoSuccessSideEffects(h);

    gateA.release();
    const placed = await first;
    if (!placed.ok) throw new Error(placed.error.code);
    const url = await expectRedirect(h.placeOrderV2(null, fd));
    expect(parsePlaced(url).orderId).toBe(placed.value.id);
    expect(gateB.calls).toHaveLength(0);
    expect(gateA.calls).toHaveLength(1);
    expect(stockOf(db, TOTE)).toBe(40);
    db.close();
  });

  test("through the action: a different owner reusing a pending key gets INVALID_INPUT at once (no wait, no charge)", async () => {
    const db = seededDb();
    const gateA = gated();
    const svcA = createOrderService(db, { now: () => NOW, payments: gateA.provider, inFlight: new Map() });
    const h = setup({ db, orders: () => createOrderService(db, { now: () => NOW, payments: gated().provider, inFlight: new Map() }) });
    fill(h, S1);
    fill(h, S2);
    const first = svcA.placeOrderV2({ sessionId: S1, address: ADDRESS, card: CARD_INPUT, idempotencyKey: "qa-owner-pending" }, NOW);
    await until(() => gateA.calls.length === 1);
    h.session = S2;
    const started = Date.now();
    const state = expectFailure(await h.placeOrderV2(null, newForm({ idempotencyKey: "qa-owner-pending" })), "INVALID_INPUT");
    expect(Date.now() - started).toBeLessThan(1000);
    expectNoOwnerKey(state, S1, S2);
    expect(h.cart.getCart(S2).itemCount).toBe(2);
    gateA.release();
    await first;
    db.close();
  });

  test("finalize failure on the PAID path (via the action) withdraws the claim: no order/lines/events/redemption, stock + coupon released; the kept key then succeeds with one provider charge", async () => {
    const h = setup();
    fill(h);
    expect(h.cart.applyCoupon(S1, "WELCOME10", NOW).ok).toBe(true);
    const internals = h.orders as unknown as { finalizeClaim: (...a: unknown[]) => void };
    const real = internals.finalizeClaim.bind(h.orders);
    internals.finalizeClaim = () => {
      throw new Error(`disk full ${S1} ada@example.com`);
    };
    const fd = newForm();
    const state = expectFailure(await h.placeOrderV2(null, fd), "INTERNAL_ERROR");
    expect(state.error.message).toBe(CHECKOUT_MESSAGES_V2.unexpected);
    expect(h.logs).toEqual(["[checkout] CHECKOUT_ACTION_FAILED step=order code=UNEXPECTED"]);
    expect(orderCount(h.db)).toBe(0);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM order_items")).toBe(0);
    expect(count(h.db, "SELECT COUNT(*) AS n FROM order_events")).toBe(0);
    expect(redemptions(h.db)).toBe(0);
    expect(usedCount(h.db, "WELCOME10")).toBe(0);
    expect(stockOf(h.db, TOTE)).toBe(42);
    expect(h.cart.getCart(S1).itemCount).toBe(2);
    expectNoSuccessSideEffects(h);

    internals.finalizeClaim = real;
    const url = await expectRedirect(h.placeOrderV2(null, fd));
    const row = orderRow(h.db, parsePlaced(url).orderId);
    expect(row).toMatchObject({ status: "paid", coupon_code: "WELCOME10" });
    expect(stockOf(h.db, TOTE)).toBe(40);
    expect(redemptions(h.db)).toBe(1);
    expect(h.charges.n).toBe(2); // two provider calls with the same key ...
    expect(new Set(h.charges.keys).size).toBe(1); // ... which the provider de-duplicates
  });

  test("finalize failure on the DECLINED path withdraws the claim too (no pending row left behind); stock restored", async () => {
    const h = setup();
    fill(h);
    const internals = h.orders as unknown as { finalizeClaim: (...a: unknown[]) => void };
    const real = internals.finalizeClaim.bind(h.orders);
    internals.finalizeClaim = () => {
      throw new Error("disk full");
    };
    const fd = newForm({}, MOCK_CARDS.declined);
    expectFailure(await h.placeOrderV2(null, fd), "INTERNAL_ERROR");
    expect(claimRows(h.db)).toEqual([]);
    expect(stockOf(h.db, TOTE)).toBe(42);
    internals.finalizeClaim = real;
    const again = expectFailure(await h.placeOrderV2(null, fd), "PAYMENT_FAILED");
    expect(claimRows(h.db)).toEqual([{ id: String(again.error.details?.orderId), status: "payment_failed", failure_code: "DECLINED", payment_ref: null }]);
    expect(stockOf(h.db, TOTE)).toBe(42);
  });

  test("no pending marker survives any completed attempt (paid, declined, stock/empty/coupon failures)", async () => {
    const h = setup();
    fill(h);
    await expectRedirect(h.placeOrderV2(null, newForm()));
    fill(h);
    await h.placeOrderV2(null, newForm({}, MOCK_CARDS.declined));
    await h.placeOrderV2(null, newForm({}, MOCK_CARDS.processingError));
    h.db.query("UPDATE products SET stock = 0 WHERE id = ?").run(TOTE);
    await h.placeOrderV2(null, newForm());
    expect(count(h.db, "SELECT COUNT(*) AS n FROM orders WHERE payment_ref = ?", PENDING_PAYMENT_REF)).toBe(0);
  });
});

// ===========================================================================
// 9. Isolation
// ===========================================================================

describe("9. isolation", () => {
  test("data/ holds only .gitkeep; no qa-t71 temp dirs left behind", () => {
    expect(readdirSync(join(ROOT, "data")).filter((n) => !n.startsWith("storefront.sqlite"))).toEqual([".gitkeep"]); // dev DB allowed
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("qa-t71-"))).toEqual([]);
  });
});
