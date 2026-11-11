/**
 * QA adversarial tests for T31 (rate limiter + text guard), src/server/security/**.
 * Owned by QA (QA-W1-T31). In-memory DB only; never touches ./data/.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import {
  RATE_LIMIT_RULES,
  createRateLimiter,
  limitAction,
  type RateLimitedAction,
  type RateLimiter,
} from "@/server/security/rate-limiter";
import { cleanText, countUrls, normalizeCouponCode } from "@/server/security/text-guard";

const UUID_A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const UUID_B = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";

interface Harness {
  readonly db: Database;
  readonly limiter: RateLimiter;
  readonly logs: string[];
  setNow(ms: number): void;
  advance(ms: number): void;
}

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
});

function harness(startMs = 1_800_000_000_000): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  open.push(db);
  let now = startMs;
  const logs: string[] = [];
  const limiter = createRateLimiter(db, {
    now: () => now,
    logger: { error: (...args: unknown[]) => void logs.push(args.map(String).join(" ")) },
  });
  return {
    db,
    limiter,
    logs,
    setNow: (ms) => {
      now = ms;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

function rowCount(db: Database, where = "1=1", params: string[] = []): number {
  return db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM rate_limits WHERE ${where}`).get(...params)?.n ?? -1;
}

function retryAfter(result: ReturnType<RateLimiter["check"]>): number {
  if (result.ok) throw new Error("expected RATE_LIMITED");
  expect(result.error.code).toBe("RATE_LIMITED");
  const value = (result.error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  if (typeof value !== "number") throw new Error("retryAfterSeconds missing");
  return value;
}

// ---------------------------------------------------------------------------
// Criterion 1: N within window, N+1 limited, recovers after window
// ---------------------------------------------------------------------------
describe("QA T31-1 window admission", () => {
  for (const [limit, windowSeconds] of [
    [1, 1],
    [1, 60],
    [5, 3600],
    [10, 86_400],
  ] as const) {
    test(`limit ${limit} / ${windowSeconds}s at every offset inside the window`, () => {
      for (const offsetFraction of [0, 0.37, 0.999]) {
        const h = harness();
        const windowStartMs = Math.floor(1_800_000_000 / windowSeconds) * windowSeconds * 1000;
        h.setNow(windowStartMs + Math.floor(offsetFraction * windowSeconds * 1000));
        for (let i = 0; i < limit; i++) expect(h.limiter.check("k", { limit, windowSeconds }).ok).toBe(true);
        const ra = retryAfter(h.limiter.check("k", { limit, windowSeconds }));
        expect(Number.isInteger(ra)).toBe(true);
        expect(ra).toBeGreaterThanOrEqual(1);
        expect(ra).toBeLessThanOrEqual(windowSeconds);
        h.advance(ra * 1000);
        expect(h.limiter.check("k", { limit, windowSeconds }).ok).toBe(true);
      }
    });
  }

  test("retryAfter at the last millisecond of a window is 1", () => {
    const h = harness(3600 * 1000 * 500_000 + 3600 * 1000 - 1);
    h.limiter.check("k", { limit: 1, windowSeconds: 3600 });
    expect(retryAfter(h.limiter.check("k", { limit: 1, windowSeconds: 3600 }))).toBe(1);
  });

  test("negative and zero clock values still limit correctly", () => {
    for (const start of [0, -1, -1_000, -86_400_000 - 1]) {
      const h = harness(start);
      expect(h.limiter.check("k", { limit: 2, windowSeconds: 60 }).ok).toBe(true);
      expect(h.limiter.check("k", { limit: 2, windowSeconds: 60 }).ok).toBe(true);
      const ra = retryAfter(h.limiter.check("k", { limit: 2, windowSeconds: 60 }));
      expect(ra).toBeGreaterThanOrEqual(1);
      expect(ra).toBeLessThanOrEqual(60);
    }
  });

  test("NaN / Infinity clock never admits unlimited calls (fail closed, not open)", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const h = harness(bad);
      let admitted = 0;
      let lastRetry: unknown = undefined;
      for (let i = 0; i < 5; i++) {
        const r = h.limiter.check("k", { limit: 1, windowSeconds: 60 });
        if (r.ok) admitted++;
        else lastRetry = (r.error.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      }
      expect(admitted).toBeLessThanOrEqual(1);
      expect(typeof lastRetry).toBe("number");
      expect(Number.isFinite(lastRetry as number)).toBe(true);
      expect(lastRetry as number).toBeGreaterThanOrEqual(1);
      expect(lastRetry as number).toBeLessThanOrEqual(60);
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: key isolation and concurrency
// ---------------------------------------------------------------------------
describe("QA T31-2 isolation and concurrency", () => {
  test("adversarial keys do not interfere (':' '*' prefixes, 10k chars, empty, unicode)", () => {
    const h = harness();
    const rule = { limit: 1, windowSeconds: 3600 };
    const keys = [
      "a",
      "a:",
      "a:*",
      "*",
      ":",
      "",
      "3600:a",
      "a:b:c",
      "x".repeat(10_000),
      "x".repeat(9_999),
      "\u00E9",
      "e\u0301",
      "a\u0000b",
      "a\u0000c",
    ];
    for (const k of keys) expect(h.limiter.check(k, rule).ok).toBe(true);
    for (const k of keys) expect(h.limiter.check(k, rule).ok).toBe(false);
  });

  test("same key with different window sizes are separate counters", () => {
    const h = harness();
    expect(h.limiter.check("k", { limit: 1, windowSeconds: 60 }).ok).toBe(true);
    expect(h.limiter.check("k", { limit: 1, windowSeconds: 3600 }).ok).toBe(true);
    expect(h.limiter.check("k", { limit: 1, windowSeconds: 600 }).ok).toBe(true);
    expect(h.limiter.check("k", { limit: 1, windowSeconds: 6000 }).ok).toBe(true);
  });

  test("Promise.all of 50 on limit 10 admits exactly 10, repeated 20x", async () => {
    for (let iter = 0; iter < 20; iter++) {
      const h = harness();
      const results = await Promise.all(
        Array.from({ length: 50 }, async () => h.limiter.check(`k${iter}`, { limit: 10, windowSeconds: 60 })),
      );
      expect(results.filter((r) => r.ok).length).toBe(10);
    }
  });

  test("Promise.all on the global key via limitAction with 400 distinct sessions admits exactly 300", async () => {
    const h = harness();
    const sessions = Array.from({ length: 400 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`);
    const results = await Promise.all(sessions.map(async (s) => limitAction(h.limiter, "review.submit", s)));
    expect(results.filter((r) => r.ok).length).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: global backstop
// ---------------------------------------------------------------------------
describe("QA T31-3 global backstop", () => {
  test("review.submit: 100 sessions x 3 fills 300; the 301st (fresh session) is limited", () => {
    const h = harness();
    for (let s = 0; s < 100; s++) {
      const sid = `00000000-0000-4000-8000-${s.toString(16).padStart(12, "0")}`;
      for (let i = 0; i < 3; i++) expect(limitAction(h.limiter, "review.submit", sid).ok).toBe(true);
    }
    const r = limitAction(h.limiter, "review.submit", UUID_A);
    const ra = retryAfter(r);
    expect(ra).toBeLessThanOrEqual(3600);
    // also anon is limited
    expect(limitAction(h.limiter, "review.submit", null).ok).toBe(false);
  });

  test("actions without a global (address.write, list.mutate) never write a '*' key", () => {
    const h = harness();
    limitAction(h.limiter, "address.write", UUID_A);
    limitAction(h.limiter, "list.mutate", UUID_A);
    expect(rowCount(h.db, "key LIKE ?", ["%:*"])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: purge / bound
// ---------------------------------------------------------------------------
describe("QA T31-4 purge and table bound", () => {
  test("10,000 calls across 200 windows with 3 rotating keys: table stays <= 2 windows x keys", () => {
    const h = harness(0);
    let max = 0;
    for (let i = 0; i < 10_000; i++) {
      h.setNow(Math.floor(i / 50) * 60_000 + (i % 50) * 10); // 50 calls per 60 s window
      h.limiter.check(`k${i % 3}`, { limit: 1000, windowSeconds: 60 });
      max = Math.max(max, rowCount(h.db));
    }
    expect(max).toBeLessThanOrEqual(6);
    // nothing older than the previous window survives
    const minStart = h.db.query<{ m: number }, []>("SELECT MIN(window_start) AS m FROM rate_limits").get()?.m ?? 0;
    expect(minStart).toBeGreaterThanOrEqual(199 * 60 - 60);
  });

  test("10,000 calls, every call a unique key in a new 1s window: bound holds", () => {
    const h = harness(0);
    let max = 0;
    for (let i = 0; i < 10_000; i++) {
      h.setNow(i * 1000);
      h.limiter.check(`u:${i}`, { limit: 1, windowSeconds: 1 });
      if (i % 97 === 0) max = Math.max(max, rowCount(h.db));
    }
    max = Math.max(max, rowCount(h.db));
    expect(max).toBeLessThanOrEqual(2);
  });

  test("contact.submit: hourly purges never delete the live daily counter", () => {
    const day0 = 20_000 * 86_400 * 1000; // a day boundary
    const h = harness(day0);
    const sid = UUID_A;
    // 3 per hour over 3 hours = 9 daily; hour rollovers trigger hourly purges
    for (let hour = 0; hour < 3; hour++) {
      h.setNow(day0 + hour * 3_600_000 + 1000);
      for (let i = 0; i < 3; i++) expect(limitAction(h.limiter, "contact.submit", sid).ok).toBe(true);
      // force extra hourly purges with other keys in fresh windows
      for (let j = 0; j < 150; j++) h.limiter.check(`noise${j}`, { limit: 1, windowSeconds: 3600 });
    }
    const daily = h.db
      .query<{ count: number }, [string]>("SELECT count FROM rate_limits WHERE key = ?")
      .get(`86400:contact.submit:${sid}`);
    expect(daily?.count).toBe(9);
    h.setNow(day0 + 3 * 3_600_000 + 1000);
    expect(limitAction(h.limiter, "contact.submit", sid).ok).toBe(true); // 10th of the day
    h.setNow(day0 + 4 * 3_600_000 + 1000);
    const r = limitAction(h.limiter, "contact.submit", sid); // 11th of the day, hour has room
    expect(retryAfter(r)).toBeGreaterThan(3600); // retry is the daily window remainder
    // next day resets
    h.setNow(day0 + 86_400_000 + 1000);
    expect(limitAction(h.limiter, "contact.submit", sid).ok).toBe(true);
  });

  test("purge for windowSeconds 3600 does not delete keys of window 36000 or 360", () => {
    const h = harness(0);
    h.limiter.check("a", { limit: 9, windowSeconds: 36_000 });
    h.limiter.check("a", { limit: 9, windowSeconds: 360 });
    h.setNow(10 * 3_600_000);
    h.limiter.check("b", { limit: 9, windowSeconds: 3600 }); // first hit -> purge 3600 prefix
    expect(rowCount(h.db, "key = ?", ["36000:a"])).toBe(1);
    expect(rowCount(h.db, "key = ?", ["360:a"])).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Criterion 7: fail closed, no PII in logs
// ---------------------------------------------------------------------------
describe("QA T31-7 fail closed", () => {
  test("dropped table: every action is RATE_LIMITED and logs never contain the UUID", () => {
    const actions = Object.keys(RATE_LIMIT_RULES) as RateLimitedAction[];
    const h = harness();
    h.db.run("DROP TABLE rate_limits");
    for (const a of actions) {
      const r = limitAction(h.limiter, a, UUID_A);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("RATE_LIMITED");
      const ra = retryAfter(r);
      expect(ra).toBeGreaterThanOrEqual(1);
    }
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) {
      expect(line).not.toContain(UUID_A);
      expect(line).not.toContain(UUID_A.slice(0, 8));
    }
  });

  test("closed DB: RATE_LIMITED, log has no UUID", () => {
    const h = harness();
    h.db.close();
    const r = limitAction(h.limiter, "contact.submit", UUID_B);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RATE_LIMITED");
    expect(h.logs.join("\n")).not.toContain(UUID_B);
  });

  test("a throwing logger does not change the answer", () => {
    const db = createDatabase(":memory:");
    open.push(db);
    runMigrations(db);
    const limiter = createRateLimiter(db, {
      now: () => 0,
      logger: {
        error: () => {
          throw new Error("logger down");
        },
      },
    });
    db.run("DROP TABLE rate_limits");
    expect(limiter.check("k", { limit: 5, windowSeconds: 60 }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Criterion 8: limitAction contract and rules table
// ---------------------------------------------------------------------------
describe("QA T31-8 limitAction contract", () => {
  test("RATE_LIMIT_RULES matches the backlog section 0 table + accounts rows (16)", () => {
    const H = 3600;
    expect(RATE_LIMIT_RULES).toEqual({
      "review.submit": { perSession: { limit: 5, windowSeconds: H }, global: { limit: 300, windowSeconds: H } },
      vote: { perSession: { limit: 60, windowSeconds: H }, global: { limit: 3000, windowSeconds: H } },
      "question.ask": { perSession: { limit: 5, windowSeconds: H }, global: { limit: 300, windowSeconds: H } },
      "answer.post": { perSession: { limit: 10, windowSeconds: H }, global: { limit: 300, windowSeconds: H } },
      "contact.submit": {
        perSession: [
          { limit: 3, windowSeconds: H },
          { limit: 10, windowSeconds: 86_400 },
        ],
        global: { limit: 200, windowSeconds: H },
      },
      "stock_alert.subscribe": { perSession: { limit: 10, windowSeconds: H }, global: { limit: 500, windowSeconds: H } },
      "coupon.apply": { perSession: { limit: 10, windowSeconds: 600 }, global: { limit: 1000, windowSeconds: 600 } },
      "address.write": { perSession: { limit: 20, windowSeconds: 86_400 }, global: null },
      "list.mutate": { perSession: { limit: 120, windowSeconds: H }, global: null },
      "search.suggest": { perSession: { limit: 120, windowSeconds: 60 }, global: { limit: 3000, windowSeconds: 60 } },
      "auth.signin.session": { perSession: { limit: 10, windowSeconds: 900 }, global: { limit: 1000, windowSeconds: 900 } },
      "auth.signin.email": { perSession: { limit: 10, windowSeconds: 900 }, global: null },
      "auth.signup": { perSession: { limit: 5, windowSeconds: H }, global: { limit: 100, windowSeconds: H } },
      "account.changePassword": { perSession: { limit: 5, windowSeconds: 900 }, global: null },
      "account.delete": { perSession: { limit: 5, windowSeconds: H }, global: null },
      "account.updateProfile": { perSession: { limit: 20, windowSeconds: H }, global: null },
    });
    expect(Object.keys(RATE_LIMIT_RULES).length).toBe(16);
    expect(Object.isFrozen(RATE_LIMIT_RULES)).toBe(true);
  });

  test("stored keys are `${window}:${action}:${session|anon}` and `${window}:${action}:*`", () => {
    const h = harness();
    limitAction(h.limiter, "coupon.apply", UUID_A);
    limitAction(h.limiter, "coupon.apply", null);
    const keys = h.db
      .query<{ key: string }, []>("SELECT key FROM rate_limits ORDER BY key")
      .all()
      .map((r) => r.key);
    expect(keys.sort()).toEqual(
      [`600:coupon.apply:${UUID_A}`, "600:coupon.apply:anon", "600:coupon.apply:*"].sort(),
    );
  });

  test("non-UUID session ids (incl. '*', 'anon', uppercase UUID, 10k chars, ':' injection) bucket as anon", () => {
    const h = harness();
    const hostile = ["*", "anon", UUID_A.toUpperCase(), "x".repeat(10_000), `${UUID_A}:*`, ":*", "", " "];
    for (const s of hostile) limitAction(h.limiter, "review.submit", s);
    const anon = h.db
      .query<{ count: number }, [string]>("SELECT count FROM rate_limits WHERE key = ?")
      .get("3600:review.submit:anon");
    // over-limit calls still bump the session counter (documented), but never reach the global key
    expect(anon?.count).toBe(8);
    expect(rowCount(h.db, "key NOT IN (?, ?)", ["3600:review.submit:anon", "3600:review.submit:*"])).toBe(0);
    // 6th..8th were refused at the anon session rule and never reached the global
    const global = h.db
      .query<{ count: number }, [string]>("SELECT count FROM rate_limits WHERE key = ?")
      .get("3600:review.submit:*");
    expect(global?.count).toBe(5);
  });

  test("a crafted '*' session cannot exhaust the global key for others faster than anon", () => {
    const h = harness();
    for (let i = 0; i < 50; i++) limitAction(h.limiter, "vote", "*");
    expect(limitAction(h.limiter, "vote", UUID_A).ok).toBe(true);
  });

  test("contact.submit requires both per-session rules (3/h AND 10/day)", () => {
    const h = harness(20_000 * 86_400 * 1000);
    for (let i = 0; i < 3; i++) expect(limitAction(h.limiter, "contact.submit", UUID_A).ok).toBe(true);
    const r = limitAction(h.limiter, "contact.submit", UUID_A);
    expect(retryAfter(r)).toBeLessThanOrEqual(3600);
    expect(limitAction(h.limiter, "contact.submit", UUID_B).ok).toBe(true);
  });

  test("invalid rules throw RangeError", () => {
    const h = harness();
    const bad = [
      { limit: 0, windowSeconds: 60 },
      { limit: -1, windowSeconds: 60 },
      { limit: 1.5, windowSeconds: 60 },
      { limit: Number.NaN, windowSeconds: 60 },
      { limit: Number.POSITIVE_INFINITY, windowSeconds: 60 },
      { limit: 1, windowSeconds: 0 },
      { limit: 1, windowSeconds: -60 },
      { limit: 1, windowSeconds: 0.5 },
      { limit: 1, windowSeconds: Number.NaN },
    ];
    for (const rule of bad) expect(() => h.limiter.check("k", rule)).toThrow(RangeError);
    expect(rowCount(h.db)).toBe(0);
  });

  test("invalid cleanText options throw RangeError", () => {
    for (const opts of [{ max: 0 }, { max: -1 }, { max: 1.5 }, { max: Number.NaN }, { max: 5, min: 6 }, { max: 5, min: -1 }]) {
      expect(() => cleanText("x", opts)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// Coupon normalisation (contract)
// ---------------------------------------------------------------------------
describe("QA T31-8 normalizeCouponCode", () => {
  test("accepts and normalises valid codes", () => {
    expect(normalizeCouponCode("  save10 ")).toEqual({ ok: true, value: "SAVE10" });
    expect(normalizeCouponCode("a_b-C")).toEqual({ ok: true, value: "A_B-C" });
    expect(normalizeCouponCode("A".repeat(32))).toEqual({ ok: true, value: "A".repeat(32) });
  });

  test("rejects hostile codes with COUPON_INVALID", () => {
    const hostile: unknown[] = [
      "A".repeat(33),
      "SAVE 10",
      "",
      "   ",
      "S\u0410VE", // Cyrillic A
      "SAVE\uFF11\uFF10", // fullwidth 10
      "\u0131nfo", // dotless i
      "\u017Fave", // long s
      "SA\u200BVE",
      "\u200BSAVE",
      "SAVE\u200D",
      "stra\u00DFe",
      "SAVE%",
      "SAVE'--",
      "A".repeat(10_000),
      null,
      undefined,
      10,
      ["SAVE10"],
      { toString: () => "SAVE10" },
    ];
    for (const h of hostile) {
      const r = normalizeCouponCode(h);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("COUPON_INVALID");
    }
  });

  test("text-guard.ts has no DB import", () => {
    const src = readFileSync(join(import.meta.dir, "../../../src/server/security/text-guard.ts"), "utf8");
    expect(src).not.toMatch(/server\/db|bun:sqlite/);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: cleanText
// ---------------------------------------------------------------------------
function value(r: ReturnType<typeof cleanText>): string {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}
function code(r: ReturnType<typeof cleanText>): string {
  if (r.ok) throw new Error(`expected error, got ok ${JSON.stringify(r.value)}`);
  return r.error.code;
}

describe("QA T31-5 cleanText", () => {
  test("1 MB string over max*4 returns TOO_LONG in < 50 ms", () => {
    const big = "\u0000a ".repeat(350_000);
    const t0 = performance.now();
    const r = cleanText(big, { max: 2000 });
    const ms = performance.now() - t0;
    expect(code(r)).toBe("TOO_LONG");
    expect(ms).toBeLessThan(50);
  });

  test("1 MB string under max*4 is scanned linearly in < 50 ms (pathological mix)", () => {
    const big = (" \t\u200B\u202E\r\n\n\n<a>").repeat(100_000).slice(0, 1_000_000);
    cleanText("warm", { max: 10 });
    const t0 = performance.now();
    const r = cleanText(big, { max: 1_000_000, multiline: true });
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(50);
  });

  test("boundary: raw length exactly max*4 is scanned, max*4+1 is rejected", () => {
    expect(value(cleanText(" ".repeat(39) + "a", { max: 10 }))).toBe("a");
    expect(code(cleanText(" ".repeat(40) + "a", { max: 10 }))).toBe("TOO_LONG");
  });

  test("strips C0 (keeping \\n only when multiline), DEL, C1", () => {
    let c0 = "";
    for (let i = 0; i < 0x20; i++) if (![0x09, 0x0a, 0x0b, 0x0c, 0x0d].includes(i)) c0 += String.fromCharCode(i);
    let c1 = "";
    for (let i = 0x7f; i <= 0x9f; i++) c1 += String.fromCharCode(i);
    expect(value(cleanText(`a${c0}b${c1}c`, { max: 100 }))).toBe("abc");
    expect(value(cleanText("a\nb", { max: 100 }))).toBe("a b");
    expect(value(cleanText("a\nb", { max: 100, multiline: true }))).toBe("a\nb");
    expect(value(cleanText("a\r\nb\rc", { max: 100, multiline: true }))).toBe("a\nb\nc");
  });

  test("strips zero-width and bidi-override characters", () => {
    const invisible = "\u200B\u200C\u200D\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u2060\uFEFF";
    expect(value(cleanText(`ad${invisible}min`, { max: 100 }))).toBe("admin");
    expect(code(cleanText(invisible, { max: 100, min: 1 }))).toBe("VALIDATION_FAILED");
  });

  test("collapses whitespace and trims", () => {
    expect(value(cleanText("  a \t\t b   c  ", { max: 100 }))).toBe("a b c");
    expect(value(cleanText("a\n\n\n\n\nb", { max: 100, multiline: true }))).toBe("a\n\nb");
    expect(value(cleanText(" \n a  \n  b \n ", { max: 100, multiline: true }))).toBe("a\nb");
  });

  test("Unicode whitespace (NBSP, ideographic space, en/em space) is collapsed/trimmed like String.prototype.trim", () => {
    expect(code(cleanText("\u00A0\u00A0\u3000\u2003", { max: 100, min: 1 }))).toBe("VALIDATION_FAILED");
    expect(value(cleanText("\u00A0a\u00A0\u00A0b\u3000", { max: 100 }))).toBe("a b");
  });

  test("min / max / types", () => {
    expect(code(cleanText("ab", { max: 10, min: 3 }))).toBe("VALIDATION_FAILED");
    expect(code(cleanText("   ", { max: 10, min: 1 }))).toBe("VALIDATION_FAILED");
    expect(value(cleanText("", { max: 10 }))).toBe("");
    for (const bad of [null, undefined, 1, {}, [], ["a"], Symbol("x"), new String("a")]) {
      expect(code(cleanText(bad, { max: 10 }))).toBe("INVALID_INPUT");
    }
  });

  test("lengths in UTF-16 code units; result never longer than max", () => {
    expect(value(cleanText("\u{1F600}", { max: 2 }))).toBe("\u{1F600}");
    expect(code(cleanText("\u{1F600}", { max: 1 }))).toBe("TOO_LONG");
    expect(code(cleanText("abcdefghijk", { max: 10 }))).toBe("TOO_LONG");
    // fuzz: random mixes never exceed max
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const alphabet = ["a", " ", "\n", "\r", "\t", "\u200B", "\u0000", "\u{1F600}", "\u202E", "\u00E9"]; // NBSP covered by its own test
    for (let i = 0; i < 2000; i++) {
      const max = 1 + Math.floor(rnd() * 20);
      let s = "";
      const len = Math.floor(rnd() * max * 4);
      while (s.length < len) s += alphabet[Math.floor(rnd() * alphabet.length)];
      s = s.slice(0, max * 4);
      for (const multiline of [false, true]) {
        const r = cleanText(s, { max, multiline });
        if (r.ok) {
          expect(r.value.length).toBeLessThanOrEqual(max);
          expect(r.value).toBe(r.value.trim().length === r.value.length ? r.value : r.value.trim());
          expect(r.value).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E]/);
          if (!multiline) expect(r.value).not.toContain("\n");
        } else {
          expect(r.error.code).toBe("TOO_LONG");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: no HTML handling, countUrls
// ---------------------------------------------------------------------------
describe("QA T31-6 html passthrough and countUrls", () => {
  test("<script> and other markup returned unchanged", () => {
    expect(value(cleanText("<script>x</script>", { max: 100 }))).toBe("<script>x</script>");
    expect(value(cleanText(`<img src=x onerror="alert(1)">&amp;`, { max: 100 }))).toBe(`<img src=x onerror="alert(1)">&amp;`);
  });

  test("0, 1, 3 URLs; uppercase scheme; www", () => {
    expect(countUrls("")).toBe(0);
    expect(countUrls("no links here, just http and www")).toBe(0);
    expect(countUrls("see https://example.com")).toBe(1);
    expect(countUrls("HTTP://A.COM Https://b.com WWW.c.com")).toBe(3);
    expect(countUrls("https://www.example.com")).toBe(1);
    expect(countUrls("http:// https://")).toBe(2);
  });

  test("URLs inside words", () => {
    expect(countUrls("visithttp://spam.com")).toBe(1);
    expect(countUrls("awww.cute")).toBe(0);
    expect(countUrls("(www.example.com)")).toBe(1);
  });

  test("URLs separated by punctuation instead of whitespace are each counted", () => {
    expect(countUrls("http://a.com,http://b.com,http://c.com")).toBe(3);
    expect(countUrls("<http://a.com><http://b.com>")).toBe(2);
  });

  test("10k-char inputs run in linear time", () => {
    const inputs = ["h".repeat(10_000), "http:/".repeat(1_700), "www".repeat(3_400), "https://x ".repeat(1_000)];
    for (const s of inputs) {
      const t0 = performance.now();
      countUrls(s);
      expect(performance.now() - t0).toBeLessThan(20);
    }
    // 100x input -> not more than ~100x time (no quadratic blowup)
    const small = "http:/h".repeat(1_500);
    const large = small.repeat(100);
    const t1 = performance.now();
    countUrls(large);
    expect(performance.now() - t1).toBeLessThan(200);
    expect(countUrls("https://x ".repeat(1_000))).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// Accounts addendum: keyKind "opaque" and user-keyed actions
// ---------------------------------------------------------------------------
describe("QA T31-8 keyKind opaque", () => {
  const HEX = "0123456789abcdef".repeat(4); // 64 chars
  function keys(db: Database): string[] {
    return db
      .query<{ key: string }, []>("SELECT key FROM rate_limits ORDER BY key")
      .all()
      .map((r) => r.key);
  }

  test("64-hex accepted; upper/mixed case folds to the same lower-case bucket", () => {
    const h = harness();
    limitAction(h.limiter, "auth.signin.session", HEX, { keyKind: "opaque" });
    limitAction(h.limiter, "auth.signin.session", HEX.toUpperCase(), { keyKind: "opaque" });
    limitAction(h.limiter, "auth.signin.session", "0123456789ABCDEF".repeat(4), { keyKind: "opaque" });
    const row = h.db
      .query<{ count: number }, [string]>("SELECT count FROM rate_limits WHERE key = ?")
      .get(`900:auth.signin.session:${HEX}`);
    expect(row?.count).toBe(3);
    expect(keys(h.db).filter((k) => /[A-F]/.test(k))).toEqual([]);
  });

  test("63/65 chars, non-hex, UUID, null, '*', ':'-injection, 10k hex, unicode digits -> anon", () => {
    const h = harness();
    const bad: (string | null)[] = [
      HEX.slice(0, 63),
      `${HEX}0`,
      `${HEX.slice(0, 63)}g`,
      `${HEX.slice(0, 63)}\u0660`,
      ` ${HEX.slice(0, 63)}`,
      `${HEX.slice(0, 63)}\n`,
      UUID_A,
      null,
      "",
      "*",
      `${HEX.slice(0, 62)}:*`,
      "a".repeat(10_000),
    ];
    for (const k of bad) limitAction(h.limiter, "auth.signin.email", k, { keyKind: "opaque" });
    expect(keys(h.db)).toEqual(["900:auth.signin.email:anon"]);
    const row = h.db
      .query<{ count: number }, [string]>("SELECT count FROM rate_limits WHERE key = ?")
      .get("900:auth.signin.email:anon");
    expect(row?.count).toBe(bad.length);
  });

  test("auth.signin.email defaults to opaque (64-hex kept, UUID -> anon)", () => {
    const h = harness();
    limitAction(h.limiter, "auth.signin.email", HEX);
    limitAction(h.limiter, "auth.signin.email", UUID_A);
    expect(keys(h.db).sort()).toEqual([`900:auth.signin.email:${HEX}`, "900:auth.signin.email:anon"].sort());
  });

  test("other actions default to session kind (64-hex -> anon, UUID kept)", () => {
    const h = harness();
    limitAction(h.limiter, "auth.signin.session", HEX);
    limitAction(h.limiter, "account.delete", UUID_A);
    expect(keys(h.db).sort()).toEqual(
      ["900:auth.signin.session:anon", "900:auth.signin.session:*", `3600:account.delete:${UUID_A}`].sort(),
    );
    // explicit keyKind "session" on the email action overrides the default
    limitAction(h.limiter, "auth.signin.email", UUID_A, { keyKind: "session" });
    expect(keys(h.db)).toContain(`900:auth.signin.email:${UUID_A}`);
  });

  test("auth.signin.email: 10 per digest, 11th limited, other digest unaffected", () => {
    const h = harness();
    for (let i = 0; i < 10; i++) expect(limitAction(h.limiter, "auth.signin.email", HEX).ok).toBe(true);
    expect(retryAfter(limitAction(h.limiter, "auth.signin.email", HEX))).toBeLessThanOrEqual(900);
    expect(limitAction(h.limiter, "auth.signin.email", "f".repeat(64)).ok).toBe(true);
  });

  test("user-keyed / no-global actions never write a '*' key, even with 1000 calls", () => {
    const h = harness();
    const noGlobal: RateLimitedAction[] = [
      "auth.signin.email",
      "account.changePassword",
      "account.delete",
      "account.updateProfile",
      "address.write",
      "list.mutate",
    ];
    for (const a of noGlobal) {
      for (let i = 0; i < 200; i++) {
        limitAction(h.limiter, a, `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`);
        limitAction(h.limiter, a, "*");
      }
    }
    expect(rowCount(h.db, "key LIKE ?", ["%:*"])).toBe(0);
  });

  test("auth.signup: 100 sessions x 1 fills the global; 101st fresh session limited", () => {
    const h = harness();
    for (let s = 0; s < 100; s++) {
      expect(limitAction(h.limiter, "auth.signup", `00000000-0000-4000-8000-${s.toString(16).padStart(12, "0")}`).ok).toBe(true);
    }
    expect(limitAction(h.limiter, "auth.signup", UUID_A).ok).toBe(false);
  });

  test("opaque key fail-closed log never contains the digest", () => {
    const h = harness();
    h.db.run("DROP TABLE rate_limits");
    expect(limitAction(h.limiter, "auth.signin.email", HEX).ok).toBe(false);
    expect(h.logs.length).toBeGreaterThan(0);
    expect(h.logs.join("\n")).not.toContain(HEX.slice(0, 16));
  });
});

describe("QA T31 fix re-verification", () => {
  test("coupon: BOM/zero-width anywhere rejected; NBSP padding trimmed", () => {
    for (const c of ["﻿SAVE10", "SAVE10﻿", "SA﻿VE", "​SAVE", "SAVE⁠"]) {
      const r = normalizeCouponCode(c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("COUPON_INVALID");
    }
    expect(normalizeCouponCode(" save10 ")).toEqual({ ok: true, value: "SAVE10" });
  });

  test("cleanText: Hangul fillers stripped, U+2028 is a line break, NEL stripped, Unicode spaces collapse", () => {
    expect(code(cleanText("ㅤﾠ", { max: 50, min: 1 }))).toBe("VALIDATION_FAILED");
    expect(value(cleanText("a b", { max: 50, multiline: true }))).toBe("a\nb");
    expect(value(cleanText("a b", { max: 50 }))).toBe("a b");
    expect(value(cleanText("a\u0085b", { max: 50 }))).toBe("ab");
    expect(value(cleanText("a     b", { max: 50 }))).toBe("a b");
  });

  test("countUrls: dense 1M-char inputs stay linear", () => {
    const t0 = performance.now();
    expect(countUrls("http://".repeat(150_000))).toBe(150_000);
    expect(countUrls("www.".repeat(250_000))).toBe(250_000);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
