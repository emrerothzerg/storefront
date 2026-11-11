import type { HTMLAttributes } from "react";

export type SpinnerSize = "sm" | "md" | "lg";

export interface SpinnerProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "role" | "children"> {
  /** Visual size of the icon. Defaults to "md". */
  size?: SpinnerSize;
  /** Text announced to assistive tech. Visually hidden. Defaults to "Loading". */
  label?: string;
}

const sizeClasses: Record<SpinnerSize, string> = {
  sm: "size-4",
  md: "size-5",
  lg: "size-8",
};

/**
 * Indeterminate loading indicator. Renders a polite live region
 * (`role="status"`) with a visually hidden label. Under
 * `prefers-reduced-motion: reduce` the icon stays visible but does not spin.
 */
export function Spinner({
  size = "md",
  label = "Loading",
  className,
  ...rest
}: SpinnerProps) {
  const classes = ["inline-flex shrink-0 items-center justify-center", className]
    .filter(Boolean)
    .join(" ");

  return (
    <span role="status" className={classes} {...rest}>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 24 24"
        fill="none"
        className={`${sizeClasses[size]} animate-spin motion-reduce:animate-none`}
        data-testid="spinner-icon"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          strokeWidth="3"
          className="stroke-current opacity-25"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          strokeWidth="3"
          strokeLinecap="round"
          className="stroke-current"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
