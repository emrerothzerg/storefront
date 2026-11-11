"use client";

import { useState } from "react";
import { Notice } from "@/components/atoms/Notice";
import type { QaActionState } from "../_contracts/qa-actions";

/**
 * Shared bits for the Q&A molecules (QuestionForm, AnswerForm, QuestionCard).
 * Caps mirror `src/server/qa/qa-service.ts` (asserted equal in tests; this
 * file must not import server code).
 */
export const QUESTION_MAX_LENGTH = 300;
export const QUESTION_MIN_LENGTH = 10;
export const ANSWER_MAX_LENGTH = 1000;
export const DISPLAY_NAME_MAX = 50;

export type QaFailure = Extract<NonNullable<QaActionState>, { ok: false }>;

/** Narrow the action state to a failure (or null). */
export function failureOf(state: QaActionState): QaFailure | null {
  return state !== null && state.ok === false ? state : null;
}

/**
 * Counts settled submissions. Used as a `key` so uncontrolled fields remount
 * with the echoed `defaultValue`s after each attempt (React resets form fields
 * after an action; without the remount the echoed values would be lost).
 * Derived-state pattern: no effect, no extra render pass outside React's
 * "set state during render" rule.
 */
export function useAttempt<S>(state: S): number {
  const [seen, setSeen] = useState(state);
  const [attempt, setAttempt] = useState(0);
  if (seen !== state) {
    setSeen(state);
    setAttempt((n) => n + 1);
  }
  return attempt;
}

/** "Try again in about 3 minutes." from a retry hint in seconds. */
export function retryText(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return "Try again in less than a minute.";
  const minutes = Math.ceil(seconds / 60);
  return `Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

const TITLES: Partial<Record<QaFailure["error"]["code"], string>> = {
  DUPLICATE: "Already posted",
  RATE_LIMITED: "Too many posts",
  LIMIT_REACHED: "Answer limit reached",
  VALIDATION_FAILED: "Please fix the following",
  TOO_LONG: "Please fix the following",
};

const WARNING_CODES: ReadonlySet<string> = new Set(["DUPLICATE", "RATE_LIMITED", "LIMIT_REACHED"]);

/**
 * Error summary for an ask/answer failure. Notice gives `role="alert"` for
 * both tones; the per-field messages are rendered (and linked) by FormField.
 */
export function QaFailureNotice({ failure }: { failure: QaFailure }) {
  const code = failure.error.code;
  const tone = WARNING_CODES.has(code) ? "warning" : "danger";
  const retry = code === "RATE_LIMITED" ? retryText(failure.retryAfterSeconds) : null;
  return (
    <Notice tone={tone} title={TITLES[code] ?? "Something went wrong"}>
      {failure.message}
      {retry ? ` ${retry}` : null}
    </Notice>
  );
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** UTC calendar date so server and client render the same text. Empty for invalid input. */
export function formatQaDate(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? "" : dateFormatter.format(time);
}
