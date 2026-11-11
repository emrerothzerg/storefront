import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { User } from "@/lib/types";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { isSessionId } from "@/server/session/session-id";
import {
  createAuthRepository,
  DEFAULT_LOCK_MS,
  isTokenHash,
  type AuthRepository,
  type UserCredentialRow,
} from "./auth-repository";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const HASH = "$argon2id$v=19$m=65536,t=2,p=1$c2FsdA$aGFzaA";

function hex(n: number): string {
  return n.toString(16).padStart(64, "0");
}

function setup(): { db: Database; repo: AuthRepository } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  return { db, repo: createAuthRepository(db) };
}

function mustCreateUser(repo: AuthRepository, email: string, now = T0): User {
  const result = repo.createUser({ email, passwordHash: HASH, displayName: "Ada" }, now);
  if (!result.ok) throw new Error(`createUser failed: ${result.error.code}`);
  return result.value;
}

function mustCreateSession(repo: AuthRepository, userId: string, n: number, expiresAt = T0 + 30 * DAY, now = T0) {
  const result = repo.createAuthSession({ userId, tokenHash: hex(n), expiresAt: new Date(expiresAt).toISOString() }, now);
  if (!result.ok) throw new Error(`createAuthSession failed: ${result.error.code}`);
  return result.value;
}

// Type-level guarantees (criterion 6): checked by `bun run typecheck`.
type HasKey<T, K extends string> = K extends keyof T ? true : false;
const userHasNoHash: HasKey<User, "passwordHash"> = false;
const credentialsHaveHash: HasKey<UserCredentialRow, "passwordHash"> = true;

describe("types", () => {
  test("public User has no passwordHash; UserCredentialRow does", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    // @ts-expect-error -- the public User type must never carry the hash
    expect(user.passwordHash).toBeUndefined();
    expect(userHasNoHash).toBe(false);
    expect(credentialsHaveHash).toBe(true);
  });

  test("no public method returns a hash at runtime", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const shapes: unknown[] = [
      user,
      repo.findUserById(user.id),
      repo.findUserByOwnerKey(user.ownerKey),
      repo.updateDisplayName(user.id, "Grace", T0),
      mustCreateSession(repo, user.id, 1),
      repo.findAuthSessionByTokenHash(hex(1), T0),
      repo.listActiveSessions(user.id, T0),
    ];
    const text = JSON.stringify(shapes);
    expect(text).not.toContain(HASH);
    expect(text).not.toContain("passwordHash");
    expect(text).not.toContain(hex(1));
  });
});

