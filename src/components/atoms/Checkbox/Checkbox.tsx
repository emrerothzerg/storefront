"use client";

import { useCallback, useEffect, useId, useRef } from "react";
import type { InputHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconSize } from "../Icon";

export type CheckboxSize = "sm" | "md" | "lg";

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size" | "children"> {
  /** Visible label; clicking it toggles the box. */
  label: ReactNode;
  /** Helper text under the label, linked with `aria-describedby`. */
  description?: ReactNode;
  /**
   * Mixed state (e.g. "select all" with some selected). Set on the DOM node
   * after mount and mirrored as `aria-checked="mixed"`.
   */
  indeterminate?: boolean;
  /** Sets `aria-invalid="true"` and a danger border. */
  invalid?: boolean;
  /** Box 16 / 20 / 24px. Defaults to "md". The row keeps a 44px hit area. */
  size?: CheckboxSize;
  ref?: Ref<HTMLInputElement>;
}

const boxSize: Record<CheckboxSize, string> = { sm: "size-4", md: "size-5", lg: "size-6" };
const iconSize: Record<CheckboxSize, IconSize> = { sm: "sm", md: "sm", lg: "md" };
const labelText: Record<CheckboxSize, string> = {
  sm: "text-small",
  md: "text-body",
  lg: "text-body",
};
// Aligns the box with the first line of label text (line heights 20/24/24px).
const boxOffset: Record<CheckboxSize, string> = { sm: "mt-0.5", md: "mt-0.5", lg: "mt-0" };
// Box width + gap-3, so the description lines up with the label text.
const descriptionIndent: Record<CheckboxSize, string> = { sm: "pl-7", md: "pl-8", lg: "pl-9" };

function assignRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === "function") ref(node);
  else if (ref) ref.current = node;
}

/**
 * Native checkbox with a token-styled box. Works in plain forms without JS
 * (posts `name=value`, default value "on").
 */
export function Checkbox({
  label,
  description,
  indeterminate = false,
  invalid = false,
  size = "md",
  id,
  className,
  disabled,
  ref,
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? `checkbox-${autoId}`;
  const descriptionId = description != null ? `${inputId}-description` : undefined;
  const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";

  const innerRef = useRef<HTMLInputElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      innerRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const boxClasses = [
    "peer m-0 shrink-0 cursor-pointer appearance-none rounded-sm border bg-surface-raised",
    "checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent",
    "disabled:cursor-not-allowed disabled:opacity-50",
    isInvalid ? "border-danger" : "border-border-strong",
    boxSize[size],
  ].join(" ");

  const markClasses =
    "pointer-events-none invisible absolute inset-0 m-auto text-text-on-accent";

  return (
    <div className={["flex flex-col", className].filter(Boolean).join(" ")}>
      <label
        htmlFor={inputId}
        className={[
          "inline-flex min-h-touch cursor-pointer items-start gap-3 py-2.5 text-text-primary",
          disabled ? "cursor-not-allowed opacity-50" : "",
          labelText[size],
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className={`relative inline-flex shrink-0 ${boxOffset[size]}`}>
          <input
            {...rest}
            ref={setRefs}
            id={inputId}
            type="checkbox"
            disabled={disabled}
            aria-invalid={isInvalid ? "true" : undefined}
            aria-checked={indeterminate ? "mixed" : undefined}
            aria-describedby={describedBy}
            className={boxClasses}
          />
          {/* Check shows when checked; the minus wins while indeterminate. */}
          <Icon
            name="check"
            size={iconSize[size]}
            className={`${markClasses} peer-checked:visible peer-indeterminate:invisible`}
          />
          <Icon
            name="minus"
            size={iconSize[size]}
            className={`${markClasses} peer-indeterminate:visible`}
          />
        </span>
        <span>{label}</span>
      </label>
      {description != null ? (
        <span id={descriptionId} className={`${descriptionIndent[size]} text-small text-text-secondary`}>
          {description}
        </span>
      ) : null}
    </div>
  );
}
