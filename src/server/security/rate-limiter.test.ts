import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AppError, Result } from "@/lib/result";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import {
  PURGE_EVERY,
  RATE_LIMIT_RULES,
  createRateLimiter,
  getRateLimiter,
  limitAction,
  type RateLimitOk,
  type RateLimitRule,
  type RateLimitedAction,
  type RateLimiter,
} from "./rate-limiter";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";

/** 2026-11-07T00:00:00Z, a multiple of every window used here. */
const T0 = Date.UTC(2026, 10, 7);

function makeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advanceSeconds: (s: number) => {
      t += s * 1000;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

function setup(start = T0) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const clock = makeClock(start);
  const logs: string[] = [];
  const logger = { error: (...args: unknown[]) => void logs.push(args.map(String).join(" ")) };
  const limiter = createRateLimiter(db, { now: clock.now, logger });
  return { db, clock, logs, limiter };
}

function rowCount(db: Database): number {
  const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM rate_limits").get();
  return row?.n ?? -1;
}

function retryAfter(r: Result<RateLimitOk, AppError>): number {
  if (r.ok) throw new Error("expected RATE_LIMITED");
  expect(r.error.code).toBe("RATE_LIMITED");
  const v = r.error.details?.retryAfterSeconds;
  if (typeof v !== "number") throw new Error("missing retryAfterSeconds");
  return v;
}

const TEN_PER_MINUTE: RateLimitRule = { limit: 10, windowSeconds: 60 };

describe("check", () => {
  test("N calls succeed with decreasing remaining, N+1 is RATE_LIMITED, next window resets", () => {
    const { limiter, clock } = setup();
    for (let i = 1; i <= 10; i++) {
      const r = limiter.check("k", TEN_PER_MINUTE);
      expect(r).toEqual({ ok: true, value: { remaining: 10 - i } });
    }
    clock.advanceSeconds(15);
    expect(retryAfter(limiter.check("k", TEN_PER_MINUTE))).toBe(45);
    clock.advanceSeconds(44);
    expect(retryAfter(limiter.check("k", TEN_PER_MINUTE))).toBe(1);
    clock.advanceSeconds(1);
    expect(limiter.check("k", TEN_PER_MINUTE)).toEqual({ ok: true, value: { remaining: 9 } });
  });

  test("retryAfterSeconds is always within 1..windowSeconds", () => {
    const { limiter, clock } = setup(T0 + 123);
    const rule = { limit: 1, windowSeconds: 7 };
    for (let i = 0; i < 200; i++) {
      limiter.check("k", rule);
      const r = limiter.check("k", rule);
      const s = retryAfter(r);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(7);
      clock.set(T0 + 123 + i * 1337);
    }
  });

  test("windows are fixed: aligned to multiples of windowSeconds, not to the first call", () => {
    const { limiter, clock } = setup(T0 + 50_000);
    const rule = { limit: 1, windowSeconds: 60 };
    expect(limiter.check("k", rule).ok).toBe(true);
    clock.advanceSeconds(10); // T0+60s: new window even though only 10 s passed
    expect(limiter.check("k", rule).ok).toBe(true);
  });

  test("different keys do not interfere", () => {
    const { limiter } = setup();
    const rule = { limit: 2, windowSeconds: 60 };
    expect(limiter.check("a", rule).ok).toBe(true);
    expect(limiter.check("a", rule).ok).toBe(true);
    expect(limiter.check("a", rule).ok).toBe(false);
    expect(limiter.check("b", rule).ok).toBe(true);
    expect(limiter.check("b", rule).ok).toBe(true);
    expect(limiter.check("b", rule).ok).toBe(false);
  });

  test("same key with two window sizes keeps separate counters (even when windows start together)", () => {
    const { limiter } = setup(); // T0 is a day boundary, so hour and day windows share window_start
    const hour = { limit: 3, windowSeconds: 3600 };
    const day = { limit: 10, windowSeconds: 86_400 };
    for (let i = 0; i < 3; i++) {
      expect(limiter.check("k", hour).ok).toBe(true);
      expect(limiter.check("k", day).ok).toBe(true);
    }
    expect(limiter.check("k", hour).ok).toBe(false);
    expect(limiter.check("k", day)).toEqual({ ok: true, value: { remaining: 6 } });
  });

  test("Promise.all of 50 checks on a limit of 10 admits exactly 10", async () => {
    const { limiter } = setup();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => Promise.resolve().then(() => limiter.check("burst", TEN_PER_MINUTE))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok && r.error.code === "RATE_LIMITED")).toHaveLength(40);
  });

  test("two limiters on the same database share counters (state lives in the table)", () => {
    const { db, clock, limiter } = setup();
    const other = createRateLimiter(db, { now: clock.now });
    const rule = { limit: 2, windowSeconds: 60 };
    expect(limiter.check("k", rule).ok).toBe(true);
    expect(other.check("k", rule).ok).toBe(true);
    expect(limiter.check("k", rule).ok).toBe(false);
  });

  test("invalid rules throw (programmer error)", () => {
    const { limiter } = setup();
    expect(() => limiter.check("k", { limit: 0, windowSeconds: 60 })).toThrow(RangeError);
    expect(() => limiter.check("k", { limit: 1, windowSeconds: 0 })).toThrow(RangeError);
    expect(() => limiter.check("k", { limit: 1.5, windowSeconds: 60 })).toThrow(RangeError);
    expect(() => limiter.check("k", { limit: 1, windowSeconds: Number.NaN })).toThrow(RangeError);
  });
});

