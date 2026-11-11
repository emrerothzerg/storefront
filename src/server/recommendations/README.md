# server/recommendations

Recommendations and browsing history (T36). Server-only, synchronous, pure SQL (no ML, no external API; BACKLOG D8). Consumers: view actions (T52), rails (T75), PDP (T97), home (T96), cart (T108).

| File | Contents |
|---|---|
| `recommendation-service.ts` | Public API: `createRecommendationService({ db, now? })`, `getRecommendationService()` (globalThis singleton over `getDatabase()`), constants, `RecoOptions`, `Bundle`, `RecommendationService` |
| `recommendation-repository.ts` | `SqliteRecommendationRepository`: read-only candidate queries returning ranked ids |
| `history-repository.ts` | `SqliteHistoryRepository`: `product_views` upsert / trim / delete / list |

## Constants

| Name | Value | Meaning |
|---|---|---|
| `RECO_DEFAULT_LIMIT` | 12 | default `limit` |
| `RECO_MAX_LIMIT` | 50 | larger limits are capped |
| `FBT_MIN_CO_PURCHASES` | 2 | min paid orders containing both products for a bundle companion |
| `FBT_MAX_COMPANIONS` | 2 | |
| `BOUGHT_LAST_MONTH_MIN_UNITS` | 5 | `boughtLastMonth` returns null below this |
| `BOUGHT_LAST_MONTH_WINDOW_MS` | 30 days | window `[now - 30d, now]`, inclusive |
| `HISTORY_CAP` | 50 | views kept per session |
| `MAX_ID_LENGTH` | 200 | longer product/category ids are rejected before SQL |

## Shared rules (every recommender)

- **Available** = `stock > 0 AND published_at <= now` (`now` = `RecoOptions.now` epoch ms, else the service clock; compared as ISO 8601 UTC strings).
- **Paid** = `orders.status = 'paid' AND fulfillment_status <> 'cancelled'`.
- Output: at most `limit` distinct, available products, never the source product(s). Ties on the score are broken by product id ascending.
- **Fallback chain** (fills up to `limit`): primary candidates -> best sellers in the relevant category (paid units desc, then id; unsold products of the category included with 0 units; a department includes its child categories) -> global best sellers (products with >= 1 paid unit) -> newest (`published_at` desc, then id). So lists are never empty while any available product exists (except the history lists below).
- `limit`: omitted = 12; capped at 50; not a positive safe integer (0, negative, fractional, NaN, Infinity) = `[]`.
- Bad input never throws: unknown/invalid product ids skip the primary step (the chain falls through to global lists); `frequentlyBoughtTogether` and `boughtLastMonth` return `null`.
- `sessionId` is an owner key (UUID v4, `isSessionId`). Invalid ids on reads return `[]` without running SQL; writes return `INVALID_INPUT` without SQL.
- All SQL is bound; id lists are passed as one JSON parameter through `json_each(?)`.

## Methods

| Method | Primary candidates | Fallback category | Notes |
|---|---|---|---|
| `alsoViewed(productId)` | products viewed in the same sessions; score = number of sessions that viewed both | source's category | |
| `alsoBought(productId)` | products in the same paid orders; score = number of such orders | source's category | 3 co-purchases rank above 1 |
| `frequentlyBoughtTogether(productId)` | top 2 products with >= 2 co-purchases (same currency as the main product) | if none qualify: top 2 of `related` | `null` when the main product is unknown, out of stock or unpublished. `items[0]` is the main product; `totalCents` = exact integer sum of current `priceCents`. `limit` is ignored |
| `related(productId)` | same category (tier 0), then same brand in other categories (tier 1); inside a tier by Bayesian rating `(rating_sum + 9) / (rating_count + 3)` desc, then id | source's category | prior: 3 stars weighted as 3 reviews, so one 5-star review does not beat fifty 4.8-star ones |
| `inspiredBy(sessionId)` | unviewed products sharing a category (weight 2 per view) or brand (weight 1 per view) with the session's latest 50 views | categories of the viewed products | viewed products are excluded; no views = global best sellers / newest |
| `forCart(sessionId)` | products co-purchased with any cart item; score = sum over cart items of co-purchase counts | categories of the cart items | cart items excluded; empty cart = global lists |
| `popularInCategory(categoryId)` | (none) | the category (department includes children) | unknown category = global lists |
| `buyAgain(sessionId)` | the session's products from paid orders, each once, latest order first (same order: id) | **no fallback** | only currently available products |
| `recentlyViewed(sessionId)` | the session's views, newest first (equal timestamps: id) | **no fallback** | only currently available products |
| `listHistory(ownerKey, { limit?, now? }?)` | `{ product, viewedAt }[]`: `recentlyViewed` with the ISO `viewedAt` of each view, same availability rule and order | **no fallback** | `limit` defaults to `HISTORY_CAP` (50), capped at `RECO_MAX_LIMIT`; bad limit or owner key -> `[]` (no SQL). Used by `/account/history` and the account hub count (consistency am) |
| `boughtLastMonth(productId, now?)` | paid units in orders created in `[now - 30d, now]` | | `null` below 5 units or for an unknown id |

## History writes

- `recordView(sessionId, productId, now?)`: `INVALID_INPUT` for a non-UUID session or a non-string/empty/over-200-char product id (no SQL); `NOT_FOUND` for an unknown product (nothing written). Otherwise one transaction: `INSERT ... ON CONFLICT (session_id, product_id) DO UPDATE SET viewed_at = excluded.viewed_at`, then delete the session's rows beyond `HISTORY_CAP` (oldest `viewed_at` first; the row just written is always kept). Unpublished/out-of-stock products are recorded (they exist) but are hidden by `recentlyViewed`.
- `removeView(sessionId, productId)`, `clearViews(sessionId)`: silent no-ops for invalid ids.
- Deleting a product cascades its views (FK `ON DELETE CASCADE`).
- Cookie rule (SR10/D10) is the caller's job: the service never touches cookies; call `recordView` from a server action / route handler.

## Performance

`recommendation-service.test.ts` builds the 60-product seed plus 500 synthetic paid orders and 1,800 view upserts and prints cold and warm timings per method; every method stays around 1 ms (bound asserted: 50 ms). Indexes used: `order_items(product_id)`, `order_items` PK, `product_views` PK and `(session_id, viewed_at DESC)`, `(product_id)`, `products(category_id)`.
