import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// QA-W3-T56 (T70 criterion scope): adversarial tests for the cart server
// actions v2 (saveForLater, moveToCart, applyCoupon, removeCoupon,
// selectShippingMethod, buyNow, addManyToCart).
//
// Part 1 drives `createCartActions` (cart-core) with the real CartService v2,
// real T31 limiter and in-memory SQLite, plus recording fakes that write into
// ONE shared call log so call ORDER can be asserted across deps.
// Part 2 drives the `'use server'` wrappers in `@/app/actions/cart` with
// `next/headers`, `next/cache` and `next/navigation` mocked (registered before
// anything imports them; next/navigation keeps the real exports except
// `redirect`). No test touches ./data.
// ---------------------------------------------------------------------------

interface SetCall {
  readonly name: string;
  readonly value: string;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];
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
    this.jar.delete(name);
  }
}

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (qa sentinel)`);
  }
}

/** Shared ordered log for the wired mocks. */
const wiredLog: string[] = [];
let fakeStore = new FakeCookieStore();
const wiredRevalidatePath = mock((path: string, type?: "page" | "layout"): void => {
  wiredLog.push(type === undefined ? `revalidate:${path}` : `revalidate:${path}:${type}`);
});
const wiredRedirect = mock((url: string): never => {
  wiredLog.push(`redirect:${url}`);
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath: wiredRevalidatePath }));
mock.module("next/navigation", () => ({ ...realNavigation, redirect: wiredRedirect }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { readFileSync, readdirSync } = await import("node:fs");
const { join } = await import("node:path");
type CartActionStateV2 = import("@/components/molecules/_contracts/cart-actions").CartActionStateV2;
type CartTotalsSummary = import("@/components/molecules/_contracts/cart-actions").CartTotalsSummary;
type AppError = import("@/lib/result").AppError;
const { ADD_MANY_MAX_ITEMS } = await import("@/components/molecules/_contracts/cart-actions");
const core = await import("@/app/actions/cart-core");
type CartActionDepsV2 = import("@/app/actions/cart-core").CartActionDepsV2;
type CartServicePortV2 = import("@/app/actions/cart-core").CartServicePortV2;
type CartActionsV2 = import("@/app/actions/cart-core").CartActionsV2;
const { createCartService } = await import("@/server/cart/cart-service");
type CartServiceV2 = import("@/server/cart/cart-service").CartServiceV2;
const { createRateLimiter } = await import("@/server/security/rate-limiter");
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;
const { createDatabase, closeDatabase, getDatabase } = await import("@/server/db/client");
const { runMigrations } = await import("@/server/db/schema");
const { seedDatabase } = await import("@/server/db/seed");
const { recordRedemption } = await import("@/server/pricing/coupon-service");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");

const dbGlobal = globalThis as typeof globalThis & { __storefrontDb?: unknown };
closeDatabase();
const wired = await import("@/app/actions/cart");
const dbOpenedByImport = dbGlobal.__storefrontDb !== undefined;

const ROOT = join(import.meta.dir, "..", "..", "..");
const DATA_DIR = join(ROOT, "data");
const dataBefore = readdirSync(DATA_DIR).sort();

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VICTIM = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const TEE = "prod_organic-cotton-tee"; // 2400, stock 120
const PIN = "prod_enamel-pin-set"; // 50, stock 100
const DESK = "prod_walnut-desk"; // 125000, stock 3
const LAST_ONE = "prod_orbit-of-small-things"; // 1599, stock 1
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const LED = "prod_smart-led-bulb-set"; // stock 0

const TWELVE_IN_STOCK = [
  TEE,
  PIN,
  "prod_shampoo-bar-rosemary",
  "prod_smart-plug-2-pack",
  "prod_notebook-dot-grid",
  "prod_wireless-charging-pad",
  "prod_gentle-gel-cleanser",
  "prod_insulated-camp-mug",
  "prod_merino-beanie",
  "prod_usb-c-hub",
  "prod_hydrating-face-serum",
  "prod_rechargeable-headlamp",
] as const;

const INVALID_COUPON_STATE = {
  ok: false,
  error: { code: "COUPON_INVALID", message: "That promo code is not valid.", details: { field: "couponCode" } },
} as const;
const INVALID_COUPON_JSON = JSON.stringify(INVALID_COUPON_STATE);

const EMPTY_STATE = {
  ok: true,
  value: {
    itemCount: 0,
    subtotalCents: 0,
    message: "Your cart is empty.",
    totals: {
      itemCount: 0,
      subtotalCents: 0,
      discountCents: 0,
      shippingCents: 0,
      totalCents: 0,
      couponCode: null,
      shippingMethodId: null,
    },
  },
} as const;

const INTERNAL_STATE = {
  ok: false,
  error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
} as const;

const FORGED: Readonly<Record<string, string>> = {
  sessionId: VICTIM,
  session: VICTIM,
  ownerKey: VICTIM,
  price: "1",
  priceCents: "1",
  unitPriceCents: "1",
  subtotal: "1",
  subtotalCents: "1",
  discount: "999999",
  discountCents: "999999",
  shipping: "0",
  shippingCents: "0",
  total: "1",
  totalCents: "1",
  redirectTo: "https://evil.example/phish",
  next: "//evil.example",
};

/** FormData that records every key read through get/getAll/has. */
class RecordingFormData extends FormData {
  readonly reads: string[] = [];
  override get(name: string): FormDataEntryValue | null {
    this.reads.push(name);
    return super.get(name);
  }
  override getAll(name: string): FormDataEntryValue[] {
    this.reads.push(name);
    return super.getAll(name);
  }
  override has(name: string): boolean {
    this.reads.push(name);
    return super.has(name);
  }
}

function form(fields: readonly (readonly [string, string | Blob])[]): FormData {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  return fd;
}

function recording(fields: readonly (readonly [string, string])[]): RecordingFormData {
  const fd = new RecordingFormData();
  for (const [k, v] of fields) fd.append(k, v);
  for (const [k, v] of Object.entries(FORGED)) fd.append(k, v);
  return fd;
}

/** FormData as a browser serialises a multipart post with JS disabled (`$ACTION_*` replayed). */
async function multipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryQaC4rtV2Mz9pLk";
  const all: (readonly [string, string])[] = [["$ACTION_ID_qa", ""], ...fields];
  const body =
    all.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") +
    `--${boundary}--\r\n`;
  const request = new Request("http://localhost/cart", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return request.formData();
}

function freshDb(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  return db;
}

interface Harness {
  readonly db: Database;
  readonly service: CartServiceV2;
  readonly log: string[];
  readonly logLines: string[];
  readonly clock: { ms: number };
  readonly session: { current: string | null };
  readonly getSessionId: ReturnType<typeof mock<() => Promise<string>>>;
  readonly readSessionId: ReturnType<typeof mock<() => Promise<string | null>>>;
  readonly revalidate: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  readonly redirect: ReturnType<typeof mock<(path: string) => never>>;
  readonly actions: CartActionsV2;
}

interface HarnessOptions {
  readonly db?: Database;
  readonly session?: string | null;
  readonly createSession?: string;
  readonly cart?: (real: CartServiceV2, log: string[]) => CartServicePortV2;
  readonly limiter?: RateLimiter;
  readonly getSessionId?: () => Promise<string>;
  readonly omitLogError?: boolean;
}

/** Logs every service call (name only) into `log`, then delegates. */
function loggingPort(real: CartServiceV2, log: string[]): CartServicePortV2 {
  return {
    addItem: (...a) => (log.push("service.addItem"), real.addItem(...a)),
    setQuantity: (...a) => (log.push("service.setQuantity"), real.setQuantity(...a)),
    removeItem: (...a) => (log.push("service.removeItem"), real.removeItem(...a)),
    getCartView: (...a) => (log.push("service.getCartView"), real.getCartView(...a)),
    saveForLater: (...a) => (log.push("service.saveForLater"), real.saveForLater(...a)),
    moveToCart: (...a) => (log.push("service.moveToCart"), real.moveToCart(...a)),
    applyCoupon: (...a) => (log.push("service.applyCoupon"), real.applyCoupon(...a)),
    removeCoupon: (...a) => (log.push("service.removeCoupon"), real.removeCoupon(...a)),
    selectShippingMethod: (...a) => (log.push("service.selectShippingMethod"), real.selectShippingMethod(...a)),
  };
}

function harness(options: HarnessOptions = {}): Harness {
  const db = options.db ?? freshDb();
  const clock = { ms: NOW };
  const service = createCartService(db, { now: () => clock.ms });
  const log: string[] = [];
  const logLines: string[] = [];
  const session = { current: options.session === undefined ? SESSION : options.session };
  const createSession = options.createSession ?? SESSION;
  const getSessionId = mock(
    options.getSessionId ??
      (async (): Promise<string> => {
        log.push("getSessionId");
        return createSession;
      }),
  );
  const readSessionId = mock(async (): Promise<string | null> => {
    log.push("readSessionId");
    return session.current;
  });
  const revalidate = mock((path: string, type?: "page" | "layout"): void => {
    log.push(type === undefined ? `revalidate:${path}` : `revalidate:${path}:${type}`);
  });
  const redirect = mock((path: string): never => {
    log.push(`redirect:${path}`);
    throw new RedirectSentinel(path);
  });
  const realLimiter = options.limiter ?? createRateLimiter(db, { now: () => clock.ms, logger: { error: () => undefined } });
  const limiter: RateLimiter = {
    check: (key, rule) => {
      log.push(`limiter:${key}`);
      return realLimiter.check(key, rule);
    },
  };
  const deps: CartActionDepsV2 = {
    getSessionId,
    readSessionId,
    cart: options.cart ? options.cart(service, log) : loggingPort(service, log),
    limiter,
    revalidate,
    redirect,
    now: () => clock.ms,
    ...(options.omitLogError ? {} : { logError: (line: string): void => void logLines.push(line) }),
  };
  return {
    db,
    service,
    log,
    logLines,
    clock,
    session,
    getSessionId,
    readSessionId,
    revalidate,
    redirect,
    actions: core.createCartActions(deps),
  };
}

function cartRows(db: Database): unknown[] {
  return db.query("SELECT cart_session_id AS s, product_id AS p, quantity AS q FROM cart_items ORDER BY s, p").all();
}

function savedRows(db: Database): unknown[] {
  return db
    .query(
      `SELECT l.session_id AS s, li.product_id AS p, li.quantity_desired AS q FROM list_items li
         JOIN lists l ON l.id = li.list_id WHERE l.kind = 'save_for_later' ORDER BY s, p`,
    )
    .all();
}

function settings(db: Database): unknown[] {
  return db.query("SELECT session_id AS s, coupon_code AS c, shipping_method_id AS m FROM carts ORDER BY s").all();
}

function snapshot(db: Database): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const t of ["carts", "cart_items", "lists", "list_items", "rate_limits", "coupon_redemptions", "coupons", "products"]) {
    out[t] = db.query(`SELECT * FROM ${t} ORDER BY rowid`).all();
  }
  return out;
}

function totalsOf(service: CartServiceV2, session = SESSION): CartTotalsSummary {
  const view = service.getCartView(session, NOW);
  if (!view.ok) throw new Error(`view failed: ${view.error.code}`);
  return core.summarizeCartView(view.value);
}

function expectErr(state: CartActionStateV2, code: AppError["code"]): AppError {
  if (state === null || state.ok) throw new Error(`expected ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code);
  return state.error;
}

