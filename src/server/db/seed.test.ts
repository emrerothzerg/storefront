import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "./client";
import { runMigrations } from "./schema";
import { renderPlaceholderSvg, SEED_PRODUCTS, seedProducts } from "./seed";
import { SqliteProductRepository } from "../catalog/product-repository";

const PUBLIC_DIR = join(import.meta.dir, "..", "..", "..", "public");

function seeded() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedProducts(db);
  return db;
}

describe("seed data", () => {
  test("has 12-20 products with unique slugs and ids", () => {
    expect(SEED_PRODUCTS.length).toBeGreaterThanOrEqual(12);
    expect(SEED_PRODUCTS.length).toBeLessThanOrEqual(20);
    expect(new Set(SEED_PRODUCTS.map((p) => p.slug)).size).toBe(SEED_PRODUCTS.length);
    expect(new Set(SEED_PRODUCTS.map((p) => p.id)).size).toBe(SEED_PRODUCTS.length);
    expect(new Set(SEED_PRODUCTS.map((p) => p.color)).size).toBe(SEED_PRODUCTS.length);
  });

  test("covers stock 0, 1, 3 and otherwise 10-100", () => {
    const stocks = SEED_PRODUCTS.map((p) => p.stock);
    expect(stocks).toContain(0);
    expect(stocks).toContain(1);
    expect(stocks).toContain(3);
    for (const s of stocks.filter((s) => ![0, 1, 3].includes(s))) {
      expect(s).toBeGreaterThanOrEqual(10);
      expect(s).toBeLessThanOrEqual(100);
    }
  });

  test("prices are non-negative integers and include 1999, 50 and 125000", () => {
    const prices = SEED_PRODUCTS.map((p) => p.priceCents);
    for (const price of prices) expect(Number.isSafeInteger(price) && price >= 0).toBe(true);
    expect(prices).toEqual(expect.arrayContaining([1999, 50, 125000]));
    for (const p of SEED_PRODUCTS) expect(p.description.length).toBeGreaterThan(0);
  });

  test("every product image exists under public/images/products and matches the renderer", () => {
    for (const p of SEED_PRODUCTS) {
      expect(p.imageUrl).toBe(`/images/products/${p.slug}.svg`);
      const file = join(PUBLIC_DIR, p.imageUrl);
      expect(existsSync(file)).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg).toBe(renderPlaceholderSvg(p));
      expect(svg).toContain('role="img"');
      expect(svg).toContain('width="600" height="600"');
      expect(svg).toMatch(/<title id="title">[^<]+<\/title>/);
    }
  });

  test("placeholder SVG escapes XML in names", () => {
    expect(renderPlaceholderSvg({ name: `Tom & "Jerry" <3`, color: "#000000" })).toContain(
      "Tom &amp; &quot;Jerry&quot; &lt;3",
    );
  });
});

describe("seedProducts", () => {
  test("inserts every seed product", () => {
    const repo = new SqliteProductRepository(seeded());
    expect(repo.list()).toHaveLength(SEED_PRODUCTS.length);
    const pin = repo.getBySlug("enamel-pin-set");
    expect(pin).toEqual({
      id: "prod_enamel-pin-set",
      slug: "enamel-pin-set",
      name: "Enamel Pin Set",
      description: expect.any(String),
      priceCents: 50,
      currency: "USD",
      imageUrl: "/images/products/enamel-pin-set.svg",
      stock: 100,
      brandName: "Inkwell Studio",
      brandSlug: "inkwell-studio",
      categoryName: "Bags & Accessories",
      categorySlug: "bags-accessories",
      sku: expect.stringMatching(/^IS-\d{4}$/),
      publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  test("running twice does not duplicate and restores seed values, keeping ids", () => {
    const db = seeded();
    db.query("UPDATE products SET stock = 0, name = 'changed' WHERE slug = 'canvas-tote-bag'").run();
    expect(seedProducts(db)).toBe(SEED_PRODUCTS.length);
    const repo = new SqliteProductRepository(db);
    expect(repo.list()).toHaveLength(SEED_PRODUCTS.length);
    const tote = repo.getBySlug("canvas-tote-bag");
    expect(tote?.name).toBe("Canvas Tote Bag");
    expect(tote?.stock).toBe(42);
    expect(tote?.id).toBe("prod_canvas-tote-bag");
  });

  test("upserts by slug even when an existing row has a different id", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    db.query(
      "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES ('legacy', 'walnut-desk', 'Old', 1, 'USD', '/x.svg', 9)",
    ).run();
    seedProducts(db);
    const repo = new SqliteProductRepository(db);
    expect(repo.list()).toHaveLength(SEED_PRODUCTS.length);
    expect(repo.getBySlug("walnut-desk")).toMatchObject({ id: "legacy", priceCents: 125000, stock: 3 });
  });
});
