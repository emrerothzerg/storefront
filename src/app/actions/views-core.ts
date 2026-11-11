import type {
  RecordViewBeacon,
  ViewActionFn,
  ViewActionState,
  ViewFieldName,
  ViewSuccessKind,
} from "@/components/molecules/_contracts/view-actions";
import { CLEAR_HISTORY_CONFIRM_VALUE, VIEW_FIELD } from "@/components/molecules/_contracts/view-actions";
import { appError, fail, ok, type AppError, type Result } from "@/lib/result";
import type { RecommendationService } from "@/server/recommendations/recommendation-service";
import { MAX_ID_LENGTH } from "@/server/recommendations/recommendation-service";
import type { RateLimiter, RateLimitRule } from "@/server/security/rate-limiter";

/**
 * Framework-free view-tracking / browsing-history action logic (T52).
 * `views.ts` wires these to Next.js (`getRecommendationService()`, product
 * lookup, `getRateLimiter()`, session helpers, `revalidatePath`); tests inject
 * fakes.
 *
 * Rules:
 * - Only `VIEW_FIELD` names are read; the owner key comes from the cookie.
 * - record: resolve the product WITHOUT touching the session (unknown or
 *   malformed -> "ignored", no cookie, D10) -> getOrCreateSessionId (lazy
 *   cookie) -> rate limit `views.record:<sid>` 120/min -> `recordView` upsert.
 *   Never revalidates (it runs on every PDP view).
 * - remove/clear: parse -> readSessionId (null -> "ignored", nothing created)
 *   -> rate limit `views.history:<sid>` 120/min (SR9) -> service ->
 *   revalidate `/account/history`.
 * - Every outcome is a state; unexpected exceptions become a generic error
 *   state and are logged as an error code + action name only (no ids, no
 *   input, no PII).
 */

export interface ViewActionDeps {
  readonly service: Pick<RecommendationService, "recordView" | "removeView" | "clearViews">;
  /** Returns the product id for a slug, or null when no such product exists. */
  readonly findProductIdBySlug: (slug: string) => string | null;
  /**
   * Optional existence check for a posted `productId`. When provided, an
   * unknown id is ignored before any session is created. When absent, a bare
   * `productId` is only recorded for a visitor who already has a session
   * (never mints a cookie), and the service's NOT_FOUND maps to "ignored".
   */
  readonly productExists?: (productId: string) => boolean;
  readonly limiter: RateLimiter;
  readonly getOrCreateSessionId: () => Promise<string>;
  readonly readSessionId: () => Promise<string | null>;
  readonly revalidatePath: (path: string, type?: "page" | "layout") => void;
  /** Epoch milliseconds passed to `recordView`; service clock when absent. */
  readonly now?: () => number;
  readonly logger?: Pick<Console, "error">;
}

export interface ViewActions {
  readonly recordProductView: RecordViewBeacon;
  readonly recordProductViewForm: ViewActionFn;
  readonly removeFromHistory: ViewActionFn;
  readonly clearHistory: ViewActionFn;
}

export const PRODUCT_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;
export const PRODUCT_SLUG_MAX_LENGTH = 100;
export const PRODUCT_ID_MAX_LENGTH = MAX_ID_LENGTH;
export const ACCOUNT_HISTORY_PATH = "/account/history";
/** The account hub: its history tile count changes on remove / clear. */
export const ACCOUNT_HUB_PATH = "/account";

/** Local rules (the shared limiter table has no `views` action). */
export const VIEW_RECORD_RATE_LIMIT: RateLimitRule = Object.freeze({ limit: 120, windowSeconds: 60 });
export const VIEW_HISTORY_RATE_LIMIT: RateLimitRule = Object.freeze({ limit: 120, windowSeconds: 60 });
export const VIEW_RECORD_LIMIT_PREFIX = "views.record";
export const VIEW_HISTORY_LIMIT_PREFIX = "views.history";

/** Logged (with the action name) when an action hits an unexpected exception. */
export const VIEW_ACTION_FAILED = "VIEW_ACTION_FAILED";

export const VIEW_MESSAGES = {
  removed: "Removed from your browsing history.",
  cleared: "Your browsing history has been cleared.",
  invalidRequest: "Something was wrong with that request.",
  confirmRequired: "Please confirm that you want to clear your browsing history.",
  rateLimitedFallback: "Too many requests. Please try again later.",
  unexpected: "Something went wrong. Please try again.",
} as const;

// ---------------------------------------------------------------------------
// Parsing (all total: never throw)
// ---------------------------------------------------------------------------

