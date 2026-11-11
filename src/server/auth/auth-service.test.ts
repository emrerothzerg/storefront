import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ok, type AppError, type Result } from "@/lib/result";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import type { RateLimiter } from "@/server/security/rate-limiter";
import {
  AUTH_SESSION_TTL_MS,
  AUTH_TOKEN_BYTES,
  createAuthService,
  generateToken,
  getAuthService,
  hashToken,
  INVALID_CREDENTIALS_MESSAGE,
  PURGE_EVERY_SIGNINS,
  TOUCH_INTERVAL_MS,
  type AuthService,
  type IssuedSession,
} from "./auth-service";
import { argon2idHasher, emailLimiterKey, type PasswordHasher } from "./password-policy";

/** Aligned to 900 s and 3600 s (PLAN conventions), so limiter windows start at T0. */
const T0 = 1_800_000_000_000;
const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
const PW = "Tr0ub4dor&3-qa";
const WRONG = "wrong-pass-123";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeHasher extends PasswordHasher {
  readonly hashCalls: string[];
  /** Hash argument of every verify call (never the password). */
  readonly verifyHashes: string[];
}

/** Fast salted fake: `fake$<salt>$<sha256(salt:pw)>`. Anything else (the argon2 dummy) never verifies. */
function fakeHasher(options: { delayMs?: (matched: boolean) => number } = {}): FakeHasher {
  const hashCalls: string[] = [];
  const verifyHashes: string[] = [];
  let salt = 0;
  const digest = (s: string, pw: string) => createHash("sha256").update(`${s}:${pw}`).digest("hex");
  return {
    hashCalls,
    verifyHashes,
    async hash(password) {
      hashCalls.push("call");
      salt++;
      return `fake$${salt}$${digest(String(salt), password)}`;
    },
    async verify(password, hash) {
      verifyHashes.push(hash);
      const parts = hash.split("$");
      const matched = parts.length === 3 && parts[0] === "fake" && parts[2] === digest(parts[1] ?? "", password);
      const delay = options.delayMs?.(matched) ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return matched;
    },
  };
}

const permissiveLimiter: RateLimiter = { check: () => ok({ remaining: 1_000_000 }) };

interface Setup {
  db: Database;
  svc: AuthService;
  hasher: FakeHasher;
  clock: { now: number };
}

function setup(options: { limiter?: RateLimiter; hasher?: FakeHasher; db?: Database } = {}): Setup {
  const db = options.db ?? createDatabase(":memory:");
  if (options.db === undefined) runMigrations(db);
  const hasher = options.hasher ?? fakeHasher();
  const clock = { now: T0 };
  const svc = createAuthService({ db, hasher, limiter: options.limiter, now: () => clock.now });
  return { db, svc, hasher, clock };
}

const sid = (): string => globalThis.crypto.randomUUID();

async function mustSignUp(svc: AuthService, email: string, password = PW, now?: number): Promise<IssuedSession> {
  const result = await svc.signUp({ email, password, displayName: "Kate" }, { sessionKey: sid(), now });
  if (!result.ok) throw new Error(`signUp failed: ${result.error.code}`);
  return result.value;
}

function code(result: Result<unknown, AppError>): string {
  return result.ok ? "OK" : result.error.code;
}

function fieldCode(result: Result<unknown, AppError>, field: string): string | null {
  if (result.ok) return null;
  const fields = result.error.details?.fields as Record<string, { code: string }> | undefined;
  return fields?.[field]?.code ?? null;
}

function userRow(db: Database, email: string) {
  return db
    .query<
      { id: string; failed_login_count: number; locked_until: string | null; last_login_at: string | null; password_hash: string },
      [string]
    >("SELECT id, failed_login_count, locked_until, last_login_at, password_hash FROM users WHERE email = ?")
    .get(email);
}

function count(db: Database, table: "users" | "auth_sessions" | "rate_limits"): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
}

/** Wraps a Database so every `query`/`prepare` SQL string is recorded (and optionally sabotaged). */
function spyDb(db: Database, fault?: (sql: string) => boolean): { db: Database; sql: string[] } {
  const sql: string[] = [];
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "query" || prop === "prepare") {
        return (text: string) => {
          sql.push(text);
          if (fault?.(text)) throw new Error("injected database failure");
          return target.query(text);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: proxy, sql };
}

// ---------------------------------------------------------------------------
// Console capture (AR1): every line written by any test in this file.
// ---------------------------------------------------------------------------

const consoleLines: string[] = [];
const secrets = new Set<string>();
const spies: Mock<(...args: unknown[]) => void>[] = [];

beforeEach(() => {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(args.map(String).join(" "));
      }),
    );
  }
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

