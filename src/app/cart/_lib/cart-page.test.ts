import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createCartService, type CartView } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedProducts } from "@/server/db/seed";

import { loadCartPage, toCartTableData } from "./cart-page";

const TOTE = "prod_canvas-tote-bag";
const PINS = "prod_enamel-pin-set";
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

const TABLE_KEYS = ["canCheckout", "currency", "itemCount", "items", "subtotalCents"];
const LINE_KEYS = [
  "availableStock",
  "imageUrl",
  "lineTotalCents",
  "name",
  "productId",
  "quantity",
  "slug",
  "status",
  "unitPriceCents",
];

function view(overrides: Partial<CartView> = {}): CartView {
  return {
    sessionId: SESSION_A,
    items: [
      {
        productId: TOTE,
        quantity: 2,
        unitPriceCents: 1999,
        status: "ok",
        name: "Canvas Tote Bag",
        slug: "canvas-tote-bag",
        imageUrl: "/images/products/canvas-tote-bag.svg",
        availableStock: 42,
        lineTotalCents: 3998,
      },
    ],
    subtotalCents: 3998,
    currency: "USD",
    itemCount: 2,
    canCheckout: true,
    ...overrides,
  };
}

describe("toCartTableData", () => {
  test("maps exactly the CartTableData keys (no sessionId or extra fields leak)", () => {
    const withExtras = {
      ...view(),
      secret: "server-only",
      items: view().items.map((i) => ({ ...i, costCents: 1 })),
    };
    const data = toCartTableData(withExtras);
    expect(Object.keys(data).sort()).toEqual(TABLE_KEYS);
    expect(data).not.toHaveProperty("sessionId");
    for (const item of data.items) expect(Object.keys(item).sort()).toEqual(LINE_KEYS);
  });

  test("copies values unchanged", () => {
    const v = view();
    const data = toCartTableData(v);
    expect(data).toEqual({
      items: v.items.map((i) => ({ ...i })),
      subtotalCents: 3998,
      currency: "USD",
      itemCount: 2,
      canCheckout: true,
    });
  });

  test("passes canCheckout through as-is", () => {
    expect(toCartTableData(view({ canCheckout: true })).canCheckout).toBe(true);
    expect(toCartTableData(view({ canCheckout: false })).canCheckout).toBe(false);
  });
});

describe("loadCartPage", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
    runMigrations(db);
    seedProducts(db);
  });

  test("null session yields an empty, non-checkoutable cart", () => {
    const data = loadCartPage(null, createCartService(db));
    expect(data.items).toEqual([]);
    expect(data.itemCount).toBe(0);
    expect(data.subtotalCents).toBe(0);
    expect(data.canCheckout).toBe(false);
  });

  test("persists per session and keeps different sessions separate", () => {
    const service = createCartService(db);
    expect(service.addItem(SESSION_A, TOTE, 2).ok).toBe(true);
    expect(service.addItem(SESSION_B, PINS, 3).ok).toBe(true);

    // A fresh service over the same DB stands in for a page reload.
    const reloaded = createCartService(db);
    const a = loadCartPage(SESSION_A, reloaded);
    const b = loadCartPage(SESSION_B, reloaded);

    expect(a.items.map((i) => [i.productId, i.quantity])).toEqual([[TOTE, 2]]);
    expect(a.subtotalCents).toBe(3998);
    expect(b.items.map((i) => [i.productId, i.quantity])).toEqual([[PINS, 3]]);
    expect(b.subtotalCents).toBe(150);
    expect(a.canCheckout && b.canCheckout).toBe(true);
  });

  test("an out-of-stock line is flagged unavailable and blocks checkout", () => {
    const service = createCartService(db);
    service.addItem(SESSION_A, TOTE, 1);
    db.run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    const data = loadCartPage(SESSION_A, service);
    expect(data.items[0]?.status).toBe("unavailable");
    expect(data.canCheckout).toBe(false);
  });
});
