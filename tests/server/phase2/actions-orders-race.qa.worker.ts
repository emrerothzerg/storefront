/**
 * QA-W3-T72 helper (owned by QA): one racer on its OWN connection to a shared
 * file database. Builds the real order actions (orders-core) over real
 * services and fires `cancelOrder` or `buyAgain` once every racer is released
 * by the Atomics barrier.
 */
import { createOrderActions } from "@/app/actions/orders-core";
import { createCartService } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { createOrderService } from "@/server/orders/order-service";
import { SqliteOrderRepository } from "@/server/orders/order-repository";
import { createMockPaymentProvider } from "@/server/payments/mock-payment-provider";
import { createRateLimiter } from "@/server/security/rate-limiter";

declare const self: Worker;

interface Job {
  readonly path: string;
  readonly op: "cancel" | "buy";
  readonly sessionId: string;
  readonly orderId: string;
  readonly start: Int32Array;
  readonly now: number;
}

self.onmessage = async (event: MessageEvent<Job>) => {
  const { path, op, sessionId, orderId, start, now } = event.data;
  const db = createDatabase(path);
  const actions = createOrderActions({
    orders: createOrderService(db, {
      now: () => now,
      payments: createMockPaymentProvider({ latencyMs: 0, now: () => new Date(now) }),
      inFlight: new Map(),
    }),
    cart: createCartService(db, { now: () => now }),
    catalog: new SqliteOrderRepository(db),
    limiter: createRateLimiter(db, { now: () => now }),
    readSessionId: async () => sessionId,
    revalidatePath: () => undefined,
    now: () => now,
    logger: { error: () => undefined },
  });
  const fd = new FormData();
  fd.append("orderId", orderId);
  fd.append("confirm", "yes");
  Atomics.wait(start, 0, 0);
  try {
    const state = op === "cancel" ? await actions.cancelOrder(null, fd) : await actions.buyAgain(null, fd);
    postMessage({ op, ok: state?.ok === true, code: state === null ? "NULL" : state.ok ? state.kind : state.error.code });
  } catch (error) {
    postMessage({ op, ok: false, code: `THROW:${String(error)}` });
  } finally {
    db.close();
  }
};
