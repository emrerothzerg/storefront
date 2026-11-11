import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "./client";
import { MIGRATIONS, runMigrations, SCHEMA_VERSION } from "./schema";
import { recomputeProductRating } from "../catalog/product-repository";

const V2_TABLES = [
  "categories", "brands", "reviews", "review_votes", "questions", "answers", "question_votes",
  "answer_votes", "lists", "list_items", "product_views", "coupons", "coupon_redemptions",
  "shipping_methods", "rate_limits", "order_events", "stock_alerts", "contact_messages",
  "addresses", "users", "auth_sessions",
];

function migrated(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}

/** A DB at schema v1 only (as the MVP left it). */
function v1Database(): Database {
  const db = createDatabase(":memory:");
  db.run(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL, name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) STRICT`);
  const v1 = MIGRATIONS.find((m) => m.version === 1);
  if (v1 === undefined) throw new Error("missing v1");
  db.exec(v1.sql);
  db.run("INSERT INTO schema_migrations (version, name) VALUES (1, 'initial_schema')");
  return db;
}

function schemaDump(db: Database): string[] {
  return db
    .query<{ sql: string | null }, []>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name")
    .all()
    .map((r) => r.sql ?? "");
}

function insertProduct(
  db: Database,
  p: { id: string; name?: string; description?: string; price?: number; brandId?: string | null; categoryId?: string | null; bullets?: string },
): void {
  db.query(
    `INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock, brand_id, category_id, bullets)
     VALUES (?, ?, ?, ?, ?, 'USD', '/x.svg', 5, ?, ?, ?)`,
  ).run(p.id, p.id, p.name ?? p.id, p.description ?? "", p.price ?? 1000, p.brandId ?? null, p.categoryId ?? null, p.bullets ?? "[]");
}

function insertOrder(db: Database, id: string): void {
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
       line1, city, region, postal_code, country, card_last4, idempotency_key)
     VALUES (?, 's1', 'paid', 100, 100, 'USD', 'A', 'a@example.com', 'L1', 'C', 'R', '123', 'US', '4242', ?)`,
  ).run(id, `key-${id}`);
}

function seedTaxonomy(db: Database): void {
  db.run("INSERT INTO brands (id, slug, name) VALUES ('b1', 'acme-goods', 'Acmeware')");
  db.run("INSERT INTO categories (id, slug, name) VALUES ('dep', 'kitchen', 'Kitchenalia')");
  db.run("INSERT INTO categories (id, slug, name, parent_id) VALUES ('cat', 'kettles', 'Kettlery', 'dep')");
}

function search(db: Database, match: string): string[] {
  return db
    .query<{ id: string }, [string]>(
      `SELECT p.id FROM products_fts JOIN products AS p ON p.rowid = products_fts.rowid
        WHERE products_fts MATCH ? ORDER BY p.id`,
    )
    .all(match)
    .map((r) => r.id);
}

function ftsIntegrity(db: Database): void {
  db.run("INSERT INTO products_fts (products_fts) VALUES ('integrity-check')");
}

function rating(db: Database, id: string): { rating_count: number; rating_sum: number } | null {
  return db.query<{ rating_count: number; rating_sum: number }, [string]>(
    "SELECT rating_count, rating_sum FROM products WHERE id = ?",
  ).get(id);
}

function addReview(db: Database, id: string, productId: string, session: string, stars: number, status = "published"): void {
  db.query(
    "INSERT INTO reviews (id, product_id, session_id, display_name, rating, status) VALUES (?, ?, ?, 'Ann', ?, ?)",
  ).run(id, productId, session, stars, status);
}

