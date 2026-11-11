/**
 * QA adversarial tests for T09 (cart repository + service).
 * src/server/cart/cart-repository.ts, src/server/cart/cart-service.ts
 *
 * Every test builds its own `createDatabase(":memory:")` + `runMigrations` +
 * `seedProducts` and wires `SqliteCartRepository`, `SqliteProductRepository`
 * and `new CartService({...})` explicitly. Assertions about persistence query
 * the tables directly instead of trusting the returned view.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedProducts } from "@/server/db/seed";
import { SqliteProductRepository, type ProductRepository } from "@/server/catalog/product-repository";
import { SqliteCartRepository } from "@/server/cart/cart-repository";
import { CartService, UNAVAILABLE_PRODUCT_NAME, type CartView } from "@/server/cart/cart-service";
import type { Result } from "@/lib/result";
import type { ErrorCode } from "@/lib/types";

// Seed products (src/server/db/seed.ts): id = prod_<slug>
const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const PIN = "prod_enamel-pin-set"; // 50, stock 100
const DESK = "prod_walnut-desk"; // 125000, stock 3
const POUR = "prod_ceramic-pour-over"; // 3400, stock 0
const PRINT = "prod_limited-print-no-1"; // 18000, stock 1
const BEANIE = "prod_merino-beanie"; // 2800, stock 64

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";

interface Harness {
  readonly db: Database;
  readonly svc: CartService;
  readonly carts: SqliteCartRepository;
  readonly products: SqliteProductRepository;
}

function setup(opts: { products?: (real: SqliteProductRepository) => ProductRepository; db?: Database } = {}): Harness {
  const db = opts.db ?? createDatabase(":memory:");
  if (opts.db === undefined) {
    runMigrations(db);
    seedProducts(db);
  }
  const carts = new SqliteCartRepository(db);
  const products = new SqliteProductRepository(db);
  const svc = new CartService({ db, carts, products: opts.products ? opts.products(products) : products });
  return { db, svc, carts, products };
}

interface ItemRow {
  cart_session_id: string;
  product_id: string;
  quantity: number;
  created_at: string;
  updated_at: string;
}
interface CartRowDb {
  session_id: string;
  currency: string;
  created_at: string;
  updated_at: string;
}

function snapshot(db: Database): { carts: CartRowDb[]; items: ItemRow[] } {
  return {
    carts: db.query<CartRowDb, []>("SELECT * FROM carts ORDER BY session_id").all(),
    items: db.query<ItemRow, []>("SELECT * FROM cart_items ORDER BY cart_session_id, product_id").all(),
  };
}

function storedQty(db: Database, session: string, productId: string): number | undefined {
  return db
    .query<{ quantity: number }, [string, string]>(
      "SELECT quantity FROM cart_items WHERE cart_session_id = ? AND product_id = ?",
    )
    .get(session, productId)?.quantity;
}

function setStock(db: Database, id: string, stock: number): void {
  db.query("UPDATE products SET stock = ? WHERE id = ?").run(stock, id);
}
function setPrice(db: Database, id: string, cents: number): void {
  db.query("UPDATE products SET price_cents = ? WHERE id = ?").run(cents, id);
}

function expectOk(r: Result<CartView>): CartView {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
function expectErr(r: Result<CartView>, code: ErrorCode): { code: string; message: string; details?: unknown } {
  if (r.ok) throw new Error(`expected ${code}, got ok`);
  expect(r.error.code).toBe(code);
  return r.error as { code: string; message: string; details?: unknown };
}

/** Sleep long enough that a later strftime('now', ms precision) would differ. */
function tick(): void {
  Bun.sleepSync(5);
}

// ---------------------------------------------------------------------------
// Criterion 1: increment single line, capped by stock (fails, no silent cap)
// ---------------------------------------------------------------------------

