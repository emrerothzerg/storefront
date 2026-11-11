# Accounts epic test plan (T114)

Author: qa-engineer, 2026-11-07. Executed by T115-T121 and T123-T128 (implementer tests), T122 (server QA), T129 (UI/pages/journeys QA) and T113 (HTTP smoke criterion 12).
Sources: STATE.md "PHASE 2" (accounts decision 2026-11-07), BACKLOG-phase2.md section 0 (SR1-SR11, input limits, rate limits), section 1 item 17, section 3b (AR1-AR5, T114-T129).

Data model status. Planned against the landed migration 2 DDL in `src/server/db/schema.ts`. `users` and `auth_sessions` are already in the file, so column names below come from the DDL, not from item 17. Differences from item 17 that the plan tests:
- DDL-1: no index on `auth_sessions(expires_at)`. Item 17 asked for it. Expired-session purge (T115) is a full scan. Filed as a minor request to P2-A, not a test blocker.
- DDL-2: `users.email` is `UNIQUE` but has no `CHECK (email = lower(email))`, so only service code enforces case-folding. Test A-71 covers this.
- DDL-3: `auth_sessions.last_seen_at` is `NOT NULL` with no default. T115 must supply it.
- DDL-4: `orders` gained `phone` and `delivery_note` in migration 2. T118 lists only "full_name, email and address fields". This plan treats both as PII to anonymise (ruling R-6).
- DDL-5: the `User` type in `src/lib/types.ts` carries `ownerKey`. Any `User` object that reaches a client prop, returned state or HTML leaks a bearer credential (see risk K-1).

Baseline on 2026-11-07, `bun test` in `storefront/`: 3556 pass, 4 fail, 3560 tests in 138 files. The failures come from in-flight T126/T31 work, not accounts: `isAllowedInternalHref rejects "/account/settings"`, `FAQ_ENTRIES states the decided behaviour`, and two `QA T31-5/T31-6 cleanText` cases. T122 criterion 8 compares against the baseline taken when T122 starts.

Conventions used below
- Identities: `G` = a guest with `sf_session=G` (UUID v4). `A` and `B` = users with `users.owner_key` `KA` and `KB`. `TA` and `TB` = raw `sf_auth` tokens (43 chars base64url). `hash(T)` = 64-char lower-case hex SHA-256.
- "Snapshot(X)" = every row of every table in the owner-keyed list (section 1) where the owner column = X, ordered by primary key. Rows are compared with `toEqual` (full rows, timestamps included, same DB).
- "Counts(X)" = `{ table: COUNT(*) WHERE owner column = X }` over every table in section 1.
- Clock: tests start at `T0 = 1_800_000_000_000` ms. This instant is aligned to 900 s and 3600 s, so fixed limiter windows start at T0. All services and the limiter take the same injected `now`.
- `INVALID_CREDENTIALS` message is `"Email or password is incorrect"` exactly (AR2).
- A case marked "(ruling R-n)" depends on an open decision in section 6. Its expected result is QA's recommendation. If the orchestrator rules differently, the case is updated, not skipped.

---

## 1. Owner-keyed table matrix

Owner column = the column that holds a guest session id or an owner key. Child tables inherit the owner through the FK in parentheses.

