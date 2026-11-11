"use client";

import { useId, useState } from "react";
import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";

export type SwitchSize = "sm" | "md" | "lg";

export interface SwitchProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "type" | "role" | "children" | "value" | "name" | "onChange" | "aria-checked" | "defaultChecked"
  > {
  /** Label text. Visible unless `hideLabel`, in which case it becomes `aria-label`. */
  label: string;
  hideLabel?: boolean;
  /** Helper text under the label, linked with `aria-describedby`. */
  description?: ReactNode;
  /** Controlled state. */
  checked?: boolean;
  /** Uncontrolled initial state. Defaults to false. */
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /**
   * Form field name. A hidden input posts `name=value` while the switch is on
   * and nothing while it is off or disabled (same as a checkbox).
   */
  name?: string;
  /** Posted value when on. Defaults to "on". */
  value?: string;
  /** Defaults to "md". The whole row keeps a 44px hit area. */
  size?: SwitchSize;
  ref?: Ref<HTMLButtonElement>;
}

const trackSize: Record<SwitchSize, string> = { sm: "h-5 w-9", md: "h-6 w-11", lg: "h-7 w-13" };
const thumbSize: Record<SwitchSize, string> = { sm: "size-4", md: "size-5", lg: "size-6" };
// Thumb inset 2px (translate-x-0.5); "on" offset = track - thumb - 2px.
const thumbOn: Record<SwitchSize, string> = {
  sm: "group-aria-checked/switch:translate-x-4.5",
  md: "group-aria-checked/switch:translate-x-5.5",
  lg: "group-aria-checked/switch:translate-x-6.5",
};
const labelText: Record<SwitchSize, string> = { sm: "text-small", md: "text-body", lg: "text-body" };

/**
 * `role="switch"` toggle on a native `<button>` (Space and Enter toggle).
 * Off: thumb left on a border-strong track; on: thumb right on accent.
 * Position, not colour alone, carries the state.
 */
export function Switch({
  label,
  hideLabel = false,
  description,
  checked,
  defaultChecked = false,
  onCheckedChange,
  name,
  value = "on",
  size = "md",
  id,
  disabled,
  className,
  onClick,
  ref,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: SwitchProps) {
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const isOn = isControlled ? checked : internal;

  const autoId = useId();
  const switchId = id ?? `switch-${autoId}`;
  const descriptionId = description != null ? `${switchId}-description` : undefined;
  const describedBy = [ariaDescribedBy, descriptionId].filter(Boolean).join(" ") || undefined;

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    const next = !isOn;
    if (!isControlled) setInternal(next);
    onCheckedChange?.(next);
  };

  return (
    <div className={["flex flex-col", className].filter(Boolean).join(" ")}>
      <button
        {...rest}
        ref={ref}
        id={switchId}
        type="button"
        role="switch"
        aria-checked={isOn}
        aria-label={hideLabel ? label : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={handleClick}
        className={[
          "group/switch inline-flex min-h-touch min-w-touch w-fit cursor-pointer items-center gap-3 rounded-md text-left text-text-primary",
          "disabled:cursor-not-allowed disabled:opacity-50",
          labelText[size],
        ].join(" ")}
      >
        <span
          aria-hidden="true"
          className={`relative inline-flex shrink-0 items-center rounded-full bg-border-strong transition-colors group-aria-checked/switch:bg-accent ${trackSize[size]}`}
        >
          <span
            className={`inline-block translate-x-0.5 rounded-full bg-surface-raised shadow-sm transition-transform ${thumbSize[size]} ${thumbOn[size]}`}
          />
        </span>
        {hideLabel ? null : <span>{label}</span>}
      </button>
      {description != null ? (
        <span id={descriptionId} className="text-small text-text-secondary">
          {description}
        </span>
      ) : null}
      {name !== undefined && isOn ? <input type="hidden" name={name} value={value} disabled={disabled} /> : null}
    </div>
  );
}
