import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedProducts } from "@/server/db/seed";
import { addressDedupeKey, createMergeRepository, dedupeListName, truncateCodePoints, type DroppedCartLine } from "./merge-repository";
import { MERGE_LIMITS } from "./merge-service";

const G = "11111111-1111-4111-8111-111111111111";
const K = "22222222-2222-4222-8222-222222222222";
const NOW = "2027-01-15T08:00:00.000Z";

function makeDb(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedProducts(db);
  return db;
}

function firstProducts(db: Database, n: number): string[] {
  return db
    .query<{ id: string }, [number]>("SELECT id FROM products WHERE stock > 0 ORDER BY id LIMIT ?")
    .all(n)
    .map((r) => r.id);
}

describe("truncateCodePoints", () => {
  test("keeps short strings unchanged", () => {
    expect(truncateCodePoints("Gifts", 60)).toBe("Gifts");
  });
  test("cuts by code points, never splitting surrogate pairs, and trims the end", () => {
    expect(truncateCodePoints("ab😀cd", 3)).toBe("ab😀");
    expect(truncateCodePoints("ab cd", 3)).toBe("ab");
  });
});

describe("dedupeListName (R-4)", () => {
  test("free name is kept", () => {
    expect(dedupeListName("Gifts", new Set(["other"]), 60)).toBe("Gifts");
  });
  test("clash gets ' (2)', then ' (3)'; existing suffix is stripped before numbering", () => {
    const taken = new Set(["gifts"]);
    const second = dedupeListName("Gifts", taken, 60);
    expect(second).toBe("Gifts (2)");
    taken.add(second.toLowerCase());
    expect(dedupeListName("Gifts (2)", taken, 60)).toBe("Gifts (3)");
  });
  test("comparison is case-insensitive", () => {
    expect(dedupeListName("GIFTS", new Set(["gifts"]), 60)).toBe("GIFTS (2)");
  });
  test("60-code-point name with suffix stays within 60 code points", () => {
    const long = "x".repeat(60);
    const name = dedupeListName(long, new Set([long]), 60);
    expect(name).toBe(`${"x".repeat(56)} (2)`);
    expect(Array.from(name).length).toBe(60);
  });
  test("astral characters are counted as one code point", () => {
    const long = "😀".repeat(60);
    const name = dedupeListName(long, new Set([long]), 60);
    expect(Array.from(name).length).toBe(60);
    expect(name.endsWith(" (2)")).toBe(true);
  });
  test("names over the max are cut even without a clash", () => {
    expect(Array.from(dedupeListName("y".repeat(80), new Set(), 60)).length).toBe(60);
  });
});

describe("addressDedupeKey", () => {
  const base = { full_name: "Ada Lovelace", line1: "1 Main  St", postal_code: "AB1 2CD", country: "GB" };
  test("ignores case and whitespace runs", () => {
    expect(addressDedupeKey(base)).toBe(
      addressDedupeKey({ full_name: "  ada   LOVELACE ", line1: "1 MAIN st", postal_code: "ab1  2cd", country: "gb" }),
    );
  });
  test("differs when any key field differs", () => {
    expect(addressDedupeKey(base)).not.toBe(addressDedupeKey({ ...base, line1: "2 Main St" }));
    expect(addressDedupeKey(base)).not.toBe(addressDedupeKey({ ...base, country: "IE" }));
  });
});

describe("mergeCart step", () => {
  test("no guest cart: no writes, user cart not created", () => {
    const db = makeDb();
    const r = createMergeRepository(db).mergeCart(G, K, NOW);
    expect(r).toEqual({ movedCartLines: 0, droppedCartLines: [] });
    expect(db.query("SELECT COUNT(*) AS n FROM carts").get()).toEqual({ n: 0 });
  });

  test("user without a cart gets a new row carrying the guest's selection; guest cart deleted", () => {
    const db = makeDb();
    const [p] = firstProducts(db, 1);
    db.run("INSERT INTO carts (session_id, coupon_code, shipping_method_id) VALUES (?, 'SAVE5', 'express')", [G]);
    db.run("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, 1)", [G, p ?? ""]);
    const r = createMergeRepository(db).mergeCart(G, K, NOW);
    expect(r.movedCartLines).toBe(1);
    expect(db.query("SELECT session_id, coupon_code, shipping_method_id FROM carts").all()).toEqual([
      { session_id: K, coupon_code: "SAVE5", shipping_method_id: "express" },
    ]);
    expect(db.query("SELECT cart_session_id, quantity FROM cart_items").all()).toEqual([{ cart_session_id: K, quantity: 1 }]);
  });

  test("user's shipping kept; guest shipping used only when the user's is NULL", () => {
    const db = makeDb();
    db.run("INSERT INTO carts (session_id, coupon_code, shipping_method_id) VALUES (?, NULL, 'express')", [G]);
    db.run("INSERT INTO carts (session_id, coupon_code, shipping_method_id) VALUES (?, NULL, 'standard')", [K]);
    createMergeRepository(db).mergeCart(G, K, NOW);
    expect(db.query("SELECT shipping_method_id FROM carts WHERE session_id = ?").get(K)).toEqual({
      shipping_method_id: "standard",
    });
  });
});

