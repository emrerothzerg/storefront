import { useId, type HTMLAttributes } from "react";
import { Icon } from "@/components/atoms/Icon";
import { Steps, type StepItem, type StepStatus } from "@/components/atoms/Steps";
import { Heading } from "@/components/atoms/Typography";
import type { TimelineStep } from "@/server/fulfillment/timeline";
import { formatDeliveryRange } from "../DeliveryEstimate";

/**
 * Mirror of `SIMULATED_TRACKING_NOTICE` in `src/server/fulfillment/fulfillment.ts`
 * (molecules do not import server runtime code); a test pins equality.
 */
export const SIMULATED_TRACKING_NOTICE = "Tracking is simulated in this demo store.";

export interface OrderTimelineEstimate {
  /** ISO date-time. */
  start: string;
  /** ISO date-time. */
  end: string;
}

export interface OrderTimelineProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  /** From the order service (`OrderView.timeline`). Empty renders the heading and notice only. */
  steps: readonly TimelineStep[];
  /** Shown as "Expected ..." on the delivered step while it has no timestamp. */
  estimatedDelivery?: OrderTimelineEstimate | null;
  /** Passed to `Steps`. Defaults to "vertical". */
  orientation?: "horizontal" | "vertical";
  /** Defaults to 2. */
  headingLevel?: 2 | 3;
  /** Visible heading text. Defaults to "Order progress". */
  heading?: string;
}

// UTC so server and client render the same text (no hydration mismatch).
// Date and time are formatted separately and joined by hand: ICU versions
// disagree on the joiner (", " vs " at ") and on the space before AM/PM.
const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const timeFormat = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

const KNOWN_STATES: ReadonlySet<string> = new Set<StepStatus>([
  "complete",
  "current",
  "upcoming",
  "cancelled",
]);

/** "Nov 7, 2026, 10:42 AM UTC"; null for missing or unparsable input. Never throws. */
export function formatTimelineDate(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  try {
    const time = timeFormat.format(ms).replace(/\s+/g, " ");
    return `${dateFormat.format(ms)}, ${time} UTC`;
  } catch {
    return null;
  }
}

/** "Expected Tue, Nov 10 – Thu, Nov 12"; null when the estimate is missing or invalid. */
export function formatExpected(estimate: OrderTimelineEstimate | null | undefined): string | null {
  const range = formatDeliveryRange(estimate ?? null);
  if (range === null) return null;
  return range.end === null ? `Expected ${range.start}` : `Expected ${range.start} – ${range.end}`;
}

/**
 * Defensive normalisation: steps after the first cancelled step are dropped
 * (a cancelled order never shows later steps, let alone completed ones), and
 * an unknown state is treated as "upcoming".
 */
export function normalizeTimeline(steps: readonly TimelineStep[]): readonly TimelineStep[] {
  const out: TimelineStep[] = [];
  for (const step of steps) {
    const state = KNOWN_STATES.has(step.state) ? step.state : "upcoming";
    out.push(state === step.state ? step : { ...step, state });
    if (state === "cancelled") break;
  }
  return out;
}

/** Maps timeline steps to `Steps` atom items (exported for tests). */
export function toStepItems(
  steps: readonly TimelineStep[],
  estimatedDelivery?: OrderTimelineEstimate | null,
): StepItem[] {
  const normalized = normalizeTimeline(steps);
  const cancelled = normalized.some((step) => step.state === "cancelled");
  const expected = cancelled ? null : formatExpected(estimatedDelivery);
  return normalized.map((step, index) => {
    let timestamp = formatTimelineDate(step.at);
    if (timestamp === null && step.status === "delivered" && step.state !== "complete") {
      timestamp = expected;
    }
    const item: StepItem = { id: `${step.status}-${index}`, label: step.label, status: step.state };
    return timestamp === null ? item : { ...item, timestamp };
  });
}

/**
 * Fulfilment timeline for an order: heading, `Steps` with en-US UTC dates
 * ("Expected <range>" on a delivered step that has not happened yet) and the
 * visible "Tracking is simulated" label (D4). Server-safe; never throws.
 */
export function OrderTimeline({
  steps,
  estimatedDelivery = null,
  orientation = "vertical",
  headingLevel = 2,
  heading = "Order progress",
  className,
  id,
  ...rest
}: OrderTimelineProps) {
  const uid = useId();
  const baseId = id ?? `order-timeline-${uid}`;
  const headingId = `${baseId}-heading`;
  const items = toStepItems(steps, estimatedDelivery);
  return (
    <section
      {...rest}
      id={id}
      aria-labelledby={headingId}
      className={["flex min-w-0 flex-col gap-3", className].filter(Boolean).join(" ")}
    >
      <Heading level={headingLevel} size="h3" id={headingId}>
        {heading}
      </Heading>
      <Steps steps={items} orientation={orientation} aria-labelledby={headingId} />
      <p className="flex items-start gap-2 text-small text-text-secondary">
        <Icon name="info" size="sm" className="mt-0.5 shrink-0" />
        <span>{SIMULATED_TRACKING_NOTICE}</span>
      </p>
    </section>
  );
}