/** Records the raw token, its hash, and every stored password hash as secrets. */
function remember(db: Database, ...tokens: string[]): void {
  for (const t of tokens) {
    secrets.add(t);
    secrets.add(hashToken(t));
  }
  for (const row of db.query<{ password_hash: string }, []>("SELECT password_hash FROM users").all()) {
    secrets.add(row.password_hash);
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

describe("tokens", () => {
  test("generateToken: 32 random bytes as 43-char base64url, unique", () => {
    expect(AUTH_TOKEN_BYTES).toBe(32);
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const token = generateToken();
      expect(token).toMatch(TOKEN_RE);
      expect(Buffer.from(token, "base64url").length).toBe(32);
      seen.add(token);
    }
    expect(seen.size).toBe(1000);
  });

  test("hashToken is lower-case SHA-256 hex", () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------

describe("signUp", () => {
  test("creates the user and a session; stores only the token hash (criteria 1, 2)", async () => {
    const { db, svc } = setup();
    const result = await svc.signUp(
      { email: "  Kate@Example.COM ", password: PW, displayName: " Kate  S " },
      { sessionKey: sid(), userAgent: "UA/1" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { user, token, authSessionId, expiresAt } = result.value;
    remember(db, token);
    expect(user).toMatchObject({ email: "kate@example.com", displayName: "Kate S", lastLoginAt: new Date(T0).toISOString() });
    expect(token).toMatch(TOKEN_RE);
    expect(expiresAt).toBe(new Date(T0 + AUTH_SESSION_TTL_MS).toISOString());
    const row = db
      .query<{ id: string; token_hash: string; user_agent: string | null; user_id: string }, []>(
        "SELECT id, token_hash, user_agent, user_id FROM auth_sessions",
      )
      .get();
    expect(row).toEqual({ id: authSessionId, token_hash: hashToken(token), user_agent: "UA/1", user_id: user.id });
    const stored = userRow(db, "kate@example.com");
    expect(stored?.password_hash).not.toBe(PW);
    expect(stored?.password_hash.startsWith("fake$")).toBe(true);
    // No column of any auth table holds the raw token.
    const dump = JSON.stringify([
      db.query("SELECT * FROM users").all(),
      db.query("SELECT * FROM auth_sessions").all(),
      db.query("SELECT * FROM rate_limits").all(),
    ]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(PW);
  });

  test("validation: per-field errors, no hashing, no rows (criterion 1, A-101/A-110)", async () => {
    const { db, svc, hasher } = setup();
    const ctx = { sessionKey: sid() };
    const base = { email: "kate@x.com", password: PW, displayName: "Kate" };
    expect(fieldCode(await svc.signUp({ ...base, password: "Abc!234" }, ctx), "password")).toBe("TOO_SHORT");
    expect(fieldCode(await svc.signUp({ ...base, password: "A".repeat(129) }, ctx), "password")).toBe("TOO_LONG");
    expect(fieldCode(await svc.signUp({ ...base, password: "PassW0rd" }, ctx), "password")).toBe("WEAK");
    expect(fieldCode(await svc.signUp({ ...base, password: "KATE@X.COM" }, ctx), "password")).toBe("WEAK");
    expect(fieldCode(await svc.signUp({ ...base, email: "kate@x@y" }, ctx), "email")).toBe("INVALID");
    expect(fieldCode(await svc.signUp({ ...base, email: `${"a".repeat(1024 * 1024)}@x.com` }, ctx), "email")).toBe("TOO_LONG");
    expect(fieldCode(await svc.signUp({ ...base, displayName: "" }, ctx), "displayName")).toBe("REQUIRED");
    const all = await svc.signUp({ email: "nope", password: "short", displayName: "x".repeat(51) }, ctx);
    expect(all.ok ? null : all.error).toEqual({
      code: "VALIDATION_FAILED",
      message: "Some fields are invalid.",
      details: {
        fields: {
          email: { code: "INVALID", message: "Enter a valid email address." },
          password: { code: "TOO_SHORT", message: "Password must be at least 8 characters." },
          displayName: { code: "TOO_LONG", message: "Display name must be at most 50 characters." },
        },
      },
    });
    expect(hasher.hashCalls.length).toBe(0);
    expect(count(db, "users")).toBe(0);
    // Validation failures do not consume the sign-up limit.
    expect(count(db, "rate_limits")).toBe(0);
  });

  test("duplicate email in any case: EMAIL_TAKEN, creates nothing, no hashing (A-103)", async () => {
    const { db, svc, hasher } = setup();
    await mustSignUp(svc, "  Kate@Example.COM ");
    const dup = await svc.signUp({ email: "kate@example.com", password: PW, displayName: "K" }, { sessionKey: sid() });
    expect(dup.ok ? null : dup.error).toEqual({ code: "EMAIL_TAKEN", message: "An account with this email already exists." });
    expect(code(await svc.signUp({ email: "KATE@EXAMPLE.COM", password: PW, displayName: "K" }, { sessionKey: sid() }))).toBe(
      "EMAIL_TAKEN",
    );
    expect(hasher.hashCalls.length).toBe(1);
    expect(count(db, "users")).toBe(1);
    expect(count(db, "auth_sessions")).toBe(1);
    // Kelvin sign + NFD variants collide with their NFC lower-case form.
    await mustSignUp(svc, "JOSÉ@x.com");
    expect(code(await svc.signUp({ email: "JOSÉ@x.com", password: PW, displayName: "J" }, { sessionKey: sid() }))).toBe(
      "EMAIL_TAKEN",
    );
    await mustSignUp(svc, "kate@x.com");
    expect(code(await svc.signUp({ email: "Kate@x.com", password: PW, displayName: "K" }, { sessionKey: sid() }))).toBe(
      "EMAIL_TAKEN",
    );
  });

  test("rate limit 5/hour per session, checked before hashing; EMAIL_TAKEN counts (A-10, A-12)", async () => {
    const { db, svc, hasher } = setup();
    const sessionKey = sid();
    for (let i = 1; i <= 5; i++) {
      expect(code(await svc.signUp({ email: `u${i}@x.com`, password: PW, displayName: "U" }, { sessionKey }))).toBe("OK");
    }
    const sixth = await svc.signUp({ email: "u6@x.com", password: PW, displayName: "U" }, { sessionKey });
    expect(code(sixth)).toBe("RATE_LIMITED");
    expect(sixth.ok ? 0 : sixth.error.details?.retryAfterSeconds).toBe(3600);
    expect(hasher.hashCalls.length).toBe(5);
    expect(count(db, "users")).toBe(5);

    const enumerator = sid();
    for (let i = 1; i <= 5; i++) {
      expect(code(await svc.signUp({ email: "u1@x.com", password: PW, displayName: "U" }, { sessionKey: enumerator }))).toBe(
        "EMAIL_TAKEN",
      );
    }
    expect(code(await svc.signUp({ email: "u1@x.com", password: PW, displayName: "U" }, { sessionKey: enumerator }))).toBe(
      "RATE_LIMITED",
    );
  });

  test("global backstop 100/hour (A-11)", async () => {
    const { db, svc } = setup();
    for (let i = 0; i < 100; i++) {
      expect(code(await svc.signUp({ email: `g${i}@x.com`, password: PW, displayName: "G" }, { sessionKey: sid() }))).toBe("OK");
    }
    expect(code(await svc.signUp({ email: "g100@x.com", password: PW, displayName: "G" }, { sessionKey: sid() }))).toBe(
      "RATE_LIMITED",
    );
    expect(count(db, "users")).toBe(100);
  });

  test("user and first session are one transaction; thrown errors carry no secret (A-90)", async () => {
    const base = createDatabase(":memory:");
    runMigrations(base);
    const { db } = spyDb(base, (sql) => sql.includes("INSERT INTO auth_sessions"));
    const { svc } = setup({ db });
    let thrown: unknown;
    try {
      await svc.signUp({ email: "kate@x.com", password: PW, displayName: "Kate" }, { sessionKey: sid() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const text = `${String(thrown)} ${(thrown as Error).stack ?? ""}`;
    expect(text).not.toContain(PW);
    expect(text).not.toContain("fake$");
    expect(count(base, "users")).toBe(0);
  });

  test("a failing hasher throws a generic error without the password or its cause (AR1)", async () => {
    const leaky: PasswordHasher = {
      hash: async (pw) => {
        throw new Error(`cannot hash ${pw}`);
      },
      verify: async () => false,
    };
    const db = createDatabase(":memory:");
    runMigrations(db);
    const svc = createAuthService({ db, hasher: leaky, now: () => T0 });
    let thrown: unknown;
    try {
      await svc.signUp({ email: "kate@x.com", password: PW, displayName: "Kate" }, { sessionKey: sid() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Password hashing failed.");
    expect((thrown as Error).cause).toBeUndefined();
    expect(String(thrown)).not.toContain(PW);
    expect(consoleLines.join("\n")).not.toContain(PW);
    expect(count(db, "users")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

describe("signIn", () => {
  test("success resets the counter, stamps last_login_at; two sign-ins = two sessions (criterion 3)", async () => {
    const { db, svc, clock } = setup();
    await mustSignUp(svc, "kate@x.com");
    clock.now = T0 + MIN;
    expect(code(await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() }))).toBe("INVALID_CREDENTIALS");
    expect(userRow(db, "kate@x.com")?.failed_login_count).toBe(1);
    clock.now = T0 + 2 * MIN;
    const a = await svc.signIn({ email: "KATE@x.com", password: PW }, { sessionKey: sid(), userAgent: "UA/A" });
    const b = await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey: sid() });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    remember(db, a.value.token, b.value.token);
    expect(a.value.token).not.toBe(b.value.token);
    expect(a.value.authSessionId).not.toBe(b.value.authSessionId);
    expect(a.value.user.lastLoginAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect(userRow(db, "kate@x.com")).toMatchObject({ failed_login_count: 0, locked_until: null });
    expect(count(db, "auth_sessions")).toBe(3);
    expect(svc.resolveToken(a.value.token)?.authSessionId).toBe(a.value.authSessionId);
    expect(svc.resolveToken(b.value.token)?.authSessionId).toBe(b.value.authSessionId);
  });

  test("unknown email and wrong password: identical results, one verify each, dummy is argon2id (AR2, A-26..A-28)", async () => {
    const one = setup();
    const two = setup();
    await mustSignUp(one.svc, "kate@x.com");
    const sessionKey = sid();
    const linesBefore = consoleLines.length;
    const wrong = await one.svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey });
    const unknown = await two.svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey });
    expect(wrong).toEqual(unknown);
    expect(JSON.stringify(wrong)).toBe(JSON.stringify(unknown));
    expect(wrong).toEqual({ ok: false, error: { code: "INVALID_CREDENTIALS", message: INVALID_CREDENTIALS_MESSAGE } });
    expect(INVALID_CREDENTIALS_MESSAGE).toBe("Email or password is incorrect");
    expect(one.hasher.verifyHashes.length).toBe(1);
    expect(two.hasher.verifyHashes.length).toBe(1);
    expect(two.hasher.verifyHashes[0]?.startsWith("$argon2id$v=19$m=65536,t=2,p=1$")).toBe(true);
    expect(consoleLines.length).toBe(linesBefore);
    // Unknown emails never create users or counters.
    expect(count(two.db, "users")).toBe(0);
    expect(count(two.db, "auth_sessions")).toBe(0);
  });

  test("missing fields: VALIDATION_FAILED before the limiter; over-long password is just wrong", async () => {
    const { db, svc, hasher } = setup();
    await mustSignUp(svc, "kate@x.com");
    const before = count(db, "rate_limits");
    const missing = await svc.signIn({ email: "", password: undefined }, { sessionKey: sid() });
    expect(fieldCode(missing, "email")).toBe("REQUIRED");
    expect(fieldCode(missing, "password")).toBe("REQUIRED");
    expect(count(db, "rate_limits")).toBe(before);
    expect(hasher.verifyHashes.length).toBe(0);

    const huge = "x".repeat(1024 * 1024);
    expect(code(await svc.signIn({ email: "kate@x.com", password: huge }, { sessionKey: sid() }))).toBe("INVALID_CREDENTIALS");
    expect(code(await svc.signIn({ email: "nobody@x.com", password: huge }, { sessionKey: sid() }))).toBe("INVALID_CREDENTIALS");
    expect(hasher.verifyHashes.length).toBe(2);
    expect(hasher.verifyHashes.every((h) => h.startsWith("$argon2id$"))).toBe(true);
    expect(userRow(db, "kate@x.com")?.failed_login_count).toBe(1);
  });

  test("password is never trimmed or altered (A-107)", async () => {
    const { svc } = setup();
    await mustSignUp(svc, "kate@x.com", " pass phrase 99 ");
    expect(code(await svc.signIn({ email: "kate@x.com", password: "pass phrase 99" }, { sessionKey: sid() }))).toBe(
      "INVALID_CREDENTIALS",
    );
    expect(code(await svc.signIn({ email: "kate@x.com", password: " pass phrase 99 " }, { sessionKey: sid() }))).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// Rate limits (real limiter, injected clock)
// ---------------------------------------------------------------------------

describe("sign-in rate limits", () => {
  test("credential stuffing from one session: 10 attempts, then RATE_LIMITED before verify (A-01)", async () => {
    const { db, svc, hasher } = setup();
    for (let i = 1; i <= 20; i++) await mustSignUp(svc, `u${i}@x.com`);
    const sessionKey = sid();
    const codes: string[] = [];
    for (let i = 0; i < 200; i++) {
      const result = await svc.signIn({ email: `u${(i % 20) + 1}@x.com`, password: WRONG }, { sessionKey });
      codes.push(code(result));
      if (i >= 10 && !result.ok) {
        const retry = result.error.details?.retryAfterSeconds as number;
        expect(retry).toBeGreaterThanOrEqual(1);
        expect(retry).toBeLessThanOrEqual(900);
      }
    }
    expect(codes.slice(0, 10).every((c) => c === "INVALID_CREDENTIALS")).toBe(true);
    expect(codes.slice(10).every((c) => c === "RATE_LIMITED")).toBe(true);
    expect(hasher.verifyHashes.length).toBe(10);
    const max = db.query<{ m: number; l: number }, []>(
      "SELECT MAX(failed_login_count) AS m, COUNT(locked_until) AS l FROM users",
    ).get();
    expect(max).toEqual({ m: 1, l: 0 });
  });

  test("one email from 20 sessions: lock at the 10th, then per-email RATE_LIMITED (A-02)", async () => {
    const { db, svc, hasher } = setup();
    await mustSignUp(svc, "kate@x.com");
    const codes: string[] = [];
    for (let i = 0; i < 20; i++) codes.push(code(await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() })));
    expect(codes.slice(0, 9).every((c) => c === "INVALID_CREDENTIALS")).toBe(true);
    expect(codes[9]).toBe("ACCOUNT_LOCKED");
    expect(codes.slice(10).every((c) => c === "RATE_LIMITED")).toBe(true);
    expect(hasher.verifyHashes.length).toBe(10);
    expect(userRow(db, "kate@x.com")?.failed_login_count).toBe(10);
  });

  test("unknown email from 20 sessions: 9 INVALID, uniform ACCOUNT_LOCKED, 10 RATE_LIMITED; no plaintext email stored (A-03, A-07)", async () => {
    const { db, svc } = setup();
    const codes: string[] = [];
    for (let i = 0; i < 20; i++) codes.push(code(await svc.signIn({ email: "Ghost@X.com", password: WRONG }, { sessionKey: sid() })));
    expect(codes.slice(0, 9).every((c) => c === "INVALID_CREDENTIALS")).toBe(true);
    expect(codes[9]).toBe("ACCOUNT_LOCKED");
    expect(codes.slice(10).every((c) => c === "RATE_LIMITED")).toBe(true);
    expect(count(db, "users")).toBe(0);
    const keys = db.query<{ key: string }, []>("SELECT key FROM rate_limits").all().map((r) => r.key);
    const emailKeys = keys.filter((k) => k.includes("auth.signin.email"));
    expect(emailKeys).toEqual([`900:auth.signin.email:${emailLimiterKey("ghost@x.com")}`]);
    for (const key of keys) {
      expect(key).not.toContain("@");
      expect(key.toLowerCase()).not.toContain("ghost");
      expect(key).not.toContain(WRONG);
    }
  });

  test("unknown vs wrong password: byte-identical results at attempts 1-9, 10 and 11, mid-window (A-25, R-10 ruling)", async () => {
    const known = setup();
    const unknown = setup();
    await mustSignUp(known.svc, "kate@x.com");
    known.hasher.verifyHashes.length = 0;
    const start = T0 + 123_456; // not window-aligned: retryAfterSeconds must still match
    known.clock.now = start;
    unknown.clock.now = start;
    const sessions = Array.from({ length: 11 }, () => sid());
    const pairs: [string, string][] = [];
    for (const [i, sessionKey] of sessions.entries()) {
      known.clock.now = start + i * SEC;
      unknown.clock.now = start + i * SEC;
      const a = await known.svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey });
      const b = await unknown.svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey });
      pairs.push([JSON.stringify(a), JSON.stringify(b)]);
    }
    for (const [a, b] of pairs) expect(a).toBe(b);
    const parsed = pairs.map(([a]) => JSON.parse(a) as { error: { code: string; message: string; details?: { retryAfterSeconds: number } } });
    expect(parsed.slice(0, 9).every((r) => r.error.code === "INVALID_CREDENTIALS")).toBe(true);
    const nowSec = Math.floor((start + 9 * SEC) / 1000);
    expect(parsed[9]?.error).toEqual({
      code: "ACCOUNT_LOCKED",
      message: "Too many failed attempts. Try again in 13 minutes.",
      details: { retryAfterSeconds: Math.floor(nowSec / 900) * 900 + 900 - nowSec },
    });
    expect(parsed[10]?.error.code).toBe("RATE_LIMITED");
    expect(known.hasher.verifyHashes.length).toBe(10);
    expect(unknown.hasher.verifyHashes.length).toBe(10);
    // The known account still carries its real 15-minute lock.
    expect(userRow(known.db, "kate@x.com")).toMatchObject({
      failed_login_count: 10,
      locked_until: new Date(start + 9 * SEC + 15 * MIN).toISOString(),
    });
    expect(count(unknown.db, "users")).toBe(0);
  });

  test("the last per-email attempt with the correct password still signs in", async () => {
    const { svc } = setup();
    await mustSignUp(svc, "kate@x.com");
    for (let i = 0; i < 9; i++) await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() });
    expect(code(await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey: sid() }))).toBe("OK");
  });

  test("global backstop 1000 / 15 min across sessions and emails (A-04)", async () => {
    const { svc, hasher } = setup();
    for (let i = 0; i < 1000; i++) {
      expect(code(await svc.signIn({ email: `n${i}@x.com`, password: WRONG }, { sessionKey: sid() }))).toBe("INVALID_CREDENTIALS");
    }
    expect(code(await svc.signIn({ email: "n1000@x.com", password: WRONG }, { sessionKey: sid() }))).toBe("RATE_LIMITED");
    expect(hasher.verifyHashes.length).toBe(1000);
  });

  test("fixed window boundary (A-05)", async () => {
    const { svc, clock } = setup();
    const sessionKey = sid();
    clock.now = T0 + 899 * SEC;
    for (let i = 0; i < 10; i++) await svc.signIn({ email: `w${i}@x.com`, password: WRONG }, { sessionKey });
    const eleventh = await svc.signIn({ email: "w10@x.com", password: WRONG }, { sessionKey });
    expect(eleventh.ok ? null : eleventh.error.details?.retryAfterSeconds).toBe(1);
    clock.now = T0 + 900 * SEC;
    expect(code(await svc.signIn({ email: "w11@x.com", password: WRONG }, { sessionKey }))).toBe("INVALID_CREDENTIALS");
  });

  test("spellings of one email share one per-email key (A-06)", async () => {
    const { svc } = setup();
    await mustSignUp(svc, "Kate@X.com ");
    // Unknown password every time, but use a permissive lock-free count: emails differ only in case/space.
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) codes.push(code(await svc.signIn({ email: " KATE@x.com", password: WRONG }, { sessionKey: sid() })));
    for (let i = 0; i < 5; i++) codes.push(code(await svc.signIn({ email: "kate@X.COM", password: WRONG }, { sessionKey: sid() })));
    expect(codes[10]).toBe("RATE_LIMITED");
  });

  test("limited session with the correct password: no verify, no login (A-08)", async () => {
    const { db, svc, hasher } = setup();
    await mustSignUp(svc, "kate@x.com");
    const before = userRow(db, "kate@x.com")?.last_login_at;
    const sessionKey = sid();
    for (let i = 0; i < 10; i++) await svc.signIn({ email: `x${i}@x.com`, password: WRONG }, { sessionKey });
    const verifies = hasher.verifyHashes.length;
    expect(code(await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey }))).toBe("RATE_LIMITED");
    expect(hasher.verifyHashes.length).toBe(verifies);
    expect(userRow(db, "kate@x.com")?.last_login_at).toBe(before ?? null);
    expect(count(db, "auth_sessions")).toBe(1);
  });

  test("cookieless clients share the 'anon' per-session bucket (A-09, documented)", async () => {
    const { svc } = setup();
    for (let i = 0; i < 10; i++) {
      expect(code(await svc.signIn({ email: `c${i}@x.com`, password: WRONG }, { sessionKey: null }))).toBe("INVALID_CREDENTIALS");
    }
    expect(code(await svc.signIn({ email: "c10@x.com", password: WRONG }, { sessionKey: "not-a-uuid" }))).toBe("RATE_LIMITED");
  });

  test("limiter database error fails closed before verify; log names no email or secret (A-15)", async () => {
    const { db, svc, hasher } = setup();
    await mustSignUp(svc, "kate@x.com");
    db.run("DROP TABLE rate_limits");
    const lines = consoleLines.length;
    expect(code(await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey: sid() }))).toBe("RATE_LIMITED");
    expect(hasher.verifyHashes.length).toBe(0);
    const logged = consoleLines.slice(lines).join("\n");
    expect(logged).toContain("auth.signin.session");
    expect(logged).not.toContain("kate");
    expect(logged).not.toContain(PW);
  });
});

