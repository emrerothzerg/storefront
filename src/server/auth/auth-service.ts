import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import type { IsoDateTimeString, User } from "@/lib/types";
import { getDatabase } from "@/server/db/client";
import {
  createRateLimiter,
  getRateLimiter,
  limitAction,
  RATE_LIMIT_RULES,
  type RateLimiter,
  type RateLimitOk,
} from "@/server/security/rate-limiter";
import { createAuthRepository, type AuthRepository, type UserCredentialRow } from "./auth-repository";
import {
  argon2idHasher,
  emailLimiterKey,
  fieldErrors,
  normalizeDisplayName,
  normalizeEmail,
  PASSWORD_MAX,
  validatePassword,
  type AuthFieldErrors,
  type PasswordHasher,
} from "./password-policy";

/**
 * Auth service (T116): sign-up, sign-in, auth-session tokens, lockout.
 * Server-only. SQL lives in the repository (T115); limits in T31's limiter.
 *
 * Secrets (AR1): raw passwords, password hashes, raw tokens and token hashes
 * are never logged, never put into an error, and never returned, except the
 * raw token inside `IssuedSession` (the one value the caller must put into
 * the `sf_auth` cookie). Log lines carry only an operation name and an error
 * class name.
 */

export const AUTH_TOKEN_BYTES = 32;
export const AUTH_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** `purgeExpiredSessions` runs on every PURGE_EVERY_SIGNINS-th successful sign-in. */
export const PURGE_EVERY_SIGNINS = 100;
/** Exact AR2 message for unknown email and wrong password alike. */
export const INVALID_CREDENTIALS_MESSAGE = "Email or password is incorrect";

export interface IssuedSession {
  readonly user: User;
  /** 43-char base64url raw token. Returned ONLY here; the database stores its SHA-256. */
  readonly token: string;
  readonly authSessionId: string;
  readonly expiresAt: IsoDateTimeString;
}

export interface ResolvedAuth {
  readonly user: User;
  readonly authSessionId: string;
  readonly expiresAt: IsoDateTimeString;
}

export interface SignInContext {
  /** Guest `sf_session` id for the per-session limiter; null (or not a UUID v4) shares the "anon" bucket. */
  readonly sessionKey: string | null;
  readonly userAgent?: string | null;
  /** Epoch ms; defaults to the service clock. */
  readonly now?: number;
}

export interface AuthService {
  signUp(
    input: { email: unknown; password: unknown; displayName: unknown },
    ctx: SignInContext,
  ): Promise<Result<IssuedSession, AppError>>;
  signIn(input: { email: unknown; password: unknown }, ctx: SignInContext): Promise<Result<IssuedSession, AppError>>;
  resolveToken(rawToken: unknown, now?: number): ResolvedAuth | null;
  signOut(rawToken: unknown, now?: number): void;
  signOutEverywhere(userId: string, now?: number): number;
  verifyPassword(userId: string, password: unknown, now?: number): Promise<Result<void, AppError>>;
  issueSessionFor(userId: string, ctx: SignInContext): Result<IssuedSession, AppError>;
}

export interface AuthServiceDeps {
  readonly db: Database;
  /** Default `argon2idHasher`; tests may inject a fast one. */
  readonly hasher?: PasswordHasher;
  /** Default `createRateLimiter(db, { now })`. */
  readonly limiter?: RateLimiter;
  /** Epoch ms clock (default `Date.now`). */
  readonly now?: () => number;
  readonly logger?: Pick<Console, "error" | "warn">;
}

/**
 * Real argon2id hash (Bun defaults m=65536,t=2,p=1) of a random value that was
 * discarded after hashing. Unknown-email sign-ins verify against it so the
 * verifier runs exactly once per attempt either way (AR2, PLAN A-27). Nothing
 * verifies true against it in practice.
 */
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,t=2,p=1$2q/zd6vKkl62a6tj1cgnxEpI9UuZcbhjvmUqb/rw9f8$nbe47YPd9YKWtNJJZP4rmUl6L29fVhm7vRgh2duv4h8";

const RAW_TOKEN_LENGTH = 43;
const RAW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** True for a 43-char base64url string (length checked before the regex). */
export function isRawToken(value: unknown): value is string {
  return typeof value === "string" && value.length === RAW_TOKEN_LENGTH && RAW_TOKEN_RE.test(value);
}

