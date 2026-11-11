"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import {
  initialAccountActionState,
  type AccountActionFn,
  type AccountActionState,
  type AccountFieldName,
} from "../_contracts/account-actions";

/**
 * Shared plumbing for the three account settings forms (T125): the guarded
 * `useActionState` hook, the error summary, and user-facing copy.
 */

export type AccountFailure = Extract<NonNullable<AccountActionState>, { ok: false }>;
export type AccountSuccess = Extract<NonNullable<AccountActionState>, { ok: true }>;

/** Stable element ids (one settings page per document); error summary links target them. */
export const ACCOUNT_FIELD_IDS = {
  displayName: "account-display-name",
  currentPassword: "account-current-password",
  newPassword: "account-new-password",
  confirmPassword: "account-confirm-password",
  password: "account-delete-password",
  confirm: "account-delete-confirm",
} as const satisfies Record<AccountFieldName, string>;

export const ACCOUNT_FIELD_LABELS = {
  displayName: "Display name",
  currentPassword: "Current password",
  newPassword: "New password",
  confirmPassword: "Confirm new password",
  password: "Password",
  confirm: "Type DELETE to confirm",
} as const satisfies Record<AccountFieldName, string>;

export const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
export const FIX_FIELDS_TITLE = "Please fix the following";
/** Where an expired session sends the user back to. */
export const SETTINGS_SIGN_IN_HREF = "/signin?next=%2Faccount%2Fsettings";

/** Codes that all mean "too many attempts" (R-10 maps a lock onto RATE_LIMITED; the others are defensive). */
const TOO_MANY_CODES: ReadonlySet<string> = new Set(["RATE_LIMITED", "ACCOUNT_LOCKED", "TOO_MANY_ATTEMPTS"]);

/** "Too many attempts. Try again in N minutes." (N rounded up, at least 1) or "... later." when unknown. */
export function tooManyAttemptsText(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) {
    return "Too many attempts. Try again later.";
  }
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** A non-blank field error for `field`, or undefined. */
export function fieldErrorOf(failure: AccountFailure | null, field: AccountFieldName): string | undefined {
  const message = failure?.fieldErrors?.[field];
  return typeof message === "string" && message.trim() !== "" ? message : undefined;
}

export interface SummaryItem {
  readonly field: AccountFieldName;
  readonly id: string;
  readonly label: string;
  readonly message: string;
}

/** Field errors for the fields this form renders, in form order (blank messages skipped). */
export function summaryItems(failure: AccountFailure, fields: readonly AccountFieldName[]): SummaryItem[] {
  return fields.flatMap((field) => {
    const message = fieldErrorOf(failure, field);
    return message === undefined
      ? []
      : [{ field, id: ACCOUNT_FIELD_IDS[field], label: ACCOUNT_FIELD_LABELS[field], message }];
  });
}

/** False during SSR and hydration, true afterwards (no hydration mismatch). */
const noopSubscribe = () => () => {};
export function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

export interface AccountFormController {
  readonly state: AccountActionState;
  readonly failure: AccountFailure | null;
  readonly success: AccountSuccess | null;
  readonly formAction: (formData: FormData) => void;
  readonly pending: boolean;
  /** Increments once per settled submit; key the fields with it so they remount empty / with echoes. */
  readonly attempt: number;
  readonly summaryRef: RefObject<HTMLDivElement | null>;
  /**
   * Double-submit guard for `onSubmit`. Returns false (and prevents the
   * submit) while a submit is in flight; otherwise arms the guard.
   */
  readonly guardSubmit: (event: FormEvent<HTMLFormElement>) => boolean;
}

/**
 * `useActionState` + double-submit guard (released in `finally`, so it opens
 * the moment the action settles, resolve or throw) + an attempt counter
 * derived from state identity + focus on the error summary after a failure.
 */
export function useAccountForm(action: AccountActionFn): AccountFormController {
  // Until mounted, hand React the RAW server action: the server renderer only
  // emits a real POST form (method, enctype, action ref) for a server reference,
  // and a wrapper would hide it (no-JS submit broken, D-T128-1).
  const mounted = useHydrated();
  const inFlight = useRef(false);
  const guardedAction: AccountActionFn = async (prev, formData) => {
    try {
      return await action(prev, formData);
    } finally {
      inFlight.current = false;
    }
  };
  const [state, formAction, pending] = useActionState(mounted ? guardedAction : action, initialAccountActionState);

  const [seenState, setSeenState] = useState<AccountActionState>(state);
  const [attempt, setAttempt] = useState(0);
  if (seenState !== state) {
    setSeenState(state);
    setAttempt((n) => n + 1);
  }

  const summaryRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (state !== null && !state.ok) summaryRef.current?.focus();
  }, [state]);

  const guardSubmit = (event: FormEvent<HTMLFormElement>): boolean => {
    if (pending || inFlight.current) {
      event.preventDefault();
      return false;
    }
    // Only the wrapped action releases the guard, so arm it only once it is in use.
    if (mounted) inFlight.current = true;
    return true;
  };

  const failure = state !== null && !state.ok ? state : null;
  const success = state !== null && state.ok ? state : null;
  return { state, failure, success, formAction, pending, attempt, summaryRef, guardSubmit };
}

function focusField(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return; // native fragment navigation
  event.preventDefault();
  target.focus();
  target.scrollIntoView?.({ block: "center" });
}

export interface AccountErrorSummaryProps {
  failure: AccountFailure;
  /** Fields rendered by this form, in order. */
  fields: readonly AccountFieldName[];
  summaryRef: RefObject<HTMLDivElement | null>;
  /** Title for a failure that has no field errors and no special code. */
  fallbackTitle: string;
  testId: string;
}

/** Focusable `role="alert"` summary (Notice tone danger). All text renders as React text. */
export function AccountErrorSummary({ failure, fields, summaryRef, fallbackTitle, testId }: AccountErrorSummaryProps) {
  const code = failure.error?.code;
  const items = summaryItems(failure, fields);
  const message = typeof failure.message === "string" && failure.message.trim() !== "" ? failure.message : GENERIC_ERROR_MESSAGE;

  let title: string;
  let body;
  if (TOO_MANY_CODES.has(code)) {
    title = tooManyAttemptsText(failure.retryAfterSeconds);
    body = null;
  } else if (code === "UNAUTHENTICATED") {
    title = message;
    body = (
      <p>
        <Link href={SETTINGS_SIGN_IN_HREF} className="inline-flex min-h-touch items-center">
          Sign in again
        </Link>
      </p>
    );
  } else if (items.length > 0) {
    title = FIX_FIELDS_TITLE;
    body = (
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={`#${item.id}`}
              className="inline-flex min-h-touch items-center break-words"
              onClick={(e) => focusField(e, item.id)}
            >
              {`${item.label}: ${item.message}`}
            </Link>
          </li>
        ))}
      </ul>
    );
  } else {
    title = fallbackTitle;
    body = <p className="break-words">{message}</p>;
  }

  return (
    <Notice ref={summaryRef} tone="danger" tabIndex={-1} title={title} data-testid={testId}>
      {body}
    </Notice>
  );
}

/** Polite live region that always exists, so a success message is announced when it appears. */
export function AccountSuccessRegion({ message, testId }: { message: string | null; testId: string }) {
  return (
    <div aria-live="polite" aria-atomic="true" data-testid={testId}>
      {message !== null ? <Notice tone="success">{message}</Notice> : null}
    </div>
  );
}
