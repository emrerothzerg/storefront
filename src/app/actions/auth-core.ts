import { unstable_rethrow } from "next/navigation";
import {
  AUTH_DISPLAY_NAME_MAX_LENGTH,
  AUTH_EMAIL_MAX_LENGTH,
  AUTH_FIELD,
  type AuthActionCode,
  type AuthActionFn,
  type AuthActionState,
  type AuthEchoValues,
  type AuthErrorField,
} from "@/components/molecules/_contracts/auth-actions";
import { appError, type AppError, type Result } from "@/lib/result";
import type { AuthService, IssuedSession, SignInContext } from "@/server/auth/auth-service";
import type { MergeService } from "@/server/auth/merge-service";
import { safeNext } from "@/server/session/safe-next";

/**
 * Framework-free auth action logic (T120). `auth.ts` wires it to Next.js
 * (session cookie helpers, `headers()`, `revalidatePath`, `redirect`, the auth
 * and merge services); tests inject the real services over `:memory:` and a
 * fake cookie jar.
 *
 * signIn / signUp:
 * 1. Read ONLY the `AUTH_FIELD` strings (forged `userId`, `ownerKey`,
 *    `sessionId`, `role`, `verified` are never read). The password is never
 *    copied into a state, a log line or a URL.
 * 2. `getOrCreateGuestSessionId()` (R-3: the guest cookie exists before the
 *    service's limiter runs, so the per-session bucket has a key).
 * 3. `auth.signIn` / `auth.signUp` (validation, rate limits, lockout and
 *    hashing all live in the service; it rate-limits before any hashing).
 *    A failure returns a state and leaves any current sign-in untouched.
 * 4. Merge the RAW guest id (`readGuestSessionId()`, K-4; never the resolved
 *    owner key) into `user.ownerKey`. On failure the just-issued session is
 *    revoked, no cookie is written, and the guest data is intact (the merge
 *    is one transaction): generic `INTERNAL_ERROR` (criterion 5, W-18).
 * 5. Only now a pre-existing VALID `sf_auth` is revoked (`auth.signOut`;
 *    criterion 8, no stacked sessions; orchestrator ruling: never on failure).
 * 6. `setAuthCookie`, then `rotateGuestSession()` (fixation defence,
 *    criterion 4), then `revalidatePath("/", "layout")` (AR5, best-effort).
 * 7. `redirect(safeNext(next, "/account"))` OUTSIDE the try/catch.
 *
 * signOut: revoke the current token (if any) -> clear `sf_auth` -> rotate
 * `sf_session` -> revalidate -> `redirect("/")`. Without `sf_auth` it still
 * clears/rotates and redirects (R-3).
 *
 * signOutEverywhere is NOT here: T121 (`account.ts`) owns it.
 *
 * Every outcome is a state or the intentional redirect throw. Unexpected
 * exceptions become `INTERNAL_ERROR`; logs carry an error code, the action
 * name and a step name only (AR1).
 */

export interface AuthActionDeps {
  readonly auth: AuthService;
  readonly merge: MergeService;
  /** Guest `sf_session` id, minted (cookie set) when absent. Used as the limiter key only. */
  readonly getOrCreateGuestSessionId: () => Promise<string>;
  /** RAW guest id (validated UUID v4, never an owner key). The ONLY id ever merged (K-4). */
  readonly readGuestSessionId: () => Promise<string | null>;
  /** Well-formed raw `sf_auth` value or null (not validated against the DB). */
  readonly readAuthToken: () => Promise<string | null>;
  readonly setAuthCookie: (token: string, expiresAt: string) => Promise<void>;
  readonly clearAuthCookie: () => Promise<void>;
  readonly rotateGuestSession: () => Promise<string>;
  /** Raw `User-Agent` header (truncated here to {@link USER_AGENT_MAX_LENGTH}). */
  readonly userAgent: () => Promise<string | null>;
  readonly revalidatePath: (path: string, type?: "page" | "layout") => void;
  /** Must throw (Next's `redirect`), never return. */
  readonly redirect: (path: string) => never;
  /** Epoch ms passed to the services; service default when absent. */
  readonly now?: () => number;
  /** Receives only error codes and step names; defaults to `console`. */
  readonly logger?: Pick<Console, "error">;
}

