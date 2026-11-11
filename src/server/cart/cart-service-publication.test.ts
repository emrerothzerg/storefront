import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AppError, Result } from "@/lib/result";
import { createCartActions, type CartActionDepsV2 } from "@/app/actions/cart-core";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { createRateLimiter } from "@/server/security/rate-limiter";
import { createOrderService } from "@/server/orders/order-service";
import { MOCK_CARDS, createMockPaymentProvider } from "@/server/payments/mock-payment-provider";
import { SqliteCartRepository } from "./cart-repository";
import {
  CartService,
  SHIPPING_METHOD_DROPPED_NOTICE,
  createCartService,
  type CartServiceV2,
  type CartViewV2,
} from "./cart-service";

/** R-CART-1 (unpublished products) and D-T55-2 (inactive stored shipping method). */

const S1 = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const DAY = 86_400_000;
const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const PIN = "prod_enamel-pin-set"; // 50
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const UNKNOWN = "prod_does-not-exist";

interface Clock {
  value: number;
}

function setup(): { db: Database; cart: CartServiceV2; clock: Clock } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  const clock: Clock = { value: NOW };
  return { db, cart: createCartService(db, { now: () => clock.value }), clock };
}

function setPublishedAt(db: Database, id: string, value: string): void {
  db.query("UPDATE products SET published_at = ? WHERE id = ?").run(value, id);
}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function errorOf<T>(r: Result<T>): AppError {
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

function view(cart: CartServiceV2, now?: number): CartViewV2 {
  return unwrap(cart.getCartView(S1, now));
}

function cartLines(db: Database): unknown[] {
  return db.query("SELECT product_id AS p, quantity AS q FROM cart_items ORDER BY p").all();
}

function savedIds(db: Database): string[] {
  return db
    .query<{ p: string }, []>(
      `SELECT li.product_id AS p FROM list_items li JOIN lists l ON l.id = li.list_id
        WHERE l.kind = 'save_for_later' ORDER BY p`,
    )
    .all()
    .map((r) => r.p);
}

const UNPUBLISHED: ReadonlyArray<readonly [string, string]> = [
  ["empty published_at (null-equivalent: the column is NOT NULL)", ""],
  ["published_at = now + 1 day", new Date(NOW + DAY).toISOString()],
  ["published_at = now + 1 ms", new Date(NOW + 1).toISOString()],
];

describe("R-CART-1: addItem", () => {
  test.each(UNPUBLISHED)("%s -> PRODUCT_NOT_FOUND, byte-identical to an unknown id, nothing written", (_label, publishedAt) => {
    const { db, cart } = setup();
    setPublishedAt(db, TOTE, publishedAt);
    const unpublished = errorOf(cart.addItem(S1, TOTE, 1));
    const unknown = errorOf(cart.addItem(S1, UNKNOWN, 1));
    expect(unpublished).toEqual({ code: "PRODUCT_NOT_FOUND", message: "Product not found", details: { productId: TOTE } });
    expect(JSON.stringify(unpublished)).toBe(JSON.stringify(unknown).replace(UNKNOWN, TOTE));
    expect(cartLines(db)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM carts").get()).toEqual({ n: 0 });
  });

  test("published exactly at now is purchasable (inclusive cut-off)", () => {
    const { db, cart } = setup();
    setPublishedAt(db, TOTE, new Date(NOW).toISOString());
    expect(unwrap(cart.addItem(S1, TOTE, 2)).items[0]).toMatchObject({ productId: TOTE, quantity: 2, status: "ok" });
  });

  test("the same product published -> success", () => {
    const { db, cart } = setup();
    setPublishedAt(db, TOTE, new Date(NOW - DAY).toISOString());
    expect(unwrap(cart.addItem(S1, TOTE, 1)).itemCount).toBe(1);
  });

  test("an unpublished out-of-stock product is PRODUCT_NOT_FOUND, not OUT_OF_STOCK (no stock leak)", () => {
    const { db, cart } = setup();
    setPublishedAt(db, POUR_OVER, new Date(NOW + DAY).toISOString());
    expect(errorOf(cart.addItem(S1, POUR_OVER, 1)).code).toBe("PRODUCT_NOT_FOUND");
  });

  test("clock dependency: future-published product becomes addable once the clock passes published_at", () => {
    const { db, cart, clock } = setup();
    const publishAt = NOW + DAY;
    setPublishedAt(db, TOTE, new Date(publishAt).toISOString());
    expect(errorOf(cart.addItem(S1, TOTE, 1)).code).toBe("PRODUCT_NOT_FOUND");
    clock.value = publishAt - 1;
    expect(errorOf(cart.addItem(S1, TOTE, 1)).code).toBe("PRODUCT_NOT_FOUND");
    clock.value = publishAt;
    expect(unwrap(cart.addItem(S1, TOTE, 1)).items[0]).toMatchObject({ productId: TOTE, status: "ok", lineTotalCents: 1999 });
  });

  test("MVP CartService (no explicit clock/publication deps) also rejects unpublished products", () => {
    const { db } = setup();
    const mvp = new CartService({ db, carts: new SqliteCartRepository(db), products: new SqliteProductRepository(db) });
    setPublishedAt(db, TOTE, "2999-01-01T00:00:00.000Z");
    expect(errorOf(mvp.addItem(S1, TOTE, 1)).code).toBe("PRODUCT_NOT_FOUND");
    expect(unwrap(mvp.addItem(S1, PIN, 1)).itemCount).toBe(1);
  });

  test("an injected publication lookup is used with the clock's ISO cut-off", () => {
    const { db } = setup();
    const calls: string[] = [];
    const svc = new CartService({
      db,
      carts: new SqliteCartRepository(db),
      products: new SqliteProductRepository(db),
      now: () => NOW,
      publication: {
        filterPublishedIds: (ids, nowIso) => {
          calls.push(nowIso);
          return new Set(ids.filter((id) => id !== TOTE));
        },
      },
    });
    expect(errorOf(svc.addItem(S1, TOTE, 1)).code).toBe("PRODUCT_NOT_FOUND");
    expect(calls[0]).toBe("2026-11-07T12:00:00.000Z");
  });

  test("a non-finite clock is a wiring bug: throws and writes nothing", () => {
    const { db } = setup();
    const svc = new CartService({ db, carts: new SqliteCartRepository(db), products: new SqliteProductRepository(db), now: () => Number.NaN });
    expect(() => svc.addItem(S1, TOTE, 1)).toThrow(TypeError);
    expect(cartLines(db)).toEqual([]);
  });
});

describe("R-CART-1: setQuantity", () => {
  test("upsert of a new unpublished product -> PRODUCT_NOT_FOUND", () => {
    const { db, cart } = setup();
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    expect(errorOf(cart.setQuantity(S1, TOTE, 1))).toEqual({
      code: "PRODUCT_NOT_FOUND",
      message: "Product not found",
      details: { productId: TOTE },
    });
    expect(errorOf(cart.setQuantity(S1, UNKNOWN, 1)).details).toEqual({ productId: UNKNOWN });
    expect(cartLines(db)).toEqual([]);
  });

  test("updating / removing an existing line of a later-unpublished product is unaffected", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    expect(unwrap(cart.setQuantity(S1, TOTE, 3)).items[0]).toMatchObject({ quantity: 3, status: "unavailable" });
    expect(unwrap(cart.removeItem(S1, TOTE)).items).toEqual([]);
  });
});

describe("R-CART-1: moveToCart", () => {
  test.each(UNPUBLISHED)("%s -> PRODUCT_NOT_FOUND, item stays saved, cart untouched", (_label, publishedAt) => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    unwrap(cart.saveForLater(S1, TOTE));
    setPublishedAt(db, TOTE, publishedAt);
    expect(errorOf(cart.moveToCart(S1, TOTE))).toEqual({
      code: "PRODUCT_NOT_FOUND",
      message: "Product not found",
      details: { productId: TOTE },
    });
    expect(savedIds(db)).toEqual([TOTE]);
    expect(cartLines(db)).toEqual([]);
  });

  test("published again (clock advanced) -> moves", () => {
    const { db, cart, clock } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    unwrap(cart.saveForLater(S1, TOTE));
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    expect(errorOf(cart.moveToCart(S1, TOTE)).code).toBe("PRODUCT_NOT_FOUND");
    clock.value = NOW + DAY;
    expect(unwrap(cart.moveToCart(S1, TOTE))).toMatchObject({ productId: TOTE, quantity: 2, status: "ok" });
    expect(savedIds(db)).toEqual([]);
  });

  test("saved view marks an unpublished saved item unavailable", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.saveForLater(S1, TOTE));
    expect(view(cart).saved[0]?.available).toBe(true);
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    expect(view(cart).saved[0]?.available).toBe(false);
  });
});

