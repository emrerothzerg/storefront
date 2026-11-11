import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Result } from "@/lib/result";
import { closeDatabase, createDatabase, getDatabase, withTransaction } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { createListService } from "@/server/lists/list-service";
import { createCouponService, recordRedemption } from "@/server/pricing/coupon-service";
import { createShippingService } from "@/server/pricing/shipping-service";
import { SqliteCartRepository } from "./cart-repository";
import {
  CartTotalOverflowError,
  DefaultCartServiceV2,
  couponDroppedNotice,
  createCartService,
  getCartService,
  type CartServiceV2,
  type CartViewV2,
} from "./cart-service";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const NOW = Date.parse("2026-11-07T12:00:00.000Z");

const TOTE = "prod_canvas-tote-bag"; // 1999
const PIN = "prod_enamel-pin-set"; // 50
const SKILLET = "prod_cast-iron-skillet"; // 4999

function setup(): { db: Database; cart: CartServiceV2 } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  return { db, cart: createCartService(db, { now: () => NOW }) };
}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function errorCode<T>(r: Result<T>): string | null {
  return r.ok ? null : r.error.code;
}

function view(cart: CartServiceV2, session: string, now?: number): CartViewV2 {
  return unwrap(cart.getCartView(session, now));
}

function setStock(db: Database, id: string, stock: number): void {
  db.query("UPDATE products SET stock = ? WHERE id = ?").run(stock, id);
}

function setPrice(db: Database, id: string, price: number): void {
  db.query("UPDATE products SET price_cents = ? WHERE id = ?").run(price, id);
}

function storedSettings(db: Database, session: string): unknown {
  return db.query("SELECT coupon_code AS c, shipping_method_id AS m FROM carts WHERE session_id = ?").get(session);
}

function cartLines(db: Database): unknown[] {
  return db.query("SELECT cart_session_id AS s, product_id AS p, quantity AS q FROM cart_items ORDER BY s, p").all();
}

function savedRows(db: Database, session: string): unknown[] {
  return db
    .query(
      `SELECT li.product_id AS p, li.quantity_desired AS q FROM list_items li
         JOIN lists l ON l.id = li.list_id
        WHERE l.session_id = ? AND l.kind = 'save_for_later' ORDER BY li.product_id`,
    )
    .all(session);
}

function saveListCount(db: Database, session: string): number {
  const row = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'save_for_later'")
    .get(session);
  return row?.n ?? 0;
}

describe("contract", () => {
  test("createCartService keeps the MVP methods and the db-only signature", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db);
    const cart = createCartService(db);
    expect(unwrap(cart.addItem(S1, TOTE, 1)).subtotalCents).toBe(1999);
    expect(cart.getTotals(S1)).toEqual({ subtotalCents: 1999, itemCount: 1 });
    expect(typeof cart.getCartView).toBe("function");
  });

  test("getCartService is a singleton per shared database", () => {
    const previous = process.env.DATABASE_PATH;
    try {
      process.env.DATABASE_PATH = ":memory:";
      const a = getCartService();
      expect(getCartService()).toBe(a);
      expect(view(a, S1).items).toEqual([]);
      closeDatabase();
      getDatabase();
      expect(getCartService()).not.toBe(a);
    } finally {
      closeDatabase();
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
    }
  });
});

