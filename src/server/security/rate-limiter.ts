import type { Database } from "bun:sqlite";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import { getDatabase } from "@/server/db/client";
import { isSessionId } from "@/server/session/session-id";

/**
 * Fixed-window rate limiter over the `rate_limits` table (migration 2).
 *
 * One atomic statement per rule: an upsert that increments the counter for
 * `(key, window_start)` and returns the new count. A call is admitted when
 * that count is <= the rule's limit. Over-limit calls still bump the counter
 * (harmless: it only ever makes the current window stricter).
 *
 * Stored key: `${windowSeconds}:${key}`. The window prefix keeps two rules
 * with the same logical key apart (contact.submit has an hourly and a daily
 * rule on one session key, and a day window always starts on an hour
 * boundary), and lets the purge target one window size via a PK range scan.
 *
 * Purge bound: on the first hit of a window (returned count 1) and on every
 * 100th check, rows of the same window size with
 * `window_start < currentWindowStart - windowSeconds` are deleted, so only
 * the current and previous windows survive. Because every new row triggers a
 * purge, the table never holds more rows per window size than the number of
 * distinct keys seen in the current plus previous window.
 *
 * Clock: `now()` returns epoch milliseconds (`Date.now` by default).
 * Fail closed: any database error returns RATE_LIMITED with
 * `retryAfterSeconds = windowSeconds` and logs only the action part of the key.
 */

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitOk {
  readonly remaining: number;
}

export interface RateLimiter {
  check(key: string, rule: RateLimitRule): Result<RateLimitOk, AppError>;
}

export interface RateLimiterOptions {
  /** Epoch milliseconds. */
  readonly now?: () => number;
  readonly logger?: Pick<Console, "error">;
}

/** A purge also runs on every PURGE_EVERY-th check, besides each window's first hit. */
export const PURGE_EVERY = 100;

const UPSERT_SQL =
  "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) " +
  "ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count";

// Range over the PK: keys from "<w>:" (inclusive) to "<w>;" (exclusive; ';' follows ':').
const PURGE_SQL = "DELETE FROM rate_limits WHERE key >= ? AND key < ? AND window_start < ?";

function assertRule(rule: RateLimitRule): void {
  if (!Number.isSafeInteger(rule.limit) || rule.limit < 1) {
    throw new RangeError("RateLimitRule.limit must be a positive integer");
  }
  if (!Number.isSafeInteger(rule.windowSeconds) || rule.windowSeconds < 1) {
    throw new RangeError("RateLimitRule.windowSeconds must be a positive integer");
  }
}

/** The part of a key before the first ':' (the action name); never the session id. */
function actionOf(key: string): string {
  const i = key.indexOf(":");
  return (i === -1 ? key : key.slice(0, i)).slice(0, 64);
}

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const codeValue = (error as { code?: unknown }).code;
    if (typeof codeValue === "string") return codeValue;
    if (error instanceof Error) return error.name;
  }
  return "unknown";
}

function rateLimited(retryAfterSeconds: number): Result<RateLimitOk, AppError> {
  return fail("RATE_LIMITED", "Too many attempts. Please wait and try again.", { retryAfterSeconds });
}

class SqliteRateLimiter implements RateLimiter {
  private readonly db: Database;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "error">;
  private checks = 0;