describe("R-CART-1: addManyToCart (via cart actions -> addItem)", () => {
  test("unpublished ids are 'unavailable' per item, published ones are added", async () => {
    const { db, cart } = setup();
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    const deps: CartActionDepsV2 = {
      getSessionId: async () => S1,
      readSessionId: async () => S1,
      cart,
      limiter: createRateLimiter(db, { now: () => NOW, logger: { error: () => undefined } }),
      revalidate: () => undefined,
      redirect: (url: string): never => {
        throw new Error(`unexpected redirect ${url}`);
      },
      now: () => NOW,
      logError: () => undefined,
    };
    const fd = new FormData();
    fd.append("productId", TOTE);
    fd.append("productId", PIN);
    fd.append("productId", UNKNOWN);
    const state = await createCartActions(deps).addManyToCart(null, fd);
    if (state === null || !state.ok) throw new Error(`expected ok, got ${JSON.stringify(state)}`);
    expect(state.value.perItem).toEqual([
      { productId: TOTE, result: "unavailable" },
      { productId: PIN, result: "added" },
      { productId: UNKNOWN, result: "unavailable" },
    ]);
    expect(cartLines(db)).toEqual([{ p: PIN, q: 1 }]);
  });
});

describe("R-CART-1: view of a line unpublished after it was added", () => {
  test("line is unavailable, lineTotal 0, excluded from totals, no product link, checkout blocked; line kept", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    unwrap(cart.addItem(S1, PIN, 1));
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    const v = view(cart);
    expect(v.items.find((i) => i.productId === TOTE)).toEqual({
      productId: TOTE,
      quantity: 2,
      unitPriceCents: 1999,
      status: "unavailable",
      name: "Canvas Tote Bag",
      slug: "",
      imageUrl: expect.any(String) as unknown as string,
      availableStock: 0,
      lineTotalCents: 0,
    });
    expect(v.subtotalCents).toBe(50);
    expect(v.totals.subtotalCents).toBe(50);
    expect(v.itemCount).toBe(3);
    expect(v.canCheckout).toBe(false);
    expect(cart.getCart(S1).canCheckout).toBe(false);
    expect(cartLines(db)).toEqual([
      { p: TOTE, q: 2 },
      { p: PIN, q: 1 },
    ]);
  });

  test("getCartView judges publication at the service clock (the per-call now is coupon-only)", () => {
    const { db, cart, clock } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    expect(view(cart).items[0]?.status).toBe("unavailable");
    expect(view(cart, NOW + DAY).items[0]?.status).toBe("unavailable");
    clock.value = NOW + DAY;
    expect(view(cart).items[0]?.status).toBe("ok");
    expect(view(cart, NOW).items[0]?.status).toBe("ok");
  });
});

