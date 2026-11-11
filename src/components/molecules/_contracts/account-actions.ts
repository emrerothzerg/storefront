import type { AppError } from "@/lib/result";

/**
 * Contract between the account settings UI (AccountSettingsForms T125, the
 * settings page T128) and the account settings server actions (T121,
 * `src/app/actions/account.ts`): `updateProfile`, `changePassword`,
 * `deleteAccount`, `signOutEverywhere`. Every action implements
 * `AccountActionFn`, so it can be passed to `useActionState` or straight to
 * `<form action>` and works as a plain form post without JavaScript.
 *
 * Common rules:
 * - The signed-in user comes from the `sf_auth` cookie only. Without a valid
 *   one (missing, expired, revoked, garbage, deleted user) every action
 *   returns `UNAUTHENTICATED` ("Please sign in.") and changes nothing: no
 *   service call, no rate-limit token, no cookie write, no revalidation.
 * - Reads ONLY the `ACCOUNT_FIELD` names below. Any other field (`userId`,
 *   `ownerKey`, `sessionId`, `email`, `$ACTION_*`, ...) is ignored. A non-string
 *   entry (a `File`) counts as missing; for duplicated keys the first wins.
 * - Cheap local checks (required fields, display name length, new password
 *   policy, confirm mismatch, the `DELETE` literal) run before the rate limiter
 *   and before any password is verified, so a typo never costs a rate-limit
 *   token or a lockout attempt.
 * - Rate limits per user: updateProfile 20/hour, changePassword 5/15 min,
 *   deleteAccount 5/hour. Exceeded -> `RATE_LIMITED` with `retryAfterSeconds`,
 *   message "Too many attempts. Try again in N minutes.". A locked account
 *   (10 wrong passwords) returns the IDENTICAL state, `error.code` included
 *   (`RATE_LIMITED`, ruling R-10): `ACCOUNT_LOCKED` never reaches the UI.
 * - Passwords are never echoed: not in `values`, messages, URLs or logs.
 *   Clear password inputs after every submit.
 * - Always settles. Unexpected failures -> `INTERNAL_ERROR` with a generic
 *   message ("Something went wrong. Please try again.").
 *
 * Per action:
 * - updateProfile (`displayName`, 1..50 chars after whitespace cleanup):
 *   success `{ ok: true, kind: "profile_updated", displayName }` (the cleaned,
 *   stored name; render as text). Errors: `VALIDATION_FAILED` on
 *   `fieldErrors.displayName`; `values.displayName` echoes the input (cut to
 *   50). Revalidates the root layout (header greeting) and `/account`.
 *   Reviews/questions already posted keep their old name snapshot.
 * - changePassword (`currentPassword`, `newPassword`, `confirmPassword`):
 *   success `{ ok: true, kind: "password_changed" }`; the current browser stays
 *   signed in, every other session is signed out. Errors: wrong current
 *   password -> `INVALID_CREDENTIALS` on `fieldErrors.currentPassword` (counts
 *   toward the lockout); policy failures (`TOO_SHORT`, `TOO_LONG`, `WEAK`,
 *   `SAME_AS_CURRENT`, missing) -> `VALIDATION_FAILED` on
 *   `fieldErrors.newPassword`; confirm mismatch -> `fieldErrors.confirmPassword`.
 * - deleteAccount (`password`, `confirm` which must be exactly `DELETE`, case
 *   and whitespace sensitive): success never returns a state; it clears
 *   `sf_auth`, rotates the guest cookie and redirects to `/`. Errors: missing
 *   password or wrong `confirm` -> `VALIDATION_FAILED` on `fieldErrors.password`
 *   / `fieldErrors.confirm`; wrong password -> `INVALID_CREDENTIALS` on
 *   `fieldErrors.password`. A second submit after success returns
 *   `UNAUTHENTICATED`.
 * - signOutEverywhere (no fields): revokes every session of the user including
 *   the current one, clears `sf_auth`, rotates the guest cookie and redirects
 *   to `/`. Not rate limited.
 */

/** Form field names posted by the account settings forms. */
export const ACCOUNT_FIELD = {
  displayName: "displayName",
  currentPassword: "currentPassword",
  newPassword: "newPassword",
  confirmPassword: "confirmPassword",
  /** deleteAccount: the account password. */
  password: "password",
  /** deleteAccount: must be the literal {@link DELETE_CONFIRM_VALUE}. */
  confirm: "confirm",
} as const;

export type AccountFieldName = keyof typeof ACCOUNT_FIELD;

/** The exact text the user must type to confirm deletion. */
export const DELETE_CONFIRM_VALUE = "DELETE";

/** Max display name length (mirror as `maxLength` on the input). */
export const DISPLAY_NAME_MAX_LENGTH = 50;

/** Password length bounds (UTF-16 units; mirror as `minLength`/`maxLength`). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

/** `null` = not yet submitted. */
export type AccountActionState =
  | null
  | {
      readonly ok: true;
      readonly kind: "profile_updated" | "password_changed";
      /** User-safe; announce through `role="status"`. */
      readonly message: string;
      /** Present for `profile_updated`: the stored (cleaned) display name. */
      readonly displayName?: string;
    }
  | {
      readonly ok: false;
      readonly error: AppError;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      readonly fieldErrors: Readonly<Partial<Record<AccountFieldName, string>>>;
      /** Re-fill values. NEVER contains a password. */
      readonly values: { readonly displayName?: string };
      /** Present for RATE_LIMITED (which also covers a locked account). */
      readonly retryAfterSeconds?: number;
    };

/** Signature for `useActionState` / `<form action>`. */
export type AccountActionFn = (prevState: AccountActionState, formData: FormData) => Promise<AccountActionState>;

export const initialAccountActionState: AccountActionState = null;
