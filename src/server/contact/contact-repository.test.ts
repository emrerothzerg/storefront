import { describe, expect, test } from "bun:test";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase, SEED_CATALOG_PRODUCTS } from "@/server/db/seed";
import { SqliteContactRepository, type NewContactMessageRow } from "./contact-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  return { db, repo: new SqliteContactRepository(db) };
}

function row(over: Partial<NewContactMessageRow> = {}): NewContactMessageRow {
  return {
    id: crypto.randomUUID(),
    reference: "C-ABCDEFGH",
    sessionId: S1,
    name: "N",
    email: "a@b.co",
    topic: "other",
    orderId: null,
    productSlug: null,
    message: "hello there friend",
    createdAt: "2026-11-07T12:00:00.000Z",
    ...over,
  };
}

describe("SqliteContactRepository", () => {
  test("insert + referenceExists + getOwnedByReference (owner only)", () => {
    const { repo } = setup();
    repo.insert(row());
    expect(repo.referenceExists("C-ABCDEFGH")).toBe(true);
    expect(repo.referenceExists("C-ZZZZZZZZ")).toBe(false);
    expect(repo.getOwnedByReference(S1, "C-ABCDEFGH")?.message).toBe("hello there friend");
    expect(repo.getOwnedByReference(S2, "C-ABCDEFGH")).toBeNull();
    expect(repo.getOwnedByReference("bogus", "C-ABCDEFGH")).toBeNull();
  });

  test("insert accepts null session, rejects a non-UUID session, and enforces UNIQUE reference", () => {
    const { repo } = setup();
    repo.insert(row({ sessionId: null, reference: "C-00000001" }));
    expect(() => repo.insert(row({ sessionId: "bogus", reference: "C-00000002" }))).toThrow(TypeError);
    repo.insert(row({ reference: "C-00000003" }));
    expect(() => repo.insert(row({ reference: "C-00000003" }))).toThrow();
  });

  test("hasRecentDuplicate respects session, message and time", () => {
    const { repo } = setup();
    repo.insert(row());
    expect(repo.hasRecentDuplicate(S1, "hello there friend", "2026-11-07T11:50:00.000Z")).toBe(true);
    expect(repo.hasRecentDuplicate(S1, "hello there friend", "2026-11-07T12:00:00.001Z")).toBe(false);
    expect(repo.hasRecentDuplicate(S2, "hello there friend", "2026-11-07T11:50:00.000Z")).toBe(false);
    expect(repo.hasRecentDuplicate(S1, "other", "2026-11-07T11:50:00.000Z")).toBe(false);
    expect(repo.hasRecentDuplicate("bogus", "hello there friend", "2000-01-01T00:00:00.000Z")).toBe(false);
  });

  test("listForSession: own rows, newest first, limit, ties by insertion order", () => {
    const { repo } = setup();
    repo.insert(row({ reference: "C-00000001", createdAt: "2026-11-07T10:00:00.000Z" }));
    repo.insert(row({ reference: "C-00000002", createdAt: "2026-11-07T11:00:00.000Z" }));
    repo.insert(row({ reference: "C-00000003", createdAt: "2026-11-07T11:00:00.000Z" }));
    repo.insert(row({ reference: "C-00000004", sessionId: S2 }));
    expect(repo.listForSession(S1, 10).map((r) => r.reference)).toEqual(["C-00000003", "C-00000002", "C-00000001"]);
    expect(repo.listForSession(S1, 1)).toHaveLength(1);
    expect(repo.listForSession("bogus", 10)).toEqual([]);
  });

  test("isOrderOwnedBy and productSlugExists", () => {
    const { db, repo } = setup();
    db.query(
      `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email,
         line1, city, region, postal_code, country, card_last4, idempotency_key)
       VALUES ('o1', ?, 'paid', 1, 1, 'USD', 'A', 'a@b.co', 'l', 'c', 'r', 'p', 'US', '4242', 'k1')`,
    ).run(S1);
    expect(repo.isOrderOwnedBy(S1, "o1")).toBe(true);
    expect(repo.isOrderOwnedBy(S2, "o1")).toBe(false);
    expect(repo.isOrderOwnedBy(S1, "o2")).toBe(false);
    expect(repo.isOrderOwnedBy("bogus", "o1")).toBe(false);
    const slug = SEED_CATALOG_PRODUCTS[0]?.slug ?? "";
    const now = new Date().toISOString();
    expect(repo.productSlugExists(slug, now)).toBe(true);
    expect(repo.productSlugExists("nope", now)).toBe(false);
    db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE slug = ?").run(slug);
    expect(repo.productSlugExists(slug, now)).toBe(false);
    expect(repo.productSlugExists(slug, "2999-01-01T00:00:00.000Z")).toBe(true);
    expect(repo.productSlugExists(slug, "2998-12-31T23:59:59.999Z")).toBe(false);
  });
});
