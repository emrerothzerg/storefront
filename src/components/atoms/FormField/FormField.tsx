import type { ReactNode } from "react";

/** Wiring FormField hands to its control. Spread it onto Input/Select/etc. */
export interface FormFieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": "true" | undefined;
  "aria-required": "true" | undefined;
  required: boolean | undefined;
}

export interface FormFieldProps {
  id: string;
  label: string;
  required?: boolean;
  hint?: string;
  /** When set, the control is marked invalid and this message is announced. */
  error?: string;
  /** Render prop: `(controlProps) => <Input {...controlProps} name="email" />`. */
  children: (controlProps: FormFieldControlProps) => ReactNode;
  className?: string;
}

/**
 * Label + hint + error wrapper. Presentational; works in server components.
 * The "(required)" text is visible (not colour-only) and aria-hidden, because
 * the control's own `aria-required` already announces it to assistive tech.
 */
export function FormField({
  id,
  label,
  required = false,
  hint,
  error,
  children,
  className,
}: FormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const controlProps: FormFieldControlProps = {
    id,
    "aria-describedby": describedBy,
    "aria-invalid": error ? "true" : undefined,
    "aria-required": required ? "true" : undefined,
    required: required || undefined,
  };

  return (
    <div className={["flex flex-col gap-1", className].filter(Boolean).join(" ")}>
      <label htmlFor={id} className="text-small text-text-primary">
        {label}
        {required && (
          <span className="text-text-secondary" aria-hidden="true">
            {" "}
            (required)
          </span>
        )}
      </label>
      {hint && (
        <p id={hintId} className="text-small text-text-secondary">
          {hint}
        </p>
      )}
      {children(controlProps)}
      {error && (
        <p id={errorId} role="alert" className="text-danger text-small">
          {error}
        </p>
      )}
    </div>
  );
}
