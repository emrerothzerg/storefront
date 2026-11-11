"use client";

import { useRef, useState } from "react";
import type { ChangeEvent, Ref, TextareaHTMLAttributes } from "react";

export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "children"> {
  /** Required so a `<label htmlFor>` can always point at it (FormField supplies it). */
  id: string;
  /** Marks the field invalid: sets `aria-invalid="true"` and a danger border. */
  invalid?: boolean;
  /**
   * With `maxLength`: shows "120 / 500" under the field (linked with
   * `aria-describedby`) and politely announces "450 / 500 characters" only
   * when the count first crosses 80%, 90% and 100% of the limit.
   */
  showCount?: boolean;
  /**
   * Grow with the content (CSS `field-sizing: content`, no JS) up to 16rem,
   * then scroll. Browsers without support keep the `rows` height.
   */
  autoResize?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
}

/** Fractions of maxLength at which the live region speaks (rising only). */
export const COUNT_THRESHOLDS = [0.8, 0.9, 1] as const;

/** Index of the highest threshold reached (-1 = none). */
export function thresholdLevel(length: number, max: number): number {
  let level = -1;
  COUNT_THRESHOLDS.forEach((t, i) => {
    if (length >= Math.ceil(max * t)) level = i;
  });
  return level;
}

const base =
  "block w-full min-h-touch px-3 py-2 bg-surface-raised border rounded-md text-body text-text-primary placeholder:text-text-secondary disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-secondary";

/**
 * Multi-line counterpart of Input (same props shape, works with FormField).
 * Without `showCount` it holds no state and posts as a normal field.
 */
export function Textarea({
  id,
  invalid = false,
  showCount = false,
  autoResize = false,
  rows = 4,
  maxLength,
  value,
  defaultValue,
  onChange,
  className,
  ref,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: TextareaProps) {
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  const counting = showCount && maxLength !== undefined && maxLength > 0;

  const initialLength = String(value ?? defaultValue ?? "").length;
  const [uncontrolledLength, setUncontrolledLength] = useState(initialLength);
  const length = value !== undefined ? String(value).length : uncontrolledLength;

  const [announcement, setAnnouncement] = useState("");
  const levelRef = useRef(counting ? thresholdLevel(initialLength, maxLength) : -1);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onChange?.(event);
    if (!counting) return;
    const nextLength = event.target.value.length;
    setUncontrolledLength(nextLength);
    const level = thresholdLevel(nextLength, maxLength);
    if (level > levelRef.current) {
      const text = `${nextLength} / ${maxLength} characters`;
      // Same text as last time (re-crossing at the same length) would not
      // mutate the live region, so toggle a trailing period to force a re-read.
      setAnnouncement((prev) => (prev === text ? `${text}.` : text));
    }
    levelRef.current = level;
  };

  const countId = counting ? `${id}-count` : undefined;
  const describedBy = [ariaDescribedBy, countId].filter(Boolean).join(" ") || undefined;
  const classes = [
    base,
    isInvalid ? "border-danger" : "border-border-strong",
    autoResize ? "field-sizing-content min-h-24 max-h-64 resize-none" : "resize-y",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const valueProps = value !== undefined ? { value } : defaultValue !== undefined ? { defaultValue } : {};

  const textarea = (
    <textarea
      {...rest}
      {...valueProps}
      ref={ref}
      id={id}
      rows={rows}
      maxLength={maxLength}
      aria-invalid={isInvalid ? "true" : ariaInvalid}
      aria-describedby={describedBy}
      onChange={counting || onChange ? handleChange : undefined}
      className={classes}
    />
  );

  if (!counting) return textarea;

  return (
    <div className="flex flex-col gap-1">
      {textarea}
      <p
        id={countId}
        className={`self-end text-caption ${length >= maxLength ? "text-danger" : "text-text-secondary"}`}
      >
        {`${length} / ${maxLength}`}
        <span className="sr-only"> characters</span>
      </p>
      <span aria-live="polite" aria-atomic="true" className="sr-only" data-testid="textarea-live">
        {announcement}
      </span>
    </div>
  );
}
