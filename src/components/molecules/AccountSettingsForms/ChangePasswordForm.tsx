"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/atoms/Button";
import { PasswordField, PASSWORD_RULES_TEXT } from "@/components/molecules/PasswordField";
import { ACCOUNT_FIELD, type AccountActionFn, type AccountFieldName } from "../_contracts/account-actions";
import {
  ACCOUNT_FIELD_IDS,
  ACCOUNT_FIELD_LABELS,
  AccountErrorSummary,
  AccountSuccessRegion,
  fieldErrorOf,
  useAccountForm,
} from "./shared";

export const CHANGE_PASSWORD_FORM_ID = "account-password-form";
export const PASSWORD_CHANGED_MESSAGE = "Password changed. Other devices were signed out.";
/** Non-blocking client hint; the server's `confirmPassword` error stays authoritative. */
export const CONFIRM_MISMATCH_HINT = "The new passwords do not match yet.";
export const NEW_PASSWORD_RULES = PASSWORD_RULES_TEXT;

const PASSWORD_FIELDS: readonly AccountFieldName[] = ["currentPassword", "newPassword", "confirmPassword"];

export interface ChangePasswordFormProps {
  /** `changePassword` server action (or any function matching the contract). */
  action: AccountActionFn;
  /** Id of a visible heading naming the form; otherwise labelled "Change password". */
  headingId?: string;
  className?: string;
}

function inputValue(form: HTMLFormElement, name: string): string {
  const element = form.elements.namedItem(name);
  return element instanceof HTMLInputElement ? element.value : "";
}

/**
 * Current / new / confirm password form (T125). Plain `<form action>`; all
 * three fields remount empty after every settled submit (React 19 also resets
 * uncontrolled fields), and no password is ever held in state or echoed.
 * The mismatch hint keeps only a boolean.
 */
export function ChangePasswordForm({ action, headingId, className }: ChangePasswordFormProps) {
  const { state, failure, success, formAction, pending, attempt, summaryRef, guardSubmit } = useAccountForm(action);

  const [mismatch, setMismatch] = useState(false);
  const [seenState, setSeenState] = useState(state);
  if (seenState !== state) {
    setSeenState(state);
    setMismatch(false);
  }

  // Bubbled input events: compare without copying either value into state.
  const onChange = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const confirm = inputValue(form, ACCOUNT_FIELD.confirmPassword);
    const next = confirm !== "" && confirm !== inputValue(form, ACCOUNT_FIELD.newPassword);
    setMismatch((prev) => (prev === next ? prev : next));
  };

  return (
    <form
      id={CHANGE_PASSWORD_FORM_ID}
      action={formAction}
      onSubmit={guardSubmit}
      onChange={onChange}
      noValidate
      aria-busy={pending || undefined}
      {...(headingId ? { "aria-labelledby": headingId } : { "aria-label": "Change password" })}
      className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      {failure !== null ? (
        <AccountErrorSummary
          failure={failure}
          fields={PASSWORD_FIELDS}
          summaryRef={summaryRef}
          fallbackTitle="Password not changed"
          testId="password-error-summary"
        />
      ) : null}
      <AccountSuccessRegion message={success !== null ? PASSWORD_CHANGED_MESSAGE : null} testId="password-status" />
      <div key={`fields-${attempt}`} className="flex min-w-0 flex-col gap-4">
        <PasswordField
          id={ACCOUNT_FIELD_IDS.currentPassword}
          name={ACCOUNT_FIELD.currentPassword}
          label={ACCOUNT_FIELD_LABELS.currentPassword}
          autoComplete="current-password"
          required
          helperText={null}
          error={fieldErrorOf(failure, "currentPassword")}
        />
        <PasswordField
          id={ACCOUNT_FIELD_IDS.newPassword}
          name={ACCOUNT_FIELD.newPassword}
          label={ACCOUNT_FIELD_LABELS.newPassword}
          autoComplete="new-password"
          required
          showLengthHint
          helperText={NEW_PASSWORD_RULES}
          error={fieldErrorOf(failure, "newPassword")}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <PasswordField
            id={ACCOUNT_FIELD_IDS.confirmPassword}
            name={ACCOUNT_FIELD.confirmPassword}
            label={ACCOUNT_FIELD_LABELS.confirmPassword}
            autoComplete="new-password"
            required
            helperText={null}
            error={fieldErrorOf(failure, "confirmPassword")}
          />
          <p aria-live="polite" data-testid="confirm-mismatch-hint" className="text-small text-text-secondary">
            {mismatch ? CONFIRM_MISMATCH_HINT : ""}
          </p>
        </div>
      </div>
      <div>
        <Button type="submit" loading={pending} className="w-full xs:w-auto">
          {pending ? "Changing password…" : "Change password"}
        </Button>
      </div>
    </form>
  );
}
