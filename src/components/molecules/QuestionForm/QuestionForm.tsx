"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/atoms/Button";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Notice } from "@/components/atoms/Notice";
import { Text } from "@/components/atoms/Typography";
import { Textarea } from "@/components/atoms/Textarea";
import { QA_FIELD, initialQaActionState, type QaActionFn } from "../_contracts/qa-actions";
import {
  DISPLAY_NAME_MAX,
  QUESTION_MAX_LENGTH,
  QUESTION_MIN_LENGTH,
  QaFailureNotice,
  failureOf,
  useAttempt,
} from "./qa-shared";

export interface QuestionFormProps {
  /** `askQuestion` server action (pass the server reference directly so the form posts without JS). */
  action: QaActionFn;
  productId: string;
  /** Posted so the action can revalidate `/products/<slug>`. */
  productSlug: string;
  /** Signed-in shopper's display name: hides the name field ("Posting as <name>"). */
  signedInName?: string | null;
  className?: string;
}

export const QUESTION_SUCCESS_TEXT = "Your question was posted.";

/** "Ask a question" form for the PDP Q&A section. Works without JavaScript. */
export function QuestionForm({ action, productId, productSlug, signedInName, className }: QuestionFormProps) {
  const uid = useId();
  const [state, formAction, isPending] = useActionState(action, initialQaActionState);
  const attempt = useAttempt(state);
  const failure = failureOf(state);
  const postingAs = typeof signedInName === "string" ? signedInName.trim() : "";
  const bodyId = `question-body-${uid}`;
  const nameId = `question-name-${uid}`;

  return (
    <form
      action={formAction}
      aria-label="Ask a question"
      className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      <input type="hidden" name={QA_FIELD.productId} value={productId} />
      <input type="hidden" name={QA_FIELD.productSlug} value={productSlug} />
      {failure ? <QaFailureNotice failure={failure} /> : null}
      <div key={attempt} className="flex flex-col gap-4">
        <FormField
          id={bodyId}
          label="Your question"
          required
          hint={`${QUESTION_MIN_LENGTH} to ${QUESTION_MAX_LENGTH} characters.`}
          error={failure?.fieldErrors.body}
        >
          {(p) => (
            <Textarea
              {...p}
              name={QA_FIELD.body}
              rows={3}
              minLength={QUESTION_MIN_LENGTH}
              maxLength={QUESTION_MAX_LENGTH}
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
        <Button type="submit" loading={isPending}>
          Ask
        </Button>
      </div>
      <div aria-live="polite" aria-atomic="true">
        {state?.ok === true ? <Notice tone="success">{QUESTION_SUCCESS_TEXT}</Notice> : null}
      </div>
    </form>
  );
}
