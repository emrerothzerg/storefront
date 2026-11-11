"use client";

import { Button } from "@/components/atoms/Button";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Text } from "@/components/atoms/Typography";
import { PasswordField } from "../PasswordField";
import { AUTH_EMAIL_MAX_LENGTH, AUTH_FIELD, type AuthActionFn } from "../_contracts/auth-actions";
import { authPageHref, fieldErrorOf, safeInternalHref, toSafeNext, type FieldSpec } from "./auth-form-helpers";
import { AuthErrorSummary, useAuthFormAction } from "./auth-form-ui";

/** Stable ids (one sign-in form per page); the error summary links to them. */
export const SIGN_IN_FIELD_IDS = {
  email: "signin-email",
  password: "signin-password",
} as const;

export const SIGN_IN_FORM_ID = "signin-form";
export const SIGN_IN_SUBMIT_LABEL = "Sign in";
export const SIGN_IN_PENDING_LABEL = "Signing in…";
export const DEFAULT_CONTACT_HREF = "/contact";
/** T126 wording: password reset is not available; locked-out shoppers contact customer service. */
export const PASSWORD_RESET_NOTICE = "Password reset is not available.";
export const PASSWORD_RESET_HELP_PREFIX = "If you are locked out or have forgotten your password,";
export const PASSWORD_RESET_CONTACT_LABEL = "contact customer service";

const FIELDS: readonly FieldSpec[] = [
  { field: "email", id: SIGN_IN_FIELD_IDS.email, label: "Email" },
  { field: "password", id: SIGN_IN_FIELD_IDS.password, label: "Password" },
];

export interface SignInFormProps {
  /** The `signIn` server action (T120). Pass it unwrapped so the no-JS post works. */
  action: AuthActionFn;
  /** Raw `next` from the URL; used only when it passes the safe-next rule. */
  next?: string | null;
  /** Contact page for the password-reset notice; must be an allow-listed route. */
  contactHref?: string;
  className?: string;
}

/**
 * Sign-in form (T124): email, password, hidden safe `next`, "Sign in",
 * "Create account" link and the "password reset is not available" notice.
 * Client component; posts as a plain form without JavaScript.
 */
export function SignInForm({ action, next, contactHref = DEFAULT_CONTACT_HREF, className }: SignInFormProps) {
  const { failure, formAction, pending, attempt, onSubmit, summaryRef } = useAuthFormAction(action);
  const safeNext = toSafeNext(next);
  const signUpHref = authPageHref("/signup", safeNext);
  const contact = safeInternalHref(contactHref, DEFAULT_CONTACT_HREF);
  const echoedEmail = failure?.values.email ?? "";

  return (
    <div className={["flex min-w-0 flex-col gap-6", className].filter(Boolean).join(" ")}>
      <form
        id={SIGN_IN_FORM_ID}
        action={formAction}
        onSubmit={onSubmit}
        noValidate
        aria-label="Sign in"
        className="flex min-w-0 flex-col gap-4"
      >
        <AuthErrorSummary
          failure={failure}
          fields={FIELDS}
          failedTitle="Sign-in failed"
          summaryRef={summaryRef}
          testId="signin-error-summary"
        />
        {safeNext !== null ? <input type="hidden" name={AUTH_FIELD.next} value={safeNext} /> : null}
        <div key={`fields-${attempt}`} className="flex min-w-0 flex-col gap-4">
          <FormField id={SIGN_IN_FIELD_IDS.email} label="Email" required error={fieldErrorOf(failure, "email")}>
            {(p) => (
              <Input
                {...p}
                type="email"
                name={AUTH_FIELD.email}
                // Sign-in identifier: `username` so password managers pair it with
                // `current-password` (D-T124-1). Sign-up keeps `email`.
                autoComplete="username"
                maxLength={AUTH_EMAIL_MAX_LENGTH}
                autoCapitalize="off"
                spellCheck={false}
                defaultValue={echoedEmail}
              />
            )}
          </FormField>
          <PasswordField
            id={SIGN_IN_FIELD_IDS.password}
            name={AUTH_FIELD.password}
            label="Password"
            autoComplete="current-password"
            required
            helperText={null}
            error={fieldErrorOf(failure, "password")}
          />
        </div>
        <div>
          <Button type="submit" loading={pending} fullWidth>
            {pending ? SIGN_IN_PENDING_LABEL : SIGN_IN_SUBMIT_LABEL}
          </Button>
        </div>
      </form>
      <Text variant="small" className="break-words">
        {"New here? "}
        <Link href={signUpHref}>Create account</Link>
      </Text>
      <Notice tone="info" data-testid="password-reset-notice">
        <p className="break-words">
          {`${PASSWORD_RESET_NOTICE} ${PASSWORD_RESET_HELP_PREFIX} `}
          <Link href={contact}>{PASSWORD_RESET_CONTACT_LABEL}</Link>
          {"."}
        </p>
      </Notice>
    </div>
  );
}
