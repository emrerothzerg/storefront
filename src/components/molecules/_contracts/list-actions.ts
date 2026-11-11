import type { AppError } from "@/lib/result";

/**
 * Contract between list UI (WishlistButton / ListItemRow / ShareListPanel T60,
 * ListView T85, lists pages T99) and the list server actions (T48,
 * `src/app/actions/lists.ts`).
 *
 * Server actions implementing `ListActionFn`:
 * - Read ONLY the `LIST_FIELD` names below. Every other field (sessionId,
 *   ownerKey, price, isDefault, `$ACTION_*`, ...) is ignored. The owner key
 *   comes from the server-side cookie, never from the form.
 * - `addToList` and `createList` are the only actions that create the session
 *   cookie (lazily, after the input parses: a cold visitor's heart button or
 *   "Create list" form). Every other action reads the cookie and, without one,
 *   returns `NOT_FOUND` and creates nothing.
 * - Rate limit (120 list mutations / hour / session) is applied before the
 *   service; over the limit -> `RATE_LIMITED` with `retryAfterSeconds`.
 * - Always settle with a plain, JSON-serializable state. `message` is
 *   user-safe and may be shown verbatim.
 *
 * Fields per action (required unless marked optional):
 * - addToList       : productId; listId (optional, absent/empty = default
 *                     wish list); quantityDesired, priority, note (optional);
 *                     productSlug, returnTo (optional, revalidation only)
 * - removeFromList  : listId, productId; productSlug, returnTo (optional)
 * - updateListItem  : listId, productId; quantityDesired / priority (absent or
 *                     empty = unchanged); note (absent = unchanged, empty = clear)
 * - moveListItem    : listId (source), toListId, productId
 * - createList      : name
 * - renameList      : listId, name
 * - deleteList      : listId, confirm (must be exactly "yes")
 * - setListSharing  : listId, mode ("enable" | "disable" | "rotate")
 * - addAllToCart    : listId
 *
 * Accepted values: quantityDesired "1".."99" (digits only); priority "0" (low),
 * "1" (medium), "2" (high); name 1..60 chars after cleaning; note <= 200 chars.
 * `returnTo` is a same-origin path ("/products/x"); anything else is ignored.
 *
 * Error codes a form should expect (`error.code`):
 * - INVALID_INPUT (`details.field`): missing/malformed field, `confirm` not
 *   "yes", unknown `mode`.
 * - INVALID_QUANTITY (`fieldErrors.quantityDesired`), VALIDATION_FAILED
 *   (`fieldErrors.priority` or blank `fieldErrors.name`), TOO_LONG
 *   (`fieldErrors.name` / `fieldErrors.note`).
 * - NOT_FOUND: list or item unknown, not yours, or no session (one message;
 *   never reveals whether the id exists for someone else).
 * - PRODUCT_NOT_FOUND, LIMIT_REACHED (`details.max`), FORBIDDEN (save-for-later
 *   list cannot be renamed/shared/deleted; the only wish list cannot be
 *   deleted), RATE_LIMITED (`retryAfterSeconds`), VALIDATION_FAILED with
 *   `details.reason === "unexpected"` (server fault).
 *
 * `sharePath` (`/lists/shared/<token>`) is returned only by a successful
 * `setListSharing` to the owner; `null` when sharing was disabled. It is a
 * bearer credential: render it only to the owner and never log it.
 */

/** Form field names posted by the list forms. */
export const LIST_FIELD = {
  listId: "listId",
  toListId: "toListId",
  productId: "productId",
  productSlug: "productSlug",
  name: "name",
  quantityDesired: "quantityDesired",
  priority: "priority",
  note: "note",
  /** "enable" | "disable" | "rotate" */
  mode: "mode",
  /** Must be "yes" for deleteList. */
  confirm: "confirm",
  /** Safe same-origin path, optional. */
  returnTo: "returnTo",
} as const;

export type ListFieldName = (typeof LIST_FIELD)[keyof typeof LIST_FIELD];

/** Mirrors the service limits (src/server/lists/list-service.ts) for `maxLength` / `min` / `max`. */
export const LIST_INPUT_LIMITS = {
  nameMax: 60,
  noteMax: 200,
  quantityMin: 1,
  quantityMax: 99,
  maxListsPerSession: 20,
  maxItemsPerList: 200,
} as const;

export type ListSharingMode = "enable" | "disable" | "rotate";
export const LIST_SHARING_MODES: readonly ListSharingMode[] = ["enable", "disable", "rotate"];

/** 0 = low, 1 = medium, 2 = high. */
export const LIST_PRIORITY_VALUES = ["0", "1", "2"] as const;

export type ListActionSuccessKind =
  | "added"
  | "already_present"
  | "removed"
  | "updated"
  | "moved"
  | "created"
  | "renamed"
  | "deleted"
  | "sharing"
  | "add_all";

export type ListAddAllItemResult = "added" | "capped" | "out_of_stock" | "unavailable";

export interface ListActionSuccess {
  readonly ok: true;
  readonly kind: ListActionSuccessKind;
  readonly message: string;
  /** The list acted on (the created list for createList, the target for addToList / moveListItem). */
  readonly listId?: string;
  /** `/lists/shared/<token>` for the owner only (setListSharing); null when disabled. */
  readonly sharePath?: string | null;
  /** addAllToCart only, in list order. */
  readonly perItem?: readonly { readonly productId: string; readonly result: ListAddAllItemResult }[];
}

/** `null` = not yet submitted. */
export type ListActionState =
  | null
  | ListActionSuccess
  | {
      readonly ok: false;
      readonly error: AppError;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      /** Keyed by `LIST_FIELD` names. */
      readonly fieldErrors?: Readonly<Record<string, string>>;
      /** Echo of `name` / `note` (truncated to their limits) for re-filling the form. */
      readonly values?: Readonly<Record<string, string>>;
      /** Present only for RATE_LIMITED. */
      readonly retryAfterSeconds?: number;
    };

/** Signature for `useActionState` / `<form action>`. */
export type ListActionFn = (prev: ListActionState, formData: FormData) => Promise<ListActionState>;

export const initialListActionState: ListActionState = null;

/** Public path of a shared list for a share token. */
export function sharedListPath(token: string): string {
  return `/lists/shared/${token}`;
}
