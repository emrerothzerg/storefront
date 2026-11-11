# app/actions

Cart Server Actions. Owning task: T12 (programmer). Implements the contract in `src/components/molecules/_contracts/cart-actions.ts`.

## Files

| File | Contents |
|---|---|
| `cart.ts` | `'use server'`. Exports only `addToCart`, `updateCartQuantity`, `removeFromCart` (async). Each builds the actions at call time with real deps (`getOrCreateSessionId`, `createCartService()`, `revalidatePath`) and delegates. Importing it opens no DB. |
| `cart-core.ts` | Framework-free logic: `createCartActions(deps)`, `parseProductId`, `parseQuantity`, `toUserSafeError`, `MESSAGES`, `PRODUCT_ID_MAX_LENGTH`, types `CartActionDeps`, `CartActions`. |
| `cart-core.test.ts` | Real `CartService` over in-memory SQLite + seed, fake session, spy `revalidate`. |
| `cart.test.ts` | Wired actions with `next/headers` and `next/cache` mocked (the only file here that uses `mock.module`). |

## Usage

```tsx
"use client";
import { useActionState } from "react";
import { addToCart } from "@/app/actions/cart";
import { CART_FIELD, initialCartActionState } from "@/components/molecules/_contracts/cart-actions";

const [state, formAction, pending] = useActionState(addToCart, initialCartActionState);
<form action={formAction}>
  <input type="hidden" name={CART_FIELD.productId} value={product.id} />
  <input type="number" name={CART_FIELD.quantity} defaultValue={1} min={1} />
  <button disabled={pending}>Add to cart</button>
</form>
```

**Progressive enhancement.** Every action has the `(prevState, formData) => Promise<CartActionState>` signature that `useActionState` binds, so a `<form action={formAction}>` posts and works before hydration / without JavaScript (Next re-renders the page with the returned state). Actions read only the named fields `productId` and `quantity`; every other field is ignored.

## Fields

| Action | Reads | Service call | Success message |
|---|---|---|---|
| `addToCart` | `productId`, `quantity` (to add) | `addItem` | `Added {n} to your cart.` |
| `updateCartQuantity` | `productId`, `quantity` (absolute) | `setQuantity` | `Quantity updated.` |
| `removeFromCart` | `productId` | `removeItem` | `Item removed.` |

- `productId`: string, trimmed, 1..128 chars.
- `quantity`: string matching `/^\d{1,3}$/`, then `Number(...)`; range (1..99) is checked by the service (`validateQuantity`).
- Non-string entries (`File`) or missing fields: `INVALID_INPUT`.
- **Never** read from the client: price, subtotal/total, session id. Prices come from the catalogue, the session from the `sf_session` cookie.

## Behaviour

- Input is parsed first; on a parse failure the action returns `INVALID_INPUT` without touching the session (no cookie minted), the DB or the cache.
- `getSessionId()` is called **at most once** per action (twice in one cookie-less request would mint two ids). The first successful-parse mutation creates the session cookie.
- On success: `revalidatePath("/cart")` and `revalidatePath("/", "layout")` (header cart count), then `ok({ itemCount, subtotalCents, message })`.
- On a service error: the `AppError` is returned with `code` and `details` intact but a user-safe `message`; nothing is revalidated.

| Code | Message |
|---|---|
| `INSUFFICIENT_STOCK` | `Only {available} left in stock.` (`No more of this item is available.` when `available` is 0 or missing) |
| `OUT_OF_STOCK` | `This item is out of stock.` |
| `PRODUCT_NOT_FOUND` | `This product is no longer available.` |
| `INVALID_QUANTITY` | `Please choose a quantity between 1 and {details.max}.` |
| `INVALID_INPUT` (service, e.g. bad session) | `Something was wrong with that request.` |
| `INVALID_INPUT` (bad `quantity` field) | `Please enter a whole number quantity.` |

## Errors and settling

Expected failures never throw. Unexpected exceptions (DB unavailable, `cookies()` failing) are rethrown so Next's nearest `error.tsx` renders. Actions must always settle: React runs actions from one page sequentially, so a hung action blocks every other pending action on the page. Do not add awaits on anything without a bound (network calls etc.) here without a timeout.

## Checkout

Owning task: T13 (programmer). Implements the contract in `src/components/organisms/_contracts/checkout-actions.ts`.

