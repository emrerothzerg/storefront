/**
 * QA-W2-T45 helper (owned by QA): one racer on its OWN connection to a shared
 * file database, performing either moveToCart or addItem for the same session
 * and product once every racer is ready (Atomics barrier).
 */
import { createDatabase } from "@/server/db/client";
import { createCartService } from "@/server/cart/cart-service";

declare const self: Worker;

interface Job {
  readonly path: string;
  readonly op: "move" | "add";
  readonly sessionId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly start: Int32Array;
  readonly now: number;
}

self.onmessage = (event: MessageEvent<Job>) => {
  const { path, op, sessionId, productId, quantity, start, now } = event.data;
  const db = createDatabase(path);
  const cart = createCartService(db, { now: () => now });
  Atomics.wait(start, 0, 0);
  try {
    const result = op === "move" ? cart.moveToCart(sessionId, productId) : cart.addItem(sessionId, productId, quantity);
    postMessage({ op, ok: result.ok, code: result.ok ? "OK" : result.error.code });
  } catch (error) {
    postMessage({ op, ok: false, code: `THROW:${String(error)}` });
  } finally {
    db.close();
  }
};
