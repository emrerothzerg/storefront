import type { AppError } from "@/lib/result";

/**
 * Contract between the PDP ViewTracker (T97), the account browsing-history
 * page (T98) and the view server actions (T52, `src/app/actions/views.ts`).
 *
 * Server actions:
 * - `recordProductView(input)` (beacon, NOT form-shaped; call it from a
 *   client component effect): pass `{ productSlug }` and/or `{ productId }`.
 *   A valid slug (`^[a-z0-9-]{1,100}$`) is resolved first, then `productId`.
 *   Unknown or malformed input settles as `{ ok: true, kind: "ignored" }` and
 *   creates NO session cookie. A known product creates the session cookie on
 *   first use and upserts one history row. Never revalidates anything. It
 *   never throws, even for garbage arguments.
 *   Over 120 calls / minute / session it returns RATE_LIMITED; the tracker
 *   should ignore every result (it is fire-and-forget, nothing is shown).
 * - `recordProductViewForm(prev, formData)`: the same, form-shaped
 *   (`productId`, `productSlug` fields), for progressive enhancement.
 * - `removeFromHistory(prev, formData)`: field `productId` (required,
 *   INVALID_INPUT with `details.field` otherwise). Removes only the current
 *   owner's row; a product not in the history is a silent success.
 * - `clearHistory(prev, formData)`: field `confirm` MUST equal `"yes"`, else
 *   INVALID_INPUT (`details.field === "confirm"`). Deletes only the current
 *   owner's rows.
 * - remove/clear never create a session: with no cookie they settle as
 *   `{ ok: true, kind: "ignored" }`. On success they revalidate
 *   `/account/history`.
 *
 * Every action reads ONLY the `VIEW_FIELD` names; the owner key always comes
 * from the server-side cookie (a posted `sessionId` is ignored). States are
 * plain JSON; `message` is user-safe and never echoes input.
 *
 * Error codes (`error.code`): INVALID_INPUT, RATE_LIMITED (`retryAfterSeconds`),
 * VALIDATION_FAILED with `details.reason === "unexpected"` (server fault).
 */

/** Form field names. */
export const VIEW_FIELD = {
  productId: "productId",
  productSlug: "productSlug",
  confirm: "confirm",
} as const;

export type ViewFieldName = (typeof VIEW_FIELD)[keyof typeof VIEW_FIELD];

export type ViewSuccessKind = "recorded" | "removed" | "cleared" | "ignored";

/** `null` = not yet submitted. */
export type ViewActionState =
  | null
  | { readonly ok: true; readonly kind: ViewSuccessKind; readonly message?: string }
  | {
      readonly ok: false;
      readonly error: AppError;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      /** Present only for RATE_LIMITED. */
      readonly retryAfterSeconds?: number;
    };

/** Signature for `useActionState` / `<form action>`. */
export type ViewActionFn = (prev: ViewActionState, formData: FormData) => Promise<ViewActionState>;

/** Beacon callable from a client component (not form-shaped). */
export type RecordViewBeacon = (input: { productId?: string; productSlug?: string }) => Promise<ViewActionState>;

/** Value the `clearHistory` form must post in `VIEW_FIELD.confirm`. */
export const CLEAR_HISTORY_CONFIRM_VALUE = "yes";

export const initialViewActionState: ViewActionState = null;
