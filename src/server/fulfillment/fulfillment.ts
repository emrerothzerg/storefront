import type {
  FulfillmentStatus,
  IsoDateTimeString,
  Order,
  ShippingMethod,
} from "@/lib/types";

/**
 * Simulated fulfilment (mock tracking). Pure, deterministic functions that
 * turn an order's `createdAt`, its shipping method and a caller-supplied
 * `nowMs` into a fulfilment status, per-status timestamps, cancellability and
 * the events the order service (T55) should persist to `order_events`.
 *
 * - No `Date.now()` anywhere: callers pass `nowMs` (epoch milliseconds).
 * - No DB access. No import from `src/server/pricing/*`: the delivery
 *   estimator (T38 `estimateDelivery`) is injected through `FulfillmentDeps`.
 * - Invalid `createdAt` / `cancelledAt`, a non-finite `nowMs`, or an estimator
 *   returning an unparsable `start` throw `TypeError` (programming errors).
 *
 * Offsets table: see README.md in this folder.
 */

export const CANCEL_WINDOW_MS = 30 * 60 * 1000;

export const FULFILLMENT_SEQUENCE = [
  "processing",
  "packed",
  "shipped",
  "out_for_delivery",
  "delivered",
] as const;

export type SequencedStatus = (typeof FULFILLMENT_SEQUENCE)[number];

export const SIMULATED_TRACKING_NOTICE =
  "Tracking is simulated in this demo store.";

export interface FulfillmentInput {
  readonly createdAt: IsoDateTimeString;
  /** Payment status: 'paid' | 'payment_failed'. */
  readonly status: Order["status"];
  /** Persisted fulfilment status; absent means 'processing'. */
  readonly fulfillmentStatus?: FulfillmentStatus;
  readonly cancelledAt?: IsoDateTimeString | null;
  /** null = standard-like default (minDays 5, maxDays 8). */
  readonly method: Pick<ShippingMethod, "id" | "minDays" | "maxDays"> | null;
}

export type DeliveryEstimator = (
  method: Pick<ShippingMethod, "minDays" | "maxDays">,
  placedAt: IsoDateTimeString | number,
  now?: number,
) => { start: IsoDateTimeString; end: IsoDateTimeString };

export interface FulfillmentDeps {
  readonly estimateDelivery: DeliveryEstimator;
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** processing -> packed. */
export const PACKED_OFFSET_MS = 2 * HOUR_MS;
/** processing -> shipped for next-day methods. */
export const NEXT_DAY_SHIP_OFFSET_MS = 6 * HOUR_MS;
/** Delivered time of day (UTC hour) on the estimate start date. */
export const DELIVERED_UTC_HOUR = 14;
/** out_for_delivery happens this long before the delivered time. */
export const OUT_FOR_DELIVERY_LEAD_MS = 8 * HOUR_MS;

/** Used when `method` is null. */
export const DEFAULT_METHOD: Pick<ShippingMethod, "id" | "minDays" | "maxDays"> =
  { id: "standard", minDays: 5, maxDays: 8 };

// ---------------------------------------------------------------------------
// Internal helpers

/** Parses an ISO string; throws TypeError when invalid. */
function parseRequired(value: string, field: string): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new TypeError(`fulfillment: invalid ${field}: ${String(value)}`);
  }
  return ms;
}

function assertNow(nowMs: number): void {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new TypeError(`fulfillment: nowMs must be a finite number`);
  }
}

function toIso(ms: number): IsoDateTimeString {
  return new Date(ms).toISOString();
}

function methodOf(
  input: FulfillmentInput,
): Pick<ShippingMethod, "id" | "minDays" | "maxDays"> {
  return input.method ?? DEFAULT_METHOD;
}

/** Next-day methods: id 'next_day' or maxDays <= 1. */
export function isNextDayMethod(
  method: Pick<ShippingMethod, "id" | "maxDays"> | null,
): boolean {
  if (method === null) return false;
  return method.id === "next_day" || method.maxDays <= 1;
}

function isWeekendUtc(ms: number): boolean {
  const day = new Date(ms).getUTCDay();
  return day === 0 || day === 6;
}

/** Adds `days` business days (Mon-Fri, UTC), keeping the time of day. */
export function addBusinessDaysUtc(ms: number, days: number): number {
  let out = ms;
  let remaining = days;
  while (remaining > 0) {
    out += DAY_MS;
    if (!isWeekendUtc(out)) remaining -= 1;
  }
  return out;
}

function atUtcHour(ms: number, hour: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour);
}

/**
 * Shipping happens on business days only (orchestrator ruling O1).
 * Weekday order: next-day = C + 6h; others = C + 1 business day.
 * Saturday/Sunday order: the clock starts the next Monday at C's time of day;
 * next-day = that Monday + 6h; others = that Monday (it counts as the
 * "+1 business day").
 */
