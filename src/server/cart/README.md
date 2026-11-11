# server/cart

Cart persistence and rules (`cart-repository.ts`, `cart-service.ts`). Server-only: never import from a `"use client"` module. Owning task: T09 (programmer).

## Files

| File | Contents |
|---|---|
| `cart-repository.ts` | `CartRow`, `CartRepository`, `SqliteCartRepository`: thin SQL over `carts` + `cart_items`, bound parameters only, no business rules |
| `cart-service.ts` | `CartService`, `DefaultCartServiceV2`, `createCartService(db?, { now? })`, `getCartService()`, `CartView`, `CartViewV2`, `CartLineView`, `SavedForLaterLine`, `CartTotals`, `CartServiceDeps`, `CartServiceV2Deps`, `couponDroppedNotice`, `SHIPPING_METHOD_DROPPED_NOTICE`, `DEFAULT_CART_CURRENCY`, `UNAVAILABLE_PRODUCT_NAME` |

App code uses `createCartService()` (shared DB). Tests build a `CartService` over `createDatabase(":memory:")` + `runMigrations` + products they insert or `seedProducts`.

## Rules

- **Synchronous.** Every method is sync (bun:sqlite is sync and `withTransaction` needs a sync callback). Server actions wrap them.
- **Sessions.** `getCart`/`getTotals` accept `null`: a null or non-UUID id returns an empty view without touching the DB. Mutations require `isSessionId(sessionId)` (from `@/server/session/session-id`, which has no Next imports), otherwise `INVALID_INPUT`. The repository also guards: reads with a bad id return `[]`, writes throw `TypeError`.
- **Prices are never stored.** Every view joins the stored lines with the current products (`getManyByIds`).
- **Line status** (`getCart`):
  - `unavailable`: product missing from the catalogue, not published at the service clock's `now` (see Publication), or `stock === 0`. `lineTotalCents` is 0. A missing product gets placeholder fields: `name: "Unavailable product"`, `slug: ""`, `imageUrl: ""`, `unitPriceCents: 0`, `availableStock: 0`.
  - `reduced`: `quantity > stock > 0`. The view reports the **stored** quantity, but `lineTotalCents` and `subtotalCents` use `min(quantity, stock)`. The stored row is not changed on read; the shopper (or checkout) fixes it.
  - `ok`: otherwise.
- **Totals.** Integer helpers (`multiplyCents`, `sumCents`); `subtotalCents` sums `lineTotalCents`. `itemCount` is the sum of **stored** quantities over all lines, including unavailable ones. Shipping is not part of the view. `canCheckout` is false when the cart is empty or any line is `unavailable` (reduced lines do not block it; checkout must re-validate stock anyway).
- **Currency.** The view takes the currency of the first resolved product, else `"USD"`. `ensureCart` stores the first product's currency. Mixed-currency carts are not guarded against (the catalogue is single-currency).
- **Overflow.** If a line total or the subtotal would exceed `Number.MAX_SAFE_INTEGER` (only possible with an absurd price), `getCart` and `getTotals` throw `CartTotalOverflowError` (`code: "MONEY_OVERFLOW"`, exported from `cart-service.ts`), because they do not return a `Result`. Callers of those two (order service, pages) should catch it. Mutations build their returned view inside the transaction: on overflow they roll back and return `err({ code: "MONEY_OVERFLOW", message: "This cart total is too large to process." })`. They never throw it.
- **Errors never mutate.** Each mutation runs read-then-write inside one `withTransaction`; an error throws an internal `Abort`, which rolls back and is returned as `Err`.

## Mutations

