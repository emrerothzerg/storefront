import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// QA adversarial tests for T12 (cart server actions).
//
// Part 1 drives `createCartActions` with a real CartService over an in-memory
// SQLite DB, a counting fake `getSessionId` and a `revalidate` spy.
// Part 2 is a wiring test of `@/app/actions/cart` with `next/headers` and
// `next/cache` mocked. `mock.module` is process-wide in bun test, so the
// mocks are registered at the top, before any import that could reach
// `next/headers`, and they delegate to per-test state in this file.
// ---------------------------------------------------------------------------

interface SetCall {
  readonly name: string;
  readonly value: string;
  readonly options: unknown;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string, options?: unknown): void {
    this.setCalls.push({ name, value, options });
    this.jar.set(name, value);
  }
}

let fakeStore = new FakeCookieStore();
const wiredRevalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/cache", () => ({ revalidatePath: wiredRevalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { CART_FIELD } = await import("@/components/molecules/_contracts/cart-actions");
type CartActionState = import("@/components/molecules/_contracts/cart-actions").CartActionState;
const { createCartActions } = await import("@/app/actions/cart-core");
const { createCartService } = await import("@/server/cart/cart-service");
const { createDatabase, closeDatabase, getDatabase } = await import("@/server/db/client");
const { runMigrations } = await import("@/server/db/schema");
const { seedProducts } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const wired = await import("@/app/actions/cart");

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const DESK = "prod_walnut-desk"; // 125000, stock 3
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const PRINT = "prod_limited-print-no-1"; // 18000, stock 1

type Entry = readonly [string, string | Blob];

function fd(entries: readonly Entry[]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

/**
 * Wraps a real FormData in a Proxy that records every property access (any
 * method or field, including iterators) and the arguments of every call, to
 * prove the action reads only the named fields.
 */
function spyFormData(entries: readonly Entry[]): { form: FormData; reads: string[] } {
  const target = fd(entries);
  const reads: string[] = [];
  const form = new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") {
        reads.push(`prop:${String(prop)}`);
        return value;
      }
      return (...args: unknown[]) => {
        reads.push(`${String(prop)}:${args.map(String).join(",")}`);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { form, reads };
}

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedProducts(db);
  const getSessionId = mock(async () => SESSION);
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const actions = createCartActions({ getSessionId, cart: createCartService(db), revalidate });
  return { db, getSessionId, revalidate, ...actions };
}

function snapshot(db: Database): unknown {
  return {
    carts: db.query("SELECT * FROM carts ORDER BY 1").all(),
    items: db.query("SELECT * FROM cart_items ORDER BY 1, 2").all(),
  };
}

/** Business columns only (timestamps differ between two DBs written a millisecond apart). */
function businessRows(db: Database): unknown {
  return {
    carts: db.query("SELECT session_id, currency FROM carts ORDER BY 1").all(),
    items: db.query("SELECT cart_session_id, product_id, quantity FROM cart_items ORDER BY 1, 2").all(),
  };
}

