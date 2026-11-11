# `src/app/cart/_lib`: cart page helpers

Private folder for `/cart` (T23 MVP, T108 v2, FIX-cart-page, T170 light-only pass). The page (`../page.tsx`) is a thin renderer: the session cookie is read once with `readSessionId()` (read-only, never minted on render), then one `loadCartPageV2` call does every read with one `now`.

| File | What it holds | Tests | Owner |
| --- | --- | --- | --- |
| `load-cart-page.ts` | `loadCartPageV2(sessionId, deps)` (cart view via `getCartView(id, { now })`, list prices, saved-for-later list, also-bought / recently-viewed rails, best sellers for an empty or cookie-less cart from one listing read, D-T108-1), `emptyCartPageData(now)`, `toCartTableDataV2`, `toCartSummaryCart`, re-exported `computeArrivals` (from `src/app/_lib/arrivals.ts`), rail titles, `CART_RAIL_LIMIT`. `CartPageData.now` = the epoch ms the load used | `load-cart-page.test.ts` | T108, FIX-cart-page |
| `cart-page.ts` | MVP `loadCartPage` / `toCartTableData` (explicit field copies so server-only fields never reach client props) | `cart-page.test.ts` | T23 |

## Page layout (T170)

1. `Breadcrumb` (Home > Cart) and the one `h1` "Shopping Cart".
2. Page-level notices: dropped-coupon warning; the shipping notice only when the cart has no lines (otherwise `CartSummary` shows it).
3. Row (stacked, two columns from `lg`): `CartTable` (`hideSummary`, thumbnails, saved-for-later; lines on a raised Card, empty state on a sunken Card, T161) and `CartSummary` (`Card as="aside"`, plain total, `now={data.now}`).
4. Empty cart extras inside the empty state: "View your saved items (N)" as an outline pill link (`min-h-touch`) and the best-sellers rail.
5. Rails: also bought and recently viewed (empty rails render nothing).

One clock: the page builds a single `Date` from `data.now` and passes it to every `ProductRail` (`now`, FIX-card-now) so "New" badges use the loader's clock; `CartSummary` gets the same instant as epoch ms. Tests that read a total use its spoken text (`.sr-only` node, or `textContent` without `[aria-hidden="true"]`), because the superscript visual is aria-hidden.
