# Pricing (T38)

Coupons, shipping methods/quotes, order totals and business-day delivery
estimates. Integer cents everywhere, no tax (BACKLOG-phase2 D3). Server-only;
bound SQL parameters only.

## Files

| File | Exports |
|---|---|
| `coupon-service.ts` | `ValidatedCoupon`, `CouponService`, `CouponServiceDeps`, `createCouponService({ db, now? })`, `getCouponService()`, `recordRedemption`, `releaseRedemption`, `releaseRedemptionForOrder`, `describeCoupon`, `COUPON_INVALID_MESSAGE`, `COUPON_DESCRIPTION_CURRENCY` |
| `shipping-service.ts` | `ShippingQuote`, `DeliveryEstimate`, `ShippingService`, `ShippingServiceDeps`, `createShippingService({ db, now? })`, `getShippingService()`, `estimateDelivery`, `quoteFor`, `MAX_DELIVERY_BUSINESS_DAYS` |
| `totals.ts` (pure) | `TotalsInput`, `Totals`, `computeTotals`, helpers `checkCents`, `discountFor`, `shippingPriceFor`, `amountToFreeFor` |

`getXService()` are `globalThis` singletons bound to `getDatabase()` (rebuilt
when the shared DB changes). `now` is an epoch-ms clock; per-call `now`
arguments override it.

## Coupons

`validate(code, subtotalCents, sessionId, now?)`

1. `subtotalCents` not a non-negative integer -> `INVALID_INPUT`; beyond
   `MAX_SAFE_INTEGER` -> `MONEY_OVERFLOW`.
2. `normalizeCouponCode` (trim, upper-case, 1-32 `[A-Za-z0-9_-]`, invisible
   characters rejected). Fails -> `COUPON_INVALID` **without any DB query**.
3. Unknown code, `is_active = 0`, unparseable stored dates -> `COUPON_INVALID`.
   Every `COUPON_INVALID` has the same message (`COUPON_INVALID_MESSAGE`, no details): no enumeration.
4. `now < starts_at` or `now > expires_at` -> `COUPON_EXPIRED` (the exact
   `starts_at` / `expires_at` instants are valid).
5. `used_count >= max_uses` -> `COUPON_EXHAUSTED`.
6. `sessionId` is a valid UUID and already has a redemption -> `COUPON_USED`.
   `null` or a non-UUID string means "no per-session check".
7. `subtotal < min_subtotal_cents` -> `COUPON_MIN_SUBTOTAL`,
   `details: { shortfallCents, minSubtotalCents }`.

Min subtotal is checked last on purpose: it is the only failure the shopper
can fix by adding items, so they never top up a cart only to learn the code
was expired or used.

`description`: `"10% off"`, `"$5.00 off orders of $25.00 or more"`,
`"Free shipping on orders of $20.00 or more"` (USD, single-currency store).

`listPromoted(now?)`: active, `promoted = 1`, inside the date window, not
exhausted; ordered by code. No session check. Returns `PromotedCoupon`
(`ValidatedCoupon` + `minSubtotalCents: number | null` (null when 0) +
`expiresAt: string | null` (ISO UTC via `toISOString()`, null when absent);
T96 additive, `validate` unchanged).

### Redemption protocol (T55 / cancellation)

`recordRedemption(db, code, sessionId, orderId)` runs in its own savepoint
(`withTransaction`, which nests), so call it inside the order transaction
with the transaction's `db`:

1. Normalise code (`COUPON_INVALID`), `isSessionId` (`INVALID_INPUT`),
   orderId non-empty string <= 128 chars (`INVALID_INPUT`).
2. Coupon missing or inactive -> `COUPON_INVALID`.
3. `INSERT ... ON CONFLICT (coupon_code, session_id) DO NOTHING`; 0 changes -> `COUPON_USED`.
4. `UPDATE coupons SET used_count = used_count + 1 WHERE code = ? AND is_active = 1 AND (max_uses IS NULL OR used_count < max_uses)`;
   0 changes -> `COUPON_EXHAUSTED`.

On any error the savepoint is rolled back (nothing written) and a `Result`
error is returned; the caller's other writes are untouched, so the caller
decides whether to abort the order. If the caller's transaction later throws,
the redemption rolls back with it. The conditional UPDATE plus `BEGIN
IMMEDIATE` (writer lock) make the last use race-safe: two sessions that both
passed `validate` get exactly one success and one `COUPON_EXHAUSTED`.