  constructor(db: Database, options: RateLimiterOptions) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
  }

  check(key: string, rule: RateLimitRule): Result<RateLimitOk, AppError> {
    assertRule(rule);
    const { limit, windowSeconds } = rule;
    const nowSeconds = Math.floor(this.now() / 1000);
    const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
    const storedKey = `${windowSeconds}:${key}`;

    let count: number;
    try {
      const row = this.db.query<{ count: number }, [string, number]>(UPSERT_SQL).get(storedKey, windowStart);
      if (row === null || typeof row.count !== "number") throw new TypeError("rate limiter upsert returned no count");
      count = row.count;
    } catch (error) {
      this.log(`rate limiter: database error (${errorName(error)}) for action "${actionOf(key)}"; failing closed`);
      return rateLimited(windowSeconds);
    }

    this.checks = (this.checks + 1) % PURGE_EVERY;
    if (count === 1 || this.checks === 0) this.purge(windowSeconds, windowStart, key);

    if (count > limit) {
      // nowSeconds lies in [windowStart, windowStart + windowSeconds), so this is 1..windowSeconds.
      return rateLimited(windowStart + windowSeconds - nowSeconds);
    }
    return ok({ remaining: limit - count });
  }

  private purge(windowSeconds: number, windowStart: number, key: string): void {
    try {
      this.db
        .query<unknown, [string, string, number]>(PURGE_SQL)
        .run(`${windowSeconds}:`, `${windowSeconds};`, windowStart - windowSeconds);
    } catch (error) {
      // The check itself already counted; a failed purge only delays cleanup.
      this.log(`rate limiter: purge failed (${errorName(error)}) for action "${actionOf(key)}"`);
    }
  }

  private log(message: string): void {
    try {
      this.logger.error(message);
    } catch {
      // Logging must never change the limiter's answer.
    }
  }
}

export function createRateLimiter(db: Database, options: RateLimiterOptions = {}): RateLimiter {
  return new SqliteRateLimiter(db, options);
}

// ---------------------------------------------------------------------------
// Action rules (BACKLOG-phase2.md section 0, "Rate limits")
// ---------------------------------------------------------------------------

export type RateLimitedAction =
  | "review.submit"
  | "vote"
  | "question.ask"
  | "answer.post"
  | "contact.submit"
  | "stock_alert.subscribe"
  | "coupon.apply"
  | "address.write"
  | "list.mutate"
  | "search.suggest"
  // Accounts epic (keyed per session, per email digest, or per user owner_key).
  | "auth.signin.session"
  | "auth.signin.email"
  | "auth.signup"
  | "account.changePassword"
  | "account.delete"
  | "account.updateProfile";