/** SHA-256 hex (lower case) of a raw token: the value stored in `auth_sessions.token_hash`. */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/** 32 bytes from `crypto.getRandomValues` -> base64url without padding (43 chars). */
export function generateToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(AUTH_TOKEN_BYTES));
  return Buffer.from(bytes).toString("base64url");
}

function iso(ms: number): IsoDateTimeString {
  return new Date(ms).toISOString();
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function invalidCredentials(): Result<never, AppError> {
  return fail("INVALID_CREDENTIALS", INVALID_CREDENTIALS_MESSAGE);
}

function accountLocked(lockedUntilMs: number, now: number): Result<never, AppError> {
  const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntilMs - now) / 1000));
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return fail(
    "ACCOUNT_LOCKED",
    `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    { retryAfterSeconds },
  );
}

const EMAIL_RULE = RATE_LIMIT_RULES["auth.signin.email"].perSession;
/** Window of the per-email sign-in rule (900 s). */
const EMAIL_WINDOW_SECONDS = Array.isArray(EMAIL_RULE)
  ? (EMAIL_RULE as readonly { windowSeconds: number }[])[0]?.windowSeconds ?? 900
  : (EMAIL_RULE as { windowSeconds: number }).windowSeconds;

/**
 * Ruling on R-10 enumeration: the attempt that uses up the per-email budget
 * fails with ACCOUNT_LOCKED for every email, known or unknown, and
 * `retryAfterSeconds` = seconds left in the fixed limiter window (same
 * formula as the limiter, 1..900), so both results are byte-identical.
 */
function emailBudgetLocked(now: number): Result<never, AppError> {
  const nowSeconds = Math.floor(now / 1000);
  const windowStart = Math.floor(nowSeconds / EMAIL_WINDOW_SECONDS) * EMAIL_WINDOW_SECONDS;
  return accountLocked((windowStart + EMAIL_WINDOW_SECONDS) * 1000, nowSeconds * 1000);
}

/** Epoch ms of a live lock, or null when there is no lock or it has expired. */
function activeLockMs(lockedUntil: IsoDateTimeString | null, now: number): number | null {
  if (lockedUntil === null) return null;
  const ms = Date.parse(lockedUntil);
  return Number.isFinite(ms) && ms > now ? ms : null;
}

function collectFields(...results: Result<unknown, AppError>[]): AuthFieldErrors | null {
  let fields: Record<string, unknown> = {};
  let any = false;
  for (const result of results) {
    if (result.ok) continue;
    any = true;
    const inner = result.error.details?.fields;
    if (typeof inner === "object" && inner !== null) fields = { ...fields, ...(inner as Record<string, unknown>) };
  }
  return any ? (fields as AuthFieldErrors) : null;
}

/** Thrown out of a transaction callback to roll it back while carrying the Result. */
class Rollback {
  constructor(readonly error: Result<never, AppError>) {}
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  const { db } = deps;
  const clock = deps.now ?? Date.now;
  const hasher = deps.hasher ?? argon2idHasher;
  // The default limiter follows the per-call `ctx.now` (set around each sync
  // limitAction call) so one injected instant drives limiter and lockout alike.
  let limiterNow: number | null = null;
  const limiter = deps.limiter ?? createRateLimiter(db, { now: () => limiterNow ?? clock() });
  const logger = deps.logger ?? console;
  const repo: AuthRepository = createAuthRepository(db);
  let successfulSignIns = 0;

  const limit = (
    action: "auth.signup" | "auth.signin.session" | "auth.signin.email",
    key: string | null,
    keyKind: "session" | "opaque",
    now: number,
  ): Result<RateLimitOk, AppError> => {
    limiterNow = now;
    try {
      return limitAction(limiter, action, key, { keyKind });
    } finally {
      limiterNow = null;
    }
  };

  const log = (message: string): void => {
    try {
      logger.error(message);
    } catch {
      // Logging never changes an auth answer.
    }
  };

  /** Never throws; a hasher failure (e.g. a corrupt stored hash) counts as "no match". */
  const safeVerify = async (password: string, hash: string): Promise<boolean> => {
    try {
      return (await hasher.verify(password, hash)) === true;
    } catch (error) {
      log(`auth: password verification failed (${errorName(error)})`);
      return false;
    }
  };

  /** Re-throws hasher failures as a fresh Error with no message detail and no cause (AR1). */
  const safeHash = async (password: string): Promise<string> => {
    try {
      return await hasher.hash(password);
    } catch (error) {
      log(`auth: password hashing failed (${errorName(error)})`);
      throw new Error("Password hashing failed.");
    }
  };

  const issue = (userId: string, userAgent: string | null | undefined, now: number): Result<IssuedSession, AppError> => {
    const user = repo.findUserById(userId);
    if (user === null) return fail("NOT_FOUND", "Account not found.");
    const ua = typeof userAgent === "string" ? userAgent : null;
    // A 256-bit token never collides in practice; one retry covers DUPLICATE anyway.
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = generateToken();
      const created = repo.createAuthSession(
        { userId, tokenHash: hashToken(token), expiresAt: iso(now + AUTH_SESSION_TTL_MS), userAgent: ua },
        now,
      );
      if (created.ok) {
        return ok({ user, token, authSessionId: created.value.id, expiresAt: created.value.expiresAt });
      }
      if (created.error.code !== "DUPLICATE") return created;
    }
    return fail("DUPLICATE", "Could not start a session. Please try again.");
  };

  const maybePurge = (now: number): void => {
    successfulSignIns = (successfulSignIns + 1) % PURGE_EVERY_SIGNINS;
    if (successfulSignIns !== 0) return;
    try {
      repo.purgeExpiredSessions(now);
    } catch (error) {
      log(`auth: session purge failed (${errorName(error)})`);
    }
  };

  /**
   * Lock gate + verification + failure accounting shared by sign-in and
   * verifyPassword. `candidate` null means "cannot match" (over-long input);
   * the verifier still runs once against the dummy hash.
   */
  const checkCredentials = async (
    cred: UserCredentialRow,
    candidate: string | null,
    now: number,
  ): Promise<Result<void, AppError>> => {
    const lockMs = activeLockMs(cred.lockedUntil, now);
    if (lockMs !== null) return accountLocked(lockMs, now);
    // Expired lock: the next attempt starts a fresh count (orchestrator ruling).
    if (cred.lockedUntil !== null) repo.clearExpiredLock(cred.id, now);

    const matched = await safeVerify(candidate ?? "", candidate === null ? DUMMY_PASSWORD_HASH : cred.passwordHash);
    if (!matched || candidate === null) {
      const state = repo.recordLoginFailure(cred.id, now);
      const lockedNow = activeLockMs(state.lockedUntil, now);
      return lockedNow !== null ? accountLocked(lockedNow, now) : invalidCredentials();
    }
    // Re-read synchronously after the async verify: a concurrent failure may
    // have locked the account, or the password may have changed meanwhile.
    const fresh = repo.findCredentialsByEmail(cred.email);
    if (fresh === null || fresh.id !== cred.id || fresh.passwordHash !== cred.passwordHash) {
      return invalidCredentials();
    }
    const freshLock = activeLockMs(fresh.lockedUntil, now);
    if (freshLock !== null) return accountLocked(freshLock, now);
    return ok(undefined);
  };

  return {
    async signUp(input, ctx) {
      const now = ctx.now ?? clock();
      const email = normalizeEmail(input.email);
      const displayName = normalizeDisplayName(input.displayName);
      const password = validatePassword(input.password, { email: email.ok ? email.value : undefined });
      const fields = collectFields(email, password, displayName);
      if (fields !== null || !email.ok || !password.ok || !displayName.ok) return fieldErrors(fields ?? {});

      const limited = limit("auth.signup", ctx.sessionKey, "session", now);
      if (!limited.ok) return limited;

      if (repo.findCredentialsByEmail(email.value) !== null) {
        return fail("EMAIL_TAKEN", "An account with this email already exists.");
      }
      const passwordHash = await safeHash(password.value);

      // User + first session in one transaction: no account without its session.
      try {
        return db.transaction((): Result<IssuedSession, AppError> => {
          const created = repo.createUser({ email: email.value, passwordHash, displayName: displayName.value }, now);
          if (!created.ok) throw new Rollback(created);
          repo.resetLoginFailures(created.value.id, now); // stamps last_login_at
          const issued = issue(created.value.id, ctx.userAgent, now);
          if (!issued.ok) throw new Rollback(issued);
          return issued;
        })();
      } catch (error) {
        if (error instanceof Rollback) return error.error;
        throw error;
      }
    },

    async signIn(input, ctx) {
      const now = ctx.now ?? clock();
      const email = normalizeEmail(input.email);
      const rawPassword = input.password;
      const passwordOk = typeof rawPassword === "string" && rawPassword !== "";
      if (!email.ok || !passwordOk) {
        const fields: Record<string, unknown> = { ...((email.ok ? {} : email.error.details?.fields) ?? {}) };
        if (!passwordOk) fields.password = { code: "REQUIRED", message: "Enter your password." };
        return fieldErrors(fields as AuthFieldErrors);
      }

      // Limiters BEFORE any lookup or hashing; the per-email key counts unknown emails too (R-10).
      const perSession = limit("auth.signin.session", ctx.sessionKey, "session", now);
      if (!perSession.ok) return perSession;
      const perEmail = limit("auth.signin.email", emailLimiterKey(email.value), "opaque", now);
      if (!perEmail.ok) return perEmail;
      // This attempt is the last one the per-email budget allows: any failure
      // below becomes the uniform ACCOUNT_LOCKED (unknown and known alike).
      const lastAllowed = perEmail.value.remaining === 0;

      // A password longer than the policy maximum can never have been stored.
      const candidate = rawPassword.length <= PASSWORD_MAX ? rawPassword : null;
      const cred = repo.findCredentialsByEmail(email.value);
      if (cred === null) {
        await safeVerify(candidate ?? "", DUMMY_PASSWORD_HASH);
        return lastAllowed ? emailBudgetLocked(now) : invalidCredentials();
      }

      const checked = await checkCredentials(cred, candidate, now);
      if (!checked.ok) {
        const uniform =
          lastAllowed && (checked.error.code === "INVALID_CREDENTIALS" || checked.error.code === "ACCOUNT_LOCKED");
        // The real `locked_until` (if any) is kept in the DB either way.
        return uniform ? emailBudgetLocked(now) : checked;
      }
      repo.resetLoginFailures(cred.id, now);
      const issued = issue(cred.id, ctx.userAgent, now);
      if (issued.ok) maybePurge(now);
      return issued;
    },

    resolveToken(rawToken, now = clock()) {
      if (!isRawToken(rawToken)) return null;
      try {
        const session = repo.findAuthSessionByTokenHash(hashToken(rawToken), now);
        if (session === null) return null;
        const user = repo.findUserById(session.userId);
        if (user === null) return null;
        const lastSeen = Date.parse(session.lastSeenAt);
        if (!Number.isFinite(lastSeen) || now - lastSeen >= TOUCH_INTERVAL_MS) {
          try {
            repo.touchAuthSession(session.id, now);
          } catch (error) {
            log(`auth: session touch failed (${errorName(error)})`);
          }
        }
        return { user, authSessionId: session.id, expiresAt: session.expiresAt };
      } catch (error) {
        // Read path (render): never throw; an unreadable session is "signed out".
        log(`auth: token resolution failed (${errorName(error)})`);
        return null;
      }
    },

    signOut(rawToken, now = clock()) {
      if (!isRawToken(rawToken)) return;
      const session = repo.findAuthSessionByTokenHash(hashToken(rawToken), now);
      if (session !== null) repo.revokeAuthSession(session.id, now);
    },

    signOutEverywhere(userId, now = clock()) {
      return repo.revokeAllForUser(userId, now);
    },

    async verifyPassword(userId, password, now = clock()) {
      const user = repo.findUserById(userId);
      if (user === null) return fail("NOT_FOUND", "Account not found.");
      if (typeof password !== "string" || password === "") {
        return fieldErrors({ password: { code: "REQUIRED", message: "Enter your password." } });
      }
      const cred = repo.findCredentialsByEmail(user.email);
      if (cred === null || cred.id !== user.id) return fail("NOT_FOUND", "Account not found.");
      return checkCredentials(cred, password.length <= PASSWORD_MAX ? password : null, now);
    },

    issueSessionFor(userId, ctx) {
      return issue(userId, ctx.userAgent, ctx.now ?? clock());
    },
  };
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

interface AuthServiceCache {
  readonly db: Database;
  readonly service: AuthService;
}

const globalForAuth = globalThis as typeof globalThis & {
  __storefrontAuthService?: AuthServiceCache;
};

/**
 * The app-wide auth service over `getDatabase()` and `getRateLimiter()`,
 * cached on `globalThis` (dev HMR safe; rebuilt if the DB handle changes).
 */
export function getAuthService(): AuthService {
  const db = getDatabase();
  const cached = globalForAuth.__storefrontAuthService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createAuthService({ db, limiter: getRateLimiter() });
  globalForAuth.__storefrontAuthService = { db, service };
  return service;
}