function expectOk(state: CartActionStateV2): NonNullable<Extract<CartActionStateV2, { ok: true }>>["value"] {
  if (state === null || !state.ok) throw new Error(`expected ok, got ${JSON.stringify(state)}`);
  return state.value;
}

function onlyRevalidations(log: readonly string[]): string[] {
  return log.filter((l) => l.startsWith("revalidate:"));
}

function inflate(db: Database, productIds: readonly string[]): void {
  // Near-MAX_SAFE_INTEGER prices: two lines cannot be summed safely.
  for (const id of productIds) {
    db.query("UPDATE products SET list_price_cents = NULL, price_cents = 9007199254740000 WHERE id = ?").run(id);
  }
}

// ===========================================================================
// Part 1: cart-core with real services
// ===========================================================================

describe("applyCoupon: order code check -> session -> limiter -> service", () => {
  const badCodes: readonly (readonly [string, readonly (readonly [string, string | Blob])[]])[] = [
    ["missing field", []],
    ["empty", [["couponCode", ""]]],
    ["whitespace", [["couponCode", "   "]]],
    ["space inside", [["couponCode", "WELCOME 10"]]],
    ["markup", [["couponCode", "<script>alert(1)</script>"]]],
    ["sql-ish", [["couponCode", "x' OR '1'='1"]]],
    ["non-ascii letter", [["couponCode", "WELCÖME10"]]],
    ["zero-width joiner", [["couponCode", "WELCOME‍10"]]],
    ["33 chars", [["couponCode", "A".repeat(33)]]],
    ["100k chars", [["couponCode", "A".repeat(100_000)]]],
    ["File value", [["couponCode", new File(["WELCOME10"], "c.txt")]]],
  ];

  for (const [label, fields] of badCodes) {
    test(`bad code (${label}): byte-identical COUPON_INVALID before the session, limiter or service`, async () => {
      const h = harness();
      const before = snapshot(h.db);
      const state = await h.actions.applyCoupon(null, form(fields));
      expect(JSON.stringify(state)).toBe(INVALID_COUPON_JSON);
      expect(h.log).toEqual([]);
      expect(snapshot(h.db)).toEqual(before);
    });
  }

  test("no cookie: byte-identical COUPON_INVALID after reading the session; limiter and service never called", async () => {
    const h = harness({ session: null });
    const before = snapshot(h.db);
    const state = await h.actions.applyCoupon(null, form([["couponCode", "WELCOME10"]]));
    expect(JSON.stringify(state)).toBe(INVALID_COUPON_JSON);
    expect(h.log).toEqual(["readSessionId"]);
    expect(h.getSessionId).not.toHaveBeenCalled();
    expect(snapshot(h.db)).toEqual(before);
  });

  test("unknown code and inactive coupon (real service) are byte-identical to the bad-charset state", async () => {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", TOTE], ["quantity", "2"]]));
    h.db.query("UPDATE coupons SET is_active = 0 WHERE code = 'SAVE5'").run();
    for (const code of ["NOPE", "welcome11", "save5", "  SAVE5  "]) {
      const state = await h.actions.applyCoupon(null, form([["couponCode", code]]));
      expect(JSON.stringify(state)).toBe(INVALID_COUPON_JSON);
    }
  });

  test("valid code: exact dependency order, then revalidation, then totals read", async () => {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", TOTE], ["quantity", "2"]]));
    h.log.length = 0;
    const value = expectOk(await h.actions.applyCoupon(null, form([["couponCode", " welcome10 "]])));
    expect(h.log).toEqual([
      "readSessionId",
      `limiter:coupon.apply:${SESSION}`,
      "limiter:coupon.apply:*",
      "service.applyCoupon",
      "revalidate:/cart",
      "revalidate:/checkout",
      "revalidate:/:layout",
      "service.getCartView",
    ]);
    expect(value.kind).toBe("coupon_applied");
    expect(value.totals).toEqual(totalsOf(h.service));
    expect(value.totals?.couponCode).toBe("WELCOME10");
    expect(value.totals?.discountCents).toBe(399); // floor(3998 * 10 / 100), server-computed
  });
});