| Method | Behaviour | Errors |
|---|---|---|
| `addItem(s, productId, qty)` | Adds `qty` to the line (creates it if needed). `existing + qty` may not exceed stock or `maxQuantity`; nothing is silently capped. | `INVALID_INPUT`, `INVALID_QUANTITY` (qty invalid, or `existing + qty > maxQuantity`, `details.reason: "ABOVE_MAX"`), `PRODUCT_NOT_FOUND`, `OUT_OF_STOCK`, `INSUFFICIENT_STOCK` with `details: { productId, available: stock - existing, requested: qty }` |
| `setQuantity(s, productId, qty)` | Sets the line to exactly `qty`. A product not yet in the cart is added (upsert) if it exists. `0` is rejected: delete lines with `removeItem`. | `INVALID_INPUT`, `INVALID_QUANTITY`, `PRODUCT_NOT_FOUND`, `OUT_OF_STOCK`, `INSUFFICIENT_STOCK` with `details: { productId, available: stock, requested: qty }` |
| `removeItem(s, productId)` | Deletes the line. Idempotent: an absent line or unknown product is a success. Works for lines whose product is gone. | `INVALID_INPUT`, `MONEY_OVERFLOW` |
| `clear(s)` | Deletes the cart row (lines cascade). Idempotent. | `INVALID_INPUT` |

All four mutations can also return `MONEY_OVERFLOW` (see Overflow above); `clear` only in theory, since an empty cart cannot overflow.

Quantities are validated as `unknown` (`null`, strings and other values from the wire are `INVALID_QUANTITY`, reason `NOT_A_NUMBER`). Validation order: session, quantity, product exists, stock > 0, stock limit, max limit. Successful mutations return the fresh `CartView`, read inside the same transaction.

`maxQuantity` (per line) defaults to `DEFAULT_MAX_QUANTITY` (99) and can be set through the constructor deps. The constructor throws `TypeError` unless it is a positive safe integer.

## Concurrency

- **In-process:** every call is synchronous, so concurrent server actions on the shared connection run one after another. The stock check and the write in the same transaction cannot be interleaved.
- **Cross-process:** `withTransaction` starts the outermost transaction with `BEGIN IMMEDIATE` (T07), which takes the write lock up front. A second writer waits up to `busy_timeout` (5 s) at `BEGIN`, so two writers cannot both read the old quantity before either writes.
- **Tests:** `Promise.all` of 10 adds on one connection, and on two connections to one file DB.
- **Read paths:** `getCart` and `getTotals` are never wrapped in `withTransaction`, so they take no write lock. When a mutation returns its view, `getCart` runs inside that mutation's transaction, which is already open.

## Deleted products

`cart_items.product_id` references `products(id)` with no delete action, so the DB refuses to delete a product that is in a cart. The "product deleted" path (`getManyByIds` miss) is therefore covered by a unit test that stubs the `ProductRepository`; "out of stock" is covered against the real DB.

## Publication (R-CART-1)

"Published" = `published_at <> '' AND published_at <= now` (ISO 8601 UTC string compare, bound parameter), via `ProductPublicationLookup.filterPublishedIds` (`src/server/catalog/product-repository.ts`; `getById` itself is unfiltered on purpose: order snapshots read withdrawn products). `now` is the service clock (`CartServiceDeps.now`, default `Date.now`; `createCartService(db, { now })` wires it); a non-finite clock value throws `TypeError` (wiring bug, the transaction rolls back). The lookup is injectable (`CartServiceDeps.publication`, default `SqliteProductRepository(db)`).

