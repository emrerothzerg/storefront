import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Product } from "@/lib/types";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedProducts } from "@/server/db/seed";
import { SqliteProductRepository, type ProductRepository } from "@/server/catalog/product-repository";
import { SqliteCartRepository } from "./cart-repository";
import { CartService, CartTotalOverflowError, createCartService, type CartView } from "./cart-service";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";

interface SeedLine {
  readonly id: string;
  readonly price: number;
  readonly stock: number;
}

function setup(products: readonly SeedLine[] = [], maxQuantity?: number) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const insert = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, ?, 'USD', ?, ?)",
  );
  for (const p of products) insert.run(p.id, `${p.id}-slug`, `Name ${p.id}`, p.price, `/images/${p.id}.svg`, p.stock);
  const carts = new SqliteCartRepository(db);
  const productRepo = new SqliteProductRepository(db);
  const service = new CartService({ db, carts, products: productRepo, ...(maxQuantity === undefined ? {} : { maxQuantity }) });
  return { db, carts, service };
}

function rows(db: Database) {
  return db.query("SELECT cart_session_id AS s, product_id AS p, quantity AS q FROM cart_items ORDER BY s, p").all();
}

function unwrap(r: { ok: true; value: CartView } | { ok: false; error: unknown }): CartView {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

const TOTE: SeedLine = { id: "tote", price: 1999, stock: 5 };
const PIN: SeedLine = { id: "pin", price: 50, stock: 100 };
const GONE: SeedLine = { id: "gone", price: 3400, stock: 0 };

describe("getCart", () => {
  test("null, invalid and unknown sessions are empty carts", () => {
    const { service } = setup([TOTE]);
    for (const s of [null, "", "not-a-uuid", S1]) {
      const view = service.getCart(s);
      expect(view.items).toEqual([]);
      expect(view.subtotalCents).toBe(0);
      expect(view.itemCount).toBe(0);
      expect(view.canCheckout).toBe(false);
      expect(view.currency).toBe("USD");
    }
  });

  test("null session does not touch the DB", () => {
    const { db, service } = setup();
    db.close();
    expect(service.getCart(null).items).toEqual([]);
    expect(service.getCart("x").items).toEqual([]);
  });

  test("full line view shape", () => {
    const { service } = setup([TOTE]);
    const view = unwrap(service.addItem(S1, "tote", 3));
    expect(view).toEqual({
      sessionId: S1,
      currency: "USD",
      subtotalCents: 5997,
      itemCount: 3,
      canCheckout: true,
      items: [
        {
          productId: "tote",
          quantity: 3,
          unitPriceCents: 1999,
          status: "ok",
          name: "Name tote",
          slug: "tote-slug",
          imageUrl: "/images/tote.svg",
          availableStock: 5,
          lineTotalCents: 5997,
        },
      ],
    });
    expect(service.getCart(S1)).toEqual(view);
    expect(service.getTotals(S1)).toEqual({ subtotalCents: 5997, itemCount: 3 });
    expect(service.getTotals(null)).toEqual({ subtotalCents: 0, itemCount: 0 });
  });

  test("totals are exact integers over several lines", () => {
    const { service } = setup([TOTE, PIN, { id: "c", price: 1, stock: 99 }]);
    unwrap(service.addItem(S1, "tote", 3));
    unwrap(service.addItem(S1, "pin", 7));
    const view = unwrap(service.addItem(S1, "c", 99));
    expect(view.subtotalCents).toBe(5997 + 350 + 99);
    expect(Number.isInteger(view.subtotalCents)).toBe(true);
    expect(view.itemCount).toBe(109);
  });

  test("a price change since add is reflected", () => {
    const { db, service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 2));
    db.run("UPDATE products SET price_cents = 2500 WHERE id = 'tote'");
    const view = service.getCart(S1);
    expect(view.items[0]?.unitPriceCents).toBe(2500);
    expect(view.subtotalCents).toBe(5000);
    expect(view.items[0]?.status).toBe("ok");
  });

  test("stock lowered below quantity: reduced, stored quantity kept, totals use stock", () => {
    const { db, service } = setup([TOTE, PIN]);
    unwrap(service.addItem(S1, "tote", 4));
    unwrap(service.addItem(S1, "pin", 1));
    db.run("UPDATE products SET stock = 2 WHERE id = 'tote'");
    const view = service.getCart(S1);
    expect(view.items[0]).toMatchObject({ status: "reduced", quantity: 4, availableStock: 2, lineTotalCents: 3998 });
    expect(view.subtotalCents).toBe(3998 + 50);
    expect(view.itemCount).toBe(5);
    expect(view.canCheckout).toBe(true);
    expect(rows(db)).toEqual([
      { s: S1, p: "pin", q: 1 },
      { s: S1, p: "tote", q: 4 },
    ]);
  });

  test("stock dropped to 0: unavailable, excluded from subtotal, blocks checkout", () => {
    const { db, service } = setup([TOTE, PIN]);
    unwrap(service.addItem(S1, "tote", 2));
    unwrap(service.addItem(S1, "pin", 2));
    db.run("UPDATE products SET stock = 0 WHERE id = 'tote'");
    const view = service.getCart(S1);
    expect(view.items[0]).toMatchObject({ status: "unavailable", quantity: 2, unitPriceCents: 1999, lineTotalCents: 0 });
    expect(view.subtotalCents).toBe(100);
    expect(view.canCheckout).toBe(false);
  });

  test("deleted product (getManyByIds miss, stubbed): unavailable placeholder, no throw", () => {
    const { db, carts, service: real } = setup([TOTE, PIN]);
    unwrap(real.addItem(S1, "tote", 2));
    unwrap(real.addItem(S1, "pin", 1));
    const sqlite = new SqliteProductRepository(db);
    const deletedTote: ProductRepository = {
      list: () => sqlite.list(),
      getBySlug: (slug) => sqlite.getBySlug(slug),
      getById: (id) => (id === "tote" ? null : sqlite.getById(id)),
      getManyByIds: (ids) => sqlite.getManyByIds(ids).filter((p: Product) => p.id !== "tote"),
      decrementStock: (id, q) => sqlite.decrementStock(id, q),
    };
    const service = new CartService({ db, carts, products: deletedTote });
    const view = service.getCart(S1);
    expect(view.items[0]).toEqual({
      productId: "tote",
      quantity: 2,
      unitPriceCents: 0,
      status: "unavailable",
      name: "Unavailable product",
      slug: "",
      imageUrl: "",
      availableStock: 0,
      lineTotalCents: 0,
    });
    expect(view.items[1]?.status).toBe("ok");
    expect(view.subtotalCents).toBe(50);
    expect(view.canCheckout).toBe(false);
    // The dead line can still be removed.
    const after = unwrap(service.removeItem(S1, "tote"));
    expect(after.items.map((i) => i.productId)).toEqual(["pin"]);
    expect(after.canCheckout).toBe(true);
  });
});