describe("C1 add increments a single line; stock cap", () => {
  test("repeated adds keep exactly one row and sum quantities", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 1));
    expectOk(svc.addItem(S1, TOTE, 2));
    const v = expectOk(svc.addItem(S1, TOTE, 4));
    expect(v.items).toHaveLength(1);
    expect(v.items[0]?.quantity).toBe(7);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cart_items").get()?.n).toBe(1);
    expect(storedQty(db, S1, TOTE)).toBe(7);
  });

  test("stock exactly reached (3 on stock 3) succeeds; stock+1 fails with details and no change", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, DESK, 2));
    expectOk(svc.addItem(S1, DESK, 1));
    expect(storedQty(db, S1, DESK)).toBe(3);
    const before = snapshot(db);
    tick();
    const e = expectErr(svc.addItem(S1, DESK, 1), "INSUFFICIENT_STOCK");
    expect(e.details).toEqual({ productId: DESK, available: 0, requested: 1 });
    expect(snapshot(db)).toEqual(before);
  });

  test("partial overflow is NOT silently capped: 2 + 2 on stock 3 fails, line stays 2", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, DESK, 2));
    const e = expectErr(svc.addItem(S1, DESK, 2), "INSUFFICIENT_STOCK");
    expect(e.details).toEqual({ productId: DESK, available: 1, requested: 2 });
    expect(storedQty(db, S1, DESK)).toBe(2);
  });

  test("first add above stock (4 on stock 3) creates no cart and no line", () => {
    const { db, svc } = setup();
    const e = expectErr(svc.addItem(S1, DESK, 4), "INSUFFICIENT_STOCK");
    expect(e.details).toEqual({ productId: DESK, available: 3, requested: 4 });
    expect(snapshot(db)).toEqual({ carts: [], items: [] });
  });

  test("stock-1 product: 1 ok, second 1 fails", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, PRINT, 1));
    expectErr(svc.addItem(S1, PRINT, 1), "INSUFFICIENT_STOCK");
    expect(storedQty(db, S1, PRINT)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: typed errors, no mutation
// ---------------------------------------------------------------------------

describe("C2 typed errors with no state mutation", () => {
  const invalid: ReadonlyArray<[string, unknown, string]> = [
    ["0", 0, "ZERO"],
    ["-0", -0, "ZERO"],
    ["-1", -1, "NEGATIVE"],
    ["1.5", 1.5, "NOT_INTEGER"],
    ["0.5", 0.5, "NOT_INTEGER"],
    ["NaN", Number.NaN, "NAN"],
    ["Infinity", Number.POSITIVE_INFINITY, "INFINITE"],
    ["-Infinity", Number.NEGATIVE_INFINITY, "INFINITE"],
    ["100", 100, "ABOVE_MAX"],
    ["1e2", 1e2, "ABOVE_MAX"],
    ["MAX_SAFE+1", Number.MAX_SAFE_INTEGER + 1, "ABOVE_MAX"],
    ['"2" (string)', "2", "NOT_A_NUMBER"],
    ["undefined", undefined, "NOT_A_NUMBER"],
    ["{} ", {}, "NOT_A_NUMBER"],
    ["[2]", [2], "NOT_A_NUMBER"],
    ["true", true, "NOT_A_NUMBER"],
    ["2n (bigint)", 2n, "NOT_A_NUMBER"],
  ];

  for (const [label, q, reason] of invalid) {
    test(`addItem and setQuantity reject quantity ${label} as INVALID_QUANTITY/${reason}, no mutation`, () => {
      const { db, svc } = setup();
      expectOk(svc.addItem(S1, PIN, 5));
      const before = snapshot(db);
      tick();
      const a = expectErr(svc.addItem(S1, PIN, q as number), "INVALID_QUANTITY");
      expect((a.details as { reason: string }).reason).toBe(reason);
      const s = expectErr(svc.setQuantity(S1, PIN, q as number), "INVALID_QUANTITY");
      expect((s.details as { reason: string }).reason).toBe(reason);
      expect(snapshot(db)).toEqual(before);
    });
  }

  // D1 (fixed): a null quantity used to bypass validateQuantity because
  // CartService.mutate() used `null` as its "no quantity" sentinel.
  test("D1 regression: addItem(null) on an existing line is INVALID_QUANTITY/NOT_A_NUMBER with no mutation", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, PIN, 5));
    const before = snapshot(db);
    tick();
    const e = expectErr(svc.addItem(S1, PIN, null as unknown as number), "INVALID_QUANTITY");
    expect((e.details as { reason: string }).reason).toBe("NOT_A_NUMBER");
    expect(snapshot(db)).toEqual(before);
  });

  test("D1 regression: setQuantity(null) returns INVALID_QUANTITY/NOT_A_NUMBER, does not throw", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, PIN, 5));
    const before = snapshot(db);
    tick();
    let r: Result<CartView> | undefined;
    expect(() => {
      r = svc.setQuantity(S1, PIN, null as unknown as number);
    }).not.toThrow();
    const e = expectErr(r as Result<CartView>, "INVALID_QUANTITY");
    expect((e.details as { reason: string }).reason).toBe("NOT_A_NUMBER");
    expect(snapshot(db)).toEqual(before);
  });

  test("D1 regression: addItem(null) on a NEW line is NOT_A_NUMBER (no longer ZERO by accident)", () => {
    const { db, svc } = setup();
    const e = expectErr(svc.addItem(S1, PIN, null as unknown as number), "INVALID_QUANTITY");
    expect((e.details as { reason: string }).reason).toBe("NOT_A_NUMBER");
    expect(snapshot(db)).toEqual({ carts: [], items: [] });
  });

  test("nit 1: INSUFFICIENT_STOCK message on a reduced line is clamped (no negative count)", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, DESK, 3));
    setStock(db, DESK, 1);
    const e = expectErr(svc.addItem(S1, DESK, 1), "INSUFFICIENT_STOCK");
    expect(e.message).not.toMatch(/-\d/);
  });

  test("nit 2: constructor rejects an invalid maxQuantity with TypeError", () => {
    const { db, carts, products } = setup();
    expect(() => new CartService({ db, carts, products, maxQuantity: 0 })).toThrow(TypeError);
  });

  test("max boundary: 99 accepted, 100 rejected ABOVE_MAX (stock 100 product)", () => {
    const { db, svc } = setup();
    expectOk(svc.setQuantity(S1, PIN, 99));
    expect(storedQty(db, S1, PIN)).toBe(99);
    const e = expectErr(svc.setQuantity(S1, PIN, 100), "INVALID_QUANTITY");
    expect((e.details as { reason: string }).reason).toBe("ABOVE_MAX");
    expect(storedQty(db, S1, PIN)).toBe(99);
  });

  test("cumulative max: 99 + 1 via addItem is ABOVE_MAX even though stock 100 allows it", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, PIN, 99));
    const before = snapshot(db);
    tick();
    const e = expectErr(svc.addItem(S1, PIN, 1), "INVALID_QUANTITY");
    expect((e.details as { reason: string }).reason).toBe("ABOVE_MAX");
    expect(snapshot(db)).toEqual(before);
  });

  test("50 + 50 via addItem is ABOVE_MAX (sum check), line stays 50", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, PIN, 50));
    const e = expectErr(svc.addItem(S1, PIN, 50), "INVALID_QUANTITY");
    expect((e.details as { reason: string }).reason).toBe("ABOVE_MAX");
    expect(storedQty(db, S1, PIN)).toBe(50);
  });

  test("PRODUCT_NOT_FOUND for unknown, empty, SQL-shaped and wrong-type ids; nothing written", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 1));
    const before = snapshot(db);
    tick();
    const ids: unknown[] = ["prod_nope", "", "' OR 1=1 --", `${TOTE} `, TOTE.toUpperCase(), "%", 42];
    for (const id of ids) {
      const a = expectErr(svc.addItem(S1, id as string, 1), "PRODUCT_NOT_FOUND");
      expect(a.details).toEqual({ productId: id });
      expectErr(svc.setQuantity(S1, id as string, 1), "PRODUCT_NOT_FOUND");
    }
    expect(snapshot(db)).toEqual(before);
  });

  test("OUT_OF_STOCK for stock 0 product (add + set), no cart created", () => {
    const { db, svc } = setup();
    expectErr(svc.addItem(S1, POUR, 1), "OUT_OF_STOCK");
    expectErr(svc.setQuantity(S1, POUR, 1), "OUT_OF_STOCK");
    expect(snapshot(db)).toEqual({ carts: [], items: [] });
  });

  test("validation order: quantity is checked before product existence", () => {
    const { svc } = setup();
    expectErr(svc.addItem(S1, "prod_nope", 0), "INVALID_QUANTITY");
    expectErr(svc.addItem(S1, POUR, -1), "INVALID_QUANTITY");
  });

  test("setQuantity above stock: INSUFFICIENT_STOCK available = stock, line unchanged", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, DESK, 1));
    const before = snapshot(db);
    tick();
    const e = expectErr(svc.setQuantity(S1, DESK, 4), "INSUFFICIENT_STOCK");
    expect(e.details).toEqual({ productId: DESK, available: 3, requested: 4 });
    expect(snapshot(db)).toEqual(before);
  });

  test("error results are plain JSON-serialisable data", () => {
    const { svc } = setup();
    const r = svc.addItem(S1, DESK, 4);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: setQuantity 0 rejected; removal only via removeItem
// ---------------------------------------------------------------------------

describe("C3 setQuantity(0) rejected", () => {
  test("setQuantity 0 and -0 do not remove the line", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 3));
    expectErr(svc.setQuantity(S1, TOTE, 0), "INVALID_QUANTITY");
    expectErr(svc.setQuantity(S1, TOTE, -0), "INVALID_QUANTITY");
    expect(storedQty(db, S1, TOTE)).toBe(3);
  });

  test("setQuantity 0 on a product not in the cart creates nothing", () => {
    const { db, svc } = setup();
    expectErr(svc.setQuantity(S1, TOTE, 0), "INVALID_QUANTITY");
    expect(snapshot(db)).toEqual({ carts: [], items: [] });
  });

  test("removeItem removes; setQuantity upserts a product not yet in the cart (ruling)", () => {
    const { db, svc } = setup();
    const v = expectOk(svc.setQuantity(S1, TOTE, 2));
    expect(v.items.map((i) => [i.productId, i.quantity])).toEqual([[TOTE, 2]]);
    expectOk(svc.removeItem(S1, TOTE));
    expect(storedQty(db, S1, TOTE)).toBeUndefined();
  });

  test("setQuantity down and up within stock is absolute, not additive", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, DESK, 3));
    expectOk(svc.setQuantity(S1, DESK, 1));
    expect(storedQty(db, S1, DESK)).toBe(1);
    expectOk(svc.setQuantity(S1, DESK, 3));
    expect(storedQty(db, S1, DESK)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: removeItem absent no-op; unknown session empty cart
// ---------------------------------------------------------------------------

describe("C4 removeItem idempotent; unknown session empty", () => {
  test("removeItem of absent / unknown product on an existing cart is ok and changes nothing", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 1));
    const before = snapshot(db).items;
    const v1 = expectOk(svc.removeItem(S1, DESK));
    const v2 = expectOk(svc.removeItem(S1, "prod_does_not_exist"));
    const v3 = expectOk(svc.removeItem(S1, "' OR 1=1 --"));
    expect(v1.items).toHaveLength(1);
    expect(v2.items).toHaveLength(1);
    expect(v3.items).toHaveLength(1);
    expect(snapshot(db).items).toEqual(before);
  });

  test("removeItem with no cart at all is ok, returns empty view and creates no cart row", () => {
    const { db, svc } = setup();
    const v = expectOk(svc.removeItem(S1, TOTE));
    expect(v.items).toEqual([]);
    expect(v.subtotalCents).toBe(0);
    expect(snapshot(db)).toEqual({ carts: [], items: [] });
  });

  test("removeItem twice is idempotent", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 1));
    expectOk(svc.removeItem(S1, TOTE));
    expectOk(svc.removeItem(S1, TOTE));
    expect(storedQty(db, S1, TOTE)).toBeUndefined();
  });

  test("getCart / getTotals for unknown valid session: empty, zero, cannot checkout", () => {
    const { svc } = setup();
    const v = svc.getCart(S3);
    expect(v).toEqual({ sessionId: S3, items: [], subtotalCents: 0, currency: "USD", itemCount: 0, canCheckout: false });
    expect(svc.getTotals(S3)).toEqual({ subtotalCents: 0, itemCount: 0 });
  });

  test("getCart for null / malformed / SQL-shaped session ids returns empty and never throws", () => {
    const { svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 1));
    const bad: unknown[] = [
      null,
      "",
      "not-a-uuid",
      S3.toUpperCase(),
      ` ${S1}`,
      `${S1}\u0000`,
      "' OR '1'='1",
      `${S1.slice(0, 35)}' OR 1=1 --`,
      "x".repeat(100000),
    ];
    for (const s of bad) {
      const v = svc.getCart(s as string | null);
      expect(v.items).toEqual([]);
      expect(v.subtotalCents).toBe(0);
      expect(svc.getTotals(s as string | null)).toEqual({ subtotalCents: 0, itemCount: 0 });
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: exact integer totals
// ---------------------------------------------------------------------------

describe("C5 exact integer totals", () => {
  test("3 x 1999 = 5997", () => {
    const { svc } = setup();
    const v = expectOk(svc.addItem(S1, TOTE, 3));
    expect(v.items[0]?.unitPriceCents).toBe(1999);
    expect(v.items[0]?.lineTotalCents).toBe(5997);
    expect(v.subtotalCents).toBe(5997);
    expect(Number.isInteger(v.subtotalCents)).toBe(true);
    expect(svc.getTotals(S1)).toEqual({ subtotalCents: 5997, itemCount: 3 });
  });

  test("empty cart subtotal 0 and after clear 0", () => {
    const { svc } = setup();
    expect(svc.getCart(S1).subtotalCents).toBe(0);
    expectOk(svc.addItem(S1, TOTE, 1));
    const v = expectOk(svc.clear(S1));
    expect(v.subtotalCents).toBe(0);
    expect(v.itemCount).toBe(0);
  });

  test("multi-line sum is exact: 3x1999 + 99x50 + 3x125000 + 1x18000", () => {
    const { svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 3));
    expectOk(svc.addItem(S1, PIN, 99));
    expectOk(svc.addItem(S1, DESK, 3));
    const v = expectOk(svc.addItem(S1, PRINT, 1));
    expect(v.subtotalCents).toBe(5997 + 4950 + 375000 + 18000);
    expect(v.itemCount).toBe(106);
    for (const i of v.items) expect(Number.isInteger(i.lineTotalCents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: changed price / stock / deleted product reflected on read
// ---------------------------------------------------------------------------

describe("C6 catalogue changes reflected by getCart", () => {
  test("price change: new unit price shown, totals recomputed, stored row untouched", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 3));
    const before = snapshot(db);
    setPrice(db, TOTE, 2501);
    const v = svc.getCart(S1);
    expect(v.items[0]).toMatchObject({ unitPriceCents: 2501, lineTotalCents: 7503, status: "ok" });
    expect(v.subtotalCents).toBe(7503);
    expect(svc.getTotals(S1).subtotalCents).toBe(7503);
    setPrice(db, TOTE, 0);
    expect(svc.getCart(S1).subtotalCents).toBe(0);
    expect(snapshot(db)).toEqual(before);
  });

  test("stock lowered below stored quantity: reduced, quantity stays stored, lineTotal uses min", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, DESK, 3));
    expectOk(svc.addItem(S1, TOTE, 1));
    setStock(db, DESK, 1);
    const v = svc.getCart(S1);
    const desk = v.items.find((i) => i.productId === DESK);
    expect(desk).toMatchObject({ status: "reduced", quantity: 3, availableStock: 1, lineTotalCents: 125000 });
    expect(v.subtotalCents).toBe(125000 + 1999);
    expect(v.itemCount).toBe(4); // ruling: stored quantities
    expect(v.canCheckout).toBe(true); // reduced does not block (README)
    expect(storedQty(db, S1, DESK)).toBe(3);
  });

  test("stock equal to stored quantity is ok, not reduced", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, DESK, 2));
    setStock(db, DESK, 2);
    expect(svc.getCart(S1).items[0]?.status).toBe("ok");
  });

  test("stock set to 0: unavailable, lineTotal 0, canCheckout false, no throw", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, DESK, 2));
    expectOk(svc.addItem(S1, TOTE, 1));
    setStock(db, DESK, 0);
    const v = svc.getCart(S1);
    expect(v.items.find((i) => i.productId === DESK)).toMatchObject({
      status: "unavailable",
      lineTotalCents: 0,
      availableStock: 0,
      quantity: 2,
    });
    expect(v.subtotalCents).toBe(1999);
    expect(v.canCheckout).toBe(false);
    expect(svc.getTotals(S1)).toEqual({ subtotalCents: 1999, itemCount: 3 });
  });

  test("mutations on a reduced/unavailable line: add fails, set to stock fixes, remove works", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, DESK, 3));
    setStock(db, DESK, 1);
    const e = expectErr(svc.addItem(S1, DESK, 1), "INSUFFICIENT_STOCK");
    expect((e.details as { available: number }).available).toBe(0);
    expect(storedQty(db, S1, DESK)).toBe(3);
    const v = expectOk(svc.setQuantity(S1, DESK, 1));
    expect(v.items[0]?.status).toBe("ok");
    setStock(db, DESK, 0);
    expectErr(svc.setQuantity(S1, DESK, 1), "OUT_OF_STOCK");
    expectOk(svc.removeItem(S1, DESK));
    expect(svc.getCart(S1).items).toEqual([]);
  });

  test("deleted product (stubbed getManyByIds/getById miss): placeholder line, no throw, remove works", () => {
    const { svc, db } = setup({
      products: (real) => ({
        list: () => real.list().filter((p) => p.id !== DESK),
        getBySlug: (s) => {
          const p = real.getBySlug(s);
          return p?.id === DESK ? null : p;
        },
        getById: (id) => (id === DESK ? null : real.getById(id)),
        getManyByIds: (ids) => real.getManyByIds(ids).filter((p) => p.id !== DESK),
        decrementStock: (id, q) => real.decrementStock(id, q),
      }),
    });
    // Seed the line directly (the product "existed" at add time).
    db.query("INSERT INTO carts (session_id) VALUES (?)").run(S1);
    db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, ?)").run(S1, DESK, 2);
    expectOk(svc.addItem(S1, TOTE, 1));
    const v = svc.getCart(S1);
    expect(v.items.find((i) => i.productId === DESK)).toEqual({
      productId: DESK,
      quantity: 2,
      unitPriceCents: 0,
      status: "unavailable",
      name: UNAVAILABLE_PRODUCT_NAME,
      slug: "",
      imageUrl: "",
      availableStock: 0,
      lineTotalCents: 0,
    });
    expect(UNAVAILABLE_PRODUCT_NAME).toBe("Unavailable product");
    expect(v.subtotalCents).toBe(1999);
    expect(v.itemCount).toBe(3);
    expect(v.canCheckout).toBe(false);
    expect(v.currency).toBe("USD");
    expectErr(svc.addItem(S1, DESK, 1), "PRODUCT_NOT_FOUND");
    expect(storedQty(db, S1, DESK)).toBe(2);
    expectOk(svc.removeItem(S1, DESK));
    expect(svc.getCart(S1).canCheckout).toBe(true);
  });

  test("cart whose ONLY line is a deleted product: currency falls back to USD, no throw", () => {
    const { svc, db } = setup({
      products: (real) => ({ ...wrap(real), getManyByIds: () => [], getById: () => null }),
    });
    db.query("INSERT INTO carts (session_id) VALUES (?)").run(S1);
    db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, ?)").run(S1, DESK, 1);
    const v = svc.getCart(S1);
    expect(v.items[0]?.status).toBe("unavailable");
    expect(v.currency).toBe("USD");
    expect(v.subtotalCents).toBe(0);
  });
});

