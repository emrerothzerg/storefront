# server/reviews

Product reviews: create, list, summary, helpful votes, "my reviews". This code runs on the server only. Owning task: T34. Consumers: review actions (T46), ReviewsSection / PDP.

| File | Contents |
|---|---|
| `review-service.ts` | `createReviewService({ db, now?, idGenerator? })`, `getReviewService()` (globalThis singleton over `getDatabase()`), `validateReviewInput`, types `ReviewService`, `ReviewSort`, `ReviewListQuery`, `ReviewListResult`, `ReviewView`, `CreateReviewInput`, `ReviewField*`, constants (limits, defaults) |
| `review-repository.ts` | `SqliteReviewRepository`: SQL over `reviews` / `review_votes` / `orders` (verified check). Bound parameters only, no business rules |

All methods are synchronous (bun:sqlite). Server actions wrap them and apply the rate limiter first (SR9: `review.submit`, `review.vote`).

## Owner keys

Every `sessionId` is an **owner key**: the guest `sf_session` id or the signed-in user's `users.owner_key` (SR11). Both are UUID v4. They are checked with `isSessionId` before any SQL. An invalid key gives `INVALID_INPUT` (create, vote), `[]` (listMine), `false` (hasReviewed). An invalid viewer in `list` counts as an anonymous viewer. Owner keys are never returned: `Review`/`ReviewView` have no session field, and the author check for votes and `isOwn` happens in SQL/server code. Never log review text or owner keys.

## create(sessionId, input, now?)

1. Owner key check -> `INVALID_INPUT`.
2. Validates every field and returns all problems together in `details.fields` (`Record<"rating"|"title"|"body"|"displayName", { code, message }>`). Field codes are `REQUIRED`, `INVALID`, `TOO_LONG`, `TOO_MANY_URLS`.
   - `rating`: integer 1-5. A one-digit string such as `"4"` (FormData) is accepted. `4.5`, `"4.0"`, `0`, `6`, booleans and a missing value are rejected.
   - `title` (max 100, single line) and `body` (max 2000, multiline) are required. Both go through `cleanText`, which strips control/invisible characters, collapses whitespace and trims. Empty after cleaning means `REQUIRED`.
   - `displayName` (max 50) is optional. Empty after cleaning becomes `"Anonymous shopper"`. The action passes the account display name for signed-in callers.
   - A body with `countUrls > 2` is spam -> `TOO_MANY_URLS`.
   - Top-level code: `TOO_LONG` when every failing field is too long, otherwise `VALIDATION_FAILED`.
3. Then one `withTransaction` (BEGIN IMMEDIATE) does the following:
   - Unknown product -> `PRODUCT_NOT_FOUND`.
   - `verified_purchase` is computed from the owner key's orders: `status = 'paid' AND fulfillment_status <> 'cancelled'` and containing the product. There is no input for it.
   - Inserts with `ON CONFLICT (product_id, session_id) DO NOTHING`. 0 rows -> `DUPLICATE`, and nothing changes. This is race-safe.
   - Compares the trigger-maintained `products.rating_count/rating_sum` with a fresh aggregate over published reviews. If they differ, it calls `recomputeProductRating` inside the same transaction.
   - An unexpected throw rolls everything back.
4. Text is stored exactly as cleaned. HTML is not touched (`<img src=x onerror=1>` stays literal text). The UI renders it as React text (SR3).

`now` (epoch ms) overrides the clock for `created_at`/`updated_at`. A non-finite value gives `INVALID_INPUT`.

## list(productId, query?, viewerSessionId?)

- Unknown product -> `PRODUCT_NOT_FOUND`. Only `status = 'published'` reviews are listed, counted or summarised.
- `sort`: `helpful` (default, also used for unknown strings) orders by `helpful_count DESC, created_at DESC`. `recent` orders by `created_at DESC`. Ties break on insertion order, newest first.
- `stars` (1-5; other values are ignored) and `verifiedOnly` filter the page and `total`.
- `page` is 1-based (invalid -> 1, capped at 1,000,000). `pageSize` is truncated and clamped to 1..20 (default 10). `pageCount = ceil(total / pageSize)` (0 when nothing matches). A page past the end returns `items: []` and still echoes `page`.
- `summary` is always the unfiltered product summary.
- With a valid viewer key, each item gets `isOwn` and `votedByViewer` booleans. Without one, both fields are omitted.

## summary(productId)

`{ count, avg, histogram }` over published reviews. `avg` is rounded to 1 decimal (`ratingAverage`), and the histogram sums to `count`. Unknown product or no reviews gives zeros.

## voteHelpful(sessionId, reviewId)

Runs in one transaction. Returns:
- `INVALID_INPUT` for a bad owner key.
- `NOT_FOUND` for an unknown or hidden review.
- `FORBIDDEN` when the voter wrote the review.
- `DUPLICATE` for an already-voted review (`INSERT ... ON CONFLICT DO NOTHING`, so concurrent double votes count once).

On success it returns `{ helpfulCount }` (the vote trigger maintains the count).

## listMine(sessionId) / hasReviewed(sessionId, productId)

`listMine` returns all of the owner's reviews, newest first, **including hidden ones** (`status` lets the UI label them). `hasReviewed` counts any status, because `create` would return `DUPLICATE` anyway.

## Tests

`bun test src/server/reviews`: in-memory DB only, plus the seeded catalogue for hidden-review and aggregate checks.
