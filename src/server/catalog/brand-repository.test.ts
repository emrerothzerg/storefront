import { describe, expect, test } from "bun:test";
import { createDatabase } from "../db/client";
import { runMigrations } from "../db/schema";
import { SqliteBrandRepository } from "./brand-repository";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  db.run("INSERT INTO brands (id, slug, name, description) VALUES ('b2', 'zeta', 'Zeta', 'Z'), ('b1', 'alpha', 'Alpha', 'A')");
  const p = db.query("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, brand_id) VALUES (?, ?, ?, 1, 'USD', '/x', 1, ?)");
  p.run("p1", "p1", "P1", "b1");
  p.run("p2", "p2", "P2", "b1");
  p.run("p3", "p3", "P3", null);
  return new SqliteBrandRepository(db);
}

describe("SqliteBrandRepository", () => {
  test("list is ordered by name and maps to Brand", () => {
    expect(setup().list()).toEqual([
      { id: "b1", slug: "alpha", name: "Alpha", description: "A" },
      { id: "b2", slug: "zeta", name: "Zeta", description: "Z" },
    ]);
  });

  test("listWithCounts counts products per brand", () => {
    expect(setup().listWithCounts().map((b) => [b.slug, b.productCount])).toEqual([["alpha", 2], ["zeta", 0]]);
  });

  test("listWithCounts counts only products published at the injected now", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    db.run("INSERT INTO brands (id, slug, name, description) VALUES ('b1', 'alpha', 'Alpha', 'A'), ('b2', 'zeta', 'Zeta', 'Z')");
    const p = db.query(
      "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, brand_id, published_at) VALUES (?, ?, ?, 1, 'USD', '/x', 1, ?, ?)",
    );
    const NOW = Date.parse("2026-11-07T12:00:00.000Z");
    p.run("past", "past", "Past", "b1", "2026-11-01T00:00:00.000Z");
    p.run("exact", "exact", "Exact", "b1", "2026-11-07T12:00:00.000Z");
    p.run("future", "future", "Future", "b1", "2026-11-07T12:00:00.001Z");
    p.run("future-z", "future-z", "Future Z", "b2", "2099-01-01T00:00:00.000Z");
    p.run("blank", "blank", "Blank", "b2", "2026-01-01T00:00:00.000Z");
    db.run("UPDATE products SET published_at = '' WHERE id = 'blank'");
    const repo = new SqliteBrandRepository(db);
    const counts = (now?: number) => repo.listWithCounts(now).map((b) => [b.slug, b.productCount]);
    expect(counts(NOW)).toEqual([["alpha", 2], ["zeta", 0]]);
    expect(counts(NOW + 1)).toEqual([["alpha", 3], ["zeta", 0]]);
    expect(counts(Date.parse("2100-01-01T00:00:00.000Z"))).toEqual([["alpha", 3], ["zeta", 1]]);
    // omitted / invalid now -> the real clock (zeta's 2099 product stays out)
    const realClock = counts(Date.now());
    expect(realClock[1]).toEqual(["zeta", 0]);
    for (const odd of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1e20]) expect(counts(odd)).toEqual(realClock);
  });

  test("getBySlug / getById return null for unknown or hostile input", () => {
    const repo = setup();
    expect(repo.getBySlug("zeta")?.id).toBe("b2");
    expect(repo.getById("b1")?.slug).toBe("alpha");
    for (const odd of ["nope", "", "' OR 1=1 --", "%", "ALPHA"]) expect(repo.getBySlug(odd)).toBeNull();
    expect(repo.getById("nope")).toBeNull();
  });

  test("empty table gives []", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    expect(new SqliteBrandRepository(db).list()).toEqual([]);
  });
});

describe("SqliteBrandRepository.listSlugsWithUpdatedAt (CONS-B4 bm)", () => {
  test("every brand's slug and updated_at, ordered by slug", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    db.run(
      "INSERT INTO brands (id, slug, name, description, updated_at) VALUES ('b2', 'zeta', 'Zeta', 'Z', '2026-11-02T00:00:00.000Z'), ('b1', 'alpha', 'Alpha', 'A', '2026-11-01T00:00:00.000Z')",
    );
    expect(new SqliteBrandRepository(db).listSlugsWithUpdatedAt()).toEqual([
      { slug: "alpha", updatedAt: "2026-11-01T00:00:00.000Z" },
      { slug: "zeta", updatedAt: "2026-11-02T00:00:00.000Z" },
    ]);
  });

  test("empty table -> []", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    expect(new SqliteBrandRepository(db).listSlugsWithUpdatedAt()).toEqual([]);
  });
});
