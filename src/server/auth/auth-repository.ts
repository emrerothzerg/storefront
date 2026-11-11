import type { Database } from "bun:sqlite";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import type { AuthSession, IsoDateTimeString, User } from "@/lib/types";
import { isSessionId } from "@/server/session/session-id";

/**
 * Accounts persistence (server-only): every SQL statement that touches `users`
 * and `auth_sessions`. Bound parameters only. No hashing, no cookies, no
 * policy (password rules, rate limits, lockout decisions): those belong to the
 * auth service (T116). This module never logs.
 *
 * Conventions:
 * - `now` is epoch milliseconds (default `Date.now()`); every timestamp is
 *   written as `new Date(now).toISOString()` (same `YYYY-MM-DDTHH:MM:SS.sssZ`
 *   shape as the schema's `strftime` defaults), so string comparison in SQL
 *   is chronological.
 * - User and session ids are UUID v4 (generated here). Reads with a malformed
 *   id return `null`/`[]`/`0` and writes are no-ops (or `NOT_FOUND` where the
 *   contract returns a `Result`), without querying.
 * - `UserCredentialRow` is the ONLY shape carrying `password_hash`; every
 *   other method maps rows to the public `User` (no hash).
 */

/** INTERNAL: the only type that carries the password hash. Never return it to a client. */
export interface UserCredentialRow {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly ownerKey: string;
  readonly failedLoginCount: number;
  readonly lockedUntil: IsoDateTimeString | null;
  readonly lastLoginAt: IsoDateTimeString | null;
  readonly createdAt: IsoDateTimeString;
  readonly updatedAt: IsoDateTimeString;
}

export interface CreateUserInput {
  /** Already trimmed and lower-cased by the service (the repository re-normalises defensively). */
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
}

export interface CreateAuthSessionInput {
  readonly userId: string;
  /** SHA-256 digest of the raw token, 64-char lower-case hex. */
  readonly tokenHash: string;
  readonly expiresAt: IsoDateTimeString;
  readonly userAgent?: string | null;
}

export interface LoginFailureState {
  readonly failedLoginCount: number;
  readonly lockedUntil: IsoDateTimeString | null;
}

export interface AuthRepository {
  createUser(input: CreateUserInput, now?: number): Result<User, AppError>;
  findCredentialsByEmail(email: string): UserCredentialRow | null;
  findUserById(id: string): User | null;
  findUserByOwnerKey(ownerKey: string): User | null;
  updateDisplayName(userId: string, displayName: string, now?: number): Result<User, AppError>;
  updatePasswordHash(userId: string, passwordHash: string, now?: number): Result<void, AppError>;
  recordLoginFailure(userId: string, now?: number, lockThreshold?: number, lockMs?: number): LoginFailureState;
  resetLoginFailures(userId: string, now?: number): void;
  clearExpiredLock(userId: string, now?: number): boolean;
  deleteUser(userId: string): Result<void, AppError>;
  createAuthSession(input: CreateAuthSessionInput, now?: number): Result<AuthSession, AppError>;
  findAuthSessionByTokenHash(tokenHash: string, now?: number): (AuthSession & { readonly userId: string }) | null;
  touchAuthSession(sessionId: string, now?: number): void;
  revokeAuthSession(sessionId: string, now?: number): void;
  revokeAllForUser(userId: string, now?: number): number;
  revokeOthers(userId: string, keepSessionId: string, now?: number): number;
  listActiveSessions(userId: string, now?: number): readonly AuthSession[];
  purgeExpiredSessions(now?: number, olderThanMs?: number): number;
}

/** Consecutive failures that lock an account (default for `recordLoginFailure`). */
export const DEFAULT_LOCK_THRESHOLD = 10;
/** Lock duration in ms (15 minutes). */
export const DEFAULT_LOCK_MS = 15 * 60 * 1000;
/** Revoked/expired sessions older than this are purged (30 days). */
export const DEFAULT_PURGE_OLDER_THAN_MS = 30 * 24 * 60 * 60 * 1000;
/** Stored user agents are cut to this many UTF-16 units (storage bound, not policy). */
export const MAX_USER_AGENT_LENGTH = 512;

const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

/** True for a 64-char lower-case hex string (SHA-256 digest). Length checked before the regex. */
export function isTokenHash(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && TOKEN_HASH_RE.test(value);
}

const isUuid = isSessionId;

function iso(now: number): IsoDateTimeString {
  return new Date(now).toISOString();
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** SQLite error with its extended result code (bun:sqlite sets `code`). */
function sqliteCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isUniqueViolation(error: unknown, column: string): boolean {
  return (
    sqliteCode(error) === "SQLITE_CONSTRAINT_UNIQUE" &&
    error instanceof Error &&
    error.message.includes(column)
  );
}

function isForeignKeyViolation(error: unknown): boolean {
  return sqliteCode(error) === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  owner_key: string;
  created_at: string;
  last_login_at: string | null;
}

interface CredentialRow extends UserRow {
  password_hash: string;
  failed_login_count: number;
  locked_until: string | null;
  updated_at: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  revoked_at: string | null;
  user_agent: string | null;
}

const USER_COLUMNS = "id, email, display_name, owner_key, created_at, last_login_at";
const SESSION_COLUMNS = "id, user_id, created_at, expires_at, last_seen_at, revoked_at, user_agent";

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    ownerKey: row.owner_key,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function toCredentials(row: CredentialRow): UserCredentialRow {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    displayName: row.display_name,
    ownerKey: row.owner_key,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSession(row: SessionRow): AuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    userAgent: row.user_agent,
  };
}

