import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteListingRepository } from "./listing-repository";

const NOW = "2026-11-07T12:00:00.000Z";

interface Row {
  id: string;
  price: number;
  stock?: number;
  list?: number | null;
  ratings?: readonly number[];
  brand?: string | null;
  category?: string;
  featured?: 0 | 1;
  published?: string;
}

function setup(rows: readonly Row[]): { db: Database; repo: SqliteListingRepository } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  db.query("INSERT INTO brands (id, slug, name) VALUES ('brand_a', 'a', 'Acme'), ('brand_b', 'b', 'Bolt')").run();
  db.query(
    `INSERT INTO categories (id, slug, name, parent_id) VALUES
       ('cat_d', 'd', 'Dept', NULL), ('cat_x', 'x', 'Leaf X', 'cat_d'), ('cat_y', 'y', 'Leaf Y', 'cat_d'), ('cat_e', 'e', 'Other', NULL)`,
  ).run();
  const insert = db.query(
    `INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, list_price_cents, brand_id, category_id, is_featured, published_at)
     VALUES (?, ?, ?, ?, 'USD', '/i.svg', ?, ?, ?, ?, ?, ?)`,
  );
  const review = db.query(
    "INSERT INTO reviews (id, product_id, session_id, display_name, rating) VALUES (?, ?, ?, 'R', ?)",
  );
  for (const r of rows) {
    insert.run(
      r.id, r.id, r.id, r.price, r.stock ?? 1, r.list ?? null, r.brand === undefined ? "brand_a" : r.brand,
      r.category ?? "cat_x", r.featured ?? 0, r.published ?? "2026-01-01T00:00:00.000Z",
    );
    (r.ratings ?? []).forEach((rating, i) => review.run(`${r.id}_r${i}`, r.id, `s${i}`, rating));
  }
  return { db, repo: new SqliteListingRepository(db) };
}

let seq = 0;
function sell(db: Database, productId: string, qty: number, status = "paid", fulfillment = "processing"): void {
  const id = `o${++seq}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
       line1, city, region, postal_code, country, card_last4, idempotency_key, fulfillment_status)
     VALUES (?, 's', ?, 1, 1, 'USD', 'A', 'a@b.co', 'l', 'c', 'r', 'p', 'US', '4242', ?, ?)`,
  ).run(id, status, id, fulfillment);
  db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'n', 1, ?)").run(id, productId, qty);
}

