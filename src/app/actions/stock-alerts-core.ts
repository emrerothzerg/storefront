import type {
  StockAlertActionFn,
  StockAlertActionState,
  StockAlertFieldName,
  StockAlertSuccessKind,
} from "@/components/molecules/_contracts/stock-alert-actions";
import { STOCK_ALERT_FIELD } from "@/components/molecules/_contracts/stock-alert-actions";
import { appError, fail, ok, type AppError, type Result } from "@/lib/result";
import type { StockAlertService } from "@/server/alerts/stock-alert-service";
import { MAX_ALERTS_PER_SESSION } from "@/server/alerts/stock-alert-service";
import { limitAction, type RateLimiter } from "@/server/security/rate-limiter";

/**
 * Framework-free stock alert action logic (T50). `stock-alerts.ts` wires these
 * to Next.js (`getOrCreateSessionId`, `readSessionId`, `getStockAlertService()`,
 * `getRateLimiter()`, `revalidatePath`); tests inject fakes.
 *
 * Rules:
 * - Only `productId`, `productSlug` and `alertId` are read from the form.
 *   No email, session id or status is ever read from the client.
 * - subscribe: parse -> getOrCreateSessionId (lazy cookie) -> rate limit ->
 *   service. unsubscribe/acknowledge: parse -> readSessionId (no cookie means
 *   NOT_FOUND, nothing created) -> service.
 * - Every outcome is a state; unexpected exceptions become a generic error
 *   state and are logged as an error code only (no ids, no input, no PII).
 */

export interface StockAlertActionDeps {
  readonly service: StockAlertService;
  readonly limiter: RateLimiter;
  readonly getOrCreateSessionId: () => Promise<string>;
  readonly readSessionId: () => Promise<string | null>;
  readonly revalidatePath: (path: string, type?: "page" | "layout") => void;
  /** Epoch milliseconds passed to the service; service default when absent. */
  readonly now?: () => number;
}

export interface StockAlertActions {
  readonly subscribeStockAlert: StockAlertActionFn;
  readonly unsubscribeStockAlert: StockAlertActionFn;
  readonly acknowledgeStockAlert: StockAlertActionFn;
}

/** Matches the service's longest lookup id. */
export const STOCK_ALERT_ID_MAX_LENGTH = 200;
export const PRODUCT_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;
export const ACCOUNT_ALERTS_PATH = "/account/alerts";
/** The account hub: its alerts tile count and back-in-stock strip change with every alert write. */
export const ACCOUNT_HUB_PATH = "/account";

/** Logged (with the action name) when an action hits an unexpected exception. */
export const STOCK_ALERT_ACTION_FAILED = "STOCK_ALERT_ACTION_FAILED";

export const STOCK_ALERT_MESSAGES = {
  subscribed: "We'll let you know here when this item is back in stock.",
  alreadyRegistered: "You already have an alert for this item.",
  unsubscribed: "Stock alert removed.",
  acknowledged: "Alert dismissed.",
  invalidRequest: "Something was wrong with that request.",
  alreadyAvailable: "Good news: this item is in stock now.",
  productNotFound: "This product is no longer available.",
  limitReached: `You can have up to ${MAX_ALERTS_PER_SESSION} stock alerts. Remove one to add another.`,
  alertNotFound: "That alert could not be found. It may have been removed already.",
  rateLimitedFallback: "Too many requests. Please try again later.",
  unexpected: "Something went wrong. Please try again.",
} as const;

