# server/auth

Accounts: persistence, auth service, guest merge, account lifecycle. Server-only: never import from a `"use client"` module. Later auth tasks (T116 service, T117 merge, T118 lifecycle) append their sections below.

## Files

| File | Task | Contents |
|---|---|---|
| `auth-repository.ts` | T115 | `createAuthRepository(db)`, `AuthRepository`, `UserCredentialRow` (internal), `CreateUserInput`, `CreateAuthSessionInput`, `LoginFailureState`, `isTokenHash`, `DEFAULT_LOCK_THRESHOLD` (10), `DEFAULT_LOCK_MS` (15 min), `DEFAULT_PURGE_OLDER_THAN_MS` (30 days), `MAX_USER_AGENT_LENGTH` (512) |

## auth-repository.ts (T115)

Every SQL statement for `users` and `auth_sessions` lives here (schema: `src/server/db/README.md`, "users / auth_sessions"). Bound parameters only. **No hashing, no cookies, no policy**: password rules, rate limits, the dummy-verify on unknown emails, and deciding what a lock means all belong to the auth service (T116). The module never logs.

Tests: `createDatabase(":memory:")` + `runMigrations(db)` + `createAuthRepository(db)`.

### Conventions

- **Clock.** Every method that writes or compares time takes `now` as epoch ms (default `Date.now()`). Timestamps are written as `new Date(now).toISOString()` (same shape as the schema's `strftime` defaults), so SQL string comparison is chronological. `createAuthSession` re-normalises `expiresAt` through `Date.parse` for the same reason.
- **Ids.** User ids, owner keys and auth-session ids are UUID v4 generated here (`crypto.randomUUID`). Methods given a malformed id do not query: reads return `null` / `[]` / `0`, void writes are no-ops, `Result` methods return `NOT_FOUND`.
- **Emails.** The service trims and lower-cases (AR3). The repository re-applies `trim().toLowerCase()` in `createUser` and `findCredentialsByEmail`, so lookups are case-insensitive against the stored lower-case value and the UNIQUE index catches duplicates in any case. An empty email is rejected (`VALIDATION_FAILED`) / returns `null`. Format and length checks are the service's job.
- **Hash isolation.** `UserCredentialRow` (from `findCredentialsByEmail`) is the only shape with `passwordHash`, `failedLoginCount`, `lockedUntil`. Everything else returns the public `User` (`@/lib/types`, no hash) or `AuthSession`. Token hashes are never returned by any method.
- **Token hashes.** `isTokenHash` = exactly 64 lower-case hex chars (length check before the regex). `findAuthSessionByTokenHash` returns `null` for anything else without touching the DB; `createAuthSession` returns `VALIDATION_FAILED`.

### Methods

| Method | Behaviour | Errors / edge cases |
|---|---|---|
| `createUser({ email, passwordHash, displayName }, now?)` | Inserts with fresh UUID v4 `id` + `owner_key`, `created_at = updated_at = now`. Returns `User`. | `EMAIL_TAKEN` on `users.email` UNIQUE (never throws; nothing is created). Retries up to 3x on an id/owner_key collision. |
| `findCredentialsByEmail(email)` | `UserCredentialRow` or `null`. For the service's sign-in only. | |
| `findUserById(id)` / `findUserByOwnerKey(ownerKey)` | `User` or `null`. | |
| `updateDisplayName(userId, name, now?)` | Sets name + `updated_at`, returns the updated `User`. Stores what it is given (the service cleans it). | `NOT_FOUND` |
| `updatePasswordHash(userId, hash, now?)` | Sets hash + `updated_at`. Does **not** revoke sessions (T118 calls `revokeOthers`). | `NOT_FOUND` |
| `recordLoginFailure(userId, now?, threshold = 10, lockMs = 15 min)` | One atomic `UPDATE … RETURNING`: `failed_login_count + 1`; when the new count >= threshold, `locked_until = now + lockMs`, otherwise `locked_until` is left as it was. Returns `{ failedLoginCount, lockedUntil }`. | Unknown/malformed user: `{ 0, null }`, nothing changes. |
| `resetLoginFailures(userId, now?)` | `failed_login_count = 0`, `locked_until = NULL`, `last_login_at = updated_at = now`. Call on successful sign-in. | |
| `deleteUser(userId)` | Deletes the user row; `auth_sessions` cascade (FK, `PRAGMA foreign_keys = ON` from `createDatabase`). Owner-keyed data is **not** touched (T118 does that first, in its transaction). | `NOT_FOUND` |
| `createAuthSession({ userId, tokenHash, expiresAt, userAgent? }, now?)` | Inserts with `created_at = last_seen_at = now`. `userAgent` is cut to 512 chars; empty/absent stores `NULL`. | `VALIDATION_FAILED` (bad hash, unparseable or non-future `expiresAt`), `NOT_FOUND` (unknown user), `DUPLICATE` (token hash already stored). |
| `findAuthSessionByTokenHash(hash, now?)` | Session only when `revoked_at IS NULL AND expires_at > now` (strict). | `null` for malformed, unknown, revoked, expired. |
| `touchAuthSession(id, now?)` | `last_seen_at = now`, only on unrevoked rows. Throttling (once per 5 min) is the service's job. | |
| `revokeAuthSession(id, now?)` | Sets `revoked_at` if still null; idempotent, keeps the first revocation time. | |
| `revokeAllForUser(userId, now?)` | Revokes every unrevoked session of that user (expired ones included). Returns rows changed. | Other users untouched. |
| `revokeOthers(userId, keepId, now?)` | Same but keeps `keepId`. A `keepId` belonging to another user protects nothing and is itself untouched. | |
| `listActiveSessions(userId, now?)` | Unrevoked, unexpired, `last_seen_at DESC`. | |
| `purgeExpiredSessions(now?, olderThanMs = 30 days)` | Deletes rows revoked before, or expired before, `now - olderThanMs`. Live sessions are never deleted (negative windows clamp to 0). Returns rows deleted. Not scheduled by anyone yet. | |

### Notes for the auth service (T116)

- **Re-lock after expiry.** The counter is not reset when a lock expires. With the default rule, after `locked_until` passes, one more wrong password (count 11 >= 10) locks again for 15 min; a correct password must call `resetLoginFailures`. If T116 wants a fresh 10 attempts after expiry, it must request a repository change (`resetLoginFailures` also stamps `last_login_at`, so it is not the right tool).
- **Concurrency.** bun:sqlite is synchronous, so each call is one statement on one connection; the 20-way test interleaves async callers and asserts counts 1..20 with the lock first appearing at exactly the threshold. Across processes, SQLite's write lock serialises the single UPDATE.
- `AuthSession` now carries `userAgent: string | null` (added by T116); every session read returns it.
- `clearExpiredLock(userId, now?)` (added by T116): `failed_login_count = 0, locked_until = NULL` only when `locked_until <= now`; `last_login_at` untouched; returns whether a row changed.

## account-service.ts / account-repository.ts (T118)

Account lifecycle: display name, password change, account deletion with anonymisation. Rulings R-1, R-6, R-7 (STATE.md).

| File | Contents |
|---|---|
| `account-service.ts` | `createAccountService(deps)`, `getAccountService()`, `AccountService`, `AccountServiceDeps`, `DeletionSummary`; re-exports `DELETED_OWNER_KEY`, `DELETED_MARKER` |
| `account-repository.ts` | `createAccountRepository(db)` (`purgeOwnerData`, `countAuthSessions`, `countOwnedRows`), `OWNER_KEYED_TABLES`, `DELETED_OWNER_KEY` (`00000000-0000-4000-8000-000000000000`), `DELETED_MARKER` (`"[deleted]"`) |
| `account-test-fixture.ts` | Test-only: three-party fixture (users A, B, guest H; one+ row per owner-keyed table), fake T116 deps, `snapshotDatabase`, `discoverOwnerColumns`. Never import from app code |

Deps are injected (`verifyPassword`, `hashPassword`, `validatePassword`, `revokeOthers`), so unit tests use fast fakes. `getAccountService()` wires `getAuthService().verifyPassword`, `argon2idHasher.hash`, `validatePassword` (T116) and `createAuthRepository(db).revokeOthers` over `getDatabase()`, cached on `globalThis`.

### Methods

| Method | Order of checks | Errors |
|---|---|---|
| `updateDisplayName(userId, raw, now?)` | `normalizeDisplayName` (= `cleanText` 1..50, UTF-16 units, plus CONS-B4 bi: other `\p{Cf}` removed, ZWNJ/ZWJ kept between two visible characters) -> `updateDisplayName` | `VALIDATION_FAILED` `details.fields.displayName.code` `REQUIRED` / `TOO_LONG`; `NOT_FOUND` |
| `changePassword(userId, current, next, keepSessionId, now?)` | `keepSessionId` is a UUID (else `UNAUTHENTICATED`, before any verify) -> user exists -> `verifyPassword(current)` -> `validatePassword(next, { email })` -> `next !== current` -> hash -> ONE transaction: `updatePasswordHash` + `revokeOthers(keepSessionId)` | `INVALID_CREDENTIALS` with `details.fields.currentPassword` (counted toward lockout by T116); `VALIDATION_FAILED` `fields.currentPassword` `REQUIRED` (missing current password; T116 does not count it); `ACCOUNT_LOCKED` (`retryAfterSeconds` kept); `VALIDATION_FAILED` `fields.newPassword` (`TOO_SHORT`/`TOO_LONG`/`WEAK`/`REQUIRED` from the policy, or `SAME_AS_CURRENT`); `NOT_FOUND` |
| `deleteAccount(userId, password, now?)` | user exists -> `verifyPassword` -> ONE `withTransaction`: re-read user (concurrent delete -> `NOT_FOUND`), `purgeOwnerData(ownerKey)`, `recomputeProductRating` per affected product, `revokeAllForUser`, `deleteUser` (auth_sessions cascade) | `INVALID_CREDENTIALS` with `details.fields.password`; `ACCOUNT_LOCKED`; `NOT_FOUND`. A database error rolls everything back, is logged as `{ name, code }` only, and is rethrown |

**Display name snapshots.** Reviews, questions and answers store `display_name` at posting time. Renaming the account does not rewrite them; only new posts use the new name.

**Concurrency.** Password change: two concurrent changes are last-writer-wins; each revokes the other's session, so at worst both callers must sign in again. Deletion: two concurrent deletes yield one success and one `NOT_FOUND`. A request that resolved the old owner key before the delete committed and writes afterwards could leave an orphan row under a key that no longer resolves (unreachable; not cleaned up).

### Deletion rules (one transaction)

| Table (owner column) | Rule | Notes |
|---|---|---|
| `carts` (`session_id`), `cart_items` (`cart_session_id`) | Hard delete | Lines deleted explicitly first (exact count) |
| `lists`, `list_items` | Hard delete | Items of the user's lists deleted explicitly first |
| `product_views` | Hard delete | |
| `review_votes`, `question_votes`, `answer_votes` cast by the user | Hard delete | `AFTER DELETE` triggers decrement the target's `helpful_count` by exactly 1. Runs before reviews are deleted |
| `reviews` by the user (any status) | Hard delete | Other shoppers' votes on them are deleted too (`review_votes_cascaded`). Rating triggers adjust products, then `recomputeProductRating` runs per affected product as the safety net |
| `stock_alerts`, `contact_messages`, `addresses` | Hard delete | `contact_messages` rows with other keys or NULL are untouched |
| `questions` by the user | Anonymise (R-7): `session_id = DELETED_OWNER_KEY`, `display_name = body = "[deleted]"` | `status` and `helpful_count` kept, so other shoppers' answers (FK CASCADE) survive |
| `answers` by the user | Anonymise, same as questions | |
| `orders` | Anonymise (R-1, R-6): `session_id = DELETED_OWNER_KEY`; `full_name`, `email`, `line1`, `city`, `region`, `postal_code`, `country` = `"[deleted]"`; `phone`, `line2`, `delivery_note` = NULL | `card_last4`, `payment_ref`, amounts, statuses, coupon, timestamps kept; `order_items` and `order_events` untouched |
| `coupon_redemptions` | Re-key to `DELETED_OWNER_KEY` (kept with the anonymised order) | PK is (coupon_code, session_id), so the tombstone holds ONE redemption per code: `UPDATE OR IGNORE`, and a later deleted account's redemption of the same code is deleted instead (counted in `deletedRows.coupon_redemptions`). `coupons.used_count` never changes |
| `rate_limits` | Untouched | Rows expire through the limiter's purge |
| `auth_sessions` | Revoked, then deleted by the `users` cascade | `deletedRows.auth_sessions` = all of the user's rows (any state) |
| `users` | Hard delete (last) | The same email can sign up again: new `id`, new `owner_key`, no old data |

`OWNER_KEYED_TABLES` lists every table with a `session_id` / `cart_session_id` column; a test compares it with `sqlite_master`, so a future owner-keyed table fails CI until it gets a rule. After deletion, no row in any of them carries the old owner key (property test over the discovered tables).

**Tombstone.** `DELETED_OWNER_KEY` is a valid v4-shaped UUID (`isSessionId` returns true) that no user owns (`findUserByOwnerKey` returns null) and no cookie holds. The session resolver would treat it as a guest id that owns only anonymised orders / Q&A / redemptions; order reads (T55 / order pages) must never return orders keyed to it. `purgeOwnerData` refuses the tombstone itself and malformed keys (`RangeError`, nothing touched).

### DeletionSummary

`{ deletedRows, anonymisedOrders, recomputedProducts, anonymisedQuestions, anonymisedAnswers, rekeyedCouponRedemptions }`. `deletedRows` keys: `carts`, `cart_items`, `lists`, `list_items`, `product_views`, `review_votes`, `question_votes`, `answer_votes`, `review_votes_cascaded`, `reviews`, `stock_alerts`, `contact_messages`, `addresses`, `coupon_redemptions`, `auth_sessions`, `users`. It never carries an owner key or user id. Show only aggregate wording to the user.

### Tests

`account-service.test.ts` (fake T116 deps, three-party fixture: exact counts per table, markers, bystanders unchanged, ratings equal recomputation, helpful counts -1, re-sign-up, tombstone coupon conflict, concurrent delete, injected `RAISE(ABORT)` trigger on each of 19 tables -> full rollback, console spy for secrets) and `account-service.integration.test.ts` (real `createAuthService` + argon2id + `validatePassword`; `getAccountService()` singleton).

## merge-service.ts / merge-repository.ts (T117)

Guest-to-account merge. Called by the sign-in / sign-up actions (T120) after credentials are verified, with the RAW guest cookie id (`readGuestSessionId()`, K-4; never `readSessionId()`, which returns the owner key) and the user's `owner_key`.

| File | Exports |
|---|---|
| `merge-service.ts` | `createMergeService({ db, logger? })`, `getMergeService()` (globalThis singleton over `getDatabase()`), `MergeService`, `MergeSummary`, `MERGE_LIMITS`, `EMPTY_MERGE_SUMMARY`, `DELETED_OWNER_KEY` (local copy of T118's tombstone, same value) |
| `merge-repository.ts` | `createMergeRepository(db)` (one `merge*` step per table family; no transactions, no validation, no logging), `MergeLimits`, `dedupeListName`, `truncateCodePoints`, `addressDedupeKey` |

```ts
mergeGuestIntoUser(guestSessionId: unknown, ownerKey: unknown, now?: number): Result<MergeSummary, AppError>
```

### Guards (nothing changes on any error)

All return `VALIDATION_FAILED` with `details.reason`:

| reason | When |
|---|---|
| `invalid_guest_id` / `invalid_owner_key` | Fails `isSessionId` (canonical lower-case UUID v4) |
| `same_id` | `guestSessionId === ownerKey` |
| `guest_is_owner_key` | The guest id is some user's `owner_key` (K-4 guard via `findUserByOwnerKey`), or the deleted-account tombstone `DELETED_OWNER_KEY` (merging it would hand every deleted account's orders/questions to the caller) |
| `unknown_owner` | `ownerKey` is not any user's `owner_key` |
| `invalid_clock` | `now` is not a finite number |
| `merge_failed` | A database error inside the transaction. Everything is rolled back; `logger.error` gets one line with the SQLite error code only (no ids, emails or row values) |

`details.reason` is for server logic and tests; actions must map every failure to their generic error state and never show it. The two owner-key guards run inside the transaction, so they cannot go stale.

### Transaction

ONE `withTransaction` (sync, `BEGIN IMMEDIATE`) for the guards and every table, in this order: carts, lists, product_views, reviews + questions + answers + votes, stock_alerts, contact_messages, addresses, orders, coupon_redemptions. Any throw rolls back everything (tested by a temp `RAISE(ABORT)` trigger on the last table, and on every written table in turn). Two concurrent merges of the same pair serialise on the write lock; the second finds no guest rows.

**Idempotent.** Every guest row is either moved or deleted, and empty containers (user cart, default wishlist, SFL) are created only when there is something to put in them, so a second call returns `EMPTY_MERGE_SUMMARY` and writes nothing. Timestamps: re-keyed rows keep `created_at`/`updated_at`; `updated_at = now` only where a row's own content changes (merged cart quantity, cart coupon/shipping, renamed or re-defaulted list, address default flag).

### Per-table rules

Caps come from `MERGE_LIMITS` (mirrors BACKLOG-phase2 input limits; other services are not imported). "Dropped" rows are DELETED (ruling R-5), never left under the guest id, and counted in the summary.

| Table | Rule | Summary fields |
|---|---|---|
| `carts` | Never `UPDATE carts.session_id` (K-7). If the guest has a cart: create the user's cart if missing (copying the guest's currency, coupon, shipping); otherwise keep the user's `coupon_code` / `shipping_method_id` and take the guest's only where the user's is NULL. Then `DELETE` the guest cart (items cascade) | |
| `cart_items` | Each guest line upserted into the user's cart: `quantity = min(user + guest, products.stock, DEFAULT_MAX_QUANTITY)` (the cart's per-line cap, 99, imported from `@/lib/validation`). Product row missing, or product unpublished at the merge clock (`published_at` empty or later than `now`; ruling R-CART-1, judged by the cart service's `ProductPublicationLookup.filterPublishedIds` from `src/server/catalog/product-repository.ts`) → dropped `unknown_product` (unknown and unpublished are indistinguishable, as in the cart service); stock 0 → dropped `out_of_stock`. A user line for the same product is left untouched (the cart view marks it unavailable). Wishlist and save-for-later items are NOT filtered (the list and SFL views hide or flag withdrawn products) | `movedCartLines`, `droppedCartLines[]` |
| `lists` (default wishlist) | User has a default: guest default items copied into it, guest default deleted. User has none: guest default re-keyed and stays default (name deduped) | `movedLists` |
| `lists` (save_for_later) | User has one: items copied into it, guest SFL deleted. Else guest SFL re-keyed (unique index `ux_lists_save_for_later` never violated) | `movedLists` |
| `lists` (other wishlists) | Re-keyed oldest first with `is_default = 0`, names deduped case-insensitively by " (2)", " (3)" … (an existing " (n)" suffix is stripped first; the base is truncated so the result is ≤ 60 code points, R-4). Cap 20 wishlists (SFL not counted, same as T37's `countWishlists`); overflow lists deleted with their items. `id`, `share_token`, `is_public` kept | `movedLists`, `droppedLists`, items in `droppedListItems` |
| `list_items` | Copy into a user list newest first: product already on the user's list → the USER's row wins (note, priority, quantity, price) and the guest row is dropped; cap 200 per list. Re-keyed lists are trimmed to 200 (oldest dropped) | `mergedListItems` (copied into existing user lists), `droppedListItems` |
| `product_views` | Upsert into the user, `viewed_at = MAX(user, guest)`; guest rows deleted; user trimmed to the newest 50 (`viewed_at DESC, product_id DESC`, same order as T36). No trim when the guest had no views | `movedViews` (guest rows processed), `droppedViews` (rows trimmed) |
| `reviews` | Guest review on a product the user already reviewed → deleted (rating triggers subtract it; other shoppers' votes on it cascade). Rest re-keyed (no rating trigger fires on `session_id`), so `rating_count/rating_sum` always equal a fresh aggregate. `display_name` unchanged | `movedReviews`, `droppedReviews` |
| `questions`, `answers` | Re-keyed (no UNIQUE) | `movedQuestions`, `movedAnswers` |
| `review_votes`, `question_votes`, `answer_votes` | Guest vote on a target the user already voted on → deleted. Rest re-keyed. Then any vote of the user on a target the user now authors (a guest vote on the user's own review/question/answer, or the user's earlier vote on content the guest wrote) → deleted, because the review and Q&A services forbid self-votes. Every removal is a plain `DELETE`, so the `AFTER DELETE` trigger decrements `helpful_count`, which therefore stays equal to the vote-row count | `droppedVotes` (all three) |
| `stock_alerts` | UNIQUE (product, owner) conflicts deleted; then the newest guest alerts that fit under 20 are re-keyed, older overflow deleted (R-5) | `movedAlerts`, `droppedAlerts` |
| `contact_messages` | Rows with `session_id = guest` re-keyed; NULL-owner rows untouched | `movedMessages` |
| `addresses` | Guest rows processed default-first then newest. Duplicate (NFKC, lower-cased, whitespace-collapsed `full_name` + `line1` + `postal_code` + `country`) of an address the user has → deleted. Cap 10 → overflow deleted. Moved rows get `is_default = 0`; then exactly one default: the user's if present, else the guest's default, else the newest | `movedAddresses`, `droppedAddresses` (duplicates + overflow) |
| `orders` | `orders.session_id` re-keyed (no FK). `order_items` / `order_events` follow by `order_id`, never written | `movedOrders` |
| `coupon_redemptions` | User already redeemed the same code → guest row deleted. Rest re-keyed. `coupons.used_count` never changes | `movedRedemptions`, `droppedRedemptions` |
| `rate_limits`, `users`, `auth_sessions`, `coupons` | Untouched (tested with abort triggers) | |

**Known consequence of R-5.** Deleting a conflicting guest review also deletes other shoppers' helpful votes on that review (FK cascade). Those voters' rows change, which is the only way the merge touches a third party's data.

**Address dedupe vs T40.** The merge key is lower-case + whitespace-collapse (as specified). T40's `duplicateKey` additionally strips punctuation, so "1 Main St." and "1 Main St" are duplicates for T40 but not for the merge.

Tests: `merge-repository.test.ts` (pure helpers, single steps), `merge-service.test.ts` (PLAN A-46..A-66 service cases, three-party fixture G/A/B/H, rollback per table, idempotency, 25 seeded randomised fixtures, singleton). All `:memory:` with `seedDatabase` + `createAuthRepository(db).createUser`.

## T116: auth service and password policy

| File | Contents |
|---|---|
| `password-policy.ts` | `PASSWORD_MIN` (8), `PASSWORD_MAX` (128), `EMAIL_MAX` (254), `DISPLAY_NAME_MAX` (50), `PasswordHasher`, `argon2idHasher`, `validatePassword`, `normalizeEmail`, `normalizeDisplayName`, `emailLimiterKey`, `fieldErrors`, `VALIDATION_MESSAGE`, types `AuthField`, `AuthFieldErrorCode`, `AuthFieldError`, `AuthFieldErrors` |
| `weak-passwords.ts` | `WEAK_PASSWORDS` (lower-case set, about 125 entries incl. `password1990`..`password2026`) |
| `auth-service.ts` | `createAuthService(deps)`, `getAuthService()`, `AuthService`, `AuthServiceDeps`, `IssuedSession`, `ResolvedAuth`, `SignInContext`, `hashToken`, `generateToken`, `isRawToken`, `AUTH_TOKEN_BYTES` (32), `AUTH_SESSION_TTL_MS` (30 d), `TOUCH_INTERVAL_MS` (5 min), `PURGE_EVERY_SIGNINS` (100), `INVALID_CREDENTIALS_MESSAGE` |

### Policy (password-policy.ts)

- `normalizeDisplayName` (CONS-B4 bi): `cleanText` 1..50 after removing every `\p{Cf}` format character except U+200C ZWNJ / U+200D ZWJ (bidi controls, U+061C, U+00AD, U+180E, tag characters, …); a joiner run is kept only between two visible characters (Persian names, emoji such as a family), otherwise deleted. Names without format characters clean exactly as before. Parity with the display cleaner `cleanDisplayName` (`src/lib/display-name.ts`) is pinned in `password-policy.test.ts`: identical output for inputs without C0/C1 controls or Hangul fillers, and a stored name always renders unchanged (the server deletes controls; the display cleaner turns them into spaces).
- Every failure is `VALIDATION_FAILED`, message `"Some fields are invalid."`, `details.fields.<email|password|displayName> = { code, message }`. Codes: `REQUIRED`, `TOO_SHORT`, `TOO_LONG`, `WEAK`, `INVALID`. Messages never echo input. `signUp` merges all field errors into one result.
- **Password**: 8..128 UTF-16 code units (ruling K-10), never trimmed/normalised. `WEAK` = lower-cased value in `WEAK_PASSWORDS`, or equal to the email or its local part (case-insensitive). No composition rules.
- **Email** (ruling R-11): NFC, trim **U+0020 only**, `toLowerCase()`. Rejected: > 254 (raw > 1016 is rejected before NFC), not exactly one `@`, empty local part/domain, any `\p{Cc}`/`\p{Cf}`/`\p{Z}` left (so a trailing `\n`, tab, NBSP, BOM or zero-width space is rejected, not silently trimmed: PLAN A-102). Kelvin sign and NFD forms collide with their NFC lower-case form.
- **Display name**: `cleanText` 1..50.
- `emailLimiterKey(email)` = SHA-256 hex of the normalised email (opaque `auth.signin.email` key; no plaintext email in `rate_limits`).

### Service behaviour

- **Deps**: `{ db, hasher? = argon2idHasher, limiter? = createRateLimiter(db), now? = Date.now, logger? = console }`. Every method takes an optional `now` (or `ctx.now`). The default limiter follows the per-call `ctx.now`; an injected limiter uses its own clock.
- **signUp**: validate all fields (no limiter, no hashing on failure) -> `auth.signup` limiter (5/h per `ctx.sessionKey`, 100/h global) -> `EMAIL_TAKEN` pre-check (no hashing) -> hash -> one transaction { `createUser`, `resetLoginFailures` (stamps `last_login_at`), create session }. EMAIL_TAKEN counts toward the limit (A-12).
- **signIn**: normalise (missing email/password -> `VALIDATION_FAILED`, limiter not touched) -> `auth.signin.session` (sessionKey; null or non-UUID -> shared `"anon"` bucket) -> `auth.signin.email` (counts unknown emails, R-10) -> lookup. Unknown email: one verify against a fixed real argon2id dummy hash (`m=65536,t=2,p=1`, Bun defaults) then `INVALID_CREDENTIALS`. Known: live lock -> `ACCOUNT_LOCKED { retryAfterSeconds }` **without** verifying (also for the right password); expired lock -> `clearExpiredLock` (fresh count); wrong -> `recordLoginFailure` -> `INVALID_CREDENTIALS`, or `ACCOUNT_LOCKED` (900 s) when that failure reaches 10. Success re-reads the row synchronously after the async verify (a concurrent locking failure or password change wins), then `resetLoginFailures`, issues a session, and purges old sessions every 100th success.
- **Uniform lock at the per-email budget (orchestrator ruling on R-10).** When the `auth.signin.email` check of this attempt leaves `remaining === 0` (the 10th attempt on one email inside a 15-min window), any failure (unknown email, wrong password, or reaching/hitting the real lock) returns `ACCOUNT_LOCKED` with `retryAfterSeconds` = seconds left in the limiter's fixed window (same formula as the limiter, 1..900). Unknown and known emails produce byte-identical results at attempts 1-9 (INVALID_CREDENTIALS), 10 (ACCOUNT_LOCKED) and 11+ (RATE_LIMITED). A correct password on that 10th attempt still signs in. Known accounts additionally keep the real `locked_until` (15 min from the 10th consecutive failure), which may outlast the reported `retryAfterSeconds`.
- **Accepted residual leak.** The real lock counts consecutive failures across windows, the limiter does not: attempts spread out (e.g. one per 15-min window, about 2.5 h for 10) lock only real accounts, so a later attempt answers ACCOUNT_LOCKED for a real email and INVALID_CREDENTIALS for an unknown one. Likewise, after the window rolls over, a still-locked real account answers ACCOUNT_LOCKED while an unknown email gets fresh attempts. Accepted by the orchestrator (no unknown-email state is ever stored).
- Passwords longer than 128 at sign-in never match: the verifier still runs once (against the dummy) and, for a known email, the attempt counts as a failure.
- `INVALID_CREDENTIALS` is exactly `{ code, message: "Email or password is incorrect" }` (no details) for unknown email and wrong password; verifier call count is 1 in both.
- **resolveToken**: not a 43-char base64url string -> `null` with no hashing and no query. Otherwise SHA-256 -> lookup -> user (deleted user -> null). Touches `last_seen_at` when `now - lastSeenAt >= 5 min`; expiry is absolute (touch never extends). Wrapped in try/catch: DB failures log a generic line and return `null` (never throws into a render, K-12). Locked accounts still resolve.
- **signOut(token)**: revokes only that session; idempotent; malformed -> no-op, no query. **signOutEverywhere(userId)**: revokes every session incl. the current one (R-2); returns the count.
- **verifyPassword(userId, pw)** (T118): `NOT_FOUND` (unknown/malformed id), `VALIDATION_FAILED` `password: REQUIRED` (empty/non-string), `ACCOUNT_LOCKED` while locked, `INVALID_CREDENTIALS` + counts toward the lock. A correct password does **not** reset the failure counter (the only reset method stamps `last_login_at`).
- **issueSessionFor(userId, ctx)** (T118/T120): new 30-day session; allowed for locked users (lock blocks password sign-in only); `NOT_FOUND` otherwise. It does not revoke anything: callers revoke the old session first.
- **Secrets (AR1)**: the raw token leaves the service only in `IssuedSession.token`. Hasher errors are logged as `auth: password hashing failed (<ErrorName>)` and re-thrown as `Error("Password hashing failed.")` without cause; verify errors count as no-match. Log lines contain only an operation and an error class name.
- **Codes for actions**: `VALIDATION_FAILED`, `EMAIL_TAKEN`, `RATE_LIMITED` (from T31, `details.retryAfterSeconds`), `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` (`details.retryAfterSeconds`), `NOT_FOUND`. Per R-10 the action maps `ACCOUNT_LOCKED` and `RATE_LIMITED` to one `TOO_MANY_ATTEMPTS` state.

Tests: `auth-service.test.ts` (fast salted fake hasher; the real `Bun.password` runs in exactly one test), `password-policy.test.ts`.