describe("applyCoupon: mapped service errors keep the previous coupon", () => {
  test("EXPIRED / EXHAUSTED / USED / MIN_SUBTOTAL exact states; WELCOME10 still applied; nothing revalidated", async () => {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", TOTE], ["quantity", "1"]])); // 1999
    expectOk(await h.actions.applyCoupon(null, form([["couponCode", "WELCOME10"]])));
    expect(recordRedemption(h.db, "FREESHIP", SESSION, "qa-order-1").ok).toBe(true);
    h.log.length = 0;

    expect(await h.actions.applyCoupon(null, form([["couponCode", "expired10"]]))).toEqual({
      ok: false,
      error: { code: "COUPON_EXPIRED", message: "This promo code has expired." },
    });
    expect(await h.actions.applyCoupon(null, form([["couponCode", "MAXED5"]]))).toEqual({
      ok: false,
      error: { code: "COUPON_EXHAUSTED", message: "This promo code is no longer available." },
    });
    expect(await h.actions.applyCoupon(null, form([["couponCode", "FREESHIP"]]))).toEqual({
      ok: false,
      error: { code: "COUPON_USED", message: "You have already used this promo code." },
    });
    expect(await h.actions.applyCoupon(null, form([["couponCode", "SAVE5"]]))).toEqual({
      ok: false,
      error: {
        code: "COUPON_MIN_SUBTOTAL",
        message: "Add $5.01 more to use this promo code.",
        details: { shortfallCents: 501, minSubtotalCents: 2500 },
      },
    });
    expect(await h.actions.applyCoupon(null, form([["couponCode", "NOPE"]]))).toEqual(INVALID_COUPON_STATE);

    expect(settings(h.db)).toEqual([{ s: SESSION, c: "WELCOME10", m: null }]);
    expect(onlyRevalidations(h.log)).toEqual([]);
    expect(totalsOf(h.service).couponCode).toBe("WELCOME10");
  });
});

