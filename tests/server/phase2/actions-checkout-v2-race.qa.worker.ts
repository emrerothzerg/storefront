/**
 * QA-W4-T71 helper (owned by QA): one racer on its OWN connection to a shared
 * file database. Builds the real checkout v2 actions (checkout-core) over the
 * real order / address services and fires `placeOrderV2` once every racer is
 * released by the Atomics barrier. Reports the redirect target (or the
 * failure code) and the charges its own provider recorded (with their keys).
 */
import { createCheckoutActionsV2 } from "@/app/actions/checkout-core";
import { createAddressService } from "@/server/addresses/address-service";
import { createDatabase } from "@/server/db/client";
import { createOrderService } from "@/server/orders/order-service";
import { createMockPaymentProvider } from "@/server/payments/mock-payment-provider";
import { createRateLimiter } from "@/server/security/rate-limiter";

declare const self: Worker;

export interface CheckoutRaceJob {
  readonly path: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly now: number;
  readonly start: Int32Array;
  readonly fields: readonly (readonly [string, string])[];
}

export interface CheckoutRaceResult {
  readonly outcome: "redirect" | "state" | "throw";
  readonly detail: string;
  readonly charges: number;
  readonly chargeKeys: readonly string[];
}

class Redirected extends Error {
  constructor(readonly url: string) {
    super("NEXT_REDIRECT (qa sentinel)");
  }
}

self.onmessage = async (event: MessageEvent<CheckoutRaceJob>) => {
  const { path, sessionId, idempotencyKey, now, start, fields } = event.data;
  const db = createDatabase(path);
  db.exec("PRAGMA busy_timeout = 10000");
  const pay = createMockPaymentProvider({ latencyMs: 3, now: () => new Date(now) });
  const actions = createCheckoutActionsV2({
    getSessionId: async () => sessionId,
    orders: createOrderService(db, { now: () => now, payments: pay, inFlight: new Map() }),
    addresses: createAddressService({ db, logger: { error: () => undefined, warn: () => undefined } }),
    limiter: createRateLimiter(db, { now: () => now }),
    redirect: (url: string): never => {
      throw new Redirected(url);
    },
    revalidate: () => undefined,
    rethrow: (error: unknown) => {
      if (error instanceof Redirected) throw error;
    },
    logError: () => undefined,
    now: () => now,
  });
  const fd = new FormData();
  fd.append("idempotencyKey", idempotencyKey);
  for (const [k, v] of fields) fd.append(k, v);
  Atomics.wait(start, 0, 0);
  let result: CheckoutRaceResult;
  try {
    const state = await actions.placeOrderV2(null, fd);
    result = { outcome: "state", detail: state === null ? "NULL" : state.error.code, charges: pay.listCharges().length, chargeKeys: [] };
  } catch (error) {
    const charges = pay.listCharges();
    result =
      error instanceof Redirected
        ? { outcome: "redirect", detail: error.url, charges: charges.length, chargeKeys: charges.map((c) => c.idempotencyKey) }
        : { outcome: "throw", detail: String(error), charges: charges.length, chargeKeys: [] };
  } finally {
    db.close();
  }
  postMessage(result);
};
