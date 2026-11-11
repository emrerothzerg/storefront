/**
 * QA adversarial tests for T39 (fulfilment derivation, mock tracking),
 * src/server/fulfillment/**. Owned by QA (QA-W1-T39). Pure functions, no DB.
 * Uses the real T38 estimateDelivery as the injected estimator unless noted.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FulfillmentStatus, OrderEvent, ShippingMethod } from "@/lib/types";
import { estimateDelivery } from "@/server/pricing/shipping-service";
import {
  CANCEL_WINDOW_MS,
  FULFILLMENT_SEQUENCE,
  deriveStatus,
  estimatedDelivery,
  isCancellable,
  nextEvents,
  statusAt,
  type DeliveryEstimator,
  type FulfillmentDeps,
  type FulfillmentInput,
  type SequencedStatus,
} from "@/server/fulfillment/fulfillment";
import { timeline } from "@/server/fulfillment/timeline";

const H = 3_600_000;
const D = 24 * H;
const MIN = 60_000;
const ms = (iso: string): number => Date.parse(iso);
const iso = (t: number): string => new Date(t).toISOString();

type Method = Pick<ShippingMethod, "id" | "minDays" | "maxDays">;
const STANDARD: Method = { id: "standard", minDays: 5, maxDays: 8 };
const EXPRESS: Method = { id: "express", minDays: 2, maxDays: 3 };
const NEXT_DAY: Method = { id: "next_day", minDays: 1, maxDays: 1 };
const METHODS: readonly (Method | null)[] = [STANDARD, EXPRESS, NEXT_DAY, null];

const realDeps: FulfillmentDeps = { estimateDelivery };

function order(createdAt: string, overrides: Partial<FulfillmentInput> = {}): FulfillmentInput {
  return { createdAt, status: "paid", method: STANDARD, ...overrides };
}

function events(input: FulfillmentInput, statuses: readonly FulfillmentStatus[]): OrderEvent[] {
  return statuses.map((status, i) => ({
    id: i + 1,
    orderId: "o1",
    status,
    at: statusAt(input, status, realDeps) ?? input.createdAt,
    note: null,
  }));
}

function sched(input: FulfillmentInput, deps: FulfillmentDeps = realDeps): Record<SequencedStatus, number> {
  const out = {} as Record<SequencedStatus, number>;
  for (const s of FULFILLMENT_SEQUENCE) {
    const at = statusAt(input, s, deps);
    if (at === null) throw new Error(`no statusAt for ${s}`);
    out[s] = ms(at);
  }
  return out;
}

const idx = (s: FulfillmentStatus): number => (FULFILLMENT_SEQUENCE as readonly string[]).indexOf(s);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Wednesday 2026-11-04 10:00 UTC
const WED = "2026-11-04T10:00:00.000Z";
const W = ms(WED);

describe("purity (contract)", () => {
  test("no Date.now / new Date() / Math.random in implementation files", () => {
    for (const f of ["fulfillment.ts", "timeline.ts"]) {
      const src = readFileSync(join(import.meta.dir, "../../../src/server/fulfillment", f), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/Date\.now\s*\(/);
      expect(code).not.toMatch(/new Date\(\s*\)/);
      expect(code).not.toMatch(/Math\.random/);
      expect(code).not.toMatch(/performance\.now/);
      expect(code).not.toMatch(/from\s+["']@\/server\/pricing/);
    }
  });

  test("estimator is called with createdAt as placedAt and now (never a wall clock)", () => {
    const calls: unknown[][] = [];
    const spy: DeliveryEstimator = (m, p, n) => {
      calls.push([m, p, n]);
      return estimateDelivery(m, p, n);
    };
    deriveStatus(order(WED), W + 30 * D, { estimateDelivery: spy });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c[1]).toBe(W);
      expect(c[2]).toBe(W);
    }
  });

  test("same inputs -> same outputs; inputs are not mutated (frozen)", () => {
    const input = Object.freeze(order(WED, { method: Object.freeze({ ...EXPRESS }) }));
    const persisted = Object.freeze(["processing"] as FulfillmentStatus[]);
    const a = JSON.stringify([
      deriveStatus(input, W + 3 * D, realDeps),
      timeline(input, W + 3 * D, realDeps, []),
      nextEvents(input, W + 3 * D, realDeps, persisted),
    ]);
    const b = JSON.stringify([
      deriveStatus(input, W + 3 * D, realDeps),
      timeline(input, W + 3 * D, realDeps, []),
      nextEvents(input, W + 3 * D, realDeps, persisted),
    ]);
    expect(a).toBe(b);
  });
});

describe("boundaries: exactly on the offset = new status (criterion 1)", () => {
  // Standard, Wed 10:00: packed Wed 12:00, shipped Thu 10:00,
  // T38 start = Wed + 5 bd = Wed 2026-11-11 -> OFD 06:00, delivered 14:00.
  const input = order(WED);
  const cases: [string, number, FulfillmentStatus][] = [
    ["created", W, "processing"],
    ["packed - 1ms", W + 2 * H - 1, "processing"],
    ["packed", W + 2 * H, "packed"],
    ["shipped - 1ms", ms("2026-11-05T10:00:00.000Z") - 1, "packed"],
    ["shipped (+1 bd)", ms("2026-11-05T10:00:00.000Z"), "shipped"],
    ["ofd - 1ms", ms("2026-11-11T06:00:00.000Z") - 1, "shipped"],
    ["ofd 06:00Z on estimate start date", ms("2026-11-11T06:00:00.000Z"), "out_for_delivery"],
    ["delivered - 1ms", ms("2026-11-11T14:00:00.000Z") - 1, "out_for_delivery"],
    ["delivered 14:00Z", ms("2026-11-11T14:00:00.000Z"), "delivered"],
    ["far future", W + 365 * D, "delivered"],
  ];
  for (const [name, now, expected] of cases) {
    test(`standard ${name} -> ${expected}`, () => {
      expect(deriveStatus(input, now, realDeps)).toBe(expected);
    });
  }

  test("next-day: shipped at +6h exactly, OFD 06:00Z next day, delivered 14:00Z", () => {
    const nd = order(WED, { method: NEXT_DAY });
    expect(deriveStatus(nd, W + 6 * H - 1, realDeps)).toBe("packed");
    expect(deriveStatus(nd, W + 6 * H, realDeps)).toBe("shipped");
    expect(deriveStatus(nd, ms("2026-11-05T06:00:00.000Z"), realDeps)).toBe("out_for_delivery");
    expect(deriveStatus(nd, ms("2026-11-05T14:00:00.000Z"), realDeps)).toBe("delivered");
  });

  test("method with maxDays <= 1 but other id is treated as next-day (+6h)", () => {
    const m = order(WED, { method: { id: "rush", minDays: 0, maxDays: 1 } });
    expect(sched(m).shipped).toBe(W + 6 * H);
  });

  test("OFD clamps to shipped when 06:00 on start date is before shipped; delivered >= OFD", () => {
    // Degenerate estimator: start = same date as created. Created 20:00.
    const same: DeliveryEstimator = (_m, p) => {
      const t = typeof p === "number" ? p : ms(p);
      const day = Math.floor(t / D) * D;
      return { start: iso(day), end: iso(day + D) };
    };
    const dep = { estimateDelivery: same };
    const s = sched(order("2026-11-04T20:00:00.000Z", { method: STANDARD }), dep);
    expect(s.out_for_delivery).toBe(s.shipped);
    expect(s.delivered).toBe(s.shipped);
    const inp = order("2026-11-04T20:00:00.000Z");
    expect(deriveStatus(inp, s.shipped, dep)).toBe("delivered"); // equal ts -> later status
    expect(nextEvents(inp, s.shipped, dep, []).map((e) => e.status)).toEqual([...FULFILLMENT_SEQUENCE]);
  });

  test("OFD clamp only (delivered 14:00 still later than shipped)", () => {
    // next-day created 03:00 Thu; estimator start same day: OFD 06:00 < shipped 09:00 < 14:00
    const same: DeliveryEstimator = (_m, p) => {
      const t = typeof p === "number" ? p : ms(p);
      const day = Math.floor(t / D) * D;
      return { start: iso(day), end: iso(day) };
    };
    const s = sched(order("2026-11-05T03:00:00.000Z", { method: NEXT_DAY }), { estimateDelivery: same });
    expect(iso(s.shipped)).toBe("2026-11-05T09:00:00.000Z");
    expect(iso(s.out_for_delivery)).toBe("2026-11-05T09:00:00.000Z");
    expect(iso(s.delivered)).toBe("2026-11-05T14:00:00.000Z");
  });
});

describe("weekend handling and UTC (DST irrelevant)", () => {
  const cases: [string, string, string][] = [
    ["Friday 20:00", "2026-11-06T20:00:00.000Z", "2026-11-09T20:00:00.000Z"],
    ["Friday 00:00", "2026-11-06T00:00:00.000Z", "2026-11-09T00:00:00.000Z"],
    ["Saturday 10:00", "2026-11-07T10:00:00.000Z", "2026-11-09T10:00:00.000Z"],
    ["Saturday 23:59:59.999", "2026-11-07T23:59:59.999Z", "2026-11-09T23:59:59.999Z"],
    ["Sunday 00:00", "2026-11-08T00:00:00.000Z", "2026-11-09T00:00:00.000Z"],
    ["Sunday 23:00", "2026-11-08T23:00:00.000Z", "2026-11-09T23:00:00.000Z"],
    ["Thursday 20:00 (control: Friday)", "2026-11-05T20:00:00.000Z", "2026-11-06T20:00:00.000Z"],
  ];
  for (const m of [STANDARD, EXPRESS, null]) {
    for (const [name, created, shipped] of cases) {
      test(`${m?.id ?? "null method"}: ${name} ships ${shipped}`, () => {
        const s = sched(order(created, { method: m }));
        expect(iso(s.shipped)).toBe(shipped);
        expect(new Date(s.shipped).getUTCDay()).not.toBe(0);
        expect(new Date(s.shipped).getUTCDay()).not.toBe(6);
      });
    }
  }

  test("delivered never lands on a weekend with the real estimator", () => {
    for (let d = 0; d < 14; d++) {
      for (const m of METHODS) {
        const s = sched(order(iso(ms("2026-11-02T00:00:00.000Z") + d * D + 17 * H), { method: m }));
        const wd = new Date(s.delivered).getUTCDay();
        expect(wd === 0 || wd === 6).toBe(false);
      }
    }
  });

  test("offsets are exact UTC milliseconds across US (2026-11-01) and EU (2026-10-25) DST changes", () => {
    // Fri 30 Oct 20:00Z -> Mon 2 Nov 20:00Z exactly 3*24h later; Sat 24 Oct -> Mon 26 Oct.
    expect(sched(order("2026-10-30T20:00:00.000Z")).shipped - ms("2026-10-30T20:00:00.000Z")).toBe(3 * D);
    expect(iso(sched(order("2026-10-24T12:00:00.000Z")).shipped)).toBe("2026-10-26T12:00:00.000Z");
    const s = sched(order("2026-10-31T01:30:00.000Z", { method: NEXT_DAY }));
    expect(s.packed - ms("2026-10-31T01:30:00.000Z")).toBe(2 * H);
    expect(new Date(s.delivered).getUTCHours()).toBe(14);
    expect(new Date(s.out_for_delivery).getUTCHours()).toBe(6);
  });

  test("result is independent of process TZ", () => {
    const prev = process.env.TZ;
    const run = (): string =>
      JSON.stringify(
        ["2026-10-30T20:00:00.000Z", "2026-03-28T23:30:00.000Z", "2026-11-01T05:30:00.000Z"].map((c) =>
          METHODS.map((m) => sched(order(c, { method: m }))),
        ),
      );
    try {
      process.env.TZ = "UTC";
      const utc = run();
      process.env.TZ = "America/New_York";
      const ny = run();
      process.env.TZ = "Europe/Berlin";
      const be = run();
      process.env.TZ = "Pacific/Chatham";
      const ch = run();
      expect(ny).toBe(utc);
      expect(be).toBe(utc);
      expect(ch).toBe(utc);
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });
});

describe("clock skew (criterion 2) and no regression", () => {
  test("now far before createdAt -> processing, never negative; no events", () => {
    const input = order(WED);
    for (const delta of [1, MIN, H, 30 * D, 10_000 * D]) {
      expect(deriveStatus(input, W - delta, realDeps)).toBe("processing");
      expect(nextEvents(input, W - delta, realDeps, [])).toEqual([]);
      const tl = timeline(input, W - delta, realDeps, []);
      expect(tl[0]?.state).toBe("current");
      expect(tl.slice(1).every((s) => s.state === "upcoming" && s.at === null)).toBe(true);
    }
  });

  test("persisted status never regresses, even under skew", () => {
    for (const p of FULFILLMENT_SEQUENCE) {
      const input = order(WED, { fulfillmentStatus: p });
      expect(deriveStatus(input, W - D, realDeps)).toBe(p);
      expect(deriveStatus(input, W + 1, realDeps)).toBe(p);
      expect(deriveStatus(input, W + 1)).toBe(p); // without deps too
      const tl = timeline(input, W - D, realDeps, events(input, FULFILLMENT_SEQUENCE.slice(0, idx(p) + 1)));
      const last = [...tl].reverse().find((s) => s.state === "current" || s.state === "complete");
      expect(last?.status).toBe(p);
    }
  });

  test("status is monotonic in now", () => {
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const c = ms("2026-01-01T00:00:00.000Z") + Math.floor(r() * 365 * D);
      const input = order(iso(c), { method: METHODS[Math.floor(r() * 4)] ?? null });
      let prev = -1;
      for (let t = c - D; t < c + 20 * D; t += Math.floor(r() * 12 * H) + 1) {
        const k = idx(deriveStatus(input, t, realDeps));
        expect(k).toBeGreaterThanOrEqual(prev);
        prev = k;
      }
    }
  });
});

describe("terminal states (criterion 3)", () => {
  test("cancelled (persisted, cancelledAt, or both) stays cancelled at any time incl. skew", () => {
    const variants: Partial<FulfillmentInput>[] = [
      { fulfillmentStatus: "cancelled" },
      { cancelledAt: iso(W + 10 * MIN) },
      { fulfillmentStatus: "cancelled", cancelledAt: iso(W + 10 * MIN) },
      { fulfillmentStatus: "shipped", cancelledAt: iso(W + 26 * H) }, // cancelledAt wins
    ];
    for (const v of variants) {
      for (const now of [W - D, W, W + 3 * H, W + 30 * D, W + 3650 * D]) {
        expect(deriveStatus(order(WED, v), now, realDeps)).toBe("cancelled");
        expect(isCancellable(order(WED, v), now)).toBe(false);
        expect(estimatedDelivery(order(WED, v), realDeps)).toBeNull();
      }
    }
  });

  test("cancelled timeline: completed steps then a cancelled step", () => {
    const cancelAt = W + 3 * H; // after packed, before shipped
    const input = order(WED, { cancelledAt: iso(cancelAt) });
    const tl = timeline(input, W + 30 * D, realDeps, []);
    expect(tl.map((s) => [s.status, s.state, s.at])).toEqual([
      ["processing", "complete", WED],
      ["packed", "complete", iso(W + 2 * H)],
      ["cancelled", "cancelled", iso(cancelAt)],
    ]);
    expect(tl.at(-1)?.label).toBe("Cancelled");
  });

  test("cancelled within window: placed + cancelled only", () => {
    const input = order(WED, { cancelledAt: iso(W + 5 * MIN), fulfillmentStatus: "cancelled" });
    expect(timeline(input, W + 30 * D, realDeps, []).map((s) => s.status)).toEqual(["processing", "cancelled"]);
    expect(nextEvents(input, W + 30 * D, realDeps, ["processing"])).toEqual([
      { status: "cancelled", at: iso(W + 5 * MIN) },
    ]);
  });

  test("payment_failed: empty timeline, no events, no estimate, not cancellable, at any time", () => {
    for (const extra of [{}, { cancelledAt: iso(W + MIN) }, { fulfillmentStatus: "delivered" as const }]) {
      const input = order(WED, { status: "payment_failed", ...extra });
      for (const now of [W - D, W, W + 5 * MIN, W + 30 * D]) {
        expect(timeline(input, now, realDeps, [])).toEqual([]);
        expect(nextEvents(input, now, realDeps, [])).toEqual([]);
        expect(estimatedDelivery(input, realDeps)).toBeNull();
        expect(isCancellable(input, now)).toBe(false);
      }
    }
  });

  test("payment_failed never calls the estimator", () => {
    let called = 0;
    const spy: DeliveryEstimator = (m, p, n) => {
      called++;
      return estimateDelivery(m, p, n);
    };
    const input = order(WED, { status: "payment_failed" });
    deriveStatus(input, W + 30 * D, { estimateDelivery: spy });
    timeline(input, W + 30 * D, { estimateDelivery: spy }, []);
    nextEvents(input, W + 30 * D, { estimateDelivery: spy }, []);
    estimatedDelivery(input, { estimateDelivery: spy });
    expect(called).toBe(0);
  });
});

describe("isCancellable matrix (criterion 4)", () => {
  test("true at created, at +30min exactly (inclusive), false at +30min+1ms", () => {
    const input = order(WED);
    expect(isCancellable(input, W)).toBe(true);
    expect(isCancellable(input, W + CANCEL_WINDOW_MS)).toBe(true);
    expect(isCancellable(input, W + 30 * MIN)).toBe(true);
    expect(isCancellable(input, W + 30 * MIN + 1)).toBe(false);
  });

  test("persisted processing within window -> true; any later persisted status -> false", () => {
    expect(isCancellable(order(WED, { fulfillmentStatus: "processing" }), W + MIN)).toBe(true);
    for (const s of ["packed", "shipped", "out_for_delivery", "delivered", "cancelled"] as const) {
      expect(isCancellable(order(WED, { fulfillmentStatus: s }), W + MIN)).toBe(false);
    }
  });

  test("false for shipped/delivered derived states and for every method", () => {
    for (const m of METHODS) {
      const input = order(WED, { method: m });
      const s = sched(input);
      expect(isCancellable(input, s.packed)).toBe(false);
      expect(isCancellable(input, s.shipped)).toBe(false);
      expect(isCancellable(input, s.delivered)).toBe(false);
    }
  });

  test("never true unless deriveStatus is processing (random sweep)", () => {
    const r = rng(11);
    for (let i = 0; i < 500; i++) {
      const c = ms("2026-01-01T00:00:00.000Z") + Math.floor(r() * 365 * D);
      const input = order(iso(c), { method: METHODS[Math.floor(r() * 4)] ?? null });
      const now = c + Math.floor((r() - 0.1) * 3 * H);
      if (isCancellable(input, now)) {
        expect(deriveStatus(input, now, realDeps)).toBe("processing");
        expect(now - c).toBeLessThanOrEqual(CANCEL_WINDOW_MS);
      }
    }
  });
});

describe("nextEvents (criterion 5)", () => {
  test("only non-persisted, chronological, offset timestamps, never now", () => {
    const input = order(WED);
    const now = ms("2026-11-11T13:59:59.999Z"); // between OFD and delivered
    const ev = nextEvents(input, now, realDeps, ["processing", "shipped"]);
    expect(ev).toEqual([
      { status: "packed", at: iso(W + 2 * H) },
      { status: "out_for_delivery", at: "2026-11-11T06:00:00.000Z" },
    ]);
    expect(ev.some((e) => e.at === iso(now))).toBe(false);
  });

  test("duplicate / unrelated persisted entries are tolerated", () => {
    const input = order(WED);
    const ev = nextEvents(input, W + 30 * D, realDeps, ["processing", "processing", "cancelled"]);
    expect(ev.map((e) => e.status)).toEqual(["packed", "shipped", "out_for_delivery", "delivered"]);
  });

  test("persisting the returned events then calling again yields nothing (idempotent)", () => {
    const input = order(WED, { method: EXPRESS });
    const persisted: FulfillmentStatus[] = [];
    for (let t = W; t < W + 10 * D; t += 37 * MIN) {
      const ev = nextEvents(input, t, realDeps, persisted);
      for (const e of ev) {
        expect(persisted).not.toContain(e.status);
        expect(ms(e.at)).toBeLessThanOrEqual(t);
        persisted.push(e.status);
      }
      expect(nextEvents(input, t, realDeps, persisted)).toEqual([]);
    }
    expect(persisted).toEqual([...FULFILLMENT_SEQUENCE]);
  });

  test("cancelled order: steps before cancellation, then cancelled at cancelledAt, chronological", () => {
    const cancelAt = ms("2026-11-06T09:00:00.000Z"); // after shipped (Thu 10:00), before OFD
    const input = order(WED, { cancelledAt: iso(cancelAt) });
    expect(nextEvents(input, W + 30 * D, realDeps, []).map((e) => [e.status, e.at])).toEqual([
      ["processing", WED],
      ["packed", iso(W + 2 * H)],
      ["shipped", "2026-11-05T10:00:00.000Z"],
      ["cancelled", iso(cancelAt)],
    ]);
  });
});

describe("estimated delivery (criterion 6)", () => {
  test("estimatedDelivery is exactly T38 estimateDelivery(method, createdAt, createdAt)", () => {
    for (const m of [STANDARD, EXPRESS, NEXT_DAY]) {
      expect(estimatedDelivery(order(WED, { method: m }), realDeps)).toEqual(estimateDelivery(m, W, W));
    }
    expect(estimatedDelivery(order(WED, { method: null }), realDeps)).toEqual(estimateDelivery(STANDARD, W, W));
  });
});

describe("programming errors -> TypeError", () => {
  const bad = ["", "not a date", "2026-13-45T00:00:00Z"];
  test("invalid createdAt throws TypeError from every entry point", () => {
    for (const b of bad) {
      const input = order(b);
      expect(() => deriveStatus(input, W)).toThrow(TypeError);
      expect(() => timeline(input, W, realDeps, [])).toThrow(TypeError);
      expect(() => nextEvents(input, W, realDeps, [])).toThrow(TypeError);
      expect(() => isCancellable(input, W)).toThrow(TypeError);
      expect(() => statusAt(input, "packed", realDeps)).toThrow(TypeError);
      expect(() => estimatedDelivery(input, realDeps)).toThrow(TypeError);
    }
  });

  test("non-string createdAt (runtime type violation) throws TypeError", () => {
    const input = { ...order(WED), createdAt: 12345 as unknown as string };
    expect(() => deriveStatus(input, W)).toThrow(TypeError);
  });

  test("non-finite / non-number nowMs throws TypeError", () => {
    for (const n of [Number.NaN, Infinity, -Infinity, "1" as unknown as number]) {
      expect(() => deriveStatus(order(WED), n, realDeps)).toThrow(TypeError);
      expect(() => timeline(order(WED), n, realDeps, [])).toThrow(TypeError);
      expect(() => nextEvents(order(WED), n, realDeps, [])).toThrow(TypeError);
      expect(() => isCancellable(order(WED), n)).toThrow(TypeError);
    }
  });

  test("invalid cancelledAt throws TypeError from deriveStatus/timeline/nextEvents/statusAt", () => {
    const input = order(WED, { cancelledAt: "garbage" });
    expect(() => deriveStatus(input, W, realDeps)).toThrow(TypeError);
    expect(() => timeline(input, W, realDeps, [])).toThrow(TypeError);
    expect(() => nextEvents(input, W, realDeps, [])).toThrow(TypeError);
    expect(() => statusAt(input, "packed", realDeps)).toThrow(TypeError);
  });

  test("invalid cancelledAt throws TypeError from isCancellable and estimatedDelivery", () => {
    const input = order(WED, { cancelledAt: "garbage" });
    expect(() => isCancellable(input, W)).toThrow(TypeError);
    expect(() => estimatedDelivery(input, realDeps)).toThrow(TypeError);
  });

  test("estimator output with unparsable start or end throws TypeError", () => {
    const outs = [
      { start: "nope", end: "2026-11-11T00:00:00.000Z" },
      { start: "2026-11-11T00:00:00.000Z", end: "nope" },
      { start: 5 as unknown as string, end: "2026-11-11T00:00:00.000Z" },
    ];
    for (const o of outs) {
      const dep = { estimateDelivery: (() => o) as DeliveryEstimator };
      expect(() => deriveStatus(order(WED), W + 30 * D, dep)).toThrow(TypeError);
      expect(() => timeline(order(WED), W + 30 * D, dep, [])).toThrow(TypeError);
      expect(() => nextEvents(order(WED), W + 30 * D, dep, [])).toThrow(TypeError);
      expect(() => estimatedDelivery(order(WED), dep)).toThrow(TypeError);
    }
  });
});

describe("property: deriveStatus / timeline / nextEvents agree (500 random triples)", () => {
  const r = rng(20261107);
  const base = ms("2026-01-01T00:00:00.000Z");
  const triples: { c: number; now: number; m: Method | null; k: number }[] = [];
  for (let i = 0; i < 500; i++) {
    const c = base + Math.floor(r() * 730 * D);
    const m = METHODS[Math.floor(r() * METHODS.length)] ?? null;
    let now: number;
    const mode = r();
    if (mode < 0.1) now = c - Math.floor(r() * 5 * D) - 1; // skew
    else if (mode < 0.4) {
      // exact boundary or 1ms before
      const s = sched(order(iso(c), { method: m }));
      const st = FULFILLMENT_SEQUENCE[Math.floor(r() * 5)] ?? "processing";
      now = s[st] - (r() < 0.5 ? 0 : 1);
    } else now = c + Math.floor(r() * 20 * D);
    triples.push({ c, now, m, k: r() });
  }

  test("500 triples", () => {
    let checked = 0;
    for (const { c, now, m, k } of triples) {
      const input0 = order(iso(c), { method: m });
      const derived0 = deriveStatus(input0, now, realDeps);
      // persisted = random prefix of what time has reached (T55 persists lazily)
      const reachedByTime = now < c ? 0 : idx(derived0) + 1;
      const p = Math.floor(k * (reachedByTime + 1));
      const persistedStatuses = FULFILLMENT_SEQUENCE.slice(0, p) as FulfillmentStatus[];
      const input: FulfillmentInput =
        p === 0 ? input0 : { ...input0, fulfillmentStatus: persistedStatuses[p - 1] };

      const status = deriveStatus(input, now, realDeps);
      expect(status).toBe(derived0);
      expect(deriveStatus(input, now, realDeps)).toBe(status); // deterministic

      const tl = timeline(input, now, realDeps, events(input, persistedStatuses));
      expect(tl.map((s) => s.status)).toEqual([...FULFILLMENT_SEQUENCE]);
      const last = [...tl].reverse().find((s) => s.state === "complete" || s.state === "current");
      expect(last?.status).toBe(status);
      for (const step of tl) {
        if (step.state === "upcoming") expect(step.at).toBeNull();
        else expect(step.at).toBe(statusAt(input, step.status, realDeps));
      }

      const ev = nextEvents(input, now, realDeps, persistedStatuses);
      for (let i = 1; i < ev.length; i++) expect(ms(ev[i]!.at)).toBeGreaterThanOrEqual(ms(ev[i - 1]!.at));
      for (const e of ev) {
        expect(persistedStatuses).not.toContain(e.status);
        const expectedAt = statusAt(input, e.status, realDeps);
        expect(expectedAt).not.toBeNull();
        expect(e.at).toBe(expectedAt ?? "");
        expect(ms(e.at)).toBeLessThanOrEqual(now);
      }
      if (now >= c) {
        const union = new Set<FulfillmentStatus>([...persistedStatuses, ...ev.map((e) => e.status)]);
        const reached = new Set<FulfillmentStatus>(FULFILLMENT_SEQUENCE.slice(0, idx(status) + 1));
        expect([...union].sort()).toEqual([...reached].sort());
      } else {
        expect(ev).toEqual([]);
      }

      // criterion 6: delivered date == estimate start date; OFD 06:00 on it (real estimator, no clamp)
      const est = estimatedDelivery(input, realDeps);
      const s = sched(input);
      expect(iso(s.delivered).slice(0, 10)).toBe(est!.start.slice(0, 10));
      expect(iso(s.delivered).slice(11)).toBe("14:00:00.000Z");
      expect(iso(s.out_for_delivery)).toBe(`${est!.start.slice(0, 10)}T06:00:00.000Z`);
      expect(s.packed).toBe(c + 2 * H);
      expect(s.processing).toBeLessThanOrEqual(s.packed);
      expect(s.packed).toBeLessThanOrEqual(s.shipped);
      expect(s.shipped).toBeLessThanOrEqual(s.out_for_delivery);
      expect(s.out_for_delivery).toBeLessThanOrEqual(s.delivered);
      checked++;
    }
    expect(checked).toBe(500);
  });
});

describe("observations (spec ambiguity, documented behaviour)", () => {
  test("O1 ruling: next-day order placed Saturday ships next Monday (same time) +6h", () => {
    const s = sched(order("2026-11-07T10:00:00.000Z", { method: NEXT_DAY }));
    expect(iso(s.shipped)).toBe("2026-11-09T16:00:00.000Z");
  });
  test("O1 ruling: next-day weekend orders ship Monday (order time) + 6h; weekday rule unchanged", () => {
    const cases: [string, string][] = [
      ["2026-11-07T00:00:00.000Z", "2026-11-09T06:00:00.000Z"], // Sat 00:00
      ["2026-11-07T23:59:59.999Z", "2026-11-10T05:59:59.999Z"], // Sat late -> Mon 23:59:59.999 + 6h
      ["2026-11-08T23:00:00.000Z", "2026-11-10T05:00:00.000Z"], // Sun 23:00
      ["2026-11-06T20:00:00.000Z", "2026-11-07T02:00:00.000Z"], // Fri 20:00 weekday rule (documented)
      ["2026-11-06T17:59:59.999Z", "2026-11-06T23:59:59.999Z"], // Fri same-day
    ];
    for (const [created, shipped] of cases) {
      const input = order(created, { method: NEXT_DAY });
      const s = sched(input);
      expect(iso(s.shipped)).toBe(shipped);
      expect(s.out_for_delivery).toBeGreaterThanOrEqual(s.shipped);
      expect(iso(s.delivered).slice(0, 10)).toBe(estimatedDelivery(input, realDeps)!.start.slice(0, 10));
      expect(deriveStatus(input, s.shipped - 1, realDeps)).toBe("packed");
      expect(deriveStatus(input, s.shipped, realDeps)).toBe("shipped");
    }
  });
});
