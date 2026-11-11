import { describe, expect, test } from "bun:test";
import { createDatabase } from "../db/client";
import { runMigrations } from "../db/schema";
import { SEED_CATALOG_STATS, seedCatalogProducts } from "../db/seed";
import { SqliteCategoryRepository } from "./category-repository";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const add = db.query("INSERT INTO categories (id, slug, name, parent_id, sort_order) VALUES (?, ?, ?, ?, ?)");
  add.run("d2", "garden", "Garden", null, 2);
  add.run("d1", "home", "Home", null, 1);
  add.run("c2", "pans", "Pans", "d1", 2);
  add.run("c1", "mugs", "Mugs", "d1", 1);
  add.run("c3", "tools", "Tools", "d2", 1);
  const p = db.query("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, category_id) VALUES (?, ?, ?, 1, 'USD', '/x', 1, ?)");
  p.run("p1", "p1", "P1", "c1");
  p.run("p2", "p2", "P2", "c1");
  p.run("p3", "p3", "P3", "c2");
  p.run("p4", "p4", "P4", "d1"); // directly in a department
  p.run("p5", "p5", "P5", null);
  return { db, repo: new SqliteCategoryRepository(db) };
}

describe("SqliteCategoryRepository", () => {
  test("listDepartments and listChildren are ordered by sort_order", () => {
    const { repo } = setup();
    expect(repo.listDepartments().map((c) => c.slug)).toEqual(["home", "garden"]);
    expect(repo.listChildren("d1").map((c) => c.slug)).toEqual(["mugs", "pans"]);
    expect(repo.listChildren("c1")).toEqual([]);
    expect(repo.listChildren("nope")).toEqual([]);
  });

  test("getBySlug / getById map to domain objects or null", () => {
    const { repo } = setup();
    expect(repo.getBySlug("mugs")).toEqual({
      id: "c1", slug: "mugs", name: "Mugs", description: "", parentId: "d1", sortOrder: 1, imageUrl: null,
    });
    expect(repo.getById("d1")?.parentId).toBeNull();
    for (const odd of ["nope", "", "' OR 1=1 --", "%", "MUGS"]) expect(repo.getBySlug(odd)).toBeNull();
  });

  test("getPath gives department -> category breadcrumbs", () => {
    const { repo } = setup();
    expect(repo.getPath("c2").map((c) => c.slug)).toEqual(["home", "pans"]);
    expect(repo.getPath("d2").map((c) => c.slug)).toEqual(["garden"]);
    expect(repo.getPath("nope")).toEqual([]);
  });

  test("listAllWithCounts: departments then their children; department counts include children", () => {
    const { repo } = setup();
    expect(repo.listAllWithCounts().map((c) => [c.slug, c.productCount])).toEqual([
      ["home", 4], ["mugs", 2], ["pans", 1], ["garden", 0], ["tools", 0],
    ]);
  });

  test("works on the seeded catalogue: 8 departments, 24 categories, every seed product (published or not)", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedCatalogProducts(db);
    const repo = new SqliteCategoryRepository(db);
    expect(repo.listDepartments()).toHaveLength(8);
    const all = repo.listAllWithCounts();
    expect(all).toHaveLength(32);
    const departments = all.filter((c) => c.parentId === null);
    expect(departments.reduce((s, d) => s + d.productCount, 0)).toBe(SEED_CATALOG_STATS.total);
    expect(repo.getPath("cat_audio").map((c) => c.name)).toEqual(["Electronics", "Headphones & Audio"]);
  });
});

describe("SqliteCategoryRepository.listSlugsWithUpdatedAt (CONS-B4 bm)", () => {
  test("departments and children, ordered by slug, with updated_at", () => {
    const { db, repo } = setup();
    db.run("UPDATE categories SET updated_at = '2026-11-03T00:00:00.000Z' WHERE slug = 'mugs'");
    const rows = repo.listSlugsWithUpdatedAt();
    expect(rows.map((r) => r.slug)).toEqual(["garden", "home", "mugs", "pans", "tools"]);
    expect(rows.find((r) => r.slug === "mugs")?.updatedAt).toBe("2026-11-03T00:00:00.000Z");
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["slug", "updatedAt"]);
      expect(typeof r.updatedAt).toBe("string");
      expect(r.updatedAt).not.toBe("");
    }
  });

  test("empty table -> []", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    expect(new SqliteCategoryRepository(db).listSlugsWithUpdatedAt()).toEqual([]);
  });
});
