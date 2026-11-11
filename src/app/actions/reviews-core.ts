import type {
  ReviewActionFn,
  ReviewActionState,
  ReviewEchoValues,
  VoteActionFn,
  VoteActionState,
} from "@/components/molecules/_contracts/review-actions";
import { REVIEW_FIELD } from "@/components/molecules/_contracts/review-actions";
import { appError, type AppError } from "@/lib/result";
import {
  REVIEW_BODY_MAX,
  REVIEW_DISPLAY_NAME_MAX,
  REVIEW_TITLE_MAX,
  validateReviewInput,
  type ReviewField,
  type ReviewFieldErrorCode,
  type ReviewService,
} from "@/server/reviews/review-service";
import { limitAction, type RateLimiter } from "@/server/security/rate-limiter";

/**
 * Framework-free review action logic (T46). `reviews.ts` wires it to Next.js
 * (`getOrCreateSessionId`, `readCurrentUser`, `getReviewService()`,
 * `getRateLimiter()`, `revalidatePath`); tests inject fakes.
 *
 * Flow of `submitReview`:
 * 1. Read the `REVIEW_FIELD` strings only (non-string = missing). Forged
 *    `verified`, `helpfulCount`, `status`, `sessionId`, `isOwn` are never read.
 * 2. `readCurrentUser()` (never sets cookies): signed in -> the account display
 *    name replaces the form's `displayName`; guest -> the form value.
 * 3. Local pre-check: `productId` shape + `validateReviewInput` (the service's
 *    own DB-free rules and messages). A failure returns field errors without
 *    creating a session or spending a rate-limit token.
 * 4. `getOrCreateSessionId()` (lazy cookie; returns the owner key, SR11), then
 *    `limitAction("review.submit")` BEFORE the service.
 * 5. `service.create` (authoritative validation, product check, verified flag,
 *    duplicate rule per owner key). Success revalidates `/products/<slug>`.
 *
 * `voteReviewHelpful`: `reviewId` shape -> session -> `limitAction("vote")` ->
 * `service.voteHelpful`.
 *
 * Every outcome is a state. Unexpected exceptions become a generic error state
 * and are logged as an error code only (no ids, no review text, no names).
 */

export interface ReviewActionDeps {
  readonly service: ReviewService;
  readonly limiter: RateLimiter;
  readonly getOrCreateSessionId: () => Promise<string>;
  readonly readCurrentUser: () => Promise<{ readonly displayName: string } | null>;
  readonly revalidatePath: (path: string, type?: "page" | "layout") => void;
  /** Epoch milliseconds passed to `service.create`; service default when absent. */
  readonly now?: () => number;
  /** Receives only `REVIEW_ACTION_FAILED`; defaults to `console`. */
  readonly logger?: Pick<Console, "error">;
}

export interface ReviewActions {
  readonly submitReview: ReviewActionFn;
  readonly voteReviewHelpful: VoteActionFn;
}

/** Matches the service's longest plausible id. */
export const REVIEW_ID_MAX_LENGTH = 200;
export const PRODUCT_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;

/** Logged (with the action name) when an action hits an unexpected exception. */
export const REVIEW_ACTION_FAILED = "REVIEW_ACTION_FAILED";

export const REVIEW_MESSAGES = {
  created: "Thanks! Your review has been posted.",
  invalid: "Some fields are invalid.",
  tooLong: "Some fields are too long.",
  invalidRequest: "Something was wrong with that request.",
  duplicate: "You already reviewed this product.",
  productNotFound: "This product is no longer available.",
  unavailable: "We could not save your review. Please try again.",
  voted: "Thanks for your feedback.",
  alreadyVoted: "You already marked this review as helpful.",
  ownReview: "You cannot vote on your own review.",
  reviewNotFound: "This review is no longer available.",
  voteUnavailable: "We could not record your vote. Please try again.",
  reviewRateLimitedFallback: "You have posted several reviews recently. Please try again later.",
  voteRateLimitedFallback: "You have voted many times recently. Please try again later.",
} as const;

