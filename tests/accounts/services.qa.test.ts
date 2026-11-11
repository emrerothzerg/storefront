import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// T122 QA: auth service (T116), auth repository (T115), merge service (T117)
// and account lifecycle (T118), adversarially, over :memory: SQLite.
// PLAN.md section 3.1-3.6, 3.8, 3.10 (svc rows) as amended by the
// orchestrator rulings (R-5, R-7, R-10, K-10, A-102).
// No next/* mocks are needed: these modules never import next/*.
// ---------------------------------------------------------------------------

import { ok, type AppError, type Result } from "@/lib/result";
import { createAuthRepository } from "@/server/auth/auth-repository";
import { createAuthService, hashToken, type AuthService, type IssuedSession } from "@/server/auth/auth-service";
import { argon2idHasher, validatePassword, type PasswordHasher } from "@/server/auth/password-policy";
import { WEAK_PASSWORDS } from "@/server/auth/weak-passwords";
import { createMergeService, type MergeSummary } from "@/server/auth/merge-service";
import { createAccountService, type AccountService } from "@/server/auth/account-service";
import type { RateLimiter } from "@/server/security/rate-limiter";
import { createDatabase } from "@/server/db/client";
import {
  INVALID_MSG,
  IN_STOCK_A,
  IN_STOCK_B,
  LOW_STOCK,
  MIN,
  OUT_OF_STOCK,
  OWNER_TABLES,
  PASSWORD,
  PASSWORD_B,
  SecretRegistry,
  T0,
  TOMBSTONE,
  closeTrackedDbs,
  consoleCapture,
  counts,
  discoverOwnerTables,
  fastHasher,
  fullSnapshot,
  helpfulMismatches,
  injectFailure,
  makeDb,
  mulberry32,
  ratingMismatches,
  safeJson,
  seedIdentity,
  seedOrderAndQa,
  sha256hex,
  snapshot,
  testClock,
  trackDb,
  uuid,
  zeroCounts,
  type FastHasher,
  type TestClock,
} from "./_fixtures";

const secrets = new SecretRegistry();
secrets.add(PASSWORD, PASSWORD_B, "wrong-pass-123", "Wr0ng-pass-qa!", "N3w-Passw0rd-qa");
const allResults: unknown[] = [];
const capture = consoleCapture();
const harvestDbs: Database[] = [];

function rec<T>(r: T): T {
  allResults.push(r);
  return r;
}

afterAll(() => {
  capture.restore();
  closeTrackedDbs();
});

const permissive: RateLimiter = { check: () => ok({ remaining: 999 }) };

interface AuthFixture {
  readonly db: Database;
  readonly svc: AuthService;
  readonly hasher: FastHasher;
  readonly clock: TestClock;
  readonly repo: ReturnType<typeof createAuthRepository>;
}

function authFixture(opts: { limiter?: "real" | "permissive"; hasher?: PasswordHasher; db?: Database } = {}): AuthFixture {
  const db = opts.db ?? makeDb(false);
  harvestDbs.push(db);
  const clock = testClock();
  const hasher = fastHasher();
  const limiter = opts.limiter === "permissive" ? permissive : undefined;
  const svc = createAuthService({
    db,
    hasher: opts.hasher ?? hasher,
    now: clock.now,
    ...(limiter ? { limiter } : {}),
  });
  return { db, svc, hasher, clock, repo: createAuthRepository(db) };
}

async function addUser(f: AuthFixture, email: string, password = PASSWORD): Promise<{ id: string; ownerKey: string }> {
  const created = f.repo.createUser({ email, passwordHash: await f.hasher.hash(password), displayName: "QA" }, f.clock.now());
  if (!created.ok) throw new Error("fixture user failed");
  f.hasher.reset();
  return { id: created.value.id, ownerKey: created.value.ownerKey };
}

function codeOf(r: Result<unknown, AppError>): string {
  return r.ok ? "OK" : r.error.code;
}

function userRow(db: Database, email: string): { failed_login_count: number; locked_until: string | null; last_login_at: string | null } {
  return db.query("SELECT failed_login_count, locked_until, last_login_at FROM users WHERE email = ?").get(email) as {
    failed_login_count: number;
    locked_until: string | null;
    last_login_at: string | null;
  };
}

// ===========================================================================
// 3.1 Credential stuffing and rate limits
// ===========================================================================

