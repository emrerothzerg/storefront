# server/payments

Payment provider interface and the MVP mock implementation. No real provider or secrets in code; any future credentials come from environment variables. Server-only. Owning task: T10 (programmer).

| Module | Contents |
|---|---|
| `payment-provider.ts` | `PaymentProvider` (`charge(request): Promise<PaymentResult>`), `ChargeRequest`, `PaymentResult = Result<PaymentSuccess, PaymentFailure>`. Types only. |
| `mock-payment-provider.ts` | `MockPaymentProvider`, `createMockPaymentProvider(options?)`, `MOCK_CARDS`, `PAYMENT_FAILURE_MESSAGES`, `RecordedCharge`, `PaymentLogEvent`. In memory, no network. |

## Wiring (dependency injection)

There is no module-level provider instance. Whoever composes the order service constructs one and passes it in:

```ts
import { createMockPaymentProvider } from "@/server/payments/mock-payment-provider";
const orders = createOrderService({ payments: createMockPaymentProvider(), /* ... */ });
```

The order service should depend only on the `PaymentProvider` type from `payment-provider.ts`.

## Mock test cards

Outcome is decided by card number only (spaces and dashes ignored). Any future expiry, any CVC.

| Card number | Outcome | `message` |
|---|---|---|
| `4242 4242 4242 4242` | success | |
| `4000 0000 0000 0002` | `DECLINED` | Your card was declined. |
| `4000 0000 0000 9995` | `INSUFFICIENT_FUNDS` | Your card has insufficient funds. |
| `4000 0000 0000 0119` | `PROCESSING_ERROR` | We couldn't process your payment. Please try again. |
| any other Luhn-valid number | success | |
| a non-Luhn number | `DECLINED` (defensive; cards are validated upstream) | Your card was declined. |

Success returns `{ providerRef: "mock_" + id, last4 }`.

## Behaviour

- **Amount**: `amountCents` must be a positive safe integer. Otherwise the result is `INVALID_AMOUNT` ("The payment amount is invalid."), nothing is recorded, and the result is not stored under the idempotency key, so a corrected retry with the same key still charges.
- **Idempotency**: every other result is stored by `idempotencyKey`. A repeat call with the same key returns the same frozen result object and records no second charge, even if the card or amount differs: the first request wins. Concurrent calls with one key share a single in-flight charge. Declines and `PROCESSING_ERROR` are cached too, so a retry needs a new key.
- **Rejections are not cached**: if the in-flight charge rejects (an injected `idGenerator` or `now` throws), the key is released and nothing is recorded, so a retry with the same key proceeds normally. A throwing `logger` is swallowed and never affects a charge.
- **Invalid key**: `idempotencyKey` must be a non-empty string of at most 128 characters (`MAX_IDEMPOTENCY_KEY_LENGTH`). Otherwise `charge` returns a promise rejected with `TypeError` (never a synchronous throw). This is a programmer error, not a `PaymentFailureCode`.
- **Card data**: only `last4` is stored, logged or returned. The full number, expiry, CVC and name never appear in results, `listCharges()` or log events.

## Options

`new MockPaymentProvider({ latencyMs?, now?, idGenerator?, logger? })`

- `latencyMs` (default 0): simulated delay per new charge. Must be finite and non-negative.
- `now` (default `new Date()`): timestamp for `RecordedCharge.createdAt`.
- `idGenerator` (default `crypto.randomUUID`): id for `providerRef`.
- `logger` (default no-op): receives `PaymentLogEvent`s (`charge.settled`, `charge.replayed`, `charge.invalid_amount`) with `last4` only. The provider never writes to the console.

## Inspection (tests and QA)

- `listCharges(): readonly RecordedCharge[]`: frozen snapshot, oldest first. `RecordedCharge = { idempotencyKey, amountCents, currency, last4, outcome: "success" | PaymentFailureCode, providerRef?, createdAt }`.
- `reset()`: clears charges and stored idempotency results. Charges still in flight when `reset()` is called are not recorded.
