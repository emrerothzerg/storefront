import type { InputHTMLAttributes, Ref } from "react";

export type InputType = "text" | "email" | "tel" | "number" | "password" | "search";
/**
 * `default`: 8px corners on a white field. `pill`: fully rounded, light-grey
 * fill, 48px tall (search fields; SearchField `variant="pill"`).
 */
export type InputVariant = "default" | "pill";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "type" | "id"> {
  /** Required so a `<label htmlFor>` can always point at it (FormField supplies it). */
  id: string;
  type?: InputType;
  /** Marks the field invalid: sets `aria-invalid="true"` and a danger border. */
  invalid?: boolean;
  /** Defaults to "default". */
  variant?: InputVariant;
  ref?: Ref<HTMLInputElement>;
}

const base =
  "block w-full min-h-touch px-3 py-2 bg-surface-raised border rounded-md text-body text-text-primary placeholder:text-text-secondary disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-secondary";
// Pill: sunken fill keeps a border-strong edge (the fill alone is ~1.1:1 on
// white, so the 3:1 control boundary comes from the border).
const pillBase =
  "block w-full min-h-12 px-5 py-2 bg-surface-sunken border rounded-full text-body text-text-primary placeholder:text-text-secondary disabled:cursor-not-allowed disabled:text-text-secondary";

/**
 * Presentational text input. No client state, so it works inside
 * server-rendered forms. Treats an incoming `aria-invalid="true"` (e.g. from
 * FormField) the same as `invalid` so the border always matches the state.
 */
export function Input({
  id,
  type = "text",
  invalid = false,
  variant = "default",
  className,
  ref,
  "aria-invalid": ariaInvalid,
  ...rest
}: InputProps) {
  const isInvalid = invalid || ariaInvalid === true || ariaInvalid === "true";
  const classes = [variant === "pill" ? pillBase : base, isInvalid ? "border-danger" : "border-border-strong", className]
    .filter(Boolean)
    .join(" ");
  return (
    <input
      {...rest}
      ref={ref}
      id={id}
      type={type}
      aria-invalid={isInvalid ? "true" : ariaInvalid}
      className={classes}
    />
  );
}