describe("D-T55-2: inactive stored shipping method", () => {
  test("cleared on the next view with a one-time notice; view falls back to the cheapest", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.selectShippingMethod(S1, "express"));
    expect(view(cart).shippingNotice).toBeNull();
    db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    const first = view(cart);
    expect(first.shippingNotice).toBe(SHIPPING_METHOD_DROPPED_NOTICE);
    expect(first.shipping?.method.id).toBe("standard");
    expect(db.query("SELECT shipping_method_id AS m FROM carts").get()).toEqual({ m: null });
    const second = view(cart);
    expect(second.shippingNotice).toBeNull();
    expect(second.shipping?.method.id).toBe("standard");
  });

  test("an active stored method is kept; an unknown stored id is cleared too", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.selectShippingMethod(S1, "express"));
    expect(view(cart).shipping?.method.id).toBe("express");
    db.run("UPDATE carts SET shipping_method_id = 'gone' WHERE session_id = ?", [S1]);
    expect(view(cart).shippingNotice).toBe(SHIPPING_METHOD_DROPPED_NOTICE);
    expect(view(cart).shippingNotice).toBeNull();
  });

  test("a concurrent re-selection is never clobbered (conditional clear)", () => {
    const { db } = setup();
    const repo = new SqliteCartRepository(db);
    repo.ensureCart(S1, "USD");
    repo.setShippingMethodId(S1, "next_day");
    expect(repo.clearShippingMethodIf(S1, "express")).toBe(false);
    expect(repo.getSettings(S1)?.shippingMethodId).toBe("next_day");
    expect(repo.clearShippingMethodIf(S1, "next_day")).toBe(true);
    expect(repo.getSettings(S1)?.shippingMethodId).toBeNull();
    expect(repo.clearShippingMethodIf(S1, "next_day")).toBe(false);
  });

  test("empty cart: stale selection is cleared, shipping stays null", () => {
    const { db, cart } = setup();
    unwrap(cart.selectShippingMethod(S1, "express"));
    db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    const v = view(cart);
    expect(v.shippingNotice).toBe(SHIPPING_METHOD_DROPPED_NOTICE);
    expect(v.shipping).toBeNull();
  });

  test("invalid session -> empty view with null notice", () => {
    const { cart } = setup();
    expect(unwrap(cart.getCartView("nope")).shippingNotice).toBeNull();
  });
});

