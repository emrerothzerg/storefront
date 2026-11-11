import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { DuplicateIdempotencyKeyError, SqliteOrderRepository, type NewOrderV2 } from "./order-repository";

const NOW = new Date("2026-11-04T10:00:00.000Z");
const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";

function setup(): { db: Database; repo: SqliteOrderRepository } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: NOW });
  return { db, repo: new SqliteOrderRepository(db, { now: () => NOW }) };
}

function order(overrides: Partial<NewOrderV2> = {}): NewOrderV2 {
  return {
    id: crypto.randomUUID(),
    sessionId: S1,
    status: "paid",
    items: [
      { productId: "prod_canvas-tote-bag", name: "Canvas Tote Bag", unitPriceCents: 1999, quantity: 2, productSlug: "canvas-tote-bag", imageUrl: "/images/products/canvas-tote-bag.svg" },
      { productId: "prod_gone", name: "Gone Thing", unitPriceCents: 50, quantity: 1, productSlug: null, imageUrl: null },
    ],
    subtotalCents: 4048,
    shippingCents: 999,
    discountCents: 404,
    totalCents: 4643,
    currency: "USD",
    address: { fullName: "Ada", email: "ada@example.com", line1: "1 Way", city: "London", region: "LDN", postalCode: "N1", country: "GB" },
    cardLast4: "4242",
    idempotencyKey: crypto.randomUUID(),
    createdAt: NOW.toISOString(),
    couponCode: "WELCOME10",
    shippingMethodId: "express",
    shippingMethodName: "Express",
    estimatedDeliveryStart: "2026-11-06T00:00:00.000Z",
    estimatedDeliveryEnd: "2026-11-09T00:00:00.000Z",
    deliveryNote: "Back door",
    ...overrides,
  };
}

