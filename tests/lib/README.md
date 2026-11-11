# tests/lib

QA-owned adversarial tests for `src/lib` (T06: domain types, money, result, validation). Independent of the author's colocated `src/lib/*.test.ts`. Owner: qa-engineer.

Run with `bun test tests/lib`. `tsconfig.json` includes `tests/**`, so the compile-time assertions in `types.test.ts` are enforced by `bun run typecheck`.

| File | Covers |
|---|---|
| `money.test.ts` | Integer-only math, `MAX_SAFE_INTEGER` boundaries, hostile operands (`-0`, `0.1 + 0.2`, `1e21`, bigint, `valueOf` objects, arrays, `null`, prototype-less objects), seeded 200-iteration property checks against BigInt, JSON round trip, `formatMoney` exactness. |
| `validation.test.ts` | `validateQuantity` reasons and boundaries; `validateAddress` unicode-whitespace trimming, email shapes, length limits, hostile inputs; `validateCard` Luhn, 12/13/19/20-digit lengths, separators, non-ASCII digits, expiry at end of month in UTC with injected `now`, 2-digit years, CVC 2-5 digits, no 6+ digit run or CVC in failures; JSON round trip for every validator. |
| `result.test.ts` | Plain-object results, `appError` shape, guards and combinators, `isErrorCode`/`isAppError` on wire data. |
| `types.test.ts` | Type-level: no `any` in exported types, `OrderStatus` is exactly `"paid" \| "payment_failed"`. Runtime: no `any`/`@ts-ignore`/`eslint-disable`/`enum` in `src/lib` sources, `formatPrice` defined in at most one place. |

Tests in an `orchestrator rulings` block assert behaviour the orchestrator ruled on after the first QA pass (`-0` normalised, `sumCents` never throws, `formatMoney` range, `validateQuantity` max check, zero-width trimming, email domain dots, card year/identical-digit/`now` rules). The `documented by design (ruling 7)` block pins intentional behaviour: the `ValidatedCard` success value keeps the full number and CVC, and a numeric card number reports `REQUIRED`. The test commented `QA-T06-01` is the regression test for the fixed `formatMoney` precision defect.