describe("applyCoupon: rate limit (10 / 10 min per session, 1000 / 10 min global)", () => {
  test("11th apply in the window -> RATE_LIMITED with details.retryAfterSeconds only; service not reached; coupon kept; window resets", async () => {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", TOTE], ["quantity", "2"]]));
    expectOk(await h.actions.applyCoupon(null, form([["couponCode", "WELCOME10"]])));
    for (let i = 1; i < 10; i++) {
      expect(await h.actions.applyCoupon(null, form([["couponCode", `WRONG${i}`]]))).toEqual(INVALID_COUPON_STATE);
    }
    h.log.length = 0;
    const limited = expectErr(await h.actions.applyCoupon(null, form([["couponCode", "SAVE5"]])), "RATE_LIMITED");
    expect(Object.keys(limited.details ?? {})).toEqual(["retryAfterSeconds"]);
    const retry = limited.details?.retryAfterSeconds;
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry as number).toBeGreaterThan(0);
    expect(retry as number).toBeLessThanOrEqual(600);
    expect(limited.message).toMatch(/^Too many promo code attempts\. Please try again in \d+ minutes?\.$/);
    expect(h.log).not.toContain("service.applyCoupon");
    expect(onlyRevalidations(h.log)).toEqual([]);
    expect(settings(h.db)).toEqual([{ s: SESSION, c: "WELCOME10", m: null }]);

    // Still limited a moment later; a valid code does not bypass it.
    h.clock.ms = NOW + 60_000;
    expectErr(await h.actions.applyCoupon(null, form([["couponCode", "WELCOME10"]])), "RATE_LIMITED");

    // After the 10-minute window, the session may try again.
    h.clock.ms = NOW + 10 * 60_000 + 1_000;
    expect(expectOk(await h.actions.applyCoupon(null, form([["couponCode", "SAVE5"]]))).totals?.couponCode).toBe("SAVE5");
  });

  test("bad-charset codes are rejected before the limiter (no limiter rows written)", async () => {
    const h = harness();
    for (let i = 0; i < 15; i++) {
      expect(JSON.stringify(await h.actions.applyCoupon(null, form([["couponCode", `bad code ${i}`]])))).toBe(INVALID_COUPON_JSON);
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM rate_limits").get()).toEqual({ n: 0 });
  });

  test("global backstop trips at 1000 across sessions (real limiter), then a brand-new session is limited", async () => {
    const h = harness();
    for (let s = 0; s < 100; s++) {
      h.session.current = crypto.randomUUID();
      for (let i = 0; i < 10; i++) {
        const state = await h.actions.applyCoupon(null, form([["couponCode", "NOPE"]]));
        if (state === null || state.ok || state.error.code !== "COUPON_INVALID") {
          throw new Error(`attempt ${s * 10 + i + 1} not COUPON_INVALID: ${JSON.stringify(state)}`);
        }
      }
    }
    h.session.current = crypto.randomUUID();
    const limited = expectErr(await h.actions.applyCoupon(null, form([["couponCode", "WELCOME10"]])), "RATE_LIMITED");
    expect(Object.keys(limited.details ?? {})).toEqual(["retryAfterSeconds"]);
    expect(settings(h.db)).toEqual([]);

    h.clock.ms = NOW + 10 * 60_000 + 1_000;
    expect(await h.actions.applyCoupon(null, form([["couponCode", "NOPE"]]))).toEqual(INVALID_COUPON_STATE);
  });

  test("10 parallel applies (mixed codes) all settle, none throw; 11th parallel batch member is limited", async () => {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", TOTE], ["quantity", "2"]]));
    const codes = ["WELCOME10", "SAVE5", "bad code", "EXPIRED10", "MAXED5", "NOPE", "FREESHIP", "", "SAVE5", "WELCOME10", "WELCOME10"];
    const settled = await Promise.allSettled(codes.map((c) => h.actions.applyCoupon(null, form([["couponCode", c]]))));
    expect(settled.map((s) => s.status)).toEqual(codes.map(() => "fulfilled"));
    const states = settled.map((s) => (s.status === "fulfilled" ? s.value : null));
    for (const state of states) expect(state).not.toBeNull();
    // 2 bad-charset codes skip the limiter, so 9 limiter-counted attempts: none limited.
    expect(states.filter((s) => s !== null && !s.ok && s.error.code === "RATE_LIMITED")).toHaveLength(0);
    const stored = (settings(h.db)[0] as { c: string | null }).c;
    expect(["WELCOME10", "SAVE5", "FREESHIP"]).toContain(stored ?? "");
  });
});

describe("buyNow", () => {
  test("success: item added (catalogue price), /cart + layout revalidated, redirect('/checkout') called LAST", async () => {
    const h = harness({ session: null });
    const fd = recording([["productId", TOTE], ["quantity", "2"]]);
    await expect(h.actions.buyNow(null, fd)).rejects.toBeInstanceOf(RedirectSentinel);
    expect(h.log).toEqual(["getSessionId", "service.addItem", "revalidate:/cart", "revalidate:/:layout", "redirect:/checkout"]);
    expect(h.log.at(-1)).toBe("redirect:/checkout");
    expect(h.redirect.mock.calls).toEqual([["/checkout"]]);
    expect(cartRows(h.db)).toEqual([{ s: SESSION, p: TOTE, q: 2 }]);
    expect(totalsOf(h.service).subtotalCents).toBe(3998);
    expect(new Set(fd.reads)).toEqual(new Set(["productId", "quantity"]));
    expect(totalsOf(h.service, VICTIM)).toMatchObject({ itemCount: 0, subtotalCents: 0 });
  });

  const failures: readonly (readonly [string, string, string, AppError["code"], string, boolean])[] = [
    ["unknown product", "prod_does-not-exist", "1", "PRODUCT_NOT_FOUND", "This product is no longer available.", true],
    ["out of stock", POUR_OVER, "1", "OUT_OF_STOCK", "This item is out of stock.", true],
    ["over stock", DESK, "4", "INSUFFICIENT_STOCK", "Only 3 left in stock.", true],
    ["above per-line max", TEE, "100", "INVALID_QUANTITY", "Please choose a quantity between 1 and 99.", true],
    ["zero quantity", TOTE, "0", "INVALID_QUANTITY", "Please choose a quantity between 1 and 99.", true],
    ["negative quantity", TOTE, "-1", "INVALID_INPUT", "Please enter a whole number quantity.", false],
    ["decimal quantity", TOTE, "1.5", "INVALID_INPUT", "Please enter a whole number quantity.", false],
    ["empty productId", "   ", "1", "INVALID_INPUT", "Something was wrong with that request.", false],
  ];
  for (const [label, productId, quantity, code, message, reachesSession] of failures) {
    test(`${label}: typed ${code}, redirect NOT called, nothing revalidated or written`, async () => {
      const h = harness();
      const before = snapshot(h.db);
      const state = await h.actions.buyNow(null, form([["productId", productId], ["quantity", quantity]]));
      const error = expectErr(state, code);
      expect(error.message).toBe(message);
      expect(h.redirect).not.toHaveBeenCalled();
      expect(onlyRevalidations(h.log)).toEqual([]);
      expect(h.getSessionId).toHaveBeenCalledTimes(reachesSession ? 1 : 0);
      expect(snapshot(h.db)).toEqual(before);
    });
  }

  test("over stock counting the existing line (2 of 3 in cart + buy 2) -> INSUFFICIENT_STOCK, no redirect", async () => {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", DESK], ["quantity", "2"]]));
    h.log.length = 0;
    const error = expectErr(await h.actions.buyNow(null, form([["productId", DESK], ["quantity", "2"]])), "INSUFFICIENT_STOCK");
    expect(error.message).toBe("Only 1 left in stock.");
    expect(h.redirect).not.toHaveBeenCalled();
    expect(cartRows(h.db)).toEqual([{ s: SESSION, p: DESK, q: 2 }]);
  });

  test("getSessionId throwing -> INTERNAL_ERROR settled, PII-free log, no redirect", async () => {
    const h = harness({
      getSessionId: async () => {
        throw new Error(`cookies() unavailable for ${SESSION}`);
      },
    });
    expect(await h.actions.buyNow(null, form([["productId", TOTE], ["quantity", "1"]]))).toEqual(INTERNAL_STATE);
    expect(h.logLines).toEqual(["[cart] CART_ACTION_FAILED action=buyNow"]);
    expect(h.redirect).not.toHaveBeenCalled();
  });
});