function wrap(real: ProductRepository): ProductRepository {
  return {
    list: () => real.list(),
    getBySlug: (s) => real.getBySlug(s),
    getById: (id) => real.getById(id),
    getManyByIds: (ids) => real.getManyByIds(ids),
    decrementStock: (id, q) => real.decrementStock(id, q),
  };
}

// ---------------------------------------------------------------------------
// Criterion 7: session isolation
// ---------------------------------------------------------------------------

describe("C7 session isolation", () => {
  test("interleaved add/set/remove across two sessions never leak", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 2));
    expectOk(svc.addItem(S2, TOTE, 5));
    expectOk(svc.setQuantity(S1, DESK, 3));
    expectOk(svc.setQuantity(S2, DESK, 3)); // stock is per-line check, not reserved
    expectOk(svc.removeItem(S2, TOTE));
    expectOk(svc.addItem(S1, TOTE, 1));
    expectOk(svc.addItem(S2, PIN, 7));
    expectOk(svc.removeItem(S1, PIN)); // S2's pin must survive
    expectOk(svc.clear(S1));
    expectOk(svc.addItem(S1, BEANIE, 1));

    const v1 = svc.getCart(S1);
    const v2 = svc.getCart(S2);
    expect(v1.sessionId).toBe(S1);
    expect(v2.sessionId).toBe(S2);
    expect(v1.items.map((i) => [i.productId, i.quantity])).toEqual([[BEANIE, 1]]);
    expect(v2.items.map((i) => [i.productId, i.quantity])).toEqual([
      [DESK, 3],
      [PIN, 7],
    ]);
    expect(storedQty(db, S2, PIN)).toBe(7);
    expect(storedQty(db, S1, TOTE)).toBeUndefined();
  });

  test("a session's addItem stock check uses only its own line", () => {
    const { svc } = setup();
    expectOk(svc.addItem(S1, DESK, 3));
    expectOk(svc.addItem(S2, DESK, 3));
    expectErr(svc.addItem(S2, DESK, 1), "INSUFFICIENT_STOCK");
  });

  test("SQL-injection-shaped session ids: INVALID_INPUT on every mutation, other carts untouched", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 1));
    expectOk(svc.addItem(S2, TOTE, 1));
    const before = snapshot(db);
    const evil = [
      "' OR 1=1 --",
      "x'); DELETE FROM carts; --",
      `${S1}' OR '1'='1`,
      `${S1.slice(0, 35)}%`,
      "%",
      S3.toUpperCase(),
    ];
    for (const s of evil) {
      expectErr(svc.addItem(s, TOTE, 1), "INVALID_INPUT");
      expectErr(svc.setQuantity(s, TOTE, 1), "INVALID_INPUT");
      expectErr(svc.removeItem(s, TOTE), "INVALID_INPUT");
      expectErr(svc.clear(s), "INVALID_INPUT");
      expect(svc.getCart(s).items).toEqual([]);
    }
    expect(snapshot(db)).toEqual(before);
  });

  test("invalid session is INVALID_INPUT even when quantity is also invalid (session first)", () => {
    const { svc } = setup();
    expectErr(svc.addItem("nope", TOTE, 0), "INVALID_INPUT");
    expectErr(svc.setQuantity(null as unknown as string, TOTE, Number.NaN), "INVALID_INPUT");
  });

  test("repository: writes with invalid ids throw TypeError, reads return [] (ruling)", () => {
    const { carts } = setup();
    expect(() => carts.upsertItem("' OR 1=1 --", TOTE, 1)).toThrow(TypeError);
    expect(() => carts.ensureCart("bad", "USD")).toThrow(TypeError);
    expect(() => carts.removeItem("bad", TOTE)).toThrow(TypeError);
    expect(() => carts.clear("bad")).toThrow(TypeError);
    expect(carts.getItems("' OR 1=1 --")).toEqual([]);
  });

  test("clear of one session leaves the other session's cart and lines", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 1));
    expectOk(svc.addItem(S2, DESK, 2));
    expectOk(svc.clear(S1));
    expect(svc.getCart(S1).items).toEqual([]);
    expect(svc.getCart(S2).items.map((i) => i.quantity)).toEqual([2]);
    expect(snapshot(db).carts.map((c) => c.session_id)).toEqual([S2]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 8: concurrent adds never exceed stock
// ---------------------------------------------------------------------------

describe("C8 concurrency", () => {
  test("25 concurrent adds of 1 on a stock-3 product: exactly 3 succeed, 22 fail, stored 3", async () => {
    const { db, svc } = setup();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => Promise.resolve().then(() => svc.addItem(S1, DESK, 1))),
    );
    const okCount = results.filter((r) => r.ok).length;
    const failCodes = results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.error.code));
    expect(okCount).toBe(3);
    expect(failCodes).toHaveLength(22);
    for (const c of failCodes) expect(["INSUFFICIENT_STOCK", "OUT_OF_STOCK"]).toContain(c);
    expect(storedQty(db, S1, DESK)).toBe(3);
  });

  test("concurrent mixed add/set/remove across two sessions on a file DB with two connections", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cart-qa-"));
    try {
      const path = join(dir, "c.sqlite");
      const dbA = createDatabase(path);
      runMigrations(dbA);
      seedProducts(dbA);
      const dbB = createDatabase(path);
      const a = setup({ db: dbA });
      const b = setup({ db: dbB });
      const ops: Array<() => Result<CartView>> = [];
      for (let i = 0; i < 20; i++) {
        ops.push(() => a.svc.addItem(S1, DESK, 1));
        ops.push(() => b.svc.addItem(S1, DESK, 1));
        ops.push(() => b.svc.addItem(S2, DESK, 2));
        if (i % 5 === 0) ops.push(() => a.svc.setQuantity(S2, DESK, 3));
      }
      const results = await Promise.all(ops.map((op) => Promise.resolve().then(op)));
      for (const r of results) {
        if (!r.ok) expect(["INSUFFICIENT_STOCK", "OUT_OF_STOCK"]).toContain(r.error.code);
      }
      expect(results.filter((r) => r.ok && r.value.sessionId === S1).length).toBe(3);
      expect(storedQty(dbA, S1, DESK)).toBe(3);
      expect(storedQty(dbA, S2, DESK)).toBeLessThanOrEqual(3);
      dbA.close();
      dbB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting invariants
// ---------------------------------------------------------------------------

describe("invariants", () => {
  test("clear then getCart is empty; cart row deleted; re-add works", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 2));
    expectOk(svc.addItem(S1, DESK, 1));
    expectOk(svc.clear(S1));
    expect(svc.getCart(S1).items).toEqual([]);
    expect(snapshot(db)).toEqual({ carts: [], items: [] });
    expectOk(svc.clear(S1));
    expect(expectOk(svc.addItem(S1, TOTE, 1)).items).toHaveLength(1);
  });

  test("getTotals always equals getCart's subtotal/itemCount across states", () => {
    const { db, svc } = setup();
    const check = (): void => {
      const v = svc.getCart(S1);
      expect(svc.getTotals(S1)).toEqual({ subtotalCents: v.subtotalCents, itemCount: v.itemCount });
      expect(v.subtotalCents).toBe(v.items.reduce((n, i) => n + i.lineTotalCents, 0));
      expect(v.itemCount).toBe(v.items.reduce((n, i) => n + i.quantity, 0));
    };
    check();
    expectOk(svc.addItem(S1, TOTE, 3));
    check();
    expectOk(svc.addItem(S1, DESK, 3));
    check();
    setStock(db, DESK, 2);
    check();
    setStock(db, DESK, 0);
    check();
    setPrice(db, TOTE, 1);
    check();
    expectOk(svc.clear(S1));
    check();
  });

  test("mutation result view equals a fresh getCart", () => {
    const { svc } = setup();
    const v = expectOk(svc.addItem(S1, TOTE, 2));
    expect(v).toEqual(svc.getCart(S1));
    const w = expectOk(svc.setQuantity(S1, DESK, 2));
    expect(w).toEqual(svc.getCart(S1));
  });

  test("JSON round-trip of a view (ok, reduced, unavailable lines) is lossless", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, TOTE, 3));
    expectOk(svc.addItem(S1, DESK, 3));
    expectOk(svc.addItem(S1, PRINT, 1));
    setStock(db, DESK, 1);
    setStock(db, PRINT, 0);
    const v = svc.getCart(S1);
    expect(v.items.map((i) => i.status)).toEqual(["ok", "reduced", "unavailable"]);
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    expect(JSON.parse(JSON.stringify(svc.getCart(S3)))).toEqual(svc.getCart(S3));
  });

  test("failed mutations leave updated_at and every row byte-identical (snapshot)", () => {
    const { db, svc } = setup();
    expectOk(svc.addItem(S1, DESK, 2));
    expectOk(svc.addItem(S1, TOTE, 1));
    const before = snapshot(db);
    tick();
    const failures: Array<() => Result<CartView>> = [
      () => svc.addItem(S1, DESK, 2),
      () => svc.addItem(S1, DESK, 0),
      () => svc.addItem(S1, "prod_nope", 1),
      () => svc.addItem(S1, POUR, 1),
      () => svc.setQuantity(S1, DESK, 4),
      () => svc.setQuantity(S1, TOTE, 0),
      () => svc.setQuantity(S1, TOTE, 100),
      () => svc.setQuantity(S1, POUR, 1),
      () => svc.addItem("bad", TOTE, 1),
      () => svc.clear("bad"),
      () => svc.removeItem("bad", TOTE),
    ];
    for (const f of failures) {
      expect(f().ok).toBe(false);
      tick();
    }
    expect(snapshot(db)).toEqual(before);
  });

  test("randomised op sequence: no row ever has quantity <= 0 or > stock-at-write; failures never mutate", () => {
    const { db, svc } = setup();
    let seed = 12345;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const sessions = [S1, S2];
    const productIds = [TOTE, PIN, DESK, POUR, PRINT, "prod_nope"];
    const quantities: unknown[] = [1, 2, 3, 5, 50, 99, 100, 0, -1, 1.5, Number.NaN, "2"];
    for (let i = 0; i < 600; i++) {
      const s = sessions[rand(2)] as string;
      const p = productIds[rand(productIds.length)] as string;
      const q = quantities[rand(quantities.length)] as number;
      const op = rand(10);
      const before = snapshot(db);
      const r =
        op < 5 ? svc.addItem(s, p, q) : op < 8 ? svc.setQuantity(s, p, q) : op < 9 ? svc.removeItem(s, p) : svc.clear(s);
      if (!r.ok) expect(snapshot(db)).toEqual(before);
      const bad = db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM cart_items ci JOIN products p ON p.id = ci.product_id
            WHERE ci.quantity <= 0 OR ci.quantity > p.stock OR ci.quantity > 99 OR typeof(ci.quantity) <> 'integer'`,
        )
        .get()?.n;
      expect(bad).toBe(0);
      const orphan = db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM cart_items ci LEFT JOIN carts c ON c.session_id = ci.cart_session_id WHERE c.session_id IS NULL",
        )
        .get()?.n;
      expect(orphan).toBe(0);
    }
  });
});