describe("saveForLater (criterion 2)", () => {
  test("moves the line into the save-for-later list with the line quantity", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 3));
    unwrap(cart.addItem(S1, PIN, 1));
    expect(unwrap(cart.saveForLater(S1, TOTE))).toBeUndefined();
    expect(cartLines(db)).toEqual([{ s: S1, p: PIN, q: 1 }]);
    expect(savedRows(db, S1)).toEqual([{ p: TOTE, q: 3 }]);
    const v = view(cart, S1);
    expect(v.items.map((i) => i.productId)).toEqual([PIN]);
    expect(v.saved).toEqual([
      {
        productId: TOTE,
        product: expect.objectContaining({ id: TOTE, priceCents: 1999 }),
        quantityDesired: 3,
        available: true,
        priceCents: 1999,
        priceDroppedByCents: null,
        addedAt: expect.any(String),
        reason: null,
      },
    ]);
  });

  test("saving an already-saved product keeps one item (larger quantity wins)", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    unwrap(cart.saveForLater(S1, TOTE));
    unwrap(cart.addItem(S1, TOTE, 5));
    unwrap(cart.saveForLater(S1, TOTE));
    expect(savedRows(db, S1)).toEqual([{ p: TOTE, q: 5 }]);
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.saveForLater(S1, TOTE));
    expect(savedRows(db, S1)).toEqual([{ p: TOTE, q: 5 }]);
    expect(saveListCount(db, S1)).toBe(1);
    expect(cartLines(db)).toEqual([]);
  });

  test("product absent from the cart is a no-op success and creates no list", () => {
    const { db, cart } = setup();
    expect(cart.saveForLater(S1, TOTE)).toEqual({ ok: true, value: undefined });
    expect(cart.saveForLater(S1, "does-not-exist")).toEqual({ ok: true, value: undefined });
    expect(cart.saveForLater(S1, 42 as unknown as string)).toEqual({ ok: true, value: undefined });
    expect(saveListCount(db, S1)).toBe(0);
  });

  test("quantityDesired is capped at 99", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db, { now: new Date(NOW) });
    const cart = new DefaultCartServiceV2({
      db,
      carts: new SqliteCartRepository(db),
      products: new SqliteProductRepository(db),
      maxQuantity: 500,
      lists: createListService({ db, now: () => new Date(NOW) }),
      coupons: createCouponService({ db }),
      shipping: createShippingService({ db }),
      now: () => NOW,
    });
    setStock(db, PIN, 400);
    unwrap(cart.addItem(S1, PIN, 150));
    unwrap(cart.saveForLater(S1, PIN));
    expect(savedRows(db, S1)).toEqual([{ p: PIN, q: 99 }]);
  });

  test("a failing list write rolls back everything (cart line kept, no list created)", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    db.query("UPDATE products SET published_at = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(TOTE);
    const r = cart.saveForLater(S1, TOTE);
    expect(errorCode(r)).toBe("PRODUCT_NOT_FOUND");
    expect(cartLines(db)).toEqual([{ s: S1, p: TOTE, q: 2 }]);
    expect(saveListCount(db, S1)).toBe(0);
  });

  test("invalid session is INVALID_INPUT", () => {
    const { cart } = setup();
    expect(errorCode(cart.saveForLater("nope", TOTE))).toBe("INVALID_INPUT");
  });
});