/** A slug when `raw` is a string matching `^[a-z0-9-]{1,100}$`, else null. */
export function parseSlugValue(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > PRODUCT_SLUG_MAX_LENGTH) return null;
  return PRODUCT_SLUG_PATTERN.test(raw) ? raw : null;
}

/** A trimmed id of 1..200 chars when `raw` is a string, else null. */
export function parseIdValue(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Length guard before trim so a huge value costs nothing.
  if (raw.length > PRODUCT_ID_MAX_LENGTH * 4) return null;
  const value = raw.trim();
  return value.length >= 1 && value.length <= PRODUCT_ID_MAX_LENGTH ? value : null;
}

export interface ViewTarget {
  readonly productId: string | null;
  readonly productSlug: string | null;
}

/** Reads the beacon argument; anything that is not a plain object yields no target. */
export function parseBeaconInput(input: unknown): ViewTarget {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { productId: null, productSlug: null };
  }
  const record = input as Readonly<Record<string, unknown>>;
  return {
    productId: parseIdValue(Object.hasOwn(record, VIEW_FIELD.productId) ? record[VIEW_FIELD.productId] : undefined),
    productSlug: parseSlugValue(
      Object.hasOwn(record, VIEW_FIELD.productSlug) ? record[VIEW_FIELD.productSlug] : undefined,
    ),
  };
}

function isFormData(value: unknown): value is FormData {
  return typeof FormData !== "undefined" && value instanceof FormData;
}

/** Reads `productId` / `productSlug` from a form; non-FormData yields no target. */
export function parseFormTarget(formData: unknown): ViewTarget {
  if (!isFormData(formData)) return { productId: null, productSlug: null };
  return {
    productId: parseIdValue(formData.get(VIEW_FIELD.productId)),
    productSlug: parseSlugValue(formData.get(VIEW_FIELD.productSlug)),
  };
}

function invalidField(field: ViewFieldName, message: string = VIEW_MESSAGES.invalidRequest): Result<never> {
  return fail("INVALID_INPUT", message, { field });
}

/** Required `productId` for removeFromHistory. */
export function parseRequiredProductId(formData: unknown): Result<string> {
  if (!isFormData(formData)) return invalidField(VIEW_FIELD.productId);
  const value = parseIdValue(formData.get(VIEW_FIELD.productId));
  return value === null ? invalidField(VIEW_FIELD.productId) : ok(value);
}

