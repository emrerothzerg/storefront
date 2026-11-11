/**
 * QA (QA-W0-A / P2-A): schema migration 2, FTS5, triggers and constraints.
 * Criteria 1 (migration), 2 (FTS5), 3 (triggers/CHECKs). Every DB is :memory:.
 */
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "@/server/db/client";
import { MIGRATIONS, runMigrations, SCHEMA_VERSION } from "@/server/db/schema";
import { recomputeProductRating } from "@/server/catalog/product-repository";

function migrated(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return db;
}

/** Same DDL runMigrations creates, then ONLY MIGRATIONS[0] (v1) recorded. */
function v1Db(): Database {
  const db = createDatabase(":memory:");
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY NOT NULL,
  name        TEXT    NOT NULL,
  applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT`);
  const v1 = MIGRATIONS[0];
  if (v1 === undefined || v1.version !== 1) throw new Error("MIGRATIONS[0] is not v1");
  db.exec(v1.sql);
  db.query("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(v1.version, v1.name);
  return db;
}

function addProduct(
  db: Database,
  id: string,
  o: { name?: string; description?: string; brand?: string | null; category?: string | null; bullets?: string; price?: number; createdAt?: string } = {},
): void {
  db.query(
    `INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock, brand_id, category_id, bullets)
     VALUES (?, ?, ?, ?, ?, 'USD', '/images/products/x.svg', 5, ?, ?, ?)`,
  ).run(id, id, o.name ?? `Item ${id}`, o.description ?? "", o.price ?? 1000, o.brand ?? null, o.category ?? null, o.bullets ?? "[]");
}

function hits(db: Database, match: string): string[] {
  return db
    .query<{ id: string }, [string]>(
      "SELECT p.id FROM products_fts JOIN products AS p ON p.rowid = products_fts.rowid WHERE products_fts MATCH ? ORDER BY p.id",
    )
    .all(match)
    .map((r) => r.id);
}

/** Throws (SQLITE_CORRUPT_VTAB) if the external-content index disagrees with products_search. */
function ftsIntegrity(db: Database): void {
  db.run("INSERT INTO products_fts (products_fts, rank) VALUES ('integrity-check', 1)");
}

/**
 * The crash-free way to pass arbitrary user text to MATCH: replace control
 * characters (a NUL truncates the C string inside FTS5 -> "unterminated
 * string") with spaces, split on whitespace, wrap each token in double quotes
 * (doubling embedded quotes), optionally append * for prefix. Every token becomes a string literal, so
 * FTS operators, column filters, '-', ':', '^', '(' etc. are inert.
 */
function quoteForMatch(raw: string, prefix = false): string | null {
  const tokens = raw.replace(/[\u0000-\u001f\u007f]/g, " ").split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"${prefix ? "*" : ""}`).join(" ");
}

function taxonomy(db: Database): void {
  db.run("INSERT INTO brands (id, slug, name) VALUES ('b1', 'quorra', 'Quorra'), ('b2', 'zephyr', 'Zephyrine')");
  db.run("INSERT INTO categories (id, slug, name) VALUES ('d1', 'electro', 'Electronics'), ('d2', 'outdoor', 'Outdoors')");
  db.run("INSERT INTO categories (id, slug, name, parent_id) VALUES ('c1', 'audio', 'Audiophile', 'd1'), ('c2', 'camp', 'Campcraft', 'd2')");
}