// ---------------------------------------------------------------------------
// Lockout (permissive limiter isolates the lock)
// ---------------------------------------------------------------------------

describe("lockout", () => {
  test("9 failures count up; the 10th locks for 900 s; correct password during the lock is rejected (A-16..A-18, criterion 5)", async () => {
    const { db, svc, hasher, clock } = setup({ limiter: permissiveLimiter });
    await mustSignUp(svc, "kate@x.com");
    const sessionKey = sid();
    for (let i = 1; i <= 9; i++) {
      expect(code(await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey }))).toBe("INVALID_CREDENTIALS");
      expect(userRow(db, "kate@x.com")).toMatchObject({ failed_login_count: i, locked_until: null });
    }
    const tenth = await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey });
    expect(tenth.ok ? null : tenth.error).toEqual({
      code: "ACCOUNT_LOCKED",
      message: "Too many failed attempts. Try again in 15 minutes.",
      details: { retryAfterSeconds: 900 },
    });
    expect(userRow(db, "kate@x.com")?.locked_until).toBe(new Date(T0 + 15 * MIN).toISOString());

    const verifies = hasher.verifyHashes.length;
    clock.now = T0 + 14 * MIN + 59 * SEC;
    const during = await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey });
    expect(during.ok ? null : during.error).toEqual({
      code: "ACCOUNT_LOCKED",
      message: "Too many failed attempts. Try again in 1 minute.",
      details: { retryAfterSeconds: 1 },
    });
    expect(hasher.verifyHashes.length).toBe(verifies);
    expect(count(db, "auth_sessions")).toBe(1);
    expect(userRow(db, "kate@x.com")?.failed_login_count).toBe(10);

    // After the lock: the correct password succeeds and resets (A-20).
    clock.now = T0 + 15 * MIN + SEC;
    const after = await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey });
    expect(code(after)).toBe("OK");
    expect(userRow(db, "kate@x.com")).toMatchObject({ failed_login_count: 0, locked_until: null });
  });

  test("lock expiry starts a fresh count via clearExpiredLock (A-21)", async () => {
    const { db, svc, clock } = setup({ limiter: permissiveLimiter });
    await mustSignUp(svc, "kate@x.com");
    for (let i = 0; i < 10; i++) await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() });
    const lastLogin = userRow(db, "kate@x.com")?.last_login_at;
    clock.now = T0 + 15 * MIN;
    expect(code(await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() }))).toBe("INVALID_CREDENTIALS");
    expect(userRow(db, "kate@x.com")).toMatchObject({ failed_login_count: 1, locked_until: null, last_login_at: lastLogin });
  });

  test("lock survives a new limiter window (real limiter, A-19)", async () => {
    const { svc, clock } = setup();
    await mustSignUp(svc, "kate@x.com");
    const sessionKey = sid();
    clock.now = T0 + 890 * SEC;
    for (let i = 0; i < 10; i++) await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey });
    clock.now = T0 + 901 * SEC;
    expect(code(await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey }))).toBe("ACCOUNT_LOCKED");
  });

  test("20 concurrent wrong passwords: all settle, count 20, locked, none succeed (A-22)", async () => {
    const hasher = fakeHasher({ delayMs: () => 2 });
    const { db, svc } = setup({ limiter: permissiveLimiter, hasher });
    await mustSignUp(svc, "kate@x.com");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() })),
    );
    expect(results.every((r) => !r.ok)).toBe(true);
    const row = userRow(db, "kate@x.com");
    expect(row?.failed_login_count).toBe(20);
    expect(row?.locked_until).not.toBeNull();
    expect(results.filter((r) => code(r) === "ACCOUNT_LOCKED").length).toBe(11);
  });

  test("a correct password racing the locking failure does not sign in (A-23)", async () => {
    // Correct verifications are slower, so the wrong ones land first and lock.
    const hasher = fakeHasher({ delayMs: (matched) => (matched ? 20 : 1) });
    const { db, svc } = setup({ limiter: permissiveLimiter, hasher });
    await mustSignUp(svc, "kate@x.com");
    for (let i = 0; i < 9; i++) await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() });
    const lastLogin = userRow(db, "kate@x.com")?.last_login_at;
    const [correct, ...wrong] = await Promise.all([
      svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey: sid() }),
      ...Array.from({ length: 5 }, () => svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() })),
    ]);
    expect(code(correct as Result<unknown, AppError>)).toBe("ACCOUNT_LOCKED");
    expect(wrong.every((r) => !r.ok)).toBe(true);
    expect(userRow(db, "kate@x.com")).toMatchObject({ failed_login_count: 14, last_login_at: lastLogin });
    expect(count(db, "auth_sessions")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveToken / signOut / signOutEverywhere
// ---------------------------------------------------------------------------

describe("resolveToken", () => {
  test("resolves a live token to the user and session", async () => {
    const { svc } = setup();
    const issued = await mustSignUp(svc, "kate@x.com");
    expect(svc.resolveToken(issued.token)).toEqual({
      user: issued.user,
      authSessionId: issued.authSessionId,
      expiresAt: issued.expiresAt,
    });
  });

  test("hostile tokens return null without any query (A-41, criterion 7)", async () => {
    const base = createDatabase(":memory:");
    runMigrations(base);
    const spy = spyDb(base);
    const { svc } = setup({ db: spy.db });
    const issued = await mustSignUp(svc, "kate@x.com");
    spy.sql.length = 0;
    const valid = issued.token;
    for (const hostile of [
      valid.slice(0, 42),
      `${valid}A`,
      `${valid.slice(0, 42)}+`,
      `${valid.slice(0, 42)}/`,
      `${valid.slice(0, 42)}=`,
      `${valid.slice(0, 41)}é`,
      "x".repeat(1024 * 1024),
      "",
      undefined,
      null,
      42,
      { toString: () => valid },
      hashToken(valid),
    ]) {
      expect(svc.resolveToken(hostile)).toBeNull();
      svc.signOut(hostile);
    }
    expect(spy.sql).toEqual([]);
    // A well-formed unknown token is looked up by its digest only.
    expect(svc.resolveToken(generateToken())).toBeNull();
    expect(spy.sql.length).toBe(1);
  });

  test("absolute expiry boundary; touch never extends expires_at (A-42)", async () => {
    const { db, svc } = setup();
    const issued = await mustSignUp(svc, "kate@x.com");
    const expires = T0 + AUTH_SESSION_TTL_MS;
    expect(svc.resolveToken(issued.token, expires - SEC)).not.toBeNull();
    expect(svc.resolveToken(issued.token, expires)).toBeNull();
    const row = db.query<{ e: string }, []>("SELECT expires_at AS e FROM auth_sessions").get();
    expect(row?.e).toBe(new Date(expires).toISOString());
  });

  test("touch is throttled to once per 5 minutes (A-43)", async () => {
    const base = createDatabase(":memory:");
    runMigrations(base);
    const spy = spyDb(base);
    const { svc } = setup({ db: spy.db });
    const issued = await mustSignUp(svc, "kate@x.com");
    const lastSeen = () => base.query<{ l: string }, []>("SELECT last_seen_at AS l FROM auth_sessions").get()?.l;
    const touches = () => spy.sql.filter((s) => s.includes("SET last_seen_at")).length;
    svc.resolveToken(issued.token, T0);
    svc.resolveToken(issued.token, T0 + 60 * SEC);
    expect(lastSeen()).toBe(new Date(T0).toISOString());
    expect(touches()).toBe(0);
    svc.resolveToken(issued.token, T0 + 301 * SEC);
    expect(lastSeen()).toBe(new Date(T0 + 301 * SEC).toISOString());
    expect(touches()).toBe(1);
    svc.resolveToken(issued.token, T0 + 301 * SEC + TOUCH_INTERVAL_MS - 1);
    expect(touches()).toBe(1);
    svc.resolveToken(issued.token, T0 + 301 * SEC + TOUCH_INTERVAL_MS);
    expect(touches()).toBe(2);
  });

  test("touch and lookup failures never throw (ruling K-12)", async () => {
    const base = createDatabase(":memory:");
    runMigrations(base);
    let failTouch = false;
    let failLookup = false;
    const spy = spyDb(base, (sql) => (failTouch && sql.includes("SET last_seen_at")) || (failLookup && sql.includes("FROM auth_sessions")));
    const errors: string[] = [];
    const svc = createAuthService({
      db: spy.db,
      hasher: fakeHasher(),
      now: () => T0,
      logger: { error: (m: string) => errors.push(m), warn: (m: string) => errors.push(m) },
    });
    const issued = await mustSignUp(svc, "kate@x.com");
    failTouch = true;
    expect(svc.resolveToken(issued.token, T0 + DAY)?.authSessionId).toBe(issued.authSessionId);
    failLookup = true;
    expect(svc.resolveToken(issued.token, T0 + DAY)).toBeNull();
    expect(errors).toEqual(["auth: session touch failed (Error)", "auth: token resolution failed (Error)"]);
    for (const line of errors) {
      expect(line).not.toContain(issued.token);
      expect(line).not.toContain(hashToken(issued.token));
    }
  });

  test("revoked → null; locked account still resolves; deleted user → null", async () => {
    const { db, svc } = setup({ limiter: permissiveLimiter });
    const issued = await mustSignUp(svc, "kate@x.com");
    for (let i = 0; i < 10; i++) await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() });
    expect(userRow(db, "kate@x.com")?.locked_until).not.toBeNull();
    expect(svc.resolveToken(issued.token)?.user.id).toBe(issued.user.id);
    svc.signOut(issued.token);
    expect(svc.resolveToken(issued.token)).toBeNull();

    const other = await mustSignUp(svc, "other@x.com");
    db.query("DELETE FROM users WHERE id = ?").run(other.user.id);
    expect(svc.resolveToken(other.token)).toBeNull();
  });
});

