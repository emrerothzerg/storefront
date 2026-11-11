import type { HTMLAttributes } from "react";
import { Icon } from "@/components/atoms/Icon";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import type { DeliveryEstimate as DeliveryEstimateRange } from "@/server/pricing/shipping-service";
import { parseIsoStrict } from "./parseIsoStrict";

const DAY_MS = 86_400_000;

// UTC so server and client render the same text (no hydration mismatch).
const fullFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const shortFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** "Tue, Nov 12", or "Tomorrow, Nov 12" when the UTC day is the day after `now`. */
export function formatDeliveryDay(ms: number, now?: number): string {
  if (now !== undefined && Number.isFinite(now) && utcDay(ms) === utcDay(now) + 1) {
    return `Tomorrow, ${shortFormat.format(ms)}`;
  }
  return fullFormat.format(ms);
}

export interface DeliveryRangeText {
  start: string;
  /** null when start and end fall on the same UTC day. */
  end: string | null;
}

/**
 * Formats an estimate as en-US UTC day labels. Returns null for a missing
 * estimate, dates that are not strict ISO-8601 date-times (including impossible
 * calendar dates such as Feb 31) or an end before the start.
 */
export function formatDeliveryRange(
  estimate: DeliveryEstimateRange | null | undefined,
  now?: number,
): DeliveryRangeText | null {
  if (estimate == null) return null;
  const start = parseIsoStrict(estimate.start);
  const end = parseIsoStrict(estimate.end);
  if (start === null || end === null || end < start) return null;
  const startText = formatDeliveryDay(start, now);
  if (utcDay(start) === utcDay(end)) return { start: startText, end: null };
  return { start: startText, end: formatDeliveryDay(end, now) };
}

export interface DeliveryEstimateProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** ISO start/end from the shipping service. null or invalid renders nothing. */
  estimate: DeliveryEstimateRange | null;
  /** Shipping method shown under the dates, e.g. "Standard Shipping". */
  methodName?: string;
  /** Adds "Free" (text) to the method line. */
  isFree?: boolean;
  /** Out of stock renders nothing. */
  inStock: boolean;
  /** e.g. "Free shipping on orders of $35 or more". */
  freeShippingNote?: string | null;
  /** Epoch ms used only for the "Tomorrow" label; omit for plain dates. */
  now?: number;
}

/**
 * "Arrives Tue, Nov 12 – Thu, Nov 14" with optional method, Free and
 * free-shipping note. Server-safe; never throws.
 */
export function DeliveryEstimate({
  estimate,
  methodName,
  isFree = false,
  inStock,
  freeShippingNote,
  now,
  className,
  ...rest
}: DeliveryEstimateProps) {
  if (!inStock) return null;
  const range = formatDeliveryRange(estimate, now);
  if (range === null) return null;

  const method = methodName?.trim() ?? "";
  const note = freeShippingNote?.trim() ?? "";
  const classes = ["flex min-w-0 flex-col gap-1 text-small text-text-primary", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div {...rest} className={classes}>
      <p className="flex items-start gap-2">
        <Icon name="truck" size="md" className="text-accent" />
        <span>
          Arrives{" "}
          <span className="font-semibold">
            {range.start}
            {range.end !== null ? (
              <>
                <span aria-hidden="true"> – </span>
                <VisuallyHidden> to </VisuallyHidden>
                {range.end}
              </>
            ) : null}
          </span>
        </span>
      </p>
      {isFree || method !== "" ? (
        <p className="pl-7">
          {isFree ? (
            <span className="rounded-full bg-success-subtle px-2 py-0.5 font-semibold text-success">Free</span>
          ) : null}
          {isFree && method !== "" ? " " : null}
          {method !== "" ? <span>{method}</span> : null}
          {isFree && method === "" ? <span> delivery</span> : null}
        </p>
      ) : null}
      {note !== "" ? <p className="pl-7 text-text-secondary">{note}</p> : null}
    </div>
  );
}
