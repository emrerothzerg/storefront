import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "./client";
import { MIGRATIONS, runMigrations, SCHEMA_VERSION } from "./schema";

function migrated(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}

function insertProduct(db: Database, overrides: Partial<Record<string, string | number>> = {}): void {
  const p = { id: "p1", slug: "p1", name: "P1", price_cents: 100, currency: "USD", image_url: "/x.svg", stock: 5, ...overrides };
  db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(p.id, p.slug, p.name, p.price_cents, p.currency, p.image_url, p.stock);
}

function insertOrder(db: Database, id = "o1", key = "k1"): void {
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
       line1, city, region, postal_code, country, card_last4, idempotency_key)
     VALUES (?, 's1', 'paid', 100, 100, 'USD', 'A', 'a@example.com', 'L1', 'C', 'R', '123', 'US', '4242', ?)`,
  ).run(id, key);
}

describe("runMigrations", () => {
  test("creates all tables and indexes", () => {
    const db = migrated();
    const names = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const t of ["products", "carts", "cart_items", "orders", "order_items", "schema_migrations"]) {
      expect(names).toContain(t);
    }
    expect(names).toContain("idx_orders_session_id");
    expect(names).toContain("idx_cart_items_product_id");
  });

  test("is idempotent: a second run applies nothing and keeps data", () => {
    const db = createDatabase(":memory:");
    expect(runMigrations(db)).toEqual(MIGRATIONS.map((m) => m.version));
    insertProduct(db);
    expect(runMigrations(db)).toEqual([]);
    expect(runMigrations(db)).toEqual([]);
    const versions = db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all();
    expect(versions).toHaveLength(MIGRATIONS.length);
    expect(Math.max(...versions.map((v) => v.version))).toBe(SCHEMA_VERSION);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM products").get()?.n).toBe(1);
  });
});

describe("constraints", () => {
  test("products: stock >= 0, price_cents >= 0, unique slug, integer money", () => {
    const db = migrated();
    insertProduct(db);
    expect(() => insertProduct(db, { id: "p2", slug: "p2", stock: -1 })).toThrow();
    expect(() => insertProduct(db, { id: "p3", slug: "p3", price_cents: -1 })).toThrow();
    expect(() => insertProduct(db, { id: "p4", slug: "p4", price_cents: 19.99 })).toThrow();
    expect(() => insertProduct(db, { id: "p5", slug: "p1" })).toThrow(/UNIQUE/);
    expect(() => db.query("UPDATE products SET stock = stock - 6 WHERE id = 'p1'").run()).toThrow(/CHECK/);
    insertProduct(db, { id: "free", slug: "free", price_cents: 0, stock: 0 });
  });

  test("cart_items: quantity > 0, FKs enforced, cascade on cart delete", () => {
    const db = migrated();
    insertProduct(db);
    db.query("INSERT INTO carts (session_id) VALUES ('s1')").run();
    const add = db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, ?)");
    expect(() => add.run("s1", "p1", 0)).toThrow(/CHECK/);
    expect(() => add.run("s1", "p1", -2)).toThrow(/CHECK/);
    expect(() => add.run("s1", "missing", 1)).toThrow(/FOREIGN KEY/);
    expect(() => add.run("nocart", "p1", 1)).toThrow(/FOREIGN KEY/);
    add.run("s1", "p1", 2);
    expect(() => add.run("s1", "p1", 1)).toThrow(/UNIQUE|PRIMARY/);
    db.query("DELETE FROM carts WHERE session_id = 's1'").run();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cart_items").get()?.n).toBe(0);
  });

  test("orders: status check, unique idempotency_key, shipping defaults to 0", () => {
    const db = migrated();
    insertOrder(db);
    expect(() => insertOrder(db, "o2", "k1")).toThrow(/UNIQUE/);
    expect(() =>
      db.query("UPDATE orders SET status = 'shipped' WHERE id = 'o1'").run(),
    ).toThrow(/CHECK/);
    const row = db.query<{ shipping_cents: number; line2: string | null; created_at: string }, []>(
      "SELECT shipping_cents, line2, created_at FROM orders",
    ).get();
    expect(row?.shipping_cents).toBe(0);
    expect(row?.line2).toBeNull();
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("order_items snapshot name and price, survive product changes, cascade on order delete", () => {
    const db = migrated();
    insertProduct(db);
    insertOrder(db);
    const add = db.query(
      "INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, ?, ?, ?)",
    );
    expect(() => add.run("o1", "p1", "P1", 100, 0)).toThrow(/CHECK/);
    expect(() => add.run("o1", "p1", "P1", -1, 1)).toThrow(/CHECK/);
    expect(() => add.run("missing-order", "p1", "P1", 100, 1)).toThrow(/FOREIGN KEY/);
    add.run("o1", "p1", "P1", 100, 2);
    db.query("UPDATE products SET name = 'Renamed', price_cents = 999 WHERE id = 'p1'").run();
    db.query("DELETE FROM products WHERE id = 'p1'").run(); // no FK from order_items
    expect(
      db.query<{ name: string; unit_price_cents: number }, []>("SELECT name, unit_price_cents FROM order_items").get(),
    ).toEqual({ name: "P1", unit_price_cents: 100 });
    db.query("DELETE FROM orders WHERE id = 'o1'").run();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM order_items").get()?.n).toBe(0);
  });
});
