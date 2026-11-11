"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type MouseEvent,
} from "react";
import { Button } from "@/components/atoms/Button";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Rating } from "@/components/atoms/Rating";
import { Textarea } from "@/components/atoms/Textarea";
import { Text } from "@/components/atoms/Typography";
import {
  REVIEW_FIELD,
  initialReviewActionState,
  type ReviewActionFn,
  type ReviewActionState,
  type ReviewEchoValues,
} from "../_contracts/review-actions";

/**
 * Input caps, mirrored from the review service (title 100 / body 2000 /
 * display name 50). Re-declared here because molecules must not import
 * `src/server/**`; a colocated test asserts they equal the service constants.
 */
export const REVIEW_TITLE_MAX = 100;
export const REVIEW_BODY_MAX = 2000;
export const REVIEW_DISPLAY_NAME_MAX = 50;

/** The `<form id>`; pages link to `#write-review`. */
export const REVIEW_FORM_ID = "write-review";

/** Stable element ids (one review form per page), used by the error summary links. */
export const REVIEW_FIELD_IDS = {
  rating: "review-rating",
  title: "review-title",
  body: "review-body",
  displayName: "review-display-name",
} as const satisfies Record<keyof ReviewEchoValues, string>;

const FIELD_LABELS: Readonly<Record<keyof ReviewEchoValues, string>> = {
  rating: "Overall rating",
  title: "Title",
  body: "Review",
  displayName: "Display name",
};

const FIELD_ORDER = ["rating", "title", "body", "displayName"] as const;

export const REVIEW_SUCCESS_MESSAGE = "Thanks! Your review is live.";
export const ALREADY_REVIEWED_MESSAGE = "You already reviewed this product.";
export const DISPLAY_NAME_HINT = "Shown publicly. Leave blank to post as Anonymous shopper.";

export interface ReviewFormProps {
  /** `submitReview` server action (or any function matching the contract). */
  action: ReviewActionFn;
  productId: string;
  /** Posted as a hidden field so the action can revalidate the product page. */
  productSlug: string;
  /** Signed-in account display name: replaces the display name input with "Posting as <name>". */
  signedInName?: string | null;
  /** Renders only a notice (no form). */
  alreadyReviewed?: boolean;
  /** Id of the visible heading that names the form; otherwise the form is labelled "Write a review". */
  headingId?: string;
  className?: string;
}