describe("read-path actions with no cookie", () => {
  const cases: readonly (readonly [string, (h: Harness, fd: FormData) => Promise<CartActionStateV2>, readonly (readonly [string, string])[]])[] = [
    ["saveForLater", (h, fd) => h.actions.saveForLater(null, fd), [["productId", TOTE]]],
    ["moveToCart", (h, fd) => h.actions.moveToCart(null, fd), [["productId", TOTE]]],
    ["removeCoupon", (h, fd) => h.actions.removeCoupon(null, fd), []],
    ["selectShippingMethod", (h, fd) => h.actions.selectShippingMethod(null, fd), [["shippingMethodId", "express"]]],
  ];
  for (const [name, run, fields] of cases) {
    test(`${name}: ok empty totals, no rows, no session created, no revalidate; forged sessionId cannot reach the victim`, async () => {
      // Victim has a cart line, a saved item, a coupon and a shipping method.
      const db = freshDb();
      const victim = harness({ db, session: VICTIM, createSession: VICTIM });
      await victim.actions.addToCart(null, form([["productId", TOTE], ["quantity", "1"]]));
      await victim.actions.addToCart(null, form([["productId", TEE], ["quantity", "1"]]));
      expectOk(await victim.actions.saveForLater(null, form([["productId", TEE]])));
      expectOk(await victim.actions.applyCoupon(null, form([["couponCode", "WELCOME10"]])));
      expectOk(await victim.actions.selectShippingMethod(null, form([["shippingMethodId", "next_day"]])));

      const h = harness({ db, session: null });
      const before = snapshot(db);
      const state = await run(h, recording(fields));
      expect(state).toEqual(EMPTY_STATE);
      expect(h.getSessionId).not.toHaveBeenCalled();
      expect(h.log).toEqual(["readSessionId"]);
      expect(snapshot(db)).toEqual(before);
    });
  }
});

describe("forged fields are never read; totals come from the service", () => {
  test("each action reads only its contract fields (recording FormData) and returns service totals", async () => {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", TOTE], ["quantity", "2"]]));
    await h.actions.addToCart(null, form([["productId", PIN], ["quantity", "1"]]));

    const runs: readonly (readonly [string, (fd: FormData) => Promise<CartActionStateV2>, readonly (readonly [string, string])[], readonly string[]])[] = [
      ["saveForLater", (fd) => h.actions.saveForLater(null, fd), [["productId", PIN]], ["productId"]],
      ["moveToCart", (fd) => h.actions.moveToCart(null, fd), [["productId", PIN]], ["productId"]],
      ["applyCoupon", (fd) => h.actions.applyCoupon(null, fd), [["couponCode", "SAVE5"]], ["couponCode"]],
      ["selectShippingMethod", (fd) => h.actions.selectShippingMethod(null, fd), [["shippingMethodId", "express"]], ["shippingMethodId"]],
      ["removeCoupon", (fd) => h.actions.removeCoupon(null, fd), [], []],
      ["addManyToCart", (fd) => h.actions.addManyToCart(null, fd), [["productId", TEE]], ["productId"]],
    ];
    for (const [name, run, fields, allowed] of runs) {
      const fd = recording(fields);
      const value = expectOk(await run(fd));
      expect({ name, reads: [...new Set(fd.reads)].sort() }).toEqual({ name, reads: [...allowed].sort() });
      expect({ name, totals: value.totals }).toEqual({ name, totals: totalsOf(h.service) });
      expect(value.itemCount).toBe(totalsOf(h.service).itemCount);
      expect(value.subtotalCents).toBe(totalsOf(h.service).subtotalCents);
    }
    // Every row lives under the cookie session; the forged session has nothing.
    expect(cartRows(h.db).every((r) => (r as { s: string }).s === SESSION)).toBe(true);
    expect(settings(h.db)).toEqual([{ s: SESSION, c: null, m: "express" }]);
    expect(totalsOf(h.service, VICTIM).itemCount).toBe(0);
    const final = totalsOf(h.service);
    expect(final.subtotalCents).toBe(2 * 1999 + 50 + 2400);
    expect(final.totalCents).toBe(final.subtotalCents - final.discountCents + final.shippingCents);
  });
});

describe("revalidation matrix", () => {
  test("every successful mutation revalidates /cart + layout; coupon and shipping also /checkout; errors revalidate nothing", async () => {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", TOTE], ["quantity", "2"]]));
    const expectRevalidated = async (run: () => Promise<CartActionStateV2>, expected: readonly string[], shouldSucceed = true): Promise<void> => {
      h.log.length = 0;
      const state = await run();
      expect(state?.ok ?? null).toBe(shouldSucceed);
      expect(onlyRevalidations(h.log)).toEqual([...expected]);
    };
    const base = ["revalidate:/cart", "revalidate:/:layout"];
    const withCheckout = ["revalidate:/cart", "revalidate:/checkout", "revalidate:/:layout"];
    await expectRevalidated(() => h.actions.saveForLater(null, form([["productId", TOTE]])), base);
    await expectRevalidated(() => h.actions.moveToCart(null, form([["productId", TOTE]])), base);
    await expectRevalidated(() => h.actions.applyCoupon(null, form([["couponCode", "WELCOME10"]])), withCheckout);
    await expectRevalidated(() => h.actions.selectShippingMethod(null, form([["shippingMethodId", "standard"]])), withCheckout);
    await expectRevalidated(() => h.actions.removeCoupon(null, form([])), withCheckout);
    await expectRevalidated(() => h.actions.addManyToCart(null, form([["productId", PIN]])), base);
    // Failures:
    await expectRevalidated(() => h.actions.moveToCart(null, form([["productId", DESK]])), [], false);
    await expectRevalidated(() => h.actions.selectShippingMethod(null, form([["shippingMethodId", "teleport"]])), [], false);
    await expectRevalidated(() => h.actions.applyCoupon(null, form([["couponCode", "EXPIRED10"]])), [], false);
    await expectRevalidated(() => h.actions.saveForLater(null, form([["productId", ""]])), [], false);
  });
});