describe("moveToCart (criterion 3)", () => {
  test("adds the desired quantity and removes the item from saved", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 3));
    unwrap(cart.saveForLater(S1, TOTE));
    const line = unwrap(cart.moveToCart(S1, TOTE));
    expect(line).toMatchObject({ productId: TOTE, quantity: 3, status: "ok", unitPriceCents: 1999, lineTotalCents: 5997 });
    expect(cartLines(db)).toEqual([{ s: S1, p: TOTE, q: 3 }]);
    expect(savedRows(db, S1)).toEqual([]);
    expect(view(cart, S1).saved).toEqual([]);
  });

  test("quantity is capped by stock", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 5));
    unwrap(cart.saveForLater(S1, TOTE));
    setStock(db, TOTE, 2);
    expect(unwrap(cart.moveToCart(S1, TOTE)).quantity).toBe(2);
    expect(savedRows(db, S1)).toEqual([]);
  });

  test("merges with an existing line, never above stock", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 3));
    unwrap(cart.saveForLater(S1, TOTE));
    unwrap(cart.addItem(S1, TOTE, 1));
    setStock(db, TOTE, 3);
    expect(unwrap(cart.moveToCart(S1, TOTE)).quantity).toBe(3);
    expect(cartLines(db)).toEqual([{ s: S1, p: TOTE, q: 3 }]);
  });

  test("out of stock -> OUT_OF_STOCK and the item stays saved", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    unwrap(cart.saveForLater(S1, TOTE));
    setStock(db, TOTE, 0);
    const r = cart.moveToCart(S1, TOTE);
    expect(!r.ok && r.error).toMatchObject({ code: "OUT_OF_STOCK", details: { productId: TOTE, available: 0 } });
    expect(savedRows(db, S1)).toEqual([{ p: TOTE, q: 2 }]);
    expect(cartLines(db)).toEqual([]);
    expect(view(cart, S1).saved[0]?.available).toBe(false);
  });

  test("cart already holds all stock -> INSUFFICIENT_STOCK, stays saved", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.saveForLater(S1, TOTE));
    setStock(db, TOTE, 2);
    unwrap(cart.addItem(S1, TOTE, 2));
    const r = cart.moveToCart(S1, TOTE);
    expect(!r.ok && r.error).toMatchObject({ code: "INSUFFICIENT_STOCK", details: { available: 0, requested: 1 } });
    expect(savedRows(db, S1)).toEqual([{ p: TOTE, q: 1 }]);
    expect(cartLines(db)).toEqual([{ s: S1, p: TOTE, q: 2 }]);
  });

  test("line at maxQuantity -> INVALID_QUANTITY, stays saved", () => {
    const { db, cart } = setup();
    setStock(db, PIN, 500);
    unwrap(cart.addItem(S1, PIN, 1));
    unwrap(cart.saveForLater(S1, PIN));
    unwrap(cart.addItem(S1, PIN, 99));
    const r = cart.moveToCart(S1, PIN);
    expect(!r.ok && r.error).toMatchObject({ code: "INVALID_QUANTITY", details: { reason: "ABOVE_MAX" } });
    expect(savedRows(db, S1)).toEqual([{ p: PIN, q: 1 }]);
  });

  test("near maxQuantity adds only up to the max", () => {
    const { db, cart } = setup();
    setStock(db, PIN, 500);
    unwrap(cart.addItem(S1, PIN, 10));
    unwrap(cart.saveForLater(S1, PIN));
    unwrap(cart.addItem(S1, PIN, 95));
    expect(unwrap(cart.moveToCart(S1, PIN)).quantity).toBe(99);
  });

  test("not saved -> NOT_FOUND and no list is created; invalid input", () => {
    const { db, cart } = setup();
    expect(errorCode(cart.moveToCart(S1, TOTE))).toBe("NOT_FOUND");
    expect(saveListCount(db, S1)).toBe(0);
    unwrap(cart.addItem(S1, PIN, 1));
    unwrap(cart.saveForLater(S1, PIN));
    expect(errorCode(cart.moveToCart(S1, TOTE))).toBe("NOT_FOUND");
    expect(errorCode(cart.moveToCart(S1, ""))).toBe("NOT_FOUND");
    expect(errorCode(cart.moveToCart("bad", PIN))).toBe("INVALID_INPUT");
    expect(cartLines(db)).toEqual([]);
  });

  test("another session cannot move my saved item", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.saveForLater(S1, TOTE));
    expect(errorCode(cart.moveToCart(S2, TOTE))).toBe("NOT_FOUND");
    expect(savedRows(db, S1)).toEqual([{ p: TOTE, q: 1 }]);
  });
});