describe("D-T45-1: shipping is quoted only when a line is available with a billable quantity", () => {
  const ZERO = { subtotalCents: 0, discountCents: 0, shippingCents: 0, totalCents: 0, amountToFreeShippingCents: null };

  test("every line unpublished: no shipping, no options, zero totals, checkout blocked; lines kept", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 2));
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    const v = view(cart);
    expect(v.items.map((i) => i.status)).toEqual(["unavailable"]);
    expect(v.shipping).toBeNull();
    expect(v.shippingOptions).toEqual([]);
    expect(v.totals).toEqual(ZERO);
    expect(v.canCheckout).toBe(false);
    expect(cartLines(db)).toEqual([{ p: TOTE, q: 2 }]);
  });

  test("every line out of stock: zero totals even with a stored method", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.selectShippingMethod(S1, "express"));
    db.run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    const v = view(cart);
    expect(v.shipping).toBeNull();
    expect(v.shippingOptions).toEqual([]);
    expect(v.totals).toEqual(ZERO);
    // A still-active stored method is kept for when the line is billable again.
    expect(db.query("SELECT shipping_method_id AS m FROM carts").get()).toEqual({ m: "express" });
    db.run("UPDATE products SET stock = 5 WHERE id = ?", [TOTE]);
    expect(view(cart).shipping?.method.id).toBe("express");
  });

  test("a free-shipping coupon on an all-unavailable cart still yields zero totals", () => {
    const { db, cart } = setup();
    db.run("UPDATE coupons SET min_subtotal_cents = 0 WHERE code = 'FREESHIP'");
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.applyCoupon(S1, "FREESHIP"));
    db.run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    const v = view(cart);
    expect(v.coupon?.kind).toBe("free_shipping");
    expect(v.shipping).toBeNull();
    expect(v.totals.totalCents).toBe(0);
    expect(v.totals.amountToFreeShippingCents).toBeNull();
  });

  test("one billable line among unavailable ones: shipping is quoted at the billable subtotal", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.addItem(S1, PIN, 2));
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    const v = view(cart);
    expect(v.subtotalCents).toBe(100);
    expect(v.shipping?.method.id).toBe("standard");
    expect(v.totals.shippingCents).toBe(v.shipping?.priceCents ?? -1);
    expect(v.totals.totalCents).toBe(100 + (v.shipping?.priceCents ?? 0));
  });

  async function viewAndOrderTotals(db: Database, cart: CartServiceV2): Promise<{ view: number[]; order: number[] }> {
    const v = view(cart, NOW);
    const t = v.totals;
    const orders = createOrderService(db, {
      now: () => NOW,
      payments: createMockPaymentProvider({ latencyMs: 0, now: () => new Date(NOW) }),
      inFlight: new Map(),
    });
    const placed = await orders.placeOrderV2(
      {
        sessionId: S1,
        address: {
          fullName: "Ada Lovelace",
          email: "ada@example.com",
          line1: "1 Analytical Way",
          city: "London",
          region: "LDN",
          postalCode: "N1 9GU",
          country: "GB",
        },
        card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" },
        idempotencyKey: `dt451-${crypto.randomUUID()}`,
      },
      NOW,
    );
    const o = unwrap(placed);
    return {
      view: [t.subtotalCents, t.discountCents, t.shippingCents, t.totalCents],
      order: [o.subtotalCents, o.discountCents, o.shippingCents, o.totalCents],
    };
  }

  test("a 100 % coupon (discounted amount 0) still quotes shipping; view totals equal placeOrderV2", async () => {
    const { db, cart } = setup();
    db.query(
      "INSERT INTO coupons (code, kind, value, min_subtotal_cents, expires_at, is_active, promoted) VALUES ('ALLOFF', 'percent', 100, 0, NULL, 1, 0)",
    ).run();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.applyCoupon(S1, "ALLOFF", NOW));
    const v = view(cart, NOW);
    expect(v.totals.discountCents).toBe(1999);
    expect(v.shipping?.method.id).toBe("standard");
    expect(v.shippingOptions.length).toBeGreaterThan(0);
    expect(v.totals.shippingCents).toBe(v.shipping?.priceCents ?? -1);
    expect(v.totals.shippingCents).toBeGreaterThan(0);
    expect(v.totals.totalCents).toBe(v.totals.shippingCents);
    const { view: got, order } = await viewAndOrderTotals(db, cart);
    expect(got).toEqual(order);
  });

  test("a zero-priced in-stock line still quotes shipping; view totals equal placeOrderV2", async () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    db.run("UPDATE products SET price_cents = 0, list_price_cents = NULL WHERE id = ?", [TOTE]);
    const v = view(cart, NOW);
    expect(v.subtotalCents).toBe(0);
    expect(v.shipping).not.toBeNull();
    expect(v.totals.totalCents).toBe(v.totals.shippingCents);
    const { view: got, order } = await viewAndOrderTotals(db, cart);
    expect(got).toEqual(order);
  });

  test("D-T55-2 kept: an all-unavailable cart still clears an inactive stored method once, with the notice", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.selectShippingMethod(S1, "express"));
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    const first = view(cart);
    expect(first.shippingNotice).toBe(SHIPPING_METHOD_DROPPED_NOTICE);
    expect(first.shipping).toBeNull();
    expect(first.totals).toEqual(ZERO);
    expect(db.query("SELECT shipping_method_id AS m FROM carts").get()).toEqual({ m: null });
    expect(view(cart).shippingNotice).toBeNull();
  });
});