describe("migration v2 applies", () => {
  test("on a fresh DB: versions [1, 2], every v2 table exists and is STRICT", () => {
    const db = createDatabase(":memory:");
    expect(runMigrations(db)).toEqual([1, 2]);
    expect(SCHEMA_VERSION).toBe(2);
    const tables = new Map(
      db.query<{ name: string; strict: number }, []>("SELECT name, strict FROM pragma_table_list WHERE type = 'table'")
        .all()
        .map((t) => [t.name, t.strict]),
    );
    for (const t of V2_TABLES) expect({ t, strict: tables.get(t) }).toEqual({ t, strict: 1 });
    expect(db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("on a v1 DB with rows: products/orders/carts survive with defaults filled and are FTS-indexed", () => {
    const db = v1Database();
    db.run(`INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock)
            VALUES ('old', 'old', 'Walnut Desk', 'Solid timber top', 125000, 'USD', '/x.svg', 3)`);
    insertOrder(db, "o1");
    db.run("INSERT INTO carts (session_id) VALUES ('s1')");
    db.run("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES ('s1', 'old', 2)");
    db.run("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES ('o1', 'old', 'Walnut Desk', 125000, 1)");

    expect(runMigrations(db)).toEqual([2]);

    const p = db.query<Record<string, unknown>, []>("SELECT * FROM products WHERE id = 'old'").get();
    expect(p).toMatchObject({
      name: "Walnut Desk", price_cents: 125000, stock: 3, brand_id: null, category_id: null,
      list_price_cents: null, sku: null, bullets: "[]", specs: "[]", images: "[]",
      rating_count: 0, rating_sum: 0, is_featured: 0,
    });
    expect(p?.published_at).toBe(p?.created_at);
    expect(db.query("SELECT fulfillment_status, discount_cents, coupon_code, delivery_note FROM orders").get()).toEqual({
      fulfillment_status: "processing", discount_cents: 0, coupon_code: null, delivery_note: null,
    });
    expect(db.query("SELECT coupon_code, shipping_method_id FROM carts").get()).toEqual({ coupon_code: null, shipping_method_id: null });
    expect(db.query("SELECT product_slug, image_url, quantity FROM order_items").get()).toEqual({ product_slug: null, image_url: null, quantity: 1 });
    expect(db.query("SELECT quantity FROM cart_items").get()).toEqual({ quantity: 2 });
    expect(search(db, "timber")).toEqual(["old"]);
    ftsIntegrity(db);
  });

  test("re-running is a no-op and the schema stays byte-identical", () => {
    const db = migrated();
    const before = schemaDump(db);
    expect(runMigrations(db)).toEqual([]);
    expect(runMigrations(db)).toEqual([]);
    expect(schemaDump(db)).toEqual(before);
  });

  test("a failing v2 rolls back atomically (v1 data intact, version not recorded)", () => {
    const db = v1Database();
    // Pre-create a conflicting object so the ALTER TABLE in v2 fails part-way.
    db.run("ALTER TABLE orders ADD COLUMN phone TEXT");
    db.run(`INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES ('k', 'k', 'K', 1, 'USD', '/x', 1)`);
    expect(() => runMigrations(db)).toThrow(/duplicate column/);
    expect(db.query("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'categories'").get()).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 1 });
  });
});

describe("products v2 columns", () => {
  test("published_at defaults to created_at, an explicit value is kept", () => {
    const db = migrated();
    insertProduct(db, { id: "a" });
    db.run(`INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at)
            VALUES ('b', 'b', 'B', 1, 'USD', '/x', 1, '2026-01-01T09:00:00.000Z')`);
    const rows = db.query<{ id: string; published_at: string; created_at: string }, []>(
      "SELECT id, published_at, created_at FROM products ORDER BY id",
    ).all();
    expect(rows[0]?.published_at).toBe(rows[0]?.created_at ?? "missing");
    expect(rows[1]?.published_at).toBe("2026-01-01T09:00:00.000Z");
  });

  test("list_price_cents must be NULL or >= price_cents; is_featured is 0/1; ratings non-negative", () => {
    const db = migrated();
    insertProduct(db, { id: "a", price: 1000 });
    db.run("UPDATE products SET list_price_cents = 1000 WHERE id = 'a'");
    db.run("UPDATE products SET list_price_cents = 1500 WHERE id = 'a'");
    expect(() => db.run("UPDATE products SET list_price_cents = 999 WHERE id = 'a'")).toThrow(/CHECK/);
    expect(() => db.run("UPDATE products SET price_cents = 2000 WHERE id = 'a'")).toThrow(/CHECK/);
    db.run("UPDATE products SET price_cents = 2000, list_price_cents = NULL WHERE id = 'a'");
    expect(() => db.run("UPDATE products SET is_featured = 2 WHERE id = 'a'")).toThrow(/CHECK/);
    expect(() => db.run("UPDATE products SET rating_count = -1 WHERE id = 'a'")).toThrow(/CHECK/);
  });

  test("brand_id and category_id are foreign keys", () => {
    const db = migrated();
    expect(() => insertProduct(db, { id: "x", brandId: "nope" })).toThrow(/FOREIGN KEY/);
    expect(() => insertProduct(db, { id: "y", categoryId: "nope" })).toThrow(/FOREIGN KEY/);
    seedTaxonomy(db);
    insertProduct(db, { id: "z", brandId: "b1", categoryId: "cat" });
    expect(() => db.run("DELETE FROM brands WHERE id = 'b1'")).toThrow(/FOREIGN KEY/);
  });
});

describe("categories", () => {
  test("at most two levels; no self-parent; slug unique", () => {
    const db = migrated();
    seedTaxonomy(db);
    expect(() => db.run("INSERT INTO categories (id, slug, name, parent_id) VALUES ('deep', 'deep', 'Deep', 'cat')")).toThrow(/maximum depth/);
    expect(() => db.run("UPDATE categories SET parent_id = 'cat' WHERE id = 'dep'")).toThrow(/maximum depth|CHECK/);
    db.run("INSERT INTO categories (id, slug, name) VALUES ('dep2', 'garden', 'Garden')");
    expect(() => db.run("UPDATE categories SET parent_id = 'dep2' WHERE id = 'dep'")).toThrow(/maximum depth/);
    db.run("UPDATE categories SET parent_id = 'dep2' WHERE id = 'cat'");
    expect(() => db.run("UPDATE categories SET parent_id = id WHERE id = 'dep2'")).toThrow(/CHECK|maximum depth/);
    expect(() => db.run("INSERT INTO categories (id, slug, name) VALUES ('dup', 'garden', 'Dup')")).toThrow(/UNIQUE/);
  });
});

describe("products_fts", () => {
  test("finds name, description, bullets, brand, category and department terms, with porter stemming and prefixes", () => {
    const db = migrated();
    seedTaxonomy(db);
    insertProduct(db, { id: "k1", name: "Gooseneck Kettle", description: "Pours precisely", brandId: "b1", categoryId: "cat", bullets: JSON.stringify(["Holds temperature for an hour"]) });
    insertProduct(db, { id: "k2", name: "Teapot", description: "Glass teapot with infuser" });
    expect(search(db, "gooseneck")).toEqual(["k1"]);
    expect(search(db, "pour")).toEqual(["k1"]); // porter: pours -> pour
    expect(search(db, "temperature")).toEqual(["k1"]);
    expect(search(db, "acmeware")).toEqual(["k1"]);
    expect(search(db, "kettlery")).toEqual(["k1"]);
    expect(search(db, "kitchenalia")).toEqual(["k1"]);
    expect(search(db, "goos*")).toEqual(["k1"]);
    expect(search(db, "te*")).toEqual(["k1", "k2"]);
    expect(search(db, "brand_name:acmeware")).toEqual(["k1"]);
    expect(search(db, "name:infuser")).toEqual([]);
    ftsIntegrity(db);
  });

  test("column order is name, brand_name, category_name, description, bullets, department_name", () => {
    const db = migrated();
    const cols = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('products_fts')").all().map((c) => c.name);
    expect(cols).toEqual(["name", "brand_name", "category_name", "description", "bullets", "department_name"]);
  });

  test("stays in sync after product UPDATE and DELETE", () => {
    const db = migrated();
    insertProduct(db, { id: "a", name: "Walnut Desk" });
    insertProduct(db, { id: "b", name: "Oak Shelf" });
    db.run("UPDATE products SET name = 'Maple Desk' WHERE id = 'a'");
    expect(search(db, "walnut")).toEqual([]);
    expect(search(db, "maple")).toEqual(["a"]);
    db.run("UPDATE products SET stock = 0, price_cents = 5 WHERE id = 'a'"); // not an indexed column
    expect(search(db, "maple")).toEqual(["a"]);
    db.run("DELETE FROM products WHERE id = 'a'");
    expect(search(db, "maple")).toEqual([]);
    expect(search(db, "desk")).toEqual([]);
    expect(search(db, "oak")).toEqual(["b"]);
    ftsIntegrity(db);
  });

  test("brand and category renames and product moves are re-indexed", () => {
    const db = migrated();
    seedTaxonomy(db);
    insertProduct(db, { id: "k1", name: "Kettle", brandId: "b1", categoryId: "cat" });
    db.run("UPDATE brands SET name = 'Zenithware' WHERE id = 'b1'");
    expect(search(db, "acmeware")).toEqual([]);
    expect(search(db, "zenithware")).toEqual(["k1"]);
    db.run("UPDATE categories SET name = 'Boilers' WHERE id = 'cat'");
    expect(search(db, "kettlery")).toEqual([]);
    expect(search(db, "boilers")).toEqual(["k1"]);
    db.run("UPDATE categories SET name = 'Cookshop' WHERE id = 'dep'");
    expect(search(db, "kitchenalia")).toEqual([]);
    expect(search(db, "cookshop")).toEqual(["k1"]);
    db.run("UPDATE products SET brand_id = NULL, category_id = NULL WHERE id = 'k1'");
    expect(search(db, "zenithware OR boilers OR cookshop")).toEqual([]);
    ftsIntegrity(db);
  });

  test("malformed bullets JSON is accepted and indexed as empty", () => {
    const db = migrated();
    insertProduct(db, { id: "m", name: "Mug", bullets: "{not json zebra" });
    expect(search(db, "mug")).toEqual(["m"]);
    expect(search(db, "zebra")).toEqual([]);
    db.run(`UPDATE products SET bullets = '["zebra stripes"]' WHERE id = 'm'`);
    expect(search(db, "zebra")).toEqual(["m"]);
    ftsIntegrity(db);
  });

  test("hostile MATCH input is a bound parameter: syntax errors throw, nothing is executed", () => {
    const db = migrated();
    insertProduct(db, { id: "a", name: "Desk" });
    expect(() => search(db, `"unterminated`)).toThrow();
    expect(search(db, `"'; DROP TABLE products; --"`)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 1 });
  });

  test("products_fts_vocab lists indexed terms for suggestions", () => {
    const db = migrated();
    insertProduct(db, { id: "h", name: "Headphones", description: "Headlamp" });
    const terms = db.query<{ term: string }, []>("SELECT term FROM products_fts_vocab WHERE term LIKE 'head%' ORDER BY term").all().map((r) => r.term);
    expect(terms).toEqual(["headlamp", "headphon"]);
  });
});

