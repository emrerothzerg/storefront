import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { CartActionState } from "@/components/molecules/_contracts/cart-actions";
import { createCartService } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedProducts } from "@/server/db/seed";
import { createCartActions, parseProductId, parseQuantity, toUserSafeError } from "./cart-core";

const SESSION = "11111111-1111-4111-8111-111111111111";
const TOTE = "prod_canvas-tote-bag"; // $19.99, stock 42
const DESK = "prod_walnut-desk"; // $1250.00, stock 3
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
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

function cartRows(db: Database) {
  return db.query("SELECT cart_session_id AS s, product_id AS p, quantity AS q FROM cart_items ORDER BY p").all();
}

function expectErr(state: CartActionState, code: string) {
  if (state === null || state.ok) throw new Error(`expected ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code as typeof state.error.code);
  return state.error;
}

function expectOk(state: CartActionState) {
  if (state === null || !state.ok) throw new Error(`expected ok, got ${JSON.stringify(state)}`);
  return state.value;
}

describe("parseProductId", () => {
  test("trims and accepts 1..128 chars", () => {
    expect(parseProductId(form({ productId: "  abc  " }))).toEqual({ ok: true, value: "abc" });
    expect(parseProductId(form({ productId: "x".repeat(128) })).ok).toBe(true);
  });

  test("rejects missing, empty, whitespace, too long and File values", () => {
    const cases: FormData[] = [
      form({}),
      form({ productId: "" }),
      form({ productId: "   " }),
      form({ productId: "x".repeat(129) }),
      form({ productId: new File(["x"], "x.txt") }),
    ];
    for (const fd of cases) {
      const r = parseProductId(fd);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
  });
});

describe("parseQuantity", () => {
  test("accepts 1-3 digit strings", () => {
    expect(parseQuantity(form({ quantity: "1" }))).toEqual({ ok: true, value: 1 });
    expect(parseQuantity(form({ quantity: "007" }))).toEqual({ ok: true, value: 7 });
    expect(parseQuantity(form({ quantity: "0" }))).toEqual({ ok: true, value: 0 }); // range is the service's job
  });

  test("rejects non-digit, signed, decimal, exponent, long, empty, missing and File values", () => {
    const bad = ["", "abc", "-1", "+1", "1.5", "1e2", "1000", " 2", "2 ", "0x10", "Infinity", "NaN", "١"];
    for (const q of bad) {
      const r = parseQuantity(form({ quantity: q }));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("INVALID_INPUT");
        expect(r.error.message).toBe("Please enter a whole number quantity.");
      }
    }
    expect(parseQuantity(form({})).ok).toBe(false);
    expect(parseQuantity(form({ quantity: new File(["3"], "q.txt") })).ok).toBe(false);
  });
});

describe("toUserSafeError", () => {
  test("maps messages and keeps code and details", () => {
    expect(toUserSafeError({ code: "INSUFFICIENT_STOCK", message: "raw", details: { available: 2 } })).toEqual({
      code: "INSUFFICIENT_STOCK",
      message: "Only 2 left in stock.",
      details: { available: 2 },
    });
    expect(toUserSafeError({ code: "INSUFFICIENT_STOCK", message: "raw", details: { available: 0 } }).message).toBe(
      "No more of this item is available.",
    );
    expect(toUserSafeError({ code: "OUT_OF_STOCK", message: "raw" }).message).toBe("This item is out of stock.");
    expect(toUserSafeError({ code: "PRODUCT_NOT_FOUND", message: "raw" }).message).toBe(
      "This product is no longer available.",
    );
    expect(toUserSafeError({ code: "INVALID_QUANTITY", message: "raw", details: { max: 5 } }).message).toBe(
      "Please choose a quantity between 1 and 5.",
    );
    expect(toUserSafeError({ code: "INVALID_QUANTITY", message: "raw" }).message).toBe(
      "Please choose a quantity between 1 and 99.",
    );
    expect(toUserSafeError({ code: "INVALID_INPUT", message: "raw" })).toEqual({
      code: "INVALID_INPUT",
      message: "Something was wrong with that request.",
    });
  });
});

describe("addToCart", () => {
  test("adds, returns totals, revalidates /cart and the root layout, calls getSessionId once", async () => {
    const { db, addToCart, getSessionId, revalidate } = setup();
    const value = expectOk(await addToCart(null, form({ productId: TOTE, quantity: "2" })));
    expect(value).toEqual({ itemCount: 2, subtotalCents: 3998, message: "Added 2 to your cart." });
    expect(getSessionId).toHaveBeenCalledTimes(1);
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(cartRows(db)).toEqual([{ s: SESSION, p: TOTE, q: 2 }]);
  });

  test("ignores client-supplied price, subtotal and session id", async () => {
    const { db, addToCart } = setup();
    const fd = form({
      productId: TOTE,
      quantity: "1",
      price: "1",
      priceCents: "1",
      unitPriceCents: "1",
      subtotalCents: "1",
      sessionId: "22222222-2222-4222-9222-222222222222",
    });
    const value = expectOk(await addToCart(null, fd));
    expect(value.subtotalCents).toBe(1999);
    expect(cartRows(db)).toEqual([{ s: SESSION, p: TOTE, q: 1 }]);
  });

  test("invalid input returns INVALID_INPUT without writing, revalidating or creating a session", async () => {
    const { db, addToCart, getSessionId, revalidate } = setup();
    const cases: FormData[] = [
      form({}),
      form({ productId: TOTE }),
      form({ quantity: "1" }),
      form({ productId: "", quantity: "1" }),
      form({ productId: TOTE, quantity: "two" }),
      form({ productId: TOTE, quantity: "-3" }),
      form({ productId: TOTE, quantity: "1.5" }),
      form({ productId: TOTE, quantity: new File(["1"], "q.txt") }),
    ];
    for (const fd of cases) expectErr(await addToCart(null, fd), "INVALID_INPUT");
    expect(cartRows(db)).toEqual([]);
    expect(getSessionId).not.toHaveBeenCalled();
    expect(revalidate).not.toHaveBeenCalled();
  });

  test("passes service errors through with user-safe messages and no revalidation", async () => {
    const { db, addToCart, revalidate } = setup();

    const notFound = expectErr(await addToCart(null, form({ productId: "prod_nope", quantity: "1" })), "PRODUCT_NOT_FOUND");
    expect(notFound.message).toBe("This product is no longer available.");
    expect(notFound.details).toEqual({ productId: "prod_nope" });

    const oos = expectErr(await addToCart(null, form({ productId: POUR_OVER, quantity: "1" })), "OUT_OF_STOCK");
    expect(oos.message).toBe("This item is out of stock.");

    const insufficient = expectErr(await addToCart(null, form({ productId: DESK, quantity: "4" })), "INSUFFICIENT_STOCK");
    expect(insufficient.message).toBe("Only 3 left in stock.");
    expect(insufficient.details).toEqual({ productId: DESK, available: 3, requested: 4 });

    const zero = expectErr(await addToCart(null, form({ productId: TOTE, quantity: "0" })), "INVALID_QUANTITY");
    expect(zero.message).toBe("Please choose a quantity between 1 and 99.");
    expect(zero.details).toEqual({ reason: "ZERO", max: 99 });

    const tooMany = expectErr(await addToCart(null, form({ productId: TOTE, quantity: "100" })), "INVALID_QUANTITY");
    expect(tooMany.details).toEqual({ reason: "ABOVE_MAX", max: 99 });

    expect(cartRows(db)).toEqual([]);
    expect(revalidate).not.toHaveBeenCalled();
  });

  test("INSUFFICIENT_STOCK accounts for what is already in the cart", async () => {
    const { addToCart } = setup();
    expectOk(await addToCart(null, form({ productId: DESK, quantity: "2" })));
    const e = expectErr(await addToCart(null, form({ productId: DESK, quantity: "2" })), "INSUFFICIENT_STOCK");
    expect(e.message).toBe("Only 1 left in stock.");
  });

  test("an invalid session from the dep maps to a generic INVALID_INPUT", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedProducts(db);
    const { addToCart } = createCartActions({
      getSessionId: async () => "not-a-uuid",
      cart: createCartService(db),
      revalidate: () => undefined,
    });
    const e = expectErr(await addToCart(null, form({ productId: TOTE, quantity: "1" })), "INVALID_INPUT");
    expect(e.message).toBe("Something was wrong with that request.");
  });

  test("unexpected exceptions are rethrown", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedProducts(db);
    const cart = createCartService(db);
    db.close();
    const revalidate = mock(() => undefined);
    const { addToCart } = createCartActions({ getSessionId: async () => SESSION, cart, revalidate });
    await expect(addToCart(null, form({ productId: TOTE, quantity: "1" }))).rejects.toThrow();
    expect(revalidate).not.toHaveBeenCalled();

    const failingSession = createCartActions({
      getSessionId: async () => {
        throw new Error("cookies unavailable");
      },
      cart: createCartService(createDatabase(":memory:")),
      revalidate,
    });
    await expect(failingSession.addToCart(null, form({ productId: TOTE, quantity: "1" }))).rejects.toThrow("cookies unavailable");
  });

  test("prevState is ignored", async () => {
    const { addToCart } = setup();
    const prev: CartActionState = { ok: true, value: { itemCount: 50, subtotalCents: 1, message: "x" } };
    expect(expectOk(await addToCart(prev, form({ productId: TOTE, quantity: "1" }))).itemCount).toBe(1);
  });
});

describe("updateCartQuantity", () => {
  test("sets the absolute quantity and revalidates", async () => {
    const { db, addToCart, updateCartQuantity, revalidate, getSessionId } = setup();
    expectOk(await addToCart(null, form({ productId: TOTE, quantity: "2" })));
    revalidate.mockClear();
    getSessionId.mockClear();
    const value = expectOk(await updateCartQuantity(null, form({ productId: TOTE, quantity: "5" })));
    expect(value).toEqual({ itemCount: 5, subtotalCents: 9995, message: "Quantity updated." });
    expect(getSessionId).toHaveBeenCalledTimes(1);
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(cartRows(db)).toEqual([{ s: SESSION, p: TOTE, q: 5 }]);
  });

  test("errors leave the cart unchanged and skip revalidation", async () => {
    const { db, addToCart, updateCartQuantity, revalidate } = setup();
    expectOk(await addToCart(null, form({ productId: DESK, quantity: "1" })));
    revalidate.mockClear();
    expect(expectErr(await updateCartQuantity(null, form({ productId: DESK, quantity: "9" })), "INSUFFICIENT_STOCK").message).toBe(
      "Only 3 left in stock.",
    );
    expectErr(await updateCartQuantity(null, form({ productId: DESK, quantity: "0" })), "INVALID_QUANTITY");
    expectErr(await updateCartQuantity(null, form({ productId: DESK, quantity: "abc" })), "INVALID_INPUT");
    expectErr(await updateCartQuantity(null, form({ productId: DESK })), "INVALID_INPUT");
    expect(cartRows(db)).toEqual([{ s: SESSION, p: DESK, q: 1 }]);
    expect(revalidate).not.toHaveBeenCalled();
  });
});

describe("removeFromCart", () => {
  test("removes the line without needing a quantity, ignores extra fields", async () => {
    const { db, addToCart, removeFromCart, revalidate } = setup();
    expectOk(await addToCart(null, form({ productId: TOTE, quantity: "2" })));
    expectOk(await addToCart(null, form({ productId: DESK, quantity: "1" })));
    revalidate.mockClear();
    const value = expectOk(await removeFromCart(null, form({ productId: TOTE, quantity: "garbage", price: "0" })));
    expect(value).toEqual({ itemCount: 1, subtotalCents: 125000, message: "Item removed." });
    expect(revalidate.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(cartRows(db)).toEqual([{ s: SESSION, p: DESK, q: 1 }]);
  });

  test("missing productId is INVALID_INPUT; unknown product is an idempotent success", async () => {
    const { removeFromCart, revalidate } = setup();
    expectErr(await removeFromCart(null, form({})), "INVALID_INPUT");
    expect(revalidate).not.toHaveBeenCalled();
    expect(expectOk(await removeFromCart(null, form({ productId: "prod_nope" }))).itemCount).toBe(0);
  });
});