/** Attempts for `createUser` when a generated id/owner_key collides (practically never). */
const MAX_ID_ATTEMPTS = 3;

export function createAuthRepository(db: Database): AuthRepository {
  const selectUserById = (id: string): User | null => {
    const row = db
      .query<UserRow, [string]>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
      .get(id);
    return row === null ? null : toUser(row);
  };

  return {
    createUser(input, now = Date.now()) {
      const email = normaliseEmail(input.email);
      if (email === "") return fail("VALIDATION_FAILED", "Email is required.", { field: "email" });
      const stamp = iso(now);
      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
        const id = globalThis.crypto.randomUUID();
        const ownerKey = globalThis.crypto.randomUUID();
        try {
          const row = db
            .query<UserRow, [string, string, string, string, string, string]>(
              `INSERT INTO users (id, email, password_hash, display_name, owner_key, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
               RETURNING ${USER_COLUMNS}`,
            )
            .get(id, email, input.passwordHash, input.displayName, ownerKey, stamp);
          if (row === null) break;
          return ok(toUser(row));
        } catch (error) {
          if (isUniqueViolation(error, "users.email")) {
            return fail("EMAIL_TAKEN", "An account with this email already exists.");
          }
          if (isUniqueViolation(error, "users.id") || isUniqueViolation(error, "users.owner_key")) {
            continue;
          }
          throw error;
        }
      }
      return fail("VALIDATION_FAILED", "Could not create the account. Please try again.");
    },

    findCredentialsByEmail(email) {
      if (typeof email !== "string") return null;
      const normalised = normaliseEmail(email);
      if (normalised === "") return null;
      const row = db
        .query<CredentialRow, [string]>(
          `SELECT ${USER_COLUMNS}, password_hash, failed_login_count, locked_until, updated_at
             FROM users WHERE email = ?`,
        )
        .get(normalised);
      return row === null ? null : toCredentials(row);
    },

    findUserById(id) {
      if (!isUuid(id)) return null;
      return selectUserById(id);
    },

    findUserByOwnerKey(ownerKey) {
      if (!isUuid(ownerKey)) return null;
      const row = db
        .query<UserRow, [string]>(`SELECT ${USER_COLUMNS} FROM users WHERE owner_key = ?`)
        .get(ownerKey);
      return row === null ? null : toUser(row);
    },

    updateDisplayName(userId, displayName, now = Date.now()) {
      if (!isUuid(userId)) return fail("NOT_FOUND", "Account not found.");
      const row = db
        .query<UserRow, [string, string, string]>(
          `UPDATE users SET display_name = ?2, updated_at = ?3 WHERE id = ?1
           RETURNING ${USER_COLUMNS}`,
        )
        .get(userId, displayName, iso(now));
      return row === null ? fail("NOT_FOUND", "Account not found.") : ok(toUser(row));
    },

    updatePasswordHash(userId, passwordHash, now = Date.now()) {
      if (!isUuid(userId)) return fail("NOT_FOUND", "Account not found.");
      const { changes } = db
        .query<unknown, [string, string, string]>(
          "UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1",
        )
        .run(userId, passwordHash, iso(now));
      return changes === 0 ? fail("NOT_FOUND", "Account not found.") : ok(undefined);
    },

    recordLoginFailure(userId, now = Date.now(), lockThreshold = DEFAULT_LOCK_THRESHOLD, lockMs = DEFAULT_LOCK_MS) {
      if (!isUuid(userId)) return { failedLoginCount: 0, lockedUntil: null };
      // One statement: SET expressions read the pre-update row, so
      // `failed_login_count + 1` in the CASE is the new count.
      const row = db
        .query<{ failed_login_count: number; locked_until: string | null }, [string, number, string, string]>(
          `UPDATE users SET
             failed_login_count = failed_login_count + 1,
             locked_until = CASE WHEN failed_login_count + 1 >= ?2 THEN ?3 ELSE locked_until END,
             updated_at = ?4
           WHERE id = ?1
           RETURNING failed_login_count, locked_until`,
        )
        .get(userId, lockThreshold, iso(now + lockMs), iso(now));
      return row === null
        ? { failedLoginCount: 0, lockedUntil: null }
        : { failedLoginCount: row.failed_login_count, lockedUntil: row.locked_until };
    },

    resetLoginFailures(userId, now = Date.now()) {
      if (!isUuid(userId)) return;
      const stamp = iso(now);
      db.query<unknown, [string, string]>(
        `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ?2, updated_at = ?2
         WHERE id = ?1`,
      ).run(userId, stamp);
    },

    clearExpiredLock(userId, now = Date.now()) {
      if (!isUuid(userId)) return false;
      // Only an EXPIRED lock is cleared (a live lock or no lock: no change);
      // last_login_at is not touched (this is not a successful sign-in).
      const stamp = iso(now);
      return (
        db
          .query<unknown, [string, string]>(
            `UPDATE users SET failed_login_count = 0, locked_until = NULL, updated_at = ?2
              WHERE id = ?1 AND locked_until IS NOT NULL AND locked_until <= ?2`,
          )
          .run(userId, stamp).changes > 0
      );
    },

    deleteUser(userId) {
      if (!isUuid(userId)) return fail("NOT_FOUND", "Account not found.");
      const { changes } = db.query<unknown, [string]>("DELETE FROM users WHERE id = ?").run(userId);
      return changes === 0 ? fail("NOT_FOUND", "Account not found.") : ok(undefined);
    },

    createAuthSession(input, now = Date.now()) {
      if (!isUuid(input.userId)) return fail("NOT_FOUND", "Account not found.");
      if (!isTokenHash(input.tokenHash)) {
        return fail("VALIDATION_FAILED", "Invalid session token.", { field: "tokenHash" });
      }
      const expiresMs = Date.parse(input.expiresAt);
      if (!Number.isFinite(expiresMs) || expiresMs <= now) {
        return fail("VALIDATION_FAILED", "Session expiry must be a future date.", { field: "expiresAt" });
      }
      const userAgent =
        typeof input.userAgent === "string" && input.userAgent !== ""
          ? input.userAgent.slice(0, MAX_USER_AGENT_LENGTH)
          : null;
      const stamp = iso(now);
      try {
        const row = db
          .query<SessionRow, [string, string, string, string, string, string | null]>(
            `INSERT INTO auth_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent)
             VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?6)
             RETURNING ${SESSION_COLUMNS}`,
          )
          .get(globalThis.crypto.randomUUID(), input.userId, input.tokenHash, stamp, iso(expiresMs), userAgent);
        if (row === null) return fail("NOT_FOUND", "Account not found.");
        return ok(toSession(row));
      } catch (error) {
        if (isForeignKeyViolation(error)) return fail("NOT_FOUND", "Account not found.");
        if (isUniqueViolation(error, "auth_sessions.token_hash")) {
          return fail("DUPLICATE", "Session token already in use.");
        }
        throw error;
      }
    },

    findAuthSessionByTokenHash(tokenHash, now = Date.now()) {
      if (!isTokenHash(tokenHash)) return null;
      const row = db
        .query<SessionRow, [string, string]>(
          `SELECT ${SESSION_COLUMNS} FROM auth_sessions
            WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
        )
        .get(tokenHash, iso(now));
      return row === null ? null : toSession(row);
    },

    touchAuthSession(sessionId, now = Date.now()) {
      if (!isUuid(sessionId)) return;
      db.query<unknown, [string, string]>(
        "UPDATE auth_sessions SET last_seen_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
      ).run(sessionId, iso(now));
    },

    revokeAuthSession(sessionId, now = Date.now()) {
      if (!isUuid(sessionId)) return;
      db.query<unknown, [string, string]>(
        "UPDATE auth_sessions SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
      ).run(sessionId, iso(now));
    },

    revokeAllForUser(userId, now = Date.now()) {
      if (!isUuid(userId)) return 0;
      return db
        .query<unknown, [string, string]>(
          "UPDATE auth_sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL",
        )
        .run(userId, iso(now)).changes;
    },

    revokeOthers(userId, keepSessionId, now = Date.now()) {
      if (!isUuid(userId) || !isUuid(keepSessionId)) return 0;
      return db
        .query<unknown, [string, string, string]>(
          `UPDATE auth_sessions SET revoked_at = ?3
            WHERE user_id = ?1 AND id <> ?2 AND revoked_at IS NULL`,
        )
        .run(userId, keepSessionId, iso(now)).changes;
    },

    listActiveSessions(userId, now = Date.now()) {
      if (!isUuid(userId)) return [];
      return db
        .query<SessionRow, [string, string]>(
          `SELECT ${SESSION_COLUMNS} FROM auth_sessions
            WHERE user_id = ?1 AND revoked_at IS NULL AND expires_at > ?2
            ORDER BY last_seen_at DESC, created_at DESC, id`,
        )
        .all(userId, iso(now))
        .map(toSession);
    },

    purgeExpiredSessions(now = Date.now(), olderThanMs = DEFAULT_PURGE_OLDER_THAN_MS) {
      // Clamped so a negative window can never reach live sessions.
      const cutoff = iso(now - Math.max(0, olderThanMs));
      return db
        .query<unknown, [string]>(
          `DELETE FROM auth_sessions
            WHERE (revoked_at IS NOT NULL AND revoked_at < ?1) OR expires_at < ?1`,
        )
        .run(cutoff).changes;
    },
  };
}