describe("T122-1 credential stuffing (service level)", () => {
  test("A-01: 200 attempts from one session across 20 emails -> 10 INVALID_CREDENTIALS then RATE_LIMITED; 10 verifies; no lock", async () => {
    const f = authFixture();
    const emails = Array.from({ length: 20 }, (_, i) => `u${i}@stuff.test`);
    for (const e of emails) await addUser(f, e);
    const session = uuid();
    const codes: string[] = [];
    for (let i = 0; i < 200; i++) {
      const r = rec(await f.svc.signIn({ email: emails[i % 20], password: "wrong-pass-123" }, { sessionKey: session }));
      codes.push(codeOf(r));
      if (i >= 10 && !r.ok) {
        const retry = r.error.details?.retryAfterSeconds as number;
        expect(retry).toBeGreaterThanOrEqual(1);
        expect(retry).toBeLessThanOrEqual(900);
      }
    }
    expect(codes.slice(0, 10)).toEqual(Array(10).fill("INVALID_CREDENTIALS"));
    expect(codes.slice(10)).toEqual(Array(190).fill("RATE_LIMITED"));
    expect(f.hasher.calls.verify).toBe(10);
    const rows = f.db.query("SELECT failed_login_count, locked_until FROM users").all() as { failed_login_count: number; locked_until: string | null }[];
    expect(Math.max(...rows.map((r) => r.failed_login_count))).toBe(1);
    expect(rows.every((r) => r.locked_until === null)).toBe(true);
  }, 30_000);

  test("A-02: 20 fresh sessions on one email -> 1-9 INVALID, 10 ACCOUNT_LOCKED, 11-20 RATE_LIMITED; verify count 10; counter 10", async () => {
    const f = authFixture();
    await addUser(f, "victim@stuff.test");
    const codes: string[] = [];
    for (let i = 0; i < 20; i++) {
      codes.push(codeOf(rec(await f.svc.signIn({ email: "victim@stuff.test", password: "wrong-pass-123" }, { sessionKey: uuid() }))));
    }
    expect(codes.slice(0, 9)).toEqual(Array(9).fill("INVALID_CREDENTIALS"));
    expect(codes[9]).toBe("ACCOUNT_LOCKED");
    expect(codes.slice(10)).toEqual(Array(10).fill("RATE_LIMITED"));
    expect(f.hasher.calls.verify).toBe(10);
    expect(userRow(f.db, "victim@stuff.test").failed_login_count).toBe(10);
    expect(userRow(f.db, "victim@stuff.test").locked_until).toBe(new Date(T0 + 15 * MIN).toISOString());

    // Correct password during the lock (same limiter window): rejected, no session.
    const during = rec(await f.svc.signIn({ email: "victim@stuff.test", password: PASSWORD }, { sessionKey: uuid() }));
    expect(during.ok).toBe(false);
    expect(["RATE_LIMITED", "ACCOUNT_LOCKED"]).toContain(codeOf(during));
    f.clock.set(T0 + 15 * MIN - 1000);
    const stillLocked = rec(await f.svc.signIn({ email: "victim@stuff.test", password: PASSWORD }, { sessionKey: uuid() }));
    expect(stillLocked.ok).toBe(false);
    expect(f.db.query("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });

    // Lock expires by clock advance: correct password succeeds and the counter is reset.
    f.clock.set(T0 + 15 * MIN + 1000);
    const after = rec(await f.svc.signIn({ email: "victim@stuff.test", password: PASSWORD }, { sessionKey: uuid() }));
    expect(after.ok).toBe(true);
    expect(userRow(f.db, "victim@stuff.test")).toMatchObject({ failed_login_count: 0, locked_until: null });
    if (after.ok) secrets.add(after.value.token);
  }, 30_000);

  test("A-02b: expired lock -> next WRONG attempt starts a fresh count (clearExpiredLock), not an immediate re-lock", async () => {
    const f = authFixture();
    await addUser(f, "relock@stuff.test");
    for (let i = 0; i < 10; i++) await f.svc.signIn({ email: "relock@stuff.test", password: "wrong-pass-123" }, { sessionKey: uuid() });
    expect(userRow(f.db, "relock@stuff.test").failed_login_count).toBe(10);
    f.clock.set(T0 + 16 * MIN); // past lock and in a new 900 s limiter window
    const r = rec(await f.svc.signIn({ email: "relock@stuff.test", password: "wrong-pass-123" }, { sessionKey: uuid() }));
    expect(codeOf(r)).toBe("INVALID_CREDENTIALS");
    expect(userRow(f.db, "relock@stuff.test")).toMatchObject({ failed_login_count: 1, locked_until: null });
  });

  test("A-03: unknown email from 20 sessions -> 1-9 INVALID, 10 ACCOUNT_LOCKED (uniform), 11-20 RATE_LIMITED; no rows; no plaintext", async () => {
    const f = authFixture();
    const codes: string[] = [];
    for (let i = 0; i < 20; i++) {
      codes.push(codeOf(rec(await f.svc.signIn({ email: "Ghost@Stuff.test", password: "wrong-pass-123" }, { sessionKey: uuid() }))));
    }
    expect(codes.slice(0, 9)).toEqual(Array(9).fill("INVALID_CREDENTIALS"));
    expect(codes[9]).toBe("ACCOUNT_LOCKED");
    expect(codes.slice(10)).toEqual(Array(10).fill("RATE_LIMITED"));
    expect(f.db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect(JSON.stringify(fullSnapshot(f.db, ["products", "categories", "brands"])).toLowerCase()).not.toContain("ghost@stuff.test");
  }, 30_000);

  test("A-04: 1001 sessions x 1001 emails in one window -> call 1001 RATE_LIMITED (global); 1000 verifies", async () => {
    const f = authFixture();
    let last: Result<IssuedSession, AppError> | null = null;
    for (let i = 0; i < 1001; i++) {
      last = await f.svc.signIn({ email: `g${i}@global.test`, password: "wrong-pass-123" }, { sessionKey: uuid() });
      if (i < 1000) expect(codeOf(last)).toBe("INVALID_CREDENTIALS");
    }
    expect(codeOf(last as Result<IssuedSession, AppError>)).toBe("RATE_LIMITED");
    expect(f.hasher.calls.verify).toBe(1000);
  }, 30_000);

  test("A-05: window boundary: 11th at T0+899s RATE_LIMITED retryAfter=1; 12th at T0+900s admitted (K-8 2x burst documented)", async () => {
    const f = authFixture();
    const s = uuid();
    f.clock.set(T0 + 899_000);
    for (let i = 0; i < 10; i++) await f.svc.signIn({ email: `w${i}@win.test`, password: "wrong-pass-123" }, { sessionKey: s });
    const r11 = await f.svc.signIn({ email: "w10@win.test", password: "wrong-pass-123" }, { sessionKey: s });
    expect(codeOf(r11)).toBe("RATE_LIMITED");
    expect(!r11.ok && r11.error.details?.retryAfterSeconds).toBe(1);
    f.clock.set(T0 + 900_000);
    const r12 = await f.svc.signIn({ email: "w11@win.test", password: "wrong-pass-123" }, { sessionKey: s });
    expect(codeOf(r12)).toBe("INVALID_CREDENTIALS");
  });

  test("A-06: spellings ' KATE@x.com' and 'kate@X.COM' share one per-email key (11th RATE_LIMITED)", async () => {
    const f = authFixture();
    await addUser(f, "kate@x.com");
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) codes.push(codeOf(await f.svc.signIn({ email: " KATE@x.com", password: "wrong-pass-123" }, { sessionKey: uuid() })));
    for (let i = 0; i < 5; i++) codes.push(codeOf(await f.svc.signIn({ email: "kate@X.COM", password: "wrong-pass-123" }, { sessionKey: uuid() })));
    expect(codes[10]).toBe("RATE_LIMITED");
  });

  test("A-07: per-email limiter keys are 900:auth.signin.email:<64 hex>, contain no '@' / local part / password, differ per email", async () => {
    const f = authFixture();
    for (const e of ["alpha@keys.test", "beta@keys.test"]) {
      await f.svc.signIn({ email: e, password: "wrong-pass-123" }, { sessionKey: uuid() });
    }
    const keys = (f.db.query("SELECT key FROM rate_limits").all() as { key: string }[]).map((r) => r.key);
    const emailKeys = keys.filter((k) => k.includes("auth.signin.email"));
    expect(emailKeys.length).toBe(2);
    for (const k of emailKeys) expect(k).toMatch(/^900:auth\.signin\.email:[0-9a-f]{64}$/);
    expect(emailKeys).toContain(`900:auth.signin.email:${sha256hex("alpha@keys.test")}`);
    for (const k of keys) {
      expect(k).not.toContain("@");
      expect(k).not.toContain("alpha");
      expect(k).not.toContain("wrong-pass");
    }
  });

  test("A-08: per-session limit reached -> valid password RATE_LIMITED, no verify, last_login_at unchanged, no session", async () => {
    const f = authFixture();
    await addUser(f, "valid@a08.test");
    const s = uuid();
    for (let i = 0; i < 10; i++) await f.svc.signIn({ email: `x${i}@a08.test`, password: "wrong-pass-123" }, { sessionKey: s });
    const verifies = f.hasher.calls.verify;
    const r = await f.svc.signIn({ email: "valid@a08.test", password: PASSWORD }, { sessionKey: s });
    expect(codeOf(r)).toBe("RATE_LIMITED");
    expect(f.hasher.calls.verify).toBe(verifies);
    expect(userRow(f.db, "valid@a08.test").last_login_at).toBeNull();
    expect(f.db.query("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });
  });

  test("A-09 (documented choice): null sessionKey shares the 'anon' per-session bucket; global 1000 is the real cap", async () => {
    const f = authFixture();
    const codes: string[] = [];
    for (let i = 0; i < 11; i++) codes.push(codeOf(await f.svc.signIn({ email: `c${i}@anon.test`, password: "wrong-pass-123" }, { sessionKey: null })));
    // R-3: actions always mint sf_session first, so the service never sees null from the app.
    expect(codes[10]).toBe("RATE_LIMITED");
  });

  test("A-10: 6 sign-ups from one session -> 5 succeed, 6th RATE_LIMITED, no 6th row, hasher not called", async () => {
    const f = authFixture();
    const s = uuid();
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) {
      if (i === 5) f.hasher.reset();
      const r = rec(await f.svc.signUp({ email: `su${i}@a10.test`, password: PASSWORD, displayName: "QA" }, { sessionKey: s }));
      if (r.ok) secrets.add(r.value.token);
      codes.push(codeOf(r));
    }
    expect(codes).toEqual(["OK", "OK", "OK", "OK", "OK", "RATE_LIMITED"]);
    expect(f.hasher.calls.hash).toBe(0);
    expect(f.db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 5 });
  }, 30_000);

  test("A-11: 101 sign-ups from 101 sessions in an hour -> 101st RATE_LIMITED (global 100/h)", async () => {
    const f = authFixture();
    let last = "";
    for (let i = 0; i < 101; i++) {
      const r = await f.svc.signUp({ email: `g${i}@a11.test`, password: PASSWORD, displayName: "QA" }, { sessionKey: uuid() });
      last = codeOf(r);
      if (i < 100) expect(last).toBe("OK");
    }
    expect(last).toBe("RATE_LIMITED");
  }, 30_000);

  test("A-12: taken email 6x from one session -> 1-5 EMAIL_TAKEN, 6th RATE_LIMITED", async () => {
    const f = authFixture();
    await addUser(f, "taken@a12.test");
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) codes.push(codeOf(await f.svc.signUp({ email: "TAKEN@a12.test", password: PASSWORD, displayName: "QA" }, { sessionKey: "11111111-1111-4111-8111-111111111111" })));
    expect(codes).toEqual(["EMAIL_TAKEN", "EMAIL_TAKEN", "EMAIL_TAKEN", "EMAIL_TAKEN", "EMAIL_TAKEN", "RATE_LIMITED"]);
  });

  test("A-15: limiter DB error fails closed: RATE_LIMITED, verifier not called, log names no email/hash", async () => {
    const f = authFixture();
    await addUser(f, "closed@a15.test");
    f.db.run("DROP TABLE rate_limits");
    const before = capture.lines.length;
    const r = await f.svc.signIn({ email: "closed@a15.test", password: PASSWORD }, { sessionKey: uuid() });
    expect(codeOf(r)).toBe("RATE_LIMITED");
    expect(f.hasher.calls.verify).toBe(0);
    const logged = capture.lines.slice(before).join("\n");
    expect(logged).not.toContain("closed@a15.test");
    expect(logged).not.toContain(sha256hex("closed@a15.test"));
  });
});

// ===========================================================================
// 3.2 Lockout
// ===========================================================================

describe("T122-1 lockout (permissive limiter isolates the lock)", () => {
  test("A-16..A-18, A-20: 9 INVALID (count 1..9) -> 10th ACCOUNT_LOCKED 900s -> correct at 14:59 locked (1s) -> after lock success", async () => {
    const f = authFixture({ limiter: "permissive" });
    await addUser(f, "lock@a16.test");
    for (let i = 1; i <= 9; i++) {
      const r = await f.svc.signIn({ email: "lock@a16.test", password: "wrong-pass-123" }, { sessionKey: uuid() });
      expect(codeOf(r)).toBe("INVALID_CREDENTIALS");
      expect(userRow(f.db, "lock@a16.test")).toMatchObject({ failed_login_count: i, locked_until: null });
    }
    const tenth = await f.svc.signIn({ email: "lock@a16.test", password: "wrong-pass-123" }, { sessionKey: uuid() });
    expect(codeOf(tenth)).toBe("ACCOUNT_LOCKED");
    expect(!tenth.ok && tenth.error.details?.retryAfterSeconds).toBe(900);
    expect(userRow(f.db, "lock@a16.test").locked_until).toBe(new Date(T0 + 15 * MIN).toISOString());

    f.clock.set(T0 + 14 * MIN + 59_000);
    const verifies = f.hasher.calls.verify;
    const during = await f.svc.signIn({ email: "lock@a16.test", password: PASSWORD }, { sessionKey: uuid() });
    expect(codeOf(during)).toBe("ACCOUNT_LOCKED");
    expect(!during.ok && during.error.details?.retryAfterSeconds).toBe(1);
    expect(f.hasher.calls.verify).toBe(verifies);
    expect(userRow(f.db, "lock@a16.test").failed_login_count).toBe(10);
    expect(f.db.query("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });

    f.clock.set(T0 + 15 * MIN + 1000);
    const okR = await f.svc.signIn({ email: "lock@a16.test", password: PASSWORD }, { sessionKey: uuid() });
    expect(okR.ok).toBe(true);
    expect(userRow(f.db, "lock@a16.test")).toMatchObject({ failed_login_count: 0, locked_until: null });
    if (okR.ok) secrets.add(okR.value.token);
  });

  test("A-19: real limiter, 10 failures at T0+890s, correct password at T0+901s (new window, lock live) -> ACCOUNT_LOCKED", async () => {
    const f = authFixture();
    await addUser(f, "edge@a19.test");
    f.clock.set(T0 + 890_000);
    for (let i = 0; i < 10; i++) await f.svc.signIn({ email: "edge@a19.test", password: "wrong-pass-123" }, { sessionKey: uuid() });
    f.clock.set(T0 + 901_000);
    const r = await f.svc.signIn({ email: "edge@a19.test", password: PASSWORD }, { sessionKey: uuid() });
    expect(codeOf(r)).toBe("ACCOUNT_LOCKED");
  });

  test("A-21: lock expired, 1 wrong password -> INVALID_CREDENTIALS, counter 1", async () => {
    const f = authFixture({ limiter: "permissive" });
    await addUser(f, "fresh@a21.test");
    for (let i = 0; i < 10; i++) await f.svc.signIn({ email: "fresh@a21.test", password: "wrong-pass-123" }, { sessionKey: uuid() });
    f.clock.set(T0 + 15 * MIN + 1);
    const r = await f.svc.signIn({ email: "fresh@a21.test", password: "wrong-pass-123" }, { sessionKey: uuid() });
    expect(codeOf(r)).toBe("INVALID_CREDENTIALS");
    expect(userRow(f.db, "fresh@a21.test").failed_login_count).toBe(1);
  });

  test("A-22: 20 concurrent wrong passwords -> all settle, counter 20, locked, no success", async () => {
    const f = authFixture({ limiter: "permissive" });
    await addUser(f, "conc@a22.test");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => f.svc.signIn({ email: "conc@a22.test", password: "wrong-pass-123" }, { sessionKey: uuid() })),
    );
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(userRow(f.db, "conc@a22.test").failed_login_count).toBe(20);
    expect(userRow(f.db, "conc@a22.test").locked_until).not.toBeNull();
  }, 30_000);

  test("A-23: 9 failures then concurrent {1 correct, 5 wrong} -> consistent final state", async () => {
    const f = authFixture({ limiter: "permissive" });
    await addUser(f, "race@a23.test");
    for (let i = 0; i < 9; i++) await f.svc.signIn({ email: "race@a23.test", password: "wrong-pass-123" }, { sessionKey: uuid() });
    const results = await Promise.all([
      f.svc.signIn({ email: "race@a23.test", password: PASSWORD }, { sessionKey: uuid() }),
      ...Array.from({ length: 5 }, () => f.svc.signIn({ email: "race@a23.test", password: "wrong-pass-123" }, { sessionKey: uuid() })),
    ]);
    const success = results[0] as Result<IssuedSession, AppError>;
    const row = userRow(f.db, "race@a23.test");
    const sessions = (f.db.query("SELECT COUNT(*) AS n FROM auth_sessions").get() as { n: number }).n;
    if (success.ok) {
      expect(sessions).toBe(1);
      expect(row.last_login_at).not.toBeNull();
      expect(row.failed_login_count).toBeLessThanOrEqual(5);
      secrets.add(success.value.token);
    } else {
      expect(codeOf(success)).toBe("ACCOUNT_LOCKED");
      expect(sessions).toBe(0);
      expect(row.last_login_at).toBeNull();
      expect(row.locked_until).not.toBeNull();
    }
  });
});

// ===========================================================================
// 3.3 Unknown vs wrong password (criterion 2, R-10)
// ===========================================================================

describe("T122-2 unknown email vs wrong password are byte-identical", () => {
  test("A-25/A-26 (service): attempts 1-9, 10 and 11 deep-equal across DB1 (user) and DB2 (none); verifier counts equal", async () => {
    const f1 = authFixture();
    const f2 = authFixture();
    await addUser(f1, "kate@x.com");
    const sessions = Array.from({ length: 11 }, () => uuid());
    for (let i = 0; i < 11; i++) {
      const r1 = rec(await f1.svc.signIn({ email: "kate@x.com", password: "wrong-pass-123" }, { sessionKey: sessions[i] as string }));
      const r2 = rec(await f2.svc.signIn({ email: "kate@x.com", password: "wrong-pass-123" }, { sessionKey: sessions[i] as string }));
      expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
      if (i < 9) expect(r1).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS", message: INVALID_MSG } });
      expect(f1.hasher.calls.verify).toBe(f2.hasher.calls.verify);
    }
    expect(f1.hasher.calls.verify).toBe(10);
  });

  test("A-27/A-28: real Bun.password -> stored $argon2id$; unknown email verifies once against a dummy with the same m/t/p; no logs", async () => {
    const calls: string[] = [];
    const spy: PasswordHasher = {
      hash: (pw) => argon2idHasher.hash(pw),
      verify: (pw, hash) => {
        calls.push(hash);
        return argon2idHasher.verify(pw, hash);
      },
    };
    const f = authFixture({ hasher: spy });
    const before = capture.lines.length;
    const su = await f.svc.signUp({ email: "real@argon.test", password: PASSWORD, displayName: "Real" }, { sessionKey: uuid() });
    expect(su.ok).toBe(true);
    if (su.ok) secrets.add(su.value.token);
    const stored = (f.db.query("SELECT password_hash FROM users").get() as { password_hash: string }).password_hash;
    secrets.add(stored);
    expect(stored.startsWith("$argon2id$v=19$")).toBe(true);
    const params = (h: string): string => h.split("$")[3] as string;

    const wrong = await f.svc.signIn({ email: "real@argon.test", password: "wrong-pass-123" }, { sessionKey: uuid() });
    const unknown = await f.svc.signIn({ email: "nobody@argon.test", password: "wrong-pass-123" }, { sessionKey: uuid() });
    expect(JSON.stringify(wrong)).toBe(JSON.stringify(unknown));
    expect(calls.length).toBe(2);
    expect(calls[1]?.startsWith("$argon2id$v=19$")).toBe(true);
    expect(params(calls[1] as string)).toBe(params(stored));
    expect(capture.lines.slice(before)).toEqual([]);
  }, 30_000);
});

// ===========================================================================
// 3.4 Tokens
// ===========================================================================

function sqlSpy(db: Database): { db: Database; log: { sql: string; args: unknown[] }[] } {
  const log: { sql: string; args: unknown[] }[] = [];
  const proxy = new Proxy(db, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop === "query" || prop === "prepare") {
        return (sql: string) => {
          const stmt = (value as (s: string) => object).call(target, sql);
          return new Proxy(stmt, {
            get(s, p) {
              const v: unknown = Reflect.get(s, p, s);
              if (typeof v !== "function") return v;
              return (...args: unknown[]) => {
                log.push({ sql, args });
                return (v as (...a: unknown[]) => unknown).apply(s, args);
              };
            },
          });
        };
      }
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy, log };
}