function aggregates(db: Database): { id: string; rc: number; rs: number; ec: number; es: number }[] {
  return db
    .query<{ id: string; rc: number; rs: number; ec: number; es: number }, []>(
      `SELECT p.id, p.rating_count AS rc, p.rating_sum AS rs,
              (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published') AS ec,
              (SELECT coalesce(SUM(rating), 0) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published') AS es
         FROM products p ORDER BY p.id`,
    )
    .all();
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
describe("QA-A C1 migration 2", () => {
  test("fresh DB: applies [1, 2], SCHEMA_VERSION 2, integrity ok, FK check empty", () => {
    const db = createDatabase(":memory:");
    expect(runMigrations(db)).toEqual([1, 2]);
    expect(SCHEMA_VERSION).toBe(2);
    expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("every non-FTS table is STRICT (pragma table_list)", () => {
    const db = migrated();
    const rows = db
      .query<{ name: string; type: string; strict: number }, []>(
        "SELECT name, type, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    const nonStrict = rows.filter((r) => r.strict !== 1 && !r.name.startsWith("products_fts")).map((r) => r.name);
    expect(nonStrict).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(27);
  });

  test("v1 DB with products/carts/orders: rows survive, defaults filled, published_at backfilled, FTS indexed", () => {
    const db = v1Db();
    db.run(`INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock, created_at)
            VALUES ('p1', 'p1', 'Wireless Lantern', 'Bright camping light', 1500, 'USD', '/a.svg', 7, '2026-01-02T03:04:05.000Z'),
                   ('p2', 'p2', 'Plain Mug', '', 900, 'USD', '/b.svg', 0, '2026-02-03T04:05:06.000Z')`);
    db.run("INSERT INTO carts (session_id) VALUES ('s1')");
    db.run("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES ('s1', 'p1', 2)");
    db.run(`INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
              line1, city, region, postal_code, country, card_last4, idempotency_key)
            VALUES ('o1', 's1', 'paid', 1500, 1500, 'USD', 'Test Person', 't@example.com', 'L1', 'C', 'R', '1', 'US', '4242', 'k1')`);
    db.run("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES ('o1', 'p1', 'Wireless Lantern', 1500, 1)");

    expect(runMigrations(db)).toEqual([2]);

    const p = db
      .query<Record<string, unknown>, []>(
        "SELECT id, price_cents, stock, bullets, specs, images, rating_count, rating_sum, is_featured, published_at, created_at, list_price_cents, brand_id, category_id FROM products ORDER BY id",
      )
      .all();
    expect(p).toEqual([
      { id: "p1", price_cents: 1500, stock: 7, bullets: "[]", specs: "[]", images: "[]", rating_count: 0, rating_sum: 0, is_featured: 0, published_at: "2026-01-02T03:04:05.000Z", created_at: "2026-01-02T03:04:05.000Z", list_price_cents: null, brand_id: null, category_id: null },
      { id: "p2", price_cents: 900, stock: 0, bullets: "[]", specs: "[]", images: "[]", rating_count: 0, rating_sum: 0, is_featured: 0, published_at: "2026-02-03T04:05:06.000Z", created_at: "2026-02-03T04:05:06.000Z", list_price_cents: null, brand_id: null, category_id: null },
    ]);
    expect(db.query("SELECT fulfillment_status, discount_cents, coupon_code FROM orders").all()).toEqual([
      { fulfillment_status: "processing", discount_cents: 0, coupon_code: null },
    ]);
    expect(db.query("SELECT coupon_code, shipping_method_id FROM carts").all()).toEqual([{ coupon_code: null, shipping_method_id: null }]);
    expect(db.query("SELECT quantity FROM cart_items").all()).toEqual([{ quantity: 2 }]);
    expect(db.query("SELECT name, product_slug, image_url FROM order_items").all()).toEqual([
      { name: "Wireless Lantern", product_slug: null, image_url: null },
    ]);
    // Pre-existing rows are in the FTS index (migration ends with 'rebuild').
    expect(hits(db, "lantern")).toEqual(["p1"]);
    expect(hits(db, "wirel*")).toEqual(["p1"]);
    ftsIntegrity(db);
    expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

    // Re-running is a no-op and changes nothing.
    const dump = db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    expect(runMigrations(db)).toEqual([]);
    expect(runMigrations(db)).toEqual([]);
    expect(db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(dump);
    expect(db.query("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 1 }, { version: 2 }]);
  });

  test("a v1 order can be moved through the v2 lifecycle after migration", () => {
    const db = v1Db();
    db.run(`INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
              line1, city, region, postal_code, country, card_last4, idempotency_key)
            VALUES ('o1', 's1', 'paid', 1, 1, 'USD', 'A', 'a@example.com', 'L', 'C', 'R', '1', 'US', '4242', 'k')`);
    runMigrations(db);
    db.run("UPDATE orders SET fulfillment_status = 'shipped' WHERE id = 'o1'");
    db.run("INSERT INTO order_events (order_id, status) VALUES ('o1', 'processing'), ('o1', 'shipped')");
    expect(() => db.run("UPDATE orders SET fulfillment_status = 'pending' WHERE id = 'o1'")).toThrow(/CHECK/);
  });

  test("new product rows get published_at = created_at when omitted or ''; explicit values kept", () => {
    const db = migrated();
    addProduct(db, "a");
    db.run("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at) VALUES ('b', 'b', 'B', 1, 'USD', '/x', 1, '')");
    db.run("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at) VALUES ('c', 'c', 'C', 1, 'USD', '/x', 1, '2026-05-05T00:00:00.000Z')");
    const rows = db.query<{ id: string; published_at: string; created_at: string }, []>("SELECT id, published_at, created_at FROM products ORDER BY id").all();
    expect(rows[0]?.published_at).toBe(rows[0]?.created_at ?? "x");
    expect(rows[1]?.published_at).toBe(rows[1]?.created_at ?? "x");
    expect(rows[2]?.published_at).toBe("2026-05-05T00:00:00.000Z");
    expect(() => db.run("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at) VALUES ('d', 'd', 'D', 1, 'USD', '/x', 1, NULL)")).toThrow(/NOT NULL/);
  });
});

// ---------------------------------------------------------------------------
describe("QA-A C2 FTS5", () => {
  function setup(): Database {
    const db = migrated();
    taxonomy(db);
    addProduct(db, "p1", { name: "Wireless Headphones", description: "Noise cancelling over-ear", brand: "b1", category: "c1", bullets: JSON.stringify(["Thirty hour battery"]) });
    addProduct(db, "p2", { name: "Trail Lantern", description: "Great for running at night", brand: "b2", category: "c2" });
    addProduct(db, "p3", { name: "Plain Mug" });
    return db;
  }

  test("hits on name, description, bullets, brand, category and department terms", () => {
    const db = setup();
    expect(hits(db, "headphones")).toEqual(["p1"]);
    expect(hits(db, "cancelling")).toEqual(["p1"]);
    expect(hits(db, "battery")).toEqual(["p1"]);
    expect(hits(db, "quorra")).toEqual(["p1"]);
    expect(hits(db, "zephyrine")).toEqual(["p2"]);
    expect(hits(db, "audiophile")).toEqual(["p1"]);
    expect(hits(db, "campcraft")).toEqual(["p2"]);
    expect(hits(db, "electronics")).toEqual(["p1"]);
    expect(hits(db, "outdoors")).toEqual(["p2"]);
    expect(hits(db, "department_name:electronics")).toEqual(["p1"]);
    expect(hits(db, "brand_name:quorra")).toEqual(["p1"]);
  });

  test("prefix wirel* finds wireless; porter: run <-> running both ways", () => {
    const db = setup();
    expect(hits(db, "wirel*")).toEqual(["p1"]);
    expect(hits(db, "wi*")).toEqual(["p1"]);
    expect(hits(db, "run")).toEqual(["p2"]);
    expect(hits(db, "runs")).toEqual(["p2"]);
    addProduct(db, "p4", { name: "Run Club Cap" });
    expect(hits(db, "running")).toEqual(["p2", "p4"]);
    ftsIntegrity(db);
  });

  test("in sync after INSERT, UPDATE of name/description/bullets/brand_id/category_id, DELETE", () => {
    const db = setup();
    db.run("UPDATE products SET name = 'Kettle Deluxe' WHERE id = 'p3'");
    expect(hits(db, "mug")).toEqual([]);
    expect(hits(db, "kettle")).toEqual(["p3"]);
    db.run("UPDATE products SET description = 'gooseneck spout' WHERE id = 'p3'");
    expect(hits(db, "gooseneck")).toEqual(["p3"]);
    db.run(`UPDATE products SET bullets = '["vacuum insulated"]' WHERE id = 'p3'`);
    expect(hits(db, "insulated")).toEqual(["p3"]);
    db.run("UPDATE products SET brand_id = 'b2' WHERE id = 'p1'");
    expect(hits(db, "quorra")).toEqual([]);
    expect(hits(db, "zephyrine")).toEqual(["p1", "p2"]);
    db.run("UPDATE products SET category_id = 'c2' WHERE id = 'p1'");
    expect(hits(db, "audiophile")).toEqual([]);
    expect(hits(db, "electronics")).toEqual([]);
    expect(hits(db, "outdoors")).toEqual(["p1", "p2"]);
    db.run("UPDATE products SET category_id = NULL, brand_id = NULL WHERE id = 'p1'");
    expect(hits(db, "outdoors")).toEqual(["p2"]);
    db.run("DELETE FROM products WHERE id = 'p2'");
    expect(hits(db, "lantern")).toEqual([]);
    expect(hits(db, "zephyrine")).toEqual([]);
    ftsIntegrity(db);
  });

  test("brand rename, category rename, department rename and category re-parent re-index", () => {
    const db = setup();
    db.run("UPDATE brands SET name = 'Quasar' WHERE id = 'b1'");
    expect(hits(db, "quorra")).toEqual([]);
    expect(hits(db, "quasar")).toEqual(["p1"]);
    db.run("UPDATE categories SET name = 'Hifi' WHERE id = 'c1'");
    expect(hits(db, "audiophile")).toEqual([]);
    expect(hits(db, "hifi")).toEqual(["p1"]);
    db.run("UPDATE categories SET name = 'Gadgets' WHERE id = 'd1'");
    expect(hits(db, "electronics")).toEqual([]);
    expect(hits(db, "gadgets")).toEqual(["p1"]);
    db.run("UPDATE categories SET parent_id = 'd2' WHERE id = 'c1'");
    expect(hits(db, "gadgets")).toEqual([]);
    expect(hits(db, "outdoors")).toEqual(["p1", "p2"]);
    // brand/category columns other than name do not desync
    db.run("UPDATE brands SET description = 'x', slug = 'quasar' WHERE id = 'b1'");
    db.run("UPDATE categories SET slug = 'hifi', sort_order = 9 WHERE id = 'c1'");
    ftsIntegrity(db);
  });

  test("stock/price/rating/featured updates and decrements do not break the index", () => {
    const db = setup();
    db.run("UPDATE products SET stock = 0, price_cents = 1, is_featured = 1, list_price_cents = 5, sku = 'X' WHERE id = 'p1'");
    db.run("UPDATE products SET stock = stock - 1 WHERE id = 'p2' AND stock >= 1");
    db.run("INSERT INTO reviews (id, product_id, session_id, display_name, rating) VALUES ('r', 'p1', 's', 'A', 4)");
    expect(hits(db, "headphones")).toEqual(["p1"]);
    ftsIntegrity(db);
  });

  test("200 random product/brand/category mutations keep the index consistent with the content view", () => {
    const db = setup();
    const r = rng(77);
    const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const w = (): string => words[Math.floor(r() * words.length)] ?? "alpha";
    let n = 10;
    for (let i = 0; i < 200; i++) {
      const ids = db.query<{ id: string }, []>("SELECT id FROM products").all().map((x) => x.id);
      const id = ids[Math.floor(r() * ids.length)] ?? "p1";
      const op = Math.floor(r() * 8);
      if (op === 0) addProduct(db, `n${n++}`, { name: w(), brand: r() < 0.5 ? "b1" : null, category: r() < 0.5 ? "c2" : "c1" });
      else if (op === 1 && ids.length > 1) db.query("DELETE FROM products WHERE id = ?").run(id);
      else if (op === 2) db.query("UPDATE products SET name = ? WHERE id = ?").run(`${w()} ${w()}`, id);
      else if (op === 3) db.query("UPDATE products SET bullets = ? WHERE id = ?").run(r() < 0.3 ? "{bad" : JSON.stringify([w()]), id);
      else if (op === 4) db.query("UPDATE products SET brand_id = ? WHERE id = ?").run(r() < 0.5 ? "b2" : null, id);
      else if (op === 5) db.query("UPDATE brands SET name = ? WHERE id = ?").run(w(), r() < 0.5 ? "b1" : "b2");
      else if (op === 6) db.query("UPDATE categories SET name = ? WHERE id = ?").run(w(), ["c1", "c2", "d1", "d2"][Math.floor(r() * 4)] ?? "c1");
      else db.query("UPDATE categories SET parent_id = ? WHERE id = ?").run(r() < 0.5 ? "d1" : "d2", r() < 0.5 ? "c1" : "c2");
    }
    ftsIntegrity(db);
    // spot check: every product is findable by its own first name word
    for (const row of db.query<{ id: string; name: string }, []>("SELECT id, name FROM products").all()) {
      const first = row.name.split(" ")[0] ?? "";
      if (/^[a-z]+$/i.test(first)) expect(hits(db, `name:"${first}"`)).toContain(row.id);
    }
  });

  test("products_fts_vocab exists and lists (porter-stemmed) terms with doc counts", () => {
    const db = setup();
    const rows = db.query<{ term: string; doc: number; cnt: number }, []>("SELECT term, doc, cnt FROM products_fts_vocab ORDER BY term").all();
    const terms = rows.map((x) => x.term);
    expect(terms).toContain("headphon");
    expect(terms).toContain("wireless");
    expect(terms).toContain("lantern");
    expect(rows.find((x) => x.term === "lantern")?.doc).toBe(1);
  });

  test("a NUL inside a quoted token still throws 'unterminated string' (why the recipe strips control chars)", () => {
    const db = setup();
    expect(() => hits(db, '"a\u0000b"')).toThrow(/unterminated/);
  });

  test("raw user text with FTS syntax throws even when bound (documents why quoting is required)", () => {
    const db = setup();
    for (const q of ["t-shirt", "usb-c", "3.5mm", "o'clock", '"unterminated', "NEAR(", "wireless AND", "-foo", "a:b", "*", "^"]) {
      expect(() => hits(db, q)).toThrow();
    }
    expect(db.query("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 3 });
  });

  test("crash-free recipe: quote every whitespace token (double embedded quotes) -> never throws over 2000 hostile strings", () => {
    const db = setup();
    const r = rng(9);
    const alphabet = ['"', "'", "*", "-", "+", "^", ":", "(", ")", "{", "}", ",", ".", "AND", "OR", "NOT", "NEAR", " ", "a", "wire", "é", "\u0000", "\t", "名", "name", ";", "--", "/", "\\"];
    for (let i = 0; i < 2000; i++) {
      let s = "";
      const len = Math.floor(r() * 12);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(r() * alphabet.length)] ?? "";
      const m = quoteForMatch(s, r() < 0.5);
      if (m === null) continue;
      expect(() => hits(db, m)).not.toThrow();
    }
    expect(hits(db, quoteForMatch("wirel", true) ?? "")).toEqual(["p1"]);
    expect(hits(db, quoteForMatch("NEAR( AND headphones") ?? "")).toEqual([]);
    expect(hits(db, quoteForMatch("wireless headphones") ?? "")).toEqual(["p1"]);
    expect(db.query("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 3 });
  });
});

// ---------------------------------------------------------------------------
describe("QA-A C3 triggers and constraints", () => {
  test("property: 100 random review ops keep rating_count/rating_sum equal to a fresh published aggregate", () => {
    const db = migrated();
    for (const id of ["a", "b", "c", "d"]) addProduct(db, id);
    const r = rng(20261107);
    const products = ["a", "b", "c", "d"];
    const pick = <T,>(xs: readonly T[]): T => {
      const x = xs[Math.floor(r() * xs.length)];
      if (x === undefined) throw new Error("empty");
      return x;
    };
    let next = 0;
    let applied = 0;
    for (let i = 0; i < 100; i++) {
      const ids = db.query<{ id: string }, []>("SELECT id FROM reviews").all().map((x) => x.id);
      const op = ids.length === 0 ? 0 : Math.floor(r() * 7);
      const stars = 1 + Math.floor(r() * 5);
      try {
        if (op === 0) {
          db.query("INSERT INTO reviews (id, product_id, session_id, display_name, rating, status) VALUES (?, ?, ?, 'N', ?, ?)")
            .run(`r${next++}`, pick(products), `s${Math.floor(r() * 6)}`, stars, r() < 0.8 ? "published" : "hidden");
        } else if (op === 1) {
          db.query("DELETE FROM reviews WHERE id = ?").run(pick(ids));
        } else if (op === 2) {
          db.query("UPDATE reviews SET rating = ? WHERE id = ?").run(stars, pick(ids));
        } else if (op === 3) {
          db.query("UPDATE reviews SET status = CASE status WHEN 'published' THEN 'hidden' ELSE 'published' END WHERE id = ?").run(pick(ids));
        } else if (op === 4) {
          db.query("UPDATE reviews SET product_id = ? WHERE id = ?").run(pick(products), pick(ids));
        } else if (op === 5) {
          db.query(
            `INSERT INTO reviews (id, product_id, session_id, display_name, rating) VALUES (?, ?, ?, 'N', ?)
             ON CONFLICT (product_id, session_id) DO UPDATE SET rating = excluded.rating`,
          ).run(`r${next++}`, pick(products), `s${Math.floor(r() * 6)}`, stars);
        } else {
          // multi-column update: move + rating + status at once
          db.query("UPDATE reviews SET product_id = ?, rating = ?, status = ? WHERE id = ?")
            .run(pick(products), stars, r() < 0.5 ? "published" : "hidden", pick(ids));
        }
        applied++;
      } catch (e) {
        // only UNIQUE (product_id, session_id) collisions are acceptable rejections
        expect(String(e)).toMatch(/UNIQUE/);
      }
      for (const row of aggregates(db)) {
        expect({ id: row.id, c: row.rc, s: row.rs }).toEqual({ id: row.id, c: row.ec, s: row.es });
      }
    }
    expect(applied).toBeGreaterThan(80);
    // bulk ops too
    db.run("UPDATE reviews SET status = 'hidden'");
    for (const row of aggregates(db)) expect([row.rc, row.rs]).toEqual([0, 0]);
    db.run("UPDATE reviews SET status = 'published'");
    for (const row of aggregates(db)) expect([row.rc, row.rs]).toEqual([row.ec, row.es]);
    db.run("DELETE FROM reviews");
    for (const row of aggregates(db)) expect([row.rc, row.rs]).toEqual([0, 0]);
  });

  test("helpful_count stays exact under 300 random vote inserts/deletes on all three vote tables; PK duplicates rejected", () => {
    const db = migrated();
    addProduct(db, "p");
    db.run("INSERT INTO reviews (id, product_id, session_id, display_name, rating) VALUES ('r1', 'p', 's', 'A', 5), ('r2', 'p', 't', 'B', 3)");
    db.run("INSERT INTO questions (id, product_id, session_id, display_name, body) VALUES ('q1', 'p', 's', 'A', 'Why?')");
    db.run("INSERT INTO answers (id, question_id, session_id, display_name, body) VALUES ('a1', 'q1', 't', 'B', 'Because')");
    const specs = [
      { table: "review_votes", col: "review_id", parent: "reviews", ids: ["r1", "r2"] },
      { table: "question_votes", col: "question_id", parent: "questions", ids: ["q1"] },
      { table: "answer_votes", col: "answer_id", parent: "answers", ids: ["a1"] },
    ] as const;
    const r = rng(5);
    for (let i = 0; i < 300; i++) {
      const s = specs[Math.floor(r() * specs.length)] ?? specs[0];
      const target = s.ids[Math.floor(r() * s.ids.length)] ?? s.ids[0];
      const voter = `v${Math.floor(r() * 8)}`;
      if (r() < 0.6) {
        const exists = db.query(`SELECT 1 FROM ${s.table} WHERE ${s.col} = ? AND session_id = ?`).get(target, voter) !== null;
        if (exists) {
          expect(() => db.query(`INSERT INTO ${s.table} (${s.col}, session_id) VALUES (?, ?)`).run(target, voter)).toThrow(/UNIQUE|PRIMARY/);
        } else {
          db.query(`INSERT INTO ${s.table} (${s.col}, session_id) VALUES (?, ?)`).run(target, voter);
        }
      } else {
        db.query(`DELETE FROM ${s.table} WHERE ${s.col} = ? AND session_id = ?`).run(target, voter);
      }
      for (const sp of specs) {
        const bad = db
          .query<{ n: number }, []>(
            `SELECT COUNT(*) AS n FROM ${sp.parent} x WHERE x.helpful_count <> (SELECT COUNT(*) FROM ${sp.table} v WHERE v.${sp.col} = x.id)`,
          )
          .get();
        expect(bad?.n).toBe(0);
      }
    }
  });

  test("order_events UNIQUE (order_id, status) and status CHECK", () => {
    const db = migrated();
    db.run(`INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
              line1, city, region, postal_code, country, card_last4, idempotency_key)
            VALUES ('o', 's', 'paid', 1, 1, 'USD', 'A', 'a@example.com', 'L', 'C', 'R', '1', 'US', '4242', 'k')`);
    db.run("INSERT INTO order_events (order_id, status) VALUES ('o', 'processing')");
    expect(() => db.run("INSERT INTO order_events (order_id, status) VALUES ('o', 'processing')")).toThrow(/UNIQUE/);
    expect(() => db.run("INSERT INTO order_events (order_id, status) VALUES ('o', 'returned')")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO order_events (order_id, status) VALUES ('nope', 'packed')")).toThrow(/FOREIGN KEY/);
  });

  test("coupons CHECKs: upper-case code, value per kind, used_count <= max_uses", () => {
    const db = migrated();
    const add = (code: string, kind: string, value: number, maxUses: number | null = null, used = 0): void => {
      db.query("INSERT INTO coupons (code, kind, value, max_uses, used_count) VALUES (?, ?, ?, ?, ?)").run(code, kind, value, maxUses, used);
    };
    add("OK1", "percent", 1);
    add("OK100", "percent", 100);
    add("FIX", "fixed", 1);
    add("SHIP", "free_shipping", 0);
    add("CAP", "fixed", 5, 2, 2);
    expect(() => add("lower", "percent", 10)).toThrow(/CHECK/);
    expect(() => add("MiXed", "percent", 10)).toThrow(/CHECK/);
    expect(() => add("", "percent", 10)).toThrow(/CHECK/);
    expect(() => add("X".repeat(65), "percent", 10)).toThrow(/CHECK/);
    expect(() => add("P0", "percent", 0)).toThrow(/CHECK/);
    expect(() => add("P101", "percent", 101)).toThrow(/CHECK/);
    expect(() => add("F0", "fixed", 0)).toThrow(/CHECK/);
    expect(() => add("FNEG", "fixed", -5)).toThrow(/CHECK/);
    expect(() => add("S1", "free_shipping", 1)).toThrow(/CHECK/);
    expect(() => add("BOGUS", "bogo", 1)).toThrow(/CHECK/);
    expect(() => add("OVER", "fixed", 5, 1, 2)).toThrow(/CHECK/);
    expect(() => add("ZERO", "fixed", 5, 0, 0)).toThrow(/CHECK/);
    expect(() => db.run("UPDATE coupons SET used_count = used_count + 1 WHERE code = 'CAP'")).toThrow(/CHECK/);
    // race-safe redemption pattern from the README reports 0 changes when exhausted
    const res = db.query("UPDATE coupons SET used_count = used_count + 1 WHERE code = ? AND (max_uses IS NULL OR used_count < max_uses)").run("CAP");
    expect(res.changes).toBe(0);
    expect(() => db.run("UPDATE coupons SET code = lower(code) WHERE code = 'FIX'")).toThrow(/CHECK/);
  });

  test("products.list_price_cents >= price_cents CHECK on insert and update", () => {
    const db = migrated();
    addProduct(db, "p", { price: 1000 });
    db.run("UPDATE products SET list_price_cents = 1000 WHERE id = 'p'");
    db.run("UPDATE products SET list_price_cents = 1500 WHERE id = 'p'");
    expect(() => db.run("UPDATE products SET list_price_cents = 999 WHERE id = 'p'")).toThrow(/CHECK/);
    expect(() => db.run("UPDATE products SET price_cents = 1600 WHERE id = 'p'")).toThrow(/CHECK/);
    db.run("UPDATE products SET price_cents = 1600, list_price_cents = 2000 WHERE id = 'p'");
    db.run("UPDATE products SET list_price_cents = NULL WHERE id = 'p'");
    expect(() =>
      db.run("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, list_price_cents) VALUES ('q', 'q', 'Q', 500, 'USD', '/x', 1, 499)"),
    ).toThrow(/CHECK/);
  });

  test("categories: third level rejected on INSERT and UPDATE; department with children cannot be nested", () => {
    const db = migrated();
    taxonomy(db);
    expect(() => db.run("INSERT INTO categories (id, slug, name, parent_id) VALUES ('g', 'g', 'G', 'c1')")).toThrow(/maximum depth/);
    db.run("INSERT INTO categories (id, slug, name) VALUES ('lone', 'lone', 'Lone')");
    expect(() => db.run("UPDATE categories SET parent_id = 'c1' WHERE id = 'lone'")).toThrow(/maximum depth/);
    expect(() => db.run("UPDATE categories SET parent_id = 'd2' WHERE id = 'd1'")).toThrow(/maximum depth/);
    expect(() => db.run("UPDATE categories SET parent_id = 'd1' WHERE id = 'd1'")).toThrow();
    expect(() => db.run("INSERT INTO categories (id, slug, name, parent_id) VALUES ('x', 'x', 'X', 'nope')")).toThrow(/FOREIGN KEY/);
    // a childless department may become a category
    db.run("UPDATE categories SET parent_id = 'd1' WHERE id = 'lone'");
    expect(db.query("SELECT COUNT(*) AS n FROM categories c JOIN categories p ON p.id = c.parent_id WHERE p.parent_id IS NOT NULL").get()).toEqual({ n: 0 });
  });

  test("one save_for_later list per session (partial unique index); wishlists unlimited; race-safe upsert form works", () => {
    const db = migrated();
    db.run("INSERT INTO lists (id, session_id, name, kind) VALUES ('l1', 's', 'Saved', 'save_for_later')");
    expect(() => db.run("INSERT INTO lists (id, session_id, name, kind) VALUES ('l2', 's', 'Saved 2', 'save_for_later')")).toThrow(/UNIQUE/);
    db.run("INSERT INTO lists (id, session_id, name, kind) VALUES ('l3', 't', 'Saved', 'save_for_later')");
    db.run("INSERT INTO lists (id, session_id, name, kind) VALUES ('w1', 's', 'A', 'wishlist'), ('w2', 's', 'B', 'wishlist')");
    const res = db
      .query("INSERT INTO lists (id, session_id, name, kind) VALUES ('l4', 's', 'Saved', 'save_for_later') ON CONFLICT (session_id) WHERE kind = 'save_for_later' DO NOTHING")
      .run();
    expect(res.changes).toBe(0);
    expect(() => db.run("UPDATE lists SET kind = 'save_for_later' WHERE id = 'w1'")).toThrow(/UNIQUE/);
  });

  test("recomputeProductRating repairs a corrupted aggregate (and is needed: corrupted-low aggregates block review deletes)", () => {
    const db = migrated();
    addProduct(db, "p");
    db.run("INSERT INTO reviews (id, product_id, session_id, display_name, rating) VALUES ('r1', 'p', 's1', 'A', 5), ('r2', 'p', 's2', 'B', 2)");
    db.run("INSERT INTO reviews (id, product_id, session_id, display_name, rating, status) VALUES ('r3', 'p', 's3', 'C', 1, 'hidden')");
    db.run("UPDATE products SET rating_count = 0, rating_sum = 0 WHERE id = 'p'");
    expect(() => db.run("DELETE FROM reviews WHERE id = 'r1'")).toThrow(/CHECK/);
    expect(recomputeProductRating(db, "p")).toEqual({ ratingCount: 2, ratingSum: 7 });
    db.run("DELETE FROM reviews WHERE id = 'r1'");
    expect(db.query("SELECT rating_count, rating_sum FROM products").get()).toEqual({ rating_count: 1, rating_sum: 2 });
  });
});