describe("applyCoupon / removeCoupon (criterion 4)", () => {
  test("a valid code is normalised, stored and applied", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    const coupon = unwrap(cart.applyCoupon(S1, "  welcome10 "));
    expect(coupon).toMatchObject({ code: "WELCOME10", kind: "percent", value: 10 });
    expect(storedSettings(db, S1)).toEqual({ c: "WELCOME10", m: null });
    const v = view(cart, S1);
    expect(v.coupon?.code).toBe("WELCOME10");
    expect(v.couponNotice).toBeNull();
    expect(v.totals.discountCents).toBe(399);
  });

  test("applying on an empty cart creates the cart row", () => {
    const { db, cart } = setup();
    unwrap(cart.applyCoupon(S1, "WELCOME10"));
    expect(storedSettings(db, S1)).toEqual({ c: "WELCOME10", m: null });
  });

  test.each([
    ["NOPE", "COUPON_INVALID"],
    ["bad code!", "COUPON_INVALID"],
    ["EXPIRED10", "COUPON_EXPIRED"],
    ["MAXED5", "COUPON_EXHAUSTED"],
    ["SAVE5", "COUPON_MIN_SUBTOTAL"],
  ])("%s -> %s and the previous coupon is untouched", (code, expected) => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1)); // 1999 < SAVE5 min 2500
    unwrap(cart.applyCoupon(S1, "WELCOME10"));
    expect(errorCode(cart.applyCoupon(S1, code))).toBe(expected);
    expect(storedSettings(db, S1)).toEqual({ c: "WELCOME10", m: null });
    expect(view(cart, S1).coupon?.code).toBe("WELCOME10");
  });

  test("COUPON_USED when the session already redeemed it; another session is fine", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(recordRedemption(db, "WELCOME10", S1, "order-1"));
    expect(errorCode(cart.applyCoupon(S1, "WELCOME10"))).toBe("COUPON_USED");
    expect(storedSettings(db, S1)).toEqual({ c: null, m: null });
    expect(unwrap(cart.applyCoupon(S2, "WELCOME10")).code).toBe("WELCOME10");
  });

  test("non-string codes and invalid sessions", () => {
    const { cart } = setup();
    expect(errorCode(cart.applyCoupon(S1, null))).toBe("COUPON_INVALID");
    expect(errorCode(cart.applyCoupon(S1, { code: "WELCOME10" }))).toBe("COUPON_INVALID");
    expect(errorCode(cart.applyCoupon("x", "WELCOME10"))).toBe("INVALID_INPUT");
    expect(errorCode(cart.removeCoupon("x"))).toBe("INVALID_INPUT");
  });

  test("validates against the current subtotal", () => {
    const { cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    expect(errorCode(cart.applyCoupon(S1, "SAVE5"))).toBe("COUPON_MIN_SUBTOTAL");
    unwrap(cart.addItem(S1, TOTE, 1));
    expect(unwrap(cart.applyCoupon(S1, "SAVE5")).code).toBe("SAVE5");
  });

  test("removeCoupon clears it and is idempotent", () => {
    const { db, cart } = setup();
    unwrap(cart.removeCoupon(S1));
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.applyCoupon(S1, "WELCOME10"));
    unwrap(cart.removeCoupon(S1));
    unwrap(cart.removeCoupon(S1));
    expect(storedSettings(db, S1)).toEqual({ c: null, m: null });
    expect(view(cart, S1).coupon).toBeNull();
    expect(view(cart, S1).couponNotice).toBeNull();
  });
});

