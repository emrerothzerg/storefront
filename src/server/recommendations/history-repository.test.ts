import { describe, expect, test } from "bun:test";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteHistoryRepository } from "./history-repository";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T = (s: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, s)).toISOString();
const NOW = T(59);

function setup(n = 6) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const ins = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at) VALUES (?, ?, ?, 100, 'USD', '/x.svg', ?, ?)",
  );
  for (let i = 1; i <= n; i += 1) ins.run(`p${i}`, `p${i}`, `P${i}`, 5, T(0));
  return { db, repo: new SqliteHistoryRepository(db) };
}

describe("SqliteHistoryRepository", () => {
  test("productExists", () => {
    const { repo } = setup();
    expect(repo.productExists("p1")).toBe(true);
    expect(repo.productExists("nope")).toBe(false);
    expect(repo.productExists("' OR 1=1 --")).toBe(false);
  });

  test("recordView upserts and trims to the cap, keeping the newest", () => {
    const { repo } = setup();
    repo.recordView(S1, "p1", T(1), 3);
    repo.recordView(S1, "p2", T(2), 3);
    repo.recordView(S1, "p3", T(3), 3);
    repo.recordView(S1, "p1", T(4), 3); // upsert, still 3 rows
    expect(repo.countViews(S1)).toBe(3);
    repo.recordView(S1, "p4", T(5), 3); // drops p2 (oldest)
    expect(repo.listAvailableViews(S1, NOW, 10)).toEqual([
      { productId: "p4", viewedAt: T(5) },
      { productId: "p1", viewedAt: T(4) },
      { productId: "p3", viewedAt: T(3) },
    ]);
  });

  test("the row just written is kept even if its timestamp is the oldest", () => {
    const { repo } = setup();
    repo.recordView(S1, "p1", T(10), 2);
    repo.recordView(S1, "p2", T(11), 2);
    repo.recordView(S1, "p3", T(1), 2);
    expect(repo.listAvailableViews(S1, NOW, 10).map((v) => v.productId)).toEqual(["p2", "p3"]);
  });

  test("equal timestamps order by product id; sessions are isolated", () => {
    const { repo } = setup();
    repo.recordView(S1, "p2", T(1), 50);
    repo.recordView(S1, "p1", T(1), 50);
    repo.recordView(S2, "p3", T(1), 50);
    expect(repo.listAvailableViews(S1, NOW, 10).map((v) => v.productId)).toEqual(["p1", "p2"]);
    expect(repo.listAvailableViews(S2, NOW, 10).map((v) => v.productId)).toEqual(["p3"]);
  });

  test("listAvailableViews skips out-of-stock and unpublished products and honours limit", () => {
    const { db, repo } = setup();
    for (let i = 1; i <= 4; i += 1) repo.recordView(S1, `p${i}`, T(i), 50);
    db.query("UPDATE products SET stock = 0 WHERE id = 'p4'").run();
    db.query("UPDATE products SET published_at = ? WHERE id = 'p3'").run(T(59).replace("2026", "2027"));
    expect(repo.listAvailableViews(S1, NOW, 10).map((v) => v.productId)).toEqual(["p2", "p1"]);
    expect(repo.listAvailableViews(S1, NOW, 1).map((v) => v.productId)).toEqual(["p2"]);
    expect(repo.countViews(S1)).toBe(4);
  });

  test("removeView and clearViews", () => {
    const { repo } = setup();
    repo.recordView(S1, "p1", T(1), 50);
    repo.recordView(S1, "p2", T(2), 50);
    repo.recordView(S2, "p1", T(3), 50);
    repo.removeView(S1, "p1");
    expect(repo.countViews(S1)).toBe(1);
    repo.clearViews(S1);
    expect(repo.countViews(S1)).toBe(0);
    expect(repo.countViews(S2)).toBe(1);
  });

  test("recordView on an unknown product violates the FK and writes nothing", () => {
    const { repo } = setup();
    expect(() => repo.recordView(S1, "nope", T(1), 50)).toThrow();
    expect(repo.countViews(S1)).toBe(0);
  });
});
