import { unstable_rethrow } from "next/navigation";
import {
  ACCOUNT_FIELD,
  DELETE_CONFIRM_VALUE,
  DISPLAY_NAME_MAX_LENGTH,
  type AccountActionFn,
  type AccountActionState,
  type AccountFieldName,
} from "@/components/molecules/_contracts/account-actions";
import { appError, type AppError } from "@/lib/result";
import type { User } from "@/lib/types";
import type { AccountService } from "@/server/auth/account-service";
import type { AuthService } from "@/server/auth/auth-service";
import { normalizeDisplayName, validatePassword } from "@/server/auth/password-policy";
import { limitAction, type RateLimitedAction, type RateLimiter } from "@/server/security/rate-limiter";

/**
 * Framework-free account settings action logic (T121). `account.ts` wires it
 * to Next.js (`readResolvedAuth`, cookie helpers, `revalidatePath`,
 * `redirect`, the account/auth services and the limiter); tests inject fakes.
 *
 * Flow of every action:
 * 1. `readResolvedAuth()`. `null` (no, expired, revoked, garbage token or a
 *    deleted user) -> `UNAUTHENTICATED` and nothing else happens.
 * 2. Read ONLY the `ACCOUNT_FIELD` strings (forged `userId`, `ownerKey`,
 *    `sessionId`, `email` are never read; the user comes from step 1).
 * 3. Local checks that need no DB and no password verification (required
 *    fields, display name, new password policy, confirm mismatch, the DELETE
 *    literal). Failures return field errors without spending a rate-limit
 *    token or a lockout attempt.
 * 4. `limitAction(limiter, "account.*", user.ownerKey)` (per user).
 * 5. The service. Its errors are mapped to user-safe states.
 * 6. Success: revalidate (and for delete / sign-out-everywhere clear `sf_auth`,
 *    rotate `sf_session`) best-effort, then `redirect("/")` OUTSIDE the
 *    try/catch so Next's redirect error is never swallowed.
 *
 * Every outcome is a state (or a redirect). Unexpected exceptions become the
 * generic `INTERNAL_ERROR` state and are logged as an error code plus the
 * action name only: never a password, id, email, owner key or token.
 */

export interface AccountActionDeps {
  readonly account: AccountService;
  readonly auth: Pick<AuthService, "signOutEverywhere">;
  readonly limiter: RateLimiter;
  readonly readResolvedAuth: () => Promise<{ user: User; authSessionId: string } | null>;
  readonly clearAuthCookie: () => Promise<void>;
  readonly rotateGuestSession: () => Promise<string>;
  readonly revalidatePath: (path: string, type?: "page" | "layout") => void;
  /** Must throw (Next's `redirect`), never return. */
  readonly redirect: (path: string) => never;
  /** Epoch milliseconds passed to the services; service default when absent. */
  readonly now?: () => number;
  /** Receives only error codes; defaults to `console`. */
  readonly logger?: Pick<Console, "error">;
}

export interface AccountActions {
  readonly updateProfile: AccountActionFn;
  readonly changePassword: AccountActionFn;
  readonly deleteAccount: AccountActionFn;
  readonly signOutEverywhere: AccountActionFn;
}

export type AccountActionName = keyof AccountActions;

/** Logged when an action hits an unexpected exception. */
export const ACCOUNT_ACTION_FAILED = "ACCOUNT_ACTION_FAILED";
/** Logged when a best-effort step after a committed change fails (cookie, revalidation). */
export const ACCOUNT_CLEANUP_FAILED = "ACCOUNT_CLEANUP_FAILED";

export const HOME_PATH = "/";
export const ACCOUNT_PATH = "/account";