describe("purge", () => {
  test("rows older than the previous window are deleted on a window's first hit", () => {
    const { db, limiter, clock } = setup();
    limiter.check("a", TEN_PER_MINUTE);
    clock.advanceSeconds(60);
    limiter.check("b", TEN_PER_MINUTE);
    expect(rowCount(db)).toBe(2); // current + previous window kept
    clock.advanceSeconds(60);
    limiter.check("c", TEN_PER_MINUTE);
    const keys = db.query<{ key: string }, []>("SELECT key FROM rate_limits ORDER BY key").all().map((r) => r.key);
    expect(keys).toEqual(["60:b", "60:c"]);
  });

  test("purge only touches rows of the same window size", () => {
    const { db, limiter, clock } = setup();
    limiter.check("daily", { limit: 5, windowSeconds: 86_400 });
    clock.advanceSeconds(600);
    limiter.check("minute", TEN_PER_MINUTE);
    clock.advanceSeconds(600);
    limiter.check("minute", TEN_PER_MINUTE);
    const keys = db.query<{ key: string }, []>("SELECT key FROM rate_limits ORDER BY key").all().map((r) => r.key);
    expect(keys).toEqual(["60:minute", "86400:daily"]);
  });

  test("10,000 calls with a fresh key each (cookie-discarding client): rows stay within the bound", () => {
    const { db, limiter, clock } = setup();
    // 5 calls per second, one new key per call, 60 s window: at most 2 windows
    // x 300 keys/window = 600 per-key rows, plus 2 global rows.
    const keysPerWindow = 5 * 60;
    const bound = 2 * keysPerWindow + 2;
    let maxRows = 0;
    for (let i = 0; i < 10_000; i++) {
      if (i > 0 && i % 5 === 0) clock.advanceSeconds(1);
      limiter.check(`search.suggest:${i}`, TEN_PER_MINUTE);
      limiter.check("search.suggest:*", { limit: 1_000_000, windowSeconds: 60 });
      if (i % 50 === 0) maxRows = Math.max(maxRows, rowCount(db));
    }
    maxRows = Math.max(maxRows, rowCount(db));
    expect(maxRows).toBeLessThanOrEqual(bound);
    expect(maxRows).toBeGreaterThan(keysPerWindow); // sanity: the test really filled windows
  });

  test("10,000 calls over a fixed set of sessions through limitAction: bounded by keys x windows", () => {
    const { db, limiter, clock } = setup();
    const sessions = Array.from({ length: 20 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    let maxRows = 0;
    for (let i = 0; i < 10_000; i++) {
      clock.advanceSeconds(7);
      limitAction(limiter, "contact.submit", sessions[i % sessions.length] ?? null);
      if (i % 100 === 0) maxRows = Math.max(maxRows, rowCount(db));
    }
    // Per session: 2 hour rows + 2 day rows; global: 2 hour rows.
    expect(maxRows).toBeLessThanOrEqual(sessions.length * 4 + 2);
  });

  test(`a purge also runs on every ${PURGE_EVERY}th check without new windows`, () => {
    const { db, limiter, clock } = setup();
    limiter.check("old", TEN_PER_MINUTE); // check #1 (count 1 -> purge)
    clock.advanceSeconds(120);
    // Seed a hot key in the current window without triggering via count === 1 afterwards.
    limiter.check("hot", { limit: 1_000_000, windowSeconds: 60 }); // count 1 -> purge removes "old"
    expect(rowCount(db)).toBe(1);
    db.run("INSERT INTO rate_limits (key, window_start, count) VALUES ('60:stale', 0, 1)");
    let calls = 2;
    while (calls % PURGE_EVERY !== PURGE_EVERY - 1) {
      limiter.check("hot", { limit: 1_000_000, windowSeconds: 60 });
      calls++;
    }
    expect(rowCount(db)).toBe(2);
    limiter.check("hot", { limit: 1_000_000, windowSeconds: 60 });
    expect(rowCount(db)).toBe(1);
  });
});

describe("failure handling", () => {
  test("database error fails closed with retryAfterSeconds = window and logs no session id", () => {
    const { db, limiter, logs } = setup();
    db.run("DROP TABLE rate_limits");
    const r = limitAction(limiter, "review.submit", S1);
    expect(retryAfter(r)).toBe(3600);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("review.submit");
    expect(logs[0]).not.toContain(S1);
    expect(logs[0]).not.toContain(S1.slice(0, 8));
  });

  test("closed database fails closed", () => {
    const { db, limiter, logs } = setup();
    db.close();
    expect(retryAfter(limiter.check(`coupon.apply:${S2}`, { limit: 10, windowSeconds: 600 }))).toBe(600);
    expect(logs.join("\n")).not.toContain(S2);
  });

  test("a throwing logger does not change the answer", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    db.run("DROP TABLE rate_limits");
    const limiter = createRateLimiter(db, {
      now: () => T0,
      logger: {
        error: () => {
          throw new Error("logger down");
        },
      },
    });
    expect(retryAfter(limiter.check("x:y", TEN_PER_MINUTE))).toBe(60);
  });

  test("a failing purge does not block an admitted call", () => {
    const { db, limiter, logs } = setup();
    db.run(
      "CREATE TRIGGER no_delete BEFORE DELETE ON rate_limits BEGIN SELECT RAISE(ABORT, 'nope'); END",
    );
    db.run("INSERT INTO rate_limits (key, window_start, count) VALUES ('60:old', 0, 1)");
    expect(limiter.check(`vote:${S1}`, TEN_PER_MINUTE).ok).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("purge failed");
    expect(logs[0]).not.toContain(S1);
  });
});

describe("RATE_LIMIT_RULES", () => {
  test("matches the backlog table", () => {
    const h = (limit: number) => ({ limit, windowSeconds: 3600 });
    expect(RATE_LIMIT_RULES).toEqual({
      "review.submit": { perSession: h(5), global: h(300) },
      vote: { perSession: h(60), global: h(3000) },
      "question.ask": { perSession: h(5), global: h(300) },
      "answer.post": { perSession: h(10), global: h(300) },
      "contact.submit": { perSession: [h(3), { limit: 10, windowSeconds: 86_400 }], global: h(200) },
      "stock_alert.subscribe": { perSession: h(10), global: h(500) },
      "coupon.apply": { perSession: { limit: 10, windowSeconds: 600 }, global: { limit: 1000, windowSeconds: 600 } },
      "address.write": { perSession: { limit: 20, windowSeconds: 86_400 }, global: null },
      "list.mutate": { perSession: h(120), global: null },
      "search.suggest": { perSession: { limit: 120, windowSeconds: 60 }, global: { limit: 3000, windowSeconds: 60 } },
      "auth.signin.session": { perSession: { limit: 10, windowSeconds: 900 }, global: { limit: 1000, windowSeconds: 900 } },
      "auth.signin.email": { perSession: { limit: 10, windowSeconds: 900 }, global: null },
      "auth.signup": { perSession: h(5), global: h(100) },
      "account.changePassword": { perSession: { limit: 5, windowSeconds: 900 }, global: null },
      "account.delete": { perSession: h(5), global: null },
      "account.updateProfile": { perSession: h(20), global: null },
    });
    expect(Object.isFrozen(RATE_LIMIT_RULES)).toBe(true);
  });
});

/** Records keys and replays scripted answers, to test limitAction in isolation. */
function recordingLimiter(failOn?: (key: string, rule: RateLimitRule) => boolean) {
  const calls: { key: string; rule: RateLimitRule }[] = [];
  const limiter: RateLimiter = {
    check(key, rule) {
      calls.push({ key, rule });
      if (failOn?.(key, rule) === true) {
        return { ok: false, error: { code: "RATE_LIMITED", message: "x", details: { retryAfterSeconds: 1 } } };
      }
      return { ok: true, value: { remaining: rule.limit - 1 } };
    },
  };
  return { calls, limiter };
}

describe("limitAction", () => {
  test("checks the per-session key then the global backstop key", () => {
    const { calls, limiter } = recordingLimiter();
    expect(limitAction(limiter, "review.submit", S1)).toEqual({ ok: true, value: { remaining: 4 } });
    expect(calls.map((c) => c.key)).toEqual([`review.submit:${S1}`, "review.submit:*"]);
  });

  test("null or non-UUID sessions use the anon key (\"*\" cannot alias the global key)", () => {
    for (const s of [null, "*", "", "not-a-uuid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]) {
      const { calls, limiter } = recordingLimiter();
      limitAction(limiter, "search.suggest", s);
      expect(calls.map((c) => c.key)).toEqual(["search.suggest:anon", "search.suggest:*"]);
    }
  });

  test("actions without a global rule check only the session key", () => {
    const { calls, limiter } = recordingLimiter();
    limitAction(limiter, "list.mutate", S1);
    expect(calls.map((c) => c.key)).toEqual([`list.mutate:${S1}`]);
  });

  test("multiple per-session rules all apply; the first failure wins and stops", () => {
    const { calls, limiter } = recordingLimiter((_k, rule) => rule.windowSeconds === 86_400);
    const r = limitAction(limiter, "contact.submit", S1);
    expect(r.ok).toBe(false);
    expect(calls.map((c) => c.rule.windowSeconds)).toEqual([3600, 86_400]);
  });

  test("contact.submit end to end: 3/hour, then 10/day", () => {
    const { limiter, clock } = setup();
    let admitted = 0;
    for (let hour = 0; hour < 24; hour++) {
      for (let i = 0; i < 5; i++) if (limitAction(limiter, "contact.submit", S1).ok) admitted++;
      clock.advanceSeconds(3600);
    }
    expect(admitted).toBe(10);
  });

  test("global backstop trips even when each session is under its own limit", () => {
    const { limiter } = setup();
    let admitted = 0;
    let lastError: Result<RateLimitOk, AppError> | null = null;
    for (let i = 0; i < 120; i++) {
      const session = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
      for (let j = 0; j < 3; j++) {
        const r = limitAction(limiter, "review.submit", session); // 3 < 5 per session
        if (r.ok) admitted++;
        else lastError = r;
      }
    }
    expect(admitted).toBe(300);
    expect(lastError).not.toBeNull();
    if (lastError !== null) expect(retryAfter(lastError)).toBe(3600);
  });

  test("every action has at least one rule and resolves end to end", () => {
    const { limiter } = setup();
    for (const action of Object.keys(RATE_LIMIT_RULES) as RateLimitedAction[]) {
      expect(limitAction(limiter, action, S2).ok).toBe(true);
    }
  });
});

const DIGEST = "a".repeat(32) + "0123456789abcdef0123456789abcdef";
const OTHER_DIGEST = "b".repeat(64);

/** Runs `limitAction` until refused; returns how many calls were admitted (capped). */
function admittedUntilRefused(limiter: RateLimiter, action: RateLimitedAction, key: string | null, cap = 5000): number {
  let n = 0;
  while (n < cap && limitAction(limiter, action, key).ok) n++;
  return n;
}

describe("accounts epic rules end to end", () => {
  const perKeyCases: readonly [RateLimitedAction, number, number][] = [
    ["auth.signin.session", 10, 900],
    ["auth.signup", 5, 3600],
    ["account.changePassword", 5, 900],
    ["account.delete", 5, 3600],
    ["account.updateProfile", 20, 3600],
  ];

  for (const [action, limit, windowSeconds] of perKeyCases) {
    test(`${action}: ${limit} per ${windowSeconds} s per key, then reset`, () => {
      const { limiter, clock } = setup();
      expect(admittedUntilRefused(limiter, action, S1)).toBe(limit);
      const refused = limitAction(limiter, action, S1);
      expect(retryAfter(refused)).toBe(windowSeconds);
      expect(limitAction(limiter, action, S2).ok).toBe(true); // other key unaffected
      clock.advanceSeconds(windowSeconds);
      expect(limitAction(limiter, action, S1).ok).toBe(true);
    });
  }

  test("auth.signin.session global backstop: 1000 per 900 s", () => {
    const { limiter } = setup();
    let admitted = 0;
    for (let i = 0; i < 1100; i++) {
      const session = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
      if (limitAction(limiter, "auth.signin.session", session).ok) admitted++;
    }
    expect(admitted).toBe(1000);
  });

  test("auth.signup global backstop: 100 per hour", () => {
    const { limiter } = setup();
    let admitted = 0;
    for (let i = 0; i < 150; i++) {
      const session = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
      if (limitAction(limiter, "auth.signup", session).ok) admitted++;
    }
    expect(admitted).toBe(100);
  });

  test("user-keyed account actions have no global backstop", () => {
    for (const action of ["account.changePassword", "account.delete", "account.updateProfile", "auth.signin.email"] as const) {
      const { calls, limiter } = recordingLimiter();
      limitAction(limiter, action, S1, { keyKind: "session" });
      expect(calls).toHaveLength(1);
    }
  });

  test("auth.signin.email: 10 per 900 s per email digest, no global", () => {
    const { limiter, clock } = setup();
    expect(admittedUntilRefused(limiter, "auth.signin.email", DIGEST)).toBe(10);
    expect(retryAfter(limitAction(limiter, "auth.signin.email", DIGEST, { keyKind: "opaque" }))).toBe(900);
    expect(admittedUntilRefused(limiter, "auth.signin.email", OTHER_DIGEST)).toBe(10);
    clock.advanceSeconds(900);
    expect(limitAction(limiter, "auth.signin.email", DIGEST).ok).toBe(true);
  });
});

describe("limitAction keyKind", () => {
  test("opaque accepts 64-char hex and lower-cases it (one bucket per digest)", () => {
    const { calls, limiter } = recordingLimiter();
    limitAction(limiter, "auth.signin.email", DIGEST, { keyKind: "opaque" });
    limitAction(limiter, "auth.signin.email", DIGEST.toUpperCase(), { keyKind: "opaque" });
    expect(calls.map((c) => c.key)).toEqual([`auth.signin.email:${DIGEST}`, `auth.signin.email:${DIGEST}`]);
  });

  test("opaque rejects non-hex, wrong length, UUIDs and null as anon", () => {
    for (const bad of [null, "", "*", "g".repeat(64), "a".repeat(63), "a".repeat(65), S1, ` ${"a".repeat(63)}`, "a".repeat(10_000)]) {
      const { calls, limiter } = recordingLimiter();
      limitAction(limiter, "auth.signin.email", bad, { keyKind: "opaque" });
      expect(calls.map((c) => c.key)).toEqual(["auth.signin.email:anon"]);
    }
  });

  test("auth.signin.email defaults to opaque; other actions default to session", () => {
    const a = recordingLimiter();
    limitAction(a.limiter, "auth.signin.email", DIGEST);
    expect(a.calls[0]?.key).toBe(`auth.signin.email:${DIGEST}`);
    const b = recordingLimiter();
    limitAction(b.limiter, "auth.signin.session", DIGEST);
    expect(b.calls[0]?.key).toBe("auth.signin.session:anon");
  });

  test("session keyKind still requires a UUID v4 even when opaque would accept the value", () => {
    const { calls, limiter } = recordingLimiter();
    limitAction(limiter, "account.delete", DIGEST, { keyKind: "session" });
    limitAction(limiter, "account.delete", S2, { keyKind: "session" });
    expect(calls.map((c) => c.key)).toEqual(["account.delete:anon", `account.delete:${S2}`]);
  });

  test("opaque applies to any action when requested explicitly", () => {
    const { calls, limiter } = recordingLimiter();
    limitAction(limiter, "auth.signup", OTHER_DIGEST, { keyKind: "opaque" });
    expect(calls.map((c) => c.key)).toEqual([`auth.signup:${OTHER_DIGEST}`, "auth.signup:*"]);
  });
});

describe("getRateLimiter", () => {
  const previous = process.env.DATABASE_PATH;
  afterEach(() => {
    closeDatabase();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  });

  test("is a singleton over the shared database and is rebuilt when the handle changes", () => {
    process.env.DATABASE_PATH = ":memory:";
    const a = getRateLimiter();
    expect(getRateLimiter()).toBe(a);
    expect(a.check("k", TEN_PER_MINUTE).ok).toBe(true);
    closeDatabase();
    const b = getRateLimiter();
    expect(b).not.toBe(a);
    expect(b.check("k", TEN_PER_MINUTE)).toEqual({ ok: true, value: { remaining: 9 } });
  });
});
