"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/atoms/Button";
import { Dialog, DialogFooter } from "@/components/atoms/Dialog";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Text } from "@/components/atoms/Typography";
import { PasswordField } from "@/components/molecules/PasswordField";
import {
  ACCOUNT_FIELD,
  DELETE_CONFIRM_VALUE,
  type AccountActionFn,
  type AccountFieldName,
} from "../_contracts/account-actions";
import {
  ACCOUNT_FIELD_IDS,
  ACCOUNT_FIELD_LABELS,
  AccountErrorSummary,
  fieldErrorOf,
  useAccountForm,
  useHydrated,
} from "./shared";

export const DELETE_ACCOUNT_FORM_ID = "account-delete-form";
export const DELETE_SUBMIT_LABEL = "Delete my account";
export const DELETE_DIALOG_TITLE = "Delete your account?";
export const DELETE_DIALOG_DESCRIPTION = "This cannot be undone. You will be signed out on every device.";
/** Explanatory copy (ruling R-7 / T118): what is deleted and what is kept. */
export const DELETE_EXPLANATION: readonly string[] = [
  "Deleting your account is permanent and cannot be undone.",
  "Your lists, saved addresses, reviews, cart, browsing history, stock alerts and contact messages are deleted, and you are signed out on every device.",
  "Your past orders are kept anonymously: your name, email address and shipping address are removed, while the items, amounts and dates stay.",
  "Questions and answers you posted stay visible, shown as [deleted], so other shoppers' answers are not lost.",
];
/** `maxLength` of the confirm input (the length of `DELETE`). */
export const DELETE_CONFIRM_MAX_LENGTH = DELETE_CONFIRM_VALUE.length;

const DELETE_FIELDS: readonly AccountFieldName[] = ["password", "confirm"];

export interface DeleteAccountFormProps {
  /** `deleteAccount` server action (or any function matching the contract). Success redirects to `/`. */
  action: AccountActionFn;
  /** Id of a visible heading naming the form; otherwise labelled "Delete account". */
  headingId?: string;
  className?: string;
}

/**
 * Account deletion form (T125). Without JavaScript it is a plain POST form
 * (the server validates the password and the literal `DELETE`). After
 * hydration the submit stays disabled until the confirm text is exactly
 * `DELETE`, and submitting first opens a confirm alert Dialog; "Delete" in
 * the dialog submits the form via `requestSubmit`.
 */
export function DeleteAccountForm({ action, headingId, className }: DeleteAccountFormProps) {
  const { state, failure, formAction, pending, attempt, summaryRef, guardSubmit } = useAccountForm(action);
  const hydrated = useHydrated();

  const [confirmText, setConfirmText] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [seenState, setSeenState] = useState(state);
  if (seenState !== state) {
    // Fields remount empty after every settled submit; keep the gate in sync.
    setSeenState(state);
    setConfirmText("");
  }

  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  /** Set by the dialog's Delete button so the next submit event goes through. */
  const confirmedRef = useRef(false);

  // Dialog's own effect (child) has already called showModal(); start on Cancel.
  useEffect(() => {
    if (dialogOpen) cancelRef.current?.focus();
  }, [dialogOpen]);

  const confirmMatches = confirmText === DELETE_CONFIRM_VALUE;

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (hydrated && !confirmedRef.current) {
      event.preventDefault();
      if (pending || !confirmMatches) return;
      // Focus returns here when the dialog closes, whatever opened it (click or Enter).
      submitRef.current?.focus();
      setDialogOpen(true);
      return;
    }
    confirmedRef.current = false;
    guardSubmit(event);
  };

  const onConfirm = () => {
    setDialogOpen(false);
    const form = formRef.current;
    if (!form) return;
    confirmedRef.current = true;
    form.requestSubmit(submitRef.current ?? undefined);
  };

  return (
    <>
      <form
        ref={formRef}
        id={DELETE_ACCOUNT_FORM_ID}
        action={formAction}
        onSubmit={onSubmit}
        noValidate
        aria-busy={pending || undefined}
        {...(headingId ? { "aria-labelledby": headingId } : { "aria-label": "Delete account" })}
        className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
      >
        {failure !== null ? (
          <AccountErrorSummary
            failure={failure}
            fields={DELETE_FIELDS}
            summaryRef={summaryRef}
            fallbackTitle="Account not deleted"
            testId="delete-error-summary"
          />
        ) : null}
        <div className="flex min-w-0 flex-col gap-2" data-testid="delete-explanation">
          {DELETE_EXPLANATION.map((line) => (
            <Text key={line} as="p" className="break-words">
              {line}
            </Text>
          ))}
        </div>
        <div key={`fields-${attempt}`} className="flex min-w-0 flex-col gap-4">
          <PasswordField
            id={ACCOUNT_FIELD_IDS.password}
            name={ACCOUNT_FIELD.password}
            label={ACCOUNT_FIELD_LABELS.password}
            autoComplete="current-password"
            required
            helperText={null}
            error={fieldErrorOf(failure, "password")}
          />
          <FormField
            id={ACCOUNT_FIELD_IDS.confirm}
            label={ACCOUNT_FIELD_LABELS.confirm}
            required
            error={fieldErrorOf(failure, "confirm")}
          >
            {(p) => (
              <Input
                {...p}
                name={ACCOUNT_FIELD.confirm}
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                maxLength={DELETE_CONFIRM_MAX_LENGTH}
                onChange={(event) => setConfirmText(event.currentTarget.value)}
              />
            )}
          </FormField>
        </div>
        <div>
          <Button
            ref={submitRef}
            type="submit"
            variant="danger"
            loading={pending}
            disabled={hydrated && !pending && !confirmMatches}
            aria-haspopup={hydrated ? "dialog" : undefined}
            className="w-full xs:w-auto"
          >
            {pending ? "Deleting account…" : DELETE_SUBMIT_LABEL}
          </Button>
        </div>
      </form>
      {hydrated ? (
        <Dialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          title={DELETE_DIALOG_TITLE}
          description={DELETE_DIALOG_DESCRIPTION}
          alert
          size="sm"
        >
          <DialogFooter>
            <Button ref={cancelRef} type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" onClick={onConfirm}>
              Delete
            </Button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </>
  );
}
