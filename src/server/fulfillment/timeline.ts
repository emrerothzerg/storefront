import type { FulfillmentStatus, IsoDateTimeString, OrderEvent } from "@/lib/types";
import {
  FULFILLMENT_SEQUENCE,
  deriveStatus,
  sequenceIndex,
  statusAt,
  type FulfillmentDeps,
  type FulfillmentInput,
} from "./fulfillment";

export interface TimelineStep {
  readonly status: FulfillmentStatus;
  readonly at: IsoDateTimeString | null;
  readonly state: "complete" | "current" | "upcoming" | "cancelled";
  readonly label: string;
}

export const TIMELINE_LABELS: Readonly<Record<FulfillmentStatus, string>> = {
  processing: "Order placed",
  packed: "Packed",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/** Valid persisted timestamps by status (unparsable `at` values are ignored). */
function persistedTimes(
  persisted: readonly OrderEvent[],
): ReadonlyMap<FulfillmentStatus, IsoDateTimeString> {
  const map = new Map<FulfillmentStatus, IsoDateTimeString>();
  for (const event of persisted) {
    const ms = Date.parse(event.at);
    if (Number.isFinite(ms) && !map.has(event.status)) {
      map.set(event.status, new Date(ms).toISOString());
    }
  }
  return map;
}

/**
 * Display timeline for an order.
 * - payment_failed: [].
 * - live order: the five sequenced steps. Steps before the current one are
 *   'complete', the current one 'current' (a reached 'delivered' is
 *   'complete'), later ones 'upcoming' with `at: null`. The current step is
 *   the later of deriveStatus() and the furthest persisted event.
 * - cancelled: the sequenced steps reached before the cancellation (or
 *   persisted), all 'complete', then a 'cancelled' step whose `at` is the
 *   persisted cancelled event, else `cancelledAt`, else null.
 * Persisted event timestamps win over derived ones.
 */
export function timeline(
  input: FulfillmentInput,
  nowMs: number,
  deps: FulfillmentDeps,
  persisted: readonly OrderEvent[],
): readonly TimelineStep[] {
  const derived = deriveStatus(input, nowMs, deps); // validates createdAt / nowMs
  if (input.status !== "paid") return [];
  const times = persistedTimes(persisted);

  if (derived === "cancelled") {
    const cancelAt = statusAt(input, "cancelled", deps);
    const horizon =
      cancelAt === null ? Date.parse(input.createdAt) : Math.min(nowMs, Date.parse(cancelAt));
    const steps: TimelineStep[] = [];
    for (const status of FULFILLMENT_SEQUENCE) {
      const persistedAt = times.get(status);
      let at: IsoDateTimeString | null = persistedAt ?? null;
      if (at === null) {
        const scheduled = statusAt(input, status, deps);
        if (status === "processing") at = scheduled;
        else if (scheduled !== null && Date.parse(scheduled) <= horizon) at = scheduled;
      }
      if (at !== null) {
        steps.push({ status, at, state: "complete", label: TIMELINE_LABELS[status] });
      }
    }
    steps.push({
      status: "cancelled",
      at: times.get("cancelled") ?? cancelAt,
      state: "cancelled",
      label: TIMELINE_LABELS.cancelled,
    });
    return steps;
  }

  let current = sequenceIndex(derived);
  for (const status of times.keys()) current = Math.max(current, sequenceIndex(status));

  return FULFILLMENT_SEQUENCE.map((status, i): TimelineStep => {
    const label = TIMELINE_LABELS[status];
    if (i > current) return { status, at: null, state: "upcoming", label };
    const at = times.get(status) ?? statusAt(input, status, deps);
    const state = i < current || status === "delivered" ? "complete" : "current";
    return { status, at, state, label };
  });
}
