"use server";

import { revalidatePath } from "next/cache";
import type { StockAlertActionState } from "@/components/molecules/_contracts/stock-alert-actions";
import { getStockAlertService } from "@/server/alerts/stock-alert-service";
import { getRateLimiter } from "@/server/security/rate-limiter";
import { getOrCreateSessionId, readSessionId } from "@/server/session/session";
import {
  STOCK_ALERT_ACTION_FAILED,
  createStockAlertActions,
  unexpectedErrorState,
  type StockAlertActions,
} from "./stock-alerts-core";

/**
 * Stock alert Server Actions (T50). This file may only export async functions
 * (Next 16 `'use server'` rule). Each wrapper builds the actions with real
 * deps at call time (never at import time, so importing this module opens no
 * DB) and delegates to `stock-alerts-core.ts`. Signature `(prevState, formData)`
 * is what `useActionState` binds, so the forms also work without JavaScript.
 */

function actions(): StockAlertActions {
  return createStockAlertActions({
    service: getStockAlertService(),
    limiter: getRateLimiter(),
    getOrCreateSessionId,
    readSessionId,
    revalidatePath,
  });
}

/** Builds deps inside the try of the core; a failure to open the DB still settles. */
async function run(
  pick: (a: StockAlertActions) => StockAlertActions[keyof StockAlertActions],
  prevState: StockAlertActionState,
  formData: FormData,
): Promise<StockAlertActionState> {
  let built: StockAlertActions;
  try {
    built = actions();
  } catch {
    console.error(`[stock-alerts] ${STOCK_ALERT_ACTION_FAILED} action=init`);
    return unexpectedErrorState();
  }
  return pick(built)(prevState, formData);
}

export async function subscribeStockAlert(prevState: StockAlertActionState, formData: FormData): Promise<StockAlertActionState> {
  return run((a) => a.subscribeStockAlert, prevState, formData);
}

export async function unsubscribeStockAlert(prevState: StockAlertActionState, formData: FormData): Promise<StockAlertActionState> {
  return run((a) => a.unsubscribeStockAlert, prevState, formData);
}

export async function acknowledgeStockAlert(prevState: StockAlertActionState, formData: FormData): Promise<StockAlertActionState> {
  return run((a) => a.acknowledgeStockAlert, prevState, formData);
}