const SUCCESS_MESSAGE: Readonly<Record<StockAlertSuccessKind, string>> = {
  subscribed: STOCK_ALERT_MESSAGES.subscribed,
  already_registered: STOCK_ALERT_MESSAGES.alreadyRegistered,
  unsubscribed: STOCK_ALERT_MESSAGES.unsubscribed,
  acknowledged: STOCK_ALERT_MESSAGES.acknowledged,
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function invalidField(field: StockAlertFieldName): Result<never> {
  return fail("INVALID_INPUT", STOCK_ALERT_MESSAGES.invalidRequest, { field });
}

/** Reads a required id field: a string, trimmed, 1..200 chars. Anything else is INVALID_INPUT. */
export function parseIdField(formData: FormData, field: "productId" | "alertId"): Result<string> {
  const raw = formData.get(STOCK_ALERT_FIELD[field]);
  if (typeof raw !== "string") return invalidField(STOCK_ALERT_FIELD[field]);
  // Length guard before trim so a huge value costs nothing.
  if (raw.length > STOCK_ALERT_ID_MAX_LENGTH * 4) return invalidField(STOCK_ALERT_FIELD[field]);
  const value = raw.trim();
  if (value.length < 1 || value.length > STOCK_ALERT_ID_MAX_LENGTH) return invalidField(STOCK_ALERT_FIELD[field]);
  return ok(value);
}

/** Optional `productSlug`: returned only when it matches `^[a-z0-9-]{1,100}$`, else null (never an error). */
export function parseProductSlug(formData: FormData): string | null {
  const raw = formData.get(STOCK_ALERT_FIELD.productSlug);
  if (typeof raw !== "string" || raw.length > 100) return null;
  return PRODUCT_SLUG_PATTERN.test(raw) ? raw : null;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function readPositiveInt(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}

export function rateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return STOCK_ALERT_MESSAGES.rateLimitedFallback;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many requests. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

const KNOWN_FIELDS: ReadonlySet<unknown> = new Set(Object.values(STOCK_ALERT_FIELD));

function errorState(error: AppError, retryAfterSeconds?: number): StockAlertActionState {
  return retryAfterSeconds === undefined
    ? { ok: false, error, message: error.message }
    : { ok: false, error, message: error.message, retryAfterSeconds };
}

/**
 * Maps any service/limiter error to a user-safe state. `details` is rebuilt
 * from a whitelist (field name, reason, limit, retryAfterSeconds) so raw input
 * such as a posted product id never reaches the client.
 */
export function toErrorState(error: AppError): StockAlertActionState {
  switch (error.code) {
    case "RATE_LIMITED": {
      const retryAfterSeconds = readPositiveInt(error.details, "retryAfterSeconds");
      const message = rateLimitedMessage(retryAfterSeconds);
      return retryAfterSeconds === undefined
        ? errorState(appError("RATE_LIMITED", message))
        : errorState(appError("RATE_LIMITED", message, { retryAfterSeconds }), retryAfterSeconds);
    }
    case "INVALID_INPUT": {
      if (error.details?.reason === "already_available") {
        return errorState(appError("INVALID_INPUT", STOCK_ALERT_MESSAGES.alreadyAvailable, { reason: "already_available" }));
      }
      const field = error.details?.field;
      return errorState(
        KNOWN_FIELDS.has(field)
          ? appError("INVALID_INPUT", STOCK_ALERT_MESSAGES.invalidRequest, { field })
          : appError("INVALID_INPUT", STOCK_ALERT_MESSAGES.invalidRequest),
      );
    }
    case "PRODUCT_NOT_FOUND":
      return errorState(appError("PRODUCT_NOT_FOUND", STOCK_ALERT_MESSAGES.productNotFound));
    case "LIMIT_REACHED":
      return errorState(appError("LIMIT_REACHED", STOCK_ALERT_MESSAGES.limitReached, { limit: MAX_ALERTS_PER_SESSION }));
    case "NOT_FOUND":
      return errorState(appError("NOT_FOUND", STOCK_ALERT_MESSAGES.alertNotFound));
    default:
      return errorState(appError(error.code, STOCK_ALERT_MESSAGES.invalidRequest));
  }
}

/** Generic state for unexpected exceptions. No internal detail leaves the server. */
export function unexpectedErrorState(): StockAlertActionState {
  return errorState(appError("VALIDATION_FAILED", STOCK_ALERT_MESSAGES.unexpected, { reason: "unexpected" }));
}

function success(kind: StockAlertSuccessKind): StockAlertActionState {
  return { ok: true, kind, message: SUCCESS_MESSAGE[kind] };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type ActionName = "subscribe" | "unsubscribe" | "acknowledge";

export function createStockAlertActions(deps: StockAlertActionDeps): StockAlertActions {
  const { service, limiter, getOrCreateSessionId, readSessionId, revalidatePath, now } = deps;

  function revalidate(slug: string | null): void {
    if (slug !== null) revalidatePath(`/products/${slug}`);
    revalidatePath(ACCOUNT_ALERTS_PATH);
    revalidatePath(ACCOUNT_HUB_PATH);
  }

  /** Runs `body`, converting any exception into the generic error state. */
  function settled(name: ActionName, body: (formData: FormData) => Promise<StockAlertActionState>): StockAlertActionFn {
    return async (_prevState, formData) => {
      try {
        return await body(formData);
      } catch {
        // Error code + action name only: the exception may carry ids or input.
        console.error(`[stock-alerts] ${STOCK_ALERT_ACTION_FAILED} action=${name}`);
        return unexpectedErrorState();
      }
    };
  }

  const subscribeStockAlert = settled("subscribe", async (formData) => {
    const productId = parseIdField(formData, "productId");
    if (!productId.ok) return toErrorState(productId.error);
    const slug = parseProductSlug(formData);

    const sessionId = await getOrCreateSessionId();
    const limited = limitAction(limiter, "stock_alert.subscribe", sessionId);
    if (!limited.ok) return toErrorState(limited.error);

    const result = service.subscribe(sessionId, productId.value, now?.());
    if (!result.ok) return toErrorState(result.error);
    revalidate(slug);
    return success(result.value.alreadyRegistered ? "already_registered" : "subscribed");
  });

  function byAlertId(
    name: "unsubscribe" | "acknowledge",
    run: (sessionId: string, alertId: string) => Result<unknown>,
    kind: StockAlertSuccessKind,
  ): StockAlertActionFn {
    return settled(name, async (formData) => {
      const alertId = parseIdField(formData, "alertId");
      if (!alertId.ok) return toErrorState(alertId.error);
      const slug = parseProductSlug(formData);

      const sessionId = await readSessionId();
      if (sessionId === null) return toErrorState(appError("NOT_FOUND", STOCK_ALERT_MESSAGES.alertNotFound));

      const result = run(sessionId, alertId.value);
      if (!result.ok) return toErrorState(result.error);
      revalidate(slug);
      return success(kind);
    });
  }

  const unsubscribeStockAlert = byAlertId(
    "unsubscribe",
    (sessionId, alertId) => service.unsubscribe(sessionId, alertId),
    "unsubscribed",
  );
  const acknowledgeStockAlert = byAlertId(
    "acknowledge",
    (sessionId, alertId) => service.acknowledge(sessionId, alertId, now?.()),
    "acknowledged",
  );

  return { subscribeStockAlert, unsubscribeStockAlert, acknowledgeStockAlert };
}