describe("SqliteListingRepository", () => {
  test("publish cut-off, limit/offset and id tiebreak", () => {
    const { repo } = setup([
      { id: "p3", price: 100 },
      { id: "p1", price: 100 },
      { id: "p2", price: 50 },
      { id: "future", price: 1, published: "2026-12-01T00:00:00.000Z" },
    ]);
    expect(repo.findIds({ nowIso: NOW }, "price_asc", 10, 0)).toEqual(["p2", "p1", "p3"]);
    expect(repo.findIds({ nowIso: NOW }, "price_asc", 1, 1)).toEqual(["p1"]);
    expect(repo.count({ nowIso: NOW })).toBe(3);
    expect(repo.count({ nowIso: "2027-01-01T00:00:00.000Z" })).toBe(4);
  });

  test("relevance orders by first position in ids; without ids it is featured", () => {
    const { repo } = setup([
      { id: "a", price: 1 },
      { id: "b", price: 1, featured: 1 },
      { id: "c", price: 1 },
    ]);
    expect(repo.findIds({ nowIso: NOW, ids: ["c", "a", "c", "zzz"] }, "relevance", 10, 0)).toEqual(["c", "a"]);
    expect(repo.findIds({ nowIso: NOW }, "relevance", 10, 0)).toEqual(["b", "a", "c"]);
  });

  test("rating filter uses the exact average; unrated never matches", () => {
    const { repo } = setup([
      { id: "r4", price: 1, ratings: [4, 4] },
      { id: "r39", price: 1, ratings: [4, 4, 4, 4, 4, 4, 4, 4, 4, 3] }, // 3.9 avg
      { id: "none", price: 1 },
    ]);
    expect(repo.findIds({ nowIso: NOW, minRating: 4 }, "featured", 10, 0)).toEqual(["r4"]);
    expect(repo.ratingCounts({ nowIso: NOW, minRating: 4 })).toEqual([2, 2, 2, 1]);
  });

  test("facet queries leave out only their own dimension", () => {
    const { repo } = setup([
      { id: "a1", price: 1000, brand: "brand_a", category: "cat_x" },
      { id: "a2", price: 3000, brand: "brand_a", category: "cat_y", stock: 0 },
      { id: "b1", price: 30000, brand: "brand_b", category: "cat_x" },
      { id: "n1", price: 30000, brand: null, category: "cat_e" },
    ]);
    const f = { nowIso: NOW, brandIds: ["brand_a"], categoryId: "cat_d" } as const;
    expect(repo.count(f)).toBe(2);
    expect(repo.brandCounts(f)).toEqual([
      { id: "brand_a", slug: "a", name: "Acme", count: 2 },
      { id: "brand_b", slug: "b", name: "Bolt", count: 1 },
    ]);
    expect([...repo.categoryCounts(f).entries()].sort()).toEqual([["cat_x", 1], ["cat_y", 1]]);
    expect(repo.priceCounts(f, [{ minCents: 0, maxCents: 2499 }, { minCents: 2500, maxCents: null }])).toEqual([1, 1]);
    expect(repo.inStockCount(f)).toBe(1);
    expect(repo.count({ ...f, inStockOnly: true }, "inStock")).toBe(2);
  });

  test("deal_saving sorts by percentage saving; dealsOnly excludes equal list price", () => {
    const { repo } = setup([
      { id: "half", price: 500, list: 1000 },
      { id: "tenth", price: 900, list: 1000 },
      { id: "equal", price: 1000, list: 1000 },
      { id: "plain", price: 1000 },
    ]);
    expect(repo.findIds({ nowIso: NOW, dealsOnly: true }, "deal_saving", 10, 0)).toEqual(["half", "tenth"]);
  });

  test("sales: paid and not cancelled only; rank within the leaf category", () => {
    const { db, repo } = setup([
      { id: "x1", price: 1, category: "cat_x" },
      { id: "x2", price: 1, category: "cat_x" },
      { id: "x3", price: 1, category: "cat_x" },
      { id: "y1", price: 1, category: "cat_y" },
    ]);
    sell(db, "x1", 3);
    sell(db, "x2", 3);
    sell(db, "x3", 9, "payment_failed");
    sell(db, "x3", 9, "paid", "cancelled");
    sell(db, "y1", 100);
    expect(repo.findIds({ nowIso: NOW, soldOnly: true }, "best_selling", 10, 0)).toEqual(["y1", "x1", "x2"]);
    expect(repo.rankInCategory("x1", NOW)).toEqual({ rank: 1, categoryId: "cat_x" });
    expect(repo.rankInCategory("x2", NOW)).toEqual({ rank: 2, categoryId: "cat_x" });
    expect(repo.rankInCategory("y1", NOW)).toEqual({ rank: 1, categoryId: "cat_y" });
    expect(repo.rankInCategory("x3", NOW)).toBeNull();
    expect(repo.rankInCategory("' OR 1=1 --", NOW)).toBeNull();
  });

  test("hostile values are bound, not interpolated", () => {
    const { repo } = setup([{ id: "a", price: 1 }]);
    expect(repo.count({ nowIso: NOW, brandIds: ["' OR 1=1 --"] })).toBe(0);
    expect(repo.count({ nowIso: NOW, categoryId: "x' OR '1'='1" })).toBe(0);
    expect(repo.count({ nowIso: NOW, ids: ["\"]; DROP TABLE products; --"] })).toBe(0);
    expect(repo.count({ nowIso: NOW })).toBe(1);
  });

  test("publishedAtByIds (T167 bx): dates for known ids only, hostile ids bound, empty input", () => {
    const { repo } = setup([
      { id: "a", price: 1, published: "2026-10-30T00:00:00.000Z" },
      { id: "b", price: 2, published: "2027-01-01T00:00:00.000Z" },
    ]);
    const map = repo.publishedAtByIds(["a", "b", "missing", "a", "' OR 1=1 --"]);
    expect([...map.entries()].sort()).toEqual([
      ["a", "2026-10-30T00:00:00.000Z"],
      ["b", "2027-01-01T00:00:00.000Z"],
    ]);
    expect(repo.publishedAtByIds([]).size).toBe(0);
  });
});
