"use server";

import { revalidatePath } from "next/cache";
import type { ReviewActionState, VoteActionState } from "@/components/molecules/_contracts/review-actions";
import { getReviewService } from "@/server/reviews/review-service";
import { getRateLimiter } from "@/server/security/rate-limiter";
import { readCurrentUser } from "@/server/session/current-user";
import { getOrCreateSessionId } from "@/server/session/session";
import {
  REVIEW_ACTION_FAILED,
  createReviewActions,
  echoReviewForm,
  unexpectedReviewState,
  unexpectedVoteState,
  type ReviewActions,
} from "./reviews-core";

/**
 * Review Server Actions (T46). This file may only export async functions
 * (Next 16 `'use server'` rule). Each wrapper builds the actions with real
 * deps at call time (never at import time, so importing this module opens no
 * DB) and delegates to `reviews-core.ts`. Signature `(prevState, formData)` is
 * what `useActionState` binds, so the forms also work without JavaScript.
 */

function build(): ReviewActions | null {
  try {
    return createReviewActions({
      service: getReviewService(),
      limiter: getRateLimiter(),
      getOrCreateSessionId,
      readCurrentUser,
      revalidatePath,
    });
  } catch {
    // Opening the DB failed; the caller still settles. Error code only.
    return null;
  }
}

export async function submitReview(prevState: ReviewActionState, formData: FormData): Promise<ReviewActionState> {
  const built = build();
  if (built === null) {
    console.error(`[reviews] ${REVIEW_ACTION_FAILED} action=init`);
    // Echo what the shopper typed so a no-JS form can re-fill itself (contract).
    return unexpectedReviewState(echoReviewForm(formData));
  }
  return built.submitReview(prevState, formData);
}

export async function voteReviewHelpful(prevState: VoteActionState, formData: FormData): Promise<VoteActionState> {
  const built = build();
  if (built === null) {
    console.error(`[reviews] ${REVIEW_ACTION_FAILED} action=init`);
    return unexpectedVoteState();
  }
  return built.voteReviewHelpful(prevState, formData);
}