describe("signOut / signOutEverywhere", () => {
  test("signOut revokes only that session and is idempotent (criterion 8)", async () => {
    const { svc } = setup();
    const a = await mustSignUp(svc, "kate@x.com");
    const b = await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey: sid() });
    if (!b.ok) throw new Error("sign-in failed");
    svc.signOut(a.token);
    svc.signOut(a.token);
    expect(svc.resolveToken(a.token)).toBeNull();
    expect(svc.resolveToken(b.value.token)).not.toBeNull();
  });

  test("signOutEverywhere revokes every session incl. the current one; others untouched (ruling R-2)", async () => {
    const { svc } = setup();
    const a1 = await mustSignUp(svc, "kate@x.com");
    const tokens = [a1.token];
    for (let i = 0; i < 2; i++) {
      const r = await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey: sid() });
      if (r.ok) tokens.push(r.value.token);
    }
    const other = await mustSignUp(svc, "other@x.com");
    expect(svc.signOutEverywhere(a1.user.id)).toBe(3);
    for (const t of tokens) expect(svc.resolveToken(t)).toBeNull();
    expect(svc.resolveToken(other.token)).not.toBeNull();
    expect(svc.signOutEverywhere(a1.user.id)).toBe(0);
    expect(svc.signOutEverywhere("not-a-uuid")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyPassword / issueSessionFor
// ---------------------------------------------------------------------------

describe("verifyPassword", () => {
  test("ok, INVALID_CREDENTIALS counting toward the lock, ACCOUNT_LOCKED, NOT_FOUND, REQUIRED", async () => {
    const { db, svc, clock } = setup();
    const { user } = await mustSignUp(svc, "kate@x.com");
    expect(await svc.verifyPassword(user.id, PW)).toEqual({ ok: true, value: undefined });
    for (let i = 1; i <= 9; i++) {
      expect(await svc.verifyPassword(user.id, WRONG)).toEqual({
        ok: false,
        error: { code: "INVALID_CREDENTIALS", message: INVALID_CREDENTIALS_MESSAGE },
      });
    }
    expect(userRow(db, "kate@x.com")?.failed_login_count).toBe(9);
    expect(code(await svc.verifyPassword(user.id, WRONG))).toBe("ACCOUNT_LOCKED");
    expect(code(await svc.verifyPassword(user.id, PW))).toBe("ACCOUNT_LOCKED");
    clock.now = T0 + 15 * MIN;
    expect(code(await svc.verifyPassword(user.id, PW))).toBe("OK");
    expect(userRow(db, "kate@x.com")).toMatchObject({ failed_login_count: 0, locked_until: null });
    expect(code(await svc.verifyPassword("11111111-1111-4111-8111-111111111111", PW))).toBe("NOT_FOUND");
    expect(code(await svc.verifyPassword("bad", PW))).toBe("NOT_FOUND");
    expect(fieldCode(await svc.verifyPassword(user.id, ""), "password")).toBe("REQUIRED");
    expect(fieldCode(await svc.verifyPassword(user.id, 12345678), "password")).toBe("REQUIRED");
  });
});

describe("issueSessionFor", () => {
  test("issues for a locked user (lock blocks only password sign-in); NOT_FOUND otherwise", async () => {
    const { db, svc } = setup({ limiter: permissiveLimiter });
    const { user } = await mustSignUp(svc, "kate@x.com");
    for (let i = 0; i < 10; i++) await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() });
    const issued = svc.issueSessionFor(user.id, { sessionKey: null, userAgent: "UA/9", now: T0 + MIN });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.token).toMatch(TOKEN_RE);
    expect(issued.value.expiresAt).toBe(new Date(T0 + MIN + AUTH_SESSION_TTL_MS).toISOString());
    expect(svc.resolveToken(issued.value.token, T0 + MIN)?.user.id).toBe(user.id);
    const ua = db
      .query<{ u: string | null }, [string]>("SELECT user_agent AS u FROM auth_sessions WHERE id = ?")
      .get(issued.value.authSessionId);
    expect(ua?.u).toBe("UA/9");
    expect(code(svc.issueSessionFor("11111111-1111-4111-8111-111111111111", { sessionKey: null }))).toBe("NOT_FOUND");
    expect(code(svc.issueSessionFor("x", { sessionKey: null }))).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// Opportunistic purge
// ---------------------------------------------------------------------------

describe("purge", () => {
  test(`every ${PURGE_EVERY_SIGNINS}th successful sign-in purges old revoked/expired sessions`, async () => {
    const { db, svc, clock } = setup({ limiter: permissiveLimiter });
    const old = await mustSignUp(svc, "kate@x.com");
    svc.signOut(old.token);
    clock.now = T0 + 31 * DAY;
    const oldExists = () =>
      (db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM auth_sessions WHERE id = ?").get(old.authSessionId)?.n ?? 0) === 1;
    for (let i = 1; i < PURGE_EVERY_SIGNINS; i++) {
      expect(code(await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey: sid() }))).toBe("OK");
    }
    expect(oldExists()).toBe(true);
    await svc.signIn({ email: "kate@x.com", password: PW }, { sessionKey: sid() });
    expect(oldExists()).toBe(false);
    expect(count(db, "auth_sessions")).toBe(PURGE_EVERY_SIGNINS);
  });
});

// ---------------------------------------------------------------------------
// Real Bun.password (the only test using it, criterion 9)
// ---------------------------------------------------------------------------

describe("argon2idHasher", () => {
  test("real argon2id: prefix, per-user salt, never the password; dummy shares the parameters", async () => {
    const verifyHashes: string[] = [];
    const spyHasher: PasswordHasher = {
      hash: (pw) => argon2idHasher.hash(pw),
      verify: (pw, hash) => {
        verifyHashes.push(hash);
        return argon2idHasher.verify(pw, hash);
      },
    };
    const db = createDatabase(":memory:");
    runMigrations(db);
    const svc = createAuthService({ db, hasher: spyHasher, now: () => T0 });
    await mustSignUp(svc, "a@x.com");
    await mustSignUp(svc, "b@x.com");
    const ha = userRow(db, "a@x.com")?.password_hash ?? "";
    const hb = userRow(db, "b@x.com")?.password_hash ?? "";
    expect(ha.startsWith("$argon2id$")).toBe(true);
    expect(hb.startsWith("$argon2id$")).toBe(true);
    expect(ha).not.toBe(hb);
    expect(ha).not.toBe(PW);
    expect(code(await svc.signIn({ email: "a@x.com", password: PW }, { sessionKey: sid() }))).toBe("OK");
    expect(code(await svc.signIn({ email: "nobody@x.com", password: PW }, { sessionKey: sid() }))).toBe("INVALID_CREDENTIALS");
    const params = (h: string) => h.split("$").slice(1, 4).join("$");
    expect(verifyHashes.length).toBe(2);
    expect(params(verifyHashes[1] ?? "")).toBe(params(ha));
    remember(db);
  });
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe("getAuthService", () => {
  const previous = process.env.DATABASE_PATH;
  afterEach(() => {
    closeDatabase();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  });

  test("is a globalThis singleton over the shared database, rebuilt when the handle changes", () => {
    process.env.DATABASE_PATH = ":memory:";
    const a = getAuthService();
    expect(getAuthService()).toBe(a);
    expect(a.resolveToken(generateToken())).toBeNull();
    closeDatabase();
    expect(getAuthService()).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// AR1 sweep (runs last): nothing secret was ever logged or returned.
// ---------------------------------------------------------------------------

describe("AR1", () => {
  test("console output of the whole file and every returned result carry no secret (A-88..A-90, criterion 10)", async () => {
    const { db, svc } = setup({ limiter: permissiveLimiter });
    const issued = await mustSignUp(svc, "kate@x.com");
    const results: unknown[] = [
      await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() }),
      await svc.signIn({ email: "ghost@x.com", password: WRONG }, { sessionKey: sid() }),
      await svc.signUp({ email: "kate@x.com", password: PW, displayName: "K" }, { sessionKey: sid() }),
      await svc.signUp({ email: "z@x.com", password: "short", displayName: "K" }, { sessionKey: sid() }),
      await svc.verifyPassword(issued.user.id, WRONG),
      svc.resolveToken(issued.token),
    ];
    for (let i = 0; i < 10; i++) results.push(await svc.signIn({ email: "kate@x.com", password: WRONG }, { sessionKey: sid() }));
    remember(db, issued.token);
    for (const secret of [PW, WRONG]) secrets.add(secret);
    const returned = JSON.stringify(results);
    const logged = consoleLines.join("\n");
    for (const secret of secrets) {
      expect(returned).not.toContain(secret);
      expect(logged).not.toContain(secret);
    }
    expect(logged).not.toContain("$argon2");
    expect(returned).not.toContain("$argon2");
    expect(returned).not.toContain("passwordHash");
    // The raw token appears only in IssuedSession.token.
    expect(JSON.stringify({ ...issued, token: "" })).not.toContain(issued.token);
  });
});