describe("addManyToCart", () => {
  test("multipart repeated keys: trimmed, deduped (first wins), invalid dropped, capped at 10 in posted order", async () => {
    const h = harness();
    const fields: (readonly [string, string])[] = [
      ["productId", ""],
      ["productId", ` ${TWELVE_IN_STOCK[0]} `],
      ["productId", TWELVE_IN_STOCK[0]],
      ["productId", "x".repeat(129)],
      ...TWELVE_IN_STOCK.slice(1).map((id) => ["productId", id] as const),
      ["sessionId", VICTIM],
      ["price", "1"],
    ];
    const value = expectOk(await h.actions.addManyToCart(null, await multipart(fields)));
    expect(ADD_MANY_MAX_ITEMS).toBe(10);
    expect(value.perItem).toEqual(TWELVE_IN_STOCK.slice(0, 10).map((productId) => ({ productId, result: "added" })));
    expect(value.message).toBe("Added 10 items to your cart.");
    expect(cartRows(h.db)).toHaveLength(10);
    expect(cartRows(h.db).every((r) => (r as { q: number }).q === 1)).toBe(true);
    expect(h.getSessionId).toHaveBeenCalledTimes(1);
    expect(value.totals).toEqual(totalsOf(h.service));
  });

  test("per-item outcomes added / out_of_stock / capped (stock and per-line max) / unavailable; message 'Added 1 of 5'", async () => {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", LAST_ONE], ["quantity", "1"]])); // holds the only unit
    await h.actions.updateCartQuantity(null, form([["productId", TEE], ["quantity", "99"]])); // at the line max
    h.log.length = 0;
    const value = expectOk(
      await h.actions.addManyToCart(
        null,
        form([
          ["productId", TOTE],
          ["productId", POUR_OVER],
          ["productId", LAST_ONE],
          ["productId", TEE],
          ["productId", "prod_ghost"],
        ]),
      ),
    );
    expect(value.perItem).toEqual([
      { productId: TOTE, result: "added" },
      { productId: POUR_OVER, result: "out_of_stock" },
      { productId: LAST_ONE, result: "capped" },
      { productId: TEE, result: "capped" },
      { productId: "prod_ghost", result: "unavailable" },
    ]);
    expect(value.message).toBe("Added 1 of 5 items to your cart.");
    expect(value.kind).toBe("added_many");
    expect(onlyRevalidations(h.log)).toEqual(["revalidate:/cart", "revalidate:/:layout"]);
    expect(cartRows(h.db)).toEqual([
      { s: SESSION, p: TOTE, q: 1 },
      { s: SESSION, p: TEE, q: 99 },
      { s: SESSION, p: LAST_ONE, q: 1 },
    ].sort((a, b) => a.p.localeCompare(b.p)));
  });

  test("message text: one item / several items", async () => {
    const one = harness();
    expect(expectOk(await one.actions.addManyToCart(null, form([["productId", TOTE]]))).message).toBe("Added 1 item to your cart.");
    const three = harness();
    expect(
      expectOk(await three.actions.addManyToCart(null, form([["productId", TOTE], ["productId", PIN], ["productId", TEE]]))).message,
    ).toBe("Added 3 items to your cart.");
  });

  test("all out of stock -> ok with zero added, 'None of the selected...' message, no revalidate, no cart rows", async () => {
    const h = harness();
    const value = expectOk(await h.actions.addManyToCart(null, form([["productId", POUR_OVER], ["productId", LED]])));
    expect(value.perItem).toEqual([
      { productId: POUR_OVER, result: "out_of_stock" },
      { productId: LED, result: "out_of_stock" },
    ]);
    expect(value.message).toBe("None of the selected items could be added to your cart.");
    expect(value.itemCount).toBe(0);
    expect(onlyRevalidations(h.log)).toEqual([]);
    expect(cartRows(h.db)).toEqual([]);
  });

  test("invalid-only post -> INVALID_INPUT without touching the session or the DB", async () => {
    const h = harness();
    const before = snapshot(h.db);
    for (const fd of [
      form([]),
      form([["productId", ""], ["productId", "   "], ["productId", "y".repeat(129)], ["productId", "z".repeat(10_000)]]),
      form([["productId", new File(["x"], "x.txt")]]),
    ]) {
      expect(await h.actions.addManyToCart(null, fd)).toEqual({
        ok: false,
        error: { code: "INVALID_INPUT", message: "Something was wrong with that request.", details: { field: "productId" } },
      });
    }
    expect(h.log).toEqual([]);
    expect(snapshot(h.db)).toEqual(before);
  });

  test("race for the last unit (20 iterations, two parallel posts, same session) adds exactly once", async () => {
    for (let i = 0; i < 20; i++) {
      const h = harness();
      const [a, b] = await Promise.all([
        h.actions.addManyToCart(null, form([["productId", LAST_ONE], ["productId", PIN]])),
        h.actions.addManyToCart(null, form([["productId", PIN], ["productId", LAST_ONE]])),
      ]);
      const results = [expectOk(a), expectOk(b)].flatMap((v) => v.perItem ?? []).filter((p) => p.productId === LAST_ONE);
      expect(results.map((r) => r.result).sort()).toEqual(["added", "capped"]);
      expect(cartRows(h.db)).toEqual([
        { s: SESSION, p: PIN, q: 2 },
        { s: SESSION, p: LAST_ONE, q: 1 },
      ].sort((x, y) => x.p.localeCompare(y.p)));
    }
  });
});

describe("concurrency across v2 actions", () => {
  test("parallel saveForLater + moveToCart on one product never duplicates or loses it", async () => {
    for (let i = 0; i < 20; i++) {
      const h = harness();
      await h.actions.addToCart(null, form([["productId", TOTE], ["quantity", "3"]]));
      const settled = await Promise.allSettled([
        h.actions.saveForLater(null, form([["productId", TOTE]])),
        h.actions.moveToCart(null, form([["productId", TOTE]])),
        h.actions.saveForLater(null, form([["productId", TOTE]])),
        h.actions.moveToCart(null, form([["productId", TOTE]])),
      ]);
      expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
      const inCart = cartRows(h.db).length;
      const inSaved = savedRows(h.db).length;
      expect(inCart + inSaved).toBe(1);
    }
  });

  test("10 parallel calls across every v2 action settle without throwing", async () => {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", TOTE], ["quantity", "2"]]));
    const settled = await Promise.allSettled([
      h.actions.applyCoupon(null, form([["couponCode", "WELCOME10"]])),
      h.actions.removeCoupon(null, form([])),
      h.actions.applyCoupon(null, form([["couponCode", "SAVE5"]])),
      h.actions.selectShippingMethod(null, form([["shippingMethodId", "express"]])),
      h.actions.selectShippingMethod(null, form([["shippingMethodId", "nope"]])),
      h.actions.saveForLater(null, form([["productId", TOTE]])),
      h.actions.moveToCart(null, form([["productId", TOTE]])),
      h.actions.addManyToCart(null, form([["productId", PIN], ["productId", POUR_OVER]])),
      h.actions.applyCoupon(null, form([["couponCode", "bad code"]])),
      h.actions.removeCoupon(null, form([])),
    ]);
    expect(settled.map((s) => s.status)).toEqual(Array.from({ length: 10 }, () => "fulfilled"));
    for (const s of settled) if (s.status === "fulfilled") expect(s.value).not.toBeNull();
  });
});

