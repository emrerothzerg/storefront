"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import type { CheckoutActionStateV2 } from "@/components/organisms/_contracts/checkout-actions";
import { appError } from "@/lib/result";
import { getAddressService } from "@/server/addresses/address-service";
import { getOrderService } from "@/server/orders/order-service";
import { getRateLimiter } from "@/server/security/rate-limiter";
import { readSessionId } from "@/server/session/session";
import {
  CHECKOUT_ACTION_FAILED,
  CHECKOUT_MESSAGES_V2,
  createCheckoutActionsV2,
  type CheckoutActionsV2,
} from "./checkout-core";

/**
 * Checkout Server Action v2 (T71). Lives in its own module because the MVP
 * `checkout.ts` is pinned (by its unmodified tests) to exporting only
 * `placeOrder`. This file may only export async functions (Next 16
 * `'use server'` rule). Deps are built at call time inside a guard (importing
 * this module opens no DB; a failure to build them still settles with
 * INTERNAL_ERROR). Uses `readSessionId`: checkout never creates a session. On
 * success `redirect()` throws, so the action never returns.
 */
export async function placeOrderV2(
  prevState: CheckoutActionStateV2,
  formData: FormData,
): Promise<CheckoutActionStateV2> {
  let actions: CheckoutActionsV2;
  try {
    actions = createCheckoutActionsV2({
      getSessionId: readSessionId,
      orders: getOrderService(),
      addresses: getAddressService(),
      limiter: getRateLimiter(),
      redirect,
      revalidate: revalidatePath,
      rethrow: unstable_rethrow,
    });
  } catch (error) {
    unstable_rethrow(error);
    console.error(`[checkout] ${CHECKOUT_ACTION_FAILED} step=init code=UNEXPECTED`);
    return { ok: false, error: appError("INTERNAL_ERROR", CHECKOUT_MESSAGES_V2.unexpected) };
  }
  return actions.placeOrderV2(prevState, formData);
}
