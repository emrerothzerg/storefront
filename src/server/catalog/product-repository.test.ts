import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase, withTransaction } from "../db/client";
import { runMigrations } from "../db/schema";
import {
  MAX_LIST_LIMIT,
  parseBullets,
  parseImages,
  parseSpecs,
  ratingAverage,
  SqliteProductRepository,
} from "./product-repository";

// D-T170-1: summaries carry `publishedAt` (the insert trigger fills it from created_at).
const PRODUCT_KEYS = ["currency", "description", "id", "imageUrl", "name", "priceCents", "publishedAt", "slug", "stock"];

function setup(products: ReadonlyArray<{ id: string; slug: string; name?: string; stock: number; price?: number }> = []) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const insert = db.query(
    "INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock) VALUES (?, ?, ?, ?, ?, 'USD', ?, ?)",
  );
  for (const p of products) {
    insert.run(p.id, p.slug, p.name ?? p.id, `About ${p.id}`, p.price ?? 1000, `/images/products/${p.slug}.svg`, p.stock);
  }
  return { db, repo: new SqliteProductRepository(db) };
}

function stockOf(db: Database, id: string): number | undefined {
  return db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id)?.stock;
}

describe("reads", () => {
  test("list on an empty table returns []", () => {
    expect(setup().repo.list()).toEqual([]);
  });

  test("list returns domain objects sorted by name", () => {
    const { repo } = setup([
      { id: "b", slug: "b", name: "Bravo", stock: 1 },
      { id: "a", slug: "a", name: "Alpha", stock: 2, price: 0 },
    ]);
    const list = repo.list();
    expect(list.map((p) => p.name)).toEqual(["Alpha", "Bravo"]);
    for (const p of list) expect(Object.keys(p).sort()).toEqual(PRODUCT_KEYS);
    expect(list[0]).toEqual({
      id: "a",
      slug: "a",
      name: "Alpha",
      description: "About a",
      priceCents: 0,
      currency: "USD",
      imageUrl: "/images/products/a.svg",
      stock: 2,
      publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  test("getBySlug / getById return null when missing", () => {
    const { repo } = setup([{ id: "p1", slug: "one", stock: 1 }]);
    expect(repo.getBySlug("nope")).toBeNull();
    expect(repo.getById("nope")).toBeNull();
    expect(repo.getBySlug("one")?.id).toBe("p1");
    expect(repo.getById("p1")?.slug).toBe("one");
    expect(Object.keys(repo.getById("p1") ?? {}).sort()).toEqual(PRODUCT_KEYS);
  });

  test("getBySlug is safe for hostile and unusual input", () => {
    const odd = ["it's", 'a"b', "100%", "a_b", "üñîçødé-☕", "'; DROP TABLE products; --"];
    const { repo } = setup(odd.map((slug, i) => ({ id: `p${i}`, slug, stock: 1 })).concat({ id: "ab", slug: "axb", stock: 1 }));
    odd.forEach((slug, i) => expect(repo.getBySlug(slug)?.id).toBe(`p${i}`));
    // No LIKE semantics: % and _ are literal.
    expect(repo.getBySlug("%")).toBeNull();
    expect(repo.getBySlug("a_b")?.id).toBe("p3");
    expect(repo.getBySlug("a%")).toBeNull();
    expect(repo.getBySlug("x".repeat(10_000))).toBeNull();
    expect(repo.getBySlug("")).toBeNull();
    expect(repo.list()).toHaveLength(odd.length + 1);
  });

  test("getManyByIds keeps input order, skips unknown ids and collapses duplicates", () => {
    const { repo } = setup([
      { id: "a", slug: "a", stock: 1 },
      { id: "b", slug: "b", stock: 1 },
      { id: "c", slug: "c", stock: 1 },
    ]);
    expect(repo.getManyByIds([])).toEqual([]);
    expect(repo.getManyByIds(["c", "missing", "a", "c"]).map((p) => p.id)).toEqual(["c", "a"]);
    expect(repo.getManyByIds(["x'); DROP TABLE products; --"])).toEqual([]);
    const many = Array.from({ length: 2000 }, (_, i) => `id-${i}`).concat("b");
    expect(repo.getManyByIds(many).map((p) => p.id)).toEqual(["b"]);
  });
});

describe("decrementStock", () => {
  test("decrements and returns the updated product", () => {
    const { db, repo } = setup([{ id: "p", slug: "p", stock: 5 }]);
    const result = repo.decrementStock("p", 2);
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ id: "p", stock: 3 }) });
    expect(stockOf(db, "p")).toBe(3);
    expect(repo.decrementStock("p", 3).ok).toBe(true);
    expect(stockOf(db, "p")).toBe(0);
  });

  test("PRODUCT_NOT_FOUND for unknown id", () => {
    const { repo } = setup();
    const result = repo.decrementStock("ghost", 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PRODUCT_NOT_FOUND");
  });

  test("OUT_OF_STOCK when stock is 0", () => {
    const { db, repo } = setup([{ id: "p", slug: "p", stock: 0 }]);
    const result = repo.decrementStock("p", 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("OUT_OF_STOCK");
      expect(result.error.details?.available).toBe(0);
    }
    expect(stockOf(db, "p")).toBe(0);
  });

  test("INSUFFICIENT_STOCK with details.available when asking for too many", () => {
    const { db, repo } = setup([{ id: "p", slug: "p", stock: 3 }]);
    const result = repo.decrementStock("p", 4);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INSUFFICIENT_STOCK");
      expect(result.error.details).toEqual({ productId: "p", available: 3, requested: 4 });
    }
    expect(stockOf(db, "p")).toBe(3);
  });

  test("INVALID_QUANTITY for zero, negative, fractional and non-finite quantities", () => {
    const { db, repo } = setup([{ id: "p", slug: "p", stock: 3 }]);
    for (const q of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = repo.decrementStock("p", q);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_QUANTITY");
    }
    expect(stockOf(db, "p")).toBe(3);
  });

  test("two interleaved buyers on stock=1: exactly one succeeds, stock ends at 0", () => {
    const { db, repo } = setup([{ id: "last", slug: "last", stock: 1 }]);
    // Both buyers read stock=1 before either writes (classic lost-update race).
    const seenByA = repo.getById("last")?.stock;
    const seenByB = repo.getById("last")?.stock;
    expect([seenByA, seenByB]).toEqual([1, 1]);
    const a = repo.decrementStock("last", 1);
    const b = repo.decrementStock("last", 1);
    const results = [a, b];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const failed = results.find((r) => !r.ok);
    expect(failed !== undefined && !failed.ok && failed.error.code).toBe("OUT_OF_STOCK");
    expect(stockOf(db, "last")).toBe(0);
  });

  test("concurrent async callers on stock=1 never drive stock negative", async () => {
    const { db, repo } = setup([{ id: "last", slug: "last", stock: 1 }]);
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        await Promise.resolve();
        return repo.decrementStock("last", 1);
      }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(stockOf(db, "last")).toBe(0);
  });

  test("composes with withTransaction: a later failure rolls the decrement back", () => {
    const { db, repo } = setup([{ id: "p", slug: "p", stock: 2 }]);
    expect(() =>
      withTransaction(db, () => {
        const r = repo.decrementStock("p", 2);
        expect(r.ok).toBe(true);
        throw new Error("payment failed");
      }),
    ).toThrow("payment failed");
    expect(stockOf(db, "p")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Phase 2: summary joins, detail, catalog lists
// ---------------------------------------------------------------------------

function catalog() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  db.run("INSERT INTO brands (id, slug, name, description) VALUES ('b1', 'acme', 'Acme', 'Makers')");
  db.run("INSERT INTO categories (id, slug, name, sort_order) VALUES ('dep', 'home', 'Home', 1)");
  db.run("INSERT INTO categories (id, slug, name, parent_id, image_url) VALUES ('cat', 'mugs', 'Mugs', 'dep', '/c.svg')");
  db.run("INSERT INTO categories (id, slug, name, parent_id) VALUES ('cat2', 'plates', 'Plates', 'dep')");
  const add = db.query(
    `INSERT INTO products (id, slug, name, description, price_cents, currency, image_url, stock, brand_id, category_id,
                           list_price_cents, sku, bullets, specs, images, is_featured, published_at)
     VALUES (?, ?, ?, '', ?, 'USD', ?, 5, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  add.run("m1", "mug", "Mug", 1000, "/m.svg", "b1", "cat", 1500, "AC-1", JSON.stringify(["Big", 3, ""]),
    JSON.stringify([{ label: "Capacity", value: "350 ml" }, { label: 1 }]), JSON.stringify([{ url: "/m.svg", alt: "Mug" }, { url: "/m2.svg", alt: "Side" }]),
    1, "2026-11-01T09:00:00.000Z");
  add.run("p1", "plate", "Plate", 2000, "/p.svg", null, "cat2", 2500, null, "[]", "[]", "[]", 0, "2026-11-05T09:00:00.000Z");
  add.run("x1", "spoon", "Spoon", 300, "/s.svg", null, null, null, null, "[]", "[]", "[]", 1, "2026-10-01T09:00:00.000Z");
  add.run("z1", "bowl", "Bowl", 900, "/b.svg", "b1", "cat", 1000, null, "[]", "[]", "[]", 0, "2026-09-01T09:00:00.000Z");
  return { db, repo: new SqliteProductRepository(db) };
}

describe("summary fields (sparse)", () => {
  test("joins brand and category, adds list price/featured/sku only when set", () => {
    const { repo } = catalog();
    expect(repo.getBySlug("mug")).toEqual({
      id: "m1", slug: "mug", name: "Mug", description: "", priceCents: 1000, currency: "USD", imageUrl: "/m.svg", stock: 5,
      listPriceCents: 1500, brandName: "Acme", brandSlug: "acme", categoryName: "Mugs", categorySlug: "mugs",
      isFeatured: true, sku: "AC-1", publishedAt: "2026-11-01T09:00:00.000Z",
    });
    expect(Object.keys(repo.getById("x1") ?? {}).sort()).toEqual([...PRODUCT_KEYS, "isFeatured"].sort());
    expect(repo.getManyByIds(["p1"])[0]).toMatchObject({ categorySlug: "plates", listPriceCents: 2500 });
    expect(repo.getManyByIds(["p1"])[0]).not.toHaveProperty("brandName");
  });

  test("D-T170-1: every summary read (getManyByIds, getBySlug, getById, lists) carries publishedAt; '' is omitted", () => {
    const { db, repo } = catalog();
    expect(repo.getManyByIds(["p1", "m1"]).map((p) => [p.id, p.publishedAt])).toEqual([
      ["p1", "2026-11-05T09:00:00.000Z"],
      ["m1", "2026-11-01T09:00:00.000Z"],
    ]);
    expect(repo.getBySlug("spoon")?.publishedAt).toBe("2026-10-01T09:00:00.000Z");
    expect(repo.getById("z1")?.publishedAt).toBe("2026-09-01T09:00:00.000Z");
    expect(repo.list().every((p) => typeof p.publishedAt === "string")).toBe(true);
    db.run("UPDATE products SET published_at = '' WHERE id = 'p1'");
    expect(repo.getManyByIds(["p1"])[0]).not.toHaveProperty("publishedAt");
    // Detail keeps its own publishedAt (no duplicate column in the detail query).
    expect(repo.getDetailBySlug("mug")?.publishedAt).toBe("2026-11-01T09:00:00.000Z");
  });

  test("rating fields appear once there are published reviews, rounded to one decimal", () => {
    const { db, repo } = catalog();
    const add = db.query("INSERT INTO reviews (id, product_id, session_id, display_name, rating, status) VALUES (?, 'm1', ?, 'A', ?, ?)");
    add.run("r1", "s1", 5, "published");
    add.run("r2", "s2", 4, "published");
    add.run("r3", "s3", 4, "published");
    add.run("r4", "s4", 1, "hidden");
    expect(repo.getBySlug("mug")).toMatchObject({ ratingCount: 3, ratingAvg: 4.3 });
    expect(repo.getBySlug("plate")).not.toHaveProperty("ratingCount");
    expect(ratingAverage(0, 0)).toBe(0);
    expect(ratingAverage(9, 2)).toBe(4.5);
  });

  test("decrementStock returns the summary shape with joins", () => {
    const { repo } = catalog();
    const r = repo.decrementStock("m1", 2);
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ id: "m1", stock: 3, brandSlug: "acme" }) });
  });
});

describe("getDetailBySlug", () => {
  test("returns rich fields with brand and category objects; invalid JSON entries filtered", () => {
    const { repo } = catalog();
    const d = repo.getDetailBySlug("mug");
    expect(d).toMatchObject({
      bullets: ["Big"],
      specs: [{ label: "Capacity", value: "350 ml" }],
      images: [{ url: "/m.svg", alt: "Mug" }, { url: "/m2.svg", alt: "Side" }],
      listPriceCents: 1500, ratingCount: 0, ratingAvg: 0,
      brand: { id: "b1", slug: "acme", name: "Acme", description: "Makers" },
      category: { id: "cat", slug: "mugs", name: "Mugs", description: "", parentId: "dep", sortOrder: 0, imageUrl: "/c.svg" },
      publishedAt: "2026-11-01T09:00:00.000Z",
    });
    expect(d?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(repo.getDetailBySlug("nope")).toBeNull();
  });

  test("null brand/category/list price and image fallback when the gallery is empty", () => {
    const { repo } = catalog();
    const d = repo.getDetailBySlug("spoon");
    expect(d).toMatchObject({ brand: null, category: null, listPriceCents: null, images: [{ url: "/s.svg", alt: "Spoon" }] });
  });

  test("malformed JSON columns never throw and yield empty arrays", () => {
    const { db, repo } = catalog();
    for (const bad of ["{oops", "null", '"string"', "42", '{"a":1}', "[1,2,3]", ""]) {
      db.query("UPDATE products SET bullets = ?, specs = ?, images = ? WHERE id = 'm1'").run(bad, bad, bad);
      const d = repo.getDetailBySlug("mug");
      expect({ bad, bullets: d?.bullets, specs: d?.specs, images: d?.images }).toEqual({
        bad, bullets: [], specs: [], images: [{ url: "/m.svg", alt: "Mug" }],
      });
    }
  });

  test("parsers keep only safe, well-shaped entries", () => {
    expect(parseBullets('["a", "  ", null, "b"]')).toEqual(["a", "b"]);
    expect(parseSpecs('[{"label":"L","value":"V"},{"label":"x","value":2},["L","V"]]')).toEqual([{ label: "L", value: "V" }]);
    expect(parseImages(JSON.stringify([
      { url: "/ok.svg", alt: "ok" }, { url: "//evil.example/x.svg", alt: "x" }, { url: "https://evil.example/x", alt: "x" },
      { url: "javascript:alert(1)", alt: "x" }, { url: "/no-alt.svg" },
    ]))).toEqual([{ url: "/ok.svg", alt: "ok" }, { url: "/no-alt.svg", alt: "" }]);
  });
});

describe("catalog lists", () => {
  test("listByCategory: leaf category, department includes children, unknown id gives []", () => {
    const { repo } = catalog();
    expect(repo.listByCategory("cat").map((p) => p.slug)).toEqual(["bowl", "mug"]);
    expect(repo.listByCategory("dep").map((p) => p.slug)).toEqual(["bowl", "mug", "plate"]);
    expect(repo.listByCategory("dep", 1).map((p) => p.slug)).toEqual(["bowl"]);
    expect(repo.listByCategory("nope")).toEqual([]);
    expect(repo.listByCategory("' OR 1=1 --")).toEqual([]);
  });

  test("listFeatured, listNewest, listDeals, listTopRated order correctly", () => {
    const { db, repo } = catalog();
    expect(repo.listFeatured(10).map((p) => p.slug)).toEqual(["mug", "spoon"]);
    expect(repo.listNewest(2).map((p) => p.slug)).toEqual(["plate", "mug"]);
    // mug 33% off, plate 20% off, bowl 10% off.
    expect(repo.listDeals(10).map((p) => p.slug)).toEqual(["mug", "plate", "bowl"]);
    const add = db.query("INSERT INTO reviews (id, product_id, session_id, display_name, rating) VALUES (?, ?, ?, 'A', ?)");
    add.run("r1", "m1", "s1", 4);
    add.run("r2", "p1", "s1", 5);
    add.run("r3", "z1", "s1", 5);
    add.run("r4", "z1", "s2", 5);
    expect(repo.listTopRated(10).map((p) => p.slug)).toEqual(["bowl", "plate", "mug"]);
  });

  test("limit must be a positive integer (else []) and is capped at MAX_LIST_LIMIT", () => {
    const { repo } = catalog();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(repo.listNewest(bad)).toEqual([]);
      expect(repo.listByCategory("dep", bad)).toEqual([]);
    }
    expect(repo.listNewest(MAX_LIST_LIMIT * 10)).toHaveLength(4);
  });

  test("listSlugsWithUpdatedAt returns every slug ordered by slug", () => {
    const { repo } = catalog();
    const rows = repo.listSlugsWithUpdatedAt();
    expect(rows.map((r) => r.slug)).toEqual(["bowl", "mug", "plate", "spoon"]);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["slug", "updatedAt"]);
      expect(r.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    expect(setup().repo.listSlugsWithUpdatedAt()).toEqual([]);
  });
});
