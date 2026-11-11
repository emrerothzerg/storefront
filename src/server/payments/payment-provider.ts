import type { Result } from "@/lib/result";
import type { CurrencyCode, PaymentFailure, PaymentSuccess } from "@/lib/types";
import type { ValidatedCard } from "@/lib/validation";

/**
 * Payment provider contract. Server-only.
 *
 * Implementations are constructed by whoever composes the order service and
 * passed in (dependency injection); there is no module-level singleton.
 *
 * Rules every implementation must follow:
 * - `charge` never throws for business outcomes (declines, bad amounts);
 *   those come back as `{ ok: false, error: PaymentFailure }`.
 * - Calls are idempotent per `idempotencyKey`: a repeat call with a key that
 *   was already charged returns the original result and charges nothing.
 * - The full card number, expiry and CVC are never stored, logged or
 *   returned. Only `last4` may leave the provider.
 */

export type PaymentResult = Result<PaymentSuccess, PaymentFailure>;

export interface ChargeRequest {
  /** Positive safe integer, in minor units of `currency`. */
  readonly amountCents: number;
  readonly currency: CurrencyCode;
  /** Card already validated by `validateCard` from `@/lib/validation`. */
  readonly card: ValidatedCard;
  /**
   * Unique per checkout attempt; reusing it replays the first result.
   * Non-empty, at most 128 characters; anything else is a programmer error
   * (`charge` rejects with `TypeError`).
   */
  readonly idempotencyKey: string;
}

export interface PaymentProvider {
  charge(request: ChargeRequest): Promise<PaymentResult>;
}