describe("T122-3 tokens (service level)", () => {
  test("A-41: malformed / oversized / unicode tokens resolve null with NO query; a well-formed unknown binds only the digest", () => {
    const base = makeDb(false);
    const { db, log } = sqlSpy(base);
    const svc = createAuthService({ db, hasher: fastHasher() });
    const bad = [
      "a".repeat(42),
      "a".repeat(44),
      "+".repeat(43),
      "/".repeat(43),
      "=".repeat(43),
      "é".repeat(43),
      `${"a".repeat(41)}😀`,
      `${"a".repeat(42)}\uD800`,
      `${"a".repeat(42)}‮`,
      `${"a".repeat(42)}\u0000`,
      "x".repeat(1024 * 1024),
      "",
      ` ${"a".repeat(43)} `,
      null,
      undefined,
      42,
    ];
    for (const t of bad) {
      expect(() => svc.resolveToken(t)).not.toThrow();
      expect(svc.resolveToken(t)).toBeNull();
    }
    expect(log.length).toBe(0);
    const good = "A".repeat(43);
    expect(svc.resolveToken(good)).toBeNull();
    expect(log.length).toBeGreaterThan(0);
    for (const entry of log) {
      for (const a of entry.args) {
        expect(a).not.toBe(good);
        if (typeof a === "string" && a.length === 64) expect(a).toBe(sha256hex(good));
      }
    }
  });

  test("A-42/A-43: expiry boundary is absolute; touch throttled to one UPDATE per 5 minutes and never extends expires_at", async () => {
    const f = authFixture();
    const su = await f.svc.signUp({ email: "tok@a42.test", password: PASSWORD, displayName: "T" }, { sessionKey: uuid() });
    if (!su.ok) throw new Error("signup");
    secrets.add(su.value.token);
    const expires = Date.parse(su.value.expiresAt);
    expect(expires).toBe(T0 + 30 * 24 * 60 * MIN);
    const row = (): { last_seen_at: string; expires_at: string } =>
      f.db.query("SELECT last_seen_at, expires_at FROM auth_sessions").get() as { last_seen_at: string; expires_at: string };
    expect(f.svc.resolveToken(su.value.token, T0 + 60_000)).not.toBeNull();
    expect(row().last_seen_at).toBe(new Date(T0).toISOString());
    expect(f.svc.resolveToken(su.value.token, T0 + 301_000)).not.toBeNull();
    expect(row().last_seen_at).toBe(new Date(T0 + 301_000).toISOString());
    expect(row().expires_at).toBe(su.value.expiresAt);
    expect(f.svc.resolveToken(su.value.token, expires - 1000)).not.toBeNull();
    expect(f.svc.resolveToken(su.value.token, expires)).toBeNull();
  });

  test("A-44: token format, distinct sessions per sign-in, token_hash = sha256(token), raw token stored nowhere", async () => {
    const f = authFixture();
    const su = await f.svc.signUp({ email: "fmt@a44.test", password: PASSWORD, displayName: "F" }, { sessionKey: uuid() });
    const s1 = await f.svc.signIn({ email: "fmt@a44.test", password: PASSWORD }, { sessionKey: uuid() });
    const s2 = await f.svc.signIn({ email: "fmt@a44.test", password: PASSWORD }, { sessionKey: uuid() });
    const tokens = [su, s1, s2].map((r) => (r.ok ? r.value.token : ""));
    tokens.forEach((t) => secrets.add(t));
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(3);
    const hashes = (f.db.query("SELECT token_hash FROM auth_sessions ORDER BY created_at").all() as { token_hash: string }[]).map((r) => r.token_hash);
    expect(hashes.length).toBe(3);
    for (const t of tokens) expect(hashes).toContain(sha256hex(t));
    expect(hashToken(tokens[0] as string)).toBe(sha256hex(tokens[0] as string));
    const dump = JSON.stringify(fullSnapshot(f.db));
    for (const t of tokens) expect(dump).not.toContain(t);
  });

  test("T116 AC7: a locked account's existing token still resolves (C-13 basis)", async () => {
    const f = authFixture({ limiter: "permissive" });
    const su = await f.svc.signUp({ email: "lk@ac7.test", password: PASSWORD, displayName: "L" }, { sessionKey: uuid() });
    if (!su.ok) throw new Error("signup");
    secrets.add(su.value.token);
    for (let i = 0; i < 10; i++) await f.svc.signIn({ email: "lk@ac7.test", password: "wrong-pass-123" }, { sessionKey: uuid() });
    expect(userRow(f.db, "lk@ac7.test").locked_until).not.toBeNull();
    expect(f.svc.resolveToken(su.value.token)?.user.email).toBe("lk@ac7.test");
  });

  test("A-95: public user shape never carries the password hash", async () => {
    const f = authFixture();
    const u = await addUser(f, "shape@a95.test");
    const keys = Object.keys(f.repo.findUserById(u.id) ?? {});
    expect(keys).not.toContain("passwordHash");
    expect(keys).not.toContain("password_hash");
    expect(Object.keys(f.repo.findUserByOwnerKey(u.ownerKey) ?? {})).not.toContain("passwordHash");
  });
});

// ===========================================================================
// 3.10 Input validation (A-101..A-110), amended per K-10 / A-102
// ===========================================================================