function expectErr(state: CartActionState, code: string) {
  if (state === null || state.ok) throw new Error(`expected ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code as string).toBe(code);
  return state.error;
}

function expectOk(state: CartActionState) {
  if (state === null || !state.ok) throw new Error(`expected ok, got ${JSON.stringify(state)}`);
  return state.value;
}

const LEAK = /SELECT|INSERT|UPDATE |DELETE |sqlite|SQLITE_|constraint|\n\s+at |Error:|TypeError|undefined|null|NaN|\[object/i;

function expectUserSafe(message: string): void {
  expect(typeof message).toBe("string");
  expect(message.trim().length).toBeGreaterThan(0);
  expect(message).not.toMatch(LEAK);
}

function expectJsonRoundTrip(state: CartActionState): void {
  expect(JSON.parse(JSON.stringify(state)) as unknown).toEqual(state);
}

type ActionName = "addToCart" | "updateCartQuantity";
const QTY_ACTIONS: readonly ActionName[] = ["addToCart", "updateCartQuantity"];

// ---------------------------------------------------------------------------
// Criterion 1: hostile input -> INVALID_INPUT, no state change, no throw,
// getSessionId not called, nothing revalidated.
// ---------------------------------------------------------------------------

const HOSTILE_QTY_FORMS: ReadonlyArray<readonly [string, readonly Entry[]]> = [
  ["no fields", []],
  ["missing productId", [["quantity", "1"]]],
  ["missing quantity", [["productId", TOTE]]],
  ["empty productId", [["productId", ""], ["quantity", "1"]]],
  ["whitespace productId", [["productId", " \t\n "], ["quantity", "1"]]],
  ["129-char productId", [["productId", "p".repeat(129)], ["quantity", "1"]]],
  ["File productId", [["productId", new File([TOTE], "id.txt")], ["quantity", "1"]]],
  ["Blob productId", [["productId", new Blob([TOTE])], ["quantity", "1"]]],
  ["File quantity", [["productId", TOTE], ["quantity", new File(["1"], "q.txt")]]],
  ["empty quantity", [["productId", TOTE], ["quantity", ""]]],
  ["full-width digit", [["productId", TOTE], ["quantity", "２"]]],
  ["arabic-indic digit", [["productId", TOTE], ["quantity", "٣"]]],
  ["exponent 1e2", [["productId", TOTE], ["quantity", "1e2"]]],
  ["negative -1", [["productId", TOTE], ["quantity", "-1"]]],
  ["plus +1", [["productId", TOTE], ["quantity", "+1"]]],
  ["decimal 1.0", [["productId", TOTE], ["quantity", "1.0"]]],
  ["four digits 1000", [["productId", TOTE], ["quantity", "1000"]]],
  ["leading space ' 2'", [["productId", TOTE], ["quantity", " 2"]]],
  ["trailing newline '2\\n'", [["productId", TOTE], ["quantity", "2\n"]]],
  ["hex 0x1", [["productId", TOTE], ["quantity", "0x1"]]],
  ["Infinity", [["productId", TOTE], ["quantity", "Infinity"]]],
  ["NaN", [["productId", TOTE], ["quantity", "NaN"]]],
  ["word 'two'", [["productId", TOTE], ["quantity", "two"]]],
  ["1MB digit string", [["productId", TOTE], ["quantity", "1".repeat(1_000_000)]]],
  ["NUL suffix", [["productId", TOTE], ["quantity", "1\u0000"]]],
  ["first duplicate quantity invalid", [["productId", TOTE], ["quantity", "x"], ["quantity", "1"]]],
  ["first duplicate productId empty", [["productId", ""], ["productId", TOTE], ["quantity", "1"]]],
];

describe("criterion 1: malformed productId/quantity -> INVALID_INPUT, no state change", () => {
  for (const action of QTY_ACTIONS) {
    for (const [label, entries] of HOSTILE_QTY_FORMS) {
      test(`${action}: ${label}`, async () => {
        const s = setup();
        // pre-existing line so "no state change" is meaningful for updates
        expectOk(await s.addToCart(null, fd([["productId", TOTE], ["quantity", "2"]])));
        s.getSessionId.mockClear();
        s.revalidate.mockClear();
        const before = snapshot(s.db);

        const state = await s[action](null, fd(entries));

        const e = expectErr(state, "INVALID_INPUT");
        expectUserSafe(e.message);
        expectJsonRoundTrip(state);
        expect(snapshot(s.db)).toEqual(before);
        expect(s.getSessionId).not.toHaveBeenCalled();
        expect(s.revalidate).not.toHaveBeenCalled();
      });
    }
  }

  const HOSTILE_REMOVE: ReadonlyArray<readonly [string, readonly Entry[]]> = [
    ["no fields", []],
    ["empty productId", [["productId", ""]]],
    ["129-char productId", [["productId", "p".repeat(129)]]],
    ["File productId", [["productId", new File([TOTE], "id.txt")]]],
    ["only quantity", [["quantity", "1"]]],
  ];
  for (const [label, entries] of HOSTILE_REMOVE) {
    test(`removeFromCart: ${label}`, async () => {
      const s = setup();
      expectOk(await s.addToCart(null, fd([["productId", TOTE], ["quantity", "2"]])));
      s.getSessionId.mockClear();
      s.revalidate.mockClear();
      const before = snapshot(s.db);
      const state = await s.removeFromCart(null, fd(entries));
      expectUserSafe(expectErr(state, "INVALID_INPUT").message);
      expect(snapshot(s.db)).toEqual(before);
      expect(s.getSessionId).not.toHaveBeenCalled();
      expect(s.revalidate).not.toHaveBeenCalled();
    });
  }

  test("boundary: 128-char productId parses (reaches service -> PRODUCT_NOT_FOUND)", async () => {
    const s = setup();
    const e = expectErr(await s.addToCart(null, fd([["productId", "p".repeat(128)], ["quantity", "1"]])), "PRODUCT_NOT_FOUND");
    expectUserSafe(e.message);
    expect(s.getSessionId).toHaveBeenCalledTimes(1);
  });

  test("'0' parses then fails in the service as INVALID_QUANTITY (not a parse error), no write", async () => {
    const s = setup();
    const before = snapshot(s.db);
    const e = expectErr(await s.addToCart(null, fd([["productId", TOTE], ["quantity", "0"]])), "INVALID_QUANTITY");
    expect(e.message).toBe("Please choose a quantity between 1 and 99.");
    expect(snapshot(s.db)).toEqual(before);
    expect(s.revalidate).not.toHaveBeenCalled();
  });

  test("duplicate keys: the first value wins deterministically", async () => {
    const s = setup();
    const v = expectOk(await s.addToCart(null, fd([["productId", TOTE], ["quantity", "2"], ["quantity", "50"]])));
    expect(v.itemCount).toBe(2);
    const v2 = expectOk(await s.addToCart(null, fd([["productId", DESK], ["productId", TOTE], ["quantity", "1"]])));
    expect(v2.subtotalCents).toBe(125000 + 2 * 1999);
  });

  test("never throws for any hostile form (all settle)", async () => {
    const s = setup();
    const all = [...HOSTILE_QTY_FORMS.map(([, e]) => e)];
    const results = await Promise.allSettled(
      all.flatMap((e) => [s.addToCart(null, fd(e)), s.updateCartQuantity(null, fd(e)), s.removeFromCart(null, fd(e))]),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: service errors pass through typed, user-safe
// ---------------------------------------------------------------------------

describe("criterion 2: service errors are typed results with user-safe messages", () => {
  test("PRODUCT_NOT_FOUND (incl. SQL-shaped id)", async () => {
    const s = setup();
    for (const id of ["prod_nope", "' OR 1=1 --", "x'); DROP TABLE products;--"]) {
      const state = await s.addToCart(null, fd([["productId", id], ["quantity", "1"]]));
      const e = expectErr(state, "PRODUCT_NOT_FOUND");
      expect(e.message).toBe("This product is no longer available.");
      expectUserSafe(e.message);
      expectJsonRoundTrip(state);
    }
    expect(snapshot(s.db)).toEqual({ carts: [], items: [] });
    expect(s.revalidate).not.toHaveBeenCalled();
  });

  test("OUT_OF_STOCK via addToCart and updateCartQuantity", async () => {
    const s = setup();
    for (const action of QTY_ACTIONS) {
      const e = expectErr(await s[action](null, fd([["productId", POUR_OVER], ["quantity", "1"]])), "OUT_OF_STOCK");
      expect(e.message).toBe("This item is out of stock.");
      expect(e.message).not.toContain("Ceramic"); // raw service message embedded product name
    }
    expect(s.revalidate).not.toHaveBeenCalled();
  });

  test("INSUFFICIENT_STOCK with available > 0", async () => {
    const s = setup();
    const e = expectErr(await s.addToCart(null, fd([["productId", DESK], ["quantity", "4"]])), "INSUFFICIENT_STOCK");
    expect(e.message).toBe("Only 3 left in stock.");
    expect(e.details).toEqual({ productId: DESK, available: 3, requested: 4 });
    const u = expectErr(await s.updateCartQuantity(null, fd([["productId", DESK], ["quantity", "9"]])), "INSUFFICIENT_STOCK");
    expect(u.message).toBe("Only 3 left in stock.");
  });

  test("INSUFFICIENT_STOCK with available 0 -> 'No more of this item is available.'", async () => {
    const s = setup();
    expectOk(await s.addToCart(null, fd([["productId", PRINT], ["quantity", "1"]])));
    s.revalidate.mockClear();
    const before = snapshot(s.db);
    const e = expectErr(await s.addToCart(null, fd([["productId", PRINT], ["quantity", "1"]])), "INSUFFICIENT_STOCK");
    expect(e.message).toBe("No more of this item is available.");
    expect(e.details).toMatchObject({ available: 0 });
    expect(snapshot(s.db)).toEqual(before);
    expect(s.revalidate).not.toHaveBeenCalled();
  });

  test("INVALID_QUANTITY for 0, 100, 999 and cumulative > 99", async () => {
    const s = setup();
    for (const q of ["0", "00", "100", "999"]) {
      const e = expectErr(await s.addToCart(null, fd([["productId", TOTE], ["quantity", q]])), "INVALID_QUANTITY");
      expect(e.message).toBe("Please choose a quantity between 1 and 99.");
      expectUserSafe(e.message);
    }
    // enamel pin set: stock 100 so the 99 cap, not stock, is what trips
    expectOk(await s.addToCart(null, fd([["productId", "prod_enamel-pin-set"], ["quantity", "99"]])));
    const e = expectErr(await s.addToCart(null, fd([["productId", "prod_enamel-pin-set"], ["quantity", "1"]])), "INVALID_QUANTITY");
    expect(e.message).toBe("Please choose a quantity between 1 and 99.");
  });

  test("getSessionId is called exactly once even when the service fails", async () => {
    const s = setup();
    await s.addToCart(null, fd([["productId", POUR_OVER], ["quantity", "1"]]));
    expect(s.getSessionId).toHaveBeenCalledTimes(1);
  });

  test("closed DB: unexpected exception is rethrown (by design), nothing revalidated", async () => {
    const s = setup();
    s.db.close();
    for (const action of [s.addToCart, s.updateCartQuantity] as const) {
      await expect(action(null, fd([["productId", TOTE], ["quantity", "1"]]))).rejects.toThrow();
    }
    await expect(s.removeFromCart(null, fd([["productId", TOTE]]))).rejects.toThrow();
    expect(s.revalidate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Criteria 3 + 4: (prevState, formData), only named fields, no client price/session
// ---------------------------------------------------------------------------

describe("criteria 3 and 4: progressive-enhancement signature, only named fields read", () => {
  test("actions take (prevState, formData) and return a Promise", () => {
    const s = setup();
    for (const fn of [s.addToCart, s.updateCartQuantity, s.removeFromCart, wired.addToCart, wired.updateCartQuantity, wired.removeFromCart]) {
      expect(typeof fn).toBe("function");
      expect(fn.length).toBe(2);
    }
  });

  test("only CART_FIELD.productId / quantity are read (spy FormData)", async () => {
    const s = setup();
    const allowed = new Set(Object.values(CART_FIELD).map((k) => `get:${k}`));
    for (const action of ["addToCart", "updateCartQuantity", "removeFromCart"] as const) {
      const { form: f, reads } = spyFormData([
        ["productId", TOTE],
        ["quantity", "1"],
        ["price", "1"],
        ["subtotalCents", "1"],
        ["sessionId", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
        ["quantityCents", "1"],
      ]);
      expectOk(await s[action](null, f));
      expect(reads.length).toBeGreaterThan(0);
      for (const r of reads) expect(allowed.has(r)).toBe(true);
      if (action === "removeFromCart") expect(reads).not.toContain("get:quantity");
    }
  });

  test("extra price/subtotalCents/sessionId/quantityCents fields have no effect", async () => {
    const plain = setup();
    const hostile = setup();
    const extras: Entry[] = [
      ["price", "0.01"],
      ["priceCents", "1"],
      ["unitPriceCents", "1"],
      ["subtotalCents", "1"],
      ["totalCents", "1"],
      ["quantityCents", "9999"],
      ["sessionId", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      ["sf_session", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ];
    const a = await plain.addToCart(null, fd([["productId", DESK], ["quantity", "2"]]));
    const b = await hostile.addToCart(null, fd([["productId", DESK], ["quantity", "2"], ...extras]));
    expect(b).toEqual(a);
    expect(expectOk(b).subtotalCents).toBe(250000);
    expect(businessRows(hostile.db)).toEqual(businessRows(plain.db));
    const rows = hostile.db.query("SELECT cart_session_id AS s FROM cart_items").all() as { s: string }[];
    expect(rows.every((r) => r.s === SESSION)).toBe(true);
  });

  test("prevState is ignored (bogus success, bogus error, garbage object)", async () => {
    const bogus: unknown[] = [
      { ok: true, value: { itemCount: 999, subtotalCents: 1, message: "hacked" } },
      { ok: false, error: { code: "OUT_OF_STOCK", message: "x" } },
      { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", priceCents: 1 },
      "garbage",
    ];
    const baseline = await setup().addToCart(null, fd([["productId", TOTE], ["quantity", "3"]]));
    for (const prev of bogus) {
      const s = setup();
      const state = await s.addToCart(prev as CartActionState, fd([["productId", TOTE], ["quantity", "3"]]));
      expect(state).toEqual(baseline);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: revalidation exact on success, empty on failure
// ---------------------------------------------------------------------------

describe("criterion 5: revalidate exact on success, never on failure", () => {
  test("each successful action revalidates exactly [/cart], [/, layout] and calls getSessionId once", async () => {
    const s = setup();
    const steps: Array<() => Promise<CartActionState>> = [
      () => s.addToCart(null, fd([["productId", TOTE], ["quantity", "2"]])),
      () => s.updateCartQuantity(null, fd([["productId", TOTE], ["quantity", "5"]])),
      () => s.removeFromCart(null, fd([["productId", TOTE]])),
    ];
    const expectedValues = [
      { itemCount: 2, subtotalCents: 3998, message: "Added 2 to your cart." },
      { itemCount: 5, subtotalCents: 9995, message: "Quantity updated." },
      { itemCount: 0, subtotalCents: 0, message: "Item removed." },
    ];
    for (const [i, step] of steps.entries()) {
      s.revalidate.mockClear();
      s.getSessionId.mockClear();
      const state = await step();
      expect(expectOk(state)).toEqual(expectedValues[i]!);
      expectJsonRoundTrip(state);
      expect(s.revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
      expect(s.getSessionId).toHaveBeenCalledTimes(1);
    }
  });

  test("leading-zero quantity '007' is accepted as 7", async () => {
    const s = setup();
    expect(expectOk(await s.addToCart(null, fd([["productId", TOTE], ["quantity", "007"]]))).itemCount).toBe(7);
  });

  test("no revalidate on any service failure", async () => {
    const s = setup();
    await s.addToCart(null, fd([["productId", "prod_nope"], ["quantity", "1"]]));
    await s.addToCart(null, fd([["productId", POUR_OVER], ["quantity", "1"]]));
    await s.addToCart(null, fd([["productId", DESK], ["quantity", "4"]]));
    await s.updateCartQuantity(null, fd([["productId", TOTE], ["quantity", "0"]]));
    expect(s.revalidate.mock.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: wiring of cart.ts (first add sets the session cookie)
// ---------------------------------------------------------------------------

describe("criterion 6: wired cart.ts creates the session on first addToCart", () => {
  beforeEach(() => {
    closeDatabase();
    seedProducts(getDatabase());
    fakeStore = new FakeCookieStore();
    wiredRevalidatePath.mockClear();
  });

  test("first add sets sf_session once; second add reuses it; cart rows keyed by cookie", async () => {
    const first = await wired.addToCart(null, fd([["productId", TOTE], ["quantity", "1"], ["sessionId", SESSION]]));
    expect(expectOk(first)).toEqual({ itemCount: 1, subtotalCents: 1999, message: "Added 1 to your cart." });
    expect(fakeStore.setCalls).toHaveLength(1);
    const call = fakeStore.setCalls[0]!;
    expect(call.name).toBe(SESSION_COOKIE_NAME);
    expect(call.value).not.toBe(SESSION); // client-supplied sessionId ignored
    expect(call.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(call.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(wiredRevalidatePath.mock.calls).toEqual([["/cart"], ["/", "layout"]]);

    const second = await wired.addToCart(null, fd([["productId", TOTE], ["quantity", "2"]]));
    expect(expectOk(second).itemCount).toBe(3);
    expect(fakeStore.setCalls).toHaveLength(1);
    const rows = getDatabase().query("SELECT cart_session_id AS s, quantity AS q FROM cart_items").all();
    expect(rows).toEqual([{ s: call.value, q: 3 }]);
  });

  test("invalid input through the wired action mints no cookie and does not revalidate", async () => {
    const state = await wired.addToCart(null, fd([["productId", TOTE], ["quantity", " 2"]]));
    expectErr(state, "INVALID_INPUT");
    expect(fakeStore.setCalls).toEqual([]);
    expect(wiredRevalidatePath).not.toHaveBeenCalled();
  });
});