export const ACCOUNT_MESSAGES = {
  unauthenticated: "Please sign in.",
  invalid: "Some fields are invalid.",
  internal: "Something went wrong. Please try again.",
  profileUpdated: "Your display name has been updated.",
  passwordChanged: "Your password has been changed. Other devices have been signed out.",
  currentPasswordIncorrect: "Your current password is incorrect.",
  passwordIncorrect: "Your password is incorrect.",
  currentPasswordRequired: "Enter your current password.",
  passwordRequired: "Enter your password.",
  confirmPasswordMismatch: "The passwords do not match.",
  confirmDelete: `Type ${DELETE_CONFIRM_VALUE} to confirm.`,
  tooManyAttemptsFallback: "Too many attempts. Try again later.",
} as const;

const RATE_LIMIT_KEYS = {
  updateProfile: "account.updateProfile",
  changePassword: "account.changePassword",
  deleteAccount: "account.delete",
} as const satisfies Partial<Record<AccountActionName, RateLimitedAction>>;

/** "Too many attempts. Try again in N minutes." (N >= 1, rounded up). */
export function tooManyAttemptsMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return ACCOUNT_MESSAGES.tooManyAttemptsFallback;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * First string value of `name`, or `undefined` for a missing or non-string
 * (File) entry. A non-FormData argument (server actions can be invoked with
 * arbitrary serialised arguments) reads as an empty form.
 */