describe("addItem", () => {
  test("adding an existing product increments its single line", () => {
    const { db, service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 1));
    const view = unwrap(service.addItem(S1, "tote", 2));
    expect(view.items).toHaveLength(1);
    expect(view.items[0]?.quantity).toBe(3);
    expect(rows(db)).toEqual([{ s: S1, p: "tote", q: 3 }]);
  });

  test("filling to exactly stock succeeds", () => {
    const { service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 2));
    expect(unwrap(service.addItem(S1, "tote", 3)).items[0]?.quantity).toBe(5);
  });

  test("exceeding stock fails with INSUFFICIENT_STOCK and leaves the line unchanged", () => {
    const { db, service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 4));
    const r = service.addItem(S1, "tote", 2);
    expect(r).toEqual({
      ok: false,
      error: {
        code: "INSUFFICIENT_STOCK",
        message: expect.any(String),
        details: { productId: "tote", available: 1, requested: 2 },
      },
    });
    expect(rows(db)).toEqual([{ s: S1, p: "tote", q: 4 }]);
  });

  test("first add above stock fails and creates no cart row", () => {
    const { db, service } = setup([TOTE]);
    const r = service.addItem(S1, "tote", 6);
    expect(!r.ok && r.error).toMatchObject({ code: "INSUFFICIENT_STOCK", details: { available: 5, requested: 6 } });
    expect(rows(db)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM carts").get()).toEqual({ n: 0 });
  });

  test("PRODUCT_NOT_FOUND and OUT_OF_STOCK do not mutate", () => {
    const { db, service } = setup([TOTE, GONE]);
    unwrap(service.addItem(S1, "tote", 1));
    const nf = service.addItem(S1, "nope", 1);
    expect(!nf.ok && nf.error.code).toBe("PRODUCT_NOT_FOUND");
    const oos = service.addItem(S1, "gone", 1);
    expect(!oos.ok && oos.error).toMatchObject({ code: "OUT_OF_STOCK", details: { available: 0 } });
    expect(rows(db)).toEqual([{ s: S1, p: "tote", q: 1 }]);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 100])("INVALID_QUANTITY for %p, no mutation", (q) => {
    const { db, service } = setup([PIN]);
    unwrap(service.addItem(S1, "pin", 1));
    const r = service.addItem(S1, "pin", q);
    expect(!r.ok && r.error.code).toBe("INVALID_QUANTITY");
    expect(rows(db)).toEqual([{ s: S1, p: "pin", q: 1 }]);
  });

  test("a non-number quantity from the wire is INVALID_QUANTITY", () => {
    const { service } = setup([PIN]);
    const r = service.addItem(S1, "pin", "2" as unknown as number);
    expect(!r.ok && r.error.code).toBe("INVALID_QUANTITY");
  });

  test("the line total may not exceed maxQuantity even when stock allows", () => {
    const { db, service } = setup([PIN], 10);
    unwrap(service.addItem(S1, "pin", 8));
    const r = service.addItem(S1, "pin", 3);
    expect(!r.ok && r.error).toMatchObject({ code: "INVALID_QUANTITY", details: { reason: "ABOVE_MAX", max: 10 } });
    expect(rows(db)).toEqual([{ s: S1, p: "pin", q: 8 }]);
    const tooMany = service.addItem(S1, "pin", 11);
    expect(!tooMany.ok && tooMany.error.code).toBe("INVALID_QUANTITY");
  });

  test("an invalid session is INVALID_INPUT and writes nothing", () => {
    const { db, service } = setup([PIN]);
    for (const s of ["", "abc", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]) {
      const r = service.addItem(s, "pin", 1);
      expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
    }
    expect(rows(db)).toEqual([]);
  });

  test("concurrent adds (Promise.all of 10) never exceed stock", async () => {
    const { db, service } = setup([{ id: "desk", price: 125000, stock: 3 }]);
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        await Promise.resolve();
        return service.addItem(S1, "desk", 1);
      }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    const failures = results.filter((r) => !r.ok);
    expect(failures).toHaveLength(7);
    for (const f of failures) expect(!f.ok && f.error.code).toBe("INSUFFICIENT_STOCK");
    expect(rows(db)).toEqual([{ s: S1, p: "desk", q: 3 }]);
  });

  test("concurrent adds through two connections to one file DB never exceed stock", async () => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/cart-svc-${crypto.randomUUID()}`;
    const { mkdirSync, rmSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/db.sqlite`;
    try {
      const a = createDatabase(path);
      runMigrations(a);
      seedProducts(a);
      const b = createDatabase(path);
      const sa = createCartService(a);
      const sb = createCartService(b);
      const results = await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          await Promise.resolve();
          return (i % 2 === 0 ? sa : sb).addItem(S1, "prod_walnut-desk", 1);
        }),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(3);
      expect(sb.getCart(S1).items[0]?.quantity).toBe(3);
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("setQuantity", () => {
  test("sets an absolute quantity", () => {
    const { db, service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 4));
    expect(unwrap(service.setQuantity(S1, "tote", 2)).items[0]?.quantity).toBe(2);
    expect(rows(db)).toEqual([{ s: S1, p: "tote", q: 2 }]);
  });

  test("0 is INVALID_QUANTITY and does not remove the line", () => {
    const { db, service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 2));
    const r = service.setQuantity(S1, "tote", 0);
    expect(!r.ok && r.error).toMatchObject({ code: "INVALID_QUANTITY", details: { reason: "ZERO" } });
    expect(rows(db)).toEqual([{ s: S1, p: "tote", q: 2 }]);
  });

  test.each([-3, 2.5, Number.NaN, 100])("INVALID_QUANTITY for %p", (q) => {
    const { service } = setup([TOTE]);
    const r = service.setQuantity(S1, "tote", q);
    expect(!r.ok && r.error.code).toBe("INVALID_QUANTITY");
  });

  test("above stock is INSUFFICIENT_STOCK with available = stock, no mutation", () => {
    const { db, service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 2));
    const r = service.setQuantity(S1, "tote", 6);
    expect(!r.ok && r.error).toMatchObject({
      code: "INSUFFICIENT_STOCK",
      details: { productId: "tote", available: 5, requested: 6 },
    });
    expect(rows(db)).toEqual([{ s: S1, p: "tote", q: 2 }]);
  });

  test("a product not yet in the cart is upserted", () => {
    const { service } = setup([TOTE]);
    expect(unwrap(service.setQuantity(S1, "tote", 3)).items[0]?.quantity).toBe(3);
  });

  test("lowering a reduced line to stock clears the flag", () => {
    const { db, service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 5));
    db.run("UPDATE products SET stock = 2 WHERE id = 'tote'");
    expect(service.getCart(S1).items[0]?.status).toBe("reduced");
    expect(unwrap(service.setQuantity(S1, "tote", 2)).items[0]?.status).toBe("ok");
  });

  test("PRODUCT_NOT_FOUND, OUT_OF_STOCK, INVALID_INPUT", () => {
    const { db, service } = setup([GONE]);
    const a = service.setQuantity(S1, "nope", 1);
    expect(!a.ok && a.error.code).toBe("PRODUCT_NOT_FOUND");
    const b = service.setQuantity(S1, "gone", 1);
    expect(!b.ok && b.error.code).toBe("OUT_OF_STOCK");
    const c = service.setQuantity("bad", "gone", 1);
    expect(!c.ok && c.error.code).toBe("INVALID_INPUT");
    expect(rows(db)).toEqual([]);
  });
});

