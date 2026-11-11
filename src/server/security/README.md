# src/server/security

Server-only guards for Phase 2 write paths (T31). Both modules are pure apart
from the limiter's SQLite table; neither imports `next/*`.

## text-guard.ts

```ts
cleanText(raw: unknown, { max, min?, multiline? }): Result<string, AppError>
countUrls(text: string): number
normalizeCouponCode(raw: unknown): Result<string, AppError>
```

- Call `cleanText` on every free-text field before it reaches a service or SQL.
  Use the Input limits table (BACKLOG-phase2.md section 0) for `max`, e.g.
  review body `{ max: 2000, min: 1, multiline: true }`, list name `{ max: 60, min: 1 }`.
- Errors: `INVALID_INPUT` (not a string), `TOO_LONG` (raw > `max * 4`, rejected
  before scanning, or cleaned > `max`), `VALIDATION_FAILED` (cleaned < `min`).
  Bad options (`max` not a positive integer, `min > max`) throw `RangeError`.
- Cleaning strips C0/C1 controls (U+0085 included), zero-width and bidi
  control characters and Hangul fillers (U+3164, U+FFA0); collapses every
  Unicode White_Space run (tab, space, NBSP, U+1680, U+2000-U+200A, U+202F,
  U+205F, U+3000) to one space; trims. NBSP-only input is empty. Single-line: line breaks become a space.
  Multiline: `\r\n`/`\r`/U+2028/U+2029 become `\n`, at most one blank line in a row.
- No HTML handling: `<script>` is returned unchanged. Render as React text only (SR3).
- Lengths are UTF-16 code units, the same unit the `maxLength` attribute uses.
- `countUrls` counts every `http://` / `https://` occurrence (case-insensitive,
  even inside words or separated only by punctuation: `http://a,http://b` is 2)
  and every `www.` at a word boundary (`awww.` is 0); a `www.` right after a
  scheme belongs to it (`https://www.x` is 1). Use it for spam heuristics.
- `normalizeCouponCode` returns the trimmed upper-case code or `COUPON_INVALID`.
  Any zero-width/BOM/bidi/filler character is rejected before trimming.
  It does not look the code up.

## rate-limiter.ts

```ts
const limited = limitAction(getRateLimiter(), "review.submit", sessionId);
if (!limited.ok) return limited; // RATE_LIMITED, details.retryAfterSeconds (1..window)
```

- Server actions call `limitAction` FIRST, before validation or service work
  (SR9), with the session id from `getOrCreateSessionId()` / `readSessionId()`
  (or `null`). Non-UUID ids are bucketed as `"anon"`.
- Key kinds: `limitAction(limiter, action, key, { keyKind })`. `"session"`
  (default) needs a lowercase UUID v4: session ids, and the user's `owner_key`
  for `account.changePassword` / `account.delete` / `account.updateProfile`.
  `"opaque"` needs 64 hex chars (lower-cased), and is the default for
  `auth.signin.email`, whose key is the SHA-256 hex of the lower-cased email.
  Never pass the raw email. Keys that don't match go to the `"anon"` bucket.
- Rules live in `RATE_LIMIT_RULES` (mirrors the backlog Rate limits table):
  per-session key `${action}:${sessionId}` plus a global backstop `${action}:*`.
  Rules are checked in order and the first failure is returned.
- Fixed windows aligned to multiples of `windowSeconds` (epoch seconds).
- Fails closed: if SQLite errors, the call is refused with
  `retryAfterSeconds = windowSeconds` and one log line naming only the action.
- Tests: `createRateLimiter(createDatabase(":memory:") /* after runMigrations */, { now: () => fakeMs, logger })`.
  Never use real timers; advance the injected clock.
- Storage: rows are `(key = "${windowSeconds}:${logicalKey}", window_start, count)`.
  The window prefix separates rules that share a logical key (contact.submit's
  hourly and daily rules) and lets the purge range-scan one window size.
- Table bound: on each window's first hit (and every 100th check) rows of that
  window size older than the previous window are deleted. Rows per window size
  never exceed the distinct keys seen in two consecutive windows (proved by
  the 10,000-call tests in `rate-limiter.test.ts`).
- Single-process guarantee: the upsert is one atomic statement, so concurrent
  requests in one Bun process cannot over-admit.