export function readField(formData: unknown, name: string): string | undefined {
  if (!(formData instanceof FormData)) return undefined;
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Cuts to `max` UTF-16 units without leaving a dangling high surrogate. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

type Values = { readonly displayName?: string };
type FieldErrors = Partial<Record<AccountFieldName, string>>;
type FieldCodes = Partial<Record<AccountFieldName, string>>;

interface FieldIssue {
  readonly code: string;
  readonly message: string;
}

const KNOWN_FIELDS: readonly AccountFieldName[] = Object.keys(ACCOUNT_FIELD) as AccountFieldName[];
/** Field codes copied into `error.details.fields` (anything else becomes INVALID). */
const KNOWN_FIELD_CODES: ReadonlySet<string> = new Set([
  "REQUIRED",
  "TOO_SHORT",
  "TOO_LONG",
  "WEAK",
  "INVALID",
  "SAME_AS_CURRENT",
  "MISMATCH",
  "INVALID_CREDENTIALS",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(error: AppError, values: Values, fieldErrors: FieldErrors = {}, retryAfterSeconds?: number): AccountActionState {
  const base = { ok: false as const, error, message: error.message, fieldErrors, values };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

export function unauthenticatedState(): AccountActionState {
  return failure(appError("UNAUTHENTICATED", ACCOUNT_MESSAGES.unauthenticated), {});
}

/** Generic state for unexpected failures. No internal detail leaves the server. */
export function internalErrorState(values: Values = {}): AccountActionState {
  return failure(appError("INTERNAL_ERROR", ACCOUNT_MESSAGES.internal), values);
}

/** VALIDATION_FAILED with one message per field; `error.details.fields` carries codes only. */
export function fieldErrorState(issues: Partial<Record<AccountFieldName, FieldIssue>>, values: Values): AccountActionState {
  const fieldErrors: FieldErrors = {};
  const codes: FieldCodes = {};
  for (const field of KNOWN_FIELDS) {
    const issue = issues[field];
    if (issue === undefined) continue;
    fieldErrors[field] = issue.message;
    codes[field] = KNOWN_FIELD_CODES.has(issue.code) ? issue.code : "INVALID";
  }
  return failure(appError("VALIDATION_FAILED", ACCOUNT_MESSAGES.invalid, { fields: codes }), values, fieldErrors);
}

/** Positive integer seconds from `details.retryAfterSeconds`, else undefined. */
function readRetryAfter(error: AppError): number | undefined {
  const value = error.details?.retryAfterSeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}

/**
 * RATE_LIMITED and ACCOUNT_LOCKED (ruling R-10, orchestrator 2026-11-07): both
 * map to ONE identical state with `error.code` "RATE_LIMITED", so a locked
 * account is indistinguishable from a rate limit at the action boundary.
 */
export function tooManyAttemptsState(error: AppError, values: Values): AccountActionState {
  const code = "RATE_LIMITED";
  const retryAfterSeconds = readRetryAfter(error);
  const message = tooManyAttemptsMessage(retryAfterSeconds);
  return retryAfterSeconds === undefined
    ? failure(appError(code, message), values)
    : failure(appError(code, message, { retryAfterSeconds }), values, {}, retryAfterSeconds);
}

/** The first `{ code, message }` entry in a service/policy `details.fields`, re-targeted onto `field`. */
function serviceFieldIssue(error: AppError, preferred: string): FieldIssue | undefined {
  const fields = error.details?.fields;
  if (!isRecord(fields)) return undefined;
  const ordered = [fields[preferred], ...Object.values(fields)];
  for (const entry of ordered) {
    if (isRecord(entry) && typeof entry.code === "string" && typeof entry.message === "string") {
      return { code: entry.code, message: entry.message };
    }
  }
  return undefined;
}

/** Maps a service error to a state. `credentialField` receives INVALID_CREDENTIALS. */
function serviceErrorState(
  error: AppError,
  values: Values,
  options: {
    readonly credentialField?: AccountFieldName;
    readonly credentialMessage?: string;
    /** Where a VALIDATION_FAILED for a given service field lands. */
    readonly fieldMap: Readonly<Record<string, AccountFieldName>>;
  },
): AccountActionState {
  switch (error.code) {
    case "UNAUTHENTICATED":
    case "NOT_FOUND":
      // The account vanished (concurrent delete) or the session is unusable.
      return unauthenticatedState();
    case "RATE_LIMITED":
    case "ACCOUNT_LOCKED":
      return tooManyAttemptsState(error, values);
    case "INVALID_CREDENTIALS": {
      if (options.credentialField === undefined) return internalErrorState(values);
      const message = options.credentialMessage ?? ACCOUNT_MESSAGES.passwordIncorrect;
      return failure(
        appError("INVALID_CREDENTIALS", message, { fields: { [options.credentialField]: "INVALID_CREDENTIALS" } }),
        values,
        { [options.credentialField]: message },
      );
    }
    case "VALIDATION_FAILED":
    case "TOO_LONG": {
      const fields = error.details?.fields;
      const issues: Partial<Record<AccountFieldName, FieldIssue>> = {};
      if (isRecord(fields)) {
        for (const [serviceField, target] of Object.entries(options.fieldMap)) {
          if (!(serviceField in fields)) continue;
          const issue = serviceFieldIssue(error, serviceField);
          if (issue !== undefined && issues[target] === undefined) issues[target] = issue;
        }
      }
      if (Object.keys(issues).length === 0) {
        const fallbackTarget = Object.values(options.fieldMap)[0];
        if (fallbackTarget === undefined) return internalErrorState(values);
        issues[fallbackTarget] = { code: "INVALID", message: ACCOUNT_MESSAGES.invalid };
      }
      return fieldErrorState(issues, values);
    }
    default:
      return internalErrorState(values);
  }
}

// ---------------------------------------------------------------------------
// Local checks
// ---------------------------------------------------------------------------

export interface PasswordChangeInput {
  readonly currentPassword: string | undefined;
  readonly newPassword: string | undefined;
  readonly confirmPassword: string | undefined;
}

/**
 * DB-free checks for changePassword, using the same policy as the service
 * (`validatePassword` with the user's email for the WEAK check). Returns an
 * empty object when everything passes. SAME_AS_CURRENT is left to the service.
 */
export function precheckPasswordChange(input: PasswordChangeInput, email: string): Partial<Record<AccountFieldName, FieldIssue>> {
  const issues: Partial<Record<AccountFieldName, FieldIssue>> = {};
  if (input.currentPassword === undefined || input.currentPassword === "") {
    issues.currentPassword = { code: "REQUIRED", message: ACCOUNT_MESSAGES.currentPasswordRequired };
  }
  const policy = validatePassword(input.newPassword, { email });
  if (!policy.ok) {
    issues.newPassword = serviceFieldIssue(policy.error, "password") ?? { code: "INVALID", message: ACCOUNT_MESSAGES.invalid };
  }
  if ((input.confirmPassword ?? "") !== (input.newPassword ?? "")) {
    issues.confirmPassword = { code: "MISMATCH", message: ACCOUNT_MESSAGES.confirmPasswordMismatch };
  }
  return issues;
}

export interface DeleteAccountInput {
  readonly password: string | undefined;
  readonly confirm: string | undefined;
}

/** `confirm` must be exactly "DELETE" (no trimming, case-sensitive); password must be non-empty. */
export function precheckDelete(input: DeleteAccountInput): Partial<Record<AccountFieldName, FieldIssue>> {
  const issues: Partial<Record<AccountFieldName, FieldIssue>> = {};
  if (input.password === undefined || input.password === "") {
    issues.password = { code: "REQUIRED", message: ACCOUNT_MESSAGES.passwordRequired };
  }
  if (input.confirm !== DELETE_CONFIRM_VALUE) {
    issues.confirm = { code: "INVALID", message: ACCOUNT_MESSAGES.confirmDelete };
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Returned by an action body when it must end with `redirect("/")`. */
const REDIRECT_HOME: unique symbol = Symbol("redirect-home");
type Outcome = AccountActionState | typeof REDIRECT_HOME;

export function createAccountActions(deps: AccountActionDeps): AccountActions {
  const { account, auth, limiter, readResolvedAuth, now } = deps;
  const logger = deps.logger ?? console;

  /** Runs a best-effort step after the change is committed; a failure is logged (code only) and skipped. */
  async function bestEffort(action: AccountActionName, step: string, run: () => unknown): Promise<void> {
    try {
      await run();
    } catch (error) {
      unstable_rethrow(error);
      logger.error(`[account] ${ACCOUNT_CLEANUP_FAILED} action=${action} step=${step}`);
    }
  }

  /** Signed-out finish (delete, sign-out-everywhere): clear `sf_auth`, rotate `sf_session`, revalidate layout. */
  async function finishSignedOut(action: AccountActionName): Promise<typeof REDIRECT_HOME> {
    await bestEffort(action, "clearAuthCookie", () => deps.clearAuthCookie());
    await bestEffort(action, "rotateGuestSession", () => deps.rotateGuestSession());
    await bestEffort(action, "revalidateLayout", () => deps.revalidatePath(HOME_PATH, "layout"));
    return REDIRECT_HOME;
  }

  /**
   * Wraps an action body: always settles, and the redirect happens outside
   * the try/catch so Next's control-flow error propagates untouched.
   */
  function action(name: AccountActionName, body: (user: User, authSessionId: string, formData: unknown) => Promise<Outcome>): AccountActionFn {
    return async (_prevState, formData) => {
      let outcome: Outcome;
      try {
        const resolved = await readResolvedAuth();
        if (resolved === null) return unauthenticatedState();
        outcome = await body(resolved.user, resolved.authSessionId, formData);
      } catch (error) {
        // Next control-flow errors (NEXT_REDIRECT / NEXT_NOT_FOUND digests from
        // cookies() or redirect()) must propagate, never become a state.
        unstable_rethrow(error);
        // Error code only: the exception may carry ids or submitted values.
        logger.error(`[account] ${ACCOUNT_ACTION_FAILED} action=${name}`);
        return internalErrorState();
      }
      if (outcome === REDIRECT_HOME) return deps.redirect(HOME_PATH);
      return outcome;
    };
  }

  const updateProfile = action("updateProfile", async (user, _sessionId, formData) => {
    const raw = readField(formData, ACCOUNT_FIELD.displayName);
    const values: Values = raw === undefined ? {} : { displayName: truncate(raw, DISPLAY_NAME_MAX_LENGTH) };

    const local = normalizeDisplayName(raw);
    if (!local.ok) {
      return serviceErrorState(local.error, values, { fieldMap: { displayName: "displayName" } });
    }

    const limited = limitAction(limiter, RATE_LIMIT_KEYS.updateProfile, user.ownerKey);
    if (!limited.ok) return tooManyAttemptsState(limited.error, values);

    const result = await account.updateDisplayName(user.id, raw, now?.());
    if (!result.ok) return serviceErrorState(result.error, values, { fieldMap: { displayName: "displayName" } });

    await bestEffort("updateProfile", "revalidateLayout", () => deps.revalidatePath(HOME_PATH, "layout"));
    await bestEffort("updateProfile", "revalidateAccount", () => deps.revalidatePath(ACCOUNT_PATH));
    return {
      ok: true,
      kind: "profile_updated",
      message: ACCOUNT_MESSAGES.profileUpdated,
      displayName: result.value.displayName,
    };
  });

  const changePassword = action("changePassword", async (user, authSessionId, formData) => {
    const input: PasswordChangeInput = {
      currentPassword: readField(formData, ACCOUNT_FIELD.currentPassword),
      newPassword: readField(formData, ACCOUNT_FIELD.newPassword),
      confirmPassword: readField(formData, ACCOUNT_FIELD.confirmPassword),
    };
    const local = precheckPasswordChange(input, user.email);
    if (Object.keys(local).length > 0) return fieldErrorState(local, {});

    const limited = limitAction(limiter, RATE_LIMIT_KEYS.changePassword, user.ownerKey);
    if (!limited.ok) return tooManyAttemptsState(limited.error, {});

    const result = await account.changePassword(user.id, input.currentPassword, input.newPassword, authSessionId, now?.());
    if (!result.ok) {
      return serviceErrorState(result.error, {}, {
        credentialField: "currentPassword",
        credentialMessage: ACCOUNT_MESSAGES.currentPasswordIncorrect,
        fieldMap: { newPassword: "newPassword", password: "newPassword", currentPassword: "currentPassword" },
      });
    }

    // The current sf_auth stays valid (service kept authSessionId): no cookie writes.
    await bestEffort("changePassword", "revalidateLayout", () => deps.revalidatePath(HOME_PATH, "layout"));
    return { ok: true, kind: "password_changed", message: ACCOUNT_MESSAGES.passwordChanged };
  });

  const deleteAccount = action("deleteAccount", async (user, _sessionId, formData) => {
    const input: DeleteAccountInput = {
      password: readField(formData, ACCOUNT_FIELD.password),
      confirm: readField(formData, ACCOUNT_FIELD.confirm),
    };
    const local = precheckDelete(input);
    if (Object.keys(local).length > 0) return fieldErrorState(local, {});

    const limited = limitAction(limiter, RATE_LIMIT_KEYS.deleteAccount, user.ownerKey);
    if (!limited.ok) return tooManyAttemptsState(limited.error, {});

    const result = await account.deleteAccount(user.id, input.password, now?.());
    if (!result.ok) {
      return serviceErrorState(result.error, {}, {
        credentialField: "password",
        credentialMessage: ACCOUNT_MESSAGES.passwordIncorrect,
        fieldMap: { password: "password" },
      });
    }
    return finishSignedOut("deleteAccount");
  });

  const signOutEverywhere = action("signOutEverywhere", async (user) => {
    // Revokes every session incl. the current one (R-2). Throws -> INTERNAL_ERROR, cookies untouched.
    auth.signOutEverywhere(user.id, now?.());
    return finishSignedOut("signOutEverywhere");
  });

  return { updateProfile, changePassword, deleteAccount, signOutEverywhere };
}
