"use client";

import { useActionState, useId } from "react";
import type { Ref } from "react";
import { Avatar } from "@/components/atoms/Avatar";
import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { Icon } from "@/components/atoms/Icon";
import { Rating } from "@/components/atoms/Rating";
import { Heading, Text } from "@/components/atoms/Typography";
// Type-only: molecules never import server code at runtime.
import type { ReviewView } from "@/server/reviews/review-service";
import {
  REVIEW_FIELD,
  initialVoteActionState,
  type VoteActionFn,
  type VoteActionState,
} from "../_contracts/review-actions";
import { parseIsoStrict } from "../DeliveryEstimate/parseIsoStrict";

export interface ReviewCardProps {
  review: ReviewView;
  /** Server action (or any function) matching `VoteActionFn`. */
  voteAction: VoteActionFn;
  /** Sent as a hidden field so the action can revalidate the product page. */
  productSlug: string;
  /** Outline level of the review title. Defaults to 3. */
  headingLevel?: 3 | 4;
  className?: string;
  ref?: Ref<HTMLElement>;
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  // Fixed zone: server and client render the same text (no hydration mismatch).
  timeZone: "UTC",
});

/**
 * "November 7, 2026" for a strict ISO-8601 date-time; `null` for anything else
 * (unparsable, impossible calendar dates, no explicit zone).
 */
export function formatReviewDate(iso: string): string | null {
  const time = parseIsoStrict(iso);
  return time === null ? null : dateFormat.format(new Date(time));
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function helpfulText(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 person found this helpful" : `${count.toLocaleString("en-US")} people found this helpful`;
}

/** User-facing text for a failed vote. */
export function voteErrorMessage(state: Extract<VoteActionState, { ok: false }>): string {
  switch (state.error.code) {
    case "DUPLICATE":
    case "ALREADY_VOTED":
      return "You already marked this review as helpful.";
    case "RATE_LIMITED": {
      const seconds = state.retryAfterSeconds;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
        const minutes = Math.ceil(seconds / 60);
        return `Too many votes. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
      }
      return "Too many votes. Try again later.";
    }
    case "NOT_FOUND":
      return "This review is no longer available.";
    case "FORBIDDEN":
      return "You can't vote on your own review.";
    default:
      return state.message.trim() !== "" ? state.message : "Something went wrong. Please try again.";
  }
}

/** Errors after which voting again cannot succeed, so the button is removed. */
const FINAL_ERROR_CODES: ReadonlySet<string> = new Set(["DUPLICATE", "ALREADY_VOTED", "NOT_FOUND", "FORBIDDEN"]);

/**
 * One customer review. All user text (title, name, body) renders as React
 * text children, never as HTML. The helpful vote is a real `<form>` posting
 * `reviewId` + `productSlug`, so it works without JavaScript; with JS it shows
 * a pending state, a polite "Thanks" confirmation and errors in `role="alert"`.
 */
export function ReviewCard({
  review,
  voteAction,
  productSlug,
  headingLevel = 3,
  className,
  ref,
}: ReviewCardProps) {
  const uid = useId();
  const titleId = `review-title-${uid}`;
  const authorId = `review-author-${uid}`;
  const [state, formAction, isPending] = useActionState(voteAction, initialVoteActionState);

  const date = formatReviewDate(review.createdAt);
  const name = review.displayName.trim() || "Anonymous shopper";
  const title = review.title.trim();

  const succeeded = state?.ok === true;
  const failed = state?.ok === false ? state : null;
  const finalError = failed !== null && FINAL_ERROR_CODES.has(failed.error.code);
  const showForm = review.isOwn !== true && review.votedByViewer !== true && !succeeded && !finalError;
  const count = succeeded ? safeCount(state.helpfulCount) : safeCount(review.helpfulCount);
  const countText = helpfulText(count);

  const classes = [
    "flex min-w-0 flex-col gap-2 break-words border-b border-border-default py-4",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article ref={ref} aria-labelledby={title ? titleId : undefined} className={classes}>
      <div className="flex min-w-0 items-center gap-2">
        <Avatar name={name} size="sm" decorative />
        <Text as="span" variant="small" id={authorId} className="min-w-0 break-words font-semibold">
          {name}
        </Text>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Rating value={review.rating} size="sm" />
        {title ? (
          <Heading level={headingLevel} size="h4" id={titleId} className="min-w-0 break-words">
            {title}
          </Heading>
        ) : null}
      </div>
      {date !== null || review.verifiedPurchase === true ? (
        <div className="flex flex-wrap items-center gap-2">
          {date !== null ? (
            <Text as="span" variant="small" tone="secondary">
              Reviewed on <time dateTime={review.createdAt}>{date}</time>
            </Text>
          ) : null}
          {review.verifiedPurchase === true ? (
            <Badge tone="success" icon={<Icon name="check-circle" size="sm" />}>
              Verified Purchase
            </Badge>
          ) : null}
        </div>
      ) : null}
      <Text className="min-w-0 whitespace-pre-line break-words">{review.body}</Text>

      <div className="flex flex-col gap-2">
        {countText !== null && !showForm ? (
          <Text variant="small" tone="secondary">
            {countText}
          </Text>
        ) : null}
        {review.votedByViewer === true && !succeeded ? (
          <Text variant="small" tone="secondary">
            You found this helpful
          </Text>
        ) : null}
        {showForm ? (
          <form action={formAction} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name={REVIEW_FIELD.reviewId} value={review.id} />
            <input type="hidden" name={REVIEW_FIELD.productSlug} value={productSlug} />
            {/* Each "Helpful (N)" is described by its review's title (or author when
                untitled) so screen-reader users can tell the buttons apart. */}
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={isPending}
              aria-describedby={title ? titleId : authorId}
            >
              {`Helpful (${count.toLocaleString("en-US")})`}
            </Button>
          </form>
        ) : null}
        <p aria-live="polite" aria-atomic="true" className="text-small text-text-primary">
          {succeeded ? "Thanks for your feedback" : null}
        </p>
        {failed !== null ? (
          <p role="alert" className="text-small text-danger">
            {voteErrorMessage(failed)}
          </p>
        ) : null}
      </div>
    </article>
  );
}
