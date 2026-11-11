# server/orders

Order placement and lookup (`order-repository.ts`, `order-service.ts`): turns a cart plus guest details and a payment result into a persisted order, and reads it back for the confirmation page. Server-only. Owning task: T11 (programmer).

## Files

| File | Contents |
|---|---|
| `order-repository.ts` | `OrderRepository`, `SqliteOrderRepository(db, { now? })`, `StockLine`, `DuplicateIdempotencyKeyError`. Thin SQL over `orders` + `order_items`, plus `restoreStock` (writes `products`, schema owned by T07). Bound parameters only. |
| `order-service.ts` | `OrderService`, `DefaultOrderServiceV2`, `OrderServiceV2`, `createOrderService(db?, deps?)`, `getOrderService()`, v2 types (see "Orders v2 (T55)"), `getPaymentProvider()`, `PlaceOrderInput`, `StockChangedLine`, `OrderServiceDeps`, `isOrderId`, `isIdempotencyKey`, `MAX_ORDER_IDEMPOTENCY_KEY_LENGTH` |

App code uses `createOrderService()`. It wires the shared DB, the SQLite repositories, `createCartService(db)`, ONE `MockPaymentProvider` cached on `globalThis` (`getPaymentProvider()`, so provider idempotency survives requests and dev HMR) and a process-wide in-flight registry (also on `globalThis`), so duplicate submits that arrive on different requests still share one attempt.

## API

```ts
placeOrder(input: { sessionId: string | null; address: unknown; card: unknown; idempotencyKey: unknown }): Promise<Result<Order>>
getOrder(orderId: unknown, sessionId: string | null): Order | null
```

`getOrder` returns `null` for a malformed id (not a canonical lowercase UUID v4), an unknown id, a null/invalid session, another session's order, or a pending claim (`payment_ref = PENDING_PAYMENT_REF`, see Flow; D-T110-2); callers cannot tell these apart. Only finalized orders (`paid`, or `payment_failed` after the charge settled) are returned.

### `placeOrder` errors

| code | when | `details` |
|---|---|---|
| `INVALID_INPUT` | `idempotencyKey` is not 1–128 printable ASCII chars (or is whitespace only), or the key belongs to another session's order / in-flight attempt | `{ field: "idempotencyKey" }` |
| `EMPTY_CART` | null/invalid session, or the cart has no lines | none |
| `VALIDATION_FAILED` | `validateAddress` and/or `validateCard` failed | `{ fields: { [field]: { code, message } } }`, address and card fields merged flat; never contains card values |
| `STOCK_CHANGED` | any cart line is `unavailable`/`reduced`, or a `decrementStock` fails during reservation | `{ lines: [{ productId, name, requested, available }] }` |
| `MONEY_OVERFLOW` | a line or subtotal exceeds `Number.MAX_SAFE_INTEGER` (including `CartTotalOverflowError` thrown by `getCart`); nothing reserved or charged | none; message "This order total is too large to process." |
| `PAYMENT_FAILED` | provider declined (or threw) | `{ orderId, failureCode }`; `message` is the provider's user-safe text |

Check order, outside any transaction: key, session, stored outcome for the key, cart read (emptiness and total overflow, via a plain `getCart`), then address/card validation. Untrusted input is never validated while the reservation's write lock is held. Then, inside the reservation transaction: key re-check, cart re-read (empty/overflow again, in case it changed), line status, totals, stock decrements, key claim. An empty cart wins over invalid fields.

Every failure that would be returned before the charge (`EMPTY_CART`, `MONEY_OVERFLOW`, `VALIDATION_FAILED`, `STOCK_CHANGED`, and in v2 delivery-note / shipping / coupon errors) first re-reads the key: if another attempt holds it by then, that attempt's outcome is returned instead (D-T71-3).

## Flow (reserve-then-charge)

The schema has no `pending` status (only `paid` / `payment_failed`); a pending order is marked by `payment_ref = PENDING_PAYMENT_REF` ("pending:claim", never a real provider ref) on a `payment_failed` / `PROCESSING_ERROR` row (FIX-checkout-v2, no schema change):

1. Validate (sync, no transaction): key, session, cart emptiness, address, card.
2. Reserve and claim: one sync `withTransaction` (`BEGIN IMMEDIATE`) that re-checks the key (`findByIdempotencyKey` under the write lock; held -> abort and settle as below), re-reads the cart, calls `decrementStock` for every line and then **claims the key** by inserting the order row (+ `order_items`) in the pending state. `UNIQUE(idempotency_key)` makes the claim single-winner. Any failure throws and rolls back every decrement and the claim. No charge, cart untouched.
3. `await payments.charge({ amountCents: subtotal, currency, card, idempotencyKey })`. Amounts come only from the server-side cart view; shipping is 0, total = subtotal.
4. - Success: one transaction finalizes the pending row in place (`status 'paid'`, `payment_ref` = provider ref; compare-and-set on the pending marker) and clears the cart.
   - Failure: one transaction restores the reserved stock and finalizes the row as `payment_failed` with `failure_code`, `payment_ref` NULL. The cart is left as it was.
   - Provider throws: treated as `PROCESSING_ERROR` (same as a failure). The thrown value is not logged or returned.

