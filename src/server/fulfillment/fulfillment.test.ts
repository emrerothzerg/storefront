import { describe, expect, test } from "bun:test";
import type { FulfillmentStatus } from "@/lib/types";
import {
  CANCEL_WINDOW_MS,
  DEFAULT_METHOD,
  FULFILLMENT_SEQUENCE,
  SIMULATED_TRACKING_NOTICE,
  addBusinessDaysUtc,
  cancellableUntil,
  deriveStatus,
  estimatedDelivery,
  isCancellable,
  isNextDayMethod,
  nextEvents,
  statusAt,
  type DeliveryEstimator,
  type FulfillmentDeps,
  type FulfillmentInput,
} from "./fulfillment";

const H = 60 * 60 * 1000;
const D = 24 * H;
const ms = (iso: string): number => Date.parse(iso);

/** Monday 2026-11-02 10:00 UTC. */
const CREATED = "2026-11-02T10:00:00.000Z";
const C = ms(CREATED);

/** Stub: start = placed date + 3 calendar days at 00:00Z, end = + 5 days. */
const stubEstimator: DeliveryEstimator = (_method, placedAt) => {
  const p = typeof placedAt === "number" ? placedAt : Date.parse(placedAt);
  const d = new Date(p);
  const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return {
    start: new Date(day0 + 3 * D).toISOString(),
    end: new Date(day0 + 5 * D).toISOString(),
  };
};
const deps: FulfillmentDeps = { estimateDelivery: stubEstimator };

/** Hand-written business-day estimator (Mon-Fri, UTC). */
const businessDayEstimator: DeliveryEstimator = (method, placedAt) => {
  const p = typeof placedAt === "number" ? placedAt : Date.parse(placedAt);
  const add = (n: number): string => {
    let t = p;
    let left = n;
    while (left > 0) {
      t += D;
      const wd = new Date(t).getUTCDay();
      if (wd !== 0 && wd !== 6) left -= 1;
    }
    return new Date(t).toISOString();
  };
  return { start: add(method.minDays), end: add(method.maxDays) };
};

function order(overrides: Partial<FulfillmentInput> = {}): FulfillmentInput {
  return {
    createdAt: CREATED,
    status: "paid",
    method: { id: "standard", minDays: 5, maxDays: 8 },
    ...overrides,
  };
}

// With the stub and a standard method created Mon 10:00:
const PACKED = C + 2 * H; // Mon 12:00
const SHIPPED = ms("2026-11-03T10:00:00.000Z"); // Tue 10:00 (1 business day)
const DELIVERED = ms("2026-11-05T14:00:00.000Z"); // estimate start date @ 14:00
const OFD = DELIVERED - 8 * H; // Thu 06:00

