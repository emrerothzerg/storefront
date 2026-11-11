"use server";

import { revalidatePath } from "next/cache";
import type { OrderActionState } from "@/components/molecules/_contracts/order-actions";
import { getCartService } from "@/server/cart/cart-service";
import { getDatabase } from "@/server/db/client";
import { SqliteOrderRepository } from "@/server/orders/order-repository";
import { getOrderService } from "@/server/orders/order-service";
import { getRateLimiter } from "@/server/security/rate-limiter";
import { readSessionId } from "@/server/session/session";
import { ORDER_ACTION_FAILED, createOrderActions, unexpectedErrorState, type OrderActions } from "./orders-core";

/**
 * Order Server Actions (T72). This file may only export async functions
 * (Next 16 `'use server'` rule). Each wrapper builds the actions with real
 * deps at call time (never at import time, so importing opens no DB) and
 * delegates to `orders-core.ts`. Uses `readSessionId` only: these actions
 * never create a session cookie.
 */

function build(action: string): OrderActions | null {
  try {
    return createOrderActions({
      orders: getOrderService(),
      cart: getCartService(),
      catalog: new SqliteOrderRepository(getDatabase()),
      limiter: getRateLimiter(),
      readSessionId,
      revalidatePath,
    });
  } catch {
    // Opening the DB failed; still settle. Error code only.
    console.error(`[orders] ${ORDER_ACTION_FAILED} action=${action} stage=init`);
    return null;
  }
}

export async function cancelOrder(prev: OrderActionState, formData: FormData): Promise<OrderActionState> {
  const built = build("cancelOrder");
  return built === null ? unexpectedErrorState() : built.cancelOrder(prev, formData);
}

export async function buyAgain(prev: OrderActionState, formData: FormData): Promise<OrderActionState> {
  const built = build("buyAgain");
  return built === null ? unexpectedErrorState() : built.buyAgain(prev, formData);
}

/** Single-argument form of `buyAgain` for OrderCard's `buyAgainAction` prop (no previous state). */
export async function buyAgainFromForm(formData: FormData): Promise<OrderActionState> {
  return buyAgain(null, formData);
}