export function shippedAtMs(
  createdMs: number,
  method: Pick<ShippingMethod, "id" | "maxDays">,
): number {
  if (isWeekendUtc(createdMs)) {
    const monday = addBusinessDaysUtc(createdMs, 1);
    return isNextDayMethod(method) ? monday + NEXT_DAY_SHIP_OFFSET_MS : monday;
  }
  return isNextDayMethod(method)
    ? createdMs + NEXT_DAY_SHIP_OFFSET_MS
    : addBusinessDaysUtc(createdMs, 1);
}

/**
 * Built-in business-day estimator, used ONLY when `deriveStatus` is called
 * without deps. start = placedAt + minDays business days, end = + maxDays.
 */
export const fallbackEstimateDelivery: DeliveryEstimator = (method, placedAt) => {
  const placed =
    typeof placedAt === "number" ? placedAt : parseRequired(placedAt, "placedAt");
  return {
    start: toIso(addBusinessDaysUtc(placed, method.minDays)),
    end: toIso(addBusinessDaysUtc(placed, method.maxDays)),
  };
};

function isCancelledInput(input: FulfillmentInput): boolean {
  return (
    input.fulfillmentStatus === "cancelled" ||
    (input.cancelledAt !== undefined && input.cancelledAt !== null)
  );
}

function cancelledAtMs(input: FulfillmentInput): number | null {
  if (input.cancelledAt === undefined || input.cancelledAt === null) return null;
  return parseRequired(input.cancelledAt, "cancelledAt");
}

export function sequenceIndex(status: FulfillmentStatus): number {
  return (FULFILLMENT_SEQUENCE as readonly FulfillmentStatus[]).indexOf(status);
}

function runEstimator(
  input: FulfillmentInput,
  createdMs: number,
  deps: FulfillmentDeps,
): { start: IsoDateTimeString; end: IsoDateTimeString } {
  const m = methodOf(input);
  const est = deps.estimateDelivery(
    { minDays: m.minDays, maxDays: m.maxDays },
    createdMs,
    createdMs,
  );
  parseRequired(est.start, "estimate.start");
  parseRequired(est.end, "estimate.end");
  return { start: est.start, end: est.end };
}

/**
 * Scheduled epoch-ms per sequenced status. Monotonic non-decreasing by
 * construction (clamps), so sequence order is chronological order.
 */
export function schedule(
  input: FulfillmentInput,
  deps: FulfillmentDeps,
): Readonly<Record<SequencedStatus, number>> {
  const created = parseRequired(input.createdAt, "createdAt");
  const packed = created + PACKED_OFFSET_MS;
  const shipped = shippedAtMs(created, methodOf(input));
  const est = runEstimator(input, created, deps);
  const deliveredBase = atUtcHour(Date.parse(est.start), DELIVERED_UTC_HOUR);
  const outForDelivery = Math.max(deliveredBase - OUT_FOR_DELIVERY_LEAD_MS, shipped);
  const delivered = Math.max(deliveredBase, outForDelivery);
  return {
    processing: created,
    packed,
    shipped,
    out_for_delivery: outForDelivery,
    delivered,
  };
}

