/**
 * QA (T07): SqliteProductRepository, adversarial. Criteria 3, 5, 7.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Product } from "@/lib/types";
import type { Result } from "@/lib/result";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { count, insertProduct, memoryDb, stockOf } from "./helpers";

// FIX-P3-pages (D-T170-1): the 8 MVP keys + `publishedAt` (filled by the insert trigger).
const PRODUCT_KEYS = ["currency", "description", "id", "imageUrl", "name", "priceCents", "publishedAt", "slug", "stock"];

function setup(rows: ReadonlyArray<{ id: string; slug?: string; name?: string; stock?: number }> = []) {
  const db = memoryDb();
  for (const r of rows) insertProduct(db, r);
  return { db, repo: new SqliteProductRepository(db) };
}

function expectDomain(p: Product | null | undefined): void {
  expect(p).toBeDefined();
  expect(p).not.toBeNull();
  expect(Object.getPrototypeOf(p)).toBe(Object.prototype);
  expect(Object.keys(p ?? {}).sort()).toEqual(PRODUCT_KEYS);
  for (const raw of ["price_cents", "image_url", "created_at", "updated_at"]) expect(p).not.toHaveProperty(raw);
}

function errCode(r: Result<Product>): string | undefined {
  return r.ok ? undefined : r.error.code;
}

describe("C3 empty / not-found", () => {
  test("list() on an empty table returns [] (a real array)", () => {
    const { repo } = setup();
    const list = repo.list();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toEqual([]);
  });

  test("getBySlug('nope') returns null, not an exception; getById likewise", () => {
    const { repo } = setup([{ id: "p1", slug: "real" }]);
    expect(() => repo.getBySlug("nope")).not.toThrow();
    expect(repo.getBySlug("nope")).toBeNull();
    expect(repo.getById("nope")).toBeNull();
    expect(repo.getBySlug("REAL")).toBeNull(); // exact, case-sensitive match
    expect(repo.getBySlug(" real")).toBeNull();
  });
});

describe("C5 getBySlug hostile input: no injection, no LIKE semantics, no throw", () => {
  const hostile: ReadonlyArray<[string, string]> = [
    ["sql injection", "' OR 1=1 --"],
    ["percent wildcard", "%"],
    ["underscore wildcard", "_"],
    ["100k-char string", "a".repeat(100_000)],
    ["NUL byte", "\u0000"],
    ["drop table", "x'; DROP TABLE products; --"],
    ["empty", ""],
    ["named-param lookalike", "$slug"],
    ["question mark", "?"],
  ];
  for (const [label, input] of hostile) {
    test(`${label} returns null and leaves the table intact`, () => {
      const { db, repo } = setup([
        { id: "a", slug: "alpha" },
        { id: "b", slug: "a" },
      ]);
      expect(repo.getBySlug(input)).toBeNull();
      expect(count(db, "products")).toBe(2);
    });
  }

  test("emoji / unicode slug round-trips exactly", () => {
    const { repo } = setup([{ id: "e", slug: "☕-mug-🔥" }, { id: "u", slug: "üñîçødé" }]);
    expect(repo.getBySlug("☕-mug-🔥")?.id).toBe("e");
    expect(repo.getBySlug("☕-mug-")).toBeNull();
    expect(repo.getBySlug("üñîçødé")?.id).toBe("u");
    expect(repo.getBySlug("uñîçødé")).toBeNull();
  });

  test("hostile strings stored AS slugs are found literally", () => {
    const slugs = ["' OR 1=1 --", "%", "_", "\u0000", "a\u0000b", "a".repeat(100_000)];
    const { repo } = setup(slugs.map((slug, i) => ({ id: `h${i}`, slug })));
    slugs.forEach((slug, i) => expect(repo.getBySlug(slug)?.id).toBe(`h${i}`));
    expect(repo.getBySlug("a")).toBeNull(); // NUL must not truncate "a\u0000b" to "a"
  });
});

describe("C5 getManyByIds", () => {
  const rows = [
    { id: "a", slug: "a" },
    { id: "b", slug: "b" },
    { id: "c", slug: "c" },
  ];

  test("[] returns []", () => {
    expect(setup(rows).repo.getManyByIds([])).toEqual([]);
  });

  test("duplicates collapse, first-appearance order kept", () => {
    const { repo } = setup(rows);
    expect(repo.getManyByIds(["c", "a", "c", "a", "b", "c"]).map((p) => p.id)).toEqual(["c", "a", "b"]);
  });

  test("unknown ids are skipped; all-unknown gives []", () => {
    const { repo } = setup(rows);
    expect(repo.getManyByIds(["zz", "b", "' OR 1=1 --", "%"]).map((p) => p.id)).toEqual(["b"]);
    expect(repo.getManyByIds(["x", "y"])).toEqual([]);
  });

  test("2000 ids (beyond typical bound-variable limits for IN lists) works", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ id: `id-${i}`, slug: `s-${i}` }));
    const { repo } = setup(many);
    const ids = many.map((m) => m.id).reverse();
    const out = repo.getManyByIds(ids);
    expect(out).toHaveLength(2000);
    expect(out[0]?.id).toBe("id-1999");
    expect(out[1999]?.id).toBe("id-0");
  });

  test("ids containing JSON metacharacters do not break the json_each binding", () => {
    const tricky = ['quo"te', "back\\slash", "]", "new\nline", "[\"a\"]"];
    const { repo } = setup(tricky.map((id, i) => ({ id, slug: `t${i}` })).concat(rows));
    expect(repo.getManyByIds([...tricky, "a"]).map((p) => p.id)).toEqual([...tricky, "a"]);
    expect(repo.getManyByIds(['["a"]'])).toEqual([repo.getById('["a"]') as Product]);
  });

  test("non-array input is rejected at the type boundary and does not throw at runtime", () => {
    const { repo } = setup(rows);
    // @ts-expect-error a bare string is not readonly string[]
    expect(() => repo.getManyByIds("abc")).not.toThrow();
    // @ts-expect-error null is not readonly string[]
    expect(repo.getManyByIds(null)).toEqual([]);
    // @ts-expect-error numbers are not strings
    expect(repo.getManyByIds([1, 2])).toEqual([]);
  });

  test("results are domain objects", () => {
    for (const p of setup(rows).repo.getManyByIds(["a", "b"])) expectDomain(p);
  });
});

describe("C5 domain types, never raw rows", () => {
  test("list / getBySlug / getById / getManyByIds / decrementStock all return exactly the Product shape", () => {
    const { repo } = setup([{ id: "p", slug: "p", stock: 3 }]);
    for (const p of repo.list()) expectDomain(p);
    expectDomain(repo.getBySlug("p"));
    expectDomain(repo.getById("p"));
    const r = repo.decrementStock("p", 1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expectDomain(r.value);
      expect(r.value.stock).toBe(2);
      expect(typeof r.value.priceCents).toBe("number");
    }
  });

  test("returned objects are detached: mutating one does not affect the DB or later reads", () => {
    const { db, repo } = setup([{ id: "p", slug: "p", stock: 3 }]);
    const p = repo.getById("p") as { stock: number };
    p.stock = 999;
    expect(repo.getById("p")?.stock).toBe(3);
    expect(stockOf(db, "p")).toBe(3);
  });

  test("list is ordered by name then id", () => {
    const { repo } = setup([
      { id: "z", slug: "z", name: "Same" },
      { id: "a", slug: "a", name: "Same" },
      { id: "m", slug: "m", name: "Alpha" },
    ]);
    expect(repo.list().map((p) => p.id)).toEqual(["m", "a", "z"]);
  });
});

describe("C7 decrementStock error codes", () => {
  test("PRODUCT_NOT_FOUND for unknown id, including hostile ids", () => {
    const { repo } = setup([{ id: "p", stock: 1 }]);
    for (const id of ["ghost", "", "' OR 1=1 --", "%"]) {
      const r = repo.decrementStock(id, 1);
      expect(errCode(r)).toBe("PRODUCT_NOT_FOUND");
    }
  });

  test("OUT_OF_STOCK when stock is 0, with details.available = 0", () => {
    const { db, repo } = setup([{ id: "p", stock: 0 }]);
    const r = repo.decrementStock("p", 3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("OUT_OF_STOCK");
      expect(r.error.details).toMatchObject({ available: 0, requested: 3 });
    }
    expect(stockOf(db, "p")).toBe(0);
  });

  test("INSUFFICIENT_STOCK with details.available when 0 < stock < quantity", () => {
    const { db, repo } = setup([{ id: "p", stock: 2 }]);
    const r = repo.decrementStock("p", 3);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INSUFFICIENT_STOCK");
      expect(r.error.details).toEqual({ productId: "p", available: 2, requested: 3 });
    }
    expect(stockOf(db, "p")).toBe(2);
  });

  test("exact quantity == stock succeeds and lands on 0; the next call is OUT_OF_STOCK", () => {
    const { db, repo } = setup([{ id: "p", stock: 4 }]);
    expect(repo.decrementStock("p", 4).ok).toBe(true);
    expect(stockOf(db, "p")).toBe(0);
    expect(errCode(repo.decrementStock("p", 1))).toBe("OUT_OF_STOCK");
  });

  const invalid: ReadonlyArray<[string, number]> = [
    ["0", 0],
    ["-0", -0],
    ["-1", -1],
    ["1.5", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
  ];
  for (const [label, q] of invalid) {
    test(`quantity ${label} -> INVALID_QUANTITY, stock unchanged`, () => {
      const { db, repo } = setup([{ id: "p", stock: 5 }]);
      expect(errCode(repo.decrementStock("p", q))).toBe("INVALID_QUANTITY");
      expect(stockOf(db, "p")).toBe(5);
    });
  }

  test("quantity validation happens before lookup (unknown id + bad qty -> INVALID_QUANTITY)", () => {
    expect(errCode(setup().repo.decrementStock("ghost", 0))).toBe("INVALID_QUANTITY");
  });

  test("non-number quantity at runtime ('1') -> INVALID_QUANTITY", () => {
    const { db, repo } = setup([{ id: "p", stock: 5 }]);
    expect(errCode(repo.decrementStock("p", "1" as unknown as number))).toBe("INVALID_QUANTITY");
    expect(stockOf(db, "p")).toBe(5);
  });

  test("Number.MAX_SAFE_INTEGER -> INSUFFICIENT_STOCK with available, stock unchanged, no overflow", () => {
    const { db, repo } = setup([{ id: "p", stock: 5 }]);
    const r = repo.decrementStock("p", Number.MAX_SAFE_INTEGER);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INSUFFICIENT_STOCK");
      expect(r.error.details).toMatchObject({ available: 5, requested: Number.MAX_SAFE_INTEGER });
    }
    expect(stockOf(db, "p")).toBe(5);
  });

  test("decrement on one product leaves others untouched", () => {
    const { db, repo } = setup([{ id: "p", stock: 5 }, { id: "q", stock: 5 }]);
    repo.decrementStock("p", 2);
    expect(stockOf(db, "q")).toBe(5);
  });
});

describe("C7 races", () => {
  test("two interleaved decrements on stock=1: exactly one success, stock 0, never negative", () => {
    const { db, repo } = setup([{ id: "last", stock: 1 }]);
    const a = repo.decrementStock("last", 1);
    const b = repo.decrementStock("last", 1);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(errCode(b)).toBe("OUT_OF_STOCK");
    expect(stockOf(db, "last")).toBe(0);
  });

  test("20-way Promise.all on stock=5, qty=1: exactly 5 successes, 15 OUT_OF_STOCK, stock 0", async () => {
    const { db, repo } = setup([{ id: "p", stock: 5 }]);
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        for (let k = 0; k < i % 3; k++) await Promise.resolve();
        return repo.decrementStock("p", 1);
      }),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => errCode(r) === "OUT_OF_STOCK")).toHaveLength(15);
    expect(stockOf(db, "p")).toBe(0);
    const remaining = results.filter((r) => r.ok).map((r) => (r.ok ? r.value.stock : -1)).sort();
    expect(remaining).toEqual([0, 1, 2, 3, 4]);
  });

  test("mixed quantities race on stock=5 (3,3,2): never oversells", async () => {
    const { db, repo } = setup([{ id: "p", stock: 5 }]);
    const results = await Promise.all([3, 3, 2].map(async (q) => repo.decrementStock("p", q)));
    const sold = results.reduce((s, r, i) => s + (r.ok ? [3, 3, 2][i]! : 0), 0);
    expect(sold).toBeLessThanOrEqual(5);
    expect(stockOf(db, "p")).toBe(5 - sold);
    expect(errCode(results[1]!)).toBe("INSUFFICIENT_STOCK");
  });

  describe("two separate connections to one file DB (OS temp dir, never ./data)", () => {
    const dir = mkdtempSync(join(tmpdir(), "storefront-qa-"));
    afterAll(() => {
      closeDatabase();
      rmSync(dir, { recursive: true, force: true });
    });

    test("interleaved buyers on stock=1 across connections: one success, stock 0", () => {
      const path = join(dir, "race.sqlite");
      const a = createDatabase(path);
      runMigrations(a);
      insertProduct(a, { id: "last", stock: 1 });
      const b = createDatabase(path);
      const repoA = new SqliteProductRepository(a);
      const repoB = new SqliteProductRepository(b);
      expect(repoA.getById("last")?.stock).toBe(1);
      expect(repoB.getById("last")?.stock).toBe(1);
      const ra = repoA.decrementStock("last", 1);
      const rb = repoB.decrementStock("last", 1);
      expect([ra, rb].filter((r) => r.ok)).toHaveLength(1);
      expect(errCode(rb)).toBe("OUT_OF_STOCK");
      expect(stockOf(a, "last")).toBe(0);
      expect(stockOf(b, "last")).toBe(0);
      a.close();
      b.close();
    });
  });
});
