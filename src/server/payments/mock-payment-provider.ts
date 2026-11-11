import { err, ok } from "@/lib/result";
import type {
  CurrencyCode,
  IsoDateTimeString,
  PaymentFailure,
  PaymentFailureCode,
} from "@/lib/types";
import { luhnCheck } from "@/lib/validation";
import type { ChargeRequest, PaymentProvider, PaymentResult } from "./payment-provider";

/**
 * In-memory mock payment provider for the MVP, tests and QA. Server-only.
 * No network access, no third-party code.
 *
 * Outcomes are deterministic by card number (spaces/dashes ignored):
 *
 * | Card number          | Outcome              |
 * |----------------------|----------------------|
 * | 4242 4242 4242 4242  | success              |
 * | 4000 0000 0000 0002  | DECLINED             |
 * | 4000 0000 0000 9995  | INSUFFICIENT_FUNDS   |
 * | 4000 0000 0000 0119  | PROCESSING_ERROR     |
 * | any other Luhn-valid | success              |
 * | not Luhn-valid       | DECLINED (defensive) |
 *
 * `amountCents` that is not a positive safe integer returns INVALID_AMOUNT.
 * That result is NOT stored under the idempotency key and nothing is
 * recorded, so a corrected retry with the same key can still charge.
 *
 * Idempotency: every other result is stored by `idempotencyKey`. A repeat call
 * with the same key returns the very same (frozen) result object and records
 * no second charge, EVEN IF the card or amount in the repeat call differs; the
 * first request wins. Concurrent calls with the same key share one in-flight
 * charge. Failures are cached too, so retrying after a decline or
 * PROCESSING_ERROR needs a new key.
 *
 * Only settled results are cached. If the in-flight charge rejects (e.g. an
 * injected `idGenerator` or `now` throws), the key is released so a retry with
 * the same key can proceed; nothing is recorded for the rejected attempt.
 *
 * Programmer errors: an `idempotencyKey` that is not a non-empty string of at
 * most 128 characters makes `charge` return a promise rejected with a
 * `TypeError` (it never throws synchronously). This is not a payment outcome.
 *
 * Card data: only `last4` is kept, logged or returned. The full number,
 * expiry and CVC never leave `charge`.
 */

export const MOCK_CARDS = {
  success: "4242424242424242",
  declined: "4000000000000002",
  insufficientFunds: "4000000000009995",
  processingError: "4000000000000119",
} as const;

const MAGIC_OUTCOMES: Readonly<Record<string, PaymentFailureCode>> = {
  [MOCK_CARDS.declined]: "DECLINED",
  [MOCK_CARDS.insufficientFunds]: "INSUFFICIENT_FUNDS",
  [MOCK_CARDS.processingError]: "PROCESSING_ERROR",
};

/** User-safe messages; contain no card data. */
export const PAYMENT_FAILURE_MESSAGES: Readonly<Record<PaymentFailureCode, string>> = {
  DECLINED: "Your card was declined.",
  INSUFFICIENT_FUNDS: "Your card has insufficient funds.",
  PROCESSING_ERROR: "We couldn't process your payment. Please try again.",
  INVALID_AMOUNT: "The payment amount is invalid.",
};

/** Maximum length of `ChargeRequest.idempotencyKey`. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export type ChargeOutcome = "success" | PaymentFailureCode;

export interface RecordedCharge {
  readonly idempotencyKey: string;
  readonly amountCents: number;
  readonly currency: CurrencyCode;
  readonly last4: string;
  readonly outcome: ChargeOutcome;
  /** Present only when `outcome === "success"`. */
  readonly providerRef?: string;
  /** From the `now` option, when the charge settled. */
  readonly createdAt: IsoDateTimeString;
}

/** Structured log event. Carries `last4` only, never card details. */
export interface PaymentLogEvent {
  readonly event: "charge.settled" | "charge.replayed" | "charge.invalid_amount";
  readonly idempotencyKey: string;
  readonly amountCents: number;
  readonly currency: CurrencyCode;
  readonly last4: string;
  readonly outcome: ChargeOutcome;
}

export type PaymentLogger = (event: PaymentLogEvent) => void;

export interface MockPaymentProviderOptions {
  /** Simulated latency per new charge, in ms. Default 0. */
  readonly latencyMs?: number;
  readonly now?: () => Date;
  /** Produces the id in `providerRef` ("mock_" + id). Default `crypto.randomUUID`. */
  readonly idGenerator?: () => string;
  /** Default: no-op. A logger that throws is ignored; it never affects a charge. */
  readonly logger?: PaymentLogger;
}

function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= MAX_IDEMPOTENCY_KEY_LENGTH;
}

