import { describe, expect, test } from "bun:test";
import type { Order } from "@/lib/types";
import { createDatabase, withTransaction } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedProducts } from "@/server/db/seed";
import { DuplicateIdempotencyKeyError, SqliteOrderRepository } from "./order-repository";

const NOW = new Date("2026-11-06T12:00:00.000Z");

function setup() {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedProducts(db);
  const repo = new SqliteOrderRepository(db, { now: () => NOW });
  return { db, repo };
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    status: "paid",
    items: [
      { productId: "prod_canvas-tote-bag", name: "Canvas Tote Bag", unitPriceCents: 1999, quantity: 2 },
      { productId: "prod_enamel-pin-set", name: "Enamel Pin Set", unitPriceCents: 50, quantity: 1 },
    ],
    subtotalCents: 4048,
    shippingCents: 0,
    totalCents: 4048,
    currency: "USD",
    address: {
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      line1: "1 Analytical Way",
      city: "London",
      region: "LDN",
      postalCode: "N1",
      country: "GB",
    },
    cardLast4: "4242",
    idempotencyKey: "key-1",
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function stockOf(db: ReturnType<typeof setup>["db"], id: string): number {
  const row = db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(id);
  if (row === null) throw new Error(`no product ${id}`);
  return row.stock;
}

describe("SqliteOrderRepository", () => {
  test("insertOrder + findById round-trips a paid order", () => {
    const { repo } = setup();
    const o = order();
    repo.insertOrder(o, "mock_ref");
    expect(repo.findById(o.id)).toEqual(o);
    expect(repo.findByIdempotencyKey("key-1")).toEqual(o);
  });

  test("line2 and failureCode round-trip; failureCode only for payment_failed", () => {
    const { db, repo } = setup();
    const failed = order({
      status: "payment_failed",
      failureCode: "DECLINED",
      address: { ...order().address, line2: "Flat 2" },
    });
    repo.insertOrder(failed, null);
    expect(repo.findById(failed.id)).toEqual(failed);

    const paidWithStrayCode = order({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", idempotencyKey: "key-2", failureCode: "DECLINED" });
    repo.insertOrder(paidWithStrayCode, "ref");
    const read = repo.findById(paidWithStrayCode.id);
    expect(read?.failureCode).toBeUndefined();
    expect("failureCode" in (read ?? {})).toBe(false);
    const row = db.query<{ failure_code: string | null }, [string]>("SELECT failure_code FROM orders WHERE id = ?").get(paidWithStrayCode.id);
    expect(row?.failure_code).toBeNull();
  });

  test("unknown id / key return null", () => {
    const { repo } = setup();
    expect(repo.findById("nope")).toBeNull();
    expect(repo.findByIdempotencyKey("nope")).toBeNull();
  });

  test("duplicate idempotency key throws DuplicateIdempotencyKeyError and rolls back in a transaction", () => {
    const { db, repo } = setup();
    repo.insertOrder(order(), null);
    const dup = order({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    expect(() => withTransaction(db, () => repo.insertOrder(dup, null))).toThrow(DuplicateIdempotencyKeyError);
    expect(repo.findById(dup.id)).toBeNull();
    const count = db.query<{ n: number }, []>("SELECT count(*) AS n FROM order_items").get();
    expect(count?.n).toBe(2);
  });

  test("restoreStock adds quantities back and sets updated_at", () => {
    const { db, repo } = setup();
    const before = stockOf(db, "prod_walnut-desk");
    repo.restoreStock([
      { productId: "prod_walnut-desk", quantity: 2 },
      { productId: "prod_missing", quantity: 1 },
    ]);
    expect(stockOf(db, "prod_walnut-desk")).toBe(before + 2);
    const row = db.query<{ updated_at: string }, []>("SELECT updated_at FROM products WHERE id = 'prod_walnut-desk'").get();
    expect(row?.updated_at).toBe(NOW.toISOString());
  });

  test("restoreStock rejects non-positive quantities", () => {
    const { repo } = setup();
    expect(() => repo.restoreStock([{ productId: "prod_walnut-desk", quantity: 0 }])).toThrow(RangeError);
    expect(() => repo.restoreStock([{ productId: "prod_walnut-desk", quantity: 1.5 }])).toThrow(RangeError);
  });
});
