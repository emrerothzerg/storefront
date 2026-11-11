import { useId } from "react";
import type { ComponentPropsWithRef } from "react";

export type ProgressBarTone = "accent" | "success" | "warning";
export type ProgressBarSize = "sm" | "md";

export interface ProgressBarProps
  extends Omit<
    ComponentPropsWithRef<"div">,
    "children" | "role" | "aria-valuenow" | "aria-valuemin" | "aria-valuemax" | "aria-valuetext"
  > {
  /** Current value, clamped to [0, max]. Ignored when `indeterminate`. */
  value?: number;
  /** Upper bound. Defaults to 100. Non-positive values fall back to 100. */
  max?: number;
  /**
   * Accessible name. Always required; shown above the bar unless `hideLabel`.
   * An empty/whitespace string logs a warning outside production and falls
   * back to `aria-label="Progress"`.
   */
  label: string;
  /** Keep the label for assistive tech only (`aria-label` instead of a visible label). */
  hideLabel?: boolean;
  /**
   * Human-readable value, e.g. "$12.50 away from free shipping". Shown below
   * the bar and used as `aria-valuetext`. Defaults to the rounded percentage
   * (announced only; shown when `showValue`).
   */
  valueText?: string;
  /**
   * Don't render the visible (aria-hidden) `valueText` line; `aria-valuetext`
   * is kept. For callers that already show the same message as visible text
   * nearby. Does not affect `showValue`. Defaults to false.
   */
  hideValueText?: boolean;
  /** Show the rounded percentage next to the label (ignored when `valueText` is set). */
  showValue?: boolean;
  /** Fill colour. Defaults to "accent". */
  tone?: ProgressBarTone;
  /** Track thickness. Defaults to "md". */
  size?: ProgressBarSize;
  /** Unknown progress: omits `aria-valuenow` and pulses (motion permitting). */
  indeterminate?: boolean;
}

const toneClasses: Record<ProgressBarTone, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
};

const sizeClasses: Record<ProgressBarSize, string> = {
  sm: "h-2",
  md: "h-3",
};

export function clampProgress(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, value));
}

/**
 * Determinate or indeterminate progress (`role="progressbar"`). Server-component
 * safe. `ref` and extra props go to the `role="progressbar"` element;
 * `className` goes to the outer wrapper. The visible `valueText` line is
 * aria-hidden because it is already exposed as `aria-valuetext`.
 * The fill width is the one inline style: it is data, not a design
 * token (a percentage cannot be expressed as a token utility without
 * arbitrary values).
 */
export function ProgressBar({
  value = 0,
  max: maxProp = 100,
  label,
  hideLabel = false,
  valueText,
  hideValueText = false,
  showValue = false,
  tone = "accent",
  size = "md",
  indeterminate = false,
  id,
  className,
  ref,
  ...rest
}: ProgressBarProps) {
  const generatedId = useId();
  const baseId = id ?? generatedId;
  const labelId = `${baseId}-label`;

  const emptyLabel = label.trim() === "";
  if (emptyLabel && process.env.NODE_ENV !== "production") {
    console.warn('[ProgressBar] `label` must be non-empty; falling back to aria-label="Progress".');
  }
  const showVisibleLabel = !hideLabel && !emptyLabel;

  const max = Number.isFinite(maxProp) && maxProp > 0 ? maxProp : 100;
  const clamped = clampProgress(value, max);
  const percent = Math.round((clamped / max) * 100);
  const ariaValueText = indeterminate ? valueText : (valueText ?? `${percent}%`);

  const classes = ["flex flex-col gap-1", className].filter(Boolean).join(" ");

  return (
    <div className={classes}>
      {!showVisibleLabel ? null : (
        <div className="flex items-baseline justify-between gap-2 text-small text-text-primary">
          <span id={labelId}>{label}</span>
          {showValue && !valueText && !indeterminate ? (
            <span aria-hidden="true" className="tabular-nums">
              {percent}%
            </span>
          ) : null}
        </div>
      )}
      <div
        {...rest}
        ref={ref}
        id={id}
        role="progressbar"
        aria-labelledby={showVisibleLabel ? labelId : undefined}
        aria-label={showVisibleLabel ? undefined : emptyLabel ? "Progress" : label}
        aria-valuemin={indeterminate ? undefined : 0}
        aria-valuemax={indeterminate ? undefined : max}
        aria-valuenow={indeterminate ? undefined : clamped}
        aria-valuetext={ariaValueText}
        aria-busy={indeterminate || undefined}
        className={[
          "w-full overflow-hidden rounded-full border border-border-strong bg-surface-sunken",
          sizeClasses[size],
        ].join(" ")}
      >
        <div
          data-testid="progress-fill"
          className={[
            "h-full rounded-full transition-all",
            toneClasses[tone],
            indeterminate ? "w-full motion-safe:animate-pulse" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>
      {valueText && !hideValueText ? (
        <p aria-hidden="true" className="text-small text-text-primary">
          {valueText}
        </p>
      ) : null}
    </div>
  );
}
