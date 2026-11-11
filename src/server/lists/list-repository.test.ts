import { describe, expect, test } from "bun:test";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { ListRepository } from "./list-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T = "2030-01-01T00:00:00.000Z";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES ('p1', 'p1', 'P1', 500, 'USD', '/p1.svg', 3)",
  ).run();
  return { db, repo: new ListRepository(db) };
}

describe("ListRepository", () => {
  test("reads with invalid session ids return empty results without querying", () => {
    const { repo } = setup();
    expect(repo.listBySession("bad")).toEqual([]);
    expect(repo.findOwned("bad", "x")).toBeNull();
    expect(repo.findDefault("bad")).toBeNull();
    expect(repo.findSaveForLater("bad")).toBeNull();
    expect(repo.countWishlists("bad")).toBe(0);
    expect(repo.isInDefaultList("bad", "p1")).toBe(false);
    expect(repo.purchasedSinceAdded("bad", "x").size).toBe(0);
  });

  test("writes with invalid session ids throw TypeError", () => {
    const { db, repo } = setup();
    expect(() => repo.insertWishlist("bad", "l1", "n", true, T)).toThrow(TypeError);
    expect(() => repo.insertSaveForLater("bad", "l1", "n", T)).toThrow(TypeError);
    expect(() => repo.rename("bad", "l1", "n", T)).toThrow(TypeError);
    expect(() => repo.delete("bad", "l1")).toThrow(TypeError);
    expect(() => repo.setShare("bad", "l1", null, T)).toThrow(TypeError);
    expect(() => repo.setDefault("bad", "l1", T)).toThrow(TypeError);
    expect(db.query("SELECT COUNT(*) AS n FROM lists").get()).toEqual({ n: 0 });
  });

  test("insertSaveForLater is guarded by the partial unique index", () => {
    const { db, repo } = setup();
    expect(repo.insertSaveForLater(S1, "a", "Saved", T)).toBe(true);
    expect(repo.insertSaveForLater(S1, "b", "Saved", T)).toBe(false);
    expect(repo.insertSaveForLater(S2, "c", "Saved", T)).toBe(true);
    expect(db.query("SELECT id FROM lists ORDER BY id").all()).toEqual([{ id: "a" }, { id: "c" }]);
    // Wishlists are not restricted by that index.
    repo.insertWishlist(S1, "w1", "A", true, T);
    repo.insertWishlist(S1, "w2", "B", false, T);
    expect(repo.countWishlists(S1)).toBe(2);
  });

  test("findOwned filters on owner key", () => {
    const { repo } = setup();
    repo.insertWishlist(S1, "w1", "A", true, T);
    expect(repo.findOwned(S1, "w1")?.name).toBe("A");
    expect(repo.findOwned(S2, "w1")).toBeNull();
  });

  test("setDefault leaves exactly one default wishlist and ignores save for later", () => {
    const { db, repo } = setup();
    repo.insertWishlist(S1, "w1", "A", true, T);
    repo.insertWishlist(S1, "w2", "B", false, T);
    repo.insertSaveForLater(S1, "s", "Saved", T);
    repo.setDefault(S1, "w2", "2030-01-02T00:00:00.000Z");
    expect(db.query("SELECT id, is_default FROM lists ORDER BY id").all()).toEqual([
      { id: "s", is_default: 0 },
      { id: "w1", is_default: 0 },
      { id: "w2", is_default: 1 },
    ]);
  });

  test("insertItem is idempotent and updateItem only changes given fields", () => {
    const { repo } = setup();
    repo.insertWishlist(S1, "w1", "A", true, T);
    const item = { productId: "p1", quantityDesired: 2, priority: 1 as const, priceAtAddCents: 500, note: "x", addedAt: T };
    expect(repo.insertItem("w1", item)).toBe(true);
    expect(repo.insertItem("w1", { ...item, quantityDesired: 9 })).toBe(false);
    repo.updateItem("w1", "p1", { priority: 2 });
    expect(repo.getItem("w1", "p1")).toMatchObject({ quantityDesired: 2, priority: 2, note: "x" });
    repo.updateItem("w1", "p1", { note: null });
    expect(repo.getItem("w1", "p1")?.note).toBeNull();
    repo.updateItem("w1", "p1", { quantityDesired: 4 });
    expect(repo.getItem("w1", "p1")).toMatchObject({ quantityDesired: 4, priority: 2, note: null });
  });

  test("findByShareToken matches only public lists", () => {
    const { repo } = setup();
    repo.insertWishlist(S1, "w1", "A", true, T);
    repo.setShare(S1, "w1", "tok_tok_tok_tok_tok_12", T);
    expect(repo.findByShareToken("tok_tok_tok_tok_tok_12")?.id).toBe("w1");
    expect(repo.findByShareTokenAny("tok_tok_tok_tok_tok_12")).toBe(true);
    repo.setShare(S1, "w1", null, T);
    expect(repo.findByShareToken("tok_tok_tok_tok_tok_12")).toBeNull();
    expect(repo.findByShareTokenAny("tok_tok_tok_tok_tok_12")).toBe(false);
  });

  test("getPublishedPrice hides unpublished products", () => {
    const { db, repo } = setup();
    expect(repo.getPublishedPrice("p1", T)).toBe(500);
    db.query("UPDATE products SET published_at = '2031-01-01T00:00:00.000Z'").run();
    expect(repo.getPublishedPrice("p1", T)).toBeNull();
    expect(repo.getPublishedPrice("nope", T)).toBeNull();
  });
});