describe("stored coupon re-validated on every read (criterion 5)", () => {
  test("cart shrinks below the minimum: not applied, notice, stored code cleared", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2)); // 3998
    unwrap(cart.applyCoupon(S1, "SAVE5"));
    expect(view(cart, S1).totals.discountCents).toBe(500);
    unwrap(cart.setQuantity(S1, TOTE, 1)); // 1999
    const v = view(cart, S1);
    expect(v.coupon).toBeNull();
    expect(v.totals.discountCents).toBe(0);
    expect(v.couponNotice).toBe("Promo code SAVE5 was removed because your subtotal is below its minimum of $25.00.");
    expect(storedSettings(db, S1)).toEqual({ c: null, m: null });
    // Notice is shown once; topping up does not resurrect the code.
    unwrap(cart.addItem(S1, TOTE, 1));
    const again = view(cart, S1);
    expect(again.couponNotice).toBeNull();
    expect(again.coupon).toBeNull();
  });

  test("expiry passes", () => {
    const { db, cart } = setup();
    db.query(
      "INSERT INTO coupons (code, kind, value, min_subtotal_cents, expires_at, is_active, promoted) VALUES ('SOON', 'fixed', 300, 0, ?, 1, 0)",
    ).run("2026-11-08T00:00:00.000Z");
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.applyCoupon(S1, "soon"));
    expect(view(cart, S1).totals.discountCents).toBe(300);
    const later = Date.parse("2026-11-09T00:00:00.000Z");
    const v = view(cart, S1, later);
    expect(v.coupon).toBeNull();
    expect(v.couponNotice).toBe("Promo code SOON has expired and was removed from your cart.");
    expect(storedSettings(db, S1)).toEqual({ c: null, m: null });
  });

  test("the injected clock is the default for reads", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db, { now: new Date(NOW) });
    db.query(
      "INSERT INTO coupons (code, kind, value, min_subtotal_cents, expires_at, is_active, promoted) VALUES ('SOON', 'fixed', 300, 0, ?, 1, 0)",
    ).run("2026-11-08T00:00:00.000Z");
    let clock = NOW;
    const cart = createCartService(db, { now: () => clock });
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.applyCoupon(S1, "SOON"));
    clock = Date.parse("2026-11-10T00:00:00.000Z");
    expect(view(cart, S1).couponNotice).toContain("expired");
  });

  test.each([
    ["deactivated", "UPDATE coupons SET is_active = 0 WHERE code = 'WELCOME10'", "is no longer valid"],
    ["exhausted", "UPDATE coupons SET max_uses = 1, used_count = 1 WHERE code = 'WELCOME10'", "is no longer available"],
  ])("%s coupon is dropped with a notice", (_label, sql, phrase) => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.applyCoupon(S1, "WELCOME10"));
    db.run(sql);
    const v = view(cart, S1);
    expect(v.coupon).toBeNull();
    expect(v.couponNotice).toContain(phrase);
    expect(storedSettings(db, S1)).toEqual({ c: null, m: null });
  });

  test("redeemed by this session elsewhere: dropped as used", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.applyCoupon(S1, "WELCOME10"));
    unwrap(recordRedemption(db, "WELCOME10", S1, "order-9"));
    expect(view(cart, S1).couponNotice).toBe("Promo code WELCOME10 has already been used and was removed from your cart.");
  });

  test("couponDroppedNotice never echoes error details beyond the minimum", () => {
    expect(couponDroppedNotice("X", { code: "COUPON_MIN_SUBTOTAL", message: "m" })).toBe(
      "Promo code X was removed because your subtotal is below its minimum.",
    );
    expect(couponDroppedNotice("X", { code: "COUPON_MIN_SUBTOTAL", message: "m", details: { minSubtotalCents: -1 } })).toBe(
      "Promo code X was removed because your subtotal is below its minimum.",
    );
    expect(couponDroppedNotice("X", { code: "COUPON_INVALID", message: "<b>" })).not.toContain("<b>");
  });
});