function waitPhrase(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  if (minutes < 120) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return `${Math.ceil(minutes / 60)} hours`;
}

export function reviewRateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return REVIEW_MESSAGES.reviewRateLimitedFallback;
  return `You have posted several reviews recently. Please try again in ${waitPhrase(retryAfterSeconds)}.`;
}

export function voteRateLimitedMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined) return REVIEW_MESSAGES.voteRateLimitedFallback;
  return `You have voted many times recently. Please try again in ${waitPhrase(retryAfterSeconds)}.`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedReviewForm {
  readonly productId: string | undefined;
  readonly productSlug: string | undefined;
  readonly rating: string | undefined;
  readonly title: string | undefined;
  readonly body: string | undefined;
  readonly displayName: string | undefined;
}

function readString(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Reads only the contract fields. A non-string entry (a `File`) is treated as missing. */
export function parseReviewForm(formData: FormData): ParsedReviewForm {
  return {
    productId: readString(formData, REVIEW_FIELD.productId),
    productSlug: readString(formData, REVIEW_FIELD.productSlug),
    rating: readString(formData, REVIEW_FIELD.rating),
    title: readString(formData, REVIEW_FIELD.title),
    body: readString(formData, REVIEW_FIELD.body),
    displayName: readString(formData, REVIEW_FIELD.displayName),
  };
}

/** A required id: trimmed, 1..200 chars; otherwise null. Huge values are rejected before trimming. */
export function normaliseId(raw: string | undefined): string | null {
  if (raw === undefined || raw.length > REVIEW_ID_MAX_LENGTH * 4) return null;
  const value = raw.trim();
  return value.length >= 1 && value.length <= REVIEW_ID_MAX_LENGTH ? value : null;
}

/** Optional slug: returned only when it matches `^[a-z0-9-]{1,100}$`, else null (never an error). */
export function normaliseSlug(raw: string | undefined): string | null {
  if (raw === undefined || raw.length > 100) return null;
  return PRODUCT_SLUG_PATTERN.test(raw) ? raw : null;
}

/** Cuts to `max` UTF-16 units without leaving a dangling high surrogate. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Values to re-fill the form with, truncated to the caps. `rating` only when
 * it is a single digit 1-5; `displayName` only for guests. Never ids.
 */
export function echoValues(parsed: ParsedReviewForm, signedIn: boolean): ReviewEchoValues {
  const out: { -readonly [K in keyof ReviewEchoValues]: string } = {};
  if (parsed.rating !== undefined && parsed.rating.length <= 8) {
    const rating = parsed.rating.trim();
    if (/^[1-5]$/.test(rating)) out.rating = rating;
  }
  if (parsed.title !== undefined) out.title = truncate(parsed.title, REVIEW_TITLE_MAX);
  if (parsed.body !== undefined) out.body = truncate(parsed.body, REVIEW_BODY_MAX);
  if (!signedIn && parsed.displayName !== undefined) {
    out.displayName = truncate(parsed.displayName, REVIEW_DISPLAY_NAME_MAX);
  }
  return out;
}

/**
 * Echo values straight from the form, for paths that fail before the signed-in
 * state is known (e.g. the wrapper when the DB cannot open). Never throws;
 * returns `{}` if the form cannot be read.
 */
export function echoReviewForm(formData: FormData): ReviewEchoValues {
  try {
    return echoValues(parseReviewForm(formData), false);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const ECHO_FIELDS: readonly ReviewField[] = ["rating", "title", "body", "displayName"];
const FIELD_CODES: ReadonlySet<unknown> = new Set<ReviewFieldErrorCode>(["REQUIRED", "INVALID", "TOO_LONG", "TOO_MANY_URLS"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the field-error state from `{ [field]: { code, message } }` (service
 * `details.fields`). Only known fields with a known code and a string message
 * are kept; `error.details.fields` carries codes only. `productIdInvalid` adds
 * `fields.productId = "REQUIRED"` (no `fieldErrors` entry: it is a hidden input).
 */
export function fieldErrorState(source: unknown, values: ReviewEchoValues, productIdInvalid = false): ReviewActionState {
  const fieldErrors: Partial<Record<ReviewField, string>> = {};
  const codes: Partial<Record<ReviewField | "productId", ReviewFieldErrorCode>> = {};
  if (isRecord(source)) {
    for (const field of ECHO_FIELDS) {
      const entry = source[field];
      if (!isRecord(entry)) continue;
      const code = entry.code;
      const message = entry.message;
      if (!FIELD_CODES.has(code) || typeof message !== "string") continue;
      fieldErrors[field] = message;
      codes[field] = code as ReviewFieldErrorCode;
    }
  }
  const userCodes = Object.values(codes);
  if (productIdInvalid) codes.productId = "REQUIRED";
  const allTooLong = !productIdInvalid && userCodes.length > 0 && userCodes.every((c) => c === "TOO_LONG");
  const message = allTooLong
    ? REVIEW_MESSAGES.tooLong
    : productIdInvalid && userCodes.length === 0
      ? REVIEW_MESSAGES.invalidRequest
      : REVIEW_MESSAGES.invalid;
  const error = appError(allTooLong ? "TOO_LONG" : "VALIDATION_FAILED", message, { fields: codes });
  return { ok: false, error, message, fieldErrors, values };
}

function readPositiveInt(details: AppError["details"], key: string): number | undefined {
  const value = details?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.ceil(value);
}

function reviewPlainError(error: AppError, values: ReviewEchoValues, retryAfterSeconds?: number): ReviewActionState {
  const base = { ok: false as const, error, message: error.message, fieldErrors: {}, values };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

function votePlainError(error: AppError, retryAfterSeconds?: number): VoteActionState {
  const base = { ok: false as const, error, message: error.message };
  return retryAfterSeconds === undefined ? base : { ...base, retryAfterSeconds };
}

/** Generic submit state for unexpected failures. No internal detail leaves the server. */
export function unexpectedReviewState(values: ReviewEchoValues = {}): ReviewActionState {
  return reviewPlainError(appError("INVALID_INPUT", REVIEW_MESSAGES.unavailable, { reason: "unavailable" }), values);
}

/** Generic vote state for unexpected failures. */
export function unexpectedVoteState(): VoteActionState {
  return votePlainError(appError("INVALID_INPUT", REVIEW_MESSAGES.voteUnavailable, { reason: "unavailable" }));
}

/** Maps a limiter error to `{ error, retryAfterSeconds }` with a user-safe message. */
function rateLimited(error: AppError, toMessage: (s: number | undefined) => string): { error: AppError; retryAfterSeconds?: number } {
  const retryAfterSeconds = readPositiveInt(error.details, "retryAfterSeconds");
  const message = toMessage(retryAfterSeconds);
  return retryAfterSeconds === undefined
    ? { error: appError("RATE_LIMITED", message) }
    : { error: appError("RATE_LIMITED", message, { retryAfterSeconds }), retryAfterSeconds };
}

/** Maps any submit-path service/limiter error to a user-safe state; `details` rebuilt from a whitelist. */
export function toReviewErrorState(error: AppError, values: ReviewEchoValues): ReviewActionState {
  switch (error.code) {
    case "VALIDATION_FAILED":
    case "TOO_LONG":
      return fieldErrorState(error.details?.fields, values);
    case "RATE_LIMITED": {
      const mapped = rateLimited(error, reviewRateLimitedMessage);
      return reviewPlainError(mapped.error, values, mapped.retryAfterSeconds);
    }
    case "DUPLICATE":
      return reviewPlainError(appError("DUPLICATE", REVIEW_MESSAGES.duplicate), values);
    case "PRODUCT_NOT_FOUND":
      return reviewPlainError(appError("PRODUCT_NOT_FOUND", REVIEW_MESSAGES.productNotFound), values);
    default:
      return unexpectedReviewState(values);
  }
}

/** Maps any vote-path service/limiter error to a user-safe state. */
export function toVoteErrorState(error: AppError): VoteActionState {
  switch (error.code) {
    case "RATE_LIMITED": {
      const mapped = rateLimited(error, voteRateLimitedMessage);
      return votePlainError(mapped.error, mapped.retryAfterSeconds);
    }
    case "DUPLICATE":
      return votePlainError(appError("DUPLICATE", REVIEW_MESSAGES.alreadyVoted));
    case "FORBIDDEN":
      return votePlainError(appError("FORBIDDEN", REVIEW_MESSAGES.ownReview));
    case "NOT_FOUND":
      return votePlainError(appError("NOT_FOUND", REVIEW_MESSAGES.reviewNotFound));
    default:
      return unexpectedVoteState();
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function createReviewActions(deps: ReviewActionDeps): ReviewActions {
  const { service, limiter, getOrCreateSessionId, readCurrentUser, revalidatePath, now } = deps;
  const logger = deps.logger ?? console;

  function revalidateProduct(slug: string | null): void {
    if (slug !== null) revalidatePath(`/products/${slug}`);
  }

  const submitReview: ReviewActionFn = async (_prevState, formData) => {
    let values: ReviewEchoValues = {};
    try {
      const parsed = parseReviewForm(formData);
      // Guest echo first so a failing user lookup still returns the typed values.
      values = echoValues(parsed, false);
      const user = await readCurrentUser();
      const signedIn = user !== null;
      if (signedIn) values = echoValues(parsed, true);

      // Signed in: the account name wins; the form's name field is ignored (criterion 8).
      const displayName = signedIn ? user.displayName : parsed.displayName;
      const productId = normaliseId(parsed.productId);
      const input = { productId: productId ?? "", rating: parsed.rating, title: parsed.title, body: parsed.body, displayName };

      const local = validateReviewInput(input);
      if (productId === null) return fieldErrorState(local.ok ? undefined : local.error.details?.fields, values, true);
      if (!local.ok) return toReviewErrorState(local.error, values);

      const sessionId = await getOrCreateSessionId();
      const limited = limitAction(limiter, "review.submit", sessionId);
      if (!limited.ok) return toReviewErrorState(limited.error, values);

      const result = service.create(sessionId, { ...input, productId }, now?.());
      if (!result.ok) return toReviewErrorState(result.error, values);

      revalidateProduct(normaliseSlug(parsed.productSlug));
      return { ok: true, kind: "created", message: REVIEW_MESSAGES.created, reviewId: result.value.id };
    } catch {
      // Error code only: the exception may carry ids or submitted text.
      logger.error(`[reviews] ${REVIEW_ACTION_FAILED} action=submit`);
      return unexpectedReviewState(values);
    }
  };

  const voteReviewHelpful: VoteActionFn = async (_prevState, formData) => {
    try {
      const reviewId = normaliseId(readString(formData, REVIEW_FIELD.reviewId));
      if (reviewId === null) {
        return votePlainError(appError("INVALID_INPUT", REVIEW_MESSAGES.invalidRequest, { field: REVIEW_FIELD.reviewId }));
      }

      const sessionId = await getOrCreateSessionId();
      const limited = limitAction(limiter, "vote", sessionId);
      if (!limited.ok) return toVoteErrorState(limited.error);

      const result = service.voteHelpful(sessionId, reviewId);
      if (!result.ok) return toVoteErrorState(result.error);

      revalidateProduct(normaliseSlug(readString(formData, REVIEW_FIELD.productSlug)));
      return { ok: true, helpfulCount: result.value.helpfulCount, message: REVIEW_MESSAGES.voted };
    } catch {
      logger.error(`[reviews] ${REVIEW_ACTION_FAILED} action=vote`);
      return unexpectedVoteState();
    }
  };

  return { submitReview, voteReviewHelpful };
}