function isValidAmount(amountCents: number): boolean {
  return Number.isSafeInteger(amountCents) && amountCents > 0;
}

function outcomeFor(digits: string): ChargeOutcome {
  if (!luhnCheck(digits)) return "DECLINED";
  return MAGIC_OUTCOMES[digits] ?? "success";
}

function failure(code: PaymentFailureCode): PaymentResult {
  const error: PaymentFailure = Object.freeze({ code, message: PAYMENT_FAILURE_MESSAGES[code] });
  return Object.freeze(err(error));
}

const noopLogger: PaymentLogger = () => {};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockPaymentProvider implements PaymentProvider {
  private readonly latencyMs: number;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly logger: PaymentLogger;

  private results = new Map<string, Promise<PaymentResult>>();
  private charges: RecordedCharge[] = [];
  /** Bumped by `reset()` so in-flight charges started before it are not recorded. */
  private generation = 0;

  constructor(options: MockPaymentProviderOptions = {}) {
    const latencyMs = options.latencyMs ?? 0;
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
      throw new RangeError("latencyMs must be a finite, non-negative number.");
    }
    this.latencyMs = latencyMs;
    this.now = options.now ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    const logger = options.logger ?? noopLogger;
    this.logger = (event) => {
      try {
        logger(event);
      } catch {
        // Logging must never change a payment outcome or leave a key stuck.
      }
    };
  }

  charge(request: ChargeRequest): Promise<PaymentResult> {
    const { idempotencyKey, amountCents, currency } = request;
    // Runtime check: callers may bypass the type system (e.g. a JS caller or a
    // value read from a form). Rejected, not thrown, to keep one async contract.
    if (!isValidIdempotencyKey(idempotencyKey)) {
      return Promise.reject(
        new TypeError(
          `idempotencyKey must be a non-empty string of at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
        ),
      );
    }
    // Derive from the number rather than trusting `card.last4`. Only these
    // four digits are kept; `request.card` is not referenced after this.
    const digits = request.card.number.replace(/\D/g, "");
    const last4 = digits.slice(-4);

    const existing = this.results.get(idempotencyKey);
    if (existing !== undefined) {
      return existing.then((result) => {
        this.logger({
          event: "charge.replayed",
          idempotencyKey,
          amountCents,
          currency,
          last4,
          outcome: result.ok ? "success" : result.error.code,
        });
        return result;
      });
    }

    if (!isValidAmount(amountCents)) {
      this.logger({
        event: "charge.invalid_amount",
        idempotencyKey,
        amountCents,
        currency,
        last4,
        outcome: "INVALID_AMOUNT",
      });
      return Promise.resolve(failure("INVALID_AMOUNT"));
    }

    // Decide the outcome now and register the pending result synchronously,
    // so concurrent calls with the same key share it.
    const outcome = outcomeFor(digits);
    const pending = this.settle(idempotencyKey, amountCents, currency, last4, outcome);
    this.results.set(idempotencyKey, pending);
    // Cache settled results only: release the key if the charge rejects, unless
    // `reset()` or a later charge has already replaced the entry.
    pending.catch(() => {
      if (this.results.get(idempotencyKey) === pending) this.results.delete(idempotencyKey);
    });
    return pending;
  }

  /** Snapshot of recorded charges, oldest first. */
  listCharges(): readonly RecordedCharge[] {
    return Object.freeze([...this.charges]);
  }

  /** Forgets all charges and stored idempotency results. */
  reset(): void {
    this.generation += 1;
    this.results = new Map();
    this.charges = [];
  }

  private async settle(
    idempotencyKey: string,
    amountCents: number,
    currency: CurrencyCode,
    last4: string,
    outcome: ChargeOutcome,
  ): Promise<PaymentResult> {
    const generation = this.generation;
    if (this.latencyMs > 0) await wait(this.latencyMs);

    let result: PaymentResult;
    let providerRef: string | undefined;
    if (outcome === "success") {
      providerRef = `mock_${this.idGenerator()}`;
      result = Object.freeze(ok(Object.freeze({ providerRef, last4 })));
    } else {
      result = failure(outcome);
    }

    if (generation === this.generation) {
      this.charges.push(
        Object.freeze({
          idempotencyKey,
          amountCents,
          currency,
          last4,
          outcome,
          ...(providerRef === undefined ? {} : { providerRef }),
          createdAt: this.now().toISOString(),
        }),
      );
    }
    this.logger({ event: "charge.settled", idempotencyKey, amountCents, currency, last4, outcome });
    return result;
  }
}

export function createMockPaymentProvider(
  options?: MockPaymentProviderOptions,
): MockPaymentProvider {
  return new MockPaymentProvider(options);
}