describe("unexpected throws -> INTERNAL_ERROR with a PII-free log line", () => {
  const SECRET = `session ${SESSION} code WELCOME10 product ${TOTE} email shopper@example.com`;
  function throwingPort(): CartServicePortV2 {
    const boom = (): never => {
      throw new Error(SECRET);
    };
    return {
      addItem: boom,
      setQuantity: boom,
      removeItem: boom,
      getCartView: boom,
      saveForLater: boom,
      moveToCart: boom,
      applyCoupon: boom,
      removeCoupon: boom,
      selectShippingMethod: boom,
    };
  }
  const runs: readonly (readonly [string, (h: Harness) => Promise<CartActionStateV2>])[] = [
    ["saveForLater", (h) => h.actions.saveForLater(null, form([["productId", TOTE]]))],
    ["moveToCart", (h) => h.actions.moveToCart(null, form([["productId", TOTE]]))],
    ["applyCoupon", (h) => h.actions.applyCoupon(null, form([["couponCode", "WELCOME10"]]))],
    ["removeCoupon", (h) => h.actions.removeCoupon(null, form([]))],
    ["selectShippingMethod", (h) => h.actions.selectShippingMethod(null, form([["shippingMethodId", "express"]]))],
    ["buyNow", (h) => h.actions.buyNow(null, form([["productId", TOTE], ["quantity", "1"]]))],
    ["addManyToCart", (h) => h.actions.addManyToCart(null, form([["productId", TOTE]]))],
  ];
  for (const [name, run] of runs) {
    test(`${name}: settles INTERNAL_ERROR; log is exactly '[cart] CART_ACTION_FAILED action=${name}'`, async () => {
      const h = harness({ cart: () => throwingPort() });
      expect(await run(h)).toEqual(INTERNAL_STATE);
      expect(h.logLines).toEqual([`[cart] CART_ACTION_FAILED action=${name}`]);
      expect(h.redirect).not.toHaveBeenCalled();
      expect(onlyRevalidations(h.log)).toEqual([]);
    });
  }

  test("default sink is console.error with the same PII-free line", async () => {
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => void lines.push(args);
    try {
      const h = harness({ cart: () => throwingPort(), omitLogError: true });
      expect(await h.actions.removeCoupon(null, form([]))).toEqual(INTERNAL_STATE);
    } finally {
      console.error = original;
    }
    expect(lines).toEqual([["[cart] CART_ACTION_FAILED action=removeCoupon"]]);
  });
});

describe("MONEY_OVERFLOW surfaced for totals overflow", () => {
  async function overflowingHarness(): Promise<Harness> {
    const h = harness();
    await h.actions.addToCart(null, form([["productId", TOTE], ["quantity", "1"]]));
    await h.actions.addToCart(null, form([["productId", PIN], ["quantity", "1"]]));
    inflate(h.db, [TOTE, PIN]);
    h.log.length = 0;
    return h;
  }
  const MONEY = { ok: false, error: { code: "MONEY_OVERFLOW", message: "This cart total is too large to process." } } as const;

  test("removeCoupon / selectShippingMethod / applyCoupon / addManyToCart on an overflowing cart -> MONEY_OVERFLOW state", async () => {
    const h = await overflowingHarness();
    expect(await h.actions.removeCoupon(null, form([]))).toEqual(MONEY);
    expect(await h.actions.selectShippingMethod(null, form([["shippingMethodId", "express"]]))).toEqual(MONEY);
    expect(await h.actions.applyCoupon(null, form([["couponCode", "WELCOME10"]]))).toEqual(MONEY);
    expect(await h.actions.addManyToCart(null, form([["productId", TEE]]))).toEqual(MONEY);
    expect(h.logLines).toEqual([]);
  });

  test("buyNow on an overflowing cart -> MONEY_OVERFLOW code, no redirect", async () => {
    const h = await overflowingHarness();
    const state = await h.actions.buyNow(null, form([["productId", TEE], ["quantity", "1"]]));
    expect(h.redirect).not.toHaveBeenCalled();
    expectErr(state, "MONEY_OVERFLOW");
  });

  // D-T56-1 (open): buyNow maps service errors with the v1 mapper, so MONEY_OVERFLOW gets the generic message.
  test("D-T56-1: buyNow MONEY_OVERFLOW carries the same overflow message as the other v2 actions", async () => {
    const h = await overflowingHarness();
    const state = await h.actions.buyNow(null, form([["productId", TEE], ["quantity", "1"]]));
    expect(h.redirect).not.toHaveBeenCalled();
    expect(state).toEqual(MONEY);
  });
});

describe("'use server' module (static checks)", () => {
  const source = readFileSync(join(ROOT, "src", "app", "actions", "cart.ts"), "utf8");

  test("starts with 'use server' and every export is an async function", () => {
    expect(source.trimStart().startsWith('"use server";')).toBe(true);
    const exportLines = source.split("\n").filter((l) => /^export\b/.test(l));
    expect(exportLines.length).toBe(10);
    for (const line of exportLines) expect(line).toMatch(/^export async function \w+\(/);
  });

  test("no DB, service or limiter is built at module top level", () => {
    const topLevel = source
      .split("\n")
      .filter((l) => !/^\s/.test(l) && !/^(import|export|function|async function|type|\/\/|\/\*|\s*\*|\}|$)/.test(l) && !l.startsWith('"use server"'));
    // Only the multi-line `type V2Name =` union continuation lines are allowed.
    for (const line of topLevel) expect(line).toMatch(/^\s*\|/);
  });
});

// ===========================================================================
// Part 2: wired 'use server' module (next/* mocked)
// ===========================================================================

function wiredCartRows(): unknown[] {
  return cartRows(getDatabase());
}

beforeEach(() => {
  env.DATABASE_PATH = ":memory:";
  closeDatabase();
  fakeStore = new FakeCookieStore();
  wiredLog.length = 0;
  wiredRevalidatePath.mockClear();
  wiredRedirect.mockClear();
});