/** Index of the latest sequenced status reached by `nowMs` (time only). */
function timeIndex(
  input: FulfillmentInput,
  created: number,
  nowMs: number,
  deps: FulfillmentDeps,
): number {
  if (nowMs < created) return 0; // clock skew
  if (nowMs < created + PACKED_OFFSET_MS) return 0; // estimator not needed
  const s = schedule(input, deps);
  let idx = 0;
  FULFILLMENT_SEQUENCE.forEach((status, i) => {
    if (s[status] <= nowMs) idx = i;
  });
  return idx;
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Current fulfilment status.
 * - cancelled (fulfillmentStatus 'cancelled' or cancelledAt set) stays 'cancelled'.
 * - payment_failed returns 'processing' (it has no timeline; see timeline()).
 * - now < createdAt (clock skew) derives 'processing'.
 * - exactly on a boundary returns the new status.
 * - never regresses below a persisted sequenced `fulfillmentStatus`.
 *
 * `deps` is optional (addition to the contract): without it a built-in
 * business-day estimator decides out_for_delivery/delivered. Pass the same
 * deps you pass to timeline()/nextEvents() so they agree.
 */
export function deriveStatus(
  input: FulfillmentInput,
  nowMs: number,
  deps?: FulfillmentDeps,
): FulfillmentStatus {
  assertNow(nowMs);
  const created = parseRequired(input.createdAt, "createdAt");
  if (isCancelledInput(input)) {
    cancelledAtMs(input); // validate
    return "cancelled";
  }
  if (input.status !== "paid") return "processing";
  const fromTime = timeIndex(
    input,
    created,
    nowMs,
    deps ?? { estimateDelivery: fallbackEstimateDelivery },
  );
  const persisted =
    input.fulfillmentStatus === undefined ? 0 : sequenceIndex(input.fulfillmentStatus);
  return FULFILLMENT_SEQUENCE[Math.max(fromTime, persisted, 0)] ?? "processing";
}

/**
 * Timestamp a status is, was, or (for a live order) will be reached.
 * null for payment_failed orders, for 'cancelled' on a non-cancelled order
 * (or a cancelled order without cancelledAt), and on cancelled orders for
 * every status scheduled after the cancellation.
 */
export function statusAt(
  input: FulfillmentInput,
  status: FulfillmentStatus,
  deps: FulfillmentDeps,
): IsoDateTimeString | null {
  const created = parseRequired(input.createdAt, "createdAt");
  const cancelMs = cancelledAtMs(input);
  if (input.status !== "paid") return null;
  const cancelled = isCancelledInput(input);
  if (status === "cancelled") {
    return cancelled && cancelMs !== null ? toIso(cancelMs) : null;
  }
  if (status === "processing") return toIso(created);
  if (cancelled) {
    if (cancelMs === null) return null;
    // packed is the cheapest check and avoids calling the estimator.
    if (cancelMs < created + PACKED_OFFSET_MS) return null;
    const at = schedule(input, deps)[status];
    return at <= cancelMs ? toIso(at) : null;
  }
  return toIso(schedule(input, deps)[status]);
}

/**
 * True only while: payment status 'paid', not cancelled, persisted status is
 * absent or 'processing', and max(0, now - createdAt) <= CANCEL_WINDOW_MS
 * (inclusive). The window (30 min) ends before packing (2 h), so the derived
 * status is necessarily 'processing' inside it. Clock skew counts as 0 elapsed.
 */
export function isCancellable(input: FulfillmentInput, nowMs: number): boolean {
  assertNow(nowMs);
  const created = parseRequired(input.createdAt, "createdAt");
  cancelledAtMs(input); // validate: invalid cancelledAt throws TypeError
  if (input.status !== "paid") return false;
  if (isCancelledInput(input)) return false;
  if (input.fulfillmentStatus !== undefined && input.fulfillmentStatus !== "processing") {
    return false;
  }
  const elapsed = Math.max(0, nowMs - created);
  return elapsed <= CANCEL_WINDOW_MS;
}

/** createdAt + CANCEL_WINDOW_MS (the last instant cancellation is allowed). */
export function cancellableUntil(input: FulfillmentInput): IsoDateTimeString {
  return toIso(parseRequired(input.createdAt, "createdAt") + CANCEL_WINDOW_MS);
}

/**
 * Events reached by `nowMs` that are not in `persistedStatuses`, oldest first,
 * each stamped with its scheduled offset (never `now`).
 * - payment_failed: [].
 * - cancelled: steps reached before min(cancelledAt, now), then a 'cancelled'
 *   event at cancelledAt (omitted when cancelledAt is null).
 * - clock skew: [].
 */
export function nextEvents(
  input: FulfillmentInput,
  nowMs: number,
  deps: FulfillmentDeps,
  persistedStatuses: readonly FulfillmentStatus[],
): readonly { status: FulfillmentStatus; at: IsoDateTimeString }[] {
  assertNow(nowMs);
  const created = parseRequired(input.createdAt, "createdAt");
  const cancelMs = cancelledAtMs(input);
  if (input.status !== "paid") return [];
  const persisted = new Set<FulfillmentStatus>(persistedStatuses);
  const cancelled = isCancelledInput(input);

  let horizon = nowMs;
  if (cancelled) horizon = cancelMs === null ? created : Math.min(nowMs, cancelMs);

  const out: { status: FulfillmentStatus; at: IsoDateTimeString; ms: number }[] = [];
  if (horizon >= created) {
    const s: Partial<Record<SequencedStatus, number>> =
      horizon < created + PACKED_OFFSET_MS ? { processing: created } : schedule(input, deps);
    for (const status of FULFILLMENT_SEQUENCE) {
      const at = s[status];
      if (at !== undefined && at <= horizon && !persisted.has(status)) {
        out.push({ status, at: toIso(at), ms: at });
      }
    }
  }
  if (cancelled && cancelMs !== null && !persisted.has("cancelled")) {
    out.push({ status: "cancelled", at: toIso(cancelMs), ms: cancelMs });
  }
  // Stable sort keeps sequence order for equal timestamps.
  out.sort((a, b) => a.ms - b.ms);
  return out.map(({ status, at }) => ({ status, at }));
}

/** The injected estimator's window; null for payment_failed / cancelled. */
export function estimatedDelivery(
  input: FulfillmentInput,
  deps: FulfillmentDeps,
): { start: IsoDateTimeString; end: IsoDateTimeString } | null {
  const created = parseRequired(input.createdAt, "createdAt");
  cancelledAtMs(input); // validate: invalid cancelledAt throws TypeError
  if (input.status !== "paid" || isCancelledInput(input)) return null;
  return runEstimator(input, created, deps);
}
