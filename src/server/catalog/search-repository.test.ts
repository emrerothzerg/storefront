import { describe, expect, test } from "bun:test";
import { createDatabase } from "../db/client";
import { runMigrations } from "../db/schema";
import { SqliteSearchRepository } from "./search-repository";

const NOW = "2026-06-01T00:00:00.000Z";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  db.run("INSERT INTO brands (id, slug, name) VALUES ('b1', 'acme', 'Acme'), ('b2', 'later', 'Later Co')");
  db.run("INSERT INTO categories (id, slug, name) VALUES ('d1', 'dept', 'Dept'), ('d2', 'empty-dept', 'Empty Dept')");
  db.run("INSERT INTO categories (id, slug, name, parent_id) VALUES ('c1', 'leaf', 'Leaf', 'd1')");
  const insert = db.query(
    `INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock, brand_id, category_id, bullets, published_at)
     VALUES (?, ?, ?, ?, 100, 'USD', '/x.svg', ?, ?, ?, ?, ?)`,
  );
  insert.run("p2", "p2", "Comet Lamp", "bright", 0, "b1", "c1", '["Dimmable glow"]', "2026-01-01T00:00:00.000Z");
  insert.run("p1", "p1", "Comet Lamp Pro", "brighter", 3, "b1", "c1", "not json", "2026-01-02T00:00:00.000Z");
  insert.run("p3", "p3", "Comet Lamp Future", "soon", 3, "b2", "c1", "[]", "2027-01-01T00:00:00.000Z");
  return { db, repo: new SqliteSearchRepository(db) };
}

describe("SqliteSearchRepository", () => {
  test("countMatches / findMatchIds exclude unpublished and honour inStockOnly", () => {
    const { repo } = setup();
    const filter = { match: '"comet"*', nowIso: NOW, inStockOnly: false };
    expect(repo.countMatches(filter)).toBe(2);
    expect([...repo.findMatchIds(filter, 10, 0)].sort()).toEqual(["p1", "p2"]);
    expect(repo.countMatches({ ...filter, inStockOnly: true })).toBe(1);
    expect(repo.findMatchIds({ ...filter, inStockOnly: true }, 10, 0)).toEqual(["p1"]);
    expect(repo.findMatchIds(filter, 1, 1)).toHaveLength(1);
    expect(repo.findMatchIds(filter, 10, 5)).toEqual([]);
  });

  test("equal rank ties are broken by product id", () => {
    const { db, repo } = setup();
    db.run("UPDATE products SET name = 'Comet Lamp', description = 'same' WHERE id IN ('p1', 'p2')");
    db.run("UPDATE products SET bullets = '[]' WHERE id IN ('p1', 'p2')");
    expect(repo.findMatchIds({ match: '"comet"', nowIso: NOW, inStockOnly: false }, 10, 0)).toEqual(["p1", "p2"]);
  });

  test("browse: countPublished / listPublishedIds order by id", () => {
    const { repo } = setup();
    expect(repo.countPublished({ nowIso: NOW, inStockOnly: false })).toBe(2);
    expect(repo.listPublishedIds({ nowIso: NOW, inStockOnly: false }, 10, 0)).toEqual(["p1", "p2"]);
    expect(repo.listPublishedIds({ nowIso: NOW, inStockOnly: true }, 10, 0)).toEqual(["p1"]);
    expect(repo.countPublished({ nowIso: "2027-01-01T00:00:00.000Z", inStockOnly: false })).toBe(3);
  });

  test("suggestProducts ignores stock but not publication", () => {
    const { repo } = setup();
    expect(repo.suggestProducts('"comet"*', NOW, 10).map((r) => r.slug).sort()).toEqual(["p1", "p2"]);
    expect(repo.suggestProducts('"comet"*', NOW, 1)).toHaveLength(1);
  });

  test("categories and brands only when they have published products", () => {
    const { repo } = setup();
    expect(repo.listCategoriesWithPublished(NOW)).toEqual([
      { slug: "dept", name: "Dept" },
      { slug: "leaf", name: "Leaf" },
    ]);
    expect(repo.listBrandsWithPublished(NOW)).toEqual([{ slug: "acme", name: "Acme" }]);
  });

  test("vocabulary and published text", () => {
    const { repo } = setup();
    const vocab = repo.listVocabulary();
    expect(vocab.find((v) => v.term === "comet")?.doc).toBe(3);
    const text = repo.listPublishedText(NOW);
    expect(text).toHaveLength(2);
    expect(text[0]).toEqual({
      name: "Comet Lamp Pro",
      brand_name: "Acme",
      category_name: "Leaf",
      description: "brighter",
      bullets: "",
      department_name: "Dept",
    });
  });

  test("a malformed MATCH throws at this layer (the service never builds one)", () => {
    const { repo } = setup();
    expect(() => repo.countMatches({ match: '"unterminated', nowIso: NOW, inStockOnly: false })).toThrow();
  });
});
