"use client";

import { useState } from "react";
import type { ChangeEvent, KeyboardEvent, Ref } from "react";

export interface QuantityStepperProps {
  id: string;
  /** Accessible (and, with `showLabel`, visible) label. Default "Quantity". */
  label?: string;
  /** Show the label visually. When false it stays available to assistive tech. Default true. */
  showLabel?: boolean;
  value: number;
  /** Called only with an integer in [min, max], and only when it differs from `value`. */
  onChange: (next: number) => void;
  /** Default 1. */
  min?: number;
  /** Typically available stock. If `max < min` the stepper renders disabled. */
  max: number;
  disabled?: boolean;
  /** Put on the numeric input so plain `<form action>` posts carry the quantity. */
  name?: string;
  className?: string;
  /** Forwarded to the numeric input. */
  ref?: Ref<HTMLInputElement>;
}

const DIGITS_ONLY = /^\d+$/;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * Commit rule for typed text (applied on blur / Enter):
 * - Trim surrounding whitespace.
 * - Digits only ("7", " 7 ", "007") -> parse, then CLAMP into [min, max]
 *   ("0" -> min, "999" -> max).
 * - Anything else ("", "abc", "-3", "2.5", "+3", "1e2") -> REVERT to the last
 *   valid `value` (returns null).
 */
export function parseQuantity(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!DIGITS_ONLY.test(trimmed)) return null;
  return clamp(Number.parseInt(trimmed, 10), min, max);
}

const buttonClasses =
  "inline-flex size-touch shrink-0 items-center justify-center text-text-primary hover:bg-surface-sunken disabled:cursor-not-allowed disabled:text-text-secondary disabled:hover:bg-transparent";

function MinusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 stroke-current" fill="none" aria-hidden="true" focusable="false">
      <path d="M3 8h10" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 stroke-current" fill="none" aria-hidden="true" focusable="false">
      <path d="M3 8h10M8 3v10" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function QuantityStepper({
  id,
  label = "Quantity",
  showLabel = true,
  value,
  onChange,
  min = 1,
  max,
  disabled = false,
  name,
  className,
  ref,
}: QuantityStepperProps) {
  // Text being typed; null when not editing (the input then mirrors `value`).
  const [draft, setDraft] = useState<string | null>(null);

  const isDisabled = disabled || max < min;
  const canDecrement = !isDisabled && value > min;
  const canIncrement = !isDisabled && value < max;

  const emit = (next: number) => {
    if (isDisabled) return;
    const clamped = clamp(Math.trunc(next), min, max);
    if (clamped !== value) onChange(clamped);
  };

  const commit = () => {
    if (draft === null) return;
    const parsed = parseQuantity(draft, min, max);
    setDraft(null);
    if (parsed !== null) emit(parsed);
  };

  /** Base for arrow steps: a valid draft wins over the committed value. */
  const currentBase = (): number => {
    if (draft === null) return value;
    return parseQuantity(draft, min, max) ?? value;
  };

  const step = (delta: number) => {
    const base = currentBase();
    setDraft(null);
    emit(base + delta);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "Enter":
        // Commit only; don't submit the surrounding form with an unvalidated draft.
        event.preventDefault();
        commit();
        break;
      case "Escape":
        if (draft !== null) {
          event.preventDefault();
          setDraft(null);
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        step(1);
        break;
      case "ArrowDown":
        event.preventDefault();
        step(-1);
        break;
      case "Home":
        event.preventDefault();
        setDraft(null);
        emit(min);
        break;
      case "End":
        event.preventDefault();
        setDraft(null);
        emit(max);
        break;
    }
  };

  const labelId = `${id}-label`;

  return (
    <div className={["flex flex-col gap-1", className].filter(Boolean).join(" ")}>
      <label id={labelId} htmlFor={id} className={showLabel ? "text-small text-text-primary" : "sr-only"}>
        {label}
      </label>
      <div
        role="group"
        aria-labelledby={labelId}
        className="inline-flex w-fit items-stretch rounded-full border border-border-strong bg-surface-raised"
      >
        <button
          type="button"
          aria-label="Decrease quantity"
          aria-controls={id}
          className={`${buttonClasses} rounded-l-full`}
          disabled={!canDecrement}
          onClick={() => step(-1)}
        >
          <MinusIcon />
        </button>
        <input
          ref={ref}
          id={id}
          name={name}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          disabled={isDisabled}
          value={draft ?? String(value)}
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
          className="min-h-touch w-12 min-w-0 bg-transparent text-center text-body text-text-primary disabled:cursor-not-allowed disabled:text-text-secondary"
        />
        <button
          type="button"
          aria-label="Increase quantity"
          aria-controls={id}
          className={`${buttonClasses} rounded-r-full`}
          disabled={!canIncrement}
          onClick={() => step(1)}
        >
          <PlusIcon />
        </button>
      </div>
      <span aria-live="polite" aria-atomic="true" className="sr-only">
        {`${label}: ${value}`}
      </span>
    </div>
  );
}
