import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { CartActionStateV2, CartTotalsSummary } from "@/components/molecules/_contracts/cart-actions";
import { CART_FIELD_V2 } from "@/components/molecules/_contracts/cart-actions";
import { fail, ok, type AppError } from "@/lib/result";
import { CartTotalOverflowError, createCartService } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { recordRedemption } from "@/server/pricing/coupon-service";
import { createRateLimiter, type RateLimiter } from "@/server/security/rate-limiter";
import {
  CART_ACTION_FAILED,
  EMPTY_CART_TOTALS,
  MESSAGES_V2,
  createCartActions,
  addManyMessage,
  parseCouponCode,
  parseProductIds,
  parseShippingMethodId,
  summarizeCartView,
  toUserSafeErrorV2,
  type CartActionDepsV2,
  type CartServicePortV2,
} from "./cart-core";

const SESSION = "11111111-1111-4111-8111-111111111111";
const FORGED_SESSION = "22222222-2222-4222-9222-222222222222";
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const DESK = "prod_walnut-desk"; // 125000, stock 3
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const PIN = "prod_enamel-pin-set";
const SKILLET = "prod_cast-iron-skillet";

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** Builds FormData the way a browser serialises a multipart form post (JS disabled, `$ACTION_*` replayed). */
async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryC4rtV2xZPf0aJ4Lm";
  const all: (readonly [string, string])[] = [["$ACTION_ID_7f3a9c", ""], ...fields];
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

interface SetupOptions {
  readonly session?: string | null;
  readonly limiter?: RateLimiter;
  readonly cart?: CartServicePortV2;
}

function setup(options: SetupOptions = {}) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  const service = createCartService(db, { now: () => NOW });
  const session = options.session === undefined ? SESSION : options.session;
  const getSessionId = mock(async () => SESSION);
  const readSessionId = mock(async (): Promise<string | null> => session);
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const redirect = mock((url: string): never => {
    throw new RedirectSentinel(url);
  });
  const logError = mock<(line: string) => void>(() => undefined);
  const limiter = options.limiter ?? createRateLimiter(db, { now: () => NOW, logger: { error: () => undefined } });
  const deps: CartActionDepsV2 = {
    getSessionId,
    readSessionId,
    cart: options.cart ?? service,
    limiter,
    revalidate,
    redirect,
    now: () => NOW,
    logError,
  };
  const actions = createCartActions(deps);
  return { db, service, getSessionId, readSessionId, revalidate, redirect, logError, ...actions };
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

function rowCounts(db: Database): Record<string, number> {
  const tables = ["carts", "cart_items", "lists", "list_items", "rate_limits", "coupon_redemptions"];
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? -1;
  return out;
}

