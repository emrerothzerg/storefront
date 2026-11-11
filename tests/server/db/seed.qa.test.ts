/**
 * QA (T07): seed data and seeding behaviour. Criteria 1, 4, 6.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { renderPlaceholderSvg, SEED_PRODUCTS, seedProducts } from "@/server/db/seed";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { count, insertCartItem, insertOrder, insertOrderItem, memoryDb } from "./helpers";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PUBLIC_DIR = join(ROOT, "public");
const IMAGE_DIR = join(PUBLIC_DIR, "images", "products");

function idsAndSlugs(db: ReturnType<typeof memoryDb>) {
  return db.query<{ id: string; slug: string }, []>("SELECT id, slug FROM products ORDER BY id").all();
}

describe("C4 seed content", () => {
  test("at least one out-of-stock product and at least one with stock exactly 1", () => {
    expect(SEED_PRODUCTS.filter((p) => p.stock === 0).length).toBeGreaterThanOrEqual(1);
    expect(SEED_PRODUCTS.filter((p) => p.stock === 1).length).toBeGreaterThanOrEqual(1);
  });

  test("the seeded DB (not just the constant) has stock 0 and stock 1 rows", () => {
    const db = memoryDb();
    seedProducts(db);
    const stocks = new SqliteProductRepository(db).list().map((p) => p.stock);
    expect(stocks).toContain(0);
    expect(stocks).toContain(1);
  });

  test("every seeded image path exists on disk under public/images/products (Bun.file().exists())", async () => {
    for (const p of SEED_PRODUCTS) {
      expect(p.imageUrl.startsWith("/images/products/")).toBe(true);
      const file = resolve(PUBLIC_DIR, `.${p.imageUrl}`);
      expect(file.startsWith(IMAGE_DIR + sep)).toBe(true); // no traversal out of the folder
      expect({ slug: p.slug, exists: await Bun.file(file).exists() }).toEqual({ slug: p.slug, exists: true });
    }
  });

  test("every seeded SVG is non-empty and XML-ish (<svg ... </svg>, xmlns, balanced root)", async () => {
    for (const p of SEED_PRODUCTS) {
      const text = await Bun.file(resolve(PUBLIC_DIR, `.${p.imageUrl}`)).text();
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("<svg");
      expect(text).toContain("</svg>");
      expect(text.indexOf("<svg")).toBeLessThan(text.lastIndexOf("</svg>"));
      expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect((text.match(/<svg\b/g) ?? []).length).toBe(1);
      // No unescaped ampersands (would break XML parsing).
      expect(text).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;|#)/);
    }
  });

  test("the rendered SVG of a name with XML metacharacters stays well-formed", () => {
    const svg = renderPlaceholderSvg({ name: "A & B <script>", color: "#000000" });
    expect(svg).not.toContain("<script>");
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  test("no orphan seed images: each SVG in the folder belongs to a seed product", () => {
    const files = readdirSync(IMAGE_DIR).filter((f) => f.endsWith(".svg")).sort();
    expect(files).toEqual(SEED_PRODUCTS.map((p) => `${p.slug}.svg`).sort());
  });

  test("seed values satisfy DB constraints and domain invariants", () => {
    for (const p of SEED_PRODUCTS) {
      expect(Number.isSafeInteger(p.priceCents) && p.priceCents >= 0).toBe(true);
      expect(Number.isSafeInteger(p.stock) && p.stock >= 0).toBe(true);
      expect(p.currency).toHaveLength(3);
      expect(p.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(p.id).toBe(`prod_${p.slug}`);
      expect(p.name.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("C1 seeding is idempotent (upsert by slug)", () => {
  test("seedProducts twice leaves the same row count and the same ids", () => {
    const db = memoryDb();
    expect(seedProducts(db)).toBe(SEED_PRODUCTS.length);
    const first = idsAndSlugs(db);
    expect(first).toHaveLength(SEED_PRODUCTS.length);
    expect(seedProducts(db)).toBe(SEED_PRODUCTS.length);
    expect(idsAndSlugs(db)).toEqual(first);
    seedProducts(db);
    expect(count(db, "products")).toBe(SEED_PRODUCTS.length);
  });

  test("seeded rows round-trip through the repository equal to SEED_PRODUCTS (minus colour)", () => {
    const db = memoryDb();
    seedProducts(db);
    const repo = new SqliteProductRepository(db);
    for (const seed of SEED_PRODUCTS) {
      const { color: _color, ...expected } = seed;
      void _color;
      expect(repo.getBySlug(seed.slug)).toEqual({ ...expected, publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    }
  });

  test("re-seed with carts and orders referencing products succeeds and keeps them (no delete+insert)", () => {
    const db = memoryDb();
    seedProducts(db);
    const target = SEED_PRODUCTS[0]!;
    db.query("INSERT INTO carts (session_id) VALUES ('s')").run();
    insertCartItem(db, "s", target.id, 2);
    insertOrder(db, "o", "k");
    insertOrderItem(db, "o", target.id, target.name, target.priceCents, 1);
    expect(() => seedProducts(db)).not.toThrow();
    expect(count(db, "cart_items")).toBe(1);
    expect(count(db, "order_items")).toBe(1);
    expect(count(db, "products")).toBe(SEED_PRODUCTS.length);
  });

  test("re-seed resets stock to seed value (accepted behaviour per orchestrator ruling)", () => {
    const db = memoryDb();
    seedProducts(db);
    const p = SEED_PRODUCTS.find((s) => s.stock > 1)!;
    db.query("UPDATE products SET stock = 0 WHERE slug = ?").run(p.slug);
    seedProducts(db);
    expect(new SqliteProductRepository(db).getBySlug(p.slug)?.stock).toBe(p.stock);
  });

  test("non-seed products are left alone by a re-seed", () => {
    const db = memoryDb();
    db.query(
      "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES ('custom', 'custom', 'Custom', 1, 'USD', '/x.svg', 7)",
    ).run();
    seedProducts(db);
    seedProducts(db);
    expect(count(db, "products")).toBe(SEED_PRODUCTS.length + 1);
    expect(new SqliteProductRepository(db).getById("custom")?.stock).toBe(7);
  });
});

describe("C6 implementer tests never write to ./data", () => {
  function snapshot(): string[] {
    return readdirSync(join(ROOT, "data")).sort();
  }

  test("data/ contents identical before and after running src/server/db + src/server/catalog tests", () => {
    const before = snapshot();
    const env = { ...process.env };
    delete env.DATABASE_PATH;
    const run = Bun.spawnSync(["bun", "test", "src/server/db", "src/server/catalog"], { cwd: ROOT, env });
    const out = run.stdout.toString() + run.stderr.toString();
    expect(run.exitCode).toBe(0);
    expect(out).toMatch(/\b0 fail\b/);
    expect(snapshot()).toEqual(before);
    for (const f of snapshot().filter((n) => !n.startsWith("storefront.sqlite"))) expect(f).not.toMatch(/\.sqlite/); // dev DB allowed
  }, 60_000);

  test("no src test calls getDatabase() without forcing DATABASE_PATH=':memory:' first", async () => {
    const glob = new Bun.Glob("src/server/{db,catalog}/**/*.test.ts");
    for await (const rel of glob.scan({ cwd: ROOT })) {
      const src = await Bun.file(join(ROOT, rel)).text();
      if (!src.includes("getDatabase()")) continue;
      expect({ file: rel, setsMemory: src.includes('process.env.DATABASE_PATH = ":memory:"') }).toEqual({
        file: rel,
        setsMemory: true,
      });
      expect(src).not.toMatch(/createDatabase\(\s*["'`]\.?\/?data\//);
    }
  });
});
