import type { Database } from "bun:sqlite";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import type { User } from "@/lib/types";
import { recomputeProductRating } from "@/server/catalog/product-repository";
import { getDatabase, withTransaction } from "@/server/db/client";
import { isSessionId } from "@/server/session/session-id";
import { createAccountRepository } from "./account-repository";
import { createAuthRepository } from "./auth-repository";
import { getAuthService } from "./auth-service";
import { argon2idHasher, normalizeDisplayName, validatePassword } from "./password-policy";

export { DELETED_MARKER, DELETED_OWNER_KEY } from "./account-repository";

/**
 * Account lifecycle (T118, server-only): display name, password change,
 * account deletion with anonymisation. Credential checks, hashing and the
 * password policy come from the auth service (T116) as injected functions, so
 * this module never sees a stored hash and tests can pass fast fakes.
 *
 * Never logs, returns or throws a password, a hash or an owner key. Unexpected
 * database errors are logged as `{ name, code }` only and rethrown.
 */

export interface AccountServiceDeps {
  readonly db: Database;
  /** T116 `authService.verifyPassword`: INVALID_CREDENTIALS (counts toward lockout), ACCOUNT_LOCKED, NOT_FOUND. */
  readonly verifyPassword: (userId: string, password: unknown, now?: number) => Promise<Result<void, AppError>>;
  /** T116 `argon2idHasher.hash`. */
  readonly hashPassword: (password: string) => Promise<string>;
  /** T116 `validatePassword`: returns the (unaltered) password or VALIDATION_FAILED. */
  readonly validatePassword: (raw: unknown, ctx: { email?: string }) => Result<string, AppError>;
  /** T115 `authRepository.revokeOthers`. */
  readonly revokeOthers: (userId: string, keepSessionId: string, now?: number) => number;
  readonly now?: () => number;
  readonly logger?: Pick<Console, "error" | "warn">;
}

export interface DeletionSummary {
  /**
   * Rows hard-deleted per table: carts, cart_items, lists, list_items,
   * product_views, review_votes (cast by the user), question_votes,
   * answer_votes, reviews, review_votes_cascaded (others' votes on the deleted
   * reviews), stock_alerts, contact_messages, addresses, coupon_redemptions
   * (only those the tombstone could not take), auth_sessions, users.
   */
  readonly deletedRows: Readonly<Record<string, number>>;
  readonly anonymisedOrders: number;
  readonly recomputedProducts: number;
  /** Additions beyond the T121 contract (informational). */
  readonly anonymisedQuestions: number;
  readonly anonymisedAnswers: number;
  readonly rekeyedCouponRedemptions: number;
}

export interface AccountService {
  /**
   * Cleans (T116 `normalizeDisplayName` = `cleanText` 1..50) and stores the account display name. Existing
   * reviews / questions / answers keep the `display_name` snapshot they were
   * posted with; only new posts use the new name.
   * Errors: VALIDATION_FAILED `details.fields.displayName` (code REQUIRED or
   * TOO_LONG), NOT_FOUND.
   */
  updateDisplayName(userId: string, raw: unknown, now?: number): Promise<Result<User, AppError>>;
  /**
   * verifyPassword(current) -> validatePassword(new, { email }) -> new !==
   * current -> hash -> store + revoke every other session except
   * `keepSessionId` (one transaction).
   * Errors: UNAUTHENTICATED (malformed keepSessionId, checked first), NOT_FOUND,
   * INVALID_CREDENTIALS (`details.fields.currentPassword`), VALIDATION_FAILED
   * (`details.fields.currentPassword` REQUIRED: missing current password), ACCOUNT_LOCKED,
   * VALIDATION_FAILED (`details.fields.newPassword`, code from the policy or
   * SAME_AS_CURRENT).
   */
  changePassword(
    userId: string,
    currentPassword: unknown,
    newPassword: unknown,
    keepSessionId: string,
    now?: number,
  ): Promise<Result<void, AppError>>;
  /**
   * verifyPassword, then ONE transaction: purge owner-keyed rows (see README
   * T118 table), recompute ratings of affected products, revoke and delete
   * auth sessions, delete the user.
   * Errors: NOT_FOUND, INVALID_CREDENTIALS (`details.fields.password`),
   * ACCOUNT_LOCKED. Database failures roll back everything and are rethrown.
   */
  deleteAccount(userId: string, password: unknown, now?: number): Promise<Result<DeletionSummary, AppError>>;
}

interface FieldError {
  readonly code: string;
  readonly message: string;
}

class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.code);
  }
}

/** Safe description of a thrown value: error name and SQLite code only, never its message. */
function describeError(e: unknown): { name: string; code?: string } {
  if (e instanceof Error) {
    const code = (e as Error & { code?: unknown }).code;
    return typeof code === "string" ? { name: e.name, code } : { name: e.name };
  }
  return { name: typeof e };
}