If the step-4 transaction itself throws, it rolls back; then one transaction withdraws the still-pending claim (deletes the row and its lines) and releases the reservation, so the key is free for the retry the checkout form allows (it keeps the key on `INTERNAL_ERROR`).

While pending, the row is invisible to every reader: `getOrderView` / `listOrders` / buy-again (paid only) and `getOrder` (excludes the pending marker, D-T110-2; so `/orders/[id]` is a 404 while the claim is pending, never the MVP "Payment failed" page). Its id is not handed out until finalize either.

**Crash window:** a process crash between steps 2 and 4 leaves the stock reserved and the pending row in place. Same-key retries then get `INTERNAL_ERROR` after the wait (never a charge); a reload issues a new key. A later fix would be a sweeper for stale pending rows.

## Idempotency (double submit)

- The same key is passed to the provider, which replays its first result.
- In flight: a `Map<key, { sessionId, promise }>` registered synchronously before the first `await` and removed when the attempt settles; concurrent duplicates from the same session share the promise, from another session get `INVALID_INPUT`.
- Afterwards: `findByIdempotencyKey`. Another session: `INVALID_INPUT` at once. Same session, finalized row: `ok(order)` for `paid`, the same `PAYMENT_FAILED` error (`details: { orderId, failureCode }`) for `payment_failed`. Same session, pending row (another connection/process is charging): poll every 10 ms until it is finalized, then replay; still pending after `claimWaitMs` (default `PENDING_CLAIM_WAIT_MS` = 5000, `OrderServiceDeps.claimWaitMs` / `createOrderService(db, { claimWaitMs })`) or withdrawn -> `INTERNAL_ERROR` ("We could not confirm this order yet. Please try again in a moment.", no details). Never a second reservation or charge.
- A retry after a decline needs a NEW key (the old one replays the decline).
- Race that slips past the registry (e.g. two processes, D-T71-2): the claim is taken inside the reservation transaction under the write lock, so the second attempt's in-transaction key check sees it before reserving anything and waits/replays as above (one reservation, one charge). Tests: `order-service-claim.test.ts` (two connections to one file DB, separate providers), QA worker race in `tests/server/phase2/actions-checkout-v2.qa.test.ts`.

## Card data

Only `card_last4` is stored. The validated card (full number, CVC) lives only in memory for the duration of the charge call and is never written, logged or put in a result or error.

## Orders v2 (T55)

Owning task: T55 (programmer). `createOrderService(db?, { now?, payments?, inFlight?, idGenerator? })` now returns `OrderServiceV2` (a `DefaultOrderServiceV2`, which extends the MVP `OrderService` class, so `placeOrder` / `getOrder` and every MVP test are unchanged). `getOrderService()` is the `globalThis` singleton over `getDatabase()` (rebuilt when the shared DB changes). `now` is an epoch-ms clock; per-call `now` arguments override it. Tests: `order-service-v2.test.ts`, `order-repository-v2.test.ts`, `order-service-redemption.test.ts` (D-T55-1), `order-service-phone.test.ts`, `order-service-claim.test.ts` (D-T71-2/3).

`PlaceOrderInputV2.card` is `unknown` (untrusted form input, like MVP `PlaceOrderInput.card`; `validateCard` decides). Optional `PlaceOrderInputV2.phone?: string | null` is validated with `parseOrderPhone`, written to `orders.phone` (NULL when absent/blank) and surfaced as the top-level `OrderView.phone` (omitted when NULL; `Address` has no phone field).

```ts
placeOrderV2(input: PlaceOrderInputV2, now?: number): Promise<Result<OrderView, AppError>>
getOrderView(orderId: string, sessionId: string, now?: number): OrderView | null
listOrders(sessionId: string, query?: ListOrdersQuery, now?: number): OrdersPage
cancelOrder(orderId: string, sessionId: string, now?: number): Result<OrderView, AppError>
getBuyAgainLines(sessionId: string, limit?: number): readonly BuyAgainLine[]
```

