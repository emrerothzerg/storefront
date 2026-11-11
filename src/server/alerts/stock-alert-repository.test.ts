import { describe, expect, test } from "bun:test";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteStockAlertRepository } from "./stock-alert-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const insert = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, 100, 'USD', '/x.svg', 0)",
  );
  for (const id of ["a", "b", "c"]) insert.run(id, id, id);
  return { db, repo: new SqliteStockAlertRepository(db) };
}

describe("SqliteStockAlertRepository", () => {
  test("insert, find, count, list newest first (ties by insertion order)", () => {
    const { repo } = setup();
    expect(repo.insert(S1, { id: "x1", productId: "a", createdAt: "2026-01-01T00:00:00.000Z" })).toBe(true);
    expect(repo.insert(S1, { id: "x2", productId: "b", createdAt: "2026-01-02T00:00:00.000Z" })).toBe(true);
    expect(repo.insert(S1, { id: "x3", productId: "c", createdAt: "2026-01-02T00:00:00.000Z" })).toBe(true);
    expect(repo.listForSession(S1).map((a) => a.id)).toEqual(["x3", "x2", "x1"]);
    expect(repo.countForSession(S1)).toBe(3);
    expect(repo.findByProduct(S1, "a")).toEqual({
      id: "x1",
      productId: "a",
      createdAt: "2026-01-01T00:00:00.000Z",
      acknowledgedAt: null,
    });
    expect(repo.findById(S1, "x2")?.productId).toBe("b");
  });

  test("rows never carry the session id", () => {
    const { repo } = setup();
    repo.insert(S1, { id: "x1", productId: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    const row = repo.findById(S1, "x1");
    expect(Object.keys(row ?? {}).sort()).toEqual(["acknowledgedAt", "createdAt", "id", "productId"]);
    expect(JSON.stringify(repo.listForSession(S1))).not.toContain(S1);
  });

  test("duplicate (product, session) insert is ignored", () => {
    const { db, repo } = setup();
    repo.insert(S1, { id: "x1", productId: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(repo.insert(S1, { id: "x2", productId: "a", createdAt: "2026-01-02T00:00:00.000Z" })).toBe(false);
    expect(db.query("SELECT COUNT(*) AS n FROM stock_alerts").get()).toEqual({ n: 1 });
    // Same product, another session is fine.
    expect(repo.insert(S2, { id: "x3", productId: "a", createdAt: "2026-01-02T00:00:00.000Z" })).toBe(true);
  });

  test("everything is scoped by session", () => {
    const { repo } = setup();
    repo.insert(S1, { id: "x1", productId: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(repo.listForSession(S2)).toEqual([]);
    expect(repo.findById(S2, "x1")).toBeNull();
    expect(repo.findByProduct(S2, "a")).toBeNull();
    expect(repo.countForSession(S2)).toBe(0);
    expect(repo.delete(S2, "x1")).toBe(false);
    expect(repo.acknowledge(S2, "x1", "2026-02-01T00:00:00.000Z")).toBe(false);
    expect(repo.findById(S1, "x1")?.acknowledgedAt).toBeNull();
  });

  test("acknowledge keeps the first timestamp; delete removes", () => {
    const { repo } = setup();
    repo.insert(S1, { id: "x1", productId: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(repo.acknowledge(S1, "x1", "2026-02-01T00:00:00.000Z")).toBe(true);
    expect(repo.acknowledge(S1, "x1", "2026-03-01T00:00:00.000Z")).toBe(true);
    expect(repo.findById(S1, "x1")?.acknowledgedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(repo.delete(S1, "x1")).toBe(true);
    expect(repo.delete(S1, "x1")).toBe(false);
    expect(repo.countForSession(S1)).toBe(0);
  });

  test("invalid session: reads are empty, writes throw TypeError", () => {
    const { repo } = setup();
    for (const bad of ["", "not-a-uuid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "' OR 1=1 --"]) {
      expect(repo.listForSession(bad)).toEqual([]);
      expect(repo.findById(bad, "x")).toBeNull();
      expect(repo.findByProduct(bad, "a")).toBeNull();
      expect(repo.countForSession(bad)).toBe(0);
      expect(() => repo.insert(bad, { id: "x", productId: "a", createdAt: "2026-01-01T00:00:00.000Z" })).toThrow(TypeError);
      expect(() => repo.delete(bad, "x")).toThrow(TypeError);
      expect(() => repo.acknowledge(bad, "x", "2026-01-01T00:00:00.000Z")).toThrow(TypeError);
    }
  });

  test("hostile ids are bound, not interpolated", () => {
    const { db, repo } = setup();
    repo.insert(S1, { id: "x1", productId: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(repo.delete(S1, "' OR '1'='1")).toBe(false);
    expect(repo.findByProduct(S1, "a' OR '1'='1")).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM stock_alerts").get()).toEqual({ n: 1 });
  });

  test("unknown product id violates the FK", () => {
    const { repo } = setup();
    expect(() => repo.insert(S1, { id: "x1", productId: "nope", createdAt: "2026-01-01T00:00:00.000Z" })).toThrow();
  });

  test("deleting the product cascades its alerts", () => {
    const { db, repo } = setup();
    repo.insert(S1, { id: "x1", productId: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    db.query("DELETE FROM products WHERE id = 'a'").run();
    expect(repo.countForSession(S1)).toBe(0);
  });
});