describe("shipping (criterion 6)", () => {
  test("default is the cheapest active method for the current subtotal", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    const v = view(cart, S1);
    expect(v.shipping?.method.id).toBe("standard");
    expect(v.shipping?.priceCents).toBe(499);
    expect(v.shippingOptions.map((q) => [q.method.id, q.priceCents])).toEqual([
      ["standard", 499],
      ["express", 999],
      ["next_day", 1999],
    ]);
    expect(storedSettings(db, S1)).toEqual({ c: null, m: null });
  });

  test("selectShippingMethod stores an active id and returns its quote", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    const quote = unwrap(cart.selectShippingMethod(S1, "express"));
    expect(quote).toMatchObject({ priceCents: 999, isFree: false, method: expect.objectContaining({ id: "express" }) });
    expect(storedSettings(db, S1)).toEqual({ c: null, m: "express" });
    const v = view(cart, S1);
    expect(v.shipping?.method.id).toBe("express");
    expect(v.totals.shippingCents).toBe(999);
  });

  test.each([["nope"], [""], [null], [42], ["x".repeat(200)], [{ id: "express" }]])(
    "unknown or malformed id %p -> INVALID_INPUT, previous selection kept",
    (bad) => {
      const { db, cart } = setup();
      unwrap(cart.addItem(S1, TOTE, 1));
      unwrap(cart.selectShippingMethod(S1, "next_day"));
      const r = cart.selectShippingMethod(S1, bad);
      expect(!r.ok && r.error).toMatchObject({ code: "INVALID_INPUT", details: { field: "shippingMethodId" } });
      expect(storedSettings(db, S1)).toEqual({ c: null, m: "next_day" });
    },
  );

  test("inactive ids are rejected; a selected method that becomes inactive falls back to the cheapest", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.selectShippingMethod(S1, "express"));
    db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    expect(errorCode(cart.selectShippingMethod(S1, "express"))).toBe("INVALID_INPUT");
    const v = view(cart, S1);
    expect(v.shipping?.method.id).toBe("standard");
    expect(v.shippingOptions.map((q) => q.method.id)).toEqual(["standard", "next_day"]);
  });

  test("selecting on an empty cart creates the row; empty cart has no shipping", () => {
    const { db, cart } = setup();
    unwrap(cart.selectShippingMethod(S1, "express"));
    expect(storedSettings(db, S1)).toEqual({ c: null, m: "express" });
    const v = view(cart, S1);
    expect(v.shipping).toBeNull();
    expect(v.shippingOptions).toEqual([]);
    expect(v.totals).toEqual({ subtotalCents: 0, discountCents: 0, shippingCents: 0, totalCents: 0, amountToFreeShippingCents: null });
  });

  test("no active methods -> shipping null, totals without shipping", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    db.run("UPDATE shipping_methods SET is_active = 0");
    const v = view(cart, S1);
    expect(v.shipping).toBeNull();
    expect(v.totals.totalCents).toBe(1999);
    expect(errorCode(cart.selectShippingMethod("bad", "standard"))).toBe("INVALID_INPUT");
  });
});

