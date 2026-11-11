import type { ReactNode } from "react";

export interface SummaryRowProps {
  label: string;
  value: string | ReactNode;
  /** Bold, larger row (e.g. the order total). */
  emphasis?: boolean;
  className?: string;
}

/**
 * One label/value pair as `<dt>`/`<dd>`. Must be rendered inside a `<dl>`
 * (use `SummaryList`). The wrapping `<div>` is allowed inside `<dl>` by HTML.
 */
export function SummaryRow({ label, value, emphasis = false, className }: SummaryRowProps) {
  const classes = [
    "flex justify-between gap-4",
    emphasis ? "text-h4 text-text-primary" : "text-body text-text-primary",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div role="presentation" className={classes}>
      <dt>{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

export interface SummaryListProps {
  children: ReactNode;
  className?: string;
  "aria-label"?: string;
}

/** `<dl>` wrapper for `SummaryRow`s. */
export function SummaryList({ children, className, "aria-label": ariaLabel }: SummaryListProps) {
  return (
    <dl aria-label={ariaLabel} className={["flex flex-col gap-2", className].filter(Boolean).join(" ")}>
      {children}
    </dl>
  );
}
