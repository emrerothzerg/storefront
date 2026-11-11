"use client";

import { Button } from "@/components/atoms/Button";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Text } from "@/components/atoms/Typography";
import {
  ACCOUNT_FIELD,
  DISPLAY_NAME_MAX_LENGTH,
  type AccountActionFn,
  type AccountFieldName,
} from "../_contracts/account-actions";
import {
  ACCOUNT_FIELD_IDS,
  ACCOUNT_FIELD_LABELS,
  AccountErrorSummary,
  AccountSuccessRegion,
  fieldErrorOf,
  useAccountForm,
} from "./shared";

export const PROFILE_FORM_ID = "account-profile-form";
export const PROFILE_UPDATED_MESSAGE = "Profile updated.";
export const DISPLAY_NAME_HINT = "Shown on new reviews, questions and answers you post.";
export const EMAIL_READ_ONLY_NOTE = "Your email address cannot be changed.";

const PROFILE_FIELDS: readonly AccountFieldName[] = ["displayName"];

export interface ProfileFormProps {
  /** `updateProfile` server action (or any function matching the contract). */
  action: AccountActionFn;
  /** Current stored display name (from `readCurrentUser()`). */
  displayName: string;
  /** Account email, shown read-only as text (never an input). */
  email: string;
  /** Id of a visible heading naming the form; otherwise labelled "Profile". */
  headingId?: string;
  className?: string;
}

/**
 * Display name form (T125). A plain `<form action>` via `useActionState`, so
 * it posts without JavaScript; with JS it adds pending state, a focused error
 * summary and a double-submit guard. The email is plain text, not a field.
 */
export function ProfileForm({ action, displayName, email, headingId, className }: ProfileFormProps) {
  const { failure, success, formAction, pending, attempt, summaryRef, guardSubmit } = useAccountForm(action);

  const nameDefault =
    failure !== null
      ? (failure.values?.displayName ?? displayName)
      : success !== null
        ? (success.displayName ?? displayName)
        : displayName;

  return (
    <form
      id={PROFILE_FORM_ID}
      action={formAction}
      onSubmit={guardSubmit}
      noValidate
      aria-busy={pending || undefined}
      {...(headingId ? { "aria-labelledby": headingId } : { "aria-label": "Profile" })}
      className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      {failure !== null ? (
        <AccountErrorSummary
          failure={failure}
          fields={PROFILE_FIELDS}
          summaryRef={summaryRef}
          fallbackTitle="Profile not saved"
          testId="profile-error-summary"
        />
      ) : null}
      <AccountSuccessRegion message={success !== null ? PROFILE_UPDATED_MESSAGE : null} testId="profile-status" />
      <div className="flex min-w-0 flex-col gap-1">
        <Text as="p" variant="small" tone="secondary">
          Email
        </Text>
        <Text as="p" className="break-words" data-testid="profile-email">
          {email}
        </Text>
        <Text as="p" variant="small" tone="secondary">
          {EMAIL_READ_ONLY_NOTE}
        </Text>
      </div>
      <FormField
        key={`name-${attempt}`}
        id={ACCOUNT_FIELD_IDS.displayName}
        label={ACCOUNT_FIELD_LABELS.displayName}
        hint={DISPLAY_NAME_HINT}
        required
        error={fieldErrorOf(failure, "displayName")}
      >
        {(p) => (
          <Input
            {...p}
            name={ACCOUNT_FIELD.displayName}
            autoComplete="name"
            maxLength={DISPLAY_NAME_MAX_LENGTH}
            defaultValue={nameDefault}
          />
        )}
      </FormField>
      <div>
        <Button type="submit" loading={pending} className="w-full xs:w-auto">
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