export interface ActionRateLimit {
  readonly perSession: RateLimitRule | readonly RateLimitRule[];
  readonly global: RateLimitRule | null;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

export const RATE_LIMIT_RULES: Readonly<Record<RateLimitedAction, ActionRateLimit>> = Object.freeze({
  "review.submit": { perSession: { limit: 5, windowSeconds: HOUR }, global: { limit: 300, windowSeconds: HOUR } },
  vote: { perSession: { limit: 60, windowSeconds: HOUR }, global: { limit: 3000, windowSeconds: HOUR } },
  "question.ask": { perSession: { limit: 5, windowSeconds: HOUR }, global: { limit: 300, windowSeconds: HOUR } },
  "answer.post": { perSession: { limit: 10, windowSeconds: HOUR }, global: { limit: 300, windowSeconds: HOUR } },
  "contact.submit": {
    perSession: [
      { limit: 3, windowSeconds: HOUR },
      { limit: 10, windowSeconds: DAY },
    ],
    global: { limit: 200, windowSeconds: HOUR },
  },
  "stock_alert.subscribe": {
    perSession: { limit: 10, windowSeconds: HOUR },
    global: { limit: 500, windowSeconds: HOUR },
  },
  "coupon.apply": {
    perSession: { limit: 10, windowSeconds: 10 * MINUTE },
    global: { limit: 1000, windowSeconds: 10 * MINUTE },
  },
  "address.write": { perSession: { limit: 20, windowSeconds: DAY }, global: null },
  "list.mutate": { perSession: { limit: 120, windowSeconds: HOUR }, global: null },
  "search.suggest": { perSession: { limit: 120, windowSeconds: MINUTE }, global: { limit: 3000, windowSeconds: MINUTE } },
  "auth.signin.session": {
    perSession: { limit: 10, windowSeconds: 15 * MINUTE },
    global: { limit: 1000, windowSeconds: 15 * MINUTE },
  },
  /** Key: SHA-256 hex of the lower-cased email (keyKind "opaque"). */
  "auth.signin.email": { perSession: { limit: 10, windowSeconds: 15 * MINUTE }, global: null },
  "auth.signup": { perSession: { limit: 5, windowSeconds: HOUR }, global: { limit: 100, windowSeconds: HOUR } },
  /** User-keyed actions: key is the user's owner_key UUID. */
  "account.changePassword": { perSession: { limit: 5, windowSeconds: 15 * MINUTE }, global: null },
  "account.delete": { perSession: { limit: 5, windowSeconds: HOUR }, global: null },
  "account.updateProfile": { perSession: { limit: 20, windowSeconds: HOUR }, global: null },
});

/**
 * How `limitAction` validates its key argument:
 * - "session": canonical lowercase UUID v4 (session ids, user owner_keys);
 * - "opaque": a 64-char hex string such as a SHA-256 digest (normalised to lower case).
 * Anything that does not match is bucketed as "anon".
 */
export type RateLimitKeyKind = "session" | "opaque";

export interface LimitActionOptions {
  /** Defaults to "opaque" for "auth.signin.email" and "session" for every other action. */
  readonly keyKind?: RateLimitKeyKind;
}

const OPAQUE_KEY_RE = /^[0-9a-fA-F]{64}$/;

function defaultKeyKind(action: RateLimitedAction): RateLimitKeyKind {
  return action === "auth.signin.email" ? "opaque" : "session";
}

function normaliseKey(key: string | null, kind: RateLimitKeyKind): string {
  if (kind === "opaque") {
    // Length is checked by the anchored {64} quantifier; no backtracking.
    return typeof key === "string" && key.length === 64 && OPAQUE_KEY_RE.test(key) ? key.toLowerCase() : "anon";
  }
  return isSessionId(key) ? key : "anon";
}

function asArray(rules: RateLimitRule | readonly RateLimitRule[]): readonly RateLimitRule[] {
  return Array.isArray(rules) ? (rules as readonly RateLimitRule[]) : [rules as RateLimitRule];
}

/**
 * Applies every rule for `action`: the per-session rule(s) on
 * `${action}:${sessionId ?? "anon"}`, then the global backstop on
 * `${action}:*`. Stops at the first failure and returns it; otherwise returns
 * the smallest `remaining`. A key that does not match `keyKind` (UUID v4 for
 * "session", 64-char hex for "opaque") is treated as "anon", so a crafted id
 * such as "*" cannot alias the global key.
 */
export function limitAction(
  limiter: RateLimiter,
  action: RateLimitedAction,
  sessionId: string | null,
  options: LimitActionOptions = {},
): Result<RateLimitOk, AppError> {
  const config = RATE_LIMIT_RULES[action];
  const keyKind = options.keyKind ?? defaultKeyKind(action);
  const sessionKey = `${action}:${normaliseKey(sessionId, keyKind)}`;
  let remaining = Number.POSITIVE_INFINITY;
  for (const rule of asArray(config.perSession)) {
    const result = limiter.check(sessionKey, rule);
    if (!result.ok) return result;
    remaining = Math.min(remaining, result.value.remaining);
  }
  if (config.global !== null) {
    const result = limiter.check(`${action}:*`, config.global);
    if (!result.ok) return result;
    remaining = Math.min(remaining, result.value.remaining);
  }
  return ok({ remaining });
}

// ---------------------------------------------------------------------------
// App wiring
// ---------------------------------------------------------------------------

interface RateLimiterCache {
  readonly db: Database;
  readonly limiter: RateLimiter;
}

const globalForRateLimiter = globalThis as typeof globalThis & {
  __storefrontRateLimiter?: RateLimiterCache;
};

/**
 * The app-wide limiter over `getDatabase()`, cached on `globalThis` (dev HMR
 * safe). Rebuilt if the shared database handle changes.
 */
export function getRateLimiter(): RateLimiter {
  const db = getDatabase();
  const cached = globalForRateLimiter.__storefrontRateLimiter;
  if (cached !== undefined && cached.db === db) return cached.limiter;
  const limiter = createRateLimiter(db);
  globalForRateLimiter.__storefrontRateLimiter = { db, limiter };
  return limiter;
}
