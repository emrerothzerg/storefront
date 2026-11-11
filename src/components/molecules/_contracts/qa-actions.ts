import type { AppError } from "@/lib/result";

/**
 * Contract between the Q&A UI (QuestionForm / AnswerForm / QuestionCard T59,
 * QASection T77) and the Q&A server actions (T47, `src/app/actions/questions.ts`).
 *
 * Actions and the fields they read (every other field, e.g. `sessionId`,
 * `isStore`, `is_store`, `status`, `helpfulCount`, `$ACTION_*`, is ignored;
 * a non-string entry such as a `File` counts as missing):
 * - askQuestion    (QaActionFn):     productId (required), body, displayName, productSlug
 * - answerQuestion (QaActionFn):     questionId (required), body, displayName, productSlug
 * - voteQuestion   (QaVoteActionFn): questionId (required), productSlug
 * - voteAnswer     (QaVoteActionFn): answerId (required), productSlug
 *
 * Behaviour every form can rely on:
 * - The owner key comes from the server-side cookie, never from the form. The
 *   session cookie is created lazily on the first write, only after the ids
 *   parse (and, for ask/answer, after the text passes the local length/link
 *   checks), so a typo neither sets a cookie nor spends rate-limit budget.
 * - Signed-in shoppers post under their account display name; the posted
 *   `displayName` is ignored (and not echoed). Guests may choose a name
 *   (max 50; blank = "Anonymous shopper").
 * - Rate limited before the service: ask 5/hour, answer 10/hour, votes
 *   60/hour per session, plus global backstops -> `RATE_LIMITED` with
 *   `retryAfterSeconds`.
 * - On success the PDP `/products/<productSlug>` is revalidated, only when a
 *   valid slug (`^[a-z0-9-]{1,100}$`) is posted. Nothing else is revalidated.
 * - Always settle with a plain, JSON-serializable state. `message` and every
 *   `fieldErrors` string are user-safe and may be shown verbatim; they never
 *   echo submitted text.
 *
 * Input caps (mirror with `maxLength`): question 300 (min 10, single line),
 * answer 1000 (line breaks kept), display name 50; at most 2 links per post.
 *
 * Error codes (`error.code`):
 * - INVALID_INPUT: missing/bad id (`details.field` = "productId" |
 *   "questionId" | "answerId"), or `details.reason === "unavailable"` (server
 *   fault; values are echoed so the user can retry).
 * - VALIDATION_FAILED / TOO_LONG: see `fieldErrors.body` / `fieldErrors.displayName`
 *   (`details.field`; `details.reason === "TOO_MANY_URLS"` for link spam).
 * - DUPLICATE: same question already asked on this product (ask, also in
 *   `fieldErrors.body`), or already voted (votes).
 * - LIMIT_REACHED: 3 answers per question per shopper (`details.limit`).
 * - NOT_FOUND: question/answer unknown or removed. PRODUCT_NOT_FOUND: ask on
 *   an unknown/unpublished product.
 * - FORBIDDEN: vote on your own question/answer.
 * - RATE_LIMITED: `retryAfterSeconds` is set.
 */

/** Form field names posted by the Q&A forms. */
export const QA_FIELD = {
  productId: "productId",
  productSlug: "productSlug",
  questionId: "questionId",
  answerId: "answerId",
  body: "body",
  displayName: "displayName",
} as const;

export type QaFieldName = (typeof QA_FIELD)[keyof typeof QA_FIELD];

/**
 * Values echoed back on failure so the form can re-fill itself without
 * JavaScript. Truncated to the caps (body 300 for questions / 1000 for
 * answers, displayName 50). `displayName` is omitted for signed-in shoppers.
 */
export interface QaEchoValues {
  readonly body?: string;
  readonly displayName?: string;
}

/** `null` = not yet submitted. */
export type QaActionState =
  | null
  | {
      readonly ok: true;
      readonly kind: "asked" | "answered";
      /** Id of the new question / answer. */
      readonly id: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly error: AppError;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      readonly fieldErrors: Readonly<Partial<Record<keyof QaEchoValues, string>>>;
      readonly values: QaEchoValues;
      /** Present only for RATE_LIMITED. */
      readonly retryAfterSeconds?: number;
    };

/** `null` = not yet submitted. */
export type QaVoteActionState =
  | null
  | { readonly ok: true; readonly helpfulCount: number; readonly message: string }
  | {
      readonly ok: false;
      readonly error: AppError;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      /** Present only for RATE_LIMITED. */
      readonly retryAfterSeconds?: number;
    };

/** Signature for `useActionState` / `<form action>` (ask, answer). */
export type QaActionFn = (prev: QaActionState, formData: FormData) => Promise<QaActionState>;

/** Signature for `useActionState` / `<form action>` (helpful votes). */
export type QaVoteActionFn = (prev: QaVoteActionState, formData: FormData) => Promise<QaVoteActionState>;

export const initialQaActionState: QaActionState = null;
export const initialQaVoteActionState: QaVoteActionState = null;