Isolation protocol (applies to every row, columns "Read" and "Write"). One `:memory:` DB holds identical fixtures for G, A and B: one row per table each, and for child tables one parent each. Three cookie jars: jar-G (`sf_session=G`), jar-A (`sf_auth=TA`, `sf_session=GA`, where GA is the empty rotated guest), jar-B (`sf_auth=TB`). For each of the 6 ordered pairs (X reads/writes Y's data):
- Read: X's read entry point returns ids that equal X's fixture ids exactly (set equality). None of Y's ids, names, bodies, addresses or emails appear in the JSON-serialised result.
- Write: X's mutating action is called with Y's row id (list id, address id, order id, review id, cart product line, alert id). It returns `NOT_FOUND` / `LIST_NOT_FOUND` / `ORDER_NOT_FOUND` (never `FORBIDDEN`, which would confirm the id exists; ruling R-9). Snapshot(Y) is identical before and after, and so is Counts(Y). The same holds when the form also posts `sessionId=<Y key>`, `ownerKey=<Y key>` or `userId=<Y user id>`.
- Discovery guard (I-00): a test enumerates `sqlite_master` and `pragma_table_info` for every table with a column named `session_id` or `cart_session_id`. It fails if any table is missing from this matrix, so a future migration cannot add an owner-keyed table without a merge/delete rule.

| # | Table (owner column) | Merge rule on sign-in/sign-up (T117) | Deletion rule (T118) | Isolation check (entry points) | Exact assertions |
|---|---|---|---|---|---|
| 1 | `carts` (`session_id` PK) | If the user has no cart, re-key the guest cart row. Otherwise keep the user's row. Coupon/shipping: user's value kept; guest's used only where the user's is NULL. Guest cart row then deleted. | Hard delete | Cart read (header count, `/cart`), `addToCart`/`updateQuantity`/`removeFromCart`, apply coupon, select shipping | After merge: `carts WHERE session_id=G` = 0 and `WHERE session_id=KA` = 1. `coupon_code`: user's if non-NULL, else guest's. After delete: `WHERE session_id=KA` = 0 |
| 2 | `cart_items` (`cart_session_id` -> carts) | Sum quantities per product, cap at `products.stock`. Drop lines with stock 0 and report them in `droppedLines`. No `ON UPDATE CASCADE` exists, so the implementation must insert or upsert into the user's cart and then delete the guest lines (a direct UPDATE of `carts.session_id` violates the FK) | Hard delete (cascade from carts) | Same as carts. Quantity update of a product only in Y's cart from jar X does not touch Y | Guest {A x2, B x1}, user {A x3}, stock A=4 gives exactly rows {(KA,A,4),(KA,B,1)}. `WHERE cart_session_id=G` = 0. Every row has `quantity <= stock` and `> 0` |
| 3 | `lists` (`session_id`) | Guest default wishlist items move into the user's default wishlist; the guest default list row is then deleted. If the user has no default, the guest default is re-keyed and stays default. Other guest wishlists are re-keyed, with names deduped by a " (2)" suffix (" (3)" ...). Guest `save_for_later` items merge into the user's SFL list (unique index `ux_lists_save_for_later` allows one per key), then the guest SFL row is deleted. Cap 20 lists: overflow lists dropped and reported. `share_token` kept on re-keyed lists | Hard delete (items cascade) | Lists page, list detail by id, rename/delete list, add/remove item, move to cart, public share view (only `is_public=1` via token, never by id) | After merge: `lists WHERE session_id=G` = 0. Exactly 1 row `kind='wishlist' AND is_default=1` for KA (0 only if neither side had one). At most 1 `save_for_later` row. List count <= 20. Names unique per KA and <= 60 code points (ruling R-4) |
| 4 | `list_items` (`list_id` -> lists) | PK (list_id, product_id). On conflict the user's row wins entirely (note, priority, quantity_desired, price_at_add_cents). Cap 200 per list; overflow dropped and reported | Hard delete (cascade) | Add/remove/update item on Y's list id from jar X gives `LIST_NOT_FOUND` | Same product in both default lists: 1 row, with the user's `note`/`priority`. Every KA list has <= 200 items. Total = user + guest - conflicts - reported drops |
| 5 | `product_views` (`session_id`) | PK (session_id, product_id). On conflict keep `MAX(viewed_at)`. Then keep only the newest 50 for KA | Hard delete | Recently viewed rail and history page, clear history, remove one view | 30 guest + 30 user distinct rows (60) leave exactly the 50 newest by `viewed_at`. The 10 oldest ids are gone. `WHERE session_id=G` = 0 |
| 6 | `reviews` (`session_id`, UNIQUE(product_id, session_id)) | Re-key unless the user already reviewed the same product. A conflicting guest row is DELETED (amended per ruling R-5) and does not abort the merge; the rating triggers subtract it, so aggregates always equal recomputation | Hard delete. `products.rating_count/rating_sum` adjusted (triggers plus `recomputeProductRating`) | Edit/delete own review from X on Y's review id gives `NOT_FOUND`. The listing shows Y's review publicly (public read is expected); only mutation is isolated | Conflict fixture: `reviews WHERE session_id=KA AND product_id=P` = 1 with the user's body; `WHERE session_id=G` = 0 (deleted, reported in `droppedReviews`; amended per ruling R-5). For every product, `rating_count/rating_sum` equal recomputation after the merge |
| 7 | `review_votes` (`session_id`, PK(review_id, session_id)) | Re-key unless KA already voted on the same review; a conflicting guest vote is DELETED (amended per ruling R-5) and the trigger decrements `helpful_count`, so it keeps equalling the vote-row count | Hard delete. Triggers decrement `helpful_count` on other users' reviews | Vote action from X never creates a vote keyed to Y. Un-vote (if offered) cannot remove Y's vote | `helpful_count` = vote rows for every review after merge (amended per ruling R-5: duplicates removed). After delete: each review that KA voted on has `helpful_count` reduced by exactly 1 |
| 8 | `questions` (`session_id`) | Re-key all (no UNIQUE) | Anonymise (amended per ruling R-7): `session_id = DELETED_OWNER_KEY`, `body = display_name = "[deleted]"`, status/helpful_count kept, so other users' answers survive | Edit/delete question (if offered) on Y's id gives `NOT_FOUND` | After merge: `WHERE session_id=G` = 0. After delete: `WHERE session_id=KA` = 0, KA's former questions carry the markers under the tombstone, other users' answers on them are unchanged (amended per ruling R-7) |
| 9 | `answers` (`session_id`) | Re-key all | Anonymise like questions (amended per ruling R-7) | As for questions | `WHERE session_id=G` = 0 after merge; `KA` = 0 after delete; former rows are `[deleted]` under the tombstone |
| 10 | `question_votes` (`session_id`, PK(question_id, session_id)) | Re-key unless conflict; conflicting guest vote is DELETED (amended per ruling R-5) | Hard delete (triggers decrement) | As for review_votes | `questions.helpful_count` = vote rows after merge (amended per ruling R-5); decremented by exactly KA's votes on delete |
| 11 | `answer_votes` (`session_id`, PK(answer_id, session_id)) | Same as question_votes (conflicts DELETED, amended per ruling R-5) | Hard delete (triggers decrement) | As for review_votes | Same invariant on `answers.helpful_count` |
| 12 | `stock_alerts` (`session_id`, UNIQUE(product_id, session_id)) | Re-key unless conflict; a conflicting guest row is DELETED (amended per ruling R-5). Cap 20 per key: the oldest guest rows beyond 20 are deleted and reported | Hard delete | Alerts list, unsubscribe/acknowledge by id from X on Y's alert gives `NOT_FOUND` | After merge: KA count <= 20; `WHERE session_id=G` = 0 (amended per ruling R-5). After delete: KA = 0 |
| 13 | `contact_messages` (`session_id` NULL allowed) | Re-key rows where `session_id=G`. Rows with NULL owner untouched | Hard delete (rows contain name/email PII) | No read entry point by design. Submitting with a forged `sessionId` stores the caller's key only | After merge: `WHERE session_id=G` = 0. After delete: `WHERE session_id=KA` = 0, and rows with other keys or NULL are unchanged |
| 14 | `addresses` (`session_id`) | Dedupe on normalised (trim, case-fold, collapse whitespace) `full_name`+`line1`+`postal_code`+`country`. Cap 10; guest overflow dropped and reported. Exactly one default, and it is the user's (the guest default becomes the default only if the user has none) | Hard delete | Address book list, edit/delete/set-default by id; checkout prefill reads only own addresses | After merge: KA count <= 10. Exactly 1 `is_default=1` when count >= 1. Duplicates not inserted. `WHERE session_id=G` = 0 (dropped rows are deleted, not left) (ruling R-5) |
| 15 | `orders` (`session_id`) | Re-key all guest orders to KA. `order_items`, `order_events` and totals unchanged | Anonymise, never delete: `full_name`, `email`, `line1`, `city`, `region`, `postal_code`, `country` set to `"[deleted]"`; `line2`, `phone`, `delivery_note` set to NULL or `"[deleted]"` (ruling R-6); `total_cents`, `subtotal_cents`, `discount_cents`, status, timestamps kept. `session_id` rewritten to the constant tombstone `DELETED_OWNER_KEY` = `00000000-0000-4000-8000-000000000000` (amended per ruling R-1); the order service never returns tombstone orders | Order history, order detail by id, cancel, buy again, invoice. All return `ORDER_NOT_FOUND` for another key | After merge: `orders WHERE session_id=G` = 0, KA count = old KA + old G, and `order_items`/`order_events` rows byte-equal. After delete: `orders WHERE session_id=KA` = 0 (ruling R-1), former order ids still exist with markers, `total_cents` equal |
| 16 | `order_items` (`order_id` -> orders) | Untouched (follows order) | Kept unchanged | Reachable only through own order | Row-equal before/after merge and delete |
| 17 | `order_events` (`order_id` -> orders) | Untouched | Kept unchanged | Same | Row-equal before/after |
| 18 | `coupon_redemptions` (`session_id`, PK(coupon_code, session_id)) | Re-key unless KA already redeemed the same code; a conflicting guest row is DELETED (amended per ruling R-5). `coupons.used_count` unchanged | Re-keyed to `DELETED_OWNER_KEY` with `UPDATE OR IGNORE`; a later deleted account's redemption of a code the tombstone already holds is deleted (amended per ruling R-1). `used_count` never changes | Apply coupon from jar X is evaluated against X's redemptions only | After merge: `coupons.used_count` is equal for every code; `WHERE session_id=G` = 0 (amended per ruling R-5). After delete: `WHERE session_id=KA` = 0, the row sits under the tombstone with its `order_id` |
| 19 | `rate_limits` (`key` contains `action:<owner>`) | Untouched (T117) | Untouched; rows expire through the purge | Limiter keys from jar A use KA, never a form value | `SELECT * FROM rate_limits` is identical before and after merge and delete. No key contains `@`, a plaintext email or a password |
| 20 | `users` (`id`, `owner_key`) | Not merged. `owner_key` is never equal to any existing `session_id` value (guard) | Hard delete (last step) | `readCurrentUser()` from jar A returns only A's `{id, displayName, email}` | After delete: `users WHERE id=A.id` = 0 and `WHERE email=A.email` = 0 |
| 21 | `auth_sessions` (`user_id` FK CASCADE) | Not merged. Sign-in/up revokes any pre-existing `sf_auth` session of the jar first | Hard delete (explicit, plus cascade from users) | `resolveToken(TA)` never yields B | After delete: `auth_sessions WHERE user_id=A.id` = 0. B's rows unchanged |
| D | Derived counters: `products.rating_count/rating_sum`, `reviews/questions/answers.helpful_count`, `coupons.used_count` | Unchanged by merge | Rating aggregates and helpful counts recomputed; `used_count` unchanged | n/a | For every product: `rating_count = COUNT(published reviews)` and `rating_sum = SUM(rating)` after merge, after delete, and after 100 randomised fixtures |

Totals: 21 tables (19 owner-keyed incl. children and `rate_limits`, plus `users` and `auth_sessions`) and 1 derived-counter row.

Three-party merge/delete fixture (used by M-* and X-* cases): guest G (merging), user A (target), user B (bystander), and a second guest H (bystander). Each owns one row in every table. After any merge or delete, Snapshot(KB) and Snapshot(H) are identical, `rate_limits` is identical, and B's `auth_sessions` are unchanged.

---

## 2. Cookie state-transition table

Cookie attributes. `sf_auth` is set with `httpOnly: true, sameSite: "lax", path: "/", maxAge: 2592000, secure: NODE_ENV === "production"`. `sf_session` is unchanged from the MVP (same flags, 30 days). "Cleared" means a `set` with `maxAge: 0` (or `expires` in the past) or a `delete`. The cookie-jar mock records both (see section 4).

### 2a. Read-side resolution

`KA` = A's owner key, `G` = guest id, "new" = a freshly minted UUID v4 that is set as `sf_session`. `getOrCreateSessionId` is only ever called from an action context. `requireUser` in page context throws a redirect (`NEXT_REDIRECT` to `/signin?next=<safe current path>`). In action/service context the action returns `UNAUTHENTICATED` instead (AR4).

| ID | Cookies on request | `readSessionId()` | `getOrCreateSessionId()` returns / cookies written | `readCurrentUser()` | `requireUser()` | DB opened? |
|---|---|---|---|---|---|---|
| C-01 | none | `null` | new / `sf_session=new` (exactly 1 set call) | `null` | redirect | no (file not created) |
| C-02 | `sf_session=G` valid | `G` | `G` / none | `null` | redirect | no |
| C-03 | `sf_session` garbage (`"abc"`, upper-case UUID, UUID v1, 37 chars, 4 KB) | `null` | new / `sf_session=new` (replaces garbage) | `null` | redirect | no |
| C-04 | `sf_auth=TA` valid, no `sf_session` (auth only) | `KA` | `KA` / none (no guest cookie minted, T119 AC4) | `{id, displayName, email}` of A, exactly 3 keys | returns A | yes |
| C-05 | `sf_auth=TA` + `sf_session=GA` (both valid) | `KA` (never GA) | `KA` / none | A | A | yes |
| C-06 | `sf_auth` expired (`expires_at <= now`) + `sf_session=G` | `G` | `G` / none (expired `sf_auth` is NOT cleared on read paths; ruling R-8) | `null` | redirect | yes |
| C-07 | `sf_auth` revoked (`revoked_at` set) + `G` | `G` | `G` / none | `null` | redirect | yes |
| C-08 | `sf_auth` garbage: 42 or 44 chars, `+`/`/`/`=` chars, empty string, whitespace-padded 43 chars, `null` text + `G` | `G` | `G` / none | `null` | redirect | no query carrying the raw value (SQL spy); preferably no DB open |
| C-09 | `sf_auth` oversized: 4096 chars, 1 MiB + `G` | `G`, returns in < 50 ms | `G` / none | `null` | redirect | no query |
| C-10 | `sf_auth` unicode: 43 code points of `é`, 43 UTF-16 units including a surrogate pair, a lone surrogate `\uD800`, RTL override `‮`, NUL `\u0000` inside 43 chars + `G` | `G`, never throws | `G` / none | `null` | redirect | no query |
| C-11 | `sf_auth` well-formed (43 b64url) but unknown + `G` | `G` | `G` / none | `null` | redirect | yes: one lookup by `hash(T)` only |
| C-12 | `sf_auth` of a deleted user + `G` | `G` | `G` / none | `null` | redirect | yes |
| C-13 | `sf_auth` of a locked user (`locked_until > now`) + `G` | `KA` (lock blocks only new sign-ins, T116 AC7) | `KA` / none | A | A | yes |
| C-14 | Fixation: attacker-chosen `sf_session=F` (valid UUID v4 the attacker knows), no `sf_auth` | `F` | `F` / none | `null` | redirect | no |
| C-15 | `sf_session=KA` (a user's owner key used as a guest cookie), no `sf_auth` | must NOT be `KA`: `null` (ruling R-1) | must not return `KA`: new / `sf_session=new` | `null` | redirect | ruling R-1 |
| C-16 | `sf_auth` expired, no `sf_session` | `null` | new / `sf_session=new`; `sf_auth` not set | `null` | redirect | yes |
| C-17 | `sf_auth=TA` + `sf_session=KB` (B's owner key) | `KA` | `KA` / none | A | A | yes |
| C-18 | `cookies()` throws an app error (no request scope) | `null` | throws (as today) | `null` | redirect | no |
| C-19 | `cookies()` throws a Next control-flow error (prerender interruption, `NEXT_REDIRECT`) | rethrown (identity) | rethrown | rethrown | rethrown | no |

Invariants for every row:
- No read function ever calls `set` or `delete` on the store. `setCalls.length === 0` after `readSessionId`, `readCurrentUser` and `requireUser` (SR10).
- No `set` call ever carries a user's owner key as a value.
- `readCurrentUser()` never returns `ownerKey`, `passwordHash`, a token or a token hash (keys asserted exactly as `["displayName","email","id"]`).

### 2b. Write-side transitions (actions)

`N` = the rotated guest id written by `rotateGuestSession()`. It is a UUID v4 different from the previous `sf_session`, from every owner key, and from F. "rev(T)" = `auth_sessions.revoked_at` set for `hash(T)`. Every success also calls `revalidatePath("/", "layout")` exactly once (AR5); failures call it 0 times.

| ID | Start state | Event | `sf_auth` after | `sf_session` after | Server-side effects | Redirect / state |
|---|---|---|---|---|---|---|
| W-01 | C-01 none | sign-up success | set to new `TA` (43 chars) | set to `N` | user row, 1 auth session, merge is a no-op (no guest id) | `next` or `/account` |
| W-02 | C-02 guest G with data | sign-up success | set `TA` | set `N` != G | G's rows moved to KA (section 1); Counts(G) all 0 | `next` or `/account` |
| W-03 | C-02 | sign-up failure (any validation, `EMAIL_TAKEN`, `RATE_LIMITED`) | not set | unchanged (no set call) | no user row, no auth session, Snapshot(G) unchanged | state with error, no redirect |
| W-04 | C-02 / C-14 | sign-in success | set new `TB` | set `N` != previous | merge G or F into KB; Counts(G or F) = 0; `last_login_at` set; `failed_login_count=0` | `next` or `/account` |
| W-05 | C-02 | sign-in failure (`INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`, `RATE_LIMITED`) | not set | unchanged. If absent before, at most one set of a fresh UUID (ruling R-3) | no merge, Snapshot(G) unchanged | state with error |
| W-06 | C-05 signed in as A | sign-in as B (or as A again) | rev(TA) first, then set `TB` | set `N` | only GA (the guest cookie) is merged into KB. Counts(KA) unchanged (A's data is never merged into B) | `next` or `/account` |
| W-07 | C-05 signed in as A | sign-up as new user C | rev(TA), set `TC` | set `N` | GA merged into KC. Counts(KA) unchanged | `/account` |
| W-08 | C-05 | sign-out | cleared | set `N` | rev(TA) only; A's other sessions untouched | redirect `/` |
| W-09 | C-02 / C-01 (no `sf_auth`) | sign-out | no set call, or a harmless clear (ruling R-3) | unchanged, or rotated (ruling R-3) | nothing revoked | redirect `/` |
| W-10 | C-05 | sign-out-everywhere | cleared | set `N` | every `auth_sessions` row of A has `revoked_at` set, including the current one (ruling R-2) | redirect `/` |
| W-11 | C-02 (unauthenticated) | sign-out-everywhere | no set call | no set call | nothing | `UNAUTHENTICATED` |
| W-12 | C-05 | password change success | unchanged (no set call; current `TA` stays valid) | unchanged | new hash; every other session of A revoked; current kept (`keepSessionId`) | success state |
| W-13 | C-05 | password change failure | unchanged | unchanged | wrong current password increments `failed_login_count` | field error |
| W-14 | C-05 | delete account success | cleared | set `N` | section 1 delete rules; all A sessions gone; user row gone | redirect `/` |
| W-15 | C-05 | delete failure (wrong password, missing or incorrect `DELETE`) | unchanged | unchanged | nothing deleted; Counts(KA) unchanged | field error |
| W-16 | C-06/07/08/11/12 (invalid `sf_auth`) | update profile / change password / delete / sign-out-everywhere | no set call | no set call | nothing | `UNAUTHENTICATED` |
| W-17 | C-04 auth only | sign-out | cleared | set `N` (a guest cookie is created by the rotation) | rev(TA) | `/` |
| W-18 | C-05 | merge throws during sign-in (injected) | not set | unchanged | no auth session row remains for this attempt (or it is revoked); Snapshot(GA) unchanged | generic error state, no redirect (T120 AC5) |

---

## 3. Adversarial cases

File keys: `svc` = `tests/accounts/services.qa.test.ts`, `ses` = `session.qa.test.ts`, `act` = `actions.qa.test.ts`, `iso` = `isolation.qa.test.ts` (T122). `ui` = `ui.qa.test.tsx`, `pg` = `pages.qa.test.tsx`, `jrn` = `journeys.qa.test.tsx` (T129). `http` = `tests/e2e/http-smoke.ts` criterion 12 (T113).
Unless stated otherwise, a "user" is created through `signUp` with password `"Tr0ub4dor&3-qa"`. A case passes only if every listed assertion holds.

### 3.1 Credential stuffing and rate limits (limiter = T31 `createRateLimiter` with the injected clock)

| ID | Precondition | Step | Expected (assertable) | File |
|---|---|---|---|---|
| A-01 | 20 users U1..U20; one guest session S; clock T0 | 200 `signIn` calls from S, cycling U1..U20 with wrong passwords | Calls 1-10: `INVALID_CREDENTIALS`. Calls 11-200: `RATE_LIMITED` with `details.retryAfterSeconds` in 1..900. Verifier call count = 10. No user has `failed_login_count > 1`. `locked_until` NULL for all | svc, act |
| A-02 | User U; 20 fresh guest sessions S1..S20 | One wrong-password `signIn` per session on U's email | Service: attempts 1-9 `INVALID_CREDENTIALS`, 10 `ACCOUNT_LOCKED`, 11-20 `RATE_LIMITED` (per-email key), verifier not called. Action boundary (amended per ruling R-10): attempts 10-20 all surface `code: "TOO_MANY_ATTEMPTS"`, `error.code: "RATE_LIMITED"` with identical shape. Verifier count = 10. `failed_login_count = 10`. Correct password during the lock rejected; after `locked_until` it succeeds and the next failure starts a fresh count (`clearExpiredLock`) | svc, act |
| A-03 | Unknown email E; 20 sessions | One `signIn` per session on E | 1-9: `INVALID_CREDENTIALS`; 10: `ACCOUNT_LOCKED` (amended per ruling R-10: the attempt that uses up the per-email budget answers identically for unknown emails); 11-20: `RATE_LIMITED`. `users` count 0. No row anywhere stores E in plain text | svc |
| A-04 | Fresh DB | `signIn` from 1001 distinct sessions on 1001 distinct emails within one 900 s window | Call 1001: `RATE_LIMITED` (global key `signin:*`). Verifier count = 1000 | svc |
| A-05 | Clock at T0 + 899 s, 10 attempts used in the window | 11th attempt at T0 + 899 s; 12th at T0 + 900 s | 11th `RATE_LIMITED` with `retryAfterSeconds = 1`. 12th is admitted (new fixed window). Documents the 2x burst across a window boundary (risk K-8) | svc |
| A-06 | Users with emails `Kate@X.com ` and `kate@x.com` typed in varying case and whitespace | 6 attempts as `" KATE@x.com"`, then 5 as `"kate@X.COM"`, from different sessions | 11th is `RATE_LIMITED`: both spellings share one per-email key | svc |
| A-07 | After A-01..A-06 | `SELECT key FROM rate_limits` | Every per-email key matches `/^900:signin\.email:[0-9a-f]{64}$/` (or the implementation's documented prefix + 64 hex). No key contains `@`, an email local part or a password. Keys differ for different emails | svc |
| A-08 | Per-session limit reached for S | 11th call with a valid password | `RATE_LIMITED`; hasher/verifier call count unchanged (no hashing before the limiter); `last_login_at` unchanged; no `sf_auth` set | svc, act |
| A-09 | No `sf_session` cookie at all (cookieless client) | 11 `signIn` attempts on 11 different emails, each from a cookie-less jar | Ruling R-3. Expected: limits are not shared across ALL cookieless clients in one global `anon` bucket of 10; or, if they are, the behaviour is documented and the global 1000 backstop is the real cap. Test asserts the documented choice | svc, act |
| A-10 | Sign-up: one session | 6 valid `signUp` calls with distinct emails | 1-5 succeed; 6th `RATE_LIMITED`, no 6th user row, hasher not called | svc, act |
| A-11 | Sign-up: 101 sessions | 101 sign-ups within one hour | 101st `RATE_LIMITED` (global 100/h) | svc |
| A-12 | Sign-up enumeration | 6 sign-ups with a taken email from one session | 1-5 `EMAIL_TAKEN`; 6th `RATE_LIMITED` (EMAIL_TAKEN is limited too) | svc |
| A-13 | Signed in as A | 6 `changePassword` with wrong current password in 15 min | 1-5 `INVALID_CREDENTIALS` on field `currentPassword`; 6th `RATE_LIMITED`, service not called (spy) | act |
| A-14 | Signed in as A | 6 `deleteAccount` calls in 1 h; 21 `updateProfile` calls in 1 h | 6th delete and 21st update return `RATE_LIMITED`; Counts(KA) unchanged | act |
| A-15 | Limiter DB error (drop `rate_limits` table) | `signIn` | `RATE_LIMITED` (fails closed); verifier not called; the console line names only the action, no email or hash | svc |

### 3.2 Lockout

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| A-16 | User U, permissive limiter injected (to isolate the lock), clock T0 | 9 wrong passwords | Each `INVALID_CREDENTIALS`; `failed_login_count` 1..9; `locked_until` NULL | svc |
| A-17 | After A-16 | 10th wrong password | `ACCOUNT_LOCKED`, `details.retryAfterSeconds = 900`; `locked_until = T0 + 15 min` (ISO) | svc |
| A-18 | Locked (A-17) | Correct password at T0 + 14:59 | `ACCOUNT_LOCKED`, `retryAfterSeconds = 1`; no `sf_auth`, no auth session created, counter not reset | svc, act |
| A-19 | Real limiter. 10 failures at T0 + 890 s (last 10 s of window 1) | Correct password at T0 + 901 s (new limiter window, lock still active) | `ACCOUNT_LOCKED` (not `RATE_LIMITED`, not success) | svc |
| A-20 | Locked | Clock to `locked_until + 1 s`, correct password | Success; `failed_login_count = 0`; `locked_until` NULL; new token | svc |
| A-21 | Locked, clock past lock | 1 wrong password | `INVALID_CREDENTIALS`, counter = 1 (fresh count, not 11 or an immediate re-lock) | svc |
| A-22 | 20-way concurrent wrong passwords (`Promise.all`, async fast hasher) | — | Every call settles. `failed_login_count = 20` (or exactly the number of attempts that reached verification). `locked_until` set. No call returned success | svc |
| A-23 | 9 failures, then concurrent {1 correct, 5 wrong} | — | Final state is consistent: either (success recorded and counter reset, then 5 failures leave counter <= 5) or (locked and no success). Never `failed_login_count > 0` with `last_login_at` updated by an attempt that the lock should have rejected | svc |
| A-24 | Locked user with valid `sf_auth` | `readSessionId()` | `KA` (existing sessions keep working, C-13) | ses |
| A-25 | Account enumeration through the lock (risk K-2) | Same 11 wrong attempts on a real email and on an unknown email, in fresh DBs, same sessions and clock | Amended per ruling R-10: responses 1-9, 10 and 11 are byte-identical in both DBs (service and action level) and the verifier count is equal. Residual cross-window difference (lock outlives the limiter window) accepted and documented by the orchestrator | svc, act |

### 3.3 Unknown email vs wrong password (AR2)

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| A-26 | DB1 has user `kate@x.com`; DB2 has no users; same session id, clock and form | `signIn` action with `kate@x.com` / `"wrong-pass-123"` in both, attempts 1-11 (amended per ruling R-10) | `JSON.stringify(state1) === JSON.stringify(state2)` at every attempt. Both `INVALID_CREDENTIALS` with message `"Email or password is incorrect"`. Cookie `setCalls` deep-equal (both empty of `sf_auth`). `revalidatePath` count equal (0). Redirect: none in both | act |
| A-27 | Same as A-26, service level | `signIn` | Results deep-equal. Verifier called exactly once in each DB. In DB2 the verifier's hash argument starts with `$argon2id$v=19$` and has the same `m=,t=,p=` parameters as a hash produced by `signUp` (real `Bun.password`) | svc |
| A-28 | Same | Thrown errors / console | Neither path logs. Console spy is empty or carries identical lines in both DBs | svc |
| A-29 | HTTP, two fresh jars | POST sign-in (multipart, no JS) with wrong password for an existing account vs an unknown email | Same status code, same `Location` (if any), same body after removing per-request tokens (Next action ids, nonces). Neither response sets `sf_auth` | http |

### 3.4 Session fixation, token theft, replay

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| A-30 | Attacker jar and victim jar both carry `sf_session=F`. Victim adds product P x1 (cart row under F) | Victim signs in as A | Victim jar: `sf_session=N` with `N != F`, `sf_auth` set. `cart_items WHERE cart_session_id=F` = 0; P x1 is in KA's cart. Counts(F) all 0 | act, jrn |
| A-31 | After A-30 | Attacker jar (`sf_session=F`) reads the cart and order history | Empty. No KA rows are returned. `readSessionId()` = F | iso, jrn |
| A-32 | After A-30 | Attacker adds Q under F; victim reads the cart | Victim cart has P only (no second merge, no leak) | jrn |
| A-33 | Jar 1 and attacker jar both hold `TA` (theft) | Attacker reads `readCurrentUser()` | A (theft works before revocation, as expected) | ses |
| A-34 | After A-33 | A runs sign-out-everywhere from jar 1 | Attacker jar: `readCurrentUser()` = null, `readSessionId()` = the attacker's own `sf_session` or null, never KA. All A rows in `auth_sessions` have `revoked_at` set | ses, act, jrn |
| A-35 | Jar 1 (`TA1`) and jar 2 (`TA2`) | `changePassword` from jar 1 | `TA1` still resolves to A; `TA2` resolves to null. Replaying `TA2` in any action returns `UNAUTHENTICATED` | ses, act |
| A-36 | `TA` signed out (W-08) | Replay the old `TA` cookie | Resolves as guest. `signOutEverywhere` with it returns `UNAUTHENTICATED` | act |
| A-37 | `TA` from a deleted user | Replay | null (C-12); actions `UNAUTHENTICATED` | ses, act |
| A-38 | Signed in as A with `sf_session=GA` | Sign in as B | rev(TA) happens before `TB` is issued (A's auth session `revoked_at` set). Counts(KA) unchanged. Only GA rows are merged into KB (W-06) | act |
| A-39 | Signed in as A; GA empty | `getOrCreateSessionId()` from an action | Returns KA; `setCalls` contain no `sf_session` and no value equal to KA | ses |
| A-40 | `sf_session=KA` (owner key as guest), no `sf_auth` (C-15) | Cart read, order history, address book | Ruling R-1. Expected: none of A's rows are returned. Until ruled, the case documents the exposure | ses, iso |
| A-41 | Token length and charset | `resolveToken` with 42/44 chars, `+/=`, unicode, 1 MiB | null. SQL spy shows no statement bound to the raw value. If any lookup runs, it binds a 64-hex digest only | svc |
| A-42 | Expiry boundary | Token at `expires_at - 1 s` and at `expires_at` | First resolves; second null. `expires_at` is unchanged by `touch` (absolute expiry, ruling R-8) | svc |
| A-43 | Touch throttle | `resolveToken` at T, T+60 s, T+301 s | `last_seen_at`: unchanged at T+60 s, updated at T+301 s. Exactly 1 UPDATE per 5 minutes (SQL spy) | svc |
| A-44 | Raw token format | `signUp`, `signIn` x2 | Each token matches `/^[A-Za-z0-9_-]{43}$/`. Two sign-ins give distinct tokens and 2 `auth_sessions` rows. `token_hash` matches `/^[0-9a-f]{64}$/` and equals `sha256hex(token)`. No column anywhere equals the raw token | svc |
| A-45 | Oversized `user-agent` header (8 KiB) on sign-in | — | `auth_sessions.user_agent` length <= the documented cap (recommend 256) or NULL; no error | act |

### 3.5 Merge (T117)

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| A-46 | Guest {A x2, B x1}, user {A x3}, stock A=4, B=10 | merge | KA lines {A x4, B x1}; `droppedLines` empty; G lines = 0 | svc |
| A-47 | Guest line on a stock-0 product | merge | Line dropped; `droppedLines` contains `{productId}`; no row with quantity 0 | svc |
| A-48 | Guest coupon `SAVE10`, user coupon NULL; then user `FREESHIP` and guest `SAVE10` | merge x2 fixtures | First: KA cart `coupon_code='SAVE10'`. Second: `'FREESHIP'` | svc |
| A-49 | Guest review on P, user review on P | merge | User's review kept under KA. Guest row DELETED and counted in `droppedReviews` (amended per ruling R-5). No exception. `products.rating_*` equal recomputation for every product | svc |
| A-50 | Guest and user both voted on review R | merge | 1 vote under KA; guest vote DELETED (amended per ruling R-5); `R.helpful_count` = 1 = vote rows | svc |
| A-51 | Same product in guest and user default wishlists; different notes | merge | 1 `list_items` row; user's note and priority | svc |
| A-52 | User has 19 lists, guest has 3 non-default lists | merge | KA has 20 lists; 2 reported as dropped; their items are not orphaned (cascade deleted or reported) | svc |
| A-53 | User default list holds 195 items, guest default 10 distinct new items | merge | 200 items; 5 reported as dropped | svc |
| A-54 | Guest list named "Gifts", user list named "Gifts"; also guest "Gifts (2)" | merge | Names are unique per KA: "Gifts", "Gifts (2)", "Gifts (3)". A 60-char name with suffix stays <= 60 code points (ruling R-4) | svc |
| A-55 | Both have a save_for_later list | merge | Exactly 1 SFL row for KA; items merged; guest SFL row deleted; no unique-index violation | svc |
| A-56 | 30 + 30 product views, 5 product overlap | merge | 50 rows for KA, the newest 50 by `viewed_at` (overlap uses `MAX(viewed_at)`) | svc |
| A-57 | User has 8 addresses (default D1); guest has 4 (one duplicate of D1 differing in case and whitespace; guest default D9) | merge | KA has 10 addresses (duplicate skipped, 1 reported as dropped by cap); exactly 1 default = D1 | svc |
| A-58 | User has 10 addresses | merge guest with 2 | KA still 10; 2 reported; G addresses = 0 | svc |
| A-59 | Guest has 2 orders | merge | `orders.session_id = KA` for both; `order_items`/`order_events` row-equal; totals equal | svc |
| A-60 | Both redeemed coupon C | merge | KA keeps 1 redemption; guest row DELETED and counted in `droppedRedemptions` (amended per ruling R-5); `coupons.used_count` unchanged | svc |
| A-61 | Guest 25 stock alerts, user 0 (cap 20) | merge | KA <= 20 (ruling R-5); overflow reported | svc |
| A-62 | Atomicity, three-party fixture | For each table in the matrix in turn, install `CREATE TEMP TRIGGER qa_fail BEFORE INSERT/UPDATE/DELETE ON <table> BEGIN SELECT RAISE(ABORT,'qa-injected'); END` and merge | The merge returns an error (or throws, then the action maps it to a generic error). The full-DB snapshot (all tables) is identical before and after. Repeat for every table so that "the last table" is covered whatever the implementation order | svc |
| A-63 | Idempotency | merge(G, KA) twice | Second call: no row changes (full-DB snapshot equal after call 1 and call 2); summary reports 0 moved | svc |
| A-64 | Guards | merge(G, G); merge("not-a-uuid", KA); merge(G, "x"); merge(KB, KA) where KB is B's owner key | Each returns `VALIDATION_FAILED` or a documented no-op; full-DB snapshot unchanged; B's data never moves to A | svc |
| A-65 | Three-party fixture | merge(G, KA) | Snapshot(KB), Snapshot(H) and `rate_limits` identical | svc, iso |
| A-66 | 100 randomised fixtures (seeded PRNG, seed printed on failure) | merge each | Invariants: (a) no duplicate PK/UNIQUE; (b) every guest row is moved or deleted and counted in a drop report; nothing remains under G (amended per ruling R-5); (c) cart qty <= stock; (d) lists <= 20, items <= 200, addresses <= 10 with one default, views <= 50, alerts <= 20; (e) rating and helpful aggregates equal recomputation; (f) the second merge is a no-op | svc |
| A-67 | Merge fails inside sign-in action (A-62 trigger) | `signIn` | Generic error state; `sf_auth` NOT set; `sf_session` unchanged; no live auth session for this attempt (W-18) | act |
| A-68 | Merge must read the raw guest cookie, not `readSessionId()` | Signed in as A (`sf_session=GA`), sign in as B | KA rows are untouched (if the implementation used `readSessionId()`, A's entire account would merge into B) | act |
| A-69 | Two concurrent sign-ins from the same guest jar to the same user | `Promise.all([signIn, signIn])` | Both settle. Final Counts(KA) are equal to a single merge (idempotent, serialised by `BEGIN IMMEDIATE`). 2 auth sessions, or the first revoked | act |

### 3.6 Account lifecycle and deletion (T118)

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| A-70 | A with one row per table (three-party fixture) | `deleteAccount(A, wrongPassword)` | `INVALID_CREDENTIALS`; full-DB snapshot unchanged except `failed_login_count` + 1 | svc |
| A-71 | Same | `deleteAccount(A, correct)` | Counts(KA) = 0 for every table in section 1 (orders included, ruling R-1). Former orders: `full_name/email/line1/city/region/postal_code/country = "[deleted]"`, `phone/delivery_note/line2` NULL or `"[deleted]"`, `total_cents` and `created_at` equal, `order_items`/`order_events` row-equal. `users` and `auth_sessions` for A = 0. B and H unchanged | svc |
| A-72 | Same, with a trigger on each table in turn (as A-62) | delete | Full rollback; snapshot identical | svc |
| A-73 | A reviewed P (rating 5) and voted on B's review R | delete | `P.rating_count -1`, `rating_sum -5`, equal to recomputation; `R.helpful_count -1` | svc |
| A-74 | A asked question Q; B answered Q | delete | Amended per ruling R-7: Q is anonymised (`body`/`display_name` = `[deleted]`, `session_id` = tombstone, status kept); B's answer survives unchanged; A's own answers are anonymised the same way | svc |
| A-75 | After A-71 | Old `TA` | `resolveToken` null; `readCurrentUser` null; actions `UNAUTHENTICATED` | svc, ses |
| A-76 | After A-71 | `signUp` with the same email (different case) | Success. New `users.id != old`, `owner_key != old KA`. Counts(new key) = 0 in every table; order history empty; old anonymised orders unreachable from the new jar | svc, act, jrn |
| A-77 | `changePassword` | new == current; new = `"password"`; new of 7 code points; wrong current | `VALIDATION_FAILED` on `newPassword` (first three); `INVALID_CREDENTIALS` on `currentPassword` with counter + 1 (fourth) | svc, act |
| A-78 | `changePassword` success, jars 1 and 2 | — | Hash changed (still `$argon2id$`); old password fails; new succeeds; jar 2 revoked; jar 1 valid | svc, act |
| A-79 | `updateDisplayName` | `""`, `"   "`, 51 ASCII, 26 astral (52 UTF-16 units), 25 astral (50 units), `"<img src=x onerror=alert(1)>"` | Amended per ruling K-10 (lengths in UTF-16 units): `""`, blank, 51 and 26-astral give `VALIDATION_FAILED` on `displayName`. The 25-astral name is accepted. The hostile string is stored as text (cleaned whitespace only). Existing review `display_name` snapshots unchanged | svc, act |
| A-80 | `deleteAccount` action | confirm `"delete"`, `" DELETE"`, missing; password missing | Error on the right field; Counts(KA) unchanged | act |
| A-81 | `deleteAccount` success, then the same form submitted again | — | Second call returns `UNAUTHENTICATED`; no exception | act |

### 3.7 Open redirect via `next`

Hostile set N-H: `//evil.com`, `https://evil.com`, `http:/evil.com`, `///evil.com`, `/\evil.com`, `\\evil.com`, `/\t/evil.com` (tab), `/\n/evil.com`, ` //evil.com` (leading space), `javascript:alert(1)`, `JaVaScRiPt:alert(1)`, `data:text/html,x`, `%2F%2Fevil.com`, `/%2F/evil.com` (amended per the safe-next ruling: rejected, returns `/account`, as T119's helper decodes once and refuses a `//` result), `evil.com`, empty string, a 4 KiB path. Safe set N-S: `/orders`, `/orders?page=2`, `/account/settings`, `/products/canvas-tote-bag#reviews`.

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| A-82 | safe-next helper | Apply to every N-H and N-S value | N-H returns `/account`; N-S returns unchanged. Output never matches `/^\/[\/\\]/`, contains no ASCII control chars, has no scheme | ses |
| A-83 | `signIn`/`signUp` success | `next` from N-H, then N-S | Redirect target is `/account` for N-H and the value for N-S | act |
| A-84 | `requireUser()` from a page whose path is hostile (`//evil.com` as current path) | — | Redirect URL is `/signin?next=` + `encodeURIComponent(safe)`; decoded `next` passes A-82 | ses |
| A-85 | `/signin?next=<N-H>` and `/signup?next=<N-H>` render | — | Hidden `next` input value is `/account` (or empty); no `href` attribute anywhere contains `evil` or `javascript:` | pg |
| A-86 | Signed-in visit to `/signin?next=<N-H>` | — | Redirects to `/account` | pg |
| A-87 | HTTP | GET `/signin?next=//evil.com` signed in; POST sign-in with `next=//evil.com` | `Location` header is `/account` (relative or same origin) | http |

### 3.8 Secret leakage (AR1)

Secret set S: every raw password used in the run, every stored `password_hash` (read from the DB after the fact), every raw token, every `token_hash`, plus the literal `$argon2`. Owner keys are tracked as a separate set (O) for HTML, client props, URLs and cookies other than in DB/limiter contexts.

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| A-88 | Console spy on `log/info/warn/error/debug` for the whole file | Run all svc/act cases | No captured line contains any member of S | svc, act |
| A-89 | Every returned Result/state | `JSON.stringify` | Contains no member of S; contains no member of O (except `readSessionId` return values, which are server-only) | svc, act |
| A-90 | Every thrown error (forced: closed DB, injected trigger) | `String(e)`, `e.message`, `e.stack` | No member of S | svc |
| A-91 | Cookie `setCalls` | values and options | `sf_auth` value is the raw token only. No cookie carries a password, hash, token hash or owner key | act |
| A-92 | Redirect URLs | — | No password, email or token in any redirect URL | act |
| A-93 | Rendered HTML of `/signin`, `/signup`, `/account`, `/account/settings`, header, PDP with a review by a signed-in user; `generateMetadata` output; JSON-LD | Render with a signed-in user | No member of S or O. The email appears only on `/account/settings` and the hub (if designed) | pg, ui |
| A-94 | Server-component props passed to client components (forms) | Inspect props via the render tree / serialized RSC payload | No `passwordHash`, `ownerKey`, token. The `User` type is never passed whole | pg |
| A-95 | `UserRecord` public shape | Type test: `expectTypeOf`/`@ts-expect-error`-free assignment check that `password_hash`/`passwordHash` is not a key | Passes; implementation-free check via `Object.keys(await repo.findById())` | svc |
| A-96 | HTTP server log | grep the captured stdout/stderr for S | 0 matches | http |

### 3.9 Forged form fields

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| A-97 | Jar A | `updateProfile` with `userId=B.id`, `ownerKey=KB`, `sessionId=KB`, `role=admin`, `verified=1`, `email=b@x.com` | Only A's display name changes. B's user row is byte-equal. A's email unchanged. `users` has no `role`/`verified` column (schema assertion). The state equals the state of the same call without the extra fields | act |
| A-98 | Guest jar | `signUp` with the extra fields above | The created user has a fresh `owner_key` != KB and != G; the forged fields are ignored | act |
| A-99 | Jar A | `changePassword`, `deleteAccount`, `signOutEverywhere` with `userId=B.id` | Only A is affected; B's hash, sessions and data unchanged | act |
| A-100 | Proxy-wrapped FormData (pattern in `tests/app/actions.qa.test.ts`) | Each auth/account action | Only the contract field names are read | act |

### 3.10 Input validation and normalisation

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| A-101 | `signUp` email lengths | 254-char valid email; 255-char; 1 MiB | 254 accepted. 255 and 1 MiB give `VALIDATION_FAILED` on `email`, 0 hasher calls, 0 `users` rows, return in < 50 ms | svc, act |
| A-102 | Email shape | `"a@b@c.com"`, `"nouser"`, `"kate @x.com"`, `"kate@x.com\u0000"`, `"kate@x.com\n"`, `"\tkate@x.com"`, NBSP/BOM padding, fullwidth `"kate＠x.com"`, `"kate​@x.com"` (zero width space, ruling R-11), `"@x.com"`, `"kate@"` | All `VALIDATION_FAILED` on `email`. Amended per the A-102 trim ruling: only U+0020 is trimmed (`"  Kate@X.com  "` is accepted as `kate@x.com`); tab, newline, NBSP and BOM are rejected, not trimmed | svc |
| A-103 | Normalisation | Sign up `"  Kate@Example.COM "` | Stored `email = "kate@example.com"`. Sign-in with `"KATE@example.com"` succeeds. Sign-up `"kate@example.com"` gives `EMAIL_TAKEN` and creates nothing | svc |
| A-104 | Unicode case | Sign up `kate@x.com`, then `"Kate@x.com"` (Kelvin sign; lower-cases to `k`) | `EMAIL_TAKEN` (deterministic `toLowerCase`, not locale dependent). Sign up `"JOSÉ@x.com"` (NFD) and `"JOSÉ@x.com"` (NFC): ruling R-11 (recommend NFC so these collide) | svc |
| A-105 | Repository bypass (DDL-2) | `createUser` called directly with `"Kate@X.com"` | Stored lower-cased by the repository too (T115 AC1), not only by the service | svc |
| A-106 | Password lengths in UTF-16 units (amended per ruling K-10) | 7 ASCII; 8 ASCII; 128 ASCII; 129 ASCII; 3 astral + 1 ASCII (7 units); 4 astral (8 units); 64 astral (128 units); 64 astral + 1 (129 units); 1 MiB | 7 and 129 units (ASCII or astral) and 1 MiB: `VALIDATION_FAILED` on `password`, 0 hasher calls. 8 and 128 units accepted, matching the input's `maxLength` | svc, act |
| A-107 | Password never altered | Sign up with `" pass phrase 99 "` | Sign-in with `"pass phrase 99"` fails `INVALID_CREDENTIALS`; exact string succeeds. NFD vs NFC variants do not match each other (documented) | svc |
| A-108 | Weak list | Every exported weak-list entry with length >= 8, in original, upper and title case | `VALIDATION_FAILED` on `password` for each | svc |
| A-109 | Local-part rule | Email `kate.smith@x.com` with password `"kate.smith"` and `"KATE.SMITH"` | `VALIDATION_FAILED` on `password` | svc |
| A-110 | Display name at sign-up | `""`, 51 code points, control chars only, `"<script>"` | First three rejected on `displayName`. `"<script>"` stored as text | svc, act |
| A-111 | Non-string FormData entries | `File`/`Blob` for email/password/displayName; duplicated keys | `INVALID_INPUT` or `VALIDATION_FAILED` per contract; no hashing; first value used for duplicates | act |
| A-112 | Password never echoed | Any failing `signUp`/`signIn`/`changePassword`/`deleteAccount` | The returned state has no field holding the password value; email and display name are echoed | act |

### 3.11 UI and page cases (T129)

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| U-01 | Header, signed in with display name `<img src=x onerror=alert(1)>` and with 50 RTL chars | Render | Text node only (`container.querySelector("img")` null); greeting "Hello, <name>"; sign-out form present | ui |
| U-02 | Header, guest | Render | "Sign in" link to `/signin` | ui |
| U-03 | SignInForm, SignUpForm | Render | Each input has an associated `<label>`; `autocomplete` email/username/current-password/new-password/name; `maxLength` 254/50/128; `<form>` has an action and `method` for no-JS; submit is a `<button type="submit">` | ui |
| U-04 | Failed submit (state with `INVALID_CREDENTIALS`) | Re-render | Error in a `role="alert"` region that receives focus; password input value is `""` | ui |
| U-05 | Pending | Submit | Button disabled with "Signing in..." label; a second click sends once | ui |
| U-06 | PasswordField | Keyboard: Tab to toggle, press Enter/Space | `type` flips; accessible name toggles "Show password"/"Hide password"; `aria-pressed` toggles; value and input focus preserved; target >= 44px (classes `min-h-11 min-w-11` or token equivalent) | ui |
| U-07 | PasswordField error | Render with error | `aria-invalid="true"`; `aria-describedby` points at existing error and helper ids | ui |
| U-08 | PasswordField value hygiene | Type a value | Not present in any attribute other than the live `value`; no `data-*`; `localStorage` untouched (spy) | ui |
| U-09 | DeleteAccountForm (JS on) | Type `DELETE` | Submit disabled until the exact value; the Dialog traps focus, Escape closes it, focus returns to the trigger | ui |
| U-10 | All new forms | 320px class audit + token check | No arbitrary values, no palette classes, no horizontal overflow classes; `bun run check:tokens` passes | ui |
| U-11 | Contrast | Error/notice/link colours used by the forms | Role tokens only (contrast already verified per token pair in phase2-tokens.qa); no new colour | ui |
| P-01 | `/signin`, `/signup` guest render | Call page | One `<h1>`; title "Sign in"/"Create account"; `robots` noindex; no cookie `set` calls; password-reset notice and contact link on `/signin` | pg |
| P-02 | Signed-in render of `/signin`, `/signup` | Call page | Redirect (`NEXT_REDIRECT`) to the safe `next` or `/account`; the form is never rendered | pg |
| P-03 | Garbage/revoked `sf_auth` on `/signin` | Call page | Form renders, no throw | pg |
| P-04 | `/account/settings` guest | Call page | Redirect to `/signin?next=%2Faccount%2Fsettings` | pg |
| P-05 | `/account/settings` as A and as B | Call page | Each shows its own email and display name only; noindex; one `<h1>`; breadcrumb to Account; sign-out-everywhere and delete are plain POST forms | pg |
| P-06 | `/account/*` (T98 pages) for guest, A, B | Call pages | No cross-user data; guest sees the sign-in invitation plus the device-bound notice; never `notFound()` | pg |
| P-07 | Sitemap | `sitemap()` | No `/signin`, `/signup`, `/account/settings` URLs | pg |

### 3.12 Journeys (T129, function level with two cookie jars)

| ID | Precondition | Step | Expected | File |
|---|---|---|---|---|
| J-01 | Jar 1 guest | add P x2 to cart, review P (5), place order O1 -> sign-up A | Jar 1 `sf_session` rotated; cart P x2, review and O1 all under KA; Counts(old guest) = 0 | jrn |
| J-02 | After J-01 | sign-out on jar 1 | Jar 1 cart empty; new `sf_session`; `readCurrentUser` null | jrn |
| J-03 | Jar 2 fresh, guest adds Q | sign-in A on jar 2 | Jar 2 sees cart {P x2, Q x1}, A's review on P, O1 in order history | jrn |
| J-04 | Jar 1 signed in again (`TA1`), jar 2 (`TA2`) | sign-out-everywhere on jar 2 | Jar 1 resolves as guest; its actions return `UNAUTHENTICATED` | jrn |
| J-05 | A signed in on jar 1 | delete account -> re-sign-up with the same email on jar 1 | Empty cart, no reviews, no orders; the anonymised O1 is unreachable | jrn |

### 3.13 HTTP smoke (T113 criterion 12)

| ID | Step | Expected | File |
|---|---|---|---|
| H-01 | Jar 1: no-JS multipart sign-up | 303 redirect; `Set-Cookie: sf_auth=...; HttpOnly; SameSite=Lax; Path=/` (no `Secure` under `next start` without production TLS unless NODE_ENV=production, then `Secure` present); `Set-Cookie: sf_session` with a new value | http |
| H-02 | Jar 1: add to cart, submit review, sign out | Sign-out clears `sf_auth` (`Max-Age=0` or past `Expires`) and rotates `sf_session` | http |
| H-03 | Jar 2: sign in | Cart, review and order history visible in HTML | http |
| H-04 | Wrong password vs unknown email (A-29) | Indistinguishable | http |
| H-05 | 11 rapid wrong-password POSTs on one email | 11th response shows the lock or rate-limit message; 10th onwards never sets `sf_auth` | http |
| H-06 | Sign-out-everywhere on jar 2 | Jar 1 next request renders as guest | http |
| H-07 | GET `/signin`, `/signup`, `/account/settings` (signed in) | `noindex` in HTML meta or `X-Robots-Tag`; absent from `/sitemap.xml` | http |
| H-08 | Guest GET `/account/settings` | 307/303 to `/signin?next=%2Faccount%2Fsettings` | http |
| H-09 | Server log | No password, hash or token; no unhandled errors | http |
| H-10 | Cross-site POST: sign-in action with `Origin: https://evil.example` | Rejected by Next's server-action origin check (non-2xx or error); no `Set-Cookie: sf_auth` (login CSRF, risk K-6) | http |
| H-11 | Open redirect (A-87) | `Location` is `/account` | http |

---

## 4. Test file map and fixtures

### 4a. Files

| File | Owner task | Cases |
|---|---|---|
| `tests/accounts/services.qa.test.ts` | T122 | A-01..A-08, A-10..A-12, A-15..A-23, A-25, A-27, A-28, A-41..A-44, A-46..A-66, A-70..A-79, A-88..A-90, A-95, A-101..A-110; section 1 merge/delete assertions per table |
| `tests/accounts/session.qa.test.ts` | T122 | C-01..C-19 (each column of 2a), A-24, A-33..A-35, A-37, A-39, A-40, A-75, A-82, A-84; "no `set` on read paths"; "DB not opened without `sf_auth`" (T119 AC8); `unstable_rethrow` regression |
| `tests/accounts/actions.qa.test.ts` | T122 | W-01..W-18, A-01, A-02, A-08..A-10, A-13, A-14, A-26, A-30, A-34..A-36, A-38, A-45, A-67..A-69, A-76..A-81, A-83, A-88, A-89, A-91, A-92, A-97..A-101, A-106, A-110..A-112 |
| `tests/accounts/isolation.qa.test.ts` | T122 | I-00 discovery guard; section 1 Read/Write protocol for rows 1-19 x 6 ordered pairs (G/A/B) through action entry points; A-31, A-40, A-65 |
| `tests/accounts/ui.qa.test.tsx` | T129 | U-01..U-11, A-93 (component part) |
| `tests/accounts/pages.qa.test.tsx` | T129 | P-01..P-07, A-85, A-86, A-93, A-94 |
| `tests/accounts/journeys.qa.test.tsx` | T129 | J-01..J-05, A-30..A-32, A-34, A-76 (journey form) |
| `tests/e2e/http-smoke.ts` | T113 | H-01..H-11, A-29, A-87, A-96 |

Implementer tests (T115-T121, T123-T128) should cover their own acceptance criteria. The cases above that fall in their scope are the minimum: T115 covers A-44 (hash format), A-105, the 20-way concurrent increment and two-user revoke. T116 covers A-16..A-21, A-26/27 at service level, A-41..A-43 and A-106..A-109. T117 covers A-46..A-64. T118 covers A-70..A-73 and A-75..A-78. T119 covers C-01..C-17. T120/T121 cover W-01..W-18 and A-83. QA files re-test these adversarially and must not depend on implementer helpers beyond the exported API.

### 4b. Fixtures and helpers (recommended; created by T122 in `tests/accounts/_fixtures.ts`, QA-owned, imported by T129)

1. `makeDb()`: `createDatabase(":memory:")` + `runMigrations` + `seedProducts` (+ the P2-A catalog seed if the services need categories). Returns a fresh DB per test. Never `getDatabase()` without `DATABASE_PATH=":memory:"`.
2. Fast hasher injection: `fastHasher()` returns `{ hash(pw): Promise<string>, verify(pw, hash): Promise<boolean>, calls: { hash: number, verify: number, verifyArgs: string[] } }`. It produces `"$qa-fast$" + saltHex + "$" + sha256hex(salt + pw)` and yields one microtask so concurrency tests interleave. It is passed through `createAuthService({ hasher })` (T116 AC9). Exactly one test per file uses real `Bun.password` (A-27, A-44, T116 AC2). The leakage grep pattern includes `$qa-fast$` as well as `$argon2`.
3. `testClock(T0)`: `{ now(): number, advance(ms): void, iso(): string }`. Passed to the auth service, merge service, repository and `createRateLimiter({ now })`, so lock, expiry and limiter windows move together.
4. Cookie jar: extend the existing `QaCookieStore` pattern (`tests/server/session.qa.test.ts`, `tests/app/actions.qa.test.ts`) with `delete(name)`, `getAll()`, `has(name)`, and a `deleteCalls` array. `set` with `maxAge: 0` and `delete` are both treated as "cleared" by an `isCleared(name)` helper. A `CookieJar` class wraps one store per browser so journeys can swap `currentStore = jar1 | jar2` between calls. Register `mock.module("next/headers", () => ({ cookies: async () => currentStore, headers: async () => currentHeaders }))` once at the top of each file, before any import that reaches `next/headers`. `currentHeaders` is a `Headers` instance (user-agent, origin). `mock.module("next/cache", ...)` spies `revalidatePath`.
5. Redirects: `next/navigation` `redirect` is mocked process-wide by other test files (see the comment in `src/server/session/session.test.ts`). The helper `captureRedirect(fn)` accepts either a thrown error whose `digest` starts with `NEXT_REDIRECT;` (parse the URL from field 3) or a call recorded on the mocked `redirect`. It returns the URL. Run `bun test tests/accounts` in isolation and in the full suite.
6. `seedIdentity(db, ownerKey, opts)`: inserts one row per owner-keyed table (cart + items, default wishlist + item, SFL + item, view, review, review vote on a bystander's review, question, answer, votes, alert, contact message, address, paid order with items and events, coupon redemption). Returns the ids, for the isolation Write protocol.
7. `OWNER_TABLES` and `snapshot(db, key)` / `counts(db, key)`: built from section 1, plus the discovery query `SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type='table' AND p.name IN ('session_id','cart_session_id')` used by I-00. `fullSnapshot(db)` dumps every table (minus FTS shadow tables) for atomicity and idempotency.
8. `injectFailure(db, table, op)`: `CREATE TEMP TRIGGER` raising `ABORT` (A-62, A-72). It needs no hook in implementer code. Remove with `DROP TRIGGER`.
9. `sqlSpy(db)`: a `Proxy` over `Database` recording `query/prepare/run` SQL text and bound params (A-41, A-43, C-08..C-11). Use it only where the service accepts an injected `db`.
10. Secrets registry: `secrets.add(value)` for every password, token, stored hash and token hash; `assertNoSecrets(haystack: string, label)` and `consoleCapture()` (spy on `console.log/info/warn/error/debug`, restored in `afterEach`). Owner keys go in a separate registry for HTML/props/cookie checks.
11. `formData(entries)` and the Proxy FormData recorder copied from `tests/app/actions.qa.test.ts` (not imported, since that file is not a module export).
12. DB-not-opened check (T119 AC8): set `DATABASE_PATH` to a not-yet-existing file in a temp dir and assert the file still does not exist after `readSessionId()` with `sf_session` only.
13. Seeded PRNG (mulberry32) for A-66; print the seed in the test name or on failure.

---

## 5. Open risks (each with the mitigation to test)

- K-1 (blocker-class) An owner key is a bearer credential. Setting `sf_session=<owner_key>` without `sf_auth` gives full access to that user's carts, orders and addresses, because guest resolution never touches the DB (T119 AC8) and the `User` type carries `ownerKey`. Mitigation: reject `sf_session` values equal to any `users.owner_key` (one indexed lookup) or derive owner keys so they can never be valid guest ids. Also never serialise `ownerKey`. Tests: C-15, A-40, A-89, A-93, A-94.
- K-2 (major) Lockout reveals account existence. The 10th failure returns `ACCOUNT_LOCKED` for real emails and `INVALID_CREDENTIALS` for unknown ones. After the per-email limiter window rolls, a locked real account keeps answering `ACCOUNT_LOCKED`. This contradicts AR2. Mitigation: answer `INVALID_CREDENTIALS`-shaped responses during lock, or track unknown emails in the same limiter key and respond identically. Test: A-25.
- K-3 (major) The per-email key cannot go through `limitAction`. That function maps any non-UUID key to `anon`, so passing a hashed email would put every email in one bucket of 10 per 15 min (a site-wide sign-in DoS). Cookieless sign-ins have the same collapse on the session key. Mitigation: call `limiter.check` directly with `signin.email:<sha256>`, and mint `sf_session` before limiting. Tests: A-06, A-07, A-09.
- K-4 (major) The merge reads the wrong id. If an action calls `readSessionId()` (which now returns the owner key) instead of reading the raw `sf_session` cookie, signing in as B while signed in as A merges A's whole account into B. Mitigation: a dedicated raw guest-cookie reader, plus the T117 guard against owner-key inputs. Tests: A-38, A-64, A-68.
- K-5 (major) Account deletion leaves the owner key on `orders.session_id` and `coupon_redemptions` (T118 AC4 vs the coupon rule), and guest rows left behind by merge conflicts (reviews, votes, alerts, redemptions) survive under the rotated guest id with the user's display name. Mitigation: rewrite to a tombstone UUID; delete or report orphaned conflict rows. Tests: A-71, A-49, A-60.
- K-6 (major) Login CSRF plus merge: an attacker who signs a victim into the attacker's account captures the victim's guest cart and future addresses and orders. Mitigation: Next server-action Origin check (do not disable it), SameSite=Lax. Test: H-10.
- K-7 (major) Cart re-keying hits a FK trap. `cart_items.cart_session_id` references `carts.session_id` without `ON UPDATE CASCADE`, so an UPDATE-based re-key fails mid-transaction or is done non-atomically. Mitigation: upsert-then-delete inside one transaction. Tests: A-46, A-62.
- K-8 (minor) Fixed windows allow 2x bursts across a boundary (20 sign-in attempts in about 2 s). The lockout counter, which is not windowed, still caps a single account at 10. Test: A-05, A-19.
- K-9 (minor) Unsalted SHA-256 of an email as a limiter key can be reversed by dictionary. No secret infrastructure exists to use HMAC instead. Accepted; tests assert only that no plaintext appears. Test: A-07.
- K-10 (minor, resolved) Password length mismatch. Ruled: the server counts UTF-16 units (8..128), matching `maxLength=128` (amended per ruling K-10). Test: A-106, U-03.
- K-11 (minor) Unicode email look-alikes (NFD vs NFC, zero width characters, Kelvin sign) can create visually duplicate accounts. Mitigation: NFC-normalise and reject `\p{Cf}` (ruling R-11). Test: A-102, A-104.
- K-12 (minor) DB writes during render: `resolveToken` touches `last_seen_at` from Server Component reads, and `requireUser` redirects from render. Mitigation: touch is throttled and must not throw. `unstable_rethrow` is preserved for control-flow errors. Tests: A-43, C-19.
- K-13 (minor) Merge caps that are not in T117 (`stock_alerts` 20, list name length after the " (2)" suffix). Mitigation: rulings R-4 and R-5. Tests: A-54, A-61.
- K-14 (minor) Deleting a user's question cascades to other users' answers (FK ON DELETE CASCADE). Mitigation: ruling R-7 (anonymise the question instead, or accept and report). Test: A-74.
- K-15 (minor) `mock.module` is process-wide in bun. Auth mocks of `next/headers`/`next/navigation` can interfere with existing suites. Mitigation: delegate to per-file state (existing pattern) and run the accounts suite both alone and with the full suite.

## 6. Rulings needed before T122 starts (orchestrator)

All eleven were answered on 2026-11-07 (STATE.md "ACCOUNTS RULINGS"). Differences from the recommendations below: R-7 anonymises questions AND answers; R-10 makes lock and limit surface one identical `RATE_LIMITED` state at the action boundary; R-1 uses one constant tombstone. T122 amended the affected rows above (each marked "amended per ruling R-x").


- R-1 Owner key vs guest cookie (K-1). Should C-15/A-40 be fixed by an owner-key lookup on `sf_session` (this relaxes T119 AC8), and should deleted users' orders and redemptions be re-keyed to a tombstone? Recommended: yes and yes.
- R-2 Sign-out-everywhere also revokes the current session and clears the jar's cookies (W-10). Recommended: yes.
- R-3 Sign-in/sign-out cookie writes when `sf_session` is absent. May a failed sign-in mint `sf_session` so the per-session limiter has a key? Recommended: yes, mint before limiting. Sign-out without `sf_auth` rotates `sf_session` anyway.
- R-4 List name dedupe suffix must keep names within 60 code points (truncate the base). Recommended: yes.
- R-5 Merge enforces the `stock_alerts` cap of 20. Rows dropped for any cap are deleted, not left under the old guest id. Recommended: yes.
- R-6 Anonymisation covers `phone` and `delivery_note` (NULL) and `line2` (NULL). `card_last4` and `payment_ref` are kept. Recommended: yes.
- R-7 Deleting a user's questions: hard delete (other users' answers cascade) vs anonymise. Recommended: anonymise the question body/display name to "[deleted]" and keep the answers.
- R-8 `sf_auth` expiry is absolute (30 days from issue, touch does not extend it). Read paths never clear an invalid `sf_auth` (SR10). Recommended: yes.
- R-9 Cross-owner mutations return `NOT_FOUND`-family codes, not `FORBIDDEN`. Recommended: yes.
- R-10 Lockout enumeration (K-2): accept and document, or make the 10th+ responses identical for unknown emails. Recommended: identical responses.
- R-11 Email normalisation: NFC-normalise before lower-casing; reject `\p{Cc}`, `\p{Cf}`, `\p{Z}`. Recommended: yes.