/** "Try again in N minutes" (rounded up, at least 1), or a generic hint when unknown. */
export function retryAfterText(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return "Try again later.";
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** Echoed rating as a number 1-5, or undefined for anything else. */
export function echoedRating(raw: string | undefined): number | undefined {
  return raw !== undefined && /^[1-5]$/.test(raw) ? Number(raw) : undefined;
}

type Failure = Extract<NonNullable<ReviewActionState>, { ok: false }>;

interface SummaryItem {
  readonly id: string;
  readonly label: string;
  readonly message: string;
}

/** Field errors in form order, skipping empty or non-string messages and `displayName` when it is not rendered. */
export function summaryItems(failure: Failure, includeDisplayName: boolean): SummaryItem[] {
  const fieldErrors = failure.fieldErrors ?? {};
  return FIELD_ORDER.flatMap((field) => {
    if (field === "displayName" && !includeDisplayName) return [];
    const message = fieldErrors[field];
    if (typeof message !== "string" || message.trim() === "") return [];
    return [{ id: REVIEW_FIELD_IDS[field], label: FIELD_LABELS[field], message }];
  });
}

function focusField(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return; // native fragment navigation
  event.preventDefault();
  // The rating id is on the fieldset; focus its checked (or first) radio.
  const focusable =
    target instanceof HTMLFieldSetElement
      ? (target.querySelector<HTMLInputElement>("input:checked") ?? target.querySelector<HTMLInputElement>("input"))
      : target;
  focusable?.focus();
  target.scrollIntoView?.({ block: "center" });
}

const summaryLink = "inline-flex min-h-touch items-center";

/** False during SSR and hydration, true afterwards (no hydration mismatch). */
const noopSubscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export function ReviewForm({
  action,
  productId,
  productSlug,
  signedInName,
  alreadyReviewed = false,
  headingId,
  className,
}: ReviewFormProps) {
  // Until mounted, hand React the RAW server action: the server renderer only
  // emits a real POST form (method, multipart enctype, action ref) for a server
  // reference, and the wrapper below would hide it (no-JS submit broken,
  // D-T97-1). Same pattern as useAuthFormAction / useAccountForm.
  const mounted = useMounted();
  const inFlight = useRef(false);
  // The double-submit guard is released synchronously when the action settles
  // (resolve or throw), so a submit that lands right after the error render is
  // never dropped waiting for a passive effect.
  const guardedAction: ReviewActionFn = async (prev, formData) => {
    try {
      return await action(prev, formData);
    } finally {
      inFlight.current = false;
    }
  };
  const [state, formAction, pending] = useActionState(mounted ? guardedAction : action, initialReviewActionState);

  // Every settled attempt remounts the fields, so defaults come back from the
  // echoed values (error) or empty (success) and the Textarea counter resets.
  // Derived during render (React's "store previous value" pattern).
  const [seenState, setSeenState] = useState<ReviewActionState>(state);
  const [attempt, setAttempt] = useState(0);
  if (seenState !== state) {
    setSeenState(state);
    setAttempt((n) => n + 1);
  }

  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state !== null && !state.ok) summaryRef.current?.focus();
  }, [state]);

  if (alreadyReviewed) {
    return (
      <Notice tone="info" className={className}>
        {ALREADY_REVIEWED_MESSAGE}
      </Notice>
    );
  }

  const name = signedInName?.trim() ? signedInName.trim() : null;
  const failure = state !== null && !state.ok ? state : null;
  const values: ReviewEchoValues = failure?.values ?? {};
  const fieldErrors = failure?.fieldErrors ?? {};
  const fieldError = (field: keyof ReviewEchoValues): string | undefined => {
    const message = fieldErrors[field];
    return typeof message === "string" && message.trim() !== "" ? message : undefined;
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Double-submit guard (Enter key or a second click before the pending render).
    if (pending || inFlight.current) {
      event.preventDefault();
      return;
    }
    // Only the wrapped action releases the guard, so arm it only once it is in use.
    if (mounted) inFlight.current = true;
  };

  let summary = null;
  if (failure) {
    const code = failure.error.code;
    const items = summaryItems(failure, name === null);
    let title: string;
    let body;
    if (code === "RATE_LIMITED") {
      title = "You've posted several reviews recently";
      // The action's message already says when to retry; show our own wording
      // (from retryAfterSeconds) once instead of repeating it.
      body = <p>{retryAfterText(failure.retryAfterSeconds)}</p>;
    } else if (code === "DUPLICATE") {
      title = "Review not posted";
      body = <p>{failure.message}</p>;
    } else if (items.length > 0) {
      title = "Please fix the following";
      body = (
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <li key={item.id}>
              <Link href={`#${item.id}`} className={summaryLink} onClick={(e) => focusField(e, item.id)}>
                {`${item.label}: ${item.message}`}
              </Link>
            </li>
          ))}
        </ul>
      );
    } else {
      title = "Review not posted";
      body = <p>{failure.message}</p>;
    }
    summary = (
      <Notice
        ref={summaryRef}
        tone="danger"
        tabIndex={-1}
        title={title}
        data-testid="review-error-summary"
      >
        {body}
      </Notice>
    );
  }

  const ratingDefault = echoedRating(values.rating);

  return (
    <form
      id={REVIEW_FORM_ID}
      action={formAction}
      onSubmit={onSubmit}
      noValidate
      {...(headingId ? { "aria-labelledby": headingId } : { "aria-label": "Write a review" })}
      className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      {summary}
      <div aria-live="polite" aria-atomic="true">
        {state?.ok === true ? <Notice tone="success">{REVIEW_SUCCESS_MESSAGE}</Notice> : null}
      </div>
      <input type="hidden" name={REVIEW_FIELD.productId} value={productId} />
      <input type="hidden" name={REVIEW_FIELD.productSlug} value={productSlug} />
      <div key={`fields-${attempt}`} className="flex min-w-0 flex-col gap-4">
        <Rating
          mode="input"
          id={REVIEW_FIELD_IDS.rating}
          name={REVIEW_FIELD.rating}
          label={FIELD_LABELS.rating}
          required
          defaultValue={ratingDefault}
          errorText={fieldError("rating")}
        />
        <FormField id={REVIEW_FIELD_IDS.title} label={FIELD_LABELS.title} required error={fieldError("title")}>
          {(p) => (
            <Input
              {...p}
              name={REVIEW_FIELD.title}
              maxLength={REVIEW_TITLE_MAX}
              defaultValue={values.title ?? ""}
              autoComplete="off"
            />
          )}
        </FormField>
        <FormField id={REVIEW_FIELD_IDS.body} label={FIELD_LABELS.body} required error={fieldError("body")}>
          {(p) => (
            <Textarea
              {...p}
              name={REVIEW_FIELD.body}
              maxLength={REVIEW_BODY_MAX}
              showCount
              rows={5}
              defaultValue={values.body ?? ""}
            />
          )}
        </FormField>
        {name === null ? (
          <FormField
            id={REVIEW_FIELD_IDS.displayName}
            label={FIELD_LABELS.displayName}
            hint={DISPLAY_NAME_HINT}
            error={fieldError("displayName")}
          >
            {(p) => (
              <Input
                {...p}
                name={REVIEW_FIELD.displayName}
                maxLength={REVIEW_DISPLAY_NAME_MAX}
                defaultValue={values.displayName ?? ""}
                autoComplete="nickname"
              />
            )}
          </FormField>
        ) : (
          <Text variant="small" tone="secondary" className="break-words">
            {`Posting as ${name}`}
          </Text>
        )}
      </div>
      <div>
        <Button type="submit" loading={pending} className="w-full xs:w-auto">
          {pending ? "Submitting…" : "Submit review"}
        </Button>
      </div>
    </form>
  );
}
