"use client";

import { Button } from "@/components/atoms/Button";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Link } from "@/components/atoms/Link";
import { Text } from "@/components/atoms/Typography";
import { PasswordField } from "../PasswordField";
import {
  AUTH_DISPLAY_NAME_MAX_LENGTH,
  AUTH_EMAIL_MAX_LENGTH,
  AUTH_FIELD,
  type AuthActionFn,
} from "../_contracts/auth-actions";
import {
  authPageHref,
  fieldErrorOf,
  safeInternalHref,
  toSafeNext,
  type FieldSpec,
} from "../SignInForm/auth-form-helpers";
import { AuthErrorSummary, useAuthFormAction } from "../SignInForm/auth-form-ui";

/** Stable ids (one sign-up form per page); the error summary links to them. */
export const SIGN_UP_FIELD_IDS = {
  displayName: "signup-display-name",
  email: "signup-email",
  password: "signup-password",
} as const;

export const SIGN_UP_FORM_ID = "signup-form";
export const SIGN_UP_SUBMIT_LABEL = "Create account";
export const SIGN_UP_PENDING_LABEL = "Creating account…";
export const DISPLAY_NAME_HINT = "Shown with your reviews, questions and answers.";
export const GUEST_MERGE_NOTE = "Your guest cart and orders from this browser will be added to your new account.";
export const PRIVACY_HREF = "/privacy";
export const TERMS_HREF = "/terms";

const FIELDS: readonly FieldSpec[] = [
  { field: "displayName", id: SIGN_UP_FIELD_IDS.displayName, label: "Display name" },
  { field: "email", id: SIGN_UP_FIELD_IDS.email, label: "Email" },
  { field: "password", id: SIGN_UP_FIELD_IDS.password, label: "Password" },
];

export interface SignUpFormProps {
  /** The `signUp` server action (T120). Pass it unwrapped so the no-JS post works. */
  action: AuthActionFn;
  /** Raw `next` from the URL; used only when it passes the safe-next rule. */
  next?: string | null;
  className?: string;
}

/**
 * Sign-up form (T124): display name, email, password with the rules and a
 * live length hint, hidden safe `next`, "Create account", "Sign in" link,
 * privacy/terms links and the guest-data merge note. Client component; posts
 * as a plain form without JavaScript.
 */
export function SignUpForm({ action, next, className }: SignUpFormProps) {
  const { failure, formAction, pending, attempt, onSubmit, summaryRef } = useAuthFormAction(action);
  const safeNext = toSafeNext(next);
  const signInHref = authPageHref("/signin", safeNext);
  const privacy = safeInternalHref(PRIVACY_HREF, "/");
  const terms = safeInternalHref(TERMS_HREF, "/");
  const values = failure?.values ?? {};

  return (
    <div className={["flex min-w-0 flex-col gap-6", className].filter(Boolean).join(" ")}>
      <form
        id={SIGN_UP_FORM_ID}
        action={formAction}
        onSubmit={onSubmit}
        noValidate
        aria-label="Create account"
        className="flex min-w-0 flex-col gap-4"
      >
        <AuthErrorSummary
          failure={failure}
          fields={FIELDS}
          failedTitle="Account not created"
          emailTakenExtra={
            <p>
              <Link href={signInHref}>Sign in</Link>
            </p>
          }
          summaryRef={summaryRef}
          testId="signup-error-summary"
        />
        {safeNext !== null ? <input type="hidden" name={AUTH_FIELD.next} value={safeNext} /> : null}
        <div key={`fields-${attempt}`} className="flex min-w-0 flex-col gap-4">
          <FormField
            id={SIGN_UP_FIELD_IDS.displayName}
            label="Display name"
            hint={DISPLAY_NAME_HINT}
            required
            error={fieldErrorOf(failure, "displayName")}
          >
            {(p) => (
              <Input
                {...p}
                name={AUTH_FIELD.displayName}
                autoComplete="name"
                maxLength={AUTH_DISPLAY_NAME_MAX_LENGTH}
                defaultValue={values.displayName ?? ""}
              />
            )}
          </FormField>
          <FormField id={SIGN_UP_FIELD_IDS.email} label="Email" required error={fieldErrorOf(failure, "email")}>
            {(p) => (
              <Input
                {...p}
                type="email"
                name={AUTH_FIELD.email}
                autoComplete="email"
                maxLength={AUTH_EMAIL_MAX_LENGTH}
                autoCapitalize="off"
                spellCheck={false}
                defaultValue={values.email ?? ""}
              />
            )}
          </FormField>
          <PasswordField
            id={SIGN_UP_FIELD_IDS.password}
            name={AUTH_FIELD.password}
            label="Password"
            autoComplete="new-password"
            required
            showLengthHint
            error={fieldErrorOf(failure, "password")}
          />
        </div>
        <Text variant="small" tone="secondary" className="break-words">
          {GUEST_MERGE_NOTE}
        </Text>
        <Text variant="small" tone="secondary" className="break-words">
          {"By creating an account you agree to our "}
          <Link href={terms}>Terms of use</Link>
          {" and acknowledge our "}
          <Link href={privacy}>Privacy notice</Link>
          {"."}
        </Text>
        <div>
          <Button type="submit" loading={pending} fullWidth>
            {pending ? SIGN_UP_PENDING_LABEL : SIGN_UP_SUBMIT_LABEL}
          </Button>
        </div>
      </form>
      <Text variant="small" className="break-words">
        {"Already have an account? "}
        <Link href={signInHref}>Sign in</Link>
      </Text>
    </div>
  );
}
