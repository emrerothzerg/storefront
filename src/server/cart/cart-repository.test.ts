import { describe, expect, test } from "bun:test";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteCartRepository } from "./cart-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const insert = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, 100, 'USD', '/x.svg', 10)",
  );
  for (const id of ["a", "b"]) insert.run(id, id, id);
  return { db, repo: new SqliteCartRepository(db) };
}

describe("SqliteCartRepository", () => {
  test("getItems is [] without a cart or with an invalid session id", () => {
    const { repo } = setup();
    expect(repo.getItems(S1)).toEqual([]);
    expect(repo.getItems("'; DROP TABLE carts; --")).toEqual([]);
  });

  test("upsert inserts then replaces quantity; lines are ordered by insertion", () => {
    const { repo } = setup();
    repo.ensureCart(S1, "USD");
    repo.upsertItem(S1, "b", 2);
    repo.upsertItem(S1, "a", 1);
    repo.upsertItem(S1, "b", 5);
    expect(repo.getItems(S1)).toEqual([
      { productId: "b", quantity: 5 },
      { productId: "a", quantity: 1 },
    ]);
  });

  test("upsert without ensureCart violates the FK", () => {
    const { repo } = setup();
    expect(() => repo.upsertItem(S1, "a", 1)).toThrow();
  });

  test("ensureCart is idempotent and keeps the original currency", () => {
    const { db, repo } = setup();
    repo.ensureCart(S1, "USD");
    repo.ensureCart(S1, "EUR");
    expect(db.query("SELECT session_id, currency FROM carts").all()).toEqual([{ session_id: S1, currency: "USD" }]);
  });

  test("removeItem and clear are no-ops when absent; clear cascades", () => {
    const { db, repo } = setup();
    repo.removeItem(S1, "a");
    repo.clear(S1);
    repo.ensureCart(S1, "USD");
    repo.upsertItem(S1, "a", 1);
    repo.upsertItem(S1, "b", 1);
    repo.removeItem(S1, "a");
    expect(repo.getItems(S1)).toEqual([{ productId: "b", quantity: 1 }]);
    repo.clear(S1);
    expect(repo.getItems(S1)).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM cart_items").get()).toEqual({ n: 0 });
  });

  test("sessions are isolated", () => {
    const { repo } = setup();
    repo.ensureCart(S1, "USD");
    repo.ensureCart(S2, "USD");
    repo.upsertItem(S1, "a", 3);
    repo.upsertItem(S2, "a", 1);
    repo.clear(S2);
    expect(repo.getItems(S1)).toEqual([{ productId: "a", quantity: 3 }]);
    expect(repo.getItems(S2)).toEqual([]);
  });

  test("writes reject invalid session ids", () => {
    const { repo } = setup();
    expect(() => repo.ensureCart("nope", "USD")).toThrow(TypeError);
    expect(() => repo.upsertItem("nope", "a", 1)).toThrow(TypeError);
    expect(() => repo.removeItem("nope", "a")).toThrow(TypeError);
    expect(() => repo.clear("nope")).toThrow(TypeError);
  });

  test("the schema rejects quantity 0", () => {
    const { repo } = setup();
    repo.ensureCart(S1, "USD");
    expect(() => repo.upsertItem(S1, "a", 0)).toThrow();
  });
});
