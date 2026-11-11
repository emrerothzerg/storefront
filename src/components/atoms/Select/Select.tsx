import type { Ref, SelectHTMLAttributes } from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "children"> {
  /** Required so a `<label htmlFor>` can always point at it (FormField supplies it). */
  id: string;
  options: ReadonlyArray<SelectOption>;
  /** Rendered as a disabled empty first option ("Choose a size"). */
  placeholder?: string;
  /** Marks the field invalid: sets `aria-invalid="true"` and a danger border. */
  invalid?: boolean;
  ref?: Ref<HTMLSelectElement>;
}

const base =
  "block w-full min-h-touch px-3 py-2 bg-surface-raised border rounded-md text-body text-text-primary disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-secondary";

/**
 * Presentational native `<select>`. When `placeholder` is set and the select is
 * neither controlled (`value`) nor given a `defaultValue`, it starts on the
 * placeholder (`defaultValue=""`) instead of silently preselecting option 1.
 */
export function Select({
  id,
  options,
  placeholder,
  invalid = false,
  className,
  ref,
  value,
  defaultValue,
  "aria-invalid": ariaInvalid,
  ...rest
}: SelectProps) {
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  const classes = [base, isInvalid ? "border-danger" : "border-border-strong", className]
    .filter(Boolean)
    .join(" ");
  const valueProps =
    value !== undefined
      ? { value }
      : defaultValue !== undefined
        ? { defaultValue }
        : placeholder !== undefined && !rest.multiple
          ? { defaultValue: "" }
          : {};
  return (
    <select
      {...rest}
      {...valueProps}
      ref={ref}
      id={id}
      aria-invalid={isInvalid ? "true" : ariaInvalid}
      className={classes}
    >
      {placeholder !== undefined && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
