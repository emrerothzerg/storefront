import type { AppError } from "@/lib/result";

/**
 * Contract between the review UI (ReviewForm T58, ReviewCard T57,
 * ReviewsSection T76) and the review server actions (T46,
 * `src/app/actions/reviews.ts`).
 *
 * `submitReview` (implements `ReviewActionFn`):
 * - Reads ONLY `productId`, `productSlug`, `rating`, `title`, `body`,
 *   `displayName`. Everything else (`verified`, `helpfulCount`, `status`,
 *   `sessionId`, `isOwn`, `$ACTION_*`, ...) is ignored. Non-string entries
 *   (a `File`) count as missing.
 * - The author is the server-side owner key (cookie), never a form value. The
 *   session cookie is created lazily, only after the input passes validation.
 * - Signed in: the stored display name is the ACCOUNT display name and the
 *   form's `displayName` is ignored (render no name input, or a read-only
 *   hint). Guest: the form's `displayName` (max 50); empty becomes
 *   "Anonymous shopper".
 * - Rate limited (5/hour per owner key, 300/hour global) before anything is
 *   stored: `RATE_LIMITED` with `retryAfterSeconds`.
 * - On success revalidates `/products/<productSlug>` when `productSlug`
 *   matches `^[a-z0-9-]{1,100}$` (send it as a hidden input).
 * - Always settles with a plain, JSON-serializable state; `message` and the
 *   `fieldErrors` strings are user-safe and may be shown verbatim.
 *
 * `voteReviewHelpful` (implements `VoteActionFn`): reads `reviewId` and
 * optional `productSlug` only. Rate limited 60/hour per owner key, 3000/hour
 * global. A first vote with no cookie creates the session and counts once.
 *
 * Error codes to expect (`error.code`):
 * - submit VALIDATION_FAILED / TOO_LONG: see `fieldErrors` (one message per
 *   field); `error.details.fields` holds per-field codes (REQUIRED, INVALID,
 *   TOO_LONG, TOO_MANY_URLS). A missing/invalid `productId` (a hidden input,
 *   so not user-fixable) is reported as VALIDATION_FAILED with
 *   `error.details.fields.productId === "REQUIRED"` and a generic message;
 *   it has no `fieldErrors` entry.
 * - submit PRODUCT_NOT_FOUND: the product no longer exists.
 * - submit DUPLICATE: "You already reviewed this product." (one per owner key).
 * - vote INVALID_INPUT: missing/invalid `reviewId`.
 * - vote DUPLICATE: already voted; FORBIDDEN: own review; NOT_FOUND: unknown
 *   or hidden review.
 * - RATE_LIMITED: `retryAfterSeconds` is set.
 * - INVALID_INPUT with `details.reason === "unavailable"`: server fault; the
 *   values are echoed so the user can retry.
 */

/** Form field names posted by the review forms. */
export const REVIEW_FIELD = {
  productId: "productId",
  productSlug: "productSlug",
  rating: "rating",
  title: "title",
  body: "body",
  displayName: "displayName",
  reviewId: "reviewId",
} as const;

export type ReviewFieldName = (typeof REVIEW_FIELD)[keyof typeof REVIEW_FIELD];

/**
 * Values echoed back on failure so the form can re-fill itself without
 * JavaScript. Truncated to the input caps (title 100, body 2000, display name
 * 50; rating only when it is a single digit 1-5). `displayName` is never
 * echoed for signed-in users. Never contains ids or the review id.
 */
export interface ReviewEchoValues {
  readonly rating?: string;
  readonly title?: string;
  readonly body?: string;
  readonly displayName?: string;
}

/** `null` = not yet submitted. */
export type ReviewActionState =
  | null
  | { readonly ok: true; readonly kind: "created"; readonly message: string; readonly reviewId: string }
  | {
      readonly ok: false;
      readonly error: AppError;
      /** User-safe; equal to `error.message`. */
      readonly message: string;
      readonly fieldErrors: Readonly<Partial<Record<keyof ReviewEchoValues, string>>>;
      readonly values: ReviewEchoValues;
      /** Present only for RATE_LIMITED. */
      readonly retryAfterSeconds?: number;
    };

/** `null` = not yet submitted. */
export type VoteActionState =
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

/** Signature for `useActionState` / `<form action>`. */
export type ReviewActionFn = (prev: ReviewActionState, formData: FormData) => Promise<ReviewActionState>;

/** Signature for `useActionState` / `<form action>`. */
export type VoteActionFn = (prev: VoteActionState, formData: FormData) => Promise<VoteActionState>;

export const initialReviewActionState: ReviewActionState = null;
export const initialVoteActionState: VoteActionState = null;