function fieldFailure(field: string, error: FieldError, message = "Some fields are invalid."): Result<never, AppError> {
  return fail("VALIDATION_FAILED", message, { fields: { [field]: error } });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Field error for the new password from whatever shape the policy returned:
 * `details.fields.<any>` `{ code, message }` if present, else `details.reason`
 * / `details.code`, else a generic INVALID. Only codes and the policy's
 * message are copied (the policy never echoes the password).
 */
function newPasswordError(error: AppError): FieldError {
  const details = error.details;
  if (isRecord(details)) {
    const fields = details.fields;
    if (isRecord(fields)) {
      for (const value of Object.values(fields)) {
        if (isRecord(value) && typeof value.code === "string" && typeof value.message === "string") {
          return { code: value.code, message: value.message };
        }
      }
    }
    for (const key of ["reason", "code"] as const) {
      const value = details[key];
      if (typeof value === "string") return { code: value, message: error.message };
    }
  }
  return { code: "INVALID", message: error.message };
}

/**
 * Puts a verifyPassword error on the form's field: INVALID_CREDENTIALS gets
 * `details.fields.<field>` (other details such as retryAfterSeconds kept);
 * VALIDATION_FAILED (T116 returns it, uncounted, for a missing password)
 * has its field error moved to `<field>`. Other codes pass through.
 */
function credentialError(error: AppError, field: string): AppError {
  if (error.code === "INVALID_CREDENTIALS") {
    return {
      ...error,
      details: { ...error.details, fields: { [field]: { code: error.code, message: error.message } } },
    };
  }
  if (error.code === "VALIDATION_FAILED") {
    return { ...error, details: { fields: { [field]: newPasswordError(error) } } };
  }
  return error;
}

export function createAccountService(deps: AccountServiceDeps): AccountService {
  const { db } = deps;
  const clock = deps.now ?? Date.now;
  const logger = deps.logger ?? console;
  const auth = createAuthRepository(db);
  const accounts = createAccountRepository(db);

  return {
    async updateDisplayName(userId, raw, now = clock()) {
      // T116 policy: cleanText 1..50 -> VALIDATION_FAILED details.fields.displayName (REQUIRED | TOO_LONG).
      const cleaned = normalizeDisplayName(raw);
      if (!cleaned.ok) return cleaned;
      return auth.updateDisplayName(userId, cleaned.value, now);
    },

    async changePassword(userId, currentPassword, newPassword, keepSessionId, now = clock()) {
      // Without a valid current session there is nothing to keep; refusing
      // here (before verify) means a bad caller never burns a lockout attempt.
      if (!isSessionId(keepSessionId)) return fail("UNAUTHENTICATED", "Please sign in again.");
      const user = auth.findUserById(userId);
      if (user === null) return fail("NOT_FOUND", "Account not found.");

      const verified = await deps.verifyPassword(userId, currentPassword, now);
      if (!verified.ok) return { ok: false, error: credentialError(verified.error, "currentPassword") };

      const policy = deps.validatePassword(newPassword, { email: user.email });
      if (!policy.ok) return fieldFailure("newPassword", newPasswordError(policy.error));
      if (policy.value === currentPassword) {
        return fieldFailure("newPassword", {
          code: "SAME_AS_CURRENT",
          message: "Choose a password that is different from your current one.",
        });
      }

      const hash = await deps.hashPassword(policy.value);
      try {
        return withTransaction(db, () => {
          const stored = auth.updatePasswordHash(userId, hash, now);
          if (!stored.ok) throw new Abort(stored.error);
          deps.revokeOthers(userId, keepSessionId, now);
          return ok(undefined);
        });
      } catch (e) {
        if (e instanceof Abort) return { ok: false, error: e.error };
        logger.error("account: password change failed", describeError(e));
        throw e;
      }
    },

    async deleteAccount(userId, password, now = clock()) {
      const user = auth.findUserById(userId);
      if (user === null) return fail("NOT_FOUND", "Account not found.");

      const verified = await deps.verifyPassword(userId, password, now);
      if (!verified.ok) return { ok: false, error: credentialError(verified.error, "password") };

      try {
        const summary = withTransaction(db, (): DeletionSummary => {
          // Re-read inside the lock: a concurrent delete may have won.
          const current = auth.findUserById(userId);
          if (current === null) throw new Abort({ code: "NOT_FOUND", message: "Account not found." });

          const purged = accounts.purgeOwnerData(current.ownerKey);
          // Triggers already adjusted the aggregates; recompute is the safety net.
          for (const productId of purged.affectedProductIds) recomputeProductRating(db, productId);

          const authSessions = accounts.countAuthSessions(userId);
          auth.revokeAllForUser(userId, now);
          const removed = auth.deleteUser(userId); // auth_sessions cascade
          if (!removed.ok) throw new Abort(removed.error);

          return {
            deletedRows: { ...purged.deletedRows, auth_sessions: authSessions, users: 1 },
            anonymisedOrders: purged.anonymisedOrders,
            recomputedProducts: purged.affectedProductIds.length,
            anonymisedQuestions: purged.anonymisedQuestions,
            anonymisedAnswers: purged.anonymisedAnswers,
            rekeyedCouponRedemptions: purged.rekeyedCouponRedemptions,
          };
        });
        return ok(summary);
      } catch (e) {
        if (e instanceof Abort) return { ok: false, error: e.error };
        logger.error("account: deletion failed (rolled back)", describeError(e));
        throw e;
      }
    },
  };
}

const globalForAccount = globalThis as typeof globalThis & {
  __storefrontAccountService?: { db: Database; service: AccountService };
};

/** App-wide service over the shared database, cached on `globalThis` (rebuilt if the DB handle changes). */
export function getAccountService(): AccountService {
  const db = getDatabase();
  const cached = globalForAccount.__storefrontAccountService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createAccountService(productionDeps(db));
  globalForAccount.__storefrontAccountService = { db, service };
  return service;
}

/** Production wiring: T116 auth service (same `getDatabase()` handle), argon2id, T116 policy, T115 revokeOthers. */
function productionDeps(db: Database): AccountServiceDeps {
  const repo = createAuthRepository(db);
  return {
    db,
    verifyPassword: (userId, password, now) => getAuthService().verifyPassword(userId, password, now),
    hashPassword: (password) => argon2idHasher.hash(password),
    validatePassword,
    revokeOthers: (userId, keepSessionId, now) => repo.revokeOthers(userId, keepSessionId, now),
  };
}
