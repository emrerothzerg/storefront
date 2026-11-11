"use client";

import { useActionState } from "react";
import { Button } from "@/components/atoms/Button";
import { Notice } from "@/components/atoms/Notice";
import { Text } from "@/components/atoms/Typography";
import { QA_FIELD, initialQaVoteActionState, type QaVoteActionFn } from "../_contracts/qa-actions";
import { retryText } from "../QuestionForm/qa-shared";

export interface HelpfulVoteProps {
  /** `voteQuestion` / `voteAnswer` server action (passed straight to the form for no-JS posts). */
  action: QaVoteActionFn;
  /** Which hidden id the action reads. */
  target: "question" | "answer";
  targetId: string;
  productSlug: string;
  helpfulCount: number;
  /** Own content: no vote button. */
  isOwn?: boolean;
  votedByViewer?: boolean;
  /** Id of the question text: the "Helpful (n)" button is described by it so repeated buttons stay distinguishable. */
  describedBy?: string;
}

/** "1 person found this helpful" / "3 people found this helpful". */
export function helpfulCountText(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"} found this helpful`;
}

function safeCount(n: number): number {
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * One helpful-vote form. Each instance owns its own `useActionState`, so
 * pending/errors are independent per question/answer. The count is never
 * posted; the server returns the new count.
 */
export function HelpfulVote({
  action,
  target,
  targetId,
  productSlug,
  helpfulCount,
  isOwn = false,
  votedByViewer = false,
  describedBy,
}: HelpfulVoteProps) {
  const [state, formAction, isPending] = useActionState(action, initialQaVoteActionState);
  const count = safeCount(state?.ok === true ? state.helpfulCount : helpfulCount);

  if (isOwn) {
    return count > 0 ? (
      <Text variant="small" tone="secondary">
        {helpfulCountText(count)}
      </Text>
    ) : null;
  }

  const alreadyVoted =
    state?.ok === false && (state.error.code === "DUPLICATE" || state.error.code === "ALREADY_VOTED");
  const voted = votedByViewer || state?.ok === true || alreadyVoted;
  const failure = state?.ok === false && !alreadyVoted ? state : null;
  const retry = failure?.error.code === "RATE_LIMITED" ? retryText(failure.retryAfterSeconds) : null;

  return (
    <form action={formAction} className="flex min-w-0 flex-col gap-2">
      <input
        type="hidden"
        name={target === "question" ? QA_FIELD.questionId : QA_FIELD.answerId}
        value={targetId}
      />
      <input type="hidden" name={QA_FIELD.productSlug} value={productSlug} />
      {voted ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Text as="span" variant="small" tone="success">
            You found this helpful
          </Text>
          {count > 0 ? (
            <Text as="span" variant="small" tone="secondary">
              {helpfulCountText(count)}
            </Text>
          ) : null}
        </div>
      ) : (
        <div>
          <Button type="submit" variant="secondary" size="sm" loading={isPending} aria-describedby={describedBy}>
            {`Helpful (${count})`}
          </Button>
        </div>
      )}
      {failure ? (
        <Notice tone="danger">
          {failure.message}
          {retry ? ` ${retry}` : null}
        </Notice>
      ) : null}
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {state?.ok === true ? state.message : ""}
      </span>
    </form>
  );
}
