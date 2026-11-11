import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";

import { loadCompare } from "./compare-data";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");

let db: Database;
let products: SqliteProductRepository;

beforeEach(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  products = new SqliteProductRepository(db);
  lookups = [];
});

afterEach(() => {
  db.close();
});

/** Slugs looked up by the loader in the current test (own counter, independent of other files' spies). */
let lookups: string[] = [];

function load(params: unknown) {
  return loadCompare(params, {
    products: {
      getPublishedDetailBySlug: (slug: string, now: number) => {
        lookups.push(slug);
        return products.getPublishedDetailBySlug(slug, now);
      },
    },
    now: NOW,
  });
}

function unpublish(slug: string, publishedAt: string): void {
  db.run("UPDATE products SET published_at = ? WHERE slug = ?", [publishedAt, slug]);
}

/** Schema + every table's row count + the connection's change counter. */
function snapshot(): string {
  const tables = db
    .query<{ name: string; sql: string | null }, []>(
      "SELECT name, sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type, name",
    )
    .all();
  const counts = tables
    .filter((t) => t.sql?.startsWith("CREATE TABLE") === true && !t.name.startsWith("sqlite_"))
    .map((t) => {
      const row = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "${t.name.replaceAll('"', '""')}"`).get();
      return `${t.name}=${row?.n ?? -1}`;
    });
  const changes = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
  return JSON.stringify({ tables, counts, changes });
}

describe("loadCompare (criterion 1)", () => {
  test("resolves published products in URL order", () => {
    const data = load({ p: ["walnut-desk", "canvas-tote-bag"] });
    expect(data.slugs).toEqual(["walnut-desk", "canvas-tote-bag"]);
    expect(data.products.map((p) => p.slug)).toEqual(["walnut-desk", "canvas-tote-bag"]);
    expect(data.products[0]?.specs.length).toBeGreaterThan(0);
    expect(data.differencesOnly).toBe(false);
  });

  test("unknown slugs are dropped", () => {
    expect(load({ p: ["no-such-product", "walnut-desk", "ghost"] }).slugs).toEqual(["walnut-desk"]);
  });

  test("unpublished (future) slugs are dropped", () => {
    unpublish("canvas-tote-bag", new Date(NOW + 86_400_000).toISOString());
    expect(load({ p: ["canvas-tote-bag", "walnut-desk"] }).slugs).toEqual(["walnut-desk"]);
  });

  test("unparseable published_at counts as unpublished", () => {
    unpublish("canvas-tote-bag", "not a date");
    expect(load({ p: ["canvas-tote-bag", "walnut-desk"] }).slugs).toEqual(["walnut-desk"]);
  });

  test("duplicates are deduped (first wins)", () => {
    expect(load({ p: ["walnut-desk", "canvas-tote-bag", "walnut-desk"] }).slugs).toEqual([
      "walnut-desk",
      "canvas-tote-bag",
    ]);
  });

  test("more than 4 valid slugs are capped in order", () => {
    const p = ["walnut-desk", "canvas-tote-bag", "brass-desk-lamp", "cork-yoga-mat", "enamel-pin-set", "bike-light-set"];
    expect(load({ p }).slugs).toEqual(p.slice(0, 4));
  });

  test("the cap applies after dropping unknown/unpublished slugs", () => {
    unpublish("brass-desk-lamp", new Date(NOW + 1000).toISOString());
    const p = ["ghost", "walnut-desk", "brass-desk-lamp", "canvas-tote-bag", "cork-yoga-mat", "enamel-pin-set", "bike-light-set"];
    expect(load({ p }).slugs).toEqual(["walnut-desk", "canvas-tote-bag", "cork-yoga-mat", "enamel-pin-set"]);
  });

  test("stops querying once 4 products are resolved", () => {
    load({ p: ["walnut-desk", "canvas-tote-bag", "brass-desk-lamp", "cork-yoga-mat", "enamel-pin-set"] });
    expect(lookups).toHaveLength(4);
  });

  test("hostile and malformed values never reach the database", () => {
    const data = load({ p: ["../etc", "%2e%2e", "a/b", "x".repeat(10_000), ["walnut-desk"]] });
    expect(data).toEqual({ products: [], slugs: [], differencesOnly: false, unavailable: true, capped: false });
    expect(lookups).toEqual([]);
  });

  test("500 slug-shaped unknown params cost a bounded number of queries", () => {
    const p = Array.from({ length: 500 }, (_, i) => `ghost-${i}`);
    expect(load({ p }).slugs).toEqual([]);
    expect(lookups.length).toBeLessThanOrEqual(16);
  });

  test("no params at all -> empty, no DB access", () => {
    expect(load({})).toEqual({ products: [], slugs: [], differencesOnly: false, unavailable: false, capped: false });
    expect(load(undefined).slugs).toEqual([]);
    expect(lookups).toEqual([]);
  });
});

