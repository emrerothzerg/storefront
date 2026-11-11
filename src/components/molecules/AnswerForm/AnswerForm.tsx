"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/atoms/Button";
import { Disclosure } from "@/components/atoms/Disclosure";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Notice } from "@/components/atoms/Notice";
import { Text } from "@/components/atoms/Typography";
import { Textarea } from "@/components/atoms/Textarea";
import { QA_FIELD, initialQaActionState, type QaActionFn } from "../_contracts/qa-actions";
import {
  ANSWER_MAX_LENGTH,
  DISPLAY_NAME_MAX,
  QaFailureNotice,
  failureOf,
  useAttempt,
} from "../QuestionForm/qa-shared";

export interface AnswerFormProps {
  /** `answerQuestion` server action (pass the server reference directly so the form posts without JS). */
  action: QaActionFn;
  questionId: string;
  /** Posted so the action can revalidate `/products/<slug>`. */
  productSlug: string;
  /** Signed-in shopper's display name: hides the name field ("Posting as <name>"). */
  signedInName?: string | null;
  /**
   * Id of the element holding the question text. The form is then named
   * "Answer this question: <question>" via `aria-labelledby`, so several open
   * answer forms on one page stay distinguishable. Without it the form is
   * named "Answer this question".
   */
  questionLabelId?: string;
  /** Start expanded. The form also opens itself after a failed post. */
  defaultOpen?: boolean;
  className?: string;
}

export const ANSWER_FORM_LABEL = "Answer this question";
export const ANSWER_SUCCESS_TEXT = "Your answer was posted.";

/**
 * Inline "Answer this question" form, collapsed in a native `<details>`
 * Disclosure (expands with Enter/Space, works without JavaScript).
 */
export function AnswerForm({
  action,
  questionId,
  productSlug,
  signedInName,
  questionLabelId,
  defaultOpen = false,
  className,
}: AnswerFormProps) {
  const uid = useId();
  const [state, formAction, isPending] = useActionState(action, initialQaActionState);
  const attempt = useAttempt(state);
  const failure = failureOf(state);
  const limitReached = failure?.error.code === "LIMIT_REACHED";
  const postingAs = typeof signedInName === "string" ? signedInName.trim() : "";
  const bodyId = `answer-body-${uid}`;
  const nameId = `answer-name-${uid}`;
  const titleId = `answer-title-${uid}`;
  const labelledBy = questionLabelId ? `${titleId} ${questionLabelId}` : undefined;

  return (
    <div className={["flex min-w-0 flex-col gap-2", className].filter(Boolean).join(" ")}>
      <Disclosure summary="Answer this question" defaultOpen={defaultOpen || failure !== null}>
        <form
          action={formAction}
          aria-label={labelledBy ? undefined : ANSWER_FORM_LABEL}
          aria-labelledby={labelledBy}
          className="flex flex-col gap-4 pt-2"
        >
          {labelledBy ? (
            // Hidden name fragment: aria-labelledby reads hidden elements.
            <span id={titleId} hidden>
              {`${ANSWER_FORM_LABEL}:`}
            </span>
          ) : null}
          <input type="hidden" name={QA_FIELD.questionId} value={questionId} />
          <input type="hidden" name={QA_FIELD.productSlug} value={productSlug} />
          {failure ? <QaFailureNotice failure={failure} /> : null}
          <div key={attempt} className="flex flex-col gap-4">
            <FormField id={bodyId} label="Your answer" required error={failure?.fieldErrors.body}>
              {(p) => (
                <Textarea
                  {...p}
                  name={QA_FIELD.body}
                  rows={3}
                  maxLength={ANSWER_MAX_LENGTH}
                  showCount
                  defaultValue={failure?.values.body ?? ""}
                />
              )}
            </FormField>
            {postingAs !== "" ? (
              <Text variant="small" tone="secondary" className="break-words">
                {`Posting as ${postingAs}`}
              </Text>
            ) : (
              <FormField
                id={nameId}
                label="Display name (optional)"
                hint="Leave blank to post as Anonymous shopper."
                error={failure?.fieldErrors.displayName}
              >
                {(p) => (
                  <Input
                    {...p}
                    name={QA_FIELD.displayName}
                    maxLength={DISPLAY_NAME_MAX}
                    autoComplete="nickname"
                    defaultValue={failure?.values.displayName ?? ""}
                  />
                )}
              </FormField>
            )}
          </div>
          <div>
            <Button type="submit" variant="secondary" loading={isPending} disabled={limitReached}>
              Post answer
            </Button>
          </div>
        </form>
      </Disclosure>
      {/* Outside the Disclosure so the confirmation stays visible if it collapses. */}
      <div aria-live="polite" aria-atomic="true">
        {state?.ok === true ? <Notice tone="success">{ANSWER_SUCCESS_TEXT}</Notice> : null}
      </div>
    </div>
  );
}