describe("users", () => {
  test("createUser stores lower-cased email, UUID v4 id and owner key, clock timestamps", () => {
    const { db, repo } = setup();
    const user = mustCreateUser(repo, "  Ada@Example.COM ");
    expect(user).toEqual({
      id: user.id,
      email: "ada@example.com",
      displayName: "Ada",
      ownerKey: user.ownerKey,
      createdAt: "2026-11-07T12:00:00.000Z",
      lastLoginAt: null,
    });
    expect(isSessionId(user.id)).toBe(true);
    expect(isSessionId(user.ownerKey)).toBe(true);
    expect(user.ownerKey).not.toBe(user.id);
    expect(db.query("SELECT email, failed_login_count, locked_until, updated_at FROM users").get()).toEqual({
      email: "ada@example.com",
      failed_login_count: 0,
      locked_until: null,
      updated_at: "2026-11-07T12:00:00.000Z",
    });
  });

  test("duplicate email in another case returns EMAIL_TAKEN without throwing and creates nothing", () => {
    const { db, repo } = setup();
    mustCreateUser(repo, "ada@example.com");
    let result: ReturnType<AuthRepository["createUser"]> | undefined;
    expect(() => {
      result = repo.createUser({ email: "ADA@Example.com", passwordHash: HASH, displayName: "Other" });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    if (result !== undefined && !result.ok) {
      expect(result.error.code).toBe("EMAIL_TAKEN");
      expect(result.error.message).not.toContain("ada@example.com");
    }
    expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  test("empty email is rejected", () => {
    const { repo } = setup();
    const result = repo.createUser({ email: "   ", passwordHash: HASH, displayName: "A" });
    expect(result.ok ? null : result.error.code).toBe("VALIDATION_FAILED");
  });

  test("different users get different owner keys", () => {
    const { repo } = setup();
    const a = mustCreateUser(repo, "a@example.com");
    const b = mustCreateUser(repo, "b@example.com");
    expect(a.ownerKey).not.toBe(b.ownerKey);
    expect(a.id).not.toBe(b.id);
  });

  test("findCredentialsByEmail matches the stored lower-cased email and is the only hash-bearing read", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const creds = repo.findCredentialsByEmail("ADA@example.com ");
    expect(creds).toEqual({
      id: user.id,
      email: "ada@example.com",
      passwordHash: HASH,
      displayName: "Ada",
      ownerKey: user.ownerKey,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: user.createdAt,
      updatedAt: user.createdAt,
    });
    expect(repo.findCredentialsByEmail("nobody@example.com")).toBeNull();
    expect(repo.findCredentialsByEmail("")).toBeNull();
    expect(repo.findCredentialsByEmail("' OR 1=1 --")).toBeNull();
  });

  test("findUserById / findUserByOwnerKey return null for unknown or malformed ids", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    expect(repo.findUserById(user.id)).toEqual(user);
    expect(repo.findUserByOwnerKey(user.ownerKey)).toEqual(user);
    expect(repo.findUserById(user.ownerKey)).toBeNull();
    expect(repo.findUserByOwnerKey(user.id)).toBeNull();
    expect(repo.findUserById("' OR 1=1 --")).toBeNull();
    expect(repo.findUserByOwnerKey("not-a-uuid")).toBeNull();
  });

  test("updateDisplayName updates and returns the user; NOT_FOUND otherwise", () => {
    const { db, repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const result = repo.updateDisplayName(user.id, "Grace", T0 + HOUR);
    expect(result).toEqual({ ok: true, value: { ...user, displayName: "Grace" } });
    expect(db.query("SELECT updated_at FROM users").get()).toEqual({ updated_at: "2026-11-07T13:00:00.000Z" });
    const missing = repo.updateDisplayName("11111111-1111-4111-8111-111111111111", "X");
    expect(missing.ok ? null : missing.error.code).toBe("NOT_FOUND");
    const bad = repo.updateDisplayName("bad", "X");
    expect(bad.ok ? null : bad.error.code).toBe("NOT_FOUND");
  });

  test("updatePasswordHash replaces the hash; NOT_FOUND for unknown users", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    expect(repo.updatePasswordHash(user.id, "$argon2id$new", T0 + HOUR)).toEqual({ ok: true, value: undefined });
    expect(repo.findCredentialsByEmail("ada@example.com")?.passwordHash).toBe("$argon2id$new");
    expect(repo.findCredentialsByEmail("ada@example.com")?.updatedAt).toBe("2026-11-07T13:00:00.000Z");
    const missing = repo.updatePasswordHash("11111111-1111-4111-8111-111111111111", "x");
    expect(missing.ok ? null : missing.error.code).toBe("NOT_FOUND");
  });

  test("deleteUser removes the user and cascades auth sessions; NOT_FOUND when absent", () => {
    const { db, repo } = setup();
    const a = mustCreateUser(repo, "a@example.com");
    const b = mustCreateUser(repo, "b@example.com");
    mustCreateSession(repo, a.id, 1);
    mustCreateSession(repo, a.id, 2);
    mustCreateSession(repo, b.id, 3);
    expect(repo.deleteUser(a.id)).toEqual({ ok: true, value: undefined });
    expect(repo.findUserById(a.id)).toBeNull();
    expect(repo.findAuthSessionByTokenHash(hex(1), T0)).toBeNull();
    expect(db.query("SELECT user_id FROM auth_sessions").all()).toEqual([{ user_id: b.id }]);
    const again = repo.deleteUser(a.id);
    expect(again.ok ? null : again.error.code).toBe("NOT_FOUND");
    // Same email can sign up again as a new user with a new owner key.
    const reborn = mustCreateUser(repo, "a@example.com");
    expect(reborn.ownerKey).not.toBe(a.ownerKey);
  });
});

describe("login failures", () => {
  test("increments, locks exactly at the threshold, reset clears and stamps last_login_at", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    for (let i = 1; i <= 2; i++) {
      expect(repo.recordLoginFailure(user.id, T0, 3, 1000)).toEqual({ failedLoginCount: i, lockedUntil: null });
    }
    expect(repo.recordLoginFailure(user.id, T0, 3, 1000)).toEqual({
      failedLoginCount: 3,
      lockedUntil: "2026-11-07T12:00:01.000Z",
    });
    repo.resetLoginFailures(user.id, T0 + HOUR);
    const creds = repo.findCredentialsByEmail("ada@example.com");
    expect(creds?.failedLoginCount).toBe(0);
    expect(creds?.lockedUntil).toBeNull();
    expect(creds?.lastLoginAt).toBe("2026-11-07T13:00:00.000Z");
    expect(repo.findUserById(user.id)?.lastLoginAt).toBe("2026-11-07T13:00:00.000Z");
  });

  test("defaults are 10 failures / 15 minutes", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    for (let i = 1; i < 10; i++) expect(repo.recordLoginFailure(user.id, T0).lockedUntil).toBeNull();
    expect(repo.recordLoginFailure(user.id, T0)).toEqual({
      failedLoginCount: 10,
      lockedUntil: new Date(T0 + DEFAULT_LOCK_MS).toISOString(),
    });
    expect(DEFAULT_LOCK_MS).toBe(15 * 60 * 1000);
  });

  test("20 concurrent increments end at exactly 20 and lock first appears at the threshold", async () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const results = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        // Interleave the callers across macrotasks in a scrambled order.
        await new Promise((resolve) => setTimeout(resolve, (i * 7) % 5));
        return repo.recordLoginFailure(user.id, T0, 10, DEFAULT_LOCK_MS);
      }),
    );
    const counts = results.map((r) => r.failedLoginCount).sort((a, b) => a - b);
    expect(counts).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    for (const r of results) {
      expect(r.lockedUntil === null).toBe(r.failedLoginCount < 10);
    }
    expect(repo.findCredentialsByEmail("ada@example.com")?.failedLoginCount).toBe(20);
  });

  test("clearExpiredLock clears only an expired lock and never touches last_login_at", () => {
    const { db, repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const state = () =>
      db
        .query<{ c: number; l: string | null; ll: string | null }, [string]>(
          "SELECT failed_login_count AS c, locked_until AS l, last_login_at AS ll FROM users WHERE id = ?",
        )
        .get(user.id);
    // No lock: counter below threshold is left alone.
    repo.recordLoginFailure(user.id, T0);
    expect(repo.clearExpiredLock(user.id, T0)).toBe(false);
    expect(state()).toEqual({ c: 1, l: null, ll: null });
    // Live lock: unchanged, also exactly one ms before expiry.
    for (let i = 0; i < 9; i++) repo.recordLoginFailure(user.id, T0);
    const lockedUntil = "2026-11-07T12:15:00.000Z";
    expect(state()).toEqual({ c: 10, l: lockedUntil, ll: null });
    expect(repo.clearExpiredLock(user.id, T0 + DEFAULT_LOCK_MS - 1)).toBe(false);
    expect(state()).toEqual({ c: 10, l: lockedUntil, ll: null });
    // Expired (boundary: locked_until == now counts as expired).
    expect(repo.clearExpiredLock(user.id, T0 + DEFAULT_LOCK_MS)).toBe(true);
    expect(state()).toEqual({ c: 0, l: null, ll: null });
    // Next failure starts a fresh count.
    expect(repo.recordLoginFailure(user.id, T0 + DEFAULT_LOCK_MS + 1)).toEqual({ failedLoginCount: 1, lockedUntil: null });
    // last_login_at survives a clear.
    repo.resetLoginFailures(user.id, T0 + HOUR);
    for (let i = 0; i < 10; i++) repo.recordLoginFailure(user.id, T0 + 2 * HOUR);
    expect(repo.clearExpiredLock(user.id, T0 + 3 * HOUR)).toBe(true);
    expect(state()).toEqual({ c: 0, l: null, ll: "2026-11-07T13:00:00.000Z" });
    // Malformed / unknown ids: no-op.
    expect(repo.clearExpiredLock("x", T0)).toBe(false);
    expect(repo.clearExpiredLock("11111111-1111-4111-8111-111111111111", T0 + DAY)).toBe(false);
  });

  test("unknown or malformed user ids change nothing", () => {
    const { db, repo } = setup();
    mustCreateUser(repo, "ada@example.com");
    expect(repo.recordLoginFailure("11111111-1111-4111-8111-111111111111", T0)).toEqual({
      failedLoginCount: 0,
      lockedUntil: null,
    });
    expect(repo.recordLoginFailure("x", T0)).toEqual({ failedLoginCount: 0, lockedUntil: null });
    repo.resetLoginFailures("x", T0);
    expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    expect(db.query("SELECT failed_login_count AS c FROM users").get()).toEqual({ c: 0 });
  });
});

