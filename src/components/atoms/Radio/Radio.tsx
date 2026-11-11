"use client";

import { useId } from "react";
import type { ChangeEvent, InputHTMLAttributes, ReactNode, Ref } from "react";
import { useRadioGroup, type RadioSize } from "./RadioGroupContext";

export interface RadioProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "type" | "size" | "children" | "value" | "name"
  > {
  /** Visible label; clicking it selects the radio. */
  label: ReactNode;
  /** Helper text under the label, linked with `aria-describedby`. */
  description?: ReactNode;
  /** Posted value. */
  value: string;
  /** Only needed outside a RadioGroup (the group supplies it). */
  name?: string;
  /** Only needed outside a RadioGroup. Defaults to the group's size, else "md". */
  size?: RadioSize;
  ref?: Ref<HTMLInputElement>;
}

const circleSize: Record<RadioSize, string> = { sm: "size-4", md: "size-5", lg: "size-6" };
const dotSize: Record<RadioSize, string> = { sm: "size-2", md: "size-2.5", lg: "size-3" };
const labelText: Record<RadioSize, string> = { sm: "text-small", md: "text-body", lg: "text-body" };
const circleOffset: Record<RadioSize, string> = { sm: "mt-0.5", md: "mt-0.5", lg: "mt-0" };
const descriptionIndent: Record<RadioSize, string> = { sm: "pl-7", md: "pl-8", lg: "pl-9" };

/**
 * Native radio with a token-styled circle. Use inside `RadioGroup`, which
 * supplies name / value / onChange / required / invalid. Arrow keys, Space
 * and form posting are native.
 */
export function Radio({
  label,
  description,
  value,
  name,
  size,
  id,
  className,
  disabled,
  onChange,
  ref,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: RadioProps) {
  const group = useRadioGroup();
  const autoId = useId();
  const inputId = id ?? `radio-${autoId}`;
  const descriptionId = description != null ? `${inputId}-description` : undefined;
  const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;
  const resolvedSize: RadioSize = size ?? group?.size ?? "md";
  const invalid = group?.invalid ?? false;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event);
    group?.onChange?.(value, event);
  };
  const hasHandler = onChange !== undefined || group?.onChange !== undefined;

  // Controlled when the group has a value; otherwise uncontrolled (defaultChecked).
  const checkedProps =
    group && group.value !== undefined
      ? { checked: group.value === value, onChange: handleChange }
      : {
          ...(group && group.defaultValue !== undefined
            ? { defaultChecked: group.defaultValue === value }
            : {}),
          ...(hasHandler ? { onChange: handleChange } : {}),
        };

  return (
    <div className={["flex flex-col", className].filter(Boolean).join(" ")}>
      <label
        htmlFor={inputId}
        className={[
          "inline-flex min-h-touch cursor-pointer items-start gap-3 py-2.5 text-text-primary",
          disabled ? "cursor-not-allowed opacity-50" : "",
          labelText[resolvedSize],
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className={`relative inline-flex shrink-0 ${circleOffset[resolvedSize]}`}>
          <input
            {...rest}
            {...checkedProps}
            ref={ref}
            id={inputId}
            type="radio"
            name={name ?? group?.name}
            value={value}
            required={rest.required ?? (group?.required || undefined)}
            disabled={disabled}
            aria-describedby={describedBy}
            className={[
              "peer m-0 shrink-0 cursor-pointer appearance-none rounded-full border bg-surface-raised",
              "checked:border-accent disabled:cursor-not-allowed",
              invalid ? "border-danger" : "border-border-strong",
              circleSize[resolvedSize],
            ].join(" ")}
          />
          <span
            aria-hidden="true"
            className={`pointer-events-none invisible absolute inset-0 m-auto rounded-full bg-accent peer-checked:visible ${dotSize[resolvedSize]}`}
          />
        </span>
        <span>{label}</span>
      </label>
      {description != null ? (
        <span
          id={descriptionId}
          className={`${descriptionIndent[resolvedSize]} text-small text-text-secondary`}
        >
          {description}
        </span>
      ) : null}
    </div>
  );
}