export interface AuthActions {
  readonly signUp: AuthActionFn;
  readonly signIn: AuthActionFn;
  readonly signOut: AuthActionFn;
}

export type AuthActionName = keyof AuthActions;

/** Logged when an action hits an unexpected exception or a failed merge. */
export const AUTH_ACTION_FAILED = "AUTH_ACTION_FAILED";
/** Logged when a best-effort step fails (revalidation, cleanup after a failure). */
export const AUTH_CLEANUP_FAILED = "AUTH_CLEANUP_FAILED";

export const HOME_PATH = "/";
export const DEFAULT_AFTER_AUTH_PATH = "/account";
/** Same cap as the auth repository's `user_agent` column. */
export const USER_AGENT_MAX_LENGTH = 512;

export const AUTH_MESSAGES = {
  invalid: "Some fields are invalid.",
  invalidCredentials: "Email or password is incorrect",
  emailTaken: "An account with this email already exists. Sign in instead.",
  internal: "Something went wrong. Please try again.",
  tooManyAttemptsFallback: "Too many attempts. Try again later.",
} as const;

/** "Too many attempts. Try again in N minutes." (N >= 1, rounded up). */
export function tooManyAttemptsMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return AUTH_MESSAGES.tooManyAttemptsFallback;
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
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export interface ParsedAuthForm {
  readonly email: string | undefined;
  readonly password: string | undefined;
  readonly displayName: string | undefined;
  readonly next: string | undefined;
}

/** Reads only the contract fields. */
export function parseAuthForm(formData: unknown): ParsedAuthForm {
  return {
    email: readField(formData, AUTH_FIELD.email),
    password: readField(formData, AUTH_FIELD.password),
    displayName: readField(formData, AUTH_FIELD.displayName),
    next: readField(formData, AUTH_FIELD.next),
  };
}

