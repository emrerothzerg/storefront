import type { ComponentPropsWithRef } from "react";
import { Icon, type IconSize } from "../Icon";
import { VisuallyHidden } from "../VisuallyHidden";

export type StepStatus = "complete" | "current" | "upcoming" | "cancelled";
export type StepsOrientation = "horizontal" | "vertical";
export type StepsSize = "sm" | "md";

export interface StepItem {
  /** Stable key. */
  id: string;
  /** Visible step name, e.g. "Shipped". */
  label: string;
  /** Optional supporting line, e.g. "Arriving Tuesday". */
  description?: string;
  status: StepStatus;
  /** Pre-formatted, human-readable time, e.g. "Nov 7, 10:42 AM". */
  timestamp?: string;
}

export interface StepsProps extends Omit<ComponentPropsWithRef<"ol">, "children"> {
  /** Steps in order. An empty array renders nothing. */
  steps: readonly StepItem[];
  /**
   * "horizontal" lays steps out in a row from `md` up and stacks them
   * vertically below `md` (320px safe). Defaults to "vertical".
   */
  orientation?: StepsOrientation;
  /** Defaults to "md". */
  size?: StepsSize;
}

/** Visually hidden status prefix read before each label. */
export const STEP_STATUS_TEXT: Record<StepStatus, string> = {
  complete: "Completed",
  current: "Current step",
  upcoming: "Upcoming",
  cancelled: "Cancelled",
};

const iconSize: Record<StepsSize, IconSize> = { sm: "sm", md: "md" };


const labelText: Record<StepsSize, string> = { sm: "text-small", md: "text-body" };
const metaText: Record<StepsSize, string> = { sm: "text-caption", md: "text-small" };

function join(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function StepIndicator({ status, size }: { status: StepStatus; size: StepsSize }) {
  if (status === "complete") {
    return <Icon name="check-circle" size={iconSize[size]} className="shrink-0 text-accent" />;
  }
  if (status === "cancelled") {
    return <Icon name="error-circle" size={iconSize[size]} className="shrink-0 text-danger" />;
  }
  return (
    <Icon
      name={status === "current" ? "circle-dot" : "circle"}
      size={iconSize[size]}
      data-indicator={status}
      className={join("shrink-0", status === "current" ? "text-accent" : "text-border-strong")}
    />
  );
}

/**
 * Ordered progress timeline (order fulfilment). Each step's status is given
 * three ways: visually hidden text ("Completed", "Current step", "Upcoming",
 * "Cancelled"), an icon, and colour. The current step carries
 * `aria-current="step"`. Server-component safe.
 *
 * ```tsx
 * <Steps
 *   orientation="horizontal"
 *   aria-label="Order progress"
 *   steps={[
 *     { id: "placed", label: "Ordered", status: "complete", timestamp: "Nov 3" },
 *     { id: "shipped", label: "Shipped", status: "current", description: "In transit" },
 *     { id: "delivered", label: "Delivered", status: "upcoming" },
 *   ]}
 * />
 * ```
 */
export function Steps({
  steps,
  orientation = "vertical",
  size = "md",
  className,
  ref,
  ...rest
}: StepsProps) {
  if (steps.length === 0) return null;
  const horizontal = orientation === "horizontal";

  return (
    <ol
      {...rest}
      ref={ref}
      // list-none drops list semantics in Safari/VoiceOver; restore them.
      role="list"
      data-orientation={orientation}
      className={join("m-0 flex list-none flex-col p-0", horizontal && "md:flex-row", className)}
    >
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const current = step.status === "current";
        return (
          <li
            key={step.id}
            aria-current={current ? "step" : undefined}
            data-status={step.status}
            className={join("flex min-w-0 gap-3", horizontal && "md:flex-1 md:flex-col md:gap-2")}
          >
            {/* Indicator + connector to the next step (decorative). */}
            <div
              className={join(
                "flex shrink-0 flex-col items-center",
                horizontal && "md:flex-row md:self-stretch",
              )}
            >
              <StepIndicator status={step.status} size={size} />
              {last ? null : (
                <span
                  aria-hidden="true"
                  data-testid="step-connector"
                  className={join(
                    "my-1 min-h-6 w-0.5 flex-1 rounded-full",
                    horizontal && "md:mx-2 md:my-0 md:h-0.5 md:min-h-0 md:w-auto",
                    step.status === "complete" ? "bg-accent" : "bg-border-default",
                  )}
                />
              )}
            </div>
            <div
              className={join(
                "flex min-w-0 flex-col",
                !last && "pb-4",
                horizontal && "md:pb-0 md:pe-2",
              )}
            >
              <span
                className={join(
                  labelText[size],
                  "break-words",
                  step.status === "cancelled" ? "text-danger" : "text-text-primary",
                  current && "font-semibold",
                )}
              >
                <VisuallyHidden>{`${STEP_STATUS_TEXT[step.status]}: `}</VisuallyHidden>
                {step.label}
              </span>
              {step.description ? (
                <span className={join(metaText[size], "break-words text-text-secondary")}>
                  {step.description}
                </span>
              ) : null}
              {step.timestamp ? (
                <span className={join(metaText[size], "text-text-secondary")}>
                  {step.timestamp}
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