- **Add paths** (`addItem`, `setQuantity` creating a new line, `moveToCart`; and therefore the `addManyToCart`/`buyNow`/buy-again actions, which call `addItem`): an unpublished or future-published product fails with exactly the unknown-id error `{ code: "PRODUCT_NOT_FOUND", message: "Product not found", details: { productId } }`, checked before stock, so neither existence nor stock leaks.
- **Existing lines** are never deleted. A line whose product is unpublished later reads as `unavailable`: real `name`/`imageUrl`/`unitPriceCents`, `slug: ""` (no dead product link), `availableStock: 0`, `lineTotalCents: 0`, excluded from the subtotal, `canCheckout: false`. `setQuantity` on such an existing line and `removeItem` are not gated.
- **Saved for later (D-T82-4):** an item whose product is unpublished (or vanished) reads as `available: false`, `reason: "unavailable"`, `priceDroppedByCents: null`; an unpublished product keeps its name/image/price but `product.slug` is `""` (no dead product link, parity with cart lines). The list row is never deleted. Otherwise `reason` is null. `SavedForLaterSection` renders such a row as "No longer available" with only a Delete form.
- **Clock (D-T108-3):** `getCartView(s, now)` with a NUMBER judges publication at the service clock and uses the number for the coupon only (order placement passes historical clocks and must not re-judge publication). `getCartView(s, { now })` uses `now` for the whole read (cart lines, saved items, coupon) and never reads the service clock; `{}` or no argument reads the service clock once. A non-finite `options.now` -> `INVALID_INPUT` (`details.field = "now"`), nothing cleared.
- **Cart page (`src/app/cart/_lib/load-cart-page.ts`):** reads the view with `getCartView(s, { now })` (the loader's one `now`). Without a well-formed owner key it never calls the cart service: the empty state gets best sellers from exactly one `bestSellers(CART_RAIL_LIMIT, { now })` read (D-T108-1, catalogue data), with no session read and no cookie mint.

## Cart v2 (T45)

`DefaultCartServiceV2` extends `CartService` (MVP methods inherited) with injected `lists`, `coupons` and `shipping` services bound to the same DB.

| Method | Behaviour |
|---|---|
| `getCartView(s, now? \| { now? })` | Cart + saved items + coupon + shipping + totals. Invalid session -> empty view. Throws only `CartTotalOverflowError`. |
| `saveForLater(s, productId)` | Moves the line into the save-for-later list (`quantityDesired` = line quantity, capped 99). Absent line -> no-op success. One transaction. |
| `moveToCart(s, productId)` | Adds `min(quantityDesired, stock room, max room) >= 1` and removes the saved item; on any error it stays saved. Not saved -> `NOT_FOUND`; unpublished -> `PRODUCT_NOT_FOUND`. |
| `applyCoupon(s, code, now?)` | Validates against the current subtotal and stores the code; on error a previously applied coupon is untouched. |
| `removeCoupon(s)` | Clears the stored coupon. Idempotent. |
| `selectShippingMethod(s, id)` | Active ids only, else `INVALID_INPUT` (`details.field = "shippingMethodId"`). |

- **Coupon on read:** re-validated on every `getCartView`; an invalid stored code is not applied, is cleared with a conditional UPDATE (`clearCouponIf`) and `couponNotice` explains why once.
- **Shipping on read (D-T55-2):** a stored `shipping_method_id` that is no longer active (or no longer exists) is cleared with a conditional UPDATE (`clearShippingMethodIf`, so a concurrent re-selection is never clobbered) and `shippingNotice` is `SHIPPING_METHOD_DROPPED_NOTICE` on that one read (else null). The view then shows the cheapest method, which is what order placement uses when nothing is stored, so view and placement agree. `shippingNotice` is optional in the `CartViewV2` type only so hand-built literals stay valid; `getCartView` always sets it.
- **Empty cart:** `shipping` null, `shippingOptions` [].
- **No billable subtotal (D-T45-1):** shipping (and so the free-shipping progress) is quoted whenever at least one line is available with a billable quantity (`min(quantity, availableStock) > 0`), even when a coupon discounts the amount to 0 or the items are priced 0 (order placement charges shipping then too, so view and order agree). A cart whose every line is unavailable (unpublished, vanished or out of stock) has `shipping` null, `shippingOptions` [], zero totals and `canCheckout` false, like an empty cart. The D-T55-2 clear-and-notice still runs; a still-active stored method is kept.
- **canCheckout** keeps the service rule (no `unavailable` line); the UI may apply the stricter every-line-ok rule.