describe("totals (criterion 7)", () => {
  test("free-shipping threshold crossing flips shipping to 0 on the next read", () => {
    const { cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1)); // 1999
    const before = view(cart, S1);
    expect(before.totals).toEqual({
      subtotalCents: 1999,
      discountCents: 0,
      shippingCents: 499,
      totalCents: 2498,
      amountToFreeShippingCents: 1501,
    });
    unwrap(cart.addItem(S1, TOTE, 1)); // 3998 >= 3500
    const after = view(cart, S1);
    expect(after.shipping?.isFree).toBe(true);
    expect(after.totals).toEqual({
      subtotalCents: 3998,
      discountCents: 0,
      shippingCents: 0,
      totalCents: 3998,
      amountToFreeShippingCents: 0,
    });
    unwrap(cart.setQuantity(S1, TOTE, 1));
    expect(view(cart, S1).totals.shippingCents).toBe(499);
  });

  test("selected express stays paid above the standard threshold", () => {
    const { cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    unwrap(cart.selectShippingMethod(S1, "express"));
    expect(view(cart, S1).totals).toMatchObject({ shippingCents: 999, totalCents: 3998 + 999, amountToFreeShippingCents: null });
  });

  test("FREESHIP zeroes shipping; WELCOME10 discounts before shipping", () => {
    const { cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1)); // 1999 < 2000 FREESHIP min
    expect(errorCode(cart.applyCoupon(S1, "FREESHIP"))).toBe("COUPON_MIN_SUBTOTAL");
    unwrap(cart.addItem(S1, PIN, 1)); // 2049
    unwrap(cart.applyCoupon(S1, "FREESHIP"));
    unwrap(cart.selectShippingMethod(S1, "next_day"));
    expect(view(cart, S1).totals).toEqual({
      subtotalCents: 2049,
      discountCents: 0,
      shippingCents: 0,
      totalCents: 2049,
      amountToFreeShippingCents: 0,
    });
    unwrap(cart.applyCoupon(S1, "WELCOME10"));
    expect(view(cart, S1).totals).toEqual({
      subtotalCents: 2049,
      discountCents: 204,
      shippingCents: 1999,
      totalCents: 2049 - 204 + 1999,
      amountToFreeShippingCents: null,
    });
  });

  test("property: total = subtotal - discount + shipping exactly over random carts", () => {
    const { db, cart } = setup();
    const ids = db
      .query<{ id: string }, []>("SELECT id FROM products WHERE stock > 0 ORDER BY id LIMIT 12")
      .all()
      .map((r) => r.id);
    const codes = [null, "WELCOME10", "SAVE5", "FREESHIP"];
    const methods = [null, "standard", "express", "next_day"];
    let seed = 7;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 60; i++) {
      unwrap(cart.clear(S1));
      const lines = 1 + rand(4);
      for (let l = 0; l < lines; l++) {
        const id = ids[rand(ids.length)];
        if (id !== undefined) cart.addItem(S1, id, 1 + rand(2));
      }
      const code = codes[rand(codes.length)];
      if (code !== null && code !== undefined) cart.applyCoupon(S1, code);
      const method = methods[rand(methods.length)];
      if (method !== null && method !== undefined) unwrap(cart.selectShippingMethod(S1, method));
      const v = view(cart, S1);
      const t = v.totals;
      expect(t.subtotalCents).toBe(v.subtotalCents);
      expect(t.totalCents).toBe(t.subtotalCents - t.discountCents + t.shippingCents);
      expect(t.shippingCents).toBe(v.coupon?.kind === "free_shipping" ? 0 : (v.shipping?.priceCents ?? 0));
      for (const n of [t.subtotalCents, t.discountCents, t.shippingCents, t.totalCents]) expect(Number.isSafeInteger(n)).toBe(true);
    }
  });

  test("canCheckout follows the MVP rule", () => {
    const { db, cart } = setup();
    expect(view(cart, S1).canCheckout).toBe(false);
    unwrap(cart.addItem(S1, TOTE, 2));
    expect(view(cart, S1).canCheckout).toBe(true);
    setStock(db, TOTE, 0);
    expect(view(cart, S1).canCheckout).toBe(false);
  });

  test("overflow throws CartTotalOverflowError like getCart", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    setPrice(db, TOTE, Number.MAX_SAFE_INTEGER);
    expect(() => cart.getCartView(S1)).toThrow(CartTotalOverflowError);
  });

  test("subtotal + shipping beyond MAX_SAFE_INTEGER throws CartTotalOverflowError", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.selectShippingMethod(S1, "express"));
    setPrice(db, TOTE, Number.MAX_SAFE_INTEGER - 10);
    expect(() => cart.getCartView(S1)).toThrow(CartTotalOverflowError);
  });

  test("a price drop on a saved item is reported", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.saveForLater(S1, TOTE));
    setPrice(db, TOTE, 1500);
    expect(view(cart, S1).saved[0]).toMatchObject({ priceCents: 1500, priceDroppedByCents: 499 });
  });
});

describe("isolation (criterion 8)", () => {
  test("two sessions never share coupon, shipping or saved items", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    unwrap(cart.addItem(S1, PIN, 1));
    unwrap(cart.applyCoupon(S1, "WELCOME10"));
    unwrap(cart.selectShippingMethod(S1, "next_day"));
    unwrap(cart.saveForLater(S1, PIN));
    unwrap(cart.addItem(S2, TOTE, 2));
    const v2 = view(cart, S2);
    expect(v2.coupon).toBeNull();
    expect(v2.shipping?.method.id).toBe("standard");
    expect(v2.saved).toEqual([]);
    unwrap(cart.removeCoupon(S2));
    unwrap(cart.clear(S2));
    const v1 = view(cart, S1);
    expect(v1.coupon?.code).toBe("WELCOME10");
    expect(v1.shipping?.method.id).toBe("next_day");
    expect(v1.saved.map((s) => s.productId)).toEqual([PIN]);
    expect(storedSettings(db, S2)).toBeNull();
  });

  test("unknown session -> empty view", () => {
    const { cart } = setup();
    expect(view(cart, S2)).toEqual({
      sessionId: S2,
      items: [],
      subtotalCents: 0,
      currency: "USD",
      itemCount: 0,
      canCheckout: false,
      saved: [],
      coupon: null,
      couponNotice: null,
      shippingNotice: null,
      shipping: null,
      shippingOptions: [],
      totals: { subtotalCents: 0, discountCents: 0, shippingCents: 0, totalCents: 0, amountToFreeShippingCents: null },
    });
  });

  test("invalid sessions -> empty view without touching the DB", () => {
    const { db, cart } = setup();
    db.close();
    for (const s of ["", "not-a-uuid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", null as unknown as string]) {
      const v = view(cart, s);
      expect(v.items).toEqual([]);
      expect(v.saved).toEqual([]);
      expect(v.totals.totalCents).toBe(0);
    }
  });

  test("view after clear keeps saved items", () => {
    const { cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.addItem(S1, PIN, 1));
    unwrap(cart.saveForLater(S1, PIN));
    unwrap(cart.clear(S1));
    expect(view(cart, S1).saved.map((s) => s.productId)).toEqual([PIN]);
  });
});