describe("removeItem / clear", () => {
  test("removeItem deletes the line", () => {
    const { service } = setup([TOTE, PIN]);
    unwrap(service.addItem(S1, "tote", 1));
    unwrap(service.addItem(S1, "pin", 1));
    expect(unwrap(service.removeItem(S1, "tote")).items.map((i) => i.productId)).toEqual(["pin"]);
  });

  test("removeItem of an absent or unknown product is a no-op success", () => {
    const { service } = setup([TOTE]);
    expect(unwrap(service.removeItem(S1, "tote")).items).toEqual([]);
    unwrap(service.addItem(S1, "tote", 1));
    expect(unwrap(service.removeItem(S1, "does-not-exist")).items).toHaveLength(1);
  });

  test("clear empties the cart and is idempotent", () => {
    const { db, service } = setup([TOTE, PIN]);
    unwrap(service.addItem(S1, "tote", 1));
    unwrap(service.addItem(S1, "pin", 1));
    const view = unwrap(service.clear(S1));
    expect(view).toEqual({ sessionId: S1, items: [], subtotalCents: 0, currency: "USD", itemCount: 0, canCheckout: false });
    expect(unwrap(service.clear(S1)).items).toEqual([]);
    expect(rows(db)).toEqual([]);
  });

  test("invalid sessions are INVALID_INPUT", () => {
    const { service } = setup();
    const r = service.removeItem("x", "tote");
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
    const c = service.clear("x");
    expect(!c.ok && c.error.code).toBe("INVALID_INPUT");
  });
});

