import { describe, expect, test } from "bun:test";
import type { FulfillmentStatus, OrderEvent } from "@/lib/types";
import type { DeliveryEstimator, FulfillmentDeps, FulfillmentInput } from "./fulfillment";
import { TIMELINE_LABELS, timeline } from "./timeline";

const H = 60 * 60 * 1000;
const D = 24 * H;
const iso = (t: number): string => new Date(t).toISOString();

const CREATED = "2026-11-02T10:00:00.000Z"; // Monday
const C = Date.parse(CREATED);
const PACKED = C + 2 * H;
const SHIPPED = Date.parse("2026-11-03T10:00:00.000Z");
const DELIVERED = Date.parse("2026-11-05T14:00:00.000Z");
const OFD = DELIVERED - 8 * H;

const stub: DeliveryEstimator = (_m, p) => {
  const d = new Date(typeof p === "number" ? p : Date.parse(p));
  const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start: iso(day0 + 3 * D), end: iso(day0 + 5 * D) };
};
const deps: FulfillmentDeps = { estimateDelivery: stub };

function order(overrides: Partial<FulfillmentInput> = {}): FulfillmentInput {
  return { createdAt: CREATED, status: "paid", method: { id: "standard", minDays: 5, maxDays: 8 }, ...overrides };
}

let nextId = 1;
function ev(status: FulfillmentStatus, at: string): OrderEvent {
  return { id: nextId++, orderId: "o1", status, at, note: null };
}

describe("timeline", () => {
  test("labels", () => {
    expect(TIMELINE_LABELS).toEqual({
      processing: "Order placed",
      packed: "Packed",
      shipped: "Shipped",
      out_for_delivery: "Out for delivery",
      delivered: "Delivered",
      cancelled: "Cancelled",
    });
  });

  test("payment_failed has no timeline", () => {
    expect(timeline(order({ status: "payment_failed" }), DELIVERED, deps, [])).toEqual([]);
  });

  test("just placed: processing current, rest upcoming with null at", () => {
    expect(timeline(order(), C + 1, deps, [])).toEqual([
      { status: "processing", at: CREATED, state: "current", label: "Order placed" },
      { status: "packed", at: null, state: "upcoming", label: "Packed" },
      { status: "shipped", at: null, state: "upcoming", label: "Shipped" },
      { status: "out_for_delivery", at: null, state: "upcoming", label: "Out for delivery" },
      { status: "delivered", at: null, state: "upcoming", label: "Delivered" },
    ]);
  });

  test("shipped exactly on boundary: two complete, shipped current", () => {
    const t = timeline(order(), SHIPPED, deps, []);
    expect(t.map((s) => s.state)).toEqual(["complete", "complete", "current", "upcoming", "upcoming"]);
    expect(t.map((s) => s.at)).toEqual([CREATED, iso(PACKED), iso(SHIPPED), null, null]);
  });

  test("delivered: every step complete with derived timestamps", () => {
    const t = timeline(order(), DELIVERED, deps, []);
    expect(t.every((s) => s.state === "complete")).toBe(true);
    expect(t.map((s) => s.at)).toEqual([C, PACKED, SHIPPED, OFD, DELIVERED].map(iso));
  });

  test("persisted timestamps win over derived ones", () => {
    const packedAt = iso(PACKED + 17 * 60 * 1000);
    const t = timeline(order(), SHIPPED, deps, [ev("processing", CREATED), ev("packed", packedAt)]);
    expect(t[1]).toEqual({ status: "packed", at: packedAt, state: "complete", label: "Packed" });
    expect(t[2]?.at).toBe(iso(SHIPPED));
  });

  test("invalid persisted timestamp falls back to the derived one", () => {
    const t = timeline(order(), SHIPPED, deps, [ev("packed", "bad")]);
    expect(t[1]?.at).toBe(iso(PACKED));
  });

  test("a persisted event ahead of the clock moves the current step forward", () => {
    const shippedAt = iso(C + H);
    const t = timeline(order(), C + H, deps, [ev("shipped", shippedAt)]);
    expect(t.map((s) => s.state)).toEqual(["complete", "complete", "current", "upcoming", "upcoming"]);
    expect(t[2]?.at).toBe(shippedAt);
  });

  test("clock skew: processing current, no negative anything", () => {
    const t = timeline(order(), C - D, deps, []);
    expect(t[0]).toEqual({ status: "processing", at: CREATED, state: "current", label: "Order placed" });
    expect(t.slice(1).every((s) => s.state === "upcoming" && s.at === null)).toBe(true);
  });

  test("cancelled within the window: order placed + cancelled, regardless of time", () => {
    const cancelAt = iso(C + 10 * 60 * 1000);
    const c = order({ fulfillmentStatus: "cancelled", cancelledAt: cancelAt });
    for (const now of [C + 11 * 60 * 1000, DELIVERED, DELIVERED + 30 * D]) {
      expect(timeline(c, now, deps, [])).toEqual([
        { status: "processing", at: CREATED, state: "complete", label: "Order placed" },
        { status: "cancelled", at: cancelAt, state: "cancelled", label: "Cancelled" },
      ]);
    }
  });

  test("cancelled later (e.g. admin): includes steps reached before cancellation only", () => {
    const cancelAt = iso(SHIPPED + H);
    const t = timeline(order({ cancelledAt: cancelAt }), DELIVERED, deps, []);
    expect(t.map((s) => [s.status, s.state])).toEqual([
      ["processing", "complete"],
      ["packed", "complete"],
      ["shipped", "complete"],
      ["cancelled", "cancelled"],
    ]);
  });

  test("cancelled: persisted cancelled event wins; no cancelledAt -> null at", () => {
    const persistedAt = iso(C + 20 * 60 * 1000);
    const a = timeline(order({ fulfillmentStatus: "cancelled" }), DELIVERED, deps, [ev("cancelled", persistedAt)]);
    expect(a.at(-1)).toEqual({ status: "cancelled", at: persistedAt, state: "cancelled", label: "Cancelled" });
    const b = timeline(order({ fulfillmentStatus: "cancelled" }), DELIVERED, deps, []);
    expect(b).toEqual([
      { status: "processing", at: CREATED, state: "complete", label: "Order placed" },
      { status: "cancelled", at: null, state: "cancelled", label: "Cancelled" },
    ]);
  });

  test("invalid createdAt throws TypeError", () => {
    expect(() => timeline(order({ createdAt: "x" }), C, deps, [])).toThrow(TypeError);
  });
});