It does not re-check the date window or min subtotal (no clock parameter):
T55 calls `validate` with the same subtotal inside the same transaction first.

`releaseRedemption(db, code, sessionId)`: deletes the session's redemption
and, only if a row was deleted, decrements `used_count` (never below 0).
Idempotent; invalid inputs are a silent no-op.

`releaseRedemptionForOrder(db, code, ownerKey, orderId)`: deletes only the row
recorded for that order (`coupon_code = ? AND session_id = ? AND order_id = ?`)
and decrements `used_count` only when a row was deleted (never below 0). Rows
of another order (e.g. the owner's own redemption kept when a guest merge
dropped the guest's conflicting row, R-5) and legacy rows with NULL `order_id`
are never touched. The order service uses this for cancel and payment failure
(D-T55-1). Idempotent; invalid inputs are a silent no-op.

## Shipping

- `listMethods(subtotal)`: active methods by `sort_order, id`, each as a
  `ShippingQuote`. Throws `RangeError` on an invalid subtotal (programmer error;
  cart subtotals come from `sumCents`).
- `getMethod(id: unknown)`: active only; null for non-strings, empty, > 64
  chars, unknown, inactive.
- `cheapest(subtotal)`: lowest `priceCents`, ties -> first by sort order; null when none.
- `quote(id, subtotal)`: `Result`; unknown/inactive -> `INVALID_INPUT`
  (`details.field = "shippingMethodId"`), invalid subtotal -> `INVALID_INPUT` / `MONEY_OVERFLOW`.
- Free rule: `subtotal >= free_over_cents` -> price 0 (equality counts);
  `amountToFreeCents = max(0, threshold - subtotal)`, null without threshold;
  `isFree = priceCents === 0`.

### `estimateDelivery(method, placedAt, now?)`

UTC calendar, Saturday/Sunday skipped, no holidays. The clock starts on
placedAt's UTC date; a Saturday or Sunday order starts on the following
Monday. `start = base + minDays` business days, `end = base + maxDays`.
Returned as ISO midnight UTC (`"2026-11-09T00:00:00.000Z"`).

| Placed (UTC) | Method | start | end |
|---|---|---|---|
| Wed 2026-11-04 | next_day 1/1 | Thu 11-05 | Thu 11-05 |
| Fri 2026-11-06 23:59 | next_day | Mon 11-09 | Mon 11-09 |
| Sat 2026-11-07 / Sun 11-08 | next_day | Tue 11-10 | Tue 11-10 |
| Fri 2026-11-06 | standard 5/8 | Fri 11-13 | Wed 11-18 |
| Thu 2026-11-05 | express 2/3 | Mon 11-09 | Tue 11-10 |

`placedAt` is an ISO string or epoch ms. Strings without a zone offset
(`"2026-11-06T23:59:00"`, SQLite `"2026-11-06 23:59:00"`) are read as UTC,
so the result never depends on the server `TZ`; `Z`/`+hh:mm` strings and
epoch ms are used as is. Invalid `placedAt` -> `now`; invalid or missing
`now` -> `Date.now()` (deterministic with an injected clock). A start/end
beyond the largest Date (8.64e15 ms, `+275760-09-13T00:00:00.000Z`) is
clamped to it. The function is total except for one documented `RangeError`:
minDays/maxDays not integers in 0..365, or max < min.

## Totals (`computeTotals`, pure, never throws)

- percent: `floor(subtotal * pct / 100)` (BigInt, exact for every safe integer), capped at subtotal.
- fixed: `min(value, subtotal)`.
- free_shipping: discount 0, shipping 0, `amountToFreeShippingCents` 0.
- Shipping is re-derived from `shipping.method` at THIS subtotal (a stale
  quote price is ignored); threshold uses the pre-discount subtotal.
- `total = subtotal - discount + shipping`, never negative.
- `amountToFreeShippingCents`: null with no method or no threshold.
- Errors: malformed input/coupon/method or non-integer amounts ->
  `INVALID_INPUT`; amounts or total beyond `MAX_SAFE_INTEGER` -> `MONEY_OVERFLOW`.
- `computeTotals` does not re-check a coupon's min subtotal; re-`validate`
  whenever the subtotal changes (T45).

## Tests

`bun test src/server/pricing` (all `:memory:`; the two-connection race test
uses a shared-cache in-memory URI). Includes a seeded 1000-case integer
property test for totals.