describe("session isolation", () => {
  test("two sessions never see each other's carts", () => {
    const { service } = setup([TOTE, PIN]);
    unwrap(service.addItem(S1, "tote", 2));
    unwrap(service.addItem(S2, "pin", 5));
    expect(service.getCart(S1).items.map((i) => [i.productId, i.quantity])).toEqual([["tote", 2]]);
    expect(service.getCart(S2).items.map((i) => [i.productId, i.quantity])).toEqual([["pin", 5]]);
    unwrap(service.clear(S2));
    expect(service.getCart(S1).itemCount).toBe(2);
    unwrap(service.removeItem(S2, "tote"));
    expect(service.getCart(S1).itemCount).toBe(2);
  });

  test("each session's stock check counts only its own line", () => {
    const { service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 5));
    expect(unwrap(service.addItem(S2, "tote", 5)).items[0]?.quantity).toBe(5);
  });
});

describe("createCartService", () => {
  test("wires the SQLite repositories against seeded products", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedProducts(db);
    const service = createCartService(db);
    const view = unwrap(service.addItem(S1, "prod_canvas-tote-bag", 3));
    expect(view.subtotalCents).toBe(5997);
    const oos = service.addItem(S1, "prod_ceramic-pour-over", 1);
    expect(!oos.ok && oos.error.code).toBe("OUT_OF_STOCK");
  });
});

