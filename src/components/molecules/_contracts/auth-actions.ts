import type { AppError } from "@/lib/result";

/**
 * Contract between the auth UI (SignInForm / SignUpForm T124, the sign-in and
 * sign-up pages T127, the header sign-out button) and the auth server actions
 * (T120, `src/app/actions/auth.ts`): `signUp`, `signIn`, `signOut`.
 * ("Sign out everywhere" belongs to the account settings actions, T121:
 * `signOutEverywhere` in `src/app/actions/account.ts`, contract
 * `account-actions.ts`.) Every action implements `AuthActionFn`, so it can be
 * passed to `useActionState` or straight to `<form action>` and works as a
 * plain form post without JavaScript (SR2).
 *
 * Common rules:
 * - Reads ONLY the `AUTH_FIELD` names below. Any other field (`userId`,
 *   `ownerKey`, `sessionId`, `role`, `verified`, `$ACTION_*`, ...) is ignored.
 *   A non-string entry (a `File`) counts as missing; for duplicated keys the
 *   first wins.
 * - SUCCESS NEVER RETURNS A STATE: the action sets/clears cookies and throws
 *   Next's redirect. Only failures return a state.
 * - The password is never echoed: not in `values`, messages, URLs or logs.
 *   Clear the password input after every submit.
 * - `message` and the `fieldErrors` strings are user-safe; render them as text.
 * - Always settles. Unexpected failures -> `INTERNAL_ERROR`
 *   ("Something went wrong. Please try again."); nothing was signed in.
 *
 * signIn (`email`, `password`, optional `next`) / signUp (`email`, `password`,
 * `displayName`, optional `next`):
 * - Success: merges the visitor's guest data (cart, lists, views, ...) into
 *   the account, sets `sf_auth`, rotates `sf_session`, revalidates the root
 *   layout and redirects to `next` when it is a safe same-origin path
 *   (`/orders`, `/account/settings?x=1`), else to `/account`. Render `next`
 *   as a hidden input; never build it from anything but the current URL.
 * - If the browser was already signed in, that session is revoked when (and
 *   only when) the new sign-in/sign-up succeeds, just before the new cookie is
 *   set. A failed attempt (any error state) keeps the current session.
 * - `VALIDATION_FAILED`: one message per field in `fieldErrors`
 *   (`email`, `password`, `displayName`).
 * - `INVALID_CREDENTIALS` (signIn): "Email or password is incorrect" for both
 *   an unknown email and a wrong password; `fieldErrors` is empty.
 * - `EMAIL_TAKEN` (signUp): "An account with this email already exists. Sign
 *   in instead." Offer a link to `/signin`.
 * - `TOO_MANY_ATTEMPTS`: rate limited OR account locked; the two are
 *   deliberately indistinguishable (ruling R-10): ONE state, byte-identical
 *   for both causes: `error.code` is `RATE_LIMITED`, message "Too many
 *   attempts. Try again in N minutes.", `retryAfterSeconds` both top-level
 *   and in `error.details`, empty `fieldErrors`.
 *
 * signOut (no fields): revokes the current session, clears `sf_auth`, rotates
 * `sf_session`, revalidates the layout and redirects to `/`. Harmless (still
 * redirects) when not signed in.
 */

/** Form field names posted by the auth forms. */
export const AUTH_FIELD = {
  email: "email",
  password: "password",
  displayName: "displayName",
  /** Hidden input: where to go after success (validated server-side). */
  next: "next",
} as const;

export type AuthFieldName = (typeof AUTH_FIELD)[keyof typeof AUTH_FIELD];

/** Fields that can carry a per-field error. */
export type AuthErrorField = "email" | "password" | "displayName";

/** Action-level outcome codes a form switches on. */
export type AuthActionCode =
  | "INVALID_CREDENTIALS"
  | "TOO_MANY_ATTEMPTS"
  | "EMAIL_TAKEN"
  | "VALIDATION_FAILED"
  /** Reserved (kept for shape stability); not produced by the T120 actions. */
  | "UNAUTHENTICATED"
  | "INTERNAL_ERROR";

/** Input caps (mirror as `maxLength` / `minLength`). Password bounds are UTF-16 units (K-10). */
export const AUTH_EMAIL_MAX_LENGTH = 254;
export const AUTH_DISPLAY_NAME_MAX_LENGTH = 50;
export const AUTH_PASSWORD_MIN_LENGTH = 8;
export const AUTH_PASSWORD_MAX_LENGTH = 128;

/** Re-fill values. NEVER contains the password. */
export interface AuthEchoValues {
  readonly email?: string;
  readonly displayName?: string;
}

/** `null` = not yet submitted. Success never returns: the action redirects. */
export type AuthActionState =
  | null
  | {
      readonly ok: false;
      readonly error: AppError;
      readonly code: AuthActionCode;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      readonly fieldErrors: Readonly<Partial<Record<AuthErrorField, string>>>;
      readonly values: AuthEchoValues;
      /** Present for TOO_MANY_ATTEMPTS. */
      readonly retryAfterSeconds?: number;
    };

/** Signature for `useActionState` / `<form action>`. */
export type AuthActionFn = (prevState: AuthActionState, formData: FormData) => Promise<AuthActionState>;

export const initialAuthActionState: AuthActionState = null;