describe("D-T82-4: saved items whose product was unpublished after saving", () => {
  test("reason 'unavailable', slug '', no price drop, not available; name/image kept", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.saveForLater(S1, TOTE));
    db.run("UPDATE list_items SET price_at_add_cents = 99999 WHERE product_id = ?", [TOTE]);
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    const [line] = view(cart).saved;
    expect(line?.reason).toBe("unavailable");
    expect(line?.available).toBe(false);
    expect(line?.priceDroppedByCents).toBeNull();
    expect(line?.product?.slug).toBe("");
    expect(line?.product?.name).toBe("Canvas Tote Bag");
    expect(line?.product?.imageUrl).not.toBe("");
  });

  test("published saved items: reason null and the real slug (in stock and out of stock)", () => {
    const { db, cart } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.addItem(S1, PIN, 1));
    unwrap(cart.saveForLater(S1, TOTE));
    unwrap(cart.saveForLater(S1, PIN));
    db.run("UPDATE products SET stock = 0 WHERE id = ?", [PIN]);
    const byId = new Map(view(cart).saved.map((s) => [s.productId, s]));
    expect(byId.get(TOTE)).toMatchObject({ reason: null, available: true, product: { slug: "canvas-tote-bag" } });
    expect(byId.get(PIN)?.reason).toBeNull();
    expect(byId.get(PIN)?.available).toBe(false);
    expect(byId.get(PIN)?.product?.slug).not.toBe("");
  });

  test("the list row is not deleted; publishing again restores the item", () => {
    const { db, cart, clock } = setup();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.saveForLater(S1, TOTE));
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    expect(view(cart).saved[0]?.reason).toBe("unavailable");
    expect(savedIds(db)).toEqual([TOTE]);
    clock.value = NOW + DAY;
    expect(view(cart).saved[0]).toMatchObject({ reason: null, available: true, product: { slug: "canvas-tote-bag" } });
  });
});