describe("review rating triggers (published reviews only)", () => {
  test("insert, rating change, status change, product move and delete keep rating_count/rating_sum exact", () => {
    const db = migrated();
    insertProduct(db, { id: "p" });
    insertProduct(db, { id: "q" });
    addReview(db, "r1", "p", "s1", 5);
    addReview(db, "r2", "p", "s2", 3);
    addReview(db, "r3", "p", "s3", 1, "hidden");
    expect(rating(db, "p")).toEqual({ rating_count: 2, rating_sum: 8 });
    db.run("UPDATE reviews SET rating = 4 WHERE id = 'r2'");
    expect(rating(db, "p")).toEqual({ rating_count: 2, rating_sum: 9 });
    db.run("UPDATE reviews SET status = 'hidden' WHERE id = 'r1'");
    expect(rating(db, "p")).toEqual({ rating_count: 1, rating_sum: 4 });
    db.run("UPDATE reviews SET status = 'published' WHERE id = 'r3'");
    expect(rating(db, "p")).toEqual({ rating_count: 2, rating_sum: 5 });
    db.run("UPDATE reviews SET title = 'edited', body = 'x' WHERE id = 'r3'"); // non-rating edit
    expect(rating(db, "p")).toEqual({ rating_count: 2, rating_sum: 5 });
    db.run("UPDATE reviews SET product_id = 'q' WHERE id = 'r2'");
    expect(rating(db, "p")).toEqual({ rating_count: 1, rating_sum: 1 });
    expect(rating(db, "q")).toEqual({ rating_count: 1, rating_sum: 4 });
    db.run("DELETE FROM reviews WHERE id = 'r1'"); // hidden: no change
    db.run("DELETE FROM reviews WHERE id = 'r3'");
    expect(rating(db, "p")).toEqual({ rating_count: 0, rating_sum: 0 });
    db.run("UPDATE reviews SET status = 'hidden', rating = 2 WHERE id = 'r2'");
    expect(rating(db, "q")).toEqual({ rating_count: 0, rating_sum: 0 });
  });

  test("ON CONFLICT upsert of a review adjusts the aggregate by the delta", () => {
    const db = migrated();
    insertProduct(db, { id: "p" });
    const upsert = db.query(
      `INSERT INTO reviews (id, product_id, session_id, display_name, rating) VALUES ('r', 'p', 's', 'A', ?)
       ON CONFLICT (product_id, session_id) DO UPDATE SET rating = excluded.rating`,
    );
    upsert.run(2);
    upsert.run(5);
    upsert.run(5);
    expect(rating(db, "p")).toEqual({ rating_count: 1, rating_sum: 5 });
  });

  test("constraints: rating 1..5, one review per (product, session), status values, product FK, cascade", () => {
    const db = migrated();
    insertProduct(db, { id: "p" });
    expect(() => addReview(db, "r0", "p", "s", 0)).toThrow(/CHECK/);
    expect(() => addReview(db, "r6", "p", "s", 6)).toThrow(/CHECK/);
    expect(() => addReview(db, "rx", "p", "s", 3, "pending")).toThrow(/CHECK/);
    expect(() => addReview(db, "rf", "missing", "s", 3)).toThrow(/FOREIGN KEY/);
    addReview(db, "r1", "p", "s", 3);
    expect(() => addReview(db, "r2", "p", "s", 4)).toThrow(/UNIQUE/);
    db.run("INSERT INTO review_votes (review_id, session_id) VALUES ('r1', 'v')");
    db.run("DELETE FROM products WHERE id = 'p'");
    expect(db.query("SELECT COUNT(*) AS n FROM reviews").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM review_votes").get()).toEqual({ n: 0 });
  });

  test("recomputeProductRating heals drift and returns null for unknown products", () => {
    const db = migrated();
    insertProduct(db, { id: "p" });
    addReview(db, "r1", "p", "s1", 4);
    addReview(db, "r2", "p", "s2", 2, "hidden");
    db.run("UPDATE products SET rating_count = 9, rating_sum = 40 WHERE id = 'p'");
    expect(recomputeProductRating(db, "p")).toEqual({ ratingCount: 1, ratingSum: 4 });
    expect(rating(db, "p")).toEqual({ rating_count: 1, rating_sum: 4 });
    expect(recomputeProductRating(db, "nope")).toBeNull();
  });
});

describe("helpful-vote triggers", () => {
  test("review, question and answer votes keep helpful_count; one vote per session", () => {
    const db = migrated();
    insertProduct(db, { id: "p" });
    addReview(db, "r", "p", "author", 5);
    db.run("INSERT INTO questions (id, product_id, session_id, display_name, body) VALUES ('q', 'p', 's', 'Q', 'Does it fit?')");
    db.run("INSERT INTO answers (id, question_id, session_id, display_name, body, is_store) VALUES ('a', 'q', 's', 'Store', 'Yes', 1)");
    const cases = [
      { table: "review_votes", col: "review_id", target: "reviews", id: "r" },
      { table: "question_votes", col: "question_id", target: "questions", id: "q" },
      { table: "answer_votes", col: "answer_id", target: "answers", id: "a" },
    ] as const;
    for (const c of cases) {
      const helpful = () => db.query<{ helpful_count: number }, [string]>(`SELECT helpful_count FROM ${c.target} WHERE id = ?`).get(c.id)?.helpful_count;
      const vote = db.query(`INSERT INTO ${c.table} (${c.col}, session_id) VALUES (?, ?)`);
      vote.run(c.id, "v1");
      vote.run(c.id, "v2");
      expect(helpful()).toBe(2);
      expect(() => vote.run(c.id, "v1")).toThrow(/UNIQUE|PRIMARY/);
      expect(helpful()).toBe(2);
      db.query(`DELETE FROM ${c.table} WHERE ${c.col} = ? AND session_id = 'v1'`).run(c.id);
      expect(helpful()).toBe(1);
      expect(() => vote.run("missing", "v9")).toThrow(/FOREIGN KEY/);
    }
    expect(() => db.run("UPDATE answers SET is_store = 2 WHERE id = 'a'")).toThrow(/CHECK/);
    expect(() => db.run("UPDATE questions SET status = 'deleted' WHERE id = 'q'")).toThrow(/CHECK/);
    db.run("DELETE FROM questions WHERE id = 'q'");
    expect(db.query("SELECT COUNT(*) AS n FROM answers").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM answer_votes").get()).toEqual({ n: 0 });
  });
});

describe("lists", () => {
  test("one save_for_later list per session; kinds checked; items constrained and cascaded", () => {
    const db = migrated();
    insertProduct(db, { id: "p" });
    const addList = db.query("INSERT INTO lists (id, session_id, name, kind, is_default) VALUES (?, ?, ?, ?, ?)");
    addList.run("sfl", "s1", "Saved for later", "save_for_later", 0);
    expect(() => addList.run("sfl2", "s1", "Again", "save_for_later", 0)).toThrow(/UNIQUE/);
    addList.run("sfl3", "s2", "Saved for later", "save_for_later", 0);
    addList.run("w1", "s1", "Wish list", "wishlist", 1);
    addList.run("w2", "s1", "Birthday", "wishlist", 0);
    expect(() => addList.run("bad", "s1", "x", "cart", 0)).toThrow(/CHECK/);
    expect(() => addList.run("bad2", "s1", "", "wishlist", 0)).toThrow(/CHECK/);
    // Race-safe lazy creation of the save-for-later list.
    db.run(`INSERT INTO lists (id, session_id, name, kind) VALUES ('other', 's1', 'S', 'save_for_later')
            ON CONFLICT (session_id) WHERE kind = 'save_for_later' DO NOTHING`);
    expect(db.query("SELECT COUNT(*) AS n FROM lists WHERE session_id = 's1'").get()).toEqual({ n: 3 });

    const addItem = db.query("INSERT INTO list_items (list_id, product_id, quantity_desired, priority, price_at_add_cents) VALUES (?, ?, ?, ?, ?)");
    addItem.run("w1", "p", 1, 2, 1000);
    expect(() => addItem.run("w2", "p", 0, 0, 1000)).toThrow(/CHECK/);
    expect(() => addItem.run("w2", "p", 1, 3, 1000)).toThrow(/CHECK/);
    expect(() => addItem.run("w2", "p", 1, 0, -1)).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO list_items (list_id, product_id) VALUES ('w2', 'p')")).toThrow(/NOT NULL/);
    expect(() => addItem.run("w1", "p", 1, 0, 1000)).toThrow(/UNIQUE|PRIMARY/);
    expect(() => addItem.run("nolist", "p", 1, 0, 1000)).toThrow(/FOREIGN KEY/);
    addItem.run("w2", "p", 3, 0, 900);
    db.run("DELETE FROM lists WHERE id = 'w1'");
    expect(db.query("SELECT COUNT(*) AS n FROM list_items").get()).toEqual({ n: 1 });
    db.run("DELETE FROM products WHERE id = 'p'");
    expect(db.query("SELECT COUNT(*) AS n FROM list_items").get()).toEqual({ n: 0 });
    expect(() => db.run("INSERT INTO lists (id, session_id, name, kind, share_token) VALUES ('t1', 's', 'a', 'wishlist', 'tok'), ('t2', 's', 'b', 'wishlist', 'tok')")).toThrow(/UNIQUE/);
  });
});

describe("product_views, stock_alerts, contact_messages, addresses", () => {
  test("product_views: one row per (session, product), upsert bumps viewed_at", () => {
    const db = migrated();
    insertProduct(db, { id: "p" });
    const view = db.query(
      `INSERT INTO product_views (session_id, product_id, viewed_at) VALUES ('s', 'p', ?)
       ON CONFLICT (session_id, product_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
    );
    view.run("2026-11-01T00:00:00.000Z");
    view.run("2026-11-02T00:00:00.000Z");
    expect(db.query("SELECT session_id, product_id, viewed_at FROM product_views").all()).toEqual([
      { session_id: "s", product_id: "p", viewed_at: "2026-11-02T00:00:00.000Z" },
    ]);
    expect(() => db.run("INSERT INTO product_views (session_id, product_id) VALUES ('s', 'missing')")).toThrow(/FOREIGN KEY/);
  });

  test("stock_alerts: no email column, one per (product, session)", () => {
    const db = migrated();
    insertProduct(db, { id: "p" });
    const cols = db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('stock_alerts')").all().map((c) => c.name);
    expect(cols).toEqual(["id", "product_id", "session_id", "created_at", "acknowledged_at"]);
    db.run("INSERT INTO stock_alerts (id, product_id, session_id) VALUES ('a1', 'p', 's')");
    expect(() => db.run("INSERT INTO stock_alerts (id, product_id, session_id) VALUES ('a2', 'p', 's')")).toThrow(/UNIQUE/);
  });

  test("contact_messages: unique reference, required topic and message", () => {
    const db = migrated();
    const add = db.query("INSERT INTO contact_messages (id, reference, name, email, topic, message) VALUES (?, ?, 'Ann', 'ann@example.com', ?, ?)");
    add.run("c1", "CM-7F3K2Q", "order", "Where is my parcel?");
    expect(() => add.run("c2", "CM-7F3K2Q", "order", "Again")).toThrow(/UNIQUE/);
    expect(() => add.run("c3", "CM-AAAAAA", "", "x")).toThrow(/CHECK/);
    expect(() => add.run("c4", "CM-BBBBBB", "other", "")).toThrow(/CHECK/);
  });

  test("addresses: label defaults to '', is_default is 0/1", () => {
    const db = migrated();
    db.run(`INSERT INTO addresses (id, session_id, full_name, line1, city, region, postal_code, country)
            VALUES ('ad', 's', 'Ann', '1 Way', 'Town', 'R', '123', 'US')`);
    expect(db.query("SELECT label, is_default, phone FROM addresses").get()).toEqual({ label: "", is_default: 0, phone: null });
    expect(() => db.run("UPDATE addresses SET is_default = 2")).toThrow(/CHECK/);
  });
});

describe("coupons and shipping", () => {
  test("coupon CHECKs: upper-case code, value per kind, used_count <= max_uses, promoted 0/1", () => {
    const db = migrated();
    const add = db.query("INSERT INTO coupons (code, kind, value, max_uses, used_count) VALUES (?, ?, ?, ?, ?)");
    add.run("TEN", "percent", 10, null, 0);
    expect(() => add.run("lower", "percent", 10, null, 0)).toThrow(/CHECK/);
    expect(() => add.run("P0", "percent", 0, null, 0)).toThrow(/CHECK/);
    expect(() => add.run("P101", "percent", 101, null, 0)).toThrow(/CHECK/);
    expect(() => add.run("F0", "fixed", 0, null, 0)).toThrow(/CHECK/);
    expect(() => add.run("FS", "free_shipping", 5, null, 0)).toThrow(/CHECK/);
    expect(() => add.run("BOGO", "bogo", 1, null, 0)).toThrow(/CHECK/);
    add.run("ONE", "fixed", 500, 1, 0);
    // Race-safe redemption: the guarded UPDATE succeeds once, then matches nothing.
    const redeem = db.query("UPDATE coupons SET used_count = used_count + 1 WHERE code = 'ONE' AND (max_uses IS NULL OR used_count < max_uses)");
    expect(redeem.run().changes).toBe(1);
    expect(redeem.run().changes).toBe(0);
    expect(() => db.run("UPDATE coupons SET used_count = 2 WHERE code = 'ONE'")).toThrow(/CHECK/);
    expect(() => db.run("UPDATE coupons SET promoted = 2 WHERE code = 'TEN'")).toThrow(/CHECK/);
  });

  test("coupon_redemptions: one per (coupon, session), coupon FK", () => {
    const db = migrated();
    db.run("INSERT INTO coupons (code, kind, value) VALUES ('TEN', 'percent', 10)");
    const add = db.query("INSERT INTO coupon_redemptions (coupon_code, session_id, order_id) VALUES (?, ?, ?)");
    add.run("TEN", "s1", null);
    expect(() => add.run("TEN", "s1", "o2")).toThrow(/UNIQUE|PRIMARY/);
    add.run("TEN", "s2", "o3");
    expect(() => add.run("NOPE", "s1", null)).toThrow(/FOREIGN KEY/);
  });

  test("shipping_methods: max_days >= min_days, price >= 0", () => {
    const db = migrated();
    const add = db.query("INSERT INTO shipping_methods (id, name, price_cents, min_days, max_days) VALUES (?, 'X', ?, ?, ?)");
    add.run("ok", 499, 5, 8);
    expect(() => add.run("bad1", 499, 5, 4)).toThrow(/CHECK/);
    expect(() => add.run("bad2", -1, 1, 1)).toThrow(/CHECK/);
  });

  test("rate_limits has exactly (key, window_start, count) with a composite PK", () => {
    const db = migrated();
    const cols = db.query<{ name: string; pk: number }, []>("SELECT name, pk FROM pragma_table_info('rate_limits')").all();
    expect(cols).toEqual([{ name: "key", pk: 1 }, { name: "window_start", pk: 2 }, { name: "count", pk: 0 }]);
    const hit = db.query(
      `INSERT INTO rate_limits (key, window_start, count) VALUES ('k', 100, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count`,
    );
    expect(hit.get()).toEqual({ count: 1 });
    expect(hit.get()).toEqual({ count: 2 });
    expect(() => db.run("INSERT INTO rate_limits (key, window_start) VALUES ('k', 1.5)")).toThrow();
  });
});

describe("orders lifecycle", () => {
  test("fulfillment_status allows the six statuses only (no 'pending'); events unique per status and cascade", () => {
    const db = migrated();
    insertOrder(db, "o1");
    for (const s of ["packed", "shipped", "out_for_delivery", "delivered", "cancelled", "processing"]) {
      db.query("UPDATE orders SET fulfillment_status = ? WHERE id = 'o1'").run(s);
    }
    expect(() => db.run("UPDATE orders SET fulfillment_status = 'pending' WHERE id = 'o1'")).toThrow(/CHECK/);
    expect(() => db.run("UPDATE orders SET discount_cents = -1 WHERE id = 'o1'")).toThrow(/CHECK/);
    expect(() => db.run("UPDATE orders SET status = 'shipped' WHERE id = 'o1'")).toThrow(/CHECK/); // payment status unchanged
    const event = db.query("INSERT INTO order_events (order_id, status, note) VALUES ('o1', ?, ?)");
    event.run("processing", null);
    event.run("shipped", "Left the warehouse");
    expect(() => event.run("shipped", "again")).toThrow(/UNIQUE/);
    expect(() => event.run("pending", null)).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO order_events (order_id, status) VALUES ('nope', 'packed')")).toThrow(/FOREIGN KEY/);
    const row = db.query<{ at: string }, []>("SELECT at FROM order_events LIMIT 1").get();
    expect(row?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    db.run("DELETE FROM orders WHERE id = 'o1'");
    expect(db.query("SELECT COUNT(*) AS n FROM order_events").get()).toEqual({ n: 0 });
  });
});

describe("users and auth_sessions", () => {
  test("email and owner_key unique; sessions cascade with the user; token_hash unique", () => {
    const db = migrated();
    const addUser = db.query("INSERT INTO users (id, email, password_hash, display_name, owner_key) VALUES (?, ?, 'h', 'Ann', ?)");
    addUser.run("u1", "ann@example.com", "11111111-1111-4111-8111-111111111111");
    expect(() => addUser.run("u2", "ann@example.com", "22222222-2222-4222-8222-222222222222")).toThrow(/UNIQUE/);
    expect(() => addUser.run("u3", "bob@example.com", "11111111-1111-4111-8111-111111111111")).toThrow(/UNIQUE/);
    expect(db.query("SELECT failed_login_count, locked_until, last_login_at FROM users").get()).toEqual({
      failed_login_count: 0, locked_until: null, last_login_at: null,
    });
    const addSession = db.query("INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, last_seen_at) VALUES (?, ?, ?, '2027-01-01T00:00:00.000Z', '2026-11-07T00:00:00.000Z')");
    addSession.run("as1", "u1", "hash1");
    expect(() => addSession.run("as2", "u1", "hash1")).toThrow(/UNIQUE/);
    expect(() => addSession.run("as3", "nouser", "hash3")).toThrow(/FOREIGN KEY/);
    db.run("DELETE FROM users WHERE id = 'u1'");
    expect(db.query("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });
  });
});
