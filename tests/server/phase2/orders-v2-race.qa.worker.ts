/**
 * QA-W3-T55 helper (owned by QA): one racer on its OWN connection to a shared
 * file database. Waits on an Atomics barrier, then performs one order-service
 * v2 operation (place / cancel / view / list) and posts a JSON-safe summary.
 */
import { createDatabase } from "@/server/db/client";
import { createOrderService } from "@/server/orders/order-service";
import { createMockPaymentProvider } from "@/server/payments/mock-payment-provider";

declare const self: Worker;

export interface OrdersRaceJob {
  readonly path: string;
  readonly op: "place" | "cancel" | "view" | "list";
  readonly sessionId: string;
  readonly now: number;
  readonly start: Int32Array;
  readonly idempotencyKey?: string;
  readonly orderId?: string;
}

export interface OrdersRaceResult {
  readonly op: string;
  readonly ok: boolean;
  readonly code: string;
  readonly orderId: string | null;
  readonly charges: number;
}

const ADDRESS = {
  fullName: "Race Tester",
  email: "race@example.com",
  line1: "1 Barrier Road",
  city: "Leeds",
  region: "WYK",
  postalCode: "LS1 1AA",
  country: "GB",
};
const CARD = { number: "4242424242424242", expMonth: 12, expYear: 2030, cvc: "123", nameOnCard: "Race Tester" };

self.onmessage = async (event: MessageEvent<OrdersRaceJob>) => {
  const { path, op, sessionId, now, start, idempotencyKey, orderId } = event.data;
  const db = createDatabase(path);
  const pay = createMockPaymentProvider({ latencyMs: 2, now: () => new Date(now) });
  const svc = createOrderService(db, { now: () => now, payments: pay, inFlight: new Map() });
  Atomics.wait(start, 0, 0);
  let result: OrdersRaceResult;
  try {
    if (op === "place") {
      const r = await svc.placeOrderV2({ sessionId, address: ADDRESS, card: CARD, idempotencyKey: idempotencyKey ?? crypto.randomUUID() }, now);
      result = { op, ok: r.ok, code: r.ok ? "OK" : r.error.code, orderId: r.ok ? r.value.id : null, charges: pay.listCharges().length };
    } else if (op === "cancel") {
      const r = svc.cancelOrder(orderId ?? "", sessionId, now);
      result = { op, ok: r.ok, code: r.ok ? "OK" : r.error.code, orderId: orderId ?? null, charges: 0 };
    } else if (op === "view") {
      const v = svc.getOrderView(orderId ?? "", sessionId, now);
      result = { op, ok: v !== null, code: v === null ? "NULL" : v.fulfillmentStatus, orderId: orderId ?? null, charges: 0 };
    } else {
      const page = svc.listOrders(sessionId, { range: "all" }, now);
      result = { op, ok: true, code: String(page.total), orderId: null, charges: 0 };
    }
  } catch (error) {
    result = { op, ok: false, code: `THROW:${String(error)}`, orderId: null, charges: 0 };
  } finally {
    db.close();
  }
  postMessage(result);
};