Also exported: `parseOrderPhone(raw)` (the address book's phone rule: absent/null/blank -> null; `INVALID_TYPE`, `TOO_LONG` > 20, then the address service's own `validatePhone` / `PHONE_ALLOWED`: `INVALID_CHARACTERS` outside digits/space/`+-()`, `INVALID_LENGTH` < 7 digits; parity test in `order-service-phone.test.ts`), `PENDING_PAYMENT_REF`, `PENDING_CLAIM_WAIT_MS`, `isOwnerKey`, `rangeCutoff(range, nowMs)`, `ORDERS_TABS`, `ORDERS_RANGES`, `DEFAULT_ORDERS_TAB` ("all"), `DEFAULT_ORDERS_RANGE` ("3m"), `ORDERS_PAGE_SIZE` (10), `MAX_DELIVERY_NOTE_LENGTH` (200), `MAX_ORDERS_QUERY_LENGTH` (100), `DEFAULT_BUY_AGAIN_LIMIT` (20), `MAX_BUY_AGAIN_LIMIT` (50), `REFUND_PENDING_NOTE` ("refund_pending").

### Owner keys and R-1

`sessionId` is an owner key (`isSessionId`). The tombstone key `DELETED_OWNER_KEY` (anonymised orders of deleted accounts) is treated as no session by EVERY method, including the MVP `placeOrder` (`EMPTY_CART`) and `getOrder` (`null`), and an order whose `session_id` is the tombstone is never returned, listed, cancelled or offered for buy-again. `OrderView` omits `sessionId` so a view can be passed to client components without leaking the owner key; it also omits `idempotencyKey` (never rendered; consistency (ag), FIX-orders-pages). The key stays on `Order` / `OrderRecord`, where the replay logic reads it.

### `placeOrderV2`

Same front door as `placeOrder` (key check, session check, one shared in-flight registry: a duplicate submit shares one attempt whichever entry point it used), same stored-outcome replay (same key -> same order; a declined key replays `PAYMENT_FAILED` with the same `orderId`; a retry needs a new key).

