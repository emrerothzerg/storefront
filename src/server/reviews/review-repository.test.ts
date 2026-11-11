import { describe, expect, test } from "bun:test";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteReviewRepository, type NewReviewRow } from "./review-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES ('p1','p1','P1',100,'USD','/x',1), ('p2','p2','P2',100,'USD','/x',1)",
  ).run();
  return { db, repo: new SqliteReviewRepository(db) };
}

function row(overrides: Partial<NewReviewRow> = {}): NewReviewRow {
  return {
    id: "r1",
    productId: "p1",
    sessionId: S1,
    displayName: "Ann",
    rating: 4,
    title: "T",
    body: "B",
    verifiedPurchase: false,
    createdAt: "2026-11-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("SqliteReviewRepository", () => {
  test("insert maps to a Review without the owner key; conflict on (product, owner) returns false", () => {
    const { repo } = setup();
    expect(repo.insert(row())).toBe(true);
    expect(repo.insert(row({ id: "r2", rating: 1 }))).toBe(false);
    const review = repo.getById("r1");
    expect(review).toEqual({
      id: "r1",
      productId: "p1",
      displayName: "Ann",
      rating: 4,
      title: "T",
      body: "B",
      verifiedPurchase: false,
      helpfulCount: 0,
      status: "published",
      createdAt: "2026-11-07T12:00:00.000Z",
      updatedAt: "2026-11-07T12:00:00.000Z",
    });
    expect(repo.getById("r2")).toBeNull();
    expect(repo.storedAggregate("p1")).toEqual({ count: 1, sum: 4 });
    expect(repo.aggregate("p1")).toEqual({ count: 1, sum: 4 });
  });

  test("writes with an invalid owner key throw; reads return empty", () => {
    const { repo } = setup();
    expect(() => repo.insert(row({ sessionId: "nope" }))).toThrow(TypeError);
    expect(() => repo.insertVote("r1", "nope")).toThrow(TypeError);
    expect(repo.listBySession("nope")).toEqual([]);
    expect(repo.existsForSession("nope", "p1")).toBe(false);
    expect(repo.hasPurchased("nope", "p1")).toBe(false);
  });

  test("aggregates, histogram and counts exclude hidden reviews", () => {
    const { db, repo } = setup();
    repo.insert(row({ id: "a", sessionId: S1, rating: 5 }));
    repo.insert(row({ id: "b", sessionId: S2, rating: 3, verifiedPurchase: true }));
    db.query("UPDATE reviews SET status = 'hidden' WHERE id = 'a'").run();
    expect(repo.aggregate("p1")).toEqual({ count: 1, sum: 3 });
    expect(repo.storedAggregate("p1")).toEqual({ count: 1, sum: 3 });
    expect([...repo.histogram("p1")]).toEqual([[3, 1]]);
    expect(repo.countPublished("p1", {})).toBe(1);
    expect(repo.countPublished("p1", { stars: 5 })).toBe(0);
    expect(repo.countPublished("p1", { verifiedOnly: true })).toBe(1);
    expect(repo.listPublished("p1", { sort: "recent", limit: 10, offset: 0, viewer: null }).map((r) => r.review.id)).toEqual(["b"]);
    expect(repo.listBySession(S1).map((r) => r.status)).toEqual(["hidden"]);
    expect(repo.storedAggregate("missing")).toBeNull();
    expect(repo.aggregate("missing")).toEqual({ count: 0, sum: 0 });
  });

  test("votes: one per owner, trigger keeps helpful_count; vote target exposes author only server-side", () => {
    const { repo } = setup();
    repo.insert(row());
    expect(repo.getVoteTarget("r1")).toEqual({ authorSessionId: S1, status: "published" });
    expect(repo.getVoteTarget("zz")).toBeNull();
    expect(repo.insertVote("r1", S2)).toBe(true);
    expect(repo.insertVote("r1", S2)).toBe(false);
    expect(repo.helpfulCount("r1")).toBe(1);
    expect(repo.helpfulCount("zz")).toBeNull();
    const [viewed] = repo.listPublished("p1", { sort: "helpful", limit: 1, offset: 0, viewer: S2 });
    expect(viewed).toMatchObject({ isOwn: false, votedByViewer: true });
  });

  test("hasPurchased requires paid + not cancelled + same owner + product", () => {
    const { db, repo } = setup();
    const insert = (id: string, session: string, status: string, fulfillment: string, product: string) => {
      db.query(
        `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
           region, postal_code, country, card_last4, idempotency_key, fulfillment_status)
         VALUES (?, ?, ?, 1, 1, 'USD', 'A', 'a@b.c', 'L', 'C', 'R', 'P', 'US', '4242', ?, ?)`,
      ).run(id, session, status, `k_${id}`, fulfillment);
      db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'n', 1, 1)").run(id, product);
    };
    insert("o1", S1, "paid", "cancelled", "p1");
    insert("o2", S1, "payment_failed", "processing", "p1");
    insert("o3", S2, "paid", "shipped", "p1");
    expect(repo.hasPurchased(S1, "p1")).toBe(false);
    expect(repo.hasPurchased(S2, "p1")).toBe(true);
    expect(repo.hasPurchased(S2, "p2")).toBe(false);
    insert("o4", S1, "paid", "out_for_delivery", "p1");
    expect(repo.hasPurchased(S1, "p1")).toBe(true);
  });
});