describe("mergeCart step: unpublished products (R-CART-1)", () => {
  const FUTURE = "2027-01-15T08:00:00.001Z"; // 1 ms after NOW
  const setPublishedAt = (db: Database, id: string, at: string): void => {
    db.run("UPDATE products SET published_at = ? WHERE id = ?", [at, id]);
  };
  const cartOf = (db: Database, key: string): unknown =>
    db.query("SELECT product_id, quantity FROM cart_items WHERE cart_session_id = ? ORDER BY product_id").all(key);
  const sorted = <T extends { product_id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => (a.product_id < b.product_id ? -1 : 1));

  test("unpublished (published_at empty) and future-dated guest lines are dropped as unknown_product; a published one is merged", () => {
    const db = makeDb();
    const [unpublished, future, live, edge] = firstProducts(db, 4);
    if (unpublished === undefined || future === undefined || live === undefined || edge === undefined) throw new Error("products");
    setPublishedAt(db, unpublished, "");
    setPublishedAt(db, future, FUTURE);
    setPublishedAt(db, edge, NOW); // published exactly at the merge clock: inclusive
    db.run("INSERT INTO carts (session_id) VALUES (?)", [G]);
    for (const id of [unpublished, future, live, edge]) {
      db.run("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, 2)", [G, id]);
    }
    const r = createMergeRepository(db).mergeCart(G, K, NOW);
    expect(r.movedCartLines).toBe(2);
    const byId = (a: DroppedCartLine, b: DroppedCartLine): number => (a.productId < b.productId ? -1 : 1);
    const expectedDropped: DroppedCartLine[] = [
      { productId: unpublished, reason: "unknown_product" },
      { productId: future, reason: "unknown_product" },
    ];
    expect([...r.droppedCartLines].sort(byId)).toEqual(expectedDropped.sort(byId));
    expect(cartOf(db, K)).toEqual(sorted([{ product_id: live, quantity: 2 }, { product_id: edge, quantity: 2 }]));
    // Dropped lines are not left behind under the guest id.
    expect(db.query("SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ?").get(G)).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM carts WHERE session_id = ?").get(G)).toEqual({ n: 0 });
  });

  test("publication is judged at the injected clock, not wall time", () => {
    const db = makeDb();
    const [p] = firstProducts(db, 1);
    if (p === undefined) throw new Error("products");
    setPublishedAt(db, p, FUTURE);
    db.run("INSERT INTO carts (session_id) VALUES (?)", [G]);
    db.run("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, 1)", [G, p]);
    const later = createMergeRepository(db).mergeCart(G, K, "2027-01-15T08:00:00.002Z");
    expect(later.movedCartLines).toBe(1);
    expect(later.droppedCartLines).toEqual([]);
  });

  test("both carts hold the same product: guest copy dropped when unpublished, user's line untouched (no sum)", () => {
    const db = makeDb();
    const [p] = firstProducts(db, 1);
    if (p === undefined) throw new Error("products");
    setPublishedAt(db, p, FUTURE);
    db.run("INSERT INTO carts (session_id) VALUES (?), (?)", [G, K]);
    db.run("INSERT INTO cart_items (cart_session_id, product_id, quantity, updated_at) VALUES (?, ?, 3, 'u0'), (?, ?, 4, 'u0')", [
      G,
      p,
      K,
      p,
    ]);
    const r = createMergeRepository(db).mergeCart(G, K, NOW);
    expect(r).toEqual({ movedCartLines: 0, droppedCartLines: [{ productId: p, reason: "unknown_product" }] });
    expect(db.query("SELECT quantity, updated_at FROM cart_items WHERE cart_session_id = ?").all(K)).toEqual([
      { quantity: 4, updated_at: "u0" },
    ]);
    expect(db.query("SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ?").get(G)).toEqual({ n: 0 });
  });

  test("both carts hold the same published product: summed and still capped at 99 (D-T117-1)", () => {
    const db = makeDb();
    const [p] = firstProducts(db, 1);
    if (p === undefined) throw new Error("products");
    db.run("UPDATE products SET stock = 500 WHERE id = ?", [p]);
    db.run("INSERT INTO carts (session_id) VALUES (?), (?)", [G, K]);
    db.run("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, 60), (?, ?, 60)", [G, p, K, p]);
    const r = createMergeRepository(db).mergeCart(G, K, NOW);
    expect(r).toEqual({ movedCartLines: 1, droppedCartLines: [] });
    expect(cartOf(db, K)).toEqual([{ product_id: p, quantity: 99 }]);
  });

  test("wishlist and save-for-later items are not filtered by publication (lists keep withdrawn products)", () => {
    const db = makeDb();
    const [a, b] = firstProducts(db, 2);
    if (a === undefined || b === undefined) throw new Error("products");
    setPublishedAt(db, a, "");
    setPublishedAt(db, b, FUTURE);
    db.run("INSERT INTO lists (id, session_id, name, kind, is_default) VALUES ('wl', ?, 'Shopping List', 'wishlist', 1)", [G]);
    db.run("INSERT INTO lists (id, session_id, name, kind, is_default) VALUES ('sfl', ?, 'Saved for later', 'save_for_later', 0)", [G]);
    db.run("INSERT INTO list_items (list_id, product_id, price_at_add_cents) VALUES ('wl', ?, 100), ('sfl', ?, 100)", [a, b]);
    createMergeRepository(db).mergeLists(G, K, NOW, MERGE_LIMITS);
    expect(
      db.query("SELECT l.kind, i.product_id FROM list_items i JOIN lists l ON l.id = i.list_id WHERE l.session_id = ? ORDER BY l.kind").all(K),
    ).toEqual([
      { kind: "save_for_later", product_id: b },
      { kind: "wishlist", product_id: a },
    ]);
  });
});

