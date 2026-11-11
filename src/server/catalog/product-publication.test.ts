import { describe, expect, test } from "bun:test";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteProductRepository, isPublishedAtIso } from "./product-repository";

const NOW_ISO = "2026-11-07T12:00:00.000Z";

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const insert = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at) VALUES (?, ?, ?, 100, 'USD', '/x.svg', 1, ?)",
  );
  insert.run("past", "past", "Past", "2026-11-01T00:00:00.000Z");
  insert.run("exact", "exact", "Exact", NOW_ISO);
  insert.run("future", "future", "Future", "2026-11-07T12:00:00.001Z");
  insert.run("defaulted", "defaulted", "Defaulted", ""); // trigger fills from created_at
  db.run("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES ('blank', 'blank', 'Blank', 1, 'USD', '/x.svg', 1)");
  db.run("UPDATE products SET published_at = '' WHERE id = 'blank'");
  return { db, repo: new SqliteProductRepository(db) };
}

describe("SqliteProductRepository.filterPublishedIds (R-CART-1)", () => {
  test("keeps only existing ids with '' < published_at <= now (inclusive); unknown ids absent", () => {
    const { repo } = setup();
    const result = repo.filterPublishedIds(["past", "exact", "future", "blank", "unknown", "past"], NOW_ISO);
    expect([...result].sort()).toEqual(["exact", "past"]);
  });

  test("an insert without published_at is published from created_at (trigger), judged against the cut-off", () => {
    const { repo } = setup();
    expect(repo.filterPublishedIds(["defaulted"], "2999-01-01T00:00:00.000Z").has("defaulted")).toBe(true);
    expect(repo.filterPublishedIds(["defaulted"], "2000-01-01T00:00:00.000Z").has("defaulted")).toBe(false);
  });

  test("empty input -> empty set; hostile ids are bound, never interpolated", () => {
    const { db, repo } = setup();
    expect(repo.filterPublishedIds([], NOW_ISO).size).toBe(0);
    expect(repo.filterPublishedIds(["'; DROP TABLE products; --", "past"], NOW_ISO)).toEqual(new Set(["past"]));
    expect(db.query("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 5 });
  });

  test("getById is unchanged: still returns unpublished products", () => {
    const { repo } = setup();
    expect(repo.getById("future")?.id).toBe("future");
    expect(repo.getById("blank")?.id).toBe("blank");
  });
});

describe("SqliteProductRepository.getPublishedDetailBySlug (consistency av)", () => {
  const NOW = Date.parse(NOW_ISO);

  test("same rule as filterPublishedIds: '' < published_at <= now (inclusive)", () => {
    const { repo } = setup();
    expect(repo.getPublishedDetailBySlug("past", NOW)?.id).toBe("past");
    expect(repo.getPublishedDetailBySlug("exact", NOW)?.id).toBe("exact");
    expect(repo.getPublishedDetailBySlug("future", NOW)).toBeNull();
    expect(repo.getPublishedDetailBySlug("future", NOW + 1)?.id).toBe("future");
    expect(repo.getPublishedDetailBySlug("blank", NOW)).toBeNull();
    expect(repo.getPublishedDetailBySlug("unknown", NOW)).toBeNull();
    for (const slug of ["past", "exact", "future", "blank"]) {
      expect(repo.getPublishedDetailBySlug(slug, NOW) !== null).toBe(repo.filterPublishedIds([slug], NOW_ISO).has(slug));
    }
  });

  test("returns exactly getDetailBySlug's detail", () => {
    const { repo } = setup();
    expect(repo.getPublishedDetailBySlug("past", NOW)).toEqual(repo.getDetailBySlug("past"));
  });

  test("garbage published_at is unpublished; non-finite or out-of-range now publishes nothing", () => {
    const { db, repo } = setup();
    db.run("UPDATE products SET published_at = 'not a date' WHERE id = 'past'");
    expect(repo.getPublishedDetailBySlug("past", NOW)).toBeNull();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 9e15]) {
      expect(repo.getPublishedDetailBySlug("exact", bad)).toBeNull();
    }
  });

  test("hostile slugs are bound, never interpolated", () => {
    const { db, repo } = setup();
    expect(repo.getPublishedDetailBySlug("' OR 1=1 --", NOW)).toBeNull();
    expect(db.query("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 5 });
  });

  test("isPublishedAtIso mirrors the SQL predicate", () => {
    expect(isPublishedAtIso("2026-11-01T00:00:00.000Z", NOW_ISO)).toBe(true);
    expect(isPublishedAtIso(NOW_ISO, NOW_ISO)).toBe(true);
    expect(isPublishedAtIso("2026-11-07T12:00:00.001Z", NOW_ISO)).toBe(false);
    expect(isPublishedAtIso("", NOW_ISO)).toBe(false);
    expect(isPublishedAtIso(null, NOW_ISO)).toBe(false);
    expect(isPublishedAtIso(undefined, NOW_ISO)).toBe(false);
  });
});

describe("SqliteProductRepository.listPublishedSlugsWithUpdatedAt (CONS-B4 bm)", () => {
  test("only products published at nowIso (same rule as filterPublishedIds), ordered by slug, with updated_at", () => {
    const { db, repo } = setup();
    db.run("UPDATE products SET updated_at = '2026-11-05T08:00:00.000Z' WHERE id = 'past'");
    // "defaulted" got published_at from created_at (wall clock); pin it so the test does not depend on the time of day.
    db.run("UPDATE products SET published_at = '2026-11-08T00:00:00.000Z' WHERE id = 'defaulted'");
    const rows = repo.listPublishedSlugsWithUpdatedAt(NOW_ISO);
    expect(rows.map((r) => r.slug)).toEqual(["exact", "past"]);
    expect(rows.find((r) => r.slug === "past")?.updatedAt).toBe("2026-11-05T08:00:00.000Z");
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["slug", "updatedAt"]);
    const published = repo.filterPublishedIds(["past", "exact", "future", "blank", "defaulted"], NOW_ISO);
    expect(rows.map((r) => r.slug)).toEqual([...published].sort());
  });

  test("matches isPublishedAtIso row by row", () => {
    const { db, repo } = setup();
    const all = db
      .query<{ slug: string; published_at: string }, []>("SELECT slug, published_at FROM products ORDER BY slug")
      .all();
    const expected = all.filter((r) => isPublishedAtIso(r.published_at, NOW_ISO)).map((r) => r.slug);
    expect(repo.listPublishedSlugsWithUpdatedAt(NOW_ISO).map((r) => r.slug)).toEqual(expected);
  });

  test("the cut-off is inclusive and moves with nowIso", () => {
    const { repo } = setup();
    expect(repo.listPublishedSlugsWithUpdatedAt("2026-11-07T12:00:00.001Z").map((r) => r.slug)).toContain("future");
    expect(repo.listPublishedSlugsWithUpdatedAt("2000-01-01T00:00:00.000Z")).toEqual([]);
  });

  test("blank or non-string nowIso -> [] (no SQL); hostile values are bound", () => {
    const { db, repo } = setup();
    expect(repo.listPublishedSlugsWithUpdatedAt("")).toEqual([]);
    expect(repo.listPublishedSlugsWithUpdatedAt(42 as unknown as string)).toEqual([]);
    expect(repo.listPublishedSlugsWithUpdatedAt("'; DROP TABLE products; --")).toEqual([]);
    expect(db.query("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: 5 });
  });
});
