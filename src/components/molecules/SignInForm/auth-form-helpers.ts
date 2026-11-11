import { isAllowedInternalHref } from "@/content/routes";
import type { AuthActionState, AuthErrorField } from "../_contracts/auth-actions";

/**
 * Pure helpers shared by SignInForm and SignUpForm (T124). No React, no
 * `src/server/**` imports (molecule rule): the safe-next rule and the action
 * messages are MIRRORED here and pinned to the server sources by the
 * colocated tests (`safeNext` in src/server/session/safe-next.ts,
 * `AUTH_MESSAGES` / `tooManyAttemptsMessage` in src/app/actions/auth-core.ts).
 */

export type AuthFailure = Extract<NonNullable<AuthActionState>, { ok: false }>;

// --- safe `next` (mirror of src/server/session/safe-next.ts) ---------------

export const SAFE_NEXT_MAX_LENGTH = 512;
const ALLOWED_RE = /^\/(?![/\\])[A-Za-z0-9/_\-.~%?=&#]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const ENCODED_TRICK_RE = /%2f%2f|%5c/i;

/**
 * The `next` value when it is a safe same-origin path, else `null`. Same rule
 * as the server's `safeNext` (single leading `/`, no `//` or `/\`, no scheme,
 * no backslash/control/non-ASCII, no double-encoded tricks, well-formed
 * escapes). Forms render `next` (hidden input, links) only when this
 * returns a string.
 */
export function toSafeNext(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > SAFE_NEXT_MAX_LENGTH) return null;
  if (!ALLOWED_RE.test(raw) || ENCODED_TRICK_RE.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.startsWith("/\\")) return null;
  if (decoded.includes("\\") || CONTROL_RE.test(decoded) || ENCODED_TRICK_RE.test(decoded)) return null;
  return raw;
}

// --- hrefs -----------------------------------------------------------------

/** `href` when it is an allow-listed internal route, else `fallback`. */
export function safeInternalHref(href: string | null | undefined, fallback: string): string {
  return typeof href === "string" && isAllowedInternalHref(href) ? href : fallback;
}

/**
 * `/signin` or `/signup`, carrying `?next=<encoded>` only when `next` passes
 * the safe-next rule; the result is checked with `isAllowedInternalHref`.
 */
export function authPageHref(path: "/signin" | "/signup", next: string | null | undefined): string {
  const safe = toSafeNext(next);
  const href = safe === null ? path : `${path}?next=${encodeURIComponent(safe)}`;
  return safeInternalHref(href, path);
}

// --- messages (mirror of src/app/actions/auth-core.ts AUTH_MESSAGES) --------

export const AUTH_FORM_MESSAGES = {
  invalid: "Some fields are invalid.",
  invalidCredentials: "Email or password is incorrect",
  emailTaken: "An account with this email already exists. Sign in instead.",
  internal: "Something went wrong. Please try again.",
  tooManyAttemptsFallback: "Too many attempts. Try again later.",
} as const;

/** "Too many attempts. Try again in N minutes." (R-10; N >= 1, rounded up, singular for 1). */
export function tooManyAttemptsText(retryAfterSeconds: unknown): string {
  if (typeof retryAfterSeconds !== "number" || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return AUTH_FORM_MESSAGES.tooManyAttemptsFallback;
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

export type FormLevelKind = "fields" | "credentials" | "too_many" | "email_taken" | "generic";

/**
 * Classifies a failure. ACCOUNT_LOCKED and RATE_LIMITED (whatever the
 * top-level `code`) collapse into one "too_many" kind with identical text
 * (ruling R-10).
 */
export function failureKind(failure: AuthFailure): FormLevelKind {
  const errorCode: string = failure.error.code;
  if (failure.code === "TOO_MANY_ATTEMPTS" || errorCode === "RATE_LIMITED" || errorCode === "ACCOUNT_LOCKED") {
    return "too_many";
  }
  if (failure.code === "INVALID_CREDENTIALS") return "credentials";
  if (failure.code === "EMAIL_TAKEN") return "email_taken";
  if (failure.code === "VALIDATION_FAILED") return "fields";
  return "generic";
}

/** Retry-after seconds from the top level, else `error.details`. */
export function retryAfterOf(failure: AuthFailure): unknown {
  return failure.retryAfterSeconds ?? failure.error.details?.retryAfterSeconds;
}

/** Text shown in the error summary for non-field failures (always from local constants). */
export function formLevelText(failure: AuthFailure): string {
  switch (failureKind(failure)) {
    case "too_many":
      return tooManyAttemptsText(retryAfterOf(failure));
    case "credentials":
      return AUTH_FORM_MESSAGES.invalidCredentials;
    case "email_taken":
      return AUTH_FORM_MESSAGES.emailTaken;
    case "fields":
      return AUTH_FORM_MESSAGES.invalid;
    default:
      return AUTH_FORM_MESSAGES.internal;
  }
}

export interface FieldSpec {
  readonly field: AuthErrorField;
  readonly id: string;
  readonly label: string;
}

export interface SummaryItem {
  readonly id: string;
  readonly label: string;
  readonly message: string;
}

/** Non-blank string field errors, in the given form order. */
export function fieldSummaryItems(failure: AuthFailure, fields: readonly FieldSpec[]): SummaryItem[] {
  const errors = failure.fieldErrors ?? {};
  return fields.flatMap(({ field, id, label }) => {
    const message = errors[field];
    if (typeof message !== "string" || message.trim() === "") return [];
    return [{ id, label, message }];
  });
}

/** The field's error text, or undefined when absent/blank. */
export function fieldErrorOf(failure: AuthFailure | null, field: AuthErrorField): string | undefined {
  const message = failure?.fieldErrors?.[field];
  return typeof message === "string" && message.trim() !== "" ? message : undefined;
}