describe("T122 input validation and normalisation", () => {
  const fieldCode = (r: Result<unknown, AppError>, field: string): string | undefined =>
    r.ok ? undefined : ((r.error.details?.fields as Record<string, { code: string }> | undefined)?.[field]?.code ?? r.error.code);

  test("A-101: 254-char email accepted; 255 and 1 MiB rejected with 0 hasher calls and 0 rows, fast", async () => {
    const f = authFixture();
    const local = "q".repeat(64);
    const domain = `${"z".repeat(254 - 64 - 1 - 5)}.test`;
    const e254 = `${local}@${domain}`;
    expect(e254.length).toBe(254);
    const ok254 = await f.svc.signUp({ email: e254, password: PASSWORD, displayName: "Q" }, { sessionKey: uuid() });
    expect(ok254.ok).toBe(true);
    f.hasher.reset();
    for (const e of [`${e254}x`, "q".repeat(1024 * 1024)]) {
      const t = performance.now();
      const r = await f.svc.signUp({ email: e, password: PASSWORD, displayName: "Q" }, { sessionKey: uuid() });
      // generous bound: rejection is structural (0 hasher calls, 0 rows); timing only guards against pathological scans
      expect(performance.now() - t).toBeLessThan(2000);
      expect(fieldCode(r, "email")).toBeDefined();
      expect(codeOf(r)).toBe("VALIDATION_FAILED");
    }
    expect(f.hasher.calls.hash).toBe(0);
    expect(f.db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  test("A-102 (amended per A-102 trim ruling): malformed emails rejected; U+0020 trimmed only", async () => {
    const f = authFixture();
    const bad = ["a@b@c.com", "nouser", "kate @x.com", "kate@x.com\u0000", "kate@x.com\n", "\tkate@x.com", "kate@x.com ", "kate＠x.com", "kate​@x.com", "@x.com", "kate@", "﻿kate@x.com"];
    for (const e of bad) {
      const r = await f.svc.signUp({ email: e, password: PASSWORD, displayName: "Q" }, { sessionKey: uuid() });
      expect([e, codeOf(r), fieldCode(r, "email")]).toEqual([e, "VALIDATION_FAILED", "INVALID"]);
    }
    const spaced = await f.svc.signUp({ email: "  Spaced@X.com  ", password: PASSWORD, displayName: "Q" }, { sessionKey: uuid() });
    expect(spaced.ok).toBe(true);
    expect(spaced.ok && spaced.value.user.email).toBe("spaced@x.com");
  });

  test("A-103/A-105: normalisation; sign-in case-insensitive; EMAIL_TAKEN creates nothing; repository lower-cases too", async () => {
    const f = authFixture();
    const r = await f.svc.signUp({ email: "  Kate@Example.COM ", password: PASSWORD, displayName: "K" }, { sessionKey: uuid() });
    expect(r.ok && r.value.user.email).toBe("kate@example.com");
    expect((await f.svc.signIn({ email: "KATE@example.com", password: PASSWORD }, { sessionKey: uuid() })).ok).toBe(true);
    const users = (f.db.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const sessions = (f.db.query("SELECT COUNT(*) AS n FROM auth_sessions").get() as { n: number }).n;
    expect(codeOf(await f.svc.signUp({ email: "kate@example.com", password: PASSWORD, displayName: "K" }, { sessionKey: uuid() }))).toBe("EMAIL_TAKEN");
    expect(f.db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: users });
    expect(f.db.query("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: sessions });
    const direct = f.repo.createUser({ email: "Direct@X.com", passwordHash: "h", displayName: "D" });
    expect(direct.ok && direct.value.email).toBe("direct@x.com");
    expect(codeOf(f.repo.createUser({ email: "DIRECT@x.COM", passwordHash: "h", displayName: "D" }))).toBe("EMAIL_TAKEN");
  });

  test("A-104: Kelvin sign and NFD/NFC spellings collide (R-11)", async () => {
    const f = authFixture();
    expect((await f.svc.signUp({ email: "kate@k.test", password: PASSWORD, displayName: "K" }, { sessionKey: uuid() })).ok).toBe(true);
    expect(codeOf(await f.svc.signUp({ email: "Kate@k.test", password: PASSWORD, displayName: "K" }, { sessionKey: uuid() }))).toBe("EMAIL_TAKEN");
    expect((await f.svc.signUp({ email: "JOSÉ@k.test", password: PASSWORD, displayName: "J" }, { sessionKey: uuid() })).ok).toBe(true);
    expect(codeOf(await f.svc.signUp({ email: "JOSÉ@k.test", password: PASSWORD, displayName: "J" }, { sessionKey: uuid() }))).toBe("EMAIL_TAKEN");
  });

  test("A-106 (amended per K-10: UTF-16 units): boundaries and 0 hasher calls on rejects", async () => {
    const f = authFixture({ limiter: "permissive" });
    const astral = "\u{1F600}"; // 2 UTF-16 units
    const cases: [string, boolean][] = [
      ["k7m2v9x", false], // 7
      ["k7m2v9x4", true], // 8
      ["q".repeat(127) + "9", true], // 128
      ["q".repeat(128) + "9", false], // 129
      [astral.repeat(3) + "z", false], // 7 units
      [astral.repeat(4), true], // 8 units
      [astral.repeat(64), true], // 128 units
      [astral.repeat(64) + "z", false], // 129 units
      ["z".repeat(1024 * 1024), false],
    ];
    let i = 0;
    for (const [pw, accepted] of cases) {
      f.hasher.reset();
      const r = await f.svc.signUp({ email: `len${i++}@a106.test`, password: pw, displayName: "L" }, { sessionKey: uuid() });
      expect([pw.length, r.ok]).toEqual([pw.length, accepted]);
      if (!accepted) {
        expect(fieldCode(r, "password")).toMatch(/TOO_SHORT|TOO_LONG/);
        expect(f.hasher.calls.hash).toBe(0);
      }
    }
  });

  test("A-107: password never trimmed or altered; NFD and NFC differ", async () => {
    const f = authFixture({ limiter: "permissive" });
    await f.svc.signUp({ email: "pp@a107.test", password: " pass phrase 99 ", displayName: "P" }, { sessionKey: uuid() });
    expect(codeOf(await f.svc.signIn({ email: "pp@a107.test", password: "pass phrase 99" }, { sessionKey: uuid() }))).toBe("INVALID_CREDENTIALS");
    expect((await f.svc.signIn({ email: "pp@a107.test", password: " pass phrase 99 " }, { sessionKey: uuid() })).ok).toBe(true);
    await f.svc.signUp({ email: "nf@a107.test", password: "café-latte-99", displayName: "N" }, { sessionKey: uuid() });
    expect(codeOf(await f.svc.signIn({ email: "nf@a107.test", password: "café-latte-99" }, { sessionKey: uuid() }))).toBe("INVALID_CREDENTIALS");
  });

  test("A-108/A-109: every weak-list entry >= 8 (orig/upper/title) and the email local part are WEAK", () => {
    let checked = 0;
    for (const w of WEAK_PASSWORDS) {
      if (w.length < 8 || w.length > 128) continue;
      for (const v of [w, w.toUpperCase(), w.charAt(0).toUpperCase() + w.slice(1)]) {
        const r = validatePassword(v, {});
        expect([v, codeOf(r)]).toEqual([v, "VALIDATION_FAILED"]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(codeOf(validatePassword("kate.smith", { email: "kate.smith@x.com" }))).toBe("VALIDATION_FAILED");
    expect(codeOf(validatePassword("KATE.SMITH", { email: "kate.smith@x.com" }))).toBe("VALIDATION_FAILED");
  });

  test("A-110: display name at sign-up: empty / 51 / control-only rejected; '<script>' stored as text", async () => {
    const f = authFixture({ limiter: "permissive" });
    for (const [i, dn] of ["", "n".repeat(51), "\u0000\u0007​"].entries()) {
      const r = await f.svc.signUp({ email: `dn${i}@a110.test`, password: PASSWORD, displayName: dn }, { sessionKey: uuid() });
      expect(fieldCode(r, "displayName")).toBeDefined();
    }
    const s = await f.svc.signUp({ email: "xss@a110.test", password: PASSWORD, displayName: "<script>" }, { sessionKey: uuid() });
    expect(s.ok && s.value.user.displayName).toBe("<script>");
  });
});

// ===========================================================================
// 3.5 Merge (criterion 5)
// ===========================================================================

interface MergeFixture {
  readonly db: Database;
  readonly merge: ReturnType<typeof createMergeService>;
  readonly G: string;
  readonly KA: string;
  readonly KB: string;
  readonly H: string;
  readonly logs: string[];
}

function mergeFixture(db: Database = makeDb()): MergeFixture {
  const repo = createAuthRepository(db);
  const a = repo.createUser({ email: "a@merge.test", passwordHash: "h", displayName: "A" });
  const b = repo.createUser({ email: "b@merge.test", passwordHash: "h", displayName: "B" });
  if (!a.ok || !b.ok) throw new Error("users");
  const logs: string[] = [];
  const merge = createMergeService({ db, logger: { error: (...args: unknown[]) => logs.push(args.map(safeJson).join(" ")) } });
  return { db, merge, G: uuid(), KA: a.value.ownerKey, KB: b.value.ownerKey, H: uuid(), logs };
}

function n(db: Database, sql: string, ...params: string[]): number {
  return (db.query(sql).get(...params) as { n: number }).n;
}

function cartLine(db: Database, key: string, product: string, qty: number): void {
  db.query("INSERT OR IGNORE INTO carts (session_id) VALUES (?)").run(key);
  db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, ?)").run(key, product, qty);
}

function addList(db: Database, key: string, name: string, kind: "wishlist" | "save_for_later" = "wishlist", isDefault = 0, created = new Date(T0).toISOString()): string {
  const id = uuid();
  db.query("INSERT INTO lists (id, session_id, name, kind, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, key, name, kind, isDefault, created, created);
  return id;
}

function addItem(db: Database, listId: string, product: string, note: string | null = null, at = new Date(T0).toISOString(), priority = 0): void {
  db.query("INSERT INTO list_items (list_id, product_id, price_at_add_cents, note, added_at, priority) VALUES (?, ?, 100, ?, ?, ?)").run(listId, product, note, at, priority);
}

function addAddress(db: Database, key: string, fullName: string, line1: string, isDefault = 0, at = new Date(T0).toISOString()): string {
  const id = uuid();
  db.query(
    `INSERT INTO addresses (id, session_id, full_name, line1, city, region, postal_code, country, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Springfield', 'IL', '62701', 'US', ?, ?, ?)`,
  ).run(id, key, fullName, line1, isDefault, at, at);
  return id;
}

function addReview(db: Database, key: string, product: string, rating: number, body = "b"): string {
  const id = uuid();
  db.query("INSERT INTO reviews (id, product_id, session_id, display_name, rating, body) VALUES (?, ?, ?, 'R', ?, ?)").run(id, product, key, rating, body);
  return id;
}

const products = (db: Database, where = "stock > 0"): string[] =>
  (db.query(`SELECT id FROM products WHERE ${where} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);

function expectMergeOk(r: Result<MergeSummary, AppError>): MergeSummary {
  if (!r.ok) throw new Error(`merge failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

describe("T122-5 merge (T117)", () => {
  test("A-46/A-47: cart sum capped at stock; out-of-stock guest line dropped and reported; no qty 0; guest cart gone", () => {
    const f = mergeFixture();
    f.db.run(`UPDATE products SET stock = 4 WHERE id = '${IN_STOCK_A}'`);
    cartLine(f.db, f.G, IN_STOCK_A, 2);
    cartLine(f.db, f.G, IN_STOCK_B, 1);
    cartLine(f.db, f.G, OUT_OF_STOCK, 1);
    cartLine(f.db, f.KA, IN_STOCK_A, 3);
    const s = expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    const lines = f.db.query("SELECT product_id, quantity FROM cart_items WHERE cart_session_id = ? ORDER BY product_id").all(f.KA);
    expect(lines).toEqual([
      { product_id: IN_STOCK_A, quantity: 4 },
      { product_id: IN_STOCK_B, quantity: 1 },
    ]);
    expect(s.droppedCartLines).toEqual([{ productId: OUT_OF_STOCK, reason: "out_of_stock" }]);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM carts WHERE session_id = ?", f.G)).toBe(0);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM cart_items WHERE quantity <= 0")).toBe(0);
  });

  test("A-48: coupon/shipping: guest value used only where the user's is NULL", () => {
    const f1 = mergeFixture();
    cartLine(f1.db, f1.G, IN_STOCK_A, 1);
    f1.db.query("UPDATE carts SET coupon_code = 'WELCOME10' WHERE session_id = ?").run(f1.G);
    cartLine(f1.db, f1.KA, IN_STOCK_B, 1);
    expectMergeOk(f1.merge.mergeGuestIntoUser(f1.G, f1.KA, T0));
    expect(f1.db.query("SELECT coupon_code FROM carts WHERE session_id = ?").get(f1.KA)).toEqual({ coupon_code: "WELCOME10" });
    const f2 = mergeFixture();
    cartLine(f2.db, f2.G, IN_STOCK_A, 1);
    f2.db.query("UPDATE carts SET coupon_code = 'WELCOME10' WHERE session_id = ?").run(f2.G);
    cartLine(f2.db, f2.KA, IN_STOCK_B, 1);
    f2.db.query("UPDATE carts SET coupon_code = 'FREESHIP' WHERE session_id = ?").run(f2.KA);
    expectMergeOk(f2.merge.mergeGuestIntoUser(f2.G, f2.KA, T0));
    expect(f2.db.query("SELECT coupon_code FROM carts WHERE session_id = ?").get(f2.KA)).toEqual({ coupon_code: "FREESHIP" });
  });

  test("A-49 (amended per R-5): conflicting guest review DELETED (not left under G); user's kept; aggregates = recomputation", () => {
    const f = mergeFixture();
    const p = IN_STOCK_A;
    const userReview = addReview(f.db, f.KA, p, 5, "user body");
    addReview(f.db, f.G, p, 1, "guest body");
    addReview(f.db, f.G, IN_STOCK_B, 3, "guest other");
    const s = expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    expect(s.droppedReviews).toBe(1);
    expect(f.db.query("SELECT id, body FROM reviews WHERE session_id = ? AND product_id = ?").all(f.KA, p)).toEqual([{ id: userReview, body: "user body" }]);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM reviews WHERE session_id = ?", f.G)).toBe(0);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM reviews WHERE session_id = ? AND product_id = ?", f.KA, IN_STOCK_B)).toBe(1);
    expect(ratingMismatches(f.db)).toEqual([]);
  });

  test("A-50 (amended per R-5): both voted on review R -> 1 vote under KA, guest duplicate deleted; helpful_count = vote rows", () => {
    const f = mergeFixture();
    const r = addReview(f.db, f.KB, IN_STOCK_A, 4);
    f.db.query("INSERT INTO review_votes (review_id, session_id) VALUES (?, ?), (?, ?)").run(r, f.KA, r, f.G);
    expect(n(f.db, "SELECT helpful_count AS n FROM reviews WHERE id = ?", r)).toBe(2);
    const s = expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    expect(s.droppedVotes).toBe(1);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM review_votes WHERE review_id = ?", r)).toBe(1);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM review_votes WHERE session_id = ?", f.G)).toBe(0);
    expect(n(f.db, "SELECT helpful_count AS n FROM reviews WHERE id = ?", r)).toBe(1);
  });

  test("A-51/A-53: same product in both default lists -> 1 row with user's note/priority; 195 + 10 -> 200 and 5 reported", () => {
    const f = mergeFixture();
    const ps = products(f.db, "1=1");
    const ul = addList(f.db, f.KA, "Wish list", "wishlist", 1);
    const gl = addList(f.db, f.G, "Wish list", "wishlist", 1);
    addItem(f.db, ul, ps[0] as string, "user note", undefined, 2);
    addItem(f.db, gl, ps[0] as string, "guest note", undefined, 0);
    const s = expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    expect(f.db.query("SELECT note, priority FROM list_items WHERE list_id = ? AND product_id = ?").all(ul, ps[0] as string)).toEqual([{ note: "user note", priority: 2 }]);
    expect(s.droppedListItems).toBe(1);

    // 195 + 10 distinct (needs > 60 products: add fixture products)
    const f2 = mergeFixture();
    const ins = f2.db.query("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, 'QA', 100, 'USD', '/x.svg', 5)");
    for (let i = 0; i < 210; i++) ins.run(`qa-li-${i}`, `qa-li-${i}`);
    const ul2 = addList(f2.db, f2.KA, "Wish list", "wishlist", 1);
    const gl2 = addList(f2.db, f2.G, "Wish list", "wishlist", 1);
    for (let i = 0; i < 195; i++) addItem(f2.db, ul2, `qa-li-${i}`);
    for (let i = 195; i < 205; i++) addItem(f2.db, gl2, `qa-li-${i}`);
    const s2 = expectMergeOk(f2.merge.mergeGuestIntoUser(f2.G, f2.KA, T0));
    expect(n(f2.db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", ul2)).toBe(200);
    expect(s2.droppedListItems).toBe(5);
    expect(n(f2.db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", f2.G)).toBe(0);
  });

  test("A-52: user 19 lists + guest 3 non-default -> 20 lists, 2 dropped, no orphaned items, names unique", () => {
    const f = mergeFixture();
    const ps = products(f.db);
    addList(f.db, f.KA, "Default", "wishlist", 1);
    for (let i = 0; i < 18; i++) addList(f.db, f.KA, `User ${i}`);
    const guestLists = [0, 1, 2].map((i) => addList(f.db, f.G, `Guest ${i}`, "wishlist", 0, new Date(T0 + i * 1000).toISOString()));
    guestLists.forEach((l, i) => addItem(f.db, l, ps[i] as string));
    const s = expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    expect(n(f.db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'wishlist'", f.KA)).toBe(20);
    expect(s.droppedLists).toBe(2);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id NOT IN (SELECT id FROM lists)")).toBe(0);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", f.G)).toBe(0);
  });

  test("A-54: name dedupe ' (2)', ' (3)'; 60-char name with suffix stays <= 60 (R-4)", () => {
    const f = mergeFixture();
    addList(f.db, f.KA, "Gifts");
    addList(f.db, f.G, "Gifts", "wishlist", 0, new Date(T0 + 1).toISOString());
    addList(f.db, f.G, "Gifts (2)", "wishlist", 0, new Date(T0 + 2).toISOString());
    const long = "L".repeat(60);
    addList(f.db, f.KA, long);
    addList(f.db, f.G, long, "wishlist", 0, new Date(T0 + 3).toISOString());
    expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    const names = (f.db.query("SELECT name FROM lists WHERE session_id = ? ORDER BY name").all(f.KA) as { name: string }[]).map((r) => r.name);
    expect(names).toContain("Gifts");
    expect(names).toContain("Gifts (2)");
    expect(names).toContain("Gifts (3)");
    expect(new Set(names.map((x) => x.toLowerCase())).size).toBe(names.length);
    for (const x of names) expect([...x].length).toBeLessThanOrEqual(60);
  });

  test("A-55: both have a save_for_later list -> exactly 1 SFL for KA, items merged, guest SFL gone", () => {
    const f = mergeFixture();
    const ps = products(f.db);
    const u = addList(f.db, f.KA, "Saved", "save_for_later");
    const g = addList(f.db, f.G, "Saved", "save_for_later");
    addItem(f.db, u, ps[0] as string);
    addItem(f.db, g, ps[1] as string);
    expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    expect(n(f.db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'save_for_later'", f.KA)).toBe(1);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", u)).toBe(2);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM lists WHERE id = ?", g)).toBe(0);
  });

  test("A-56: 30 + 30 views with 5 overlapping -> exactly the newest 50 for KA (overlap keeps MAX(viewed_at))", () => {
    const f = mergeFixture();
    const ps = products(f.db, "1=1");
    const ins = f.db.query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)");
    const latest = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const t = T0 - (i * 2 + 1) * 60_000;
      ins.run(f.KA, ps[i] as string, new Date(t).toISOString());
      latest.set(ps[i] as string, Math.max(latest.get(ps[i] as string) ?? 0, t));
    }
    for (let i = 25; i < 55; i++) {
      const t = T0 - i * 2 * 60_000;
      ins.run(f.G, ps[i] as string, new Date(t).toISOString());
      latest.set(ps[i] as string, Math.max(latest.get(ps[i] as string) ?? 0, t));
    }
    expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    const rows = f.db.query("SELECT product_id, viewed_at FROM product_views WHERE session_id = ?").all(f.KA) as { product_id: string; viewed_at: string }[];
    expect(rows.length).toBe(50);
    const expected = [...latest.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50);
    expect(new Set(rows.map((r) => r.product_id))).toEqual(new Set(expected.map((e) => e[0])));
    for (const r of rows) expect(Date.parse(r.viewed_at)).toBe(latest.get(r.product_id) as number);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?", f.G)).toBe(0);
  });

  test("A-57/A-58: address dedupe (case/whitespace), cap 10, exactly one default = user's; dropped rows deleted (R-5)", () => {
    const f = mergeFixture();
    const d1 = addAddress(f.db, f.KA, "Kate Smith", "1 Main St", 1);
    for (let i = 2; i <= 8; i++) addAddress(f.db, f.KA, `User ${i}`, `${i} Main St`);
    addAddress(f.db, f.G, "  kate   SMITH ", "1 main st", 0);
    addAddress(f.db, f.G, "Guest 9", "9 Elm", 1);
    addAddress(f.db, f.G, "Guest 10", "10 Elm");
    addAddress(f.db, f.G, "Guest 11", "11 Elm");
    const s = expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    expect(n(f.db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?", f.KA)).toBe(10);
    expect(s.droppedAddresses).toBe(2);
    expect(f.db.query("SELECT id FROM addresses WHERE session_id = ? AND is_default = 1").all(f.KA)).toEqual([{ id: d1 }]);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?", f.G)).toBe(0);

    const f2 = mergeFixture();
    for (let i = 0; i < 10; i++) addAddress(f2.db, f2.KA, `U${i}`, `${i} Oak`, i === 0 ? 1 : 0);
    addAddress(f2.db, f2.G, "G1", "1 Pine", 1);
    addAddress(f2.db, f2.G, "G2", "2 Pine");
    const s2 = expectMergeOk(f2.merge.mergeGuestIntoUser(f2.G, f2.KA, T0));
    expect(n(f2.db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?", f2.KA)).toBe(10);
    expect(s2.droppedAddresses).toBe(2);
    expect(n(f2.db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?", f2.G)).toBe(0);
  });

  test("A-59/A-60 (amended per R-5): orders re-keyed with items/events row-equal; duplicate redemption deleted, used_count unchanged", () => {
    const f = mergeFixture();
    const g = seedIdentity(f.db, f.G, { tag: "g59", slot: 1 });
    seedIdentity(f.db, f.KA, { tag: "a59", slot: 2 });
    const items = f.db.query("SELECT * FROM order_items WHERE order_id = ?").all(g.orderId);
    const events = f.db.query("SELECT * FROM order_events WHERE order_id = ?").all(g.orderId);
    const order = f.db.query("SELECT * FROM orders WHERE id = ?").get(g.orderId) as Record<string, unknown>;
    const used = f.db.query("SELECT code, used_count FROM coupons ORDER BY code").all();
    const s = expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    expect(f.db.query("SELECT * FROM orders WHERE id = ?").get(g.orderId)).toEqual({ ...order, session_id: f.KA });
    expect(f.db.query("SELECT * FROM order_items WHERE order_id = ?").all(g.orderId)).toEqual(items);
    expect(f.db.query("SELECT * FROM order_events WHERE order_id = ?").all(g.orderId)).toEqual(events);
    expect(s.droppedRedemptions).toBe(1);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE session_id = ?", f.KA)).toBe(1);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE session_id = ?", f.G)).toBe(0);
    expect(f.db.query("SELECT code, used_count FROM coupons ORDER BY code").all()).toEqual(used);
  });

  test("A-61: guest 25 alerts, user 0 -> KA 20, 5 reported; user 18 + guest 5 with 1 conflict -> 20", () => {
    const f = mergeFixture();
    const ps = products(f.db, "1=1");
    const ins = f.db.query("INSERT INTO stock_alerts (id, product_id, session_id, created_at) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 25; i++) ins.run(uuid(), ps[i] as string, f.G, new Date(T0 + i * 1000).toISOString());
    const s = expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    expect(n(f.db, "SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?", f.KA)).toBe(20);
    expect(s.droppedAlerts).toBe(5);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?", f.G)).toBe(0);

    const f2 = mergeFixture();
    const ins2 = f2.db.query("INSERT INTO stock_alerts (id, product_id, session_id, created_at) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < 18; i++) ins2.run(uuid(), ps[i] as string, f2.KA, new Date(T0).toISOString());
    for (let i = 17; i < 22; i++) ins2.run(uuid(), ps[i] as string, f2.G, new Date(T0 + i).toISOString());
    const s2 = expectMergeOk(f2.merge.mergeGuestIntoUser(f2.G, f2.KA, T0));
    expect(n(f2.db, "SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?", f2.KA)).toBe(20);
    expect(s2.droppedAlerts).toBe(3);
  });

  test("D-T117-1 (fixed): merged cart line never exceeds the cart's per-line cap (DEFAULT_MAX_QUANTITY 99)", () => {
    const f = mergeFixture();
    f.db.run(`UPDATE products SET stock = 500 WHERE id = '${IN_STOCK_A}'`);
    cartLine(f.db, f.G, IN_STOCK_A, 60);
    cartLine(f.db, f.KA, IN_STOCK_A, 60);
    expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    const q = n(f.db, "SELECT quantity AS n FROM cart_items WHERE cart_session_id = ? AND product_id = ?", f.KA, IN_STOCK_A);
    expect(q).toBeLessThanOrEqual(99);
  });

  test("D-T117-2 (fixed): a guest helpful-vote on the user's own review must not become a self-vote after merge", () => {
    const f = mergeFixture();
    const own = addReview(f.db, f.KA, IN_STOCK_B, 5);
    f.db.query("INSERT INTO review_votes (review_id, session_id) VALUES (?, ?)").run(own, f.G);
    expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    const selfVotes = n(f.db, "SELECT COUNT(*) AS n FROM review_votes v JOIN reviews r ON r.id = v.review_id WHERE v.session_id = r.session_id");
    expect(selfVotes).toBe(0);
  });

  test("R-CART-1: guest cart lines for unpublished products (published_at empty or in the future) are dropped on merge", () => {
    const f = mergeFixture();
    const future = new Date(T0 + 7 * 24 * 3_600_000).toISOString();
    f.db.query("UPDATE products SET published_at = ? WHERE id = ?").run(future, IN_STOCK_A);
    f.db.query("UPDATE products SET published_at = '' WHERE id = ?").run(LOW_STOCK);
    cartLine(f.db, f.G, IN_STOCK_A, 1);
    cartLine(f.db, f.G, LOW_STOCK, 1);
    cartLine(f.db, f.G, IN_STOCK_B, 1);
    const s = expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    const lines = f.db.query("SELECT product_id FROM cart_items WHERE cart_session_id = ? ORDER BY product_id").all(f.KA);
    expect(lines).toEqual([{ product_id: IN_STOCK_B }]);
    expect(s.droppedCartLines.map((d) => d.productId).sort()).toEqual([LOW_STOCK, IN_STOCK_A].sort());
    expect(n(f.db, "SELECT COUNT(*) AS n FROM carts WHERE session_id = ?", f.G)).toBe(0);
  });

  test("A-62: atomic rollback - a failure injected on EVERY table x op leaves the full DB identical (logs carry no ids)", () => {
    const template = makeDb();
    const tables = Object.keys(fullSnapshot(template));
    let failures = 0;
    const touched = new Set<string>();
    for (const table of tables) {
      for (const op of ["INSERT", "UPDATE", "DELETE"] as const) {
        const f = mergeFixture(makeDb());
        const a = seedIdentity(f.db, f.KA, { tag: "a62", slot: 1 });
        const b = seedIdentity(f.db, f.KB, { tag: "b62", slot: 2 });
        seedIdentity(f.db, f.G, { tag: "g62", slot: 1, voteOn: { reviewId: a.reviewId } });
        seedIdentity(f.db, f.H, { tag: "h62", slot: 3, voteOn: { reviewId: b.reviewId } });
        cartLine(f.db, f.G, IN_STOCK_B, 1);
        const before = fullSnapshot(f.db);
        injectFailure(f.db, table, op);
        const r = f.merge.mergeGuestIntoUser(f.G, f.KA, T0);
        if (r.ok) continue;
        failures++;
        touched.add(table);
        expect([table, op, r.error.code, (r.error.details as { reason?: string }).reason]).toEqual([table, op, "VALIDATION_FAILED", "merge_failed"]);
        expect(fullSnapshot(f.db)).toEqual(before);
        for (const line of f.logs) {
          expect(line).not.toContain(f.G);
          expect(line).not.toContain(f.KA);
        }
      }
    }
    expect(failures).toBeGreaterThan(10);
    for (const t of ["carts", "cart_items", "lists", "list_items", "product_views", "reviews", "review_votes", "questions", "answers", "stock_alerts", "contact_messages", "addresses", "orders", "coupon_redemptions"]) {
      expect([t, touched.has(t)]).toEqual([t, true]);
    }
  }, 30_000);

  test("A-63/A-64: idempotent second merge (no row changes, zero summary); guards change nothing", () => {
    const f = mergeFixture();
    seedIdentity(f.db, f.KA, { tag: "a63", slot: 1 });
    seedIdentity(f.db, f.G, { tag: "g63", slot: 2 });
    seedIdentity(f.db, f.KB, { tag: "b63", slot: 3 });
    expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    const after1 = fullSnapshot(f.db);
    const s2 = expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0 + 1000));
    expect(fullSnapshot(f.db)).toEqual(after1);
    for (const [k, v] of Object.entries(s2)) expect([k, Array.isArray(v) ? v.length : v]).toEqual([k, 0]);

    const guards: [unknown, unknown][] = [
      [f.G, f.G],
      ["not-a-uuid", f.KA],
      [f.G, "x"],
      [f.KB, f.KA],
      [TOMBSTONE, f.KA],
      [f.G, uuid()],
      [f.G.toUpperCase(), f.KA],
    ];
    for (const [g, k] of guards) {
      const r = f.merge.mergeGuestIntoUser(g, k, T0);
      expect(codeOf(r)).toBe("VALIDATION_FAILED");
      expect(fullSnapshot(f.db)).toEqual(after1);
    }
  }, 30_000);

  test("A-65/T117 AC9: three-party - Snapshot(KB), Snapshot(H) and rate_limits identical after merge", () => {
    const f = mergeFixture();
    const a = seedIdentity(f.db, f.KA, { tag: "a65", slot: 1 });
    const b = seedIdentity(f.db, f.KB, { tag: "b65", slot: 2, voteOn: { reviewId: a.reviewId } });
    seedIdentity(f.db, f.G, { tag: "g65", slot: 3, voteOn: { reviewId: b.reviewId } });
    seedIdentity(f.db, f.H, { tag: "h65", slot: 4, voteOn: { reviewId: a.reviewId } });
    f.db.query("INSERT INTO rate_limits (key, window_start, count) VALUES ('900:x:y', 1, 3)").run();
    const sb = snapshot(f.db, f.KB);
    const sh = snapshot(f.db, f.H);
    const rl = f.db.query("SELECT * FROM rate_limits").all();
    expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0));
    const sbAfter = snapshot(f.db, f.KB);
    // B's review helpful_count includes G's vote, which moved (not deleted): unchanged.
    expect(sbAfter).toEqual(sb);
    expect(snapshot(f.db, f.H)).toEqual(sh);
    expect(f.db.query("SELECT * FROM rate_limits").all()).toEqual(rl);
    expect(zeroCounts(counts(f.db, f.G))).toBe(true);
  });

  test("A-66: 100 randomised fixtures keep invariants (seeded PRNG; seed printed on failure)", () => {
    const template = makeDb();
    const image = template.serialize();
    const baselineHelpful = helpfulMismatches(template).length;
    for (let seed = 1; seed <= 100; seed++) {
      const db = trackDb(Database.deserialize(image));
      db.run("PRAGMA foreign_keys = ON");
      const f = mergeFixture(db);
      const rnd = mulberry32(seed);
      const ri = (k: number): number => Math.floor(rnd() * k);
      const all = products(db, "1=1");
      const pick = (k: number): string[] => {
        const s = new Set<string>();
        while (s.size < k) s.add(all[ri(all.length)] as string);
        return [...s];
      };
      const seededReviews = (db.query("SELECT id FROM reviews WHERE session_id LIKE 'seed_%'").all() as { id: string }[]).map((r) => r.id);
      const at = (i: number): string => new Date(T0 - (i + 1) * 1000).toISOString();

      for (const key of [f.G, f.KA]) {
        if (key === f.KA && rnd() < 0.3) {
          /* user without a cart */
        } else
          for (const p of pick(ri(6))) {
            const stock = n(db, "SELECT stock AS n FROM products WHERE id = ?", p);
            // The user's own cart is always valid (qty <= stock); the guest's may hold OOS / over-stock lines.
            if (key === f.KA && stock === 0) continue;
            cartLine(db, key, p, key === f.KA ? Math.min(1 + ri(8), stock) : 1 + ri(8));
          }
        const wishlists = key === f.KA ? ri(21) : ri(5);
        const hasDefault = rnd() < 0.7;
        const usedNames = new Set<string>();
        for (let i = 0; i < wishlists; i++) {
          let name = rnd() < 0.4 ? `Shared ${ri(3)}` : `L${key.slice(0, 4)}${i}`;
          if (usedNames.has(name)) name = `${name} x${i}`;
          usedNames.add(name);
          const id = addList(db, key, name, "wishlist", hasDefault && i === 0 ? 1 : 0, at(i));
          for (const p of pick(ri(5))) addItem(db, id, p, rnd() < 0.5 ? `n${ri(9)}` : null, at(ri(100)));
        }
        if (rnd() < 0.5) {
          const sfl = addList(db, key, "Saved", "save_for_later");
          for (const p of pick(ri(4))) addItem(db, sfl, p);
        }
        for (const [i, p] of pick(ri(40)).entries()) db.query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)").run(key, p, at(ri(500) + i));
        for (const p of pick(ri(5))) addReview(db, key, p, 1 + ri(5));
        for (const r of new Set(Array.from({ length: ri(6) }, () => seededReviews[ri(seededReviews.length)] as string))) {
          db.query("INSERT INTO review_votes (review_id, session_id) VALUES (?, ?)").run(r, key);
        }
        for (const [i, p] of pick(key === f.KA ? ri(21) : ri(26)).entries()) {
          db.query("INSERT INTO stock_alerts (id, product_id, session_id, created_at) VALUES (?, ?, ?, ?)").run(uuid(), p, key, at(i));
        }
        const addrN = key === f.KA ? ri(11) : ri(6);
        for (let i = 0; i < addrN; i++) addAddress(db, key, rnd() < 0.3 ? "Dup Name" : `N${key.slice(0, 4)}${i}`, rnd() < 0.3 ? "1 Dup St" : `${i} St`, i === 0 ? 1 : 0, at(i));
        for (const c of ["WELCOME10", "SAVE5", "FREESHIP"]) if (rnd() < 0.4) db.query("INSERT INTO coupon_redemptions (coupon_code, session_id) VALUES (?, ?)").run(c, key);
      }
      if (rnd() < 0.5) seedOrderAndQa(db, f.G, `g${seed}`);
      if (rnd() < 0.3) seedOrderAndQa(db, f.KA, `a${seed}`);

      const cBefore = { G: counts(db, f.G), A: counts(db, f.KA) };
      const wishBefore = n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'wishlist'", f.KA);
      const aHadDefault = n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND is_default = 1", f.KA) > 0;
      const gHadDefault = n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND is_default = 1", f.G) > 0;
      const aHadAddrDefault = n(db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?", f.KA) > 0;
      const viewUnion = n(db, "SELECT COUNT(DISTINCT product_id) AS n FROM product_views WHERE session_id IN (?, ?)", f.G, f.KA);
      const ctx = `seed=${seed}`;

      const r = f.merge.mergeGuestIntoUser(f.G, f.KA, T0);
      expect([ctx, r.ok]).toEqual([ctx, true]);
      if (!r.ok) continue;
      const s = r.value;
      const cAfter = counts(db, f.KA) as Record<string, number> & { review_votes: number; question_votes: number; answer_votes: number; addresses: number; stock_alerts: number; product_views: number };

      // (b) nothing left under G; every guest row moved or reported as dropped
      expect([ctx, zeroCounts(counts(db, f.G))]).toEqual([ctx, true]);
      const exact = (t: string, dropped: number): void => {
        expect([ctx, t, cAfter[t]]).toEqual([ctx, t, (cBefore.A[t] as number) + (cBefore.G[t] as number) - dropped]);
      };
      exact("reviews", s.droppedReviews);
      exact("questions", 0);
      exact("answers", 0);
      exact("orders", 0);
      exact("contact_messages", 0);
      exact("coupon_redemptions", s.droppedRedemptions);
      exact("stock_alerts", s.droppedAlerts);
      exact("addresses", s.droppedAddresses);
      exact("list_items", s.droppedListItems);
      expect([ctx, cAfter.review_votes + cAfter.question_votes + cAfter.answer_votes]).toEqual([
        ctx,
        (cBefore.A.review_votes as number) + (cBefore.G.review_votes as number) + (cBefore.A.question_votes as number) + (cBefore.G.question_votes as number) + (cBefore.A.answer_votes as number) + (cBefore.G.answer_votes as number) - s.droppedVotes,
      ]);
      expect([ctx, cAfter.product_views]).toEqual([ctx, Math.min(50, viewUnion)]);
      // (c) cart qty <= stock, > 0
      expect([ctx, n(db, "SELECT COUNT(*) AS n FROM cart_items c JOIN products p ON p.id = c.product_id WHERE c.cart_session_id = ? AND (c.quantity > p.stock OR c.quantity <= 0)", f.KA)]).toEqual([ctx, 0]);
      // (d) caps
      expect([ctx, n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'wishlist'", f.KA) <= Math.max(20, wishBefore)]).toEqual([ctx, true]);
      expect([ctx, n(db, "SELECT COUNT(*) AS n FROM (SELECT list_id FROM list_items GROUP BY list_id HAVING COUNT(*) > 200)")]).toEqual([ctx, 0]);
      expect([ctx, cAfter.addresses <= 10, cAfter.stock_alerts <= 20, cAfter.product_views <= 50]).toEqual([ctx, true, true, true]);
      expect([ctx, n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'save_for_later'", f.KA) <= 1]).toEqual([ctx, true]);
      const defaults = n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'wishlist' AND is_default = 1", f.KA);
      expect([ctx, defaults <= 1]).toEqual([ctx, true]);
      if (aHadDefault || (gHadDefault && wishBefore < 20)) expect([ctx, "default wishlist", defaults]).toEqual([ctx, "default wishlist", 1]);
      if (cAfter.addresses > 0) expect([ctx, "default address", n(db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ? AND is_default = 1", f.KA)]).toEqual([ctx, "default address", 1]);
      void aHadAddrDefault;
      // names unique
      expect([ctx, n(db, "SELECT COUNT(*) AS n FROM (SELECT lower(name) FROM lists WHERE session_id = ? GROUP BY lower(name) HAVING COUNT(*) > 1)", f.KA)]).toEqual([ctx, 0]);
      // (e) aggregates exact
      expect([ctx, ratingMismatches(db)]).toEqual([ctx, []]);
      expect([ctx, helpfulMismatches(db).length]).toEqual([ctx, baselineHelpful]);
      // (f) second merge is a no-op
      const snap = fullSnapshot(db);
      expectMergeOk(f.merge.mergeGuestIntoUser(f.G, f.KA, T0 + 5000));
      expect([ctx, fullSnapshot(db)]).toEqual([ctx, snap]);
      db.close();
    }
  }, 120_000);
});

// ===========================================================================
// 3.6 Account lifecycle and deletion (criterion 6)
// ===========================================================================

interface AccountFixture {
  readonly db: Database;
  readonly auth: AuthService;
  readonly account: AccountService;
  readonly hasher: FastHasher;
  readonly clock: TestClock;
  readonly A: { id: string; key: string; token: string; email: string };
  readonly B: { id: string; key: string; token: string };
  readonly H: string;
  readonly rows: { a: ReturnType<typeof seedIdentity>; b: ReturnType<typeof seedIdentity>; h: ReturnType<typeof seedIdentity> };
}

async function accountFixture(): Promise<AccountFixture> {
  const db = makeDb();
  harvestDbs.push(db);
  const clock = testClock();
  const hasher = fastHasher();
  const auth = createAuthService({ db, hasher, now: clock.now, limiter: permissive });
  const repo = createAuthRepository(db);
  const account = createAccountService({
    db,
    verifyPassword: (u, p, now) => auth.verifyPassword(u, p, now),
    hashPassword: (p) => hasher.hash(p),
    validatePassword,
    revokeOthers: (u, k, now) => repo.revokeOthers(u, k, now),
    now: clock.now,
    logger: { error: (...a: unknown[]) => console.error(...a), warn: (...a: unknown[]) => console.warn(...a) },
  });
  const sa = await auth.signUp({ email: "a@life.test", password: PASSWORD, displayName: "Alice" }, { sessionKey: uuid() });
  const sb = await auth.signUp({ email: "b@life.test", password: PASSWORD_B, displayName: "Bob" }, { sessionKey: uuid() });
  if (!sa.ok || !sb.ok) throw new Error("users");
  secrets.add(sa.value.token, sb.value.token);
  const A = { id: sa.value.user.id, key: sa.value.user.ownerKey, token: sa.value.token, email: "a@life.test" };
  const B = { id: sb.value.user.id, key: sb.value.user.ownerKey, token: sb.value.token };
  const H = uuid();
  const b = seedIdentity(db, B.key, { tag: "qbob", slot: 2 });
  const a = seedIdentity(db, A.key, { tag: "qals", slot: 1, voteOn: { reviewId: b.reviewId, questionId: b.questionId, answerId: b.answerId } });
  const h = seedIdentity(db, H, { tag: "qhub", slot: 3, voteOn: { reviewId: b.reviewId } });
  // B answers A's question and votes on A's review (cascade target).
  db.query("INSERT INTO answers (id, question_id, session_id, display_name, body) VALUES (?, ?, ?, 'Bob', 'B answers A')").run(uuid(), a.questionId, B.key);
  db.query("INSERT INTO review_votes (review_id, session_id) VALUES (?, ?)").run(a.reviewId, B.key);
  return { db, auth, account, hasher, clock, A, B, H, rows: { a, b, h } };
}

function tableTotals(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of Object.keys(fullSnapshot(db))) out[t] = n(db, `SELECT COUNT(*) AS n FROM ${t}`);
  return out;
}

describe("T122-6 deletion and anonymisation (T118)", () => {
  test("A-70: wrong password -> INVALID_CREDENTIALS, nothing deleted (only failed_login_count/updated_at change)", async () => {
    const f = await accountFixture();
    const before = fullSnapshot(f.db, ["users"]);
    const userBefore = f.db.query("SELECT * FROM users WHERE id = ?").get(f.A.id) as Record<string, unknown>;
    const r = rec(await f.account.deleteAccount(f.A.id, "Wr0ng-pass-qa!"));
    expect(codeOf(r)).toBe("INVALID_CREDENTIALS");
    expect(fullSnapshot(f.db, ["users"])).toEqual(before);
    const userAfter = f.db.query("SELECT * FROM users WHERE id = ?").get(f.A.id) as Record<string, unknown>;
    expect({ ...userAfter, failed_login_count: 0, updated_at: "" }).toEqual({ ...userBefore, failed_login_count: 0, updated_at: "" });
    expect(userAfter.failed_login_count).toBe((userBefore.failed_login_count as number) + 1);
  });

  test("A-71/A-73/A-74 + criterion 6: exact per-table row deltas, order PII markers, tombstone re-key, Q&A anonymised, aggregates recomputed", async () => {
    const f = await accountFixture();
    const discovered = discoverOwnerTables(f.db);
    expect(discovered.sort()).toEqual(Object.keys(OWNER_TABLES).sort());
    const totals = tableTotals(f.db);
    const order = f.db.query("SELECT * FROM orders WHERE id = ?").get(f.rows.a.orderId) as Record<string, unknown>;
    const items = f.db.query("SELECT * FROM order_items WHERE order_id = ?").all(f.rows.a.orderId);
    const events = f.db.query("SELECT * FROM order_events WHERE order_id = ?").all(f.rows.a.orderId);
    const product = f.db.query("SELECT rating_count, rating_sum FROM products WHERE id = ?").get(f.rows.a.reviewProduct) as { rating_count: number; rating_sum: number };
    const bReviewHelpful = n(f.db, "SELECT helpful_count AS n FROM reviews WHERE id = ?", f.rows.b.reviewId);
    const bQuestionHelpful = n(f.db, "SELECT helpful_count AS n FROM questions WHERE id = ?", f.rows.b.questionId);
    const sb = snapshot(f.db, f.B.key);
    const sh = snapshot(f.db, f.H);
    const used = f.db.query("SELECT code, used_count FROM coupons").all();
    const authSessionsA = n(f.db, "SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?", f.A.id);

    const r = rec(await f.account.deleteAccount(f.A.id, PASSWORD));
    expect(r.ok).toBe(true);

    // Every discovered owner-keyed table: zero rows under KA (orders included, R-1).
    for (const t of discovered) {
      const col = t === "cart_items" ? "cart_session_id" : "session_id";
      expect([t, n(f.db, `SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`, f.A.key)]).toEqual([t, 0]);
    }
    // Exact deltas per table.
    const after = tableTotals(f.db);
    const delta: Record<string, number> = {};
    for (const t of Object.keys(totals)) delta[t] = (after[t] as number) - (totals[t] as number);
    expect(delta).toMatchObject({
      carts: -1,
      cart_items: -1,
      lists: -2,
      list_items: -2,
      product_views: -1,
      reviews: -1,
      review_votes: -2, // A's vote on B's review + B's vote on A's review (cascade)
      questions: 0,
      answers: 0,
      question_votes: -1,
      answer_votes: -1,
      stock_alerts: -1,
      contact_messages: -1,
      addresses: -1,
      orders: 0,
      order_items: 0,
      order_events: 0,
      coupon_redemptions: 0,
      users: -1,
      auth_sessions: -authSessionsA,
      rate_limits: 0,
    });
    // Orders: markers, NULLs, amounts kept, tombstone.
    const o = f.db.query("SELECT * FROM orders WHERE id = ?").get(f.rows.a.orderId) as Record<string, unknown>;
    expect(o).toEqual({
      ...order,
      session_id: TOMBSTONE,
      full_name: "[deleted]",
      email: "[deleted]",
      line1: "[deleted]",
      city: "[deleted]",
      region: "[deleted]",
      postal_code: "[deleted]",
      country: "[deleted]",
      line2: null,
      phone: null,
      delivery_note: null,
    });
    expect(f.db.query("SELECT * FROM order_items WHERE order_id = ?").all(f.rows.a.orderId)).toEqual(items);
    expect(f.db.query("SELECT * FROM order_events WHERE order_id = ?").all(f.rows.a.orderId)).toEqual(events);
    // coupon_redemptions re-keyed to the tombstone with its order.
    expect(f.db.query("SELECT session_id, order_id FROM coupon_redemptions WHERE order_id = ?").all(f.rows.a.orderId)).toEqual([{ session_id: TOMBSTONE, order_id: f.rows.a.orderId }]);
    expect(f.db.query("SELECT code, used_count FROM coupons").all()).toEqual(used);
    // Q&A anonymised (R-7); B's answer on A's question survives.
    expect(f.db.query("SELECT session_id, display_name, body, status FROM questions WHERE id = ?").get(f.rows.a.questionId)).toEqual({ session_id: TOMBSTONE, display_name: "[deleted]", body: "[deleted]", status: "published" });
    expect(f.db.query("SELECT session_id, display_name, body FROM answers WHERE id = ?").get(f.rows.a.answerId)).toEqual({ session_id: TOMBSTONE, display_name: "[deleted]", body: "[deleted]" });
    expect(n(f.db, "SELECT COUNT(*) AS n FROM answers WHERE question_id = ? AND body = 'B answers A'", f.rows.a.questionId)).toBe(1);
    // Reviews deleted, aggregates recomputed, helpful decremented on B's review and question.
    const pAfter = f.db.query("SELECT rating_count, rating_sum FROM products WHERE id = ?").get(f.rows.a.reviewProduct) as { rating_count: number; rating_sum: number };
    expect(pAfter).toEqual({ rating_count: product.rating_count - 1, rating_sum: product.rating_sum - 4 });
    expect(ratingMismatches(f.db)).toEqual([]);
    expect(n(f.db, "SELECT helpful_count AS n FROM reviews WHERE id = ?", f.rows.b.reviewId)).toBe(bReviewHelpful - 1);
    expect(n(f.db, "SELECT helpful_count AS n FROM questions WHERE id = ?", f.rows.b.questionId)).toBe(bQuestionHelpful - 1);
    // Bystanders: H identical; B identical except B's vote on A's (deleted) review and the helpful decrements above.
    expect(snapshot(f.db, f.H)).toEqual(sh);
    const sbAfter = snapshot(f.db, f.B.key);
    expect(sbAfter.review_votes).toEqual((sb.review_votes as { review_id: string }[]).filter((v) => v.review_id !== f.rows.a.reviewId));
    for (const t of ["carts", "cart_items", "lists", "list_items", "orders", "addresses", "stock_alerts", "contact_messages", "coupon_redemptions", "product_views"]) {
      expect([t, sbAfter[t]]).toEqual([t, sb[t]]);
    }
    expect(f.db.query("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ?").get(f.B.id)).toEqual({ n: 1 });
    expect(f.db.query("SELECT COUNT(*) AS n FROM users WHERE id = ? OR email = ?").get(f.A.id, f.A.email)).toEqual({ n: 0 });
    // A-75: old token resolves to nothing.
    expect(f.auth.resolveToken(f.A.token)).toBeNull();
    expect(f.auth.resolveToken(f.B.token)?.user.id).toBe(f.B.id);
  }, 30_000);

  test("A-71b: a second deleted account with the same coupon -> its redemption is deleted (tombstone holds one per code)", async () => {
    const f = await accountFixture();
    expect((await f.account.deleteAccount(f.A.id, PASSWORD)).ok).toBe(true);
    expect((await f.account.deleteAccount(f.B.id, PASSWORD_B)).ok).toBe(true);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE session_id = ?", TOMBSTONE)).toBe(1);
    expect(n(f.db, "SELECT COUNT(*) AS n FROM orders WHERE session_id = ?", TOMBSTONE)).toBe(2);
  });

  test("A-72: injected failure on each table x op -> full rollback, user still exists", async () => {
    const tables = Object.keys(fullSnapshot(makeDb()));
    let failures = 0;
    for (const table of tables) {
      for (const op of ["INSERT", "UPDATE", "DELETE"] as const) {
        const f = await accountFixture();
        const before = fullSnapshot(f.db);
        injectFailure(f.db, table, op);
        let threw = false;
        try {
          const r = await f.account.deleteAccount(f.A.id, PASSWORD);
          if (r.ok) continue;
        } catch (e) {
          threw = true;
          expect(secrets.find(`${String(e)} ${(e as Error).stack ?? ""}`)).toEqual([]);
        }
        if (!threw) continue;
        failures++;
        // failed_login_count is untouched by a correct password; snapshot must be identical.
        expect([table, op, fullSnapshot(f.db)]).toEqual([table, op, before]);
      }
    }
    expect(failures).toBeGreaterThan(8);
  }, 30_000);

  test("A-76: re-sign-up with the same email (different case) -> new id, new owner key, no old data, old orders unreachable", async () => {
    const f = await accountFixture();
    expect((await f.account.deleteAccount(f.A.id, PASSWORD)).ok).toBe(true);
    const re = rec(await f.auth.signUp({ email: "A@Life.TEST", password: PASSWORD, displayName: "Alice 2" }, { sessionKey: uuid() }));
    if (!re.ok) throw new Error("re-signup");
    secrets.add(re.value.token);
    expect(re.value.user.id).not.toBe(f.A.id);
    expect(re.value.user.ownerKey).not.toBe(f.A.key);
    expect(re.value.user.ownerKey).not.toBe(TOMBSTONE);
    expect(zeroCounts(counts(f.db, re.value.user.ownerKey))).toBe(true);
  });

  test("A-77/A-78: changePassword - same/weak/short new -> newPassword VALIDATION_FAILED; wrong current counts; success revokes others only", async () => {
    const f = await accountFixture();
    const s2 = await f.auth.signIn({ email: f.A.email, password: PASSWORD }, { sessionKey: uuid() });
    if (!s2.ok) throw new Error("second session");
    secrets.add(s2.value.token);
    const keep = f.auth.resolveToken(f.A.token)?.authSessionId as string;
    const field = (r: Result<unknown, AppError>): string[] => (r.ok ? [] : Object.keys((r.error.details?.fields as object) ?? {}));
    for (const np of [PASSWORD, "password", "Sh0rt!7"]) {
      const r = rec(await f.account.changePassword(f.A.id, PASSWORD, np, keep));
      expect([np, codeOf(r), field(r)]).toEqual([np, "VALIDATION_FAILED", ["newPassword"]]);
    }
    const before = userRow(f.db, f.A.email).failed_login_count;
    const wrong = rec(await f.account.changePassword(f.A.id, "Wr0ng-pass-qa!", "N3w-Passw0rd-qa", keep));
    expect([codeOf(wrong), field(wrong)]).toEqual(["INVALID_CREDENTIALS", ["currentPassword"]]);
    expect(userRow(f.db, f.A.email).failed_login_count).toBe(before + 1);
    const oldHash = (f.db.query("SELECT password_hash AS h FROM users WHERE id = ?").get(f.A.id) as { h: string }).h;
    const okR = rec(await f.account.changePassword(f.A.id, PASSWORD, "N3w-Passw0rd-qa", keep));
    expect(okR.ok).toBe(true);
    const newHash = (f.db.query("SELECT password_hash AS h FROM users WHERE id = ?").get(f.A.id) as { h: string }).h;
    expect(newHash).not.toBe(oldHash);
    expect(f.auth.resolveToken(f.A.token)?.user.id).toBe(f.A.id);
    expect(f.auth.resolveToken(s2.value.token)).toBeNull();
    expect(f.auth.resolveToken(f.B.token)?.user.id).toBe(f.B.id);
    expect(codeOf(await f.auth.signIn({ email: f.A.email, password: PASSWORD }, { sessionKey: uuid() }))).toBe("INVALID_CREDENTIALS");
    const s3 = await f.auth.signIn({ email: f.A.email, password: "N3w-Passw0rd-qa" }, { sessionKey: uuid() });
    expect(s3.ok).toBe(true);
    if (s3.ok) secrets.add(s3.value.token);
  });

  test("A-79 (amended per K-10: UTF-16 units): display name rules; review snapshots unchanged", async () => {
    const f = await accountFixture();
    const astral = "\u{1F600}";
    for (const v of ["", "   ", "n".repeat(51), astral.repeat(26)]) {
      const r = await f.account.updateDisplayName(f.A.id, v);
      expect([v.length, codeOf(r)]).toEqual([v.length, "VALIDATION_FAILED"]);
    }
    expect((await f.account.updateDisplayName(f.A.id, astral.repeat(25))).ok).toBe(true);
    const hostile = await f.account.updateDisplayName(f.A.id, "<img src=x onerror=alert(1)>");
    expect(hostile.ok && hostile.value.displayName).toBe("<img src=x onerror=alert(1)>");
    expect(f.db.query("SELECT display_name FROM reviews WHERE id = ?").get(f.rows.a.reviewId)).toEqual({ display_name: "Name qals" });
  });
});

// ===========================================================================
// 3.8 Secret leakage (criterion 7, service part) - runs last
// ===========================================================================

describe("T122-7 secret leakage (services)", () => {
  test("A-88/A-89/A-90: console output, every returned Result and thrown error carry no password, hash, token or token hash", () => {
    for (const db of harvestDbs) {
      try {
        secrets.harvest(db);
      } catch {
        /* db closed or dropped table */
      }
    }
    expect(secrets.secrets.size).toBeGreaterThan(20);
    const logs = capture.lines.join("\n");
    expect(secrets.find(logs, true)).toEqual([]);
    for (const r of allResults) {
      const s = JSON.stringify(r);
      // IssuedSession legitimately carries the raw token (the one value for sf_auth) and the User (ownerKey) server-side.
      const scrubbed = s.replace(/"token":"[A-Za-z0-9_-]{43}"/g, '"token":"_"').replace(/"ownerKey":"[0-9a-f-]{36}"/g, '"ownerKey":"_"');
      expect(secrets.find(scrubbed)).toEqual([]);
    }
  }, 30_000);

  test("A-90: forced errors (closed DB) do not leak", async () => {
    const db = trackDb(createDatabase(":memory:"));
    const svc = createAuthService({ db, hasher: fastHasher() });
    db.close();
    for (const call of [
      () => svc.signIn({ email: "x@closed.test", password: PASSWORD }, { sessionKey: uuid() }),
      () => svc.signUp({ email: "x@closed.test", password: PASSWORD, displayName: "x" }, { sessionKey: uuid() }),
    ]) {
      try {
        const r = await call();
        expect(secrets.find(JSON.stringify(r))).toEqual([]);
      } catch (e) {
        expect(secrets.find(`${String(e)} ${(e as Error).stack ?? ""}`)).toEqual([]);
      }
    }
  });
});

beforeAll(() => {
  // keep the template DB creation out of timed tests
  makeDb();
});
