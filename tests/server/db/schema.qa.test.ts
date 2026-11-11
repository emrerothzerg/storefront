/**
 * QA (T07): schema, migrations and DB constraints, adversarial.
 * Criteria 1, 2, 6 (client), 8 (withTransaction).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  closeDatabase,
  createDatabase,
  DEFAULT_DATABASE_PATH,
  getDatabase,
  resolveDatabasePath,
  withTransaction,
} from "@/server/db/client";
import { MIGRATIONS, runMigrations, SCHEMA_VERSION } from "@/server/db/schema";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { count, insertCartItem, insertOrder, insertOrderItem, insertProduct, memoryDb, stockOf } from "./helpers";

const ROOT = join(import.meta.dir, "..", "..", "..");

function schemaDump(db: ReturnType<typeof memoryDb>): string[] {
  return db
    .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all()
    .map((r) => r.sql ?? "");
}

describe("C1 migrations are idempotent", () => {
  test("running migrations 3x applies each version once, keeps schema byte-identical and keeps data", () => {
    const db = createDatabase(":memory:");
    expect(runMigrations(db)).toEqual([1, 2]);
    const before = schemaDump(db);
    insertProduct(db, { id: "p1" });
    insertOrder(db, "o1", "k1");
    expect(runMigrations(db)).toEqual([]);
    expect(runMigrations(db)).toEqual([]);
    expect(schemaDump(db)).toEqual(before);
    expect(count(db, "products")).toBe(1);
    expect(count(db, "orders")).toBe(1);
    const rows = db.query<{ version: number; name: string }, []>("SELECT version, name FROM schema_migrations").all();
    expect(rows).toEqual([
      { version: 1, name: "initial_schema" },
      { version: 2, name: "phase2_catalog_reviews_lists_orders" },
    ]);
    expect(SCHEMA_VERSION).toBe(2);
    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2]);
  });

  test("a second connection to the same in-memory DB is not involved: each :memory: is isolated", () => {
    const a = memoryDb();
    const b = createDatabase(":memory:");
    insertProduct(a, { id: "only-in-a" });
    expect(b.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'products'").get()?.n).toBe(0);
  });

  test("every app table is STRICT and the schema passes integrity and FK checks", () => {
    const db = memoryDb();
    // Every table in sqlite_master except the FTS5 virtual/shadow tables
    // (products_fts*), which SQLite cannot make STRICT. Views are not tables.
    const tables = db
      .query<{ name: string; strict: number }, []>(
        `SELECT name, strict FROM pragma_table_list
          WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'products\\_fts%' ESCAPE '\\'`,
      )
      .all();
    const names = tables.map((t) => t.name).sort();
    const fromMaster = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'products\\_fts%' ESCAPE '\\'`,
      )
      .all()
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(fromMaster);
    // The MVP tables are still there.
    for (const t of ["cart_items", "carts", "order_items", "orders", "products", "schema_migrations"]) expect(names).toContain(t);
    for (const t of tables) expect({ name: t.name, strict: t.strict }).toEqual({ name: t.name, strict: 1 });
    expect(db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("C2 products constraints", () => {
  test("REAL price is rejected by STRICT (19.99, 0.5)", () => {
    const db = memoryDb();
    expect(() => insertProduct(db, { id: "r1", priceCents: 19.99 })).toThrow(/cannot store REAL/i);
    expect(() => insertProduct(db, { id: "r2", priceCents: 0.5 })).toThrow();
    expect(count(db, "products")).toBe(0);
  });

  test("non-numeric TEXT price and REAL stock are rejected", () => {
    const db = memoryDb();
    expect(() => insertProduct(db, { id: "t1", priceCents: "abc" })).toThrow(/cannot store TEXT/i);
    expect(() => insertProduct(db, { id: "t2", stock: 1.5 })).toThrow();
    expect(() =>
      db
        .query("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES ('t3', 't3', 'n', NULL, 'USD', '/x', 1)")
        .run(),
    ).toThrow(/NOT NULL/);
  });

  test("stock = -1 rejected on insert and on update; price_cents = -1 rejected", () => {
    const db = memoryDb();
    expect(() => insertProduct(db, { id: "n1", stock: -1 })).toThrow(/CHECK/);
    expect(() => insertProduct(db, { id: "n2", priceCents: -1 })).toThrow(/CHECK/);
    insertProduct(db, { id: "ok", stock: 0, priceCents: 0 });
    expect(() => db.query("UPDATE products SET stock = -1 WHERE id = 'ok'").run()).toThrow(/CHECK/);
    expect(() => db.query("UPDATE products SET price_cents = price_cents - 1 WHERE id = 'ok'").run()).toThrow(/CHECK/);
    expect(stockOf(db, "ok")).toBe(0);
  });

  test("duplicate slug rejected (different id), duplicate id rejected", () => {
    const db = memoryDb();
    insertProduct(db, { id: "a", slug: "same" });
    expect(() => insertProduct(db, { id: "b", slug: "same" })).toThrow(/UNIQUE constraint failed: products\.slug/);
    expect(() => insertProduct(db, { id: "a", slug: "other" })).toThrow(/UNIQUE constraint failed: products\.id/);
    expect(() => db.query("UPDATE products SET slug = 'same' WHERE id = 'a'").run()).not.toThrow();
    insertProduct(db, { id: "c", slug: "c" });
    expect(() => db.query("UPDATE products SET slug = 'same' WHERE id = 'c'").run()).toThrow(/UNIQUE/);
  });

  test("currency must be exactly 3 characters", () => {
    const db = memoryDb();
    expect(() => insertProduct(db, { id: "c2", currency: "US" })).toThrow(/CHECK/);
    expect(() => insertProduct(db, { id: "c4", currency: "USDX" })).toThrow(/CHECK/);
  });
});

describe("C2 cart_items constraints", () => {
  test("quantity = 0, -1 and 1.5 rejected", () => {
    const db = memoryDb();
    insertProduct(db, { id: "p" });
    db.query("INSERT INTO carts (session_id) VALUES ('s')").run();
    expect(() => insertCartItem(db, "s", "p", 0)).toThrow(/CHECK/);
    expect(() => insertCartItem(db, "s", "p", -1)).toThrow(/CHECK/);
    expect(() => insertCartItem(db, "s", "p", 1.5)).toThrow();
    insertCartItem(db, "s", "p", 1);
    expect(() => db.query("UPDATE cart_items SET quantity = 0").run()).toThrow(/CHECK/);
  });

  test("FK on product_id: unknown product rejected; deleting a product in a cart is blocked", () => {
    const db = memoryDb();
    insertProduct(db, { id: "p" });
    db.query("INSERT INTO carts (session_id) VALUES ('s')").run();
    expect(() => insertCartItem(db, "s", "ghost", 1)).toThrow(/FOREIGN KEY/);
    insertCartItem(db, "s", "p", 2);
    expect(() => db.query("DELETE FROM products WHERE id = 'p'").run()).toThrow(/FOREIGN KEY/);
    expect(() => db.query("UPDATE products SET id = 'p2' WHERE id = 'p'").run()).toThrow(/FOREIGN KEY/);
    expect(count(db, "products")).toBe(1);
  });

  test("ON DELETE CASCADE from carts removes only that cart's items", () => {
    const db = memoryDb();
    insertProduct(db, { id: "p" });
    insertProduct(db, { id: "q" });
    db.query("INSERT INTO carts (session_id) VALUES ('s1'), ('s2')").run();
    insertCartItem(db, "s1", "p", 1);
    insertCartItem(db, "s1", "q", 3);
    insertCartItem(db, "s2", "p", 1);
    db.query("DELETE FROM carts WHERE session_id = 's1'").run();
    expect(db.query<{ s: string }, []>("SELECT cart_session_id AS s FROM cart_items").all()).toEqual([{ s: "s2" }]);
    expect(count(db, "products")).toBe(2);
  });
});

describe("C2 orders / order_items constraints", () => {
  test("order_items snapshot name and unit price survive product rename, reprice and delete", () => {
    const db = memoryDb();
    insertProduct(db, { id: "p", name: "Original", priceCents: 1999 });
    insertOrder(db, "o1", "k1");
    insertOrderItem(db, "o1", "p", "Original", 1999, 2);
    db.query("UPDATE products SET name = 'Renamed', price_cents = 1 WHERE id = 'p'").run();
    expect(db.query("SELECT name, unit_price_cents, quantity FROM order_items").get()).toEqual({
      name: "Original",
      unit_price_cents: 1999,
      quantity: 2,
    });
    db.query("DELETE FROM products WHERE id = 'p'").run();
    expect(db.query("SELECT product_id, name, unit_price_cents FROM order_items").get()).toEqual({
      product_id: "p",
      name: "Original",
      unit_price_cents: 1999,
    });
  });

  test("order_items: quantity 0 / REAL price / negative price rejected; FK to orders enforced", () => {
    const db = memoryDb();
    insertOrder(db, "o1", "k1");
    expect(() => insertOrderItem(db, "o1", "p", "N", 100, 0)).toThrow(/CHECK/);
    expect(() => insertOrderItem(db, "o1", "p", "N", 9.99, 1)).toThrow();
    expect(() => insertOrderItem(db, "o1", "p", "N", -1, 1)).toThrow(/CHECK/);
    expect(() => insertOrderItem(db, "nope", "p", "N", 100, 1)).toThrow(/FOREIGN KEY/);
    expect(() => insertOrderItem(db, "o1", "p", null as unknown as string, 100, 1)).toThrow(/NOT NULL/);
    expect(count(db, "order_items")).toBe(0);
  });

  test("ON DELETE CASCADE from orders removes only that order's items", () => {
    const db = memoryDb();
    insertOrder(db, "o1", "k1");
    insertOrder(db, "o2", "k2");
    insertOrderItem(db, "o1", "a", "A", 1, 1);
    insertOrderItem(db, "o1", "b", "B", 1, 1);
    insertOrderItem(db, "o2", "a", "A", 1, 1);
    db.query("DELETE FROM orders WHERE id = 'o1'").run();
    expect(db.query("SELECT order_id FROM order_items").all()).toEqual([{ order_id: "o2" }]);
  });

  test("idempotency_key is unique", () => {
    const db = memoryDb();
    insertOrder(db, "o1", "same-key");
    expect(() => insertOrder(db, "o2", "same-key")).toThrow(/UNIQUE constraint failed: orders\.idempotency_key/);
    expect(count(db, "orders")).toBe(1);
  });

  test("status CHECK rejects 'pending' (insert and update) and accepts paid / payment_failed", () => {
    const db = memoryDb();
    expect(() => insertOrder(db, "o1", "k1", "pending")).toThrow(/CHECK/);
    expect(() => insertOrder(db, "o1", "k1", "PAID")).toThrow(/CHECK/);
    insertOrder(db, "o2", "k2", "paid");
    insertOrder(db, "o3", "k3", "payment_failed");
    expect(() => db.query("UPDATE orders SET status = 'pending' WHERE id = 'o2'").run()).toThrow(/CHECK/);
  });

  test("negative money on orders rejected", () => {
    const db = memoryDb();
    insertOrder(db, "o1", "k1");
    for (const col of ["subtotal_cents", "shipping_cents", "total_cents"]) {
      expect(() => db.query(`UPDATE orders SET ${col} = -1 WHERE id = 'o1'`).run()).toThrow(/CHECK/);
    }
  });
});

describe("C6 database path", () => {
  test("resolveDatabasePath: unset, empty, whitespace -> default; set -> override", () => {
    expect(DEFAULT_DATABASE_PATH).toBe("./data/storefront.sqlite");
    expect(resolveDatabasePath({})).toBe("./data/storefront.sqlite");
    expect(resolveDatabasePath({ DATABASE_PATH: undefined })).toBe("./data/storefront.sqlite");
    expect(resolveDatabasePath({ DATABASE_PATH: "" })).toBe("./data/storefront.sqlite");
    expect(resolveDatabasePath({ DATABASE_PATH: "   " })).toBe("./data/storefront.sqlite");
    expect(resolveDatabasePath({ DATABASE_PATH: ":memory:" })).toBe(":memory:");
    expect(resolveDatabasePath({ DATABASE_PATH: "/var/db/x.sqlite" })).toBe("/var/db/x.sqlite");
  });

  test("resolveDatabasePath() reads process.env by default (subprocess, DATABASE_PATH unset and set)", () => {
    const script = `import { resolveDatabasePath } from "./src/server/db/client"; console.log(resolveDatabasePath());`;
    const env = { ...process.env };
    delete env.DATABASE_PATH;
    const unset = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, env });
    expect(unset.stdout.toString().trim()).toBe("./data/storefront.sqlite");
    const set = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, env: { ...env, DATABASE_PATH: "/tmp/qa-override.sqlite" } });
    expect(set.stdout.toString().trim()).toBe("/tmp/qa-override.sqlite");
  });

  describe("getDatabase", () => {
    const original = process.env.DATABASE_PATH;
    afterEach(() => {
      closeDatabase();
      if (original === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = original;
    });

    test("with DATABASE_PATH=:memory: is migrated, FK-enforcing, cached, and reopens after close", () => {
      process.env.DATABASE_PATH = ":memory:";
      const db = getDatabase();
      expect(getDatabase()).toBe(db);
      expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(count(db, "products")).toBe(0);
      closeDatabase();
      closeDatabase(); // idempotent
      const again = getDatabase();
      expect(again).not.toBe(db);
      expect(count(again, "products")).toBe(0);
    });
  });
});

describe("C8 withTransaction", () => {
  test("a thrown error restores stock AND removes inserted rows, then rethrows the same error", () => {
    const db = memoryDb();
    insertProduct(db, { id: "p", stock: 3 });
    const repo = new SqliteProductRepository(db);
    const boom = new Error("payment declined");
    let caught: unknown;
    try {
      withTransaction(db, (tx) => {
        expect(repo.decrementStock("p", 2).ok).toBe(true);
        insertOrder(tx, "o1", "k1");
        insertOrderItem(tx, "o1", "p", "Name p", 1000, 2);
        tx.query("INSERT INTO carts (session_id) VALUES ('s')").run();
        expect(stockOf(tx, "p")).toBe(1);
        throw boom;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(boom);
    expect(stockOf(db, "p")).toBe(3);
    expect(count(db, "orders")).toBe(0);
    expect(count(db, "order_items")).toBe(0);
    expect(count(db, "carts")).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  test("a non-Error throw (string) also rolls back", () => {
    const db = memoryDb();
    insertProduct(db, { id: "p", stock: 1 });
    expect(() =>
      withTransaction(db, (tx) => {
        tx.query("UPDATE products SET stock = 0 WHERE id = 'p'").run();
        throw "plain string";
      }),
    ).toThrow();
    expect(stockOf(db, "p")).toBe(1);
  });

  test("nested: inner failure rolls back only the savepoint; outer commits", () => {
    const db = memoryDb();
    insertProduct(db, { id: "p", stock: 5 });
    const repo = new SqliteProductRepository(db);
    withTransaction(db, (tx) => {
      repo.decrementStock("p", 1);
      expect(() =>
        withTransaction(tx, () => {
          repo.decrementStock("p", 2);
          insertOrder(tx, "inner", "k-inner");
          throw new Error("inner");
        }),
      ).toThrow("inner");
      expect(tx.inTransaction).toBe(true);
      expect(stockOf(tx, "p")).toBe(4);
      insertOrder(tx, "outer", "k-outer");
    });
    expect(stockOf(db, "p")).toBe(4);
    expect(db.query("SELECT id FROM orders").all()).toEqual([{ id: "outer" }]);
  });

  test("nested: inner success then outer throw rolls back both levels", () => {
    const db = memoryDb();
    insertProduct(db, { id: "p", stock: 5 });
    expect(() =>
      withTransaction(db, (tx) => {
        withTransaction(tx, (inner) => {
          inner.query("UPDATE products SET stock = 1 WHERE id = 'p'").run();
          insertOrder(inner, "o", "k");
        });
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(stockOf(db, "p")).toBe(5);
    expect(count(db, "orders")).toBe(0);
  });

  test("three levels deep: middle failure discards middle+innermost, keeps outer", () => {
    const db = memoryDb();
    withTransaction(db, (tx) => {
      tx.query("INSERT INTO carts (session_id) VALUES ('L1')").run();
      try {
        withTransaction(tx, () => {
          tx.query("INSERT INTO carts (session_id) VALUES ('L2')").run();
          withTransaction(tx, () => {
            tx.query("INSERT INTO carts (session_id) VALUES ('L3')").run();
          });
          throw new Error("L2 fails");
        });
      } catch {
        /* expected */
      }
    });
    expect(db.query("SELECT session_id FROM carts").all()).toEqual([{ session_id: "L1" }]);
  });

  test("a constraint violation inside rolls back earlier writes in the same transaction", () => {
    const db = memoryDb();
    insertProduct(db, { id: "p", stock: 2 });
    expect(() =>
      withTransaction(db, (tx) => {
        tx.query("UPDATE products SET stock = 1 WHERE id = 'p'").run();
        tx.query("UPDATE products SET stock = -5 WHERE id = 'p'").run();
      }),
    ).toThrow(/CHECK/);
    expect(stockOf(db, "p")).toBe(2);
  });
});
