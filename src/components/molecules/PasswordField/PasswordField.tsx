"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { FormField } from "@/components/atoms/FormField";
import { IconButton } from "@/components/atoms/IconButton";
import { Input } from "@/components/atoms/Input";

/**
 * Password bounds in UTF-16 code units (ruling K-10), mirrored from the auth
 * contract / password policy. Molecules never import `src/server/**`; the
 * colocated test pins these to `src/server/auth/password-policy.ts`.
 */
export const PASSWORD_FIELD_MIN_LENGTH = 8;
export const PASSWORD_FIELD_MAX_LENGTH = 128;
/** Above this length the live hint warns that the cap is near. */
export const PASSWORD_NEAR_LIMIT = 120;

/** Default helper text: the policy rules (8..128, weak-list check, no composition rules). */
export const PASSWORD_RULES_TEXT =
  "Use 8 to 128 characters. Avoid common or easy-to-guess passwords. No special characters are required.";

export const SHOW_PASSWORD_LABEL = "Show password";
export const HIDE_PASSWORD_LABEL = "Hide password";

export const LENGTH_HINT_TEXT = {
  short: `Use at least ${PASSWORD_FIELD_MIN_LENGTH} characters.`,
  ok: "Password length is OK.",
  near: `Approaching the ${PASSWORD_FIELD_MAX_LENGTH} character limit.`,
  max: `Maximum length of ${PASSWORD_FIELD_MAX_LENGTH} characters reached.`,
} as const;

export type LengthHintBucket = "empty" | keyof typeof LENGTH_HINT_TEXT;

/**
 * Coarse bucket for a password length. The live hint only changes text when
 * the bucket changes (crossing 8, crossing 120, reaching 128), so typing does
 * not produce an announcement per keystroke.
 */
export function lengthHintBucket(length: number): LengthHintBucket {
  if (!Number.isFinite(length) || length <= 0) return "empty";
  if (length < PASSWORD_FIELD_MIN_LENGTH) return "short";
  if (length >= PASSWORD_FIELD_MAX_LENGTH) return "max";
  if (length > PASSWORD_NEAR_LIMIT) return "near";
  return "ok";
}

export interface PasswordFieldProps {
  name: string;
  label: string;
  autoComplete: "current-password" | "new-password";
  /** Input id (error summaries link to `#id`). Defaults to a `useId` value. */
  id?: string;
  required?: boolean;
  error?: string | null;
  /** Shown under the input and linked via `aria-describedby`. Defaults to the policy rules; `null` hides it. */
  helperText?: ReactNode;
  /** Polite live hint that changes only at thresholds (8, > 120, 128). */
  showLengthHint?: boolean;
  /** `minlength` attribute; defaults to 8 for `new-password`, none for `current-password`. */
  minLength?: 8;
  maxLength?: 128;
  /** Passwords are never pre-filled. */
  defaultValue?: never;
  className?: string;
}

const noopSubscribe = () => () => {};

/**
 * Labelled password input with a show/hide toggle (T123).
 *
 * - Uncontrolled: the value lives only in the input's live `value`; it is never
 *   copied into React state, an attribute, `data-*` or storage. Only its LENGTH
 *   is kept (for the optional hint).
 * - The toggle is server-rendered but `disabled` until hydration (hydration
 *   flag via `useSyncExternalStore`), so without JS the field is a plain
 *   `type="password"` input that still submits.
 * - Toggling keeps the value, moves focus back to the input and restores the
 *   caret/selection.
 * - A `reset` of the owning form (React 19 resets uncontrolled fields after an
 *   action) masks the value again and clears the length hint.
 */
export function PasswordField({
  name,
  label,
  autoComplete,
  id,
  required = false,
  error,
  helperText = PASSWORD_RULES_TEXT,
  showLengthHint = false,
  minLength,
  maxLength = PASSWORD_FIELD_MAX_LENGTH,
  className,
}: PasswordFieldProps) {
  const generatedId = useId();
  const inputId = id ?? `password-${generatedId}`;
  const helperId = `${inputId}-helper`;
  const lengthHintId = `${inputId}-length`;

  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [visible, setVisible] = useState(false);
  const [bucket, setBucket] = useState<LengthHintBucket>("empty");
  const inputRef = useRef<HTMLInputElement>(null);
  // Selection to restore after a toggle re-render (null = nothing pending).
  const pendingSelection = useRef<{ start: number | null; end: number | null } | null>(null);

  useLayoutEffect(() => {
    const selection = pendingSelection.current;
    const input = inputRef.current;
    if (selection === null || input === null) return;
    pendingSelection.current = null;
    input.focus();
    if (selection.start !== null && selection.end !== null) {
      try {
        input.setSelectionRange(selection.start, selection.end);
      } catch {
        // Some engines reject selection APIs on certain types; focus is enough.
      }
    }
  }, [visible]);

  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const onReset = () => {
      setVisible(false);
      setBucket("empty");
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  const toggle = () => {
    const input = inputRef.current;
    pendingSelection.current = {
      start: input?.selectionStart ?? null,
      end: input?.selectionEnd ?? null,
    };
    setVisible((v) => !v);
  };

  const hasHelper = helperText !== null && helperText !== undefined && helperText !== false && helperText !== "";
  const effectiveMinLength = minLength ?? (autoComplete === "new-password" ? PASSWORD_FIELD_MIN_LENGTH : undefined);
  const errorText = typeof error === "string" && error.trim() !== "" ? error : undefined;

  return (
    <FormField id={inputId} label={label} required={required} error={errorText} className={className}>
      {(p) => {
        const describedBy =
          [hasHelper ? helperId : null, p["aria-describedby"]].filter(Boolean).join(" ") || undefined;
        return (
          <>
            <div className="flex min-w-0 items-center gap-1">
              <Input
                {...p}
                ref={inputRef}
                aria-describedby={describedBy}
                type={visible ? "text" : "password"}
                name={name}
                autoComplete={autoComplete}
                maxLength={maxLength}
                minLength={effectiveMinLength}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="min-w-0 flex-1"
                onChange={
                  showLengthHint
                    ? (event) => {
                        const next = lengthHintBucket(event.currentTarget.value.length);
                        setBucket((prev) => (prev === next ? prev : next));
                      }
                    : undefined
                }
              />
              <IconButton
                icon={visible ? "eye-off" : "eye"}
                label={visible ? HIDE_PASSWORD_LABEL : SHOW_PASSWORD_LABEL}
                pressed={visible}
                aria-controls={inputId}
                disabled={!mounted}
                // Keep focus (and the caret) in the input on pointer toggles.
                onMouseDown={(event) => event.preventDefault()}
                onClick={toggle}
              />
            </div>
            {hasHelper ? (
              <div id={helperId} className="text-small text-text-secondary break-words">
                {helperText}
              </div>
            ) : null}
            {showLengthHint ? (
              <p id={lengthHintId} role="status" aria-live="polite" className="text-small text-text-secondary">
                {bucket === "empty" ? "" : LENGTH_HINT_TEXT[bucket]}
              </p>
            ) : null}
          </>
        );
      }}
    </FormField>
  );
}
