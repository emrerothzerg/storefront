import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteRecommendationRepository, type CandidateQuery } from "./recommendation-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const NOW = "2026-11-07T12:00:00.000Z";
const PAST = "2026-10-01T00:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";
const q = (over: Partial<CandidateQuery> = {}): CandidateQuery => ({ nowIso: NOW, exclude: [], limit: 50, ...over });

interface P {
  readonly id: string;
  readonly cat?: string | null;
  readonly brand?: string | null;
  readonly stock?: number;
  readonly published?: string;
  readonly rating?: readonly [number, number];
}

function setup(products: readonly P[]) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  db.query("INSERT INTO categories (id, slug, name) VALUES ('dept', 'dept', 'Dept')").run();
  for (const c of ["c1", "c2", "c3"]) {
    db.query("INSERT INTO categories (id, slug, name, parent_id) VALUES (?, ?, ?, 'dept')").run(c, c, c);
  }
  db.query("INSERT INTO categories (id, slug, name) VALUES ('other', 'other', 'Other')").run();
  for (const b of ["b1", "b2"]) db.query("INSERT INTO brands (id, slug, name) VALUES (?, ?, ?)").run(b, b, b);
  const ins = db.query(
    `INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at, category_id, brand_id, rating_count, rating_sum)
     VALUES (?, ?, ?, 100, 'USD', '/x.svg', ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of products) {
    ins.run(p.id, p.id, p.id, p.stock ?? 5, p.published ?? PAST, p.cat ?? null, p.brand ?? null, p.rating?.[0] ?? 0, p.rating?.[1] ?? 0);
  }
  return { db, repo: new SqliteRecommendationRepository(db) };
}

let seq = 0;
function order(db: Database, items: readonly (string | readonly [string, number])[], o: { session?: string; status?: string; fulfillment?: string; at?: string } = {}) {
  seq += 1;
  const id = `o${seq}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city, region,
       postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
     VALUES (?, ?, ?, 1, 1, 'USD', 'n', 'e@x.io', 'l', 'c', 'r', 'p', 'US', '4242', ?, ?, ?)`,
  ).run(id, o.session ?? S1, o.status ?? "paid", id, o.at ?? PAST, o.fulfillment ?? "processing");
  for (const it of items) {
    const [pid, qty] = typeof it === "string" ? [it, 1] : it;
    db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'n', 1, ?)").run(id, pid, qty);
  }
}

const ALL: readonly P[] = [
  { id: "a", cat: "c1", brand: "b1" },
  { id: "b", cat: "c1", brand: "b2" },
  { id: "c", cat: "c1", brand: null },
  { id: "d", cat: "c2", brand: "b1" },
  { id: "e", cat: "c3", brand: "b2" },
  { id: "f", cat: "other", brand: null },
  { id: "oos", cat: "c1", brand: "b1", stock: 0 },
  { id: "later", cat: "c1", brand: "b1", published: FUTURE },
  { id: "nocat", cat: null, brand: null },
];

describe("productFacts", () => {
  test("availability reflects stock and publication at now", () => {
    const { repo } = setup(ALL);
    expect(repo.productFacts("a", NOW)).toEqual({ id: "a", categoryId: "c1", brandId: "b1", currency: "USD", available: true });
    expect(repo.productFacts("oos", NOW)?.available).toBe(false);
    expect(repo.productFacts("later", NOW)?.available).toBe(false);
    expect(repo.productFacts("later", FUTURE)?.available).toBe(true);
    expect(repo.productFacts("missing", NOW)).toBeNull();
  });
});

describe("coPurchased", () => {
  test("scores, threshold, exclusions, paid-only, availability", () => {
    const { db, repo } = setup(ALL);
    order(db, ["a", "b", "oos"]);
    order(db, ["a", "b", "later"]);
    order(db, ["a", "c"]);
    order(db, ["a", "d"], { status: "payment_failed" });
    order(db, ["a", "d"], { fulfillment: "cancelled" });
    expect(repo.coPurchased(["a"], 1, q())).toEqual([
      { id: "b", score: 2 },
      { id: "c", score: 1 },
    ]);
    expect(repo.coPurchased(["a"], 2, q())).toEqual([{ id: "b", score: 2 }]);
    expect(repo.coPurchased(["a"], 1, q({ exclude: ["b"] }))).toEqual([{ id: "c", score: 1 }]);
    expect(repo.coPurchased(["a"], 1, q({ limit: 1 }))).toEqual([{ id: "b", score: 2 }]);
    expect(repo.coPurchased([], 1, q())).toEqual([]);
  });

  test("multiple sources: sources never returned, scores summed", () => {
    const { db, repo } = setup(ALL);
    order(db, ["a", "b", "e"]);
    order(db, ["c", "e"]);
    order(db, ["a", "f"]);
    expect(repo.coPurchased(["a", "b", "c"], 1, q())).toEqual([
      { id: "e", score: 3 },
      { id: "f", score: 1 },
    ]);
  });
});

describe("coViewed", () => {
  test("counts sessions", () => {
    const { db, repo } = setup(ALL);
    const v = db.query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)");
    v.run(S1, "a", NOW);
    v.run(S1, "b", NOW);
    v.run(S1, "oos", NOW);
    v.run(S2, "a", NOW);
    v.run(S2, "b", NOW);
    v.run(S2, "c", NOW);
    expect(repo.coViewed("a", q())).toEqual([
      { id: "b", score: 2 },
      { id: "c", score: 1 },
    ]);
  });
});

describe("related", () => {
  test("category tier then brand tier, rating-weighted, ties by id", () => {
    const { db, repo } = setup([...ALL, { id: "a2", cat: "c1", brand: null, rating: [10, 50] }]);
    expect(repo.related("c1", "b1", q({ exclude: ["a"] }))).toEqual(["a2", "b", "c", "d"]);
    expect(repo.related(null, "b2", q())).toEqual(["b", "e"]);
    expect(repo.related("c2", null, q())).toEqual(["d"]);
    expect(repo.related(null, null, q())).toEqual([]);
    db.query("UPDATE products SET rating_count = 2, rating_sum = 2 WHERE id = 'a2'").run();
    expect(repo.related("c1", null, q({ exclude: ["a"] }))).toEqual(["b", "c", "a2"]);
  });
});

describe("inspiredBy / viewedIds", () => {
  test("weights categories x2 plus brand; viewed products excluded", () => {
    const { db, repo } = setup(ALL);
    const v = db.query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)");
    v.run(S1, "a", "2026-11-07T10:00:00.000Z");
    v.run(S1, "f", "2026-11-07T11:00:00.000Z");
    expect(repo.viewedIds(S1)).toEqual(["f", "a"]);
    // b: c1 (2) ; c: c1 (2) ; d: brand b1 (1)
    expect(repo.inspiredBy(S1, q())).toEqual([
      { id: "b", score: 2 },
      { id: "c", score: 2 },
      { id: "d", score: 1 },
    ]);
    expect(repo.inspiredBy(S2, q())).toEqual([]);
  });
});

describe("buyAgain / cartProductIds", () => {
  test("latest order first, paid only, session only", () => {
    const { db, repo } = setup(ALL);
    order(db, ["a", "b"], { at: "2026-10-01T00:00:00.000Z" });
    order(db, ["c"], { at: "2026-10-05T00:00:00.000Z" });
    order(db, ["a"], { at: "2026-10-10T00:00:00.000Z" });
    order(db, ["d"], { at: "2026-10-20T00:00:00.000Z", status: "payment_failed" });
    order(db, ["e"], { at: "2026-10-20T00:00:00.000Z", session: S2 });
    order(db, ["oos"], { at: "2026-10-21T00:00:00.000Z" });
    expect(repo.buyAgain(S1, q())).toEqual(["a", "c", "b"]);
    expect(repo.buyAgain(S2, q())).toEqual(["e"]);
  });

  test("cartProductIds", () => {
    const { db, repo } = setup(ALL);
    db.query("INSERT INTO carts (session_id) VALUES (?)").run(S1);
    db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity, created_at) VALUES (?, 'b', 1, ?)").run(S1, PAST);
    db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity, created_at) VALUES (?, 'a', 1, ?)").run(S1, NOW);
    expect(repo.cartProductIds(S1)).toEqual(["b", "a"]);
    expect(repo.cartProductIds(S2)).toEqual([]);
  });
});

describe("best sellers, newest, categories, units", () => {
  test("categoryBestSellers: department includes children; unsold included after sold", () => {
    const { db, repo } = setup(ALL);
    order(db, [["e", 3], ["d", 1]]);
    order(db, [["f", 9]]);
    expect(repo.categoryBestSellers(["dept"], q())).toEqual(["e", "d", "a", "b", "c"]);
    expect(repo.categoryBestSellers(["c1"], q({ exclude: ["a"] }))).toEqual(["b", "c"]);
    expect(repo.categoryBestSellers([], q())).toEqual([]);
  });

  test("globalBestSellers lists sold products only; newest by published_at", () => {
    const { db, repo } = setup([...ALL, { id: "fresh", published: "2026-11-06T00:00:00.000Z" }]);
    order(db, [["e", 3], ["d", 3], ["oos", 10]]);
    expect(repo.globalBestSellers(q())).toEqual(["d", "e"]);
    expect(repo.newest(q({ limit: 2 }))).toEqual(["fresh", "a"]);
  });

  test("categoryIdsOf / categoryExists", () => {
    const { repo } = setup(ALL);
    expect(repo.categoryIdsOf(["a", "b", "d", "nocat", "missing"])).toEqual(["c1", "c2"]);
    expect(repo.categoryIdsOf([])).toEqual([]);
    expect(repo.categoryExists("dept")).toBe(true);
    expect(repo.categoryExists("nope")).toBe(false);
  });

  test("unitsSold: inclusive window, paid non-cancelled only", () => {
    const { db, repo } = setup(ALL);
    order(db, [["a", 2]], { at: "2026-10-08T12:00:00.000Z" });
    order(db, [["a", 3]], { at: NOW });
    order(db, [["a", 4]], { at: "2026-10-08T11:59:59.999Z" });
    order(db, [["a", 5]], { at: NOW, fulfillment: "cancelled" });
    expect(repo.unitsSold("a", "2026-10-08T12:00:00.000Z", NOW)).toBe(5);
    expect(repo.unitsSold("missing", PAST, NOW)).toBe(0);
  });

  test("ids that look like SQL are just data", () => {
    const { repo } = setup(ALL);
    expect(repo.coPurchased(["') OR 1=1 --"], 1, q({ exclude: ['"]'] }))).toEqual([]);
    expect(repo.categoryBestSellers(["' OR '1'='1"], q())).toEqual([]);
  });
});