function expectErr(state: CartActionStateV2, code: AppError["code"]): AppError {
  if (state === null || state.ok) throw new Error(`expected ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code);
  return state.error;
}

function expectOk(state: CartActionStateV2) {
  if (state === null || !state.ok) throw new Error(`expected ok, got ${JSON.stringify(state)}`);
  return state.value;
}

function totalsOf(service: ReturnType<typeof createCartService>, session = SESSION): CartTotalsSummary {
  const view = service.getCartView(session, NOW);
  if (!view.ok) throw new Error("view failed");
  return summarizeCartView(view.value);
}

const FORGED: Record<string, string> = {
  sessionId: FORGED_SESSION,
  price: "1",
  priceCents: "1",
  unitPriceCents: "1",
  subtotalCents: "1",
  discount: "99999",
  discountCents: "99999",
  shipping: "0",
  shippingCents: "0",
  total: "1",
  totalCents: "1",
};

// ---------------------------------------------------------------------------

describe("factory", () => {
  test("v2 deps return v1 + v2 actions; v1 deps return only the v1 actions", () => {
    const v2 = setup();
    for (const name of ["addToCart", "updateCartQuantity", "removeFromCart", "saveForLater", "moveToCart", "applyCoupon", "removeCoupon", "selectShippingMethod", "buyNow", "addManyToCart"] as const) {
      expect(typeof v2[name]).toBe("function");
    }
    const v1 = createCartActions({ getSessionId: async () => SESSION, cart: v2.service, revalidate: () => undefined });
    expect(Object.keys(v1).sort()).toEqual(["addToCart", "removeFromCart", "updateCartQuantity"]);
  });

  test("v1 actions behave identically with v2 deps", async () => {
    const { db, addToCart, revalidate } = setup();
    const state = await addToCart(null, form({ productId: TOTE, quantity: "2" }));
    expect(state).toEqual({ ok: true, value: { itemCount: 2, subtotalCents: 3998, message: "Added 2 to your cart." } });
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(cartRows(db)).toEqual([{ s: SESSION, p: TOTE, q: 2 }]);
  });
});

describe("parsers", () => {
  test("parseCouponCode normalises and rejects with the identical generic error", () => {
    expect(parseCouponCode(form({ couponCode: "  welcome10 " }))).toEqual(ok("WELCOME10"));
    const expected = fail("COUPON_INVALID", "That promo code is not valid.", { field: "couponCode" });
    for (const fd of [form({}), form({ couponCode: "" }), form({ couponCode: "bad code" }), form({ couponCode: "ŞAVE" }), form({ couponCode: "x".repeat(33) }), form({ couponCode: "A​B" }), form({ couponCode: new File(["SAVE5"], "c.txt") })]) {
      expect(parseCouponCode(fd)).toEqual(expected);
    }
  });

  test("parseShippingMethodId trims and bounds", () => {
    expect(parseShippingMethodId(form({ shippingMethodId: " express " }))).toEqual(ok("express"));
    for (const fd of [form({}), form({ shippingMethodId: "  " }), form({ shippingMethodId: "x".repeat(65) }), form({ shippingMethodId: "x".repeat(1000) }), form({ shippingMethodId: new File(["a"], "a") })]) {
      const r = parseShippingMethodId(fd);
      expect(r).toEqual(fail("INVALID_INPUT", "Choose a valid shipping method.", { field: "shippingMethodId" }));
    }
  });

  test("CART_FIELD_V2 extends CART_FIELD", () => {
    expect(CART_FIELD_V2).toEqual({ productId: "productId", quantity: "quantity", couponCode: "couponCode", shippingMethodId: "shippingMethodId" });
  });
});

describe("toUserSafeErrorV2", () => {
  test("maps coupon, limiter, list and shipping codes with whitelisted details", () => {
    expect(toUserSafeErrorV2({ code: "COUPON_INVALID", message: "raw", details: { code: "<script>" } })).toEqual({
      code: "COUPON_INVALID",
      message: "That promo code is not valid.",
      details: { field: "couponCode" },
    });
    expect(toUserSafeErrorV2({ code: "COUPON_EXPIRED", message: "raw" })).toEqual({ code: "COUPON_EXPIRED", message: MESSAGES_V2.couponExpired });
    expect(toUserSafeErrorV2({ code: "COUPON_EXHAUSTED", message: "raw" }).message).toBe(MESSAGES_V2.couponExhausted);
    expect(toUserSafeErrorV2({ code: "COUPON_USED", message: "raw" }).message).toBe(MESSAGES_V2.couponUsed);
    expect(toUserSafeErrorV2({ code: "COUPON_MIN_SUBTOTAL", message: "raw", details: { shortfallCents: 501, minSubtotalCents: 2500, x: 1 } })).toEqual({
      code: "COUPON_MIN_SUBTOTAL",
      message: "Add $5.01 more to use this promo code.",
      details: { shortfallCents: 501, minSubtotalCents: 2500 },
    });
    expect(toUserSafeErrorV2({ code: "COUPON_MIN_SUBTOTAL", message: "raw", details: { shortfallCents: -1 } })).toEqual({
      code: "COUPON_MIN_SUBTOTAL",
      message: MESSAGES_V2.couponMinSubtotal,
    });
    expect(toUserSafeErrorV2({ code: "RATE_LIMITED", message: "raw", details: { retryAfterSeconds: 61, key: "coupon.apply:x" } })).toEqual({
      code: "RATE_LIMITED",
      message: "Too many promo code attempts. Please try again in 2 minutes.",
      details: { retryAfterSeconds: 61 },
    });
    expect(toUserSafeErrorV2({ code: "RATE_LIMITED", message: "raw", details: { retryAfterSeconds: 30 } }).message).toBe(
      "Too many promo code attempts. Please try again in 1 minute.",
    );
    expect(toUserSafeErrorV2({ code: "RATE_LIMITED", message: "raw" })).toEqual({ code: "RATE_LIMITED", message: MESSAGES_V2.couponRateLimited });
    expect(toUserSafeErrorV2({ code: "NOT_FOUND", message: "raw", details: { productId: "p" } })).toEqual({ code: "NOT_FOUND", message: MESSAGES_V2.notSaved });
    expect(toUserSafeErrorV2({ code: "LIMIT_REACHED", message: "raw" }).message).toBe(MESSAGES_V2.savedListFull);
    expect(toUserSafeErrorV2({ code: "INVALID_INPUT", message: "raw", details: { field: "shippingMethodId" } })).toEqual({
      code: "INVALID_INPUT",
      message: MESSAGES_V2.shippingInvalid,
      details: { field: "shippingMethodId" },
    });
    expect(toUserSafeErrorV2({ code: "INVALID_INPUT", message: "raw session" })).toEqual({ code: "INVALID_INPUT", message: "Something was wrong with that request." });
    expect(toUserSafeErrorV2({ code: "MONEY_OVERFLOW", message: "raw" }).message).toBe(MESSAGES_V2.moneyOverflow);
    expect(toUserSafeErrorV2({ code: "OUT_OF_STOCK", message: "raw" }).message).toBe("This item is out of stock.");
    expect(toUserSafeErrorV2({ code: "INSUFFICIENT_STOCK", message: "raw", details: { available: 0 } }).message).toBe("No more of this item is available.");
  });
});

// ---------------------------------------------------------------------------

describe("applyCoupon", () => {
  test("success stores the code, returns the new totals, revalidates /cart, /checkout and the layout", async () => {
    const { db, service, addToCart, applyCoupon, revalidate } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    revalidate.mockClear();
    const value = expectOk(await applyCoupon(null, form({ couponCode: "welcome10" })));
    expect(value.kind).toBe("coupon_applied");
    expect(value.message).toBe("Promo code WELCOME10 applied: 10% off.");
    expect(value.totals).toEqual(totalsOf(service));
    expect(value.totals?.couponCode).toBe("WELCOME10");
    expect(value.totals?.subtotalCents).toBe(1999);
    expect(value.totals?.discountCents).toBeGreaterThan(0);
    expect(value.totals?.shippingCents).toBe(499);
    expect(value.totals?.totalCents).toBe(1999 - (value.totals?.discountCents ?? 0) + 499);
    expect(value.itemCount).toBe(1);
    expect(value.subtotalCents).toBe(1999);
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/checkout"], ["/", "layout"]]);
    expect(settings(db)).toEqual([{ s: SESSION, c: "WELCOME10", m: null }]);
  });

  test("unknown, bad charset and over-long codes all return the identical generic error", async () => {
    const { db, addToCart, applyCoupon, revalidate } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    revalidate.mockClear();
    const states = [
      await applyCoupon(null, form({ couponCode: "NOPE" })),
      await applyCoupon(null, form({ couponCode: "bad code!" })),
      await applyCoupon(null, form({ couponCode: "x".repeat(40) })),
      await applyCoupon(null, form({})),
    ];
    for (const s of states) {
      expect(s).toEqual({ ok: false, error: { code: "COUPON_INVALID", message: "That promo code is not valid.", details: { field: "couponCode" } } });
    }
    expect(revalidate).not.toHaveBeenCalled();
    expect(settings(db)).toEqual([{ s: SESSION, c: null, m: null }]);
  });

  test("EXPIRED / EXHAUSTED / USED / MIN_SUBTOTAL map to user-safe messages and keep the applied coupon", async () => {
    const { db, addToCart, applyCoupon, revalidate } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "1" })); // 1999 < SAVE5 minimum 2500
    expectOk(await applyCoupon(null, form({ couponCode: "WELCOME10" })));
    revalidate.mockClear();

    expect(expectErr(await applyCoupon(null, form({ couponCode: "EXPIRED10" })), "COUPON_EXPIRED").message).toBe("This promo code has expired.");
    expect(expectErr(await applyCoupon(null, form({ couponCode: "maxed5" })), "COUPON_EXHAUSTED").message).toBe("This promo code is no longer available.");
    const min = expectErr(await applyCoupon(null, form({ couponCode: "SAVE5" })), "COUPON_MIN_SUBTOTAL");
    expect(min).toEqual({
      code: "COUPON_MIN_SUBTOTAL",
      message: "Add $5.01 more to use this promo code.",
      details: { shortfallCents: 501, minSubtotalCents: 2500 },
    });
    expect(recordRedemption(db, "FREESHIP", SESSION, "order-1").ok).toBe(true);
    expect(expectErr(await applyCoupon(null, form({ couponCode: "FREESHIP" })), "COUPON_USED").message).toBe("You have already used this promo code.");

    expect(settings(db)).toEqual([{ s: SESSION, c: "WELCOME10", m: null }]);
    expect(revalidate).not.toHaveBeenCalled();
  });

  test("no cookie: generic invalid message, no session, no limiter hit, no rows", async () => {
    const { db, applyCoupon, readSessionId, getSessionId, revalidate } = setup({ session: null });
    const before = rowCounts(db);
    const state = await applyCoupon(null, form({ couponCode: "WELCOME10" }));
    expect(state).toEqual({ ok: false, error: { code: "COUPON_INVALID", message: "That promo code is not valid.", details: { field: "couponCode" } } });
    expect(readSessionId).toHaveBeenCalledTimes(1);
    expect(getSessionId).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
    expect(rowCounts(db)).toEqual(before);
  });

  test("rate limited at 10 per session per 10 minutes, BEFORE the service, with retryAfterSeconds", async () => {
    const applySpy = mock<CartServicePortV2["applyCoupon"]>(() => fail("COUPON_INVALID", "raw"));
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db, { now: new Date(NOW) });
    const real = createCartService(db, { now: () => NOW });
    const port: CartServicePortV2 = {
      addItem: (...a) => real.addItem(...a),
      setQuantity: (...a) => real.setQuantity(...a),
      removeItem: (...a) => real.removeItem(...a),
      getCartView: (...a) => real.getCartView(...a),
      saveForLater: (...a) => real.saveForLater(...a),
      moveToCart: (...a) => real.moveToCart(...a),
      applyCoupon: applySpy,
      removeCoupon: (...a) => real.removeCoupon(...a),
      selectShippingMethod: (...a) => real.selectShippingMethod(...a),
    };
    const { applyCoupon } = setup({ cart: port, limiter: createRateLimiter(db, { now: () => NOW }) });
    for (let i = 0; i < 10; i++) expectErr(await applyCoupon(null, form({ couponCode: `TRY${i}` })), "COUPON_INVALID");
    expect(applySpy).toHaveBeenCalledTimes(10);
    const limited = expectErr(await applyCoupon(null, form({ couponCode: "WELCOME10" })), "RATE_LIMITED");
    expect(applySpy).toHaveBeenCalledTimes(10);
    const retry = limited.details?.retryAfterSeconds;
    expect(typeof retry).toBe("number");
    expect(retry as number).toBeGreaterThan(0);
    expect(retry as number).toBeLessThanOrEqual(600);
    expect(Object.keys(limited.details ?? {})).toEqual(["retryAfterSeconds"]);
    expect(limited.message).toMatch(/^Too many promo code attempts\. Please try again in \d+ minutes?\.$/);
  });

  test("global backstop (1000 / 10 min) applies across sessions", async () => {
    const checks: string[] = [];
    const limiter: RateLimiter = {
      check: (key) => {
        checks.push(key);
        return key === "coupon.apply:*" ? fail("RATE_LIMITED", "raw", { retryAfterSeconds: 120 }) : ok({ remaining: 5 });
      },
    };
    const { applyCoupon, db } = setup({ limiter });
    const state = await applyCoupon(null, form({ couponCode: "WELCOME10" }));
    expect(expectErr(state, "RATE_LIMITED").details).toEqual({ retryAfterSeconds: 120 });
    expect(checks).toEqual([`coupon.apply:${SESSION}`, "coupon.apply:*"]);
    expect(settings(db)).toEqual([]);
  });

  test("forged sessionId / price / discount / shipping / total fields are ignored", async () => {
    const { db, service, addToCart, applyCoupon } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    const value = expectOk(await applyCoupon(null, form({ couponCode: "WELCOME10", ...FORGED })));
    expect(value.totals).toEqual(totalsOf(service));
    expect(value.totals?.totalCents).not.toBe(1);
    expect(settings(db)).toEqual([{ s: SESSION, c: "WELCOME10", m: null }]);
  });

  test("browser-shaped multipart post works", async () => {
    const { db, addToCart, applyCoupon } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    expectOk(await applyCoupon(null, await browserMultipart([["couponCode", "welcome10"]])));
    expect(settings(db)).toEqual([{ s: SESSION, c: "WELCOME10", m: null }]);
  });

  test("race: 10 parallel applyCoupon calls all settle without throwing; final state is consistent", async () => {
    const { db, addToCart, applyCoupon } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "2" })); // 3998 >= SAVE5 / FREESHIP minimums
    const codes = ["WELCOME10", "SAVE5", "FREESHIP", "EXPIRED10", "MAXED5", "NOPE", "WELCOME10", "SAVE5", "NOPE2", "FREESHIP"];
    const settled = await Promise.allSettled(codes.map((c) => applyCoupon(null, form({ couponCode: c }))));
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    const states = settled.map((s) => (s.status === "fulfilled" ? s.value : null));
    expect(states.every((s) => s !== null)).toBe(true);
    const applied = states.filter((s) => s?.ok === true);
    expect(applied.length).toBe(6);
    const stored = (settings(db)[0] as { c: string | null }).c;
    expect(["WELCOME10", "SAVE5", "FREESHIP"].includes(stored ?? "")).toBe(true);
    // An 11th attempt in the window is limited.
    expectErr(await applyCoupon(null, form({ couponCode: "WELCOME10" })), "RATE_LIMITED");
  });

  test("race with a failing service: parallel calls still settle (INTERNAL_ERROR), no throw, PII-free log", async () => {
    const { db, addToCart, applyCoupon, logError } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    db.close();
    const settled = await Promise.allSettled(Array.from({ length: 10 }, () => applyCoupon(null, form({ couponCode: "WELCOME10" }))));
    for (const s of settled) {
      expect(s.status).toBe("fulfilled");
      if (s.status === "fulfilled") {
        // The limiter fails closed on a DB error, so the outcome is RATE_LIMITED, never a throw.
        expect(s.value?.ok).toBe(false);
      }
    }
    for (const [line] of logError.mock.calls) {
      expect(line).not.toContain(SESSION);
      expect(line).not.toContain("WELCOME10");
    }
  });
});

describe("removeCoupon", () => {
  test("clears the code, returns totals, revalidates /cart, /checkout and layout; idempotent", async () => {
    const { db, service, addToCart, applyCoupon, removeCoupon, revalidate } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    await applyCoupon(null, form({ couponCode: "WELCOME10" }));
    revalidate.mockClear();
    const value = expectOk(await removeCoupon(null, form({ couponCode: "IGNORED", ...FORGED })));
    expect(value).toEqual({
      itemCount: 1,
      subtotalCents: 1999,
      message: "Promo code removed.",
      kind: "coupon_removed",
      totals: totalsOf(service),
    });
    expect(value.totals?.couponCode).toBeNull();
    expect(value.totals?.discountCents).toBe(0);
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/checkout"], ["/", "layout"]]);
    expect(settings(db)).toEqual([{ s: SESSION, c: null, m: null }]);
    expectOk(await removeCoupon(null, await browserMultipart([])));
  });

  test("no cookie: empty success, no rows, no revalidation", async () => {
    const { db, removeCoupon, revalidate, getSessionId } = setup({ session: null });
    const before = rowCounts(db);
    expect(await removeCoupon(null, form({}))).toEqual({
      ok: true,
      value: { itemCount: 0, subtotalCents: 0, message: "Your cart is empty.", totals: EMPTY_CART_TOTALS },
    });
    expect(rowCounts(db)).toEqual(before);
    expect(revalidate).not.toHaveBeenCalled();
    expect(getSessionId).not.toHaveBeenCalled();
  });
});

describe("selectShippingMethod", () => {
  test("stores the method and returns totals with its price", async () => {
    const { db, service, addToCart, selectShippingMethod, revalidate } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    revalidate.mockClear();
    const value = expectOk(await selectShippingMethod(null, await browserMultipart([["shippingMethodId", "express"], ["shippingCents", "0"]])));
    expect(value.kind).toBe("shipping_selected");
    expect(value.message).toMatch(/^Shipping method set to .+\.$/);
    expect(value.totals).toEqual(totalsOf(service));
    expect(value.totals?.shippingMethodId).toBe("express");
    expect(value.totals?.shippingCents).toBe(999);
    expect(value.totals?.totalCents).toBe(1999 + 999);
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/checkout"], ["/", "layout"]]);
    expect(settings(db)).toEqual([{ s: SESSION, c: null, m: "express" }]);
  });

  test("unknown method -> INVALID_INPUT with field, nothing stored, no revalidation", async () => {
    const { db, addToCart, selectShippingMethod, revalidate } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    revalidate.mockClear();
    for (const fd of [form({ shippingMethodId: "teleport" }), form({ shippingMethodId: "" }), form({})]) {
      expect(expectErr(await selectShippingMethod(null, fd), "INVALID_INPUT")).toEqual({
        code: "INVALID_INPUT",
        message: "Choose a valid shipping method.",
        details: { field: "shippingMethodId" },
      });
    }
    expect(settings(db)).toEqual([{ s: SESSION, c: null, m: null }]);
    expect(revalidate).not.toHaveBeenCalled();
  });

  test("no cookie: empty success, no rows", async () => {
    const { db, selectShippingMethod } = setup({ session: null });
    const before = rowCounts(db);
    expect(expectOk(await selectShippingMethod(null, form({ shippingMethodId: "express" }))).itemCount).toBe(0);
    expect(rowCounts(db)).toEqual(before);
  });
});

describe("saveForLater / moveToCart", () => {
  test("saveForLater moves the line to saved and returns totals", async () => {
    const { db, service, addToCart, saveForLater, revalidate } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "2" }));
    await addToCart(null, form({ productId: DESK, quantity: "1" }));
    revalidate.mockClear();
    const value = expectOk(await saveForLater(null, await browserMultipart([["productId", TOTE], ["sessionId", FORGED_SESSION]])));
    expect(value).toEqual({ itemCount: 1, subtotalCents: 125000, message: "Saved for later.", kind: "saved", totals: totalsOf(service) });
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(cartRows(db)).toEqual([{ s: SESSION, p: DESK, q: 1 }]);
    expect(savedRows(db)).toEqual([{ s: SESSION, p: TOTE, q: 2 }]);
  });

  test("moveToCart moves it back", async () => {
    const { db, addToCart, saveForLater, moveToCart, revalidate } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "2" }));
    await saveForLater(null, form({ productId: TOTE }));
    revalidate.mockClear();
    const value = expectOk(await moveToCart(null, await browserMultipart([["productId", TOTE], ...Object.entries(FORGED)])));
    expect(value.kind).toBe("moved");
    expect(value.message).toBe("Moved to your cart.");
    expect(value.totals?.subtotalCents).toBe(3998);
    expect(value.totals?.itemCount).toBe(2);
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(cartRows(db)).toEqual([{ s: SESSION, p: TOTE, q: 2 }]);
    expect(savedRows(db)).toEqual([]);
  });

  test("moveToCart OUT_OF_STOCK / INSUFFICIENT_STOCK: message, item stays saved, no revalidation", async () => {
    const { db, addToCart, saveForLater, moveToCart, revalidate } = setup();
    await addToCart(null, form({ productId: DESK, quantity: "3" }));
    await saveForLater(null, form({ productId: DESK }));
    await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    await saveForLater(null, form({ productId: TOTE }));
    db.query("UPDATE products SET stock = 0 WHERE id = ?").run(TOTE);
    await addToCart(null, form({ productId: DESK, quantity: "3" })); // fills all DESK stock
    revalidate.mockClear();

    expect(expectErr(await moveToCart(null, form({ productId: TOTE })), "OUT_OF_STOCK").message).toBe("This item is out of stock.");
    expect(expectErr(await moveToCart(null, form({ productId: DESK })), "INSUFFICIENT_STOCK").message).toBe("No more of this item is available.");
    expect(savedRows(db)).toEqual([
      { s: SESSION, p: TOTE, q: 1 },
      { s: SESSION, p: DESK, q: 3 },
    ].sort((a, b) => (a.p < b.p ? -1 : 1)));
    expect(revalidate).not.toHaveBeenCalled();
  });

  test("moveToCart of an item not saved -> NOT_FOUND message; bad productId -> INVALID_INPUT", async () => {
    const { moveToCart, saveForLater } = setup();
    expect(expectErr(await moveToCart(null, form({ productId: TOTE })), "NOT_FOUND").message).toBe(MESSAGES_V2.notSaved);
    expectErr(await moveToCart(null, form({})), "INVALID_INPUT");
    expectErr(await saveForLater(null, form({ productId: "" })), "INVALID_INPUT");
  });

  test("no cookie: empty result and no session rows for both", async () => {
    const { db, saveForLater, moveToCart, revalidate, getSessionId } = setup({ session: null });
    const before = rowCounts(db);
    for (const run of [saveForLater, moveToCart]) {
      expect(await run(null, form({ productId: TOTE }))).toEqual({
        ok: true,
        value: { itemCount: 0, subtotalCents: 0, message: "Your cart is empty.", totals: EMPTY_CART_TOTALS },
      });
    }
    expect(rowCounts(db)).toEqual(before);
    expect(revalidate).not.toHaveBeenCalled();
    expect(getSessionId).not.toHaveBeenCalled();
  });
});

describe("buyNow", () => {
  test("success adds the quantity, revalidates, then redirects to /checkout (last)", async () => {
    const order: string[] = [];
    const { db, buyNow, revalidate, redirect, getSessionId } = setup();
    revalidate.mockImplementation((p: string) => {
      order.push(`revalidate:${p}`);
    });
    redirect.mockImplementation((url: string): never => {
      order.push(`redirect:${url}`);
      throw new RedirectSentinel(url);
    });
    const promise = buyNow(null, await browserMultipart([["productId", TOTE], ["quantity", "2"], ...Object.entries(FORGED)]));
    await expect(promise).rejects.toBeInstanceOf(RedirectSentinel);
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(redirect.mock.calls[0]).toEqual(["/checkout"]);
    expect(order).toEqual(["revalidate:/cart", "revalidate:/", "redirect:/checkout"]);
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(getSessionId).toHaveBeenCalledTimes(1);
    expect(cartRows(db)).toEqual([{ s: SESSION, p: TOTE, q: 2 }]);
  });

  test("out-of-stock, unknown product, insufficient stock and bad input return typed errors and never redirect", async () => {
    const { db, buyNow, redirect, revalidate } = setup();
    expect(expectErr(await buyNow(null, form({ productId: POUR_OVER, quantity: "1" })), "OUT_OF_STOCK").message).toBe("This item is out of stock.");
    expect(expectErr(await buyNow(null, form({ productId: "prod_nope", quantity: "1" })), "PRODUCT_NOT_FOUND").message).toBe(
      "This product is no longer available.",
    );
    expect(expectErr(await buyNow(null, form({ productId: DESK, quantity: "4" })), "INSUFFICIENT_STOCK").message).toBe("Only 3 left in stock.");
    expectErr(await buyNow(null, form({ productId: TOTE, quantity: "0" })), "INVALID_QUANTITY");
    expectErr(await buyNow(null, form({ productId: TOTE, quantity: "two" })), "INVALID_INPUT");
    expectErr(await buyNow(null, form({ quantity: "1" })), "INVALID_INPUT");
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
    expect(cartRows(db)).toEqual([]);
  });

  test("bad input never creates a session", async () => {
    const { buyNow, getSessionId } = setup();
    await buyNow(null, form({ productId: TOTE, quantity: "x" }));
    expect(getSessionId).not.toHaveBeenCalled();
  });

  test("unexpected failures (DB closed, cookie error) return INTERNAL_ERROR without redirect; log is PII-free", async () => {
    const { db, buyNow, redirect, logError } = setup();
    db.close();
    const state = await buyNow(null, form({ productId: TOTE, quantity: "1" }));
    expect(state).toEqual({ ok: false, error: { code: "INTERNAL_ERROR", message: MESSAGES_V2.unexpected } });
    expect(redirect).not.toHaveBeenCalled();
    expect(logError.mock.calls).toEqual([[`[cart] ${CART_ACTION_FAILED} action=buyNow`]]);

    const failing = setup();
    const actions = createCartActions({
      getSessionId: async () => {
        throw new Error(`cookies unavailable for ${SESSION}`);
      },
      readSessionId: async () => null,
      cart: failing.service,
      limiter: createRateLimiter(failing.db),
      revalidate: () => undefined,
      redirect: failing.redirect,
      logError: failing.logError,
    });
    expectErr(await actions.buyNow(null, form({ productId: TOTE, quantity: "1" })), "INTERNAL_ERROR");
    expect(failing.redirect).not.toHaveBeenCalled();
    expect(failing.logError.mock.calls.flat().join(" ")).not.toContain(SESSION);
  });

  test("a MONEY_OVERFLOW from the service gets the v2 overflow message and never redirects (D-T56-1)", async () => {
    const unused = (): never => {
      throw new Error("not called by buyNow");
    };
    const port: CartServicePortV2 = {
      addItem: () => fail("MONEY_OVERFLOW", "raw overflow 9007199254740993"),
      setQuantity: unused,
      removeItem: unused,
      getCartView: unused,
      saveForLater: unused,
      moveToCart: unused,
      applyCoupon: unused,
      removeCoupon: unused,
      selectShippingMethod: unused,
    };
    const { buyNow, redirect, revalidate } = setup({ cart: port });
    const state = await buyNow(null, form({ productId: TOTE, quantity: "1" }));
    expect(state).toEqual({ ok: false, error: { code: "MONEY_OVERFLOW", message: MESSAGES_V2.moneyOverflow } });
    expect(MESSAGES_V2.moneyOverflow).toBe("This cart total is too large to process.");
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  test("the injected rethrow sees unexpected errors first (Next control flow is never swallowed)", async () => {
    const s = setup();
    class ControlFlow extends Error {}
    const actions = createCartActions({
      getSessionId: async () => {
        throw new ControlFlow("NEXT_DYNAMIC");
      },
      readSessionId: async () => {
        throw new ControlFlow("NEXT_DYNAMIC");
      },
      cart: s.service,
      limiter: createRateLimiter(s.db),
      revalidate: () => undefined,
      redirect: s.redirect,
      rethrow: (e) => {
        if (e instanceof ControlFlow) throw e;
      },
      logError: () => undefined,
    });
    await expect(actions.buyNow(null, form({ productId: TOTE, quantity: "1" }))).rejects.toBeInstanceOf(ControlFlow);
    await expect(actions.removeCoupon(null, form({}))).rejects.toBeInstanceOf(ControlFlow);
  });
});

describe("always settle", () => {
  test("a throwing service in every v2 action -> INTERNAL_ERROR (overflow -> MONEY_OVERFLOW)", async () => {
    const boom = (): never => {
      throw new Error("db is locked");
    };
    const port: CartServicePortV2 = {
      addItem: boom,
      setQuantity: boom,
      removeItem: boom,
      getCartView: () => {
        throw new CartTotalOverflowError("overflow");
      },
      saveForLater: boom,
      moveToCart: boom,
      applyCoupon: boom,
      removeCoupon: () => ok(undefined),
      selectShippingMethod: boom,
    };
    const { saveForLater, moveToCart, applyCoupon, removeCoupon, selectShippingMethod, buyNow, redirect, logError } = setup({ cart: port });
    for (const [run, fd] of [
      [saveForLater, form({ productId: TOTE })],
      [moveToCart, form({ productId: TOTE })],
      [applyCoupon, form({ couponCode: "WELCOME10" })],
      [selectShippingMethod, form({ shippingMethodId: "express" })],
      [buyNow, form({ productId: TOTE, quantity: "1" })],
    ] as const) {
      expect(await run(null, fd)).toEqual({ ok: false, error: { code: "INTERNAL_ERROR", message: MESSAGES_V2.unexpected } });
    }
    expect(await removeCoupon(null, form({}))).toEqual({ ok: false, error: { code: "MONEY_OVERFLOW", message: MESSAGES_V2.moneyOverflow } });
    expect(redirect).not.toHaveBeenCalled();
    for (const [line] of logError.mock.calls) expect(line).toMatch(/^\[cart\] CART_ACTION_FAILED action=\w+$/);
  });

  test("a throwing logger does not change the outcome", async () => {
    const s = setup();
    s.db.close();
    const actions = createCartActions({
      getSessionId: async () => SESSION,
      readSessionId: async () => SESSION,
      cart: s.service,
      limiter: { check: () => ok({ remaining: 1 }) },
      revalidate: () => undefined,
      redirect: s.redirect,
      logError: () => {
        throw new Error("log down");
      },
    });
    expectErr(await actions.saveForLater(null, form({ productId: TOTE })), "INTERNAL_ERROR");
  });

  test("prevState is ignored", async () => {
    const { addToCart, removeCoupon } = setup();
    await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    const prev: CartActionStateV2 = { ok: true, value: { itemCount: 99, subtotalCents: 1, message: "x", kind: "saved" } };
    expect(expectOk(await removeCoupon(prev, form({}))).itemCount).toBe(1);
  });
});

describe("addManyToCart", () => {
  test("parseProductIds: repeated keys, trimmed, invalid dropped, deduped, capped at 10", async () => {
    const fd = await browserMultipart([
      ["productId", ` ${TOTE} `],
      ["productId", TOTE],
      ["productId", ""],
      ["productId", "x".repeat(129)],
      ["productId", PIN],
    ]);
    expect(parseProductIds(fd)).toEqual(ok([TOTE, PIN]));
    const many = new FormData();
    for (let i = 0; i < 15; i++) many.append("productId", `prod_${i}`);
    const r = parseProductIds(many);
    expect(r.ok && r.value.length).toBe(10);
    expect(r.ok && r.value[9]).toBe("prod_9");
    for (const bad of [form({}), form({ productId: "  " }), form({ productId: new File(["x"], "x") })]) {
      expect(parseProductIds(bad)).toEqual(fail("INVALID_INPUT", "Something was wrong with that request.", { field: "productId" }));
    }
  });

  test("addManyMessage", () => {
    expect(addManyMessage(1, 1)).toBe("Added 1 item to your cart.");
    expect(addManyMessage(3, 3)).toBe("Added 3 items to your cart.");
    expect(addManyMessage(2, 3)).toBe("Added 2 of 3 items to your cart.");
    expect(addManyMessage(0, 2)).toBe(MESSAGES_V2.noneAdded);
  });

  test("adds 1 of each valid id with per-item outcomes; forged fields ignored; revalidates once", async () => {
    const { db, service, addToCart, addManyToCart, revalidate, getSessionId } = setup();
    await addToCart(null, form({ productId: DESK, quantity: "3" })); // DESK stock fully in cart
    revalidate.mockClear();
    getSessionId.mockClear();
    const fd = await browserMultipart([
      ["productId", TOTE],
      ["productId", POUR_OVER],
      ["productId", DESK],
      ["productId", "prod_nope"],
      ["productId", PIN],
      ["productId", TOTE],
      ["quantity", "50"],
      ...Object.entries(FORGED),
    ]);
    const value = expectOk(await addManyToCart(null, fd));
    expect(value.kind).toBe("added_many");
    expect(value.perItem).toEqual([
      { productId: TOTE, result: "added" },
      { productId: POUR_OVER, result: "out_of_stock" },
      { productId: DESK, result: "capped" },
      { productId: "prod_nope", result: "unavailable" },
      { productId: PIN, result: "added" },
    ]);
    expect(value.message).toBe("Added 2 of 5 items to your cart.");
    expect(value.totals).toEqual(totalsOf(service));
    expect(value.itemCount).toBe(5);
    expect(getSessionId).toHaveBeenCalledTimes(1);
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(cartRows(db)).toEqual(
      [
        { s: SESSION, p: DESK, q: 3 },
        { s: SESSION, p: PIN, q: 1 },
        { s: SESSION, p: TOTE, q: 1 },
      ].sort((a, b) => (a.p < b.p ? -1 : 1)),
    );
  });

  test("all out of stock -> ok with zero added, clear message, no revalidation, no cart rows", async () => {
    const { db, addManyToCart, revalidate } = setup();
    db.query("UPDATE products SET stock = 0 WHERE id IN (?, ?)").run(TOTE, SKILLET);
    const value = expectOk(await addManyToCart(null, await browserMultipart([["productId", TOTE], ["productId", SKILLET], ["productId", POUR_OVER]])));
    expect(value.message).toBe("None of the selected items could be added to your cart.");
    expect(value.perItem?.every((p) => p.result === "out_of_stock")).toBe(true);
    expect(value.itemCount).toBe(0);
    expect(revalidate).not.toHaveBeenCalled();
    expect(cartRows(db)).toEqual([]);
  });

  test("never oversells: last unit across two parallel posts is added once", async () => {
    const { db, addManyToCart } = setup();
    db.query("UPDATE products SET stock = 1 WHERE id = ?").run(TOTE);
    const [a, b] = await Promise.all([addManyToCart(null, form({ productId: TOTE })), addManyToCart(null, form({ productId: TOTE }))]);
    const results = [expectOk(a).perItem?.[0]?.result, expectOk(b).perItem?.[0]?.result].sort();
    expect(results).toEqual(["added", "capped"]);
    expect(cartRows(db)).toEqual([{ s: SESSION, p: TOTE, q: 1 }]);
  });

  test("no valid ids -> INVALID_INPUT without creating a session", async () => {
    const { addManyToCart, getSessionId } = setup();
    expectErr(await addManyToCart(null, form({ quantity: "1" })), "INVALID_INPUT");
    expect(getSessionId).not.toHaveBeenCalled();
  });

  test("unexpected failure -> INTERNAL_ERROR", async () => {
    const { db, addManyToCart } = setup();
    db.close();
    expectErr(await addManyToCart(null, form({ productId: TOTE })), "INTERNAL_ERROR");
  });
});
