/**
 * QA-W1-T38 helper (owned by QA): one shopper racing for the last use of a
 * coupon on its OWN connection to a shared-cache in-memory database.
 * Retries on lock errors (shared-cache locks fail fast with SQLITE_LOCKED).
 */
import { Database } from "bun:sqlite";
import { withTransaction } from "@/server/db/client";
import { recordRedemption } from "@/server/pricing/coupon-service";

declare const self: Worker;

interface Job {
  readonly uri: string;
  readonly code: string;
  readonly sessionId: string;
  readonly orderId: string;
  readonly start: Int32Array;
}

self.onmessage = (event: MessageEvent<Job>) => {
  const { uri, code, sessionId, orderId, start } = event.data;
  const db = new Database(uri, { strict: true });
  db.run("PRAGMA busy_timeout = 5000");
  // Spin until every worker is ready so the transactions really overlap.
  Atomics.wait(start, 0, 0);
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const result = withTransaction(db, (tx) => recordRedemption(tx, code, sessionId, orderId));
      db.close();
      postMessage({ ok: result.ok, code: result.ok ? "OK" : result.error.code, attempts });
      return;
    } catch (error) {
      const message = String(error);
      if (!/locked|busy/i.test(message) || attempts > 10_000) {
        db.close();
        postMessage({ ok: false, code: `THROW:${message}`, attempts });
        return;
      }
    }
  }
};