/** Re-fill values (truncated to the input caps). Never the password. */
export function echoValues(parsed: ParsedAuthForm, withDisplayName: boolean): AuthEchoValues {
  const out: { email?: string; displayName?: string } = {};
  if (parsed.email !== undefined) out.email = truncate(parsed.email, AUTH_EMAIL_MAX_LENGTH);
  if (withDisplayName && parsed.displayName !== undefined) {
    out.displayName = truncate(parsed.displayName, AUTH_DISPLAY_NAME_MAX_LENGTH);
  }
  return out;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

type FieldErrors = Partial<Record<AuthErrorField, string>>;

const ERROR_FIELDS: readonly AuthErrorField[] = ["email", "password", "displayName"];
const KNOWN_FIELD_CODES: ReadonlySet<string> = new Set(["REQUIRED", "TOO_SHORT", "TOO_LONG", "WEAK", "INVALID"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(
  code: AuthActionCode,
  error: AppError,
  values: AuthEchoValues,
  fieldErrors: FieldErrors = {},
  retryAfterSeconds?: number,
): AuthActionState {
  const base = { ok: false as const, error, code, message: error.message, fieldErrors, values };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

/** Generic state for unexpected failures. No internal detail leaves the server. */
export function internalErrorState(values: AuthEchoValues = {}): AuthActionState {
  return failure("INTERNAL_ERROR", appError("INTERNAL_ERROR", AUTH_MESSAGES.internal), values);
}

function readRetryAfter(error: AppError): number | undefined {
  const value = error.details?.retryAfterSeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}

/**
 * RATE_LIMITED and ACCOUNT_LOCKED (ruling R-10): byte-identical shape AND
 * codes (`code: "TOO_MANY_ATTEMPTS"`, `error.code: "RATE_LIMITED"`), so the
 * response never reveals whether an account exists or is locked.
 */
export function tooManyAttemptsState(error: AppError, values: AuthEchoValues): AuthActionState {
  const retryAfterSeconds = readRetryAfter(error);
  const message = tooManyAttemptsMessage(retryAfterSeconds);
  return retryAfterSeconds === undefined
    ? failure("TOO_MANY_ATTEMPTS", appError("RATE_LIMITED", message), values)
    : failure("TOO_MANY_ATTEMPTS", appError("RATE_LIMITED", message, { retryAfterSeconds }), values, {}, retryAfterSeconds);
}

/**
 * VALIDATION_FAILED from the service's `details.fields` (`{ [field]: { code,
 * message } }`). Only known fields with a string message are kept;
 * `error.details.fields` carries codes only.
 */
export function fieldErrorState(source: unknown, values: AuthEchoValues): AuthActionState {
  const fieldErrors: FieldErrors = {};
  const codes: Partial<Record<AuthErrorField, string>> = {};
  if (isRecord(source)) {
    for (const field of ERROR_FIELDS) {
      const entry = source[field];
      if (!isRecord(entry) || typeof entry.message !== "string") continue;
      fieldErrors[field] = entry.message;
      codes[field] = typeof entry.code === "string" && KNOWN_FIELD_CODES.has(entry.code) ? entry.code : "INVALID";
    }
  }
  return failure("VALIDATION_FAILED", appError("VALIDATION_FAILED", AUTH_MESSAGES.invalid, { fields: codes }), values, fieldErrors);
}

/** Maps an auth-service error to a user-safe state; messages and details are rebuilt from constants. */
export function toErrorState(error: AppError, values: AuthEchoValues): AuthActionState {
  switch (error.code) {
    case "VALIDATION_FAILED":
    case "TOO_LONG":
      return fieldErrorState(error.details?.fields, values);
    case "INVALID_CREDENTIALS":
      return failure("INVALID_CREDENTIALS", appError("INVALID_CREDENTIALS", AUTH_MESSAGES.invalidCredentials), values);
    case "EMAIL_TAKEN":
      return failure("EMAIL_TAKEN", appError("EMAIL_TAKEN", AUTH_MESSAGES.emailTaken), values);
    case "RATE_LIMITED":
    case "ACCOUNT_LOCKED":
      return tooManyAttemptsState(error, values);
    default:
      return internalErrorState(values);
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Returned by an action body when it must end with a redirect to `path`. */
interface RedirectTo {
  readonly redirectTo: string;
}
type Outcome = AuthActionState | RedirectTo;

function isRedirect(outcome: Outcome): outcome is RedirectTo {
  return outcome !== null && "redirectTo" in outcome;
}

type Credentials = (parsed: ParsedAuthForm, ctx: SignInContext) => Promise<Result<IssuedSession, AppError>>;

export function createAuthActions(deps: AuthActionDeps): AuthActions {
  const { auth, merge } = deps;
  const logger = deps.logger ?? console;

  function logFailure(action: AuthActionName, step: string): void {
    logger.error(`[auth] ${AUTH_ACTION_FAILED} action=${action} step=${step}`);
  }

  /** A step whose failure must not change the outcome; logged (code + step only) and skipped. */
  async function bestEffort(action: AuthActionName, step: string, run: () => unknown): Promise<void> {
    try {
      await run();
    } catch (error) {
      unstable_rethrow(error);
      logger.error(`[auth] ${AUTH_CLEANUP_FAILED} action=${action} step=${step}`);
    }
  }

  /**
   * Wraps an action body: always settles, and the redirect happens outside
   * the try/catch so Next's control-flow error propagates untouched.
   */
  function action(name: AuthActionName, body: (formData: unknown, step: { current: string }) => Promise<Outcome>): AuthActionFn {
    return async (_prevState, formData) => {
      const step = { current: "start" };
      let outcome: Outcome;
      try {
        outcome = await body(formData, step);
      } catch (error) {
        unstable_rethrow(error);
        // Error code + step only: the exception may carry ids, tokens or input.
        logFailure(name, step.current);
        return internalErrorState();
      }
      if (isRedirect(outcome)) return deps.redirect(outcome.redirectTo);
      return outcome;
    };
  }

  async function userAgent(): Promise<string | null> {
    const raw = await deps.userAgent();
    if (typeof raw !== "string" || raw === "") return null;
    return truncate(raw, USER_AGENT_MAX_LENGTH);
  }

  /** Shared sign-in / sign-up flow (steps 2-7 in the module comment). */
  function authenticate(name: "signIn" | "signUp", credentials: Credentials): AuthActionFn {
    return action(name, async (formData, step) => {
      const parsed = parseAuthForm(formData);
      const values = echoValues(parsed, name === "signUp");
      const now = deps.now?.();

      step.current = "guestSession";
      const sessionKey = await deps.getOrCreateGuestSessionId();
      step.current = "userAgent";
      const ua = await userAgent();

      step.current = "credentials";
      const ctx: SignInContext = now === undefined ? { sessionKey, userAgent: ua } : { sessionKey, userAgent: ua, now };
      const issued = await credentials(parsed, ctx);
      if (!issued.ok) return toErrorState(issued.error, values);
      const { user, token, expiresAt } = issued.value;

      // From here on the issued session must not outlive a failure (W-18).
      let cookieSet = false;
      try {
        step.current = "merge";
        const guestId = await deps.readGuestSessionId();
        if (guestId !== null) {
          const merged = merge.mergeGuestIntoUser(guestId, user.ownerKey, now);
          if (!merged.ok) {
            logFailure(name, "merge");
            await bestEffort(name, "revokeIssued", () => auth.signOut(token, now));
            return internalErrorState(values);
          }
        }
        // Criterion 8 / W-06 (orchestrator ruling): an existing valid session is
        // revoked only now, after the new credentials and the merge succeeded,
        // so a failed attempt leaves the current sign-in untouched.
        step.current = "revokePrevious";
        const previousToken = await deps.readAuthToken();
        if (previousToken !== null && previousToken !== token && auth.resolveToken(previousToken, now) !== null) {
          auth.signOut(previousToken, now);
        }
        step.current = "setAuthCookie";
        await deps.setAuthCookie(token, expiresAt);
        cookieSet = true;
        step.current = "rotateGuestSession";
        await deps.rotateGuestSession();
      } catch (error) {
        unstable_rethrow(error);
        logFailure(name, step.current);
        await bestEffort(name, "revokeIssued", () => auth.signOut(token, now));
        if (cookieSet) await bestEffort(name, "clearAuthCookie", () => deps.clearAuthCookie());
        return internalErrorState(values);
      }

      await bestEffort(name, "revalidateLayout", () => deps.revalidatePath(HOME_PATH, "layout"));
      return { redirectTo: safeNext(parsed.next, DEFAULT_AFTER_AUTH_PATH) };
    });
  }

  const signIn = authenticate("signIn", (parsed, ctx) =>
    auth.signIn({ email: parsed.email, password: parsed.password }, ctx),
  );

  const signUp = authenticate("signUp", (parsed, ctx) =>
    auth.signUp({ email: parsed.email, password: parsed.password, displayName: parsed.displayName }, ctx),
  );

  const signOut = action("signOut", async (_formData, step) => {
    const now = deps.now?.();
    step.current = "readToken";
    const token = await deps.readAuthToken();
    let revokeFailed = false;
    if (token !== null) {
      try {
        auth.signOut(token, now);
      } catch (error) {
        unstable_rethrow(error);
        // Still sign this browser out below, but tell the user something went wrong.
        logFailure("signOut", "revoke");
        revokeFailed = true;
      }
    }
    step.current = "clearAuthCookie";
    await deps.clearAuthCookie();
    step.current = "rotateGuestSession";
    await deps.rotateGuestSession();
    await bestEffort("signOut", "revalidateLayout", () => deps.revalidatePath(HOME_PATH, "layout"));
    if (revokeFailed) return internalErrorState();
    return { redirectTo: HOME_PATH };
  });

  return { signUp, signIn, signOut };
}
