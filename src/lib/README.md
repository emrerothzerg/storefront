# lib

Pure, framework-free code shared by server and client: domain types and small helpers. No I/O, no React, no imports from `src/server`. Every runtime module has a colocated `*.test.ts`. Owner: programmer.

| Module | Contents |
|---|---|
| `types.ts` | Domain types (`Product`, `CartItem`/`CartLine`, `Cart`, `Address`, `CardInput`, `PaymentSuccess`/`PaymentFailure`, `Order`, `OrderItem`) and the `ErrorCode` union with its runtime list `ERROR_CODES`. All fields `readonly`; string-literal unions, no enums. |
| `result.ts` | `Result<T, E = AppError>` (`{ ok: true, value } \| { ok: false, error }`), `AppError`, constructors `ok`/`err`/`appError`/`fail`, guards `isOk`/`isErr`/`isErrorCode`/`isAppError`, combinators `mapResult`/`andThen`. Results are plain JSON so server actions can return them. |
| `money.ts` | Integer minor-unit math: `addCents`, `multiplyCents`, `sumCents` return `Result<number>` (`INVALID_INPUT` for non-integer/negative, `MONEY_OVERFLOW` past `Number.MAX_SAFE_INTEGER`); `isValidCents` guard; `formatMoney(amountMinor, currency, locale = "en-US")` (currency-aware minor units, exact for every safe integer, throws `RangeError` on non-integer, negative or unsafe amounts: guard display code with `isValidCents`). Ok values never carry `-0`; `sumCents` never throws. |
| `display-name.ts` | `cleanDisplayName(name)` (non-strings → ""; every `\p{Cf}` removed except ZWNJ U+200C / ZWJ U+200D, which stay only between two visible characters; runs of `\p{Cc}` controls and whitespace → one space; trimmed), `truncateDisplayName(name, max = 20)` (code points, ellipsis, no dangling joiner at the cut), `MAX_VISIBLE_NAME_LENGTH`. Neutral home (CONS-B4 bh) for the header, AccountMenu and DepartmentMenu; `organisms/SiteHeader/header-model.ts` re-exports them. Server parity: `normalizeDisplayName` (src/server/auth/password-policy.ts). |
| `validation.ts` | `validateQuantity`, `validateAddress`, `validateCard` (+ `luhnCheck`). Return normalized values or an error with a per-field map (`details.fields`). Zero-width characters count as whitespace. Card errors never contain the card number or CVC; the `ValidatedCard` success value does (for the payment provider), so never return it from a server action or log it. Bad `max` / `now` arguments throw `TypeError` (programmer errors). |

## Rules

- Money is always an integer number of minor units in a `...Cents` field plus an ISO 4217 `currency`. Never use floats for money; format only at the edge with `formatMoney`.
- `CardInput` is never persisted, logged, or sent to the client. Keep only `last4`.
- Import as `@/lib/types`, `@/lib/result`, `@/lib/money`, `@/lib/validation`.
