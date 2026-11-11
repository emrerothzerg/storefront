# `src/app/checkout/_lib`: checkout page helpers

Private folder for `/checkout` (T109 v2, T170 light-only pass). The page (`../page.tsx`) reads the session cookie and the signed-in user (`readSessionId()`, `readCurrentUser()`, both read-only, never set a cookie, SR10), then one `loadCheckoutPageV2` call does every read with one `now`.

| File | What it holds | Tests | Owner |
| --- | --- | --- | --- |
| `load-checkout-page.ts` | `loadCheckoutPageV2(input, deps)` -> `empty` / `blocked` / `ready` (D-T109-1: empty or blocked carts render a 200 state linking to `/cart`, no redirect; addresses are read only for a ready cart), `toSummaryCart`, `toCheckoutSummaryItems`, `toCheckoutFormConfig`, `computeCheckoutArrivals` (= `computeArrivals` from `src/app/_lib/arrivals.ts`), `CHECKOUT_CART_HREF`, `CHECKOUT_EMPTY_TITLE`, `CHECKOUT_BLOCKED_TITLE` | `load-checkout-page.test.ts` | T109 |

## Page states (T170)

- `empty`: a sunken `Card` holding an info `Notice` ("Your cart is empty", `role="status"`) and a primary pill link "Go to your cart" (`/cart`). No form.
- `blocked`: dropped-coupon / shipping notices, then a sunken `Card` holding a warning `Notice` ("Some items are unavailable" + the loader's message, `role="alert"`) and a primary pill link "Review your cart". No form.
- `ready`: the same notices, then `CheckoutForm` v2 (each step a raised Card, T161; from `lg` steps left and the sticky "Review your order" + "Place order" column right, all in one `<form>`, T180) with a fresh `crypto.randomUUID()` idempotency key on every render and `placeOrderV2` as the action.

Metadata stays `noindex`; the page has no product rails or grids, so there is no `now` to forward.