describe("constants", () => {
  test("contract values", () => {
    expect(CANCEL_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(FULFILLMENT_SEQUENCE).toEqual([
      "processing",
      "packed",
      "shipped",
      "out_for_delivery",
      "delivered",
    ]);
    expect(SIMULATED_TRACKING_NOTICE).toBe("Tracking is simulated in this demo store.");
    expect(DEFAULT_METHOD).toEqual({ id: "standard", minDays: 5, maxDays: 8 });
  });
});

describe("deriveStatus boundaries (criterion 1)", () => {
  const cases: [string, number, FulfillmentStatus][] = [
    ["created", C, "processing"],
    ["packed - 1ms", PACKED - 1, "processing"],
    ["packed", PACKED, "packed"],
    ["shipped - 1ms", SHIPPED - 1, "packed"],
    ["shipped", SHIPPED, "shipped"],
    ["ofd - 1ms", OFD - 1, "shipped"],
    ["ofd", OFD, "out_for_delivery"],
    ["delivered - 1ms", DELIVERED - 1, "out_for_delivery"],
    ["delivered", DELIVERED, "delivered"],
    ["a year later", DELIVERED + 365 * D, "delivered"],
  ];
  for (const [name, now, expected] of cases) {
    test(`${name} -> ${expected}`, () => {
      expect(deriveStatus(order(), now, deps)).toBe(expected);
    });
  }

  test("deterministic: same inputs, same output, estimator called with createdAt as placedAt and now", () => {
    const calls: unknown[][] = [];
    const spy: DeliveryEstimator = (m, p, n) => {
      calls.push([m, p, n]);
      return stubEstimator(m, p, n);
    };
    const a = deriveStatus(order(), OFD, { estimateDelivery: spy });
    const b = deriveStatus(order(), OFD, { estimateDelivery: spy });
    expect(a).toBe(b);
    expect(calls[0]).toEqual([{ minDays: 5, maxDays: 8 }, C, C]);
  });

  test("next-day method ships at createdAt + 6h", () => {
    const nd = order({ method: { id: "next_day", minDays: 1, maxDays: 1 } });
    expect(deriveStatus(nd, C + 6 * H - 1, deps)).toBe("packed");
    expect(deriveStatus(nd, C + 6 * H, deps)).toBe("shipped");
    expect(statusAt(nd, "shipped", deps)).toBe(new Date(C + 6 * H).toISOString());
  });

  test("isNextDayMethod: id next_day or maxDays <= 1", () => {
    expect(isNextDayMethod({ id: "next_day", maxDays: 3 })).toBe(true);
    expect(isNextDayMethod({ id: "same_day", maxDays: 0 })).toBe(true);
    expect(isNextDayMethod({ id: "express", maxDays: 3 })).toBe(false);
    expect(isNextDayMethod(null)).toBe(false);
  });

  test("shipped skips the weekend (Friday order ships Monday)", () => {
    const fri = order({ createdAt: "2026-11-06T18:00:00.000Z" });
    expect(statusAt(fri, "shipped", deps)).toBe("2026-11-09T18:00:00.000Z");
    const sat = order({ createdAt: "2026-11-07T08:00:00.000Z" });
    expect(statusAt(sat, "shipped", deps)).toBe("2026-11-09T08:00:00.000Z");
    const sun = order({ createdAt: "2026-11-08T23:30:00.000Z" });
    expect(statusAt(sun, "shipped", deps)).toBe("2026-11-09T23:30:00.000Z");
  });

  test("O1: weekend next-day orders ship Monday (same time of day) + 6h", () => {
    const nd = { id: "next_day", minDays: 1, maxDays: 1 } as const;
    const sat = order({ createdAt: "2026-11-07T10:00:00.000Z", method: nd });
    expect(statusAt(sat, "shipped", deps)).toBe("2026-11-09T16:00:00.000Z");
    const sun = order({ createdAt: "2026-11-08T20:00:00.000Z", method: nd });
    expect(statusAt(sun, "shipped", deps)).toBe("2026-11-10T02:00:00.000Z");
    const satMs = Date.parse("2026-11-09T16:00:00.000Z");
    expect(deriveStatus(sat, satMs - 1, deps)).toBe("packed");
    expect(deriveStatus(sat, satMs, deps)).toBe("shipped");
  });

  test("O1: weekday orders unchanged (Friday next-day evening ships Saturday +6h)", () => {
    const nd = { id: "next_day", minDays: 1, maxDays: 1 } as const;
    const fri = order({ createdAt: "2026-11-06T20:00:00.000Z", method: nd });
    expect(statusAt(fri, "shipped", deps)).toBe("2026-11-07T02:00:00.000Z");
  });

  test("null method uses the standard default (5..8) for the estimator", () => {
    const seen: number[][] = [];
    const spy: DeliveryEstimator = (m, p, n) => {
      seen.push([m.minDays, m.maxDays]);
      return stubEstimator(m, p, n);
    };
    estimatedDelivery(order({ method: null }), { estimateDelivery: spy });
    expect(seen).toEqual([[5, 8]]);
  });

  test("estimate earlier than shipping: out_for_delivery and delivered clamp to shipped", () => {
    const sameDay: DeliveryEstimator = (_m, p) => {
      const iso = new Date(typeof p === "number" ? p : Date.parse(p)).toISOString();
      return { start: iso, end: iso };
    };
    const d2: FulfillmentDeps = { estimateDelivery: sameDay };
    const shipped = statusAt(order(), "shipped", d2);
    expect(statusAt(order(), "out_for_delivery", d2)).toBe(shipped);
    expect(statusAt(order(), "delivered", d2)).toBe(shipped);
    expect(deriveStatus(order(), SHIPPED - 1, d2)).toBe("packed");
    expect(deriveStatus(order(), SHIPPED, d2)).toBe("delivered");
  });

  test("without deps the built-in business-day estimator is used", () => {
    // Mon + 5 business days = Mon 2026-11-09 -> delivered 14:00 that day.
    expect(deriveStatus(order(), ms("2026-11-09T13:59:59.999Z"))).toBe("out_for_delivery");
    expect(deriveStatus(order(), ms("2026-11-09T14:00:00.000Z"))).toBe("delivered");
  });

  test("never regresses below a persisted sequenced status", () => {
    expect(deriveStatus(order({ fulfillmentStatus: "shipped" }), C + H, deps)).toBe("shipped");
    expect(deriveStatus(order({ fulfillmentStatus: "packed" }), DELIVERED, deps)).toBe("delivered");
  });
});

describe("clock skew (criterion 2)", () => {
  test("now < createdAt -> processing", () => {
    expect(deriveStatus(order(), C - 1, deps)).toBe("processing");
    expect(deriveStatus(order(), C - 10 * D, deps)).toBe("processing");
  });
  test("no events and still cancellable (elapsed clamped to 0)", () => {
    expect(nextEvents(order(), C - 1, deps, [])).toEqual([]);
    expect(isCancellable(order(), C - 10 * D)).toBe(true);
  });
});

describe("terminal states (criterion 3)", () => {
  const cancelled = order({
    fulfillmentStatus: "cancelled",
    cancelledAt: new Date(C + 10 * 60 * 1000).toISOString(),
  });
  test("cancelled stays cancelled at any time", () => {
    for (const now of [C - D, C, PACKED, SHIPPED, OFD, DELIVERED, DELIVERED + 100 * D]) {
      expect(deriveStatus(cancelled, now, deps)).toBe("cancelled");
    }
  });
  test("cancelledAt alone (status not yet persisted) means cancelled", () => {
    const c = order({ cancelledAt: new Date(C + 60_000).toISOString() });
    expect(deriveStatus(c, DELIVERED, deps)).toBe("cancelled");
    expect(isCancellable(c, C + 60_000)).toBe(false);
  });
  test("cancelled: statusAt null after cancellation, cancelled = cancelledAt", () => {
    expect(statusAt(cancelled, "processing", deps)).toBe(CREATED);
    expect(statusAt(cancelled, "packed", deps)).toBeNull();
    expect(statusAt(cancelled, "delivered", deps)).toBeNull();
    expect(statusAt(cancelled, "cancelled", deps)).toBe(cancelled.cancelledAt ?? "");
    expect(statusAt(order(), "cancelled", deps)).toBeNull();
    expect(statusAt(order({ fulfillmentStatus: "cancelled" }), "cancelled", deps)).toBeNull();
  });
  test("payment_failed: processing, no statusAt, no events, no estimate, not cancellable", () => {
    const failed = order({ status: "payment_failed" });
    expect(deriveStatus(failed, DELIVERED, deps)).toBe("processing");
    for (const s of [...FULFILLMENT_SEQUENCE, "cancelled"] as const) {
      expect(statusAt(failed, s, deps)).toBeNull();
    }
    expect(nextEvents(failed, DELIVERED, deps, [])).toEqual([]);
    expect(estimatedDelivery(failed, deps)).toBeNull();
    expect(isCancellable(failed, C)).toBe(false);
  });
  test("estimatedDelivery null for cancelled", () => {
    expect(estimatedDelivery(cancelled, deps)).toBeNull();
  });
});

describe("isCancellable (criterion 4)", () => {
  test("window boundaries: inclusive at 30 min, false 1ms after", () => {
    expect(isCancellable(order(), C)).toBe(true);
    expect(isCancellable(order(), C + CANCEL_WINDOW_MS - 1)).toBe(true);
    expect(isCancellable(order(), C + CANCEL_WINDOW_MS)).toBe(true);
    expect(isCancellable(order(), C + CANCEL_WINDOW_MS + 1)).toBe(false);
  });
  test("false when persisted status is past processing", () => {
    for (const s of ["packed", "shipped", "out_for_delivery", "delivered", "cancelled"] as const) {
      expect(isCancellable(order({ fulfillmentStatus: s }), C + 60_000)).toBe(false);
    }
    expect(isCancellable(order({ fulfillmentStatus: "processing" }), C + 60_000)).toBe(true);
  });
  test("false at derived packed/shipped/delivered times", () => {
    for (const now of [PACKED, SHIPPED, OFD, DELIVERED]) {
      expect(isCancellable(order(), now)).toBe(false);
    }
  });
  test("cancellableUntil = createdAt + 30 min", () => {
    expect(cancellableUntil(order())).toBe("2026-11-02T10:30:00.000Z");
  });
});

describe("nextEvents (criterion 5)", () => {
  test("only not-yet-persisted, chronological, stamped with offsets (not now)", () => {
    const now = SHIPPED + 123_456;
    expect(nextEvents(order(), now, deps, ["processing"])).toEqual([
      { status: "packed", at: new Date(PACKED).toISOString() },
      { status: "shipped", at: new Date(SHIPPED).toISOString() },
    ]);
  });
  test("all reached events when nothing persisted; none when all persisted", () => {
    const all = nextEvents(order(), DELIVERED + D, deps, []);
    expect(all.map((e) => e.status)).toEqual([...FULFILLMENT_SEQUENCE]);
    expect(all.map((e) => e.at)).toEqual(
      [C, PACKED, SHIPPED, OFD, DELIVERED].map((t) => new Date(t).toISOString()),
    );
    expect(nextEvents(order(), DELIVERED + D, deps, [...FULFILLMENT_SEQUENCE])).toEqual([]);
  });
  test("gaps in persisted statuses are filled, order is preserved", () => {
    const evs = nextEvents(order(), DELIVERED, deps, ["shipped", "processing"]);
    expect(evs.map((e) => e.status)).toEqual(["packed", "out_for_delivery", "delivered"]);
  });
  test("exactly on a boundary the event is included", () => {
    expect(nextEvents(order(), PACKED, deps, ["processing"]).map((e) => e.status)).toEqual(["packed"]);
    expect(nextEvents(order(), PACKED - 1, deps, ["processing"])).toEqual([]);
  });
  test("cancelled: events before cancellation then the cancelled event at cancelledAt", () => {
    const cancelAt = new Date(C + 5 * 60 * 1000).toISOString();
    const c = order({ fulfillmentStatus: "cancelled", cancelledAt: cancelAt });
    expect(nextEvents(c, DELIVERED, deps, [])).toEqual([
      { status: "processing", at: CREATED },
      { status: "cancelled", at: cancelAt },
    ]);
    expect(nextEvents(c, DELIVERED, deps, ["processing", "cancelled"])).toEqual([]);
  });
  test("cancelled without cancelledAt never fabricates a timestamp", () => {
    const c = order({ fulfillmentStatus: "cancelled" });
    expect(nextEvents(c, DELIVERED, deps, [])).toEqual([{ status: "processing", at: CREATED }]);
  });
});

describe("estimated delivery (criterion 6)", () => {
  test("stub: delivered date equals estimate start date", () => {
    const est = estimatedDelivery(order(), deps);
    expect(est).toEqual(stubEstimator(DEFAULT_METHOD, C));
    expect(statusAt(order(), "delivered", deps)?.slice(0, 10)).toBe(est?.start.slice(0, 10) ?? "x");
  });
  for (const [label, createdAt, method] of [
    ["standard, Friday evening", "2026-11-06T18:00:00.000Z", { id: "standard", minDays: 5, maxDays: 8 }],
    ["express, Wednesday", "2026-11-04T09:15:00.000Z", { id: "express", minDays: 2, maxDays: 3 }],
    ["next_day, Friday evening", "2026-11-06T18:00:00.000Z", { id: "next_day", minDays: 1, maxDays: 1 }],
  ] as const) {
    test(`business-day estimator (${label}): delivered = estimate start date at 14:00Z`, () => {
      const bd: FulfillmentDeps = { estimateDelivery: businessDayEstimator };
      const o = order({ createdAt, method });
      const est = estimatedDelivery(o, bd);
      expect(est).not.toBeNull();
      const startDate = est?.start.slice(0, 10) ?? "";
      expect(statusAt(o, "delivered", bd)).toBe(`${startDate}T14:00:00.000Z`);
      // and the derived status flips to delivered exactly then
      const deliveredMs = ms(`${startDate}T14:00:00.000Z`);
      expect(deriveStatus(o, deliveredMs - 1, bd)).toBe("out_for_delivery");
      expect(deriveStatus(o, deliveredMs, bd)).toBe("delivered");
    });
  }
  test("business-day: Friday standard order delivers Friday next week", () => {
    const bd: FulfillmentDeps = { estimateDelivery: businessDayEstimator };
    const o = order({ createdAt: "2026-11-06T18:00:00.000Z" });
    expect(statusAt(o, "delivered", bd)).toBe("2026-11-13T14:00:00.000Z");
    expect(statusAt(o, "out_for_delivery", bd)).toBe("2026-11-13T06:00:00.000Z");
  });
});

describe("programming errors", () => {
  const bad = order({ createdAt: "not a date" });
  test("invalid createdAt throws TypeError from every function", () => {
    expect(() => deriveStatus(bad, C, deps)).toThrow(TypeError);
    expect(() => statusAt(bad, "packed", deps)).toThrow(TypeError);
    expect(() => isCancellable(bad, C)).toThrow(TypeError);
    expect(() => cancellableUntil(bad)).toThrow(TypeError);
    expect(() => nextEvents(bad, C, deps, [])).toThrow(TypeError);
    expect(() => estimatedDelivery(bad, deps)).toThrow(TypeError);
  });
  test("invalid createdAt throws even for payment_failed orders", () => {
    expect(() => deriveStatus({ ...bad, status: "payment_failed" }, C, deps)).toThrow(TypeError);
  });
  test("invalid cancelledAt throws TypeError from every function (paid and payment_failed)", () => {
    for (const status of ["paid", "payment_failed"] as const) {
      const o = order({ status, cancelledAt: "nope" });
      expect(() => deriveStatus(o, C, deps)).toThrow(TypeError);
      expect(() => statusAt(o, "packed", deps)).toThrow(TypeError);
      expect(() => isCancellable(o, C)).toThrow(TypeError);
      expect(() => nextEvents(o, C, deps, [])).toThrow(TypeError);
      expect(() => estimatedDelivery(o, deps)).toThrow(TypeError);
    }
  });
  test("non-finite nowMs throws TypeError", () => {
    expect(() => deriveStatus(order(), Number.NaN, deps)).toThrow(TypeError);
    expect(() => isCancellable(order(), Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
  test("estimator returning an invalid date throws TypeError", () => {
    const broken: FulfillmentDeps = {
      estimateDelivery: () => ({ start: "garbage", end: "garbage" }),
    };
    expect(() => deriveStatus(order(), DELIVERED, broken)).toThrow(TypeError);
    expect(() => estimatedDelivery(order(), broken)).toThrow(TypeError);
  });
  test("estimator is not consulted before the packed offset", () => {
    const boom: FulfillmentDeps = {
      estimateDelivery: () => {
        throw new Error("should not be called");
      },
    };
    expect(deriveStatus(order(), PACKED - 1, boom)).toBe("processing");
  });
});

describe("addBusinessDaysUtc", () => {
  test("skips Saturday and Sunday, keeps time of day", () => {
    expect(new Date(addBusinessDaysUtc(ms("2026-11-06T18:00:00.000Z"), 1)).toISOString()).toBe(
      "2026-11-09T18:00:00.000Z",
    );
    expect(new Date(addBusinessDaysUtc(ms("2026-11-02T10:00:00.000Z"), 5)).toISOString()).toBe(
      "2026-11-09T10:00:00.000Z",
    );
    expect(addBusinessDaysUtc(C, 0)).toBe(C);
  });
});
