"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { CheckoutActionState } from "@/components/organisms/_contracts/checkout-actions";
import { createOrderService } from "@/server/orders/order-service";
import { readSessionId } from "@/server/session/session";
import { createCheckoutActions } from "./checkout-core";

/**
 * Checkout Server Action (T13). This file may only export async functions
 * (Next 16 `'use server'` rule). Deps are built at call time (never at import
 * time, so importing this module opens no DB). Uses `readSessionId`: checkout
 * never creates a session (no session = EMPTY_CART). On success `redirect()`
 * throws, so the action never returns.
 */
export async function placeOrder(prevState: CheckoutActionState, formData: FormData): Promise<CheckoutActionState> {
  return createCheckoutActions({
    getSessionId: readSessionId,
    orders: createOrderService(),
    redirect,
    revalidate: revalidatePath,
  }).placeOrder(prevState, formData);
}