1. Outside any transaction: stored outcome for the key, plain cart read (`EMPTY_CART`, `MONEY_OVERFLOW`), `validateAddress` + `validateCard` + `parseOrderPhone` (`VALIDATION_FAILED`; all field errors merged in `details.fields`, phone under `fields.phone`), delivery note (`cleanText`, max 200, single line; `TOO_LONG` / `INVALID_INPUT` with `details.field = "deliveryNote"`; absent or blank -> null), shipping id type (`INVALID_INPUT`).
2. ONE sync reservation transaction (`BEGIN IMMEDIATE`): stored cart coupon code read first, `getCartView(sessionId, now)`, line status (`STOCK_CHANGED`), subtotal, coupon re-`validate` against the subtotal (its typed error: `COUPON_INVALID` / `COUPON_EXPIRED` / `COUPON_EXHAUSTED` / `COUPON_USED` / `COUPON_MIN_SUBTOTAL`; the cart view's silent drop of the code is rolled back with the transaction, so the next cart view shows the one-time notice), shipping method (`shippingMethodId` ?? cart selection ?? cheapest; an explicit or stored id that is unknown/inactive -> `INVALID_INPUT` `details.field = "shippingMethodId"`; no active method at all -> the same), `computeTotals` (server-side only; nothing client-supplied is read), stock decrements, `recordRedemption(tx, code, sessionId, orderId)` (savepoint), estimate via `estimateDelivery(method, now, now)`. Any error rolls everything back: nothing reserved, redeemed or charged.
3. `await charge({ amountCents: totals.totalCents, ... })`. A total of 0 (100 % coupon + free shipping) is not sent to the provider (it rejects 0); the order is stored `paid` with `payment_ref` NULL.
4. (The pending claim row with every v2 column below is inserted at the end of step 2, after the redemption, exactly like the MVP claim.) Paid: one transaction finalizes the claimed order (every v2 column: `fulfillment_status 'processing'`, `coupon_code`, `discount_cents`, `shipping_cents`, `shipping_method_id/name`, `estimated_delivery_start/end`, `delivery_note`; lines with `product_slug` / `image_url` snapshots), the `order_events('processing', created_at)` row, and clears the cart (coupon and shipping selection go with it). Declined / provider threw: one transaction restores stock, `releaseRedemptionForOrder` (this reservation's order id), finalizes the row as `payment_failed` (no event). If that transaction throws, the claim is withdrawn and stock and redemption are released in a separate transaction first.

`createdAt` is the call's `now` (also the estimate's placedAt and the fulfilment clock origin). Two sessions racing for a coupon's last use: the first reservation commits its redemption before its charge is awaited, so the second gets `COUPON_EXHAUSTED` (or `COUPON_USED` for the same session) from the in-transaction `validate`, or from `recordRedemption`'s conditional UPDATE when another process slipped in; no order, no charge (24-iteration test, one and two connections).

Cross-process duplicate key with a coupon: the second process's in-transaction key check runs before the coupon re-validation, so it waits for and replays the first order (no `COUPON_USED`, D-T71-2).

### Views and fulfilment events

`getOrderView` returns `null` for malformed/unknown/foreign/tombstone ids and for `payment_failed` orders. Each order gets ONE `FulfillmentDeps` object used for `deriveStatus`, `nextEvents`, `timeline`, `isCancellable`, `estimatedDelivery`: its `estimateDelivery` returns the order's persisted window (immune to later shipping-method edits) and falls back to T38 `estimateDelivery` for pre-v2 rows. The method timing (`id`, `minDays`, `maxDays`) comes from `shipping_methods` by id, inactive rows included; a vanished row -> `{ id, 5, 8 }`; no method (MVP orders) -> T39's default.

Reads persist newly reached events: a read-only pre-check, then (only if needed) a write transaction that re-reads the order, inserts `nextEvents` with `INSERT OR IGNORE` (UNIQUE(order_id, status): at most once per status, stamped with the derived offsets, oldest first) and moves `fulfillment_status` forward with a compare-and-set (`shipped_at` / `delivered_at` filled from the events). The persisted status never regresses, so a read with an earlier clock still shows the later status. `fulfillmentStatus` on views is always derived. `cancellableUntil` is the deadline while `cancellable`, else null.

### `listOrders`

Paid orders of the owner only (never `payment_failed`), newest first (`created_at DESC, rowid DESC`). Hostile params fall back to defaults: `tab` not in `all | not_shipped | cancelled` -> `all`; `range` not in `30d | 3m | 6m | 1y | all` -> `3m`; `page` not a positive integer (numeric strings accepted) -> 1, beyond the last page -> clamped to the last; `query` not a string or failing `cleanText(max 100)` -> ignored. Ranges are inclusive (`created_at >= cutoff`): `30d` = 30 x 24 h, `3m`/`6m`/`1y` = UTC calendar months with the day clamped (May 31 - 3m = Feb 28). `query` is a case-insensitive substring match on the order line NAME snapshots only (not slugs, not current product names). `not_shipped` = derived `processing | packed`; `cancelled` = derived `cancelled`. Page size 10; `pageCount = ceil(total / 10)` (0 when nothing matches, `page` then 1). Views on the returned page persist their events like `getOrderView`.

### `cancelOrder`

`ORDER_NOT_FOUND` for malformed/unknown/foreign/tombstone/`payment_failed`. One transaction: re-read; already cancelled or `!isCancellable` (30 min window inclusive, persisted status must be `processing`) -> `ORDER_NOT_CANCELLABLE`; reached events persisted; compare-and-set `fulfillment_status 'processing' -> 'cancelled'` + `cancelled_at`; `order_events('cancelled', now, note = "refund_pending")`; stock restored for every line (deleted products skipped); `releaseRedemptionForOrder(code, owner, orderId)` when the order had a coupon: only the redemption row recorded for THIS order is deleted and `used_count` is decremented only if it was (D-T55-1). After a guest merge (R-5 drops the guest's conflicting row), cancelling the merged guest order leaves the owner's other order's redemption intact, so re-applying a single-use coupon is still `COUPON_USED`; cancelling the order that owns the row makes the coupon usable again. A second cancel fails before touching stock, so stock is restored exactly once.

**Refund:** the mock payment provider has no refund method, so the refund is recorded ONLY as the note `refund_pending` (`REFUND_PENDING_NOTE`) on the `cancelled` event; `payment_ref` and the provider ledger are untouched. When the provider gains `refund(providerRef, amountCents)`, call it after the cancel transaction commits and update the note.

### `getBuyAgainLines`

Each product once, newest order first, from the owner's paid, non-cancelled orders; `limit` default 20, max 50 (invalid -> 20). `name` / `productSlug` / `imageUrl` come from the newest snapshot (slug/image fall back to the current product for pre-v2 rows). `product` is the current product, or null when deleted or unpublished (`published_at > now`); `available = product !== null && stock > 0`.

### Repository additions (`OrderRepositoryV2`, implemented by `SqliteOrderRepository`)

`insertOrderV2`, `findRecordById` (`OrderRecord`: every column, nullable v2 fields as `null`), `listPaidRecords(sessionId, sinceIso)`, `listEvents`, `insertEventIfAbsent` (`INSERT OR IGNORE`), `advanceFulfillment` (CAS), `markCancelled` (CAS), `findShippingMethodTiming` (inactive included), `getProductAvailability` (ids bound as one JSON array via `json_each(?)`), `listPurchasedLines`. Types: `OrderSnapshotItem`, `NewOrderV2`, `OrderRecord`, `ProductAvailabilityRow`, `PurchasedLineRow`. The MVP `findById` now selects `shipping_cents` instead of hard-coding 0 (MVP rows store 0, so its output is unchanged). Bound parameters only; the only interpolation is the constant `ORDER_COLUMNS` (enforced by `tests/server/orders.qa.test.ts`).