describe("concurrency (criterion 9)", () => {
  test("interleaved addItem then moveToCart of the last unit inside one transaction never oversells", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, SKILLET, 1));
    unwrap(cart.saveForLater(S1, SKILLET));
    setStock(db, SKILLET, 1);
    withTransaction(db, () => {
      expect(unwrap(cart.addItem(S1, SKILLET, 1)).items[0]?.quantity).toBe(1);
      const moved = cart.moveToCart(S1, SKILLET);
      expect(errorCode(moved)).toBe("INSUFFICIENT_STOCK");
    });
    expect(cartLines(db)).toEqual([{ s: S1, p: SKILLET, q: 1 }]);
    expect(savedRows(db, S1)).toEqual([{ p: SKILLET, q: 1 }]);
  });

  test("interleaved moveToCart then addItem of the last unit inside one transaction never oversells", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, SKILLET, 1));
    unwrap(cart.saveForLater(S1, SKILLET));
    setStock(db, SKILLET, 1);
    withTransaction(db, () => {
      expect(unwrap(cart.moveToCart(S1, SKILLET)).quantity).toBe(1);
      expect(errorCode(cart.addItem(S1, SKILLET, 1))).toBe("INSUFFICIENT_STOCK");
    });
    expect(cartLines(db)).toEqual([{ s: S1, p: SKILLET, q: 1 }]);
    expect(savedRows(db, S1)).toEqual([]);
  });

  test("Promise.all of moveToCart + addItem racing for the last unit: exactly one wins", async () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, SKILLET, 1));
    unwrap(cart.saveForLater(S1, SKILLET));
    setStock(db, SKILLET, 1);
    const results = await Promise.all([
      (async () => {
        await Promise.resolve();
        return cart.moveToCart(S1, SKILLET).ok;
      })(),
      (async () => {
        await Promise.resolve();
        return cart.addItem(S1, SKILLET, 1).ok;
      })(),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(cartLines(db)).toEqual([{ s: S1, p: SKILLET, q: 1 }]);
  });

  test("two connections to one file DB: moveToCart + addItem never oversell", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/cart-v2-${crypto.randomUUID()}`;
    const { mkdirSync, rmSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/db.sqlite`;
    try {
      const a = createDatabase(path);
      runMigrations(a);
      seedDatabase(a, { now: new Date(NOW) });
      const b = createDatabase(path);
      const ca = createCartService(a, { now: () => NOW });
      const cb = createCartService(b, { now: () => NOW });
      unwrap(ca.addItem(S1, SKILLET, 2));
      unwrap(ca.saveForLater(S1, SKILLET));
      setStock(a, SKILLET, 3);
      const results = await Promise.all([
        (async () => {
          await Promise.resolve();
          return ca.moveToCart(S1, SKILLET);
        })(),
        (async () => {
          await Promise.resolve();
          return cb.addItem(S1, SKILLET, 2);
        })(),
        (async () => {
          await Promise.resolve();
          return cb.addItem(S1, SKILLET, 1);
        })(),
      ]);
      expect(results.some((r) => r.ok)).toBe(true);
      const q = cb.getCart(S1).items[0]?.quantity ?? 0;
      expect(q).toBeLessThanOrEqual(3);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
