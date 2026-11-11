import type { AppError } from "@/lib/result";

/**
 * Contract between the order UI (OrderCard T68, OrdersList T94, OrderDetail
 * T95) and the order server actions (T72, `src/app/actions/orders.ts`).
 *
 * Both actions implement `OrderActionFn` (`useActionState` signature), so a
 * plain `<form action={formAction}>` works without JavaScript (SR2).
 *
 * `cancelOrder` reads `orderId` + `confirm` (must be exactly `"yes"`; render a
 * confirmation checkbox / dialog that posts it). `buyAgain` reads `orderId`
 * and optionally `productId` (one line of that order; absent/empty = every
 * line). Quantities always come from the order snapshot; every other field
 * (`sessionId`, `price`, `quantity`, `$ACTION_*`, ...) is ignored.
 *
 * - Owner key from the server-side cookie only. No cookie: ORDER_NOT_FOUND,
 *   and NO session is created (read-only failure).
 * - Rate limit: 60 order mutations per hour per owner key (cancel and buy
 *   again share the budget): RATE_LIMITED with `retryAfterSeconds`.
 * - `cancelOrder` success: `kind: "cancelled"`; revalidates `/orders`,
 *   `/orders/<id>` and the root layout. A second submit (double click, replay)
 *   returns ORDER_NOT_CANCELLABLE; stock is restored exactly once.
 * - `buyAgain` success: `kind: "buy_again"` with `perLine` (one entry per
 *   order line attempted): `added` (full snapshot quantity), `capped` (only
 *   what stock / the 99 per-line cap allowed, possibly nothing more because
 *   the cart already holds it all), `out_of_stock`, `unavailable` (product
 *   removed or not purchasable). Message: "Added N of M items to your cart."
 *   Revalidates `/cart` + root layout only when something was added. Works on
 *   cancelled and shipped orders too.
 * - Always settles with a plain, JSON-serialisable state; `message` is
 *   user-safe and may be shown verbatim.
 *
 * Error codes (`error.code`):
 * - INVALID_INPUT: `details.field` is `"orderId"` (malformed id),
 *   `"confirm"` (cancel without `confirm=yes`) or `"productId"` (not a line of
 *   that order / malformed).
 * - ORDER_NOT_FOUND: unknown, foreign (another owner's) order, or no session.
 * - ORDER_NOT_CANCELLABLE: already cancelled, shipped, or outside the window.
 * - RATE_LIMITED: `retryAfterSeconds` is set.
 * - INTERNAL_ERROR: unexpected server fault (generic message).
 *
 * OrderCard's `buyAgainAction` prop takes `(formData) => ...`; pass
 * `buyAgainFromForm` from `orders.ts` (same behaviour, no previous state) or
 * a `useActionState` dispatcher bound to `buyAgain`.
 */

/** Form field names read by the order actions. */
export const ORDER_FIELD = {
  orderId: "orderId",
  /** Optional: buy again only this line of the order. */
  productId: "productId",
  /** Cancel only: must be exactly `ORDER_CONFIRM_VALUE`. */
  confirm: "confirm",
} as const;

export type OrderFieldName = (typeof ORDER_FIELD)[keyof typeof ORDER_FIELD];

/** The value `confirm` must carry for `cancelOrder`. */
export const ORDER_CONFIRM_VALUE = "yes";

export type OrderLineResult = "added" | "capped" | "out_of_stock" | "unavailable";

export interface OrderPerLineResult {
  readonly productId: string;
  /** Snapshot name from the order. */
  readonly name: string;
  readonly result: OrderLineResult;
}

export type OrderActionKind = "cancelled" | "buy_again";

/** `null` = not yet submitted. */
export type OrderActionState =
  | null
  | {
      readonly ok: true;
      readonly kind: OrderActionKind;
      readonly message: string;
      /** `buy_again` only. */
      readonly perLine?: readonly OrderPerLineResult[];
    }
  | {
      readonly ok: false;
      readonly error: AppError;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      /** Present only for RATE_LIMITED. */
      readonly retryAfterSeconds?: number;
    };

/** Signature for `useActionState` / `<form action>`. */
export type OrderActionFn = (prev: OrderActionState, formData: FormData) => Promise<OrderActionState>;

export const initialOrderActionState: OrderActionState = null;