describe("mergeViews step", () => {
  test("overlap keeps MAX(viewed_at)", () => {
    const db = makeDb();
    const [p] = firstProducts(db, 1);
    db.run("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)", [G, p ?? "", "2027-01-02T00:00:00.000Z"]);
    db.run("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)", [K, p ?? "", "2027-01-01T00:00:00.000Z"]);
    const r = createMergeRepository(db).mergeViews(G, K, MERGE_LIMITS);
    expect(r).toEqual({ moved: 1, dropped: 0 });
    expect(db.query("SELECT session_id, viewed_at FROM product_views").all()).toEqual([
      { session_id: K, viewed_at: "2027-01-02T00:00:00.000Z" },
    ]);
  });

  test("older guest view does not overwrite a newer user view", () => {
    const db = makeDb();
    const [p] = firstProducts(db, 1);
    db.run("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)", [G, p ?? "", "2027-01-01T00:00:00.000Z"]);
    db.run("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)", [K, p ?? "", "2027-01-03T00:00:00.000Z"]);
    createMergeRepository(db).mergeViews(G, K, MERGE_LIMITS);
    expect(db.query("SELECT viewed_at FROM product_views WHERE session_id = ?").get(K)).toEqual({
      viewed_at: "2027-01-03T00:00:00.000Z",
    });
  });

  test("no guest views: user's history is not trimmed even if it is over the cap", () => {
    const db = makeDb();
    const ps = firstProducts(db, 3);
    for (const p of ps) db.run("INSERT INTO product_views (session_id, product_id) VALUES (?, ?)", [K, p]);
    const r = createMergeRepository(db).mergeViews(G, K, { ...MERGE_LIMITS, maxViews: 1 });
    expect(r).toEqual({ moved: 0, dropped: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM product_views").get()).toEqual({ n: 3 });
  });
});

describe("mergeCouponRedemptions step", () => {
  test("conflict deletes the guest row; others re-keyed", () => {
    const db = makeDb();
    db.run("INSERT INTO coupons (code, kind, value) VALUES ('C1', 'percent', 10), ('C2', 'percent', 10)");
    db.run("INSERT INTO coupon_redemptions (coupon_code, session_id) VALUES ('C1', ?), ('C2', ?), ('C1', ?)", [G, G, K]);
    const r = createMergeRepository(db).mergeCouponRedemptions(G, K);
    expect(r).toEqual({ moved: 1, dropped: 1 });
    expect(
      db.query("SELECT coupon_code, session_id FROM coupon_redemptions ORDER BY coupon_code").all(),
    ).toEqual([
      { coupon_code: "C1", session_id: K },
      { coupon_code: "C2", session_id: K },
    ]);
  });
});