/** `confirm` must be exactly "yes". */
export function parseConfirm(formData: unknown): Result<true> {
  if (!isFormData(formData)) return invalidField(VIEW_FIELD.confirm, VIEW_MESSAGES.confirmRequired);
  return formData.get(VIEW_FIELD.confirm) === CLEAR_HISTORY_CONFIRM_VALUE
    ? ok(true)
    : invalidField(VIEW_FIELD.confirm, VIEW_MESSAGES.confirmRequired);
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function readPositiveInt(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}

export function rateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return VIEW_MESSAGES.rateLimitedFallback;
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many requests. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

function errorState(error: AppError, retryAfterSeconds?: number): ViewActionState {
  return retryAfterSeconds === undefined
    ? { ok: false, error, message: error.message }
    : { ok: false, error, message: error.message, retryAfterSeconds };
}

const KNOWN_FIELDS: ReadonlySet<unknown> = new Set(Object.values(VIEW_FIELD));

/** Maps any error to a user-safe state; `details` is rebuilt from a whitelist. */
export function toErrorState(error: AppError): ViewActionState {
  switch (error.code) {
    case "RATE_LIMITED": {
      const retryAfterSeconds = readPositiveInt(error.details, "retryAfterSeconds");
      const message = rateLimitedMessage(retryAfterSeconds);
      return retryAfterSeconds === undefined
        ? errorState(appError("RATE_LIMITED", message))
        : errorState(appError("RATE_LIMITED", message, { retryAfterSeconds }), retryAfterSeconds);
    }
    case "INVALID_INPUT": {
      const field = error.details?.field;
      const message =
        field === VIEW_FIELD.confirm ? VIEW_MESSAGES.confirmRequired : VIEW_MESSAGES.invalidRequest;
      return errorState(
        KNOWN_FIELDS.has(field) ? appError("INVALID_INPUT", message, { field }) : appError("INVALID_INPUT", message),
      );
    }
    default:
      return errorState(appError(error.code, VIEW_MESSAGES.invalidRequest));
  }
}

/** Generic state for unexpected exceptions. No internal detail leaves the server. */
export function unexpectedErrorState(): ViewActionState {
  return errorState(appError("VALIDATION_FAILED", VIEW_MESSAGES.unexpected, { reason: "unexpected" }));
}

const SUCCESS_MESSAGE: Readonly<Partial<Record<ViewSuccessKind, string>>> = {
  removed: VIEW_MESSAGES.removed,
  cleared: VIEW_MESSAGES.cleared,
};

function success(kind: ViewSuccessKind): ViewActionState {
  const message = SUCCESS_MESSAGE[kind];
  return message === undefined ? { ok: true, kind } : { ok: true, kind, message };
}

export const IGNORED: ViewActionState = Object.freeze({ ok: true, kind: "ignored" });

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type ActionName = "record" | "recordForm" | "remove" | "clear";

export function createViewActions(deps: ViewActionDeps): ViewActions {
  const { service, findProductIdBySlug, productExists, limiter, getOrCreateSessionId, readSessionId, revalidatePath, now } =
    deps;
  const logger = deps.logger ?? console;

  async function settle(name: ActionName, body: () => Promise<ViewActionState>): Promise<ViewActionState> {
    try {
      return await body();
    } catch {
      // Error code + action name only: the exception may carry ids or input.
      try {
        logger.error(`[views] ${VIEW_ACTION_FAILED} action=${name}`);
      } catch {
        // A failing logger must never stop the action from settling.
      }
      return unexpectedErrorState();
    }
  }

  /**
   * Resolves the target to a known product id, or null. Never touches the
   * session. A bare id without `productExists` is returned with
   * `verified: false` so the caller only records it for an existing session.
   */
  function resolve(target: ViewTarget): { readonly id: string; readonly verified: boolean } | null {
    if (target.productSlug !== null) {
      const id = findProductIdBySlug(target.productSlug);
      if (id !== null) return { id, verified: true };
    }
    if (target.productId === null) return null;
    if (productExists === undefined) return { id: target.productId, verified: false };
    return productExists(target.productId) ? { id: target.productId, verified: true } : null;
  }

  async function record(target: ViewTarget): Promise<ViewActionState> {
    const product = resolve(target);
    if (product === null) return IGNORED;

    let sessionId: string;
    if (product.verified) {
      sessionId = await getOrCreateSessionId();
    } else {
      const existing = await readSessionId();
      if (existing === null) return IGNORED;
      sessionId = existing;
    }

    const limited = limiter.check(`${VIEW_RECORD_LIMIT_PREFIX}:${sessionId}`, VIEW_RECORD_RATE_LIMIT);
    if (!limited.ok) return toErrorState(limited.error);

    const result = service.recordView(sessionId, product.id, now?.());
    if (!result.ok) {
      // NOT_FOUND (product vanished / unverified id) and a bad id are silent.
      if (result.error.code === "NOT_FOUND" || result.error.code === "INVALID_INPUT") return IGNORED;
      return toErrorState(result.error);
    }
    return success("recorded");
  }

  /** Never throws, whatever the caller passes (objects, arrays, huge strings). */
  const recordProductView: RecordViewBeacon = async (input) => {
    let target: ViewTarget;
    try {
      target = parseBeaconInput(input as unknown);
    } catch {
      return IGNORED;
    }
    return settle("record", () => record(target));
  };

  const recordProductViewForm: ViewActionFn = async (_prev, formData) => {
    let target: ViewTarget;
    try {
      target = parseFormTarget(formData as unknown);
    } catch {
      return IGNORED;
    }
    return settle("recordForm", () => record(target));
  };

  /** Shared tail of remove/clear: existing session only, rate limited, revalidates. */
  async function mutateHistory(run: (sessionId: string) => void, kind: "removed" | "cleared"): Promise<ViewActionState> {
    const sessionId = await readSessionId();
    if (sessionId === null) return IGNORED;
    const limited = limiter.check(`${VIEW_HISTORY_LIMIT_PREFIX}:${sessionId}`, VIEW_HISTORY_RATE_LIMIT);
    if (!limited.ok) return toErrorState(limited.error);
    run(sessionId);
    revalidatePath(ACCOUNT_HISTORY_PATH);
    revalidatePath(ACCOUNT_HUB_PATH);
    return success(kind);
  }

  const removeFromHistory: ViewActionFn = async (_prev, formData) =>
    settle("remove", async () => {
      const productId = parseRequiredProductId(formData as unknown);
      if (!productId.ok) return toErrorState(productId.error);
      return mutateHistory((sessionId) => service.removeView(sessionId, productId.value), "removed");
    });

  const clearHistory: ViewActionFn = async (_prev, formData) =>
    settle("clear", async () => {
      const confirmed = parseConfirm(formData as unknown);
      if (!confirmed.ok) return toErrorState(confirmed.error);
      return mutateHistory((sessionId) => service.clearViews(sessionId), "cleared");
    });

  return { recordProductView, recordProductViewForm, removeFromHistory, clearHistory };
}