describe("loadCompare: notice flags", () => {
  test("all found, within the cap: no flags", () => {
    expect(load({ p: ["walnut-desk", "canvas-tote-bag"] })).toMatchObject({ unavailable: false, capped: false });
  });

  test("unknown slug -> unavailable", () => {
    expect(load({ p: ["walnut-desk", "ghost"] })).toMatchObject({ unavailable: true, capped: false });
  });

  test("unpublished slug -> unavailable", () => {
    unpublish("walnut-desk", new Date(NOW + 60_000).toISOString());
    expect(load({ p: ["walnut-desk", "canvas-tote-bag"] })).toMatchObject({
      slugs: ["canvas-tote-bag"],
      unavailable: true,
    });
  });

  test("duplicates alone do not raise a notice", () => {
    expect(load({ p: ["walnut-desk", "walnut-desk"] })).toMatchObject({ unavailable: false, capped: false });
  });

  test("more than 4 usable -> capped", () => {
    const p = ["walnut-desk", "canvas-tote-bag", "brass-desk-lamp", "cork-yoga-mat", "enamel-pin-set"];
    expect(load({ p })).toMatchObject({ capped: true, unavailable: false });
    expect(load({ p: p.slice(0, 4) })).toMatchObject({ capped: false });
  });

  test("comma form resolves the same products", () => {
    expect(load({ p: "walnut-desk,canvas-tote-bag" }).slugs).toEqual(["walnut-desk", "canvas-tote-bag"]);
  });
});

describe("loadCompare: diff (criterion 3)", () => {
  test("diff=1 turns differences-only on", () => {
    expect(load({ p: ["walnut-desk", "canvas-tote-bag"], diff: "1" }).differencesOnly).toBe(true);
  });

  test.each<[unknown]>([["0"], ["true"], ["yes"], [""], [["0", "1"]], [1]])("diff=%p is off", (diff) => {
    expect(load({ p: ["walnut-desk", "canvas-tote-bag"], diff }).differencesOnly).toBe(false);
  });

  test("diff survives an empty selection", () => {
    expect(load({ diff: "1" })).toEqual({ products: [], slugs: [], differencesOnly: true, unavailable: false, capped: false });
  });
});

describe("loadCompare: read-only (criterion 4)", () => {
  test("no schema change, no row change, no write", () => {
    const before = snapshot();
    load({ p: ["walnut-desk", "canvas-tote-bag", "ghost", "walnut-desk", "brass-desk-lamp", "cork-yoga-mat", "enamel-pin-set"], diff: "1" });
    load({ p: "../etc" });
    expect(snapshot()).toBe(before);
  });
});

describe("publication rule (shared getPublishedDetailBySlug)", () => {
  test("published_at <= now inclusive; future, empty and garbage are unpublished", () => {
    unpublish("walnut-desk", new Date(NOW).toISOString());
    unpublish("brass-desk-lamp", new Date(NOW + 1).toISOString());
    unpublish("cork-yoga-mat", "");
    unpublish("enamel-pin-set", "garbage");
    const data = load({ p: ["walnut-desk", "brass-desk-lamp", "cork-yoga-mat", "enamel-pin-set"] });
    expect(data.slugs).toEqual(["walnut-desk"]);
    expect(data.unavailable).toBe(true);
  });

  test("a non-finite now publishes nothing", () => {
    const data = loadCompare({ p: ["walnut-desk"] }, { products, now: Number.NaN });
    expect(data.slugs).toEqual([]);
    expect(data.unavailable).toBe(true);
  });
});