describe("auth sessions", () => {
  test("createAuthSession stores the hash and returns the session", () => {
    const { db, repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const result = repo.createAuthSession(
      { userId: user.id, tokenHash: hex(1), expiresAt: "2026-12-07T12:00:00.000Z", userAgent: "UA/1" },
      T0,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      id: result.value.id,
      userId: user.id,
      createdAt: "2026-11-07T12:00:00.000Z",
      expiresAt: "2026-12-07T12:00:00.000Z",
      lastSeenAt: "2026-11-07T12:00:00.000Z",
      revokedAt: null,
      userAgent: "UA/1",
    });
    expect(isSessionId(result.value.id)).toBe(true);
    expect(db.query("SELECT token_hash, user_agent FROM auth_sessions").get()).toEqual({
      token_hash: hex(1),
      user_agent: "UA/1",
    });
  });

  test("createAuthSession rejects bad hashes, past expiry, unknown users and duplicate hashes", () => {
    const { db, repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const future = "2026-12-07T12:00:00.000Z";
    const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error?.code);
    expect(code(repo.createAuthSession({ userId: user.id, tokenHash: hex(1).toUpperCase().replace(/0/g, "A"), expiresAt: future }, T0))).toBe("VALIDATION_FAILED");
    expect(code(repo.createAuthSession({ userId: user.id, tokenHash: "abc", expiresAt: future }, T0))).toBe("VALIDATION_FAILED");
    expect(code(repo.createAuthSession({ userId: user.id, tokenHash: hex(1), expiresAt: "nope" }, T0))).toBe("VALIDATION_FAILED");
    expect(code(repo.createAuthSession({ userId: user.id, tokenHash: hex(1), expiresAt: new Date(T0).toISOString() }, T0))).toBe("VALIDATION_FAILED");
    expect(code(repo.createAuthSession({ userId: "11111111-1111-4111-8111-111111111111", tokenHash: hex(1), expiresAt: future }, T0))).toBe("NOT_FOUND");
    expect(code(repo.createAuthSession({ userId: "bad", tokenHash: hex(1), expiresAt: future }, T0))).toBe("NOT_FOUND");
    mustCreateSession(repo, user.id, 1);
    expect(code(repo.createAuthSession({ userId: user.id, tokenHash: hex(1), expiresAt: future }, T0))).toBe("DUPLICATE");
    expect(db.query("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 1 });
  });

  test("userAgent is exposed on every session read (null when absent)", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    repo.createAuthSession({ userId: user.id, tokenHash: hex(1), expiresAt: "2026-12-07T12:00:00.000Z", userAgent: "UA/2" }, T0);
    const noUa = repo.createAuthSession({ userId: user.id, tokenHash: hex(2), expiresAt: "2026-12-07T12:00:00.000Z", userAgent: "" }, T0);
    expect(noUa.ok && noUa.value.userAgent).toBeNull();
    expect(repo.findAuthSessionByTokenHash(hex(1), T0)?.userAgent).toBe("UA/2");
    expect(repo.findAuthSessionByTokenHash(hex(2), T0)?.userAgent).toBeNull();
    expect(repo.listActiveSessions(user.id, T0).map((s) => s.userAgent).sort()).toEqual(["UA/2", null].sort());
  });

  test("user agent is optional and capped", () => {
    const { db, repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    repo.createAuthSession({ userId: user.id, tokenHash: hex(1), expiresAt: "2026-12-07T12:00:00.000Z", userAgent: "x".repeat(2000) }, T0);
    repo.createAuthSession({ userId: user.id, tokenHash: hex(2), expiresAt: "2026-12-07T12:00:00.000Z" }, T0);
    const rows = db.query<{ len: number | null }, []>("SELECT length(user_agent) AS len FROM auth_sessions ORDER BY token_hash").all();
    expect(rows).toEqual([{ len: 512 }, { len: null }]);
  });

  test("findAuthSessionByTokenHash: live only; expired and revoked return null (injected clock)", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const live = mustCreateSession(repo, user.id, 1, T0 + DAY);
    const revoked = mustCreateSession(repo, user.id, 2, T0 + DAY);
    repo.revokeAuthSession(revoked.id, T0 + 1);

    expect(repo.findAuthSessionByTokenHash(hex(1), T0 + HOUR)).toEqual(live);
    expect(repo.findAuthSessionByTokenHash(hex(1), T0 + DAY - 1)).toEqual(live);
    expect(repo.findAuthSessionByTokenHash(hex(1), T0 + DAY)).toBeNull(); // expires_at > now is strict
    expect(repo.findAuthSessionByTokenHash(hex(1), T0 + 2 * DAY)).toBeNull();
    expect(repo.findAuthSessionByTokenHash(hex(2), T0 + HOUR)).toBeNull();
    expect(repo.findAuthSessionByTokenHash(hex(99), T0)).toBeNull();
  });

  test("token hash lookups accept only 64 lower-case hex characters", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    mustCreateSession(repo, user.id, 1);
    expect(isTokenHash(hex(1))).toBe(true);
    for (const bad of [hex(1).toUpperCase().replace(/0/g, "F"), hex(1).slice(1), `${hex(1)}0`, "%", "' OR 1=1 --", "", `${"g".repeat(64)}`]) {
      expect(isTokenHash(bad)).toBe(false);
      expect(repo.findAuthSessionByTokenHash(bad, T0)).toBeNull();
    }
    expect(isTokenHash(undefined)).toBe(false);
  });

  test("malformed token hash never reaches the database", () => {
    const { db } = setup();
    let queries = 0;
    const counting = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query" || prop === "prepare") {
          return (...args: Parameters<Database["query"]>) => {
            queries++;
            return target.query(...args);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const repo = createAuthRepository(counting);
    expect(repo.findAuthSessionByTokenHash("short", T0)).toBeNull();
    expect(repo.findAuthSessionByTokenHash("Z".repeat(64), T0)).toBeNull();
    expect(queries).toBe(0);
    repo.findAuthSessionByTokenHash(hex(1), T0);
    expect(queries).toBe(1);
  });

  test("touchAuthSession updates last_seen_at on live sessions only", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const s = mustCreateSession(repo, user.id, 1);
    repo.touchAuthSession(s.id, T0 + HOUR);
    expect(repo.findAuthSessionByTokenHash(hex(1), T0 + HOUR)?.lastSeenAt).toBe("2026-11-07T13:00:00.000Z");
    repo.revokeAuthSession(s.id, T0 + 2 * HOUR);
    repo.touchAuthSession(s.id, T0 + 3 * HOUR);
    repo.touchAuthSession("bad", T0);
    expect(repo.listActiveSessions(user.id, T0)).toEqual([]);
  });

  test("revokeAuthSession is idempotent and keeps the first revocation time", () => {
    const { db, repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const s = mustCreateSession(repo, user.id, 1);
    repo.revokeAuthSession(s.id, T0 + HOUR);
    repo.revokeAuthSession(s.id, T0 + 2 * HOUR);
    repo.revokeAuthSession("bad", T0);
    expect(db.query("SELECT revoked_at FROM auth_sessions").get()).toEqual({ revoked_at: "2026-11-07T13:00:00.000Z" });
  });

  test("revokeAllForUser and revokeOthers leave other users' sessions untouched", () => {
    const { repo } = setup();
    const a = mustCreateUser(repo, "a@example.com");
    const b = mustCreateUser(repo, "b@example.com");
    const a1 = mustCreateSession(repo, a.id, 1);
    mustCreateSession(repo, a.id, 2);
    mustCreateSession(repo, a.id, 3);
    const b1 = mustCreateSession(repo, b.id, 4);
    const b2 = mustCreateSession(repo, b.id, 5);

    expect(repo.revokeOthers(a.id, a1.id, T0 + 1)).toBe(2);
    expect(repo.listActiveSessions(a.id, T0 + 2).map((s) => s.id)).toEqual([a1.id]);
    expect(repo.listActiveSessions(b.id, T0 + 2)).toHaveLength(2);
    // Another user's session id as "keep" does not protect or touch it.
    expect(repo.revokeOthers(a.id, b1.id, T0 + 3)).toBe(1);
    expect(repo.listActiveSessions(a.id, T0 + 4)).toEqual([]);
    expect(repo.findAuthSessionByTokenHash(hex(4), T0 + 4)?.id).toBe(b1.id);

    expect(repo.revokeAllForUser(a.id, T0 + 5)).toBe(0);
    expect(repo.revokeAllForUser(b.id, T0 + 5)).toBe(2);
    expect(repo.findAuthSessionByTokenHash(hex(5), T0 + 6)).toBeNull();
    expect(repo.revokeAllForUser(b.id, T0 + 7)).toBe(0); // idempotent
    expect(b2.revokedAt).toBeNull();
    expect(repo.revokeAllForUser("bad", T0)).toBe(0);
    expect(repo.revokeOthers("bad", a1.id, T0)).toBe(0);
  });

  test("revokeAllForUser leaves other users untouched (fresh two-user fixture)", () => {
    const { repo } = setup();
    const a = mustCreateUser(repo, "a@example.com");
    const b = mustCreateUser(repo, "b@example.com");
    mustCreateSession(repo, a.id, 1);
    mustCreateSession(repo, b.id, 2);
    expect(repo.revokeAllForUser(a.id, T0 + 1)).toBe(1);
    expect(repo.findAuthSessionByTokenHash(hex(1), T0 + 2)).toBeNull();
    expect(repo.findAuthSessionByTokenHash(hex(2), T0 + 2)?.userId).toBe(b.id);
  });

  test("listActiveSessions excludes revoked and expired, most recently seen first", () => {
    const { repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const older = mustCreateSession(repo, user.id, 1);
    const newer = mustCreateSession(repo, user.id, 2);
    mustCreateSession(repo, user.id, 3, T0 + HOUR);
    const revoked = mustCreateSession(repo, user.id, 4);
    repo.revokeAuthSession(revoked.id, T0);
    repo.touchAuthSession(newer.id, T0 + 2 * HOUR);
    repo.touchAuthSession(older.id, T0 + 3 * HOUR);
    expect(repo.listActiveSessions(user.id, T0 + 4 * HOUR).map((s) => s.id)).toEqual([older.id, newer.id]);
    expect(repo.listActiveSessions("bad", T0)).toEqual([]);
  });

  test("purgeExpiredSessions deletes old revoked/expired rows and leaves live sessions", () => {
    const { db, repo } = setup();
    const user = mustCreateUser(repo, "ada@example.com");
    const now = T0 + 60 * DAY;
    const live = mustCreateSession(repo, user.id, 1, now + DAY, T0); // live at `now`
    mustCreateSession(repo, user.id, 2, T0 + DAY, T0); // expired 59 days before `now`: purged
    mustCreateSession(repo, user.id, 3, now - DAY, T0); // expired 1 day ago: kept (within 30 days)
    const oldRevoked = mustCreateSession(repo, user.id, 4, now + DAY, T0);
    repo.revokeAuthSession(oldRevoked.id, T0 + DAY); // revoked 59 days ago: purged
    const recentRevoked = mustCreateSession(repo, user.id, 5, now + DAY, T0);
    repo.revokeAuthSession(recentRevoked.id, now - DAY); // kept

    expect(repo.purgeExpiredSessions(now)).toBe(2);
    const remaining = db
      .query<{ token_hash: string }, []>("SELECT token_hash FROM auth_sessions ORDER BY token_hash")
      .all()
      .map((r) => r.token_hash);
    expect(remaining).toEqual([hex(1), hex(3), hex(5)]);
    expect(repo.findAuthSessionByTokenHash(hex(1), now)).toEqual(live);

    // Window 0 purges everything dead, never live sessions; negative windows are clamped.
    expect(repo.purgeExpiredSessions(now, -10 * DAY)).toBe(2);
    expect(repo.listActiveSessions(user.id, now).map((s) => s.id)).toEqual([live.id]);
    expect(repo.purgeExpiredSessions(now, 0)).toBe(0);
  });
});