| File | Contents |
|---|---|
| `checkout.ts` | `'use server'`. Exports only `placeOrder(prevState, formData)`. Builds deps at call time: `readSessionId` (never creates a session), `createOrderService()`, `redirect` (`next/navigation`), `revalidatePath`. |
| `checkout-core.ts` | Framework-free: `createCheckoutActions(deps)`, `parseCheckoutForm`, `toRetainedValues`, `toUserSafeCheckoutError`, `CHECKOUT_MESSAGES`, `ADDRESS_FIELDS`, `CARD_FIELDS`, types `CheckoutActionDeps`, `CheckoutActions`, `ParsedCheckoutForm`. |
| `checkout-core.test.ts` | Real `OrderService` over in-memory SQLite + seed, `MOCK_CARDS`, redirect sentinel, revalidate spy. |
| `checkout.test.ts` | Wired action with `next/headers`, `next/navigation` (real exports spread, `redirect` overridden) and `next/cache` mocked. |

```tsx
<CheckoutForm placeOrder={placeOrder} initialIdempotencyKey={crypto.randomUUID()} />
```

### Fields

Reads `idempotencyKey`, the `Address` keys (`fullName`, `email`, `line1`, `line2`, `city`, `region`, `postalCode`, `country`) and the `CardInput` keys (`nameOnCard`, `number`, `expMonth`, `expYear`, `cvc`). Every one must be a string (missing or `File` = `INVALID_INPUT`). All are trimmed except `number` and `cvc`, which go to `validateCard` as posted. A blank key is `INVALID_INPUT`; key format (1-128 printable ASCII) is checked by the order service. Extra fields are ignored; price, totals and session id are never read from the form.

### Behaviour

1. Parse address + card fields. Failure: `{ ok: false, error: INVALID_INPUT }` (no `values`).
2. Parse the key. Failure: `INVALID_INPUT` with `values`.
3. `getSessionId()` once (`null` = no session; the service returns `EMPTY_CART`).
4. `orders.placeOrder({ sessionId, address, card, idempotencyKey })`.
5. Success: `revalidatePath("/cart")`, `revalidatePath("/", "layout")`, then `redirect("/orders/{id}")` (throws, never returns). A replay with the same key redirects to the same order.
6. Service error: `{ ok: false, error, values }` with `code` and `details` intact and a user-safe message. `values` = trimmed address fields + `nameOnCard` only.

| Code | Message |
|---|---|
| `VALIDATION_FAILED` | service message (`Some fields are invalid.`); `details.fields` per field |
| `PAYMENT_FAILED` | provider's shopper-safe message, e.g. `Your card was declined.` |
| `EMPTY_CART` | `Your cart is empty.` |
| `STOCK_CHANGED` | `Some items in your cart are no longer available in the requested quantity.`; `details.lines` |
| `MONEY_OVERFLOW` | `This order total is too large to process.` |
| `INVALID_INPUT` / other | `Something was wrong with that request.` |

A retry after a decline needs a new key (CheckoutForm rotates it after every completed attempt); the old key replays the decline.

**Card data** never appears in `values`, `details`, messages, the redirect URL or logs (the action logs nothing). Expected failures never throw; unexpected exceptions propagate to the error boundary.

### Checkout v2: order contact phone (D-T71-1, FIX-checkout-v2)

`placeOrderV2` (`checkout-v2.ts` over `checkout-core.ts` `localCheckoutProblemsV2`):

- **New-address mode:** a non-blank `phone` is validated with the address book's rules (`parseAddressInput`, same messages; invalid → `fieldErrors.phone`) whether or not "save this address" is ticked, because the phone goes on the order either way. The address `label` is checked only when saving. A blank phone means "no phone" (the order carries none).
- **Saved-address mode:** any posted `phone` is ignored; the order uses the saved address's phone (or none).

## Account hub freshness (consistency ao)

`/account` shows per-section counts (alerts, history) and the back-in-stock strip, so actions that change those rows revalidate it too:

- Stock alerts (`stock-alerts-core.ts`): every successful `subscribeStockAlert` / `unsubscribeStockAlert` / `acknowledgeStockAlert` revalidates `/products/<slug>` (only for a valid slug), then `ACCOUNT_ALERTS_PATH` (`/account/alerts`), then `ACCOUNT_HUB_PATH` (`/account`).
- Browsing history (`views-core.ts`): successful `removeFromHistory` / `clearHistory` revalidate `ACCOUNT_HISTORY_PATH` (`/account/history`), then `ACCOUNT_HUB_PATH` (`/account`). `recordProductView` revalidates nothing.