describe("D-T108-3: getCartView(owner, { now }) uses one clock for the whole read", () => {
  function counted(): { db: Database; cart: CartServiceV2; calls: { n: number } } {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db, { now: new Date(NOW) });
    const calls = { n: 0 };
    const cart = createCartService(db, {
      now: () => {
        calls.n += 1;
        return NOW;
      },
    });
    return { db, cart, calls };
  }

  test("publication of lines and saved items is judged at options.now; the service clock is not read", () => {
    const { db, cart, calls } = counted();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.addItem(S1, PIN, 1));
    unwrap(cart.saveForLater(S1, PIN));
    setPublishedAt(db, TOTE, new Date(NOW + DAY).toISOString());
    setPublishedAt(db, PIN, new Date(NOW + DAY).toISOString());
    calls.n = 0;
    const before = unwrap(cart.getCartView(S1, { now: NOW }));
    expect(before.items[0]?.status).toBe("unavailable");
    expect(before.saved[0]?.reason).toBe("unavailable");
    const after = unwrap(cart.getCartView(S1, { now: NOW + DAY }));
    expect(after.items[0]?.status).toBe("ok");
    expect(after.saved[0]).toMatchObject({ reason: null, available: true });
    expect(calls.n).toBe(0);
  });

  test("options.now is also the coupon clock", () => {
    const { db, cart } = counted();
    db.query(
      "INSERT INTO coupons (code, kind, value, min_subtotal_cents, expires_at, is_active, promoted) VALUES ('SOON', 'fixed', 300, 0, ?, 1, 0)",
    ).run("2026-11-08T00:00:00.000Z");
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.applyCoupon(S1, "SOON"));
    expect(unwrap(cart.getCartView(S1, { now: NOW })).totals.discountCents).toBe(300);
    const later = unwrap(cart.getCartView(S1, { now: Date.parse("2026-11-09T00:00:00.000Z") }));
    expect(later.coupon).toBeNull();
    expect(later.couponNotice).toContain("expired");
  });

  test("no clock given ({} or nothing): the service clock is read exactly once", () => {
    const { cart, calls } = counted();
    unwrap(cart.addItem(S1, TOTE, 1));
    unwrap(cart.saveForLater(S1, TOTE));
    unwrap(cart.addItem(S1, PIN, 1));
    calls.n = 0;
    unwrap(cart.getCartView(S1, {}));
    expect(calls.n).toBe(1);
    calls.n = 0;
    unwrap(cart.getCartView(S1));
    expect(calls.n).toBe(1);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "non-finite options.now (%p) -> INVALID_INPUT, nothing cleared",
    (bad) => {
      const { db, cart } = counted();
      unwrap(cart.addItem(S1, TOTE, 1));
      unwrap(cart.applyCoupon(S1, "WELCOME10"));
      expect(errorOf(cart.getCartView(S1, { now: bad }))).toMatchObject({ code: "INVALID_INPUT", details: { field: "now" } });
      expect(db.query("SELECT coupon_code AS c FROM carts").get()).toEqual({ c: "WELCOME10" });
    },
  );

  test("invalid session with options -> empty view without reading any clock", () => {
    const { cart, calls } = counted();
    calls.n = 0;
    expect(unwrap(cart.getCartView("nope", { now: NOW })).items).toEqual([]);
    expect(calls.n).toBe(0);
  });
});
