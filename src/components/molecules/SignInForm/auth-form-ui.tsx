"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { initialAuthActionState, type AuthActionFn, type AuthActionState } from "../_contracts/auth-actions";
import {
  failureKind,
  fieldSummaryItems,
  formLevelText,
  type AuthFailure,
  type FieldSpec,
} from "./auth-form-helpers";

const noopSubscribe = () => () => {};

export interface AuthFormController {
  readonly state: AuthActionState;
  readonly failure: AuthFailure | null;
  readonly formAction: (payload: FormData) => void;
  readonly pending: boolean;
  /** Bumped on every settled attempt; key the fields with it so they remount. */
  readonly attempt: number;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly summaryRef: Ref<HTMLDivElement>;
}

/**
 * `useActionState` wiring shared by the auth forms.
 *
 * No-JS / hydration: until the client has mounted, the RAW `action` is handed
 * to `useActionState`, so React's server renderer sees the server reference
 * (`$$FORM_ACTION`: real POST/multipart form + `$ACTION_*` fields, and the
 * post-back state of a no-JS submit). A wrapper would hide it and turn the
 * form into `action="javascript:..."`.
 *
 * With JS: after mount the action is wrapped so the double-submit guard is
 * released in `finally` the moment the action settles (resolve or throw),
 * never in a passive effect.
 */
export function useAuthFormAction(action: AuthActionFn): AuthFormController {
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const inFlight = useRef(false);
  const guarded: AuthActionFn = async (prev, formData) => {
    try {
      return await action(prev, formData);
    } finally {
      inFlight.current = false;
    }
  };
  const [state, formAction, pending] = useActionState(mounted ? guarded : action, initialAuthActionState);

  // Every settled attempt remounts the fields (derived during render): the
  // password comes back empty and the echoed email/name come back as defaults.
  const [seenState, setSeenState] = useState<AuthActionState>(state);
  const [attempt, setAttempt] = useState(0);
  if (seenState !== state) {
    setSeenState(state);
    setAttempt((n) => n + 1);
  }

  const summaryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state !== null && !state.ok) summaryRef.current?.focus();
  }, [state]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    if (pending || inFlight.current) {
      event.preventDefault();
      return;
    }
    // Only the wrapped action releases the guard, so arm it only once it is in use.
    if (mounted) inFlight.current = true;
  };

  const failure = state !== null && !state.ok ? state : null;
  return { state, failure, formAction, pending, attempt, onSubmit, summaryRef };
}

function focusField(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return; // native fragment navigation
  event.preventDefault();
  target.focus();
  target.scrollIntoView?.({ block: "center" });
}

export interface AuthErrorSummaryProps {
  failure: AuthFailure | null;
  fields: readonly FieldSpec[];
  /** Title for the non-field failure, e.g. "Sign-in failed". */
  failedTitle: string;
  /** Extra content for EMAIL_TAKEN (the sign-in link). */
  emailTakenExtra?: ReactNode;
  summaryRef: Ref<HTMLDivElement>;
  testId: string;
}

const summaryLink = "inline-flex min-h-touch items-center break-words";

/**
 * Error summary: `role="alert"` (danger Notice), focusable (`tabIndex=-1`),
 * focused by the form after each failure. Field errors become links that
 * focus the field; other failures show text from local constants.
 */
export function AuthErrorSummary({
  failure,
  fields,
  failedTitle,
  emailTakenExtra,
  summaryRef,
  testId,
}: AuthErrorSummaryProps) {
  if (failure === null) return null;
  const items = failureKind(failure) === "fields" ? fieldSummaryItems(failure, fields) : [];
  let title: string;
  let body: ReactNode;
  if (items.length > 0) {
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
    title = failedTitle;
    body = (
      <>
        <p>{formLevelText(failure)}</p>
        {failureKind(failure) === "email_taken" ? emailTakenExtra : null}
      </>
    );
  }
  return (
    <Notice ref={summaryRef} tone="danger" tabIndex={-1} title={title} data-testid={testId}>
      {body}
    </Notice>
  );
}
