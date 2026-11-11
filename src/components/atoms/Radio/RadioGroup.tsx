"use client";

import { useId } from "react";
import type { ChangeEvent, FieldsetHTMLAttributes, ReactNode, Ref } from "react";
import { RadioGroupContext, type RadioGroupContextValue, type RadioSize } from "./RadioGroupContext";

export type RadioGroupOrientation = "vertical" | "horizontal";

export interface RadioGroupProps
  extends Omit<
    FieldsetHTMLAttributes<HTMLFieldSetElement>,
    "onChange" | "defaultValue" | "role" | "children"
  > {
  /** Group label, rendered as `<legend>`. */
  label: string;
  /** Keep the legend for assistive tech only. */
  hideLabel?: boolean;
  /** Shared `name` for every Radio inside; the checked value posts under it. */
  name: string;
  /** Controlled selected value (`""` = none). */
  value?: string;
  /** Uncontrolled initial value. */
  defaultValue?: string;
  onChange?: (value: string, event: ChangeEvent<HTMLInputElement>) => void;
  /** Defaults to "vertical". Horizontal wraps on narrow screens. */
  orientation?: RadioGroupOrientation;
  /** Native `required` on every radio, plus `aria-required` on the group. */
  required?: boolean;
  /** Marks the group invalid (`aria-invalid`) and every circle with a danger border. */
  invalid?: boolean;
  /** Error message, linked to the group with `aria-describedby` and announced. */
  errorText?: string;
  /** Hint under the legend, linked with `aria-describedby`. */
  hint?: string;
  /** Applies to every Radio inside. Defaults to "md". */
  size?: RadioSize;
  disabled?: boolean;
  children: ReactNode;
  ref?: Ref<HTMLFieldSetElement>;
}

/**
 * `<fieldset role="radiogroup">` + `<legend>` wrapping native radios. Works
 * without JavaScript: the checked radio posts as `name=value`.
 */
export function RadioGroup({
  label,
  hideLabel = false,
  name,
  value,
  defaultValue,
  onChange,
  orientation = "vertical",
  required = false,
  invalid = false,
  errorText,
  hint,
  size = "md",
  disabled = false,
  id,
  className,
  children,
  ref,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: RadioGroupProps) {
  const autoId = useId();
  const baseId = id ?? `radiogroup-${autoId}`;
  const hintId = hint ? `${baseId}-hint` : undefined;
  const hasError = Boolean(errorText?.trim());
  const errorId = hasError ? `${baseId}-error` : undefined;
  const describedBy = [ariaDescribedBy, hintId, errorId].filter(Boolean).join(" ") || undefined;
  const isInvalid = invalid || hasError;

  const context: RadioGroupContextValue = {
    name,
    value,
    defaultValue,
    onChange,
    required,
    invalid: isInvalid,
    size,
  };

  return (
    <fieldset
      {...rest}
      ref={ref}
      id={id}
      role="radiogroup"
      disabled={disabled}
      aria-invalid={isInvalid ? "true" : undefined}
      aria-required={required ? "true" : undefined}
      aria-describedby={describedBy}
      className={["m-0 min-w-0 border-0 p-0 disabled:opacity-50", className].filter(Boolean).join(" ")}
    >
      <legend className={hideLabel ? "sr-only" : "mb-1 text-small font-semibold text-text-primary"}>
        {label}
        {required ? (
          <span className="font-normal text-text-secondary" aria-hidden="true">
            {" "}
            (required)
          </span>
        ) : null}
      </legend>
      {hint ? (
        <p id={hintId} className="text-small text-text-secondary">
          {hint}
        </p>
      ) : null}
      <div
        className={
          orientation === "horizontal" ? "flex flex-row flex-wrap gap-x-6" : "flex flex-col"
        }
      >
        <RadioGroupContext value={context}>{children}</RadioGroupContext>
      </div>
      {hasError ? (
        <p id={errorId} role="alert" className="text-small text-danger">
          {errorText}
        </p>
      ) : null}
    </fieldset>
  );
}