describe("wired: module shape", () => {
  test("exports exactly the 3 MVP + 7 v2 async functions; import opened no database", () => {
    expect(Object.keys(wired).sort()).toEqual([
      "addManyToCart",
      "addToCart",
      "applyCoupon",
      "buyNow",
      "moveToCart",
      "removeCoupon",
      "removeFromCart",
      "saveForLater",
      "selectShippingMethod",
      "updateCartQuantity",
    ]);
    for (const value of Object.values(wired)) {
      expect(typeof value).toBe("function");
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
    expect(dbOpenedByImport).toBe(false);
  });
});

describe("wired: no cookie", () => {
  test("read-path actions: ok empty totals, no Set-Cookie, no rows, no revalidate (also with a garbage cookie)", async () => {
    seedDatabase(getDatabase());
    for (const garbage of [undefined, "not-a-uuid", VICTIM.toUpperCase()]) {
      fakeStore = new FakeCookieStore();
      if (garbage !== undefined) fakeStore.jar.set(SESSION_COOKIE_NAME, garbage);
      const before = snapshot(getDatabase());
      const withForged = (fields: readonly (readonly [string, string])[]): Promise<FormData> =>
        multipart([...fields, ...Object.entries(FORGED)]);
      expect(await wired.saveForLater(null, await withForged([["productId", TOTE]]))).toEqual(EMPTY_STATE);
      expect(await wired.moveToCart(null, await withForged([["productId", TOTE]]))).toEqual(EMPTY_STATE);
      expect(await wired.removeCoupon(null, await withForged([]))).toEqual(EMPTY_STATE);
      expect(await wired.selectShippingMethod(null, await withForged([["shippingMethodId", "express"]]))).toEqual(EMPTY_STATE);
      expect(fakeStore.setCalls).toEqual([]);
      expect(snapshot(getDatabase())).toEqual(before);
      expect(wiredRevalidatePath).not.toHaveBeenCalled();
    }
  });

  test("applyCoupon: no cookie, bad charset and unknown code are byte-identical", async () => {
    seedDatabase(getDatabase());
    const noCookie = await wired.applyCoupon(null, await multipart([["couponCode", "WELCOME10"]]));
    expect(fakeStore.setCalls).toEqual([]);
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const badCharset = await wired.applyCoupon(null, await multipart([["couponCode", "<b>x</b>"]]));
    const unknown = await wired.applyCoupon(null, await multipart([["couponCode", "NOPE"]]));
    expect(JSON.stringify(noCookie)).toBe(INVALID_COUPON_JSON);
    expect(JSON.stringify(badCharset)).toBe(INVALID_COUPON_JSON);
    expect(JSON.stringify(unknown)).toBe(INVALID_COUPON_JSON);
  });
});

describe("wired: buyNow", () => {
  test("success: cookie set, item in cart under it, revalidations precede redirect('/checkout') which is last", async () => {
    seedDatabase(getDatabase());
    const fd = await multipart([["productId", TOTE], ["quantity", "3"], ...Object.entries(FORGED)]);
    await expect(wired.buyNow(null, fd)).rejects.toBeInstanceOf(RedirectSentinel);
    expect(wiredLog).toEqual(["revalidate:/cart", "revalidate:/:layout", "redirect:/checkout"]);
    expect(fakeStore.setCalls).toHaveLength(1);
    const cookie = fakeStore.setCalls[0]?.value;
    expect(cookie).not.toBe(VICTIM);
    expect(wiredCartRows()).toEqual([{ s: cookie, p: TOTE, q: 3 }]);
  });

  test("unknown / out-of-stock / over-stock: typed error, redirect never called", async () => {
    seedDatabase(getDatabase());
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    expectErr(await wired.buyNow(null, await multipart([["productId", "prod_ghost"], ["quantity", "1"]])), "PRODUCT_NOT_FOUND");
    expectErr(await wired.buyNow(null, await multipart([["productId", POUR_OVER], ["quantity", "1"]])), "OUT_OF_STOCK");
    expectErr(await wired.buyNow(null, await multipart([["productId", DESK], ["quantity", "9"]])), "INSUFFICIENT_STOCK");
    expect(wiredRedirect).not.toHaveBeenCalled();
    expect(wiredRevalidatePath).not.toHaveBeenCalled();
    expect(wiredCartRows()).toEqual([]);
  });
});

describe("wired: addManyToCart", () => {
  test("invalid-only post -> INVALID_INPUT and no cookie is created", async () => {
    seedDatabase(getDatabase());
    const state = await wired.addManyToCart(null, await multipart([["productId", ""], ["productId", "   "]]));
    expectErr(state, "INVALID_INPUT");
    expect(fakeStore.setCalls).toEqual([]);
    expect(wiredRevalidatePath).not.toHaveBeenCalled();
  });
});

describe("wired: dependency init failure settles", () => {
  test("DB cannot open -> INTERNAL_ERROR settled, PII-free log", async () => {
    env.DATABASE_PATH = "/dev/null/qa-cannot-exist/store.db";
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => void lines.push(args);
    let state: CartActionStateV2 = null;
    try {
      state = await wired.buyNow(null, await multipart([["productId", TOTE], ["quantity", "1"]]));
    } finally {
      console.error = original;
      env.DATABASE_PATH = ":memory:";
    }
    expect(state).toEqual(INTERNAL_STATE);
    expect(wiredRedirect).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(String(lines[0]?.[0])).toMatch(/^\[cart\] CART_ACTION_FAILED action=\w+$/);
  });

  // D-T56-2 (open): runV2 logs action=init instead of the action name.
  test("D-T56-2: DB cannot open -> the log line names the action", async () => {
    env.DATABASE_PATH = "/dev/null/qa-cannot-exist/store.db";
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const lines: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => void lines.push(args);
    let state: CartActionStateV2 = null;
    try {
      state = await wired.selectShippingMethod(null, await multipart([["shippingMethodId", "express"]]));
    } finally {
      console.error = original;
      env.DATABASE_PATH = ":memory:";
    }
    expect(state).toEqual(INTERNAL_STATE);
    expect(JSON.stringify(lines)).not.toContain(SESSION);
    expect(lines).toEqual([["[cart] CART_ACTION_FAILED action=selectShippingMethod"]]);
  });
});

describe("data/ untouched", () => {
  test("the data directory listing is unchanged", () => {
    expect(readdirSync(DATA_DIR).sort()).toEqual(dataBefore);
  });
});