describe("SqliteOrderRepository v2", () => {
  test("insertOrderV2 + findRecordById round-trip every v2 column and snapshot", () => {
    const { repo } = setup();
    const o = order();
    repo.insertOrderV2(o, "mock_1");
    const record = repo.findRecordById(o.id);
    expect(record).toMatchObject({
      id: o.id,
      sessionId: S1,
      status: "paid",
      failureCode: null,
      items: o.items,
      subtotalCents: 4048,
      shippingCents: 999,
      discountCents: 404,
      totalCents: 4643,
      fulfillmentStatus: "processing",
      couponCode: "WELCOME10",
      shippingMethodId: "express",
      shippingMethodName: "Express",
      estimatedDeliveryStart: o.estimatedDeliveryStart,
      estimatedDeliveryEnd: o.estimatedDeliveryEnd,
      cancelledAt: null,
      shippedAt: null,
      deliveredAt: null,
      phone: null,
      deliveryNote: "Back door",
    });
    // The MVP reader keeps its shape and now reports the stored shipping.
    expect(repo.findById(o.id)?.shippingCents).toBe(999);
    expect(repo.findRecordById(crypto.randomUUID())).toBeNull();
    expect(() => repo.insertOrderV2({ ...o, id: crypto.randomUUID() }, null)).toThrow(DuplicateIdempotencyKeyError);
  });

  test("payment_failed rows keep their failure code; listPaidRecords excludes them, filters by owner and since, newest first", () => {
    const { repo } = setup();
    const old = order({ createdAt: "2026-01-01T00:00:00.000Z" });
    const mid = order({ createdAt: "2026-06-01T00:00:00.000Z" });
    const failed = order({ status: "payment_failed", failureCode: "DECLINED", createdAt: "2026-07-01T00:00:00.000Z" });
    const foreign = order({ sessionId: S2 });
    for (const o of [old, mid, failed, foreign]) repo.insertOrderV2(o, null);
    expect(repo.findRecordById(failed.id)?.failureCode).toBe("DECLINED");
    expect(repo.listPaidRecords(S1, null).map((r) => r.id)).toEqual([mid.id, old.id]);
    expect(repo.listPaidRecords(S1, "2026-06-01T00:00:00.000Z").map((r) => r.id)).toEqual([mid.id]);
    expect(repo.listPaidRecords(S1, "2026-06-01T00:00:00.001Z")).toEqual([]);
    expect(repo.listPaidRecords("' OR 1=1 --", null)).toEqual([]);
    expect(repo.listPaidRecords(S1, null)[0]?.items.length).toBe(2);
  });

  test("insertEventIfAbsent writes at most once per status", () => {
    const { repo } = setup();
    const o = order();
    repo.insertOrderV2(o, null);
    expect(repo.insertEventIfAbsent(o.id, "processing", o.createdAt, null)).toBe(true);
    expect(repo.insertEventIfAbsent(o.id, "processing", "2030-01-01T00:00:00.000Z", "dup")).toBe(false);
    expect(repo.insertEventIfAbsent(o.id, "packed", "2026-11-04T12:00:00.000Z", null)).toBe(true);
    expect(repo.listEvents(o.id).map((e) => [e.status, e.at, e.note])).toEqual([
      ["processing", o.createdAt, null],
      ["packed", "2026-11-04T12:00:00.000Z", null],
    ]);
  });

  test("advanceFulfillment and markCancelled are compare-and-set", () => {
    const { repo } = setup();
    const o = order();
    repo.insertOrderV2(o, null);
    expect(repo.advanceFulfillment(o.id, "packed", "shipped", "x", null)).toBe(false);
    expect(repo.advanceFulfillment(o.id, "processing", "shipped", "2026-11-05T10:00:00.000Z", null)).toBe(true);
    expect(repo.advanceFulfillment(o.id, "shipped", "delivered", "IGNORED", "2026-11-06T14:00:00.000Z")).toBe(true);
    expect(repo.findRecordById(o.id)).toMatchObject({ fulfillmentStatus: "delivered", shippedAt: "2026-11-05T10:00:00.000Z", deliveredAt: "2026-11-06T14:00:00.000Z" });
    expect(repo.markCancelled(o.id, NOW.toISOString())).toBe(false);

    const p = order();
    repo.insertOrderV2(p, null);
    expect(repo.markCancelled(p.id, NOW.toISOString())).toBe(true);
    expect(repo.markCancelled(p.id, NOW.toISOString())).toBe(false);
    expect(repo.findRecordById(p.id)).toMatchObject({ fulfillmentStatus: "cancelled", cancelledAt: NOW.toISOString() });
    expect(repo.advanceFulfillment(p.id, "processing", "packed", null, null)).toBe(false);

    const failed = order({ status: "payment_failed", failureCode: "DECLINED" });
    repo.insertOrderV2(failed, null);
    expect(repo.markCancelled(failed.id, NOW.toISOString())).toBe(false);
  });

  test("shipping timing includes inactive methods; availability and purchased lines", () => {
    const { db, repo } = setup();
    db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    expect(repo.findShippingMethodTiming("express")).toEqual({ id: "express", minDays: 2, maxDays: 3 });
    expect(repo.findShippingMethodTiming("nope")).toBeNull();

    const availability = repo.getProductAvailability(["prod_canvas-tote-bag", "missing", "\"); DROP TABLE products; --"]);
    expect(availability.map((a) => [a.productId, a.stock])).toEqual([["prod_canvas-tote-bag", 42]]);
    expect(repo.getProductAvailability([])).toEqual([]);

    const first = order({ createdAt: "2026-11-01T00:00:00.000Z" });
    const second = order({ createdAt: "2026-11-02T00:00:00.000Z", items: [{ productId: "prod_gone", name: "Gone Thing", unitPriceCents: 50, quantity: 1, productSlug: null, imageUrl: null }] });
    const cancelled = order({ createdAt: "2026-11-03T00:00:00.000Z" });
    for (const o of [first, second, cancelled]) repo.insertOrderV2(o, null);
    repo.markCancelled(cancelled.id, NOW.toISOString());
    expect(repo.listPurchasedLines(S1).map((l) => [l.productId, l.orderedAt])).toEqual([
      ["prod_gone", "2026-11-02T00:00:00.000Z"],
      ["prod_canvas-tote-bag", "2026-11-01T00:00:00.000Z"],
      ["prod_gone", "2026-11-01T00:00:00.000Z"],
    ]);
    expect(repo.listPurchasedLines(S2)).toEqual([]);
  });
});