describe("non-number quantities from the wire (D1)", () => {
  const PIN_ID = "prod_enamel-pin-set";

  function seeded() {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedProducts(db);
    const service = createCartService(db);
    unwrap(service.addItem(S1, PIN_ID, 5));
    // Backdate so any write would visibly bump updated_at.
    db.run("UPDATE carts SET updated_at = '2000-01-01T00:00:00.000Z'");
    db.run("UPDATE cart_items SET updated_at = '2000-01-01T00:00:00.000Z'");
    const snapshot = () => ({
      carts: db.query("SELECT * FROM carts ORDER BY session_id").all(),
      items: db.query("SELECT * FROM cart_items ORDER BY cart_session_id, product_id").all(),
    });
    return { service, snapshot };
  }

  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["string", "2"],
    ["object", { n: 1 }],
  ];

  for (const [label, bad] of cases) {
    for (const op of ["addItem", "setQuantity"] as const) {
      for (const [lineLabel, productId] of [
        ["existing line", PIN_ID],
        ["new line", "prod_canvas-tote-bag"],
      ] as const) {
        test(`${op}(${label}) on ${lineLabel} is INVALID_QUANTITY / NOT_A_NUMBER with no state change`, () => {
          const { service, snapshot } = seeded();
          const before = snapshot();
          const r = service[op](S1, productId, bad as number);
          expect(r.ok).toBe(false);
          expect(!r.ok && r.error).toMatchObject({ code: "INVALID_QUANTITY", details: { reason: "NOT_A_NUMBER" } });
          expect(snapshot()).toEqual(before);
        });
      }
    }
  }

  test("a Symbol quantity (not the private sentinel) is rejected too", () => {
    const { service, snapshot } = seeded();
    const before = snapshot();
    const r = service.addItem(S1, PIN_ID, Symbol("NO_QUANTITY") as unknown as number);
    expect(!r.ok && r.error.code).toBe("INVALID_QUANTITY");
    expect(snapshot()).toEqual(before);
  });
});

describe("nits", () => {
  test("INSUFFICIENT_STOCK message never shows a negative count when the stored line exceeds stock", () => {
    const { db, service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 5));
    db.run("UPDATE products SET stock = 3 WHERE id = 'tote'");
    const r = service.addItem(S1, "tote", 1);
    expect(!r.ok && r.error).toMatchObject({ code: "INSUFFICIENT_STOCK", details: { available: 0, requested: 1 } });
    expect(!r.ok && r.error.message).toBe("Only 0 more of Name tote available");
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])("constructor rejects maxQuantity %p", (max) => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    expect(
      () =>
        new CartService({ db, carts: new SqliteCartRepository(db), products: new SqliteProductRepository(db), maxQuantity: max }),
    ).toThrow(TypeError);
  });

  test("constructor rejects a non-number maxQuantity", () => {
    const db = createDatabase(":memory:");
    const deps = { db, carts: new SqliteCartRepository(db), products: new SqliteProductRepository(db), maxQuantity: "5" as unknown as number };
    expect(() => new CartService(deps)).toThrow(TypeError);
  });
});

describe("money overflow (D-T11-1)", () => {
  test("getCart/getTotals throw CartTotalOverflowError for a price near MAX_SAFE_INTEGER", () => {
    const { db, service } = setup([TOTE]);
    unwrap(service.addItem(S1, "tote", 2));
    db.run("UPDATE products SET price_cents = 9007199254740991 WHERE id = 'tote'");
    expect(() => service.getCart(S1)).toThrow(CartTotalOverflowError);
    let caught: unknown;
    try {
      service.getTotals(S1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CartTotalOverflowError);
    expect(caught instanceof CartTotalOverflowError && caught.code).toBe("MONEY_OVERFLOW");
    expect(caught instanceof Error && caught.message).toStartWith("Cart total could not be computed: ");
  });

  const OVERFLOW = { ok: false, error: { code: "MONEY_OVERFLOW", message: "This cart total is too large to process." } } as const;

  test("addItem/setQuantity whose view overflows return MONEY_OVERFLOW and roll back", () => {
    const { db, service } = setup([TOTE, { id: "big", price: 9007199254740991, stock: 5 }]);
    unwrap(service.addItem(S1, "tote", 1));
    expect(service.addItem(S1, "big", 2)).toEqual(OVERFLOW);
    expect(service.setQuantity(S1, "big", 2)).toEqual(OVERFLOW);
    expect(rows(db)).toEqual([{ s: S1, p: "tote", q: 1 }]);
  });

  test("removeItem on an already-overflowing cart returns MONEY_OVERFLOW and rolls back; clear recovers", () => {
    const { db, service } = setup([TOTE, PIN]);
    unwrap(service.addItem(S1, "tote", 2));
    unwrap(service.addItem(S1, "pin", 1));
    db.run("UPDATE products SET price_cents = 9007199254740991 WHERE id = 'tote'");
    expect(service.removeItem(S1, "pin")).toEqual(OVERFLOW);
    expect(rows(db)).toEqual([
      { s: S1, p: "pin", q: 1 },
      { s: S1, p: "tote", q: 2 },
    ]);
    // Removing the offending line yields a computable view, so it succeeds.
    expect(unwrap(service.removeItem(S1, "tote")).subtotalCents).toBe(50);
    expect(unwrap(service.clear(S1)).items).toEqual([]);
  });
});
