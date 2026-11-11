# Fulfilment derivation (T39, mock tracking)

Pure, deterministic functions. No DB, no `Date.now()`, no import from
`src/server/pricing/*`. The order service (T55) persists what these derive
into `order_events`; the UI shows `SIMULATED_TRACKING_NOTICE`
("Tracking is simulated in this demo store.").

- `fulfillment.ts`: constants, `FulfillmentInput`, `DeliveryEstimator`,
  `FulfillmentDeps`, `deriveStatus`, `statusAt`, `isCancellable`,
  `cancellableUntil`, `nextEvents`, `estimatedDelivery`.
- `timeline.ts`: `TimelineStep`, `TIMELINE_LABELS`, `timeline`.

## Offsets table

All times UTC. `C` = `createdAt`. `E` = `deps.estimateDelivery(
{ minDays, maxDays }, C_ms, C_ms )` (placedAt and now are both `createdAt` in
epoch ms, so the result never depends on the wall clock). `method: null` uses
`{ id: "standard", minDays: 5, maxDays: 8 }`.

| Status | Reached at |
|---|---|
| processing ("Order placed") | `C` |
| packed | `C + 2h` |
| shipped | Business days only (ruling O1). Weekday `C`: next-day method (`id === "next_day"` or `maxDays <= 1`) `C + 6h`; others `C + 1 business day` (+24h skipping Sat/Sun, same time of day, so Friday orders ship Monday). Saturday/Sunday `C`: let `M` = the next Monday at `C`'s time of day; next-day `M + 6h`; others `M` (Monday counts as the +1 business day). A weekday next-day order may still ship on a Saturday early morning (e.g. Fri 20:00 -> Sat 02:00) |
| out_for_delivery | `max(D0 - 8h, shipped)` where `D0` = the UTC date of `E.start` at 14:00 (i.e. 06:00 UTC on the delivery date) |
| delivered | `max(D0, out_for_delivery)`; normally exactly `D0` = `E.start`'s date at 14:00 UTC |
| cancelled | `cancelledAt` (input) or the persisted cancelled event |

Because of the clamps the schedule is non-decreasing, so sequence order is
chronological order. Equal timestamps (clamped) resolve to the later status.
Cancel window: `CANCEL_WINDOW_MS` = 30 min, inclusive (`now - C <= 30 min`),
always before `packed`.

## Rules

- Exactly on a boundary = the new status. `now < createdAt` (clock skew) =
  `processing`; elapsed time is clamped to 0, never negative.
- `cancelled` (persisted `fulfillmentStatus === "cancelled"` OR `cancelledAt`
  set) is terminal. `payment_failed` is terminal: `deriveStatus` returns
  `processing`, `timeline`/`nextEvents` return `[]`, `statusAt` and
  `estimatedDelivery` return `null`, `isCancellable` is false.
- `deriveStatus` never regresses below a persisted sequenced
  `fulfillmentStatus` (the DB record wins if it is ahead of the clock).
- `deriveStatus(input, nowMs, deps?)`: `deps` is optional. Without it a
  built-in business-day estimator (`fallbackEstimateDelivery`: start =
  `C + minDays` business days) is used. Always pass the same deps you pass
  to `timeline`/`nextEvents`, otherwise they can disagree.
- `statusAt` is time-independent: for a live order it returns the scheduled
  time even if still in the future; for a cancelled order, `null` for steps
  scheduled after `cancelledAt`.
- `nextEvents` returns events reached by `nowMs` (by `min(nowMs, cancelledAt)`
  for cancelled orders) that are not in `persistedStatuses`, oldest first,
  stamped with their offset (never `now`). Includes `processing` at `C` if not
  persisted. A cancelled order also yields `cancelled` at `cancelledAt`
  (omitted if `cancelledAt` is null: no fabricated timestamps).
- `timeline`: live order = five steps; before current = `complete`, current
  = `current` (a reached `delivered` is `complete`), after = `upcoming` with
  `at: null`. The current step is the later of `deriveStatus` and the
  furthest persisted event. Cancelled = reached/persisted steps (`complete`)
  + a `cancelled` step (`at` = persisted event, else `cancelledAt`, else null).
  Persisted timestamps win over derived ones; unparsable persisted `at`
  values are ignored.
- `estimatedDelivery` = the injected estimator's output (null for
  payment_failed/cancelled). The delivered timestamp's date equals its
  `start` date (criterion 6), except when the estimate start is before the
  shipped time (degenerate estimator), where delivered clamps to shipped.

## Programming errors (throw `TypeError`)

Invalid `createdAt` and invalid non-null `cancelledAt` (all six functions,
checked before anything else, including for payment_failed orders), non-finite `nowMs`, estimator returning an
unparsable `start`/`end`. The estimator is only called once the packed offset
is reached (or by `statusAt`/`estimatedDelivery`/`nextEvents` when needed).
