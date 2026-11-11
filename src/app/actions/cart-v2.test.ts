import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Wiring tests for the v2 cart actions in ./cart (T56). next/headers,
// next/cache and next/navigation are mocked process-wide (bun test), so the
// mocks are registered before `./cart` is imported and delegate to per-test
// state. next/navigation spreads the real exports (unstable_rethrow stays real).
// ---------------------------------------------------------------------------

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

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

  set(name: string, value: string): void {
    this.setCalls.push({ name, value });
    this.jar.set(name, value);
  }
}

let fakeStore = new FakeCookieStore();
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));
mock.module("next/cache", () => ({ revalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
closeDatabase();
const dbGlobal = globalThis as typeof globalThis & { __storefrontDb?: unknown };
const wired = await import("./cart");
const dbOpenedByImport = dbGlobal.__storefrontDb !== undefined;
const { seedDatabase } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");

const TOTE = "prod_canvas-tote-bag"; // 1999
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const EXISTING = "33333333-3333-4333-8333-333333333333";
const FORGED = "44444444-4444-4444-8444-444444444444";

/** Builds FormData the way a browser serialises a multipart form post (JS disabled, `$ACTION_*` replayed). */
async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryW1r3dC4rtV2Lm1T0";
  const all: (readonly [string, string])[] = [["$ACTION_ID_0f9e8d", ""], ...fields];
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

function cartRows(): unknown[] {
  return getDatabase().query("SELECT cart_session_id AS s, product_id AS p, quantity AS q FROM cart_items ORDER BY s, p").all();
}

function settings(): unknown[] {
  return getDatabase().query("SELECT session_id AS s, coupon_code AS c, shipping_method_id AS m FROM carts ORDER BY s").all();
}

function rowCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ["carts", "cart_items", "lists", "list_items", "rate_limits"]) {
    out[t] = getDatabase().query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n ?? -1;
  }
  return out;
}

beforeEach(() => {
  closeDatabase(); // fresh in-memory DB per test
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
  revalidatePath.mockClear();
  redirect.mockClear();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("'use server' module shape", () => {
  test("exports only async functions (3 MVP + 7 v2)", () => {
    const names = Object.keys(wired).sort();
    expect(names).toEqual([
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
    for (const name of names) {
      const value: unknown = wired[name as keyof typeof wired];
      expect(typeof value).toBe("function");
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
  });

  test("importing the module opens no database", () => {
    expect(dbOpenedByImport).toBe(false);
  });
});

describe("buyNow (wired)", () => {
  test("cold: creates the session cookie, adds the item under it, revalidates and redirects to /checkout", async () => {
    const fd = await browserMultipart([["productId", TOTE], ["quantity", "1"], ["sessionId", FORGED], ["price", "1"], ["total", "1"]]);
    await expect(wired.buyNow(null, fd)).rejects.toBeInstanceOf(RedirectSentinel);
    expect(redirect.mock.calls).toEqual([["/checkout"]]);
    expect(fakeStore.setCalls).toHaveLength(1);
    expect(fakeStore.setCalls[0]?.name).toBe(SESSION_COOKIE_NAME);
    expect(cartRows()).toEqual([{ s: fakeStore.setCalls[0]?.value, p: TOTE, q: 1 }]);
    expect(revalidatePath.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
  });

  test("out of stock / unknown product: typed error, no redirect, no revalidation", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const oos = await wired.buyNow(null, await browserMultipart([["productId", POUR_OVER], ["quantity", "1"]]));
    expect(oos).toMatchObject({ ok: false, error: { code: "OUT_OF_STOCK", message: "This item is out of stock." } });
    const unknown = await wired.buyNow(null, await browserMultipart([["productId", "prod_nope"], ["quantity", "1"]]));
    expect(unknown).toMatchObject({ ok: false, error: { code: "PRODUCT_NOT_FOUND" } });
    expect(redirect).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(cartRows()).toEqual([]);
  });
});

describe("addManyToCart (wired)", () => {
  test("cold multipart post with repeated productId keys creates the cookie and adds each once", async () => {
    const fd = await browserMultipart([["productId", TOTE], ["productId", POUR_OVER], ["productId", TOTE], ["sessionId", FORGED], ["price", "1"]]);
    const state = await wired.addManyToCart(null, fd);
    expect(state).toMatchObject({
      ok: true,
      value: {
        kind: "added_many",
        message: "Added 1 of 2 items to your cart.",
        perItem: [
          { productId: TOTE, result: "added" },
          { productId: POUR_OVER, result: "out_of_stock" },
        ],
        totals: { subtotalCents: 1999 },
      },
    });
    expect(fakeStore.setCalls).toHaveLength(1);
    expect(cartRows()).toEqual([{ s: fakeStore.setCalls[0]?.value, p: TOTE, q: 1 }]);
    expect(revalidatePath.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
  });
});

describe("v2 actions without a cookie (readSessionId)", () => {
  test("saveForLater / moveToCart / removeCoupon / selectShippingMethod: empty success, no cookie, no rows", async () => {
    const before = rowCounts();
    const empty = { ok: true, value: { itemCount: 0, subtotalCents: 0, message: "Your cart is empty." } };
    expect(await wired.saveForLater(null, await browserMultipart([["productId", TOTE]]))).toMatchObject(empty);
    expect(await wired.moveToCart(null, await browserMultipart([["productId", TOTE]]))).toMatchObject(empty);
    expect(await wired.removeCoupon(null, await browserMultipart([]))).toMatchObject(empty);
    expect(await wired.selectShippingMethod(null, await browserMultipart([["shippingMethodId", "express"]]))).toMatchObject(empty);
    expect(fakeStore.setCalls).toEqual([]);
    expect(rowCounts()).toEqual(before);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("applyCoupon: generic invalid message, no cookie, no limiter row", async () => {
    const before = rowCounts();
    const state = await wired.applyCoupon(null, await browserMultipart([["couponCode", "WELCOME10"]]));
    expect(state).toEqual({ ok: false, error: { code: "COUPON_INVALID", message: "That promo code is not valid.", details: { field: "couponCode" } } });
    expect(fakeStore.setCalls).toEqual([]);
    expect(rowCounts()).toEqual(before);
  });
});

describe("v2 actions with a cookie", () => {
  test("full flow: save, move back, coupon, shipping; forged session ignored; revalidation paths", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    await wired.addToCart(null, await browserMultipart([["productId", TOTE], ["quantity", "2"]]));

    revalidatePath.mockClear();
    const saved = await wired.saveForLater(null, await browserMultipart([["productId", TOTE], ["sessionId", FORGED]]));
    expect(saved).toMatchObject({ ok: true, value: { kind: "saved", itemCount: 0 } });
    expect(revalidatePath.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(cartRows()).toEqual([]);

    const moved = await wired.moveToCart(null, await browserMultipart([["productId", TOTE]]));
    expect(moved).toMatchObject({ ok: true, value: { kind: "moved", itemCount: 2, subtotalCents: 3998 } });
    expect(cartRows()).toEqual([{ s: EXISTING, p: TOTE, q: 2 }]);

    revalidatePath.mockClear();
    const applied = await wired.applyCoupon(
      null,
      await browserMultipart([["couponCode", "welcome10"], ["sessionId", FORGED], ["discount", "3998"], ["total", "0"]]),
    );
    expect(applied).toMatchObject({ ok: true, value: { kind: "coupon_applied", totals: { couponCode: "WELCOME10", subtotalCents: 3998 } } });
    if (applied !== null && applied.ok) {
      const t = applied.value.totals;
      expect(t?.totalCents).toBe(3998 - (t?.discountCents ?? 0) + (t?.shippingCents ?? 0));
      expect(t?.totalCents).not.toBe(0);
    }
    expect(revalidatePath.mock.calls).toEqual([["/cart"], ["/checkout"], ["/", "layout"]]);

    const shipped = await wired.selectShippingMethod(null, await browserMultipart([["shippingMethodId", "next_day"], ["shipping", "0"]]));
    expect(shipped).toMatchObject({ ok: true, value: { kind: "shipping_selected", totals: { shippingMethodId: "next_day", shippingCents: 1999 } } });

    const removed = await wired.removeCoupon(null, await browserMultipart([]));
    expect(removed).toMatchObject({ ok: true, value: { kind: "coupon_removed", totals: { couponCode: null, discountCents: 0 } } });

    expect(settings()).toEqual([{ s: EXISTING, c: null, m: "next_day" }]);
    expect(fakeStore.setCalls).toEqual([]);
    expect(redirect).not.toHaveBeenCalled();
  });

  test("applyCoupon is rate limited after 10 attempts per session", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    for (let i = 0; i < 10; i++) {
      const s = await wired.applyCoupon(null, await browserMultipart([["couponCode", `NOPE${i}`]]));
      expect(s).toMatchObject({ ok: false, error: { code: "COUPON_INVALID" } });
    }
    const limited = await wired.applyCoupon(null, await browserMultipart([["couponCode", "WELCOME10"]]));
    expect(limited).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    if (limited !== null && !limited.ok) expect(typeof limited.error.details?.retryAfterSeconds).toBe("number");
  });

  test("a database failure settles as INTERNAL_ERROR (no throw, no redirect)", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args);
    };
    try {
      // Warm the singletons, then close the shared handle underneath them.
      await wired.removeCoupon(null, await browserMultipart([]));
      getDatabase().close();
      const state = await wired.buyNow(null, await browserMultipart([["productId", TOTE], ["quantity", "1"]]));
      expect(state).toEqual({ ok: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } });
      expect(redirect).not.toHaveBeenCalled();
      // readSessionId treats a failed owner-key lookup as "no session" (T119), so read-path
      // actions resolve with the empty result instead of throwing.
      const save = await wired.saveForLater(null, await browserMultipart([["productId", TOTE]]));
      expect(save).toMatchObject({ ok: true, value: { itemCount: 0 } });
    } finally {
      console.error = originalError;
      closeDatabase();
    }
    expect(JSON.stringify(errors)).not.toContain(EXISTING);
  });
});

describe("dependency init failure (D-T56-2)", () => {
  test("DB cannot open -> INTERNAL_ERROR, one PII-free log line naming the action", async () => {
    closeDatabase();
    env.DATABASE_PATH = "/dev/null/cart-v2-cannot-exist/store.db";
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const lines: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]): void => {
      lines.push(args);
    };
    const results: unknown[] = [];
    try {
      results.push(await wired.selectShippingMethod(null, await browserMultipart([["shippingMethodId", "express"]])));
      results.push(await wired.addManyToCart(null, await browserMultipart([["productId", TOTE]])));
    } finally {
      console.error = originalError;
      env.DATABASE_PATH = ":memory:";
      closeDatabase();
    }
    const internal = { ok: false, error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." } };
    expect(results).toEqual([internal, internal]);
    expect(redirect).not.toHaveBeenCalled();
    expect(lines).toEqual([["[cart] CART_ACTION_FAILED action=selectShippingMethod"], ["[cart] CART_ACTION_FAILED action=addManyToCart"]]);
    expect(JSON.stringify(lines)).not.toContain(EXISTING);
  });
});
