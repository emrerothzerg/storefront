import type { AppError } from "@/lib/result";

/**
 * Contract between stock alert UI (StockAlertForm T66, account alerts page
 * T98) and the stock alert server actions (T50, `src/app/actions/stock-alerts.ts`).
 *
 * Server actions implementing `StockAlertActionFn`:
 * - Read ONLY the `STOCK_ALERT_FIELD` names below; every other field
 *   (email, sessionId, status, `$ACTION_*`, ...) is ignored. No email is
 *   collected: alerts are in-app only.
 * - Take the owner key from the server-side cookie, never from the form.
 *   `subscribeStockAlert` creates the session cookie lazily (after the input
 *   parses); `unsubscribeStockAlert` / `acknowledgeStockAlert` never create one.
 * - Always settle with a plain, JSON-serializable state. `message` is
 *   user-safe and may be shown verbatim; it never echoes submitted input.
 * - Revalidate `/account/alerts` on success, plus `/products/<productSlug>`
 *   when a valid slug (`^[a-z0-9-]{1,100}$`) is posted.
 *
 * Field usage per action:
 * - subscribeStockAlert   : productId (required), productSlug (optional, revalidation only)
 * - unsubscribeStockAlert : alertId (required), productSlug (optional)
 * - acknowledgeStockAlert : alertId (required), productSlug (optional)
 *
 * Error codes a form should expect (`error.code`):
 * - INVALID_INPUT: bad/missing field (`details.field`), or the product is in
 *   stock now (`details.reason === "already_available"`).
 * - PRODUCT_NOT_FOUND, LIMIT_REACHED (`details.limit`), NOT_FOUND (alert
 *   unknown / not yours / no session), RATE_LIMITED (`retryAfterSeconds`),
 *   VALIDATION_FAILED with `details.reason === "unexpected"` (server fault).
 */

/** Form field names posted by the stock alert forms. */
export const STOCK_ALERT_FIELD = {
  productId: "productId",
  productSlug: "productSlug",
  alertId: "alertId",
} as const;

export type StockAlertFieldName = (typeof STOCK_ALERT_FIELD)[keyof typeof STOCK_ALERT_FIELD];

export type StockAlertSuccessKind = "subscribed" | "already_registered" | "unsubscribed" | "acknowledged";

/** `null` = not yet submitted. */
export type StockAlertActionState =
  | null
  | { readonly ok: true; readonly kind: StockAlertSuccessKind; readonly message: string }
  | {
      readonly ok: false;
      readonly error: AppError;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      /** Present only for RATE_LIMITED. */
      readonly retryAfterSeconds?: number;
    };

/** Signature for `useActionState` / `<form action>`. */
export type StockAlertActionFn = (
  prevState: StockAlertActionState,
  formData: FormData,
) => Promise<StockAlertActionState>;

export const initialStockAlertActionState: StockAlertActionState = null;
