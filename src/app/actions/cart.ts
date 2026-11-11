"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import type { CartActionState, CartActionStateV2 } from "@/components/molecules/_contracts/cart-actions";
import { appError, err } from "@/lib/result";
import { createCartService, getCartService } from "@/server/cart/cart-service";
import { getRateLimiter } from "@/server/security/rate-limiter";
import { getOrCreateSessionId, readSessionId } from "@/server/session/session";
import {
  CART_ACTION_FAILED,
  MESSAGES_V2,
  createCartActions,
  type CartActions,
  type CartActionsV2,
} from "./cart-core";

/**
 * Cart Server Actions (T12, v2 T56). This file may only export async
 * functions (Next 16 `'use server'` rule). Each wrapper builds the actions
 * with real deps at call time (never at import time, so importing this module
 * opens no DB) and delegates to `cart-core.ts`. Signature `(prevState, formData)`
 * is what `useActionState` binds, so the forms also work without JavaScript.
 *
 * v1 actions keep their MVP wiring (unexpected errors propagate). v2 actions
 * settle with INTERNAL_ERROR on unexpected failures, including a failure to
 * build their deps; `buyNow` throws Next's redirect to /checkout on success.
 */

function actions(): CartActions {
  return createCartActions({
    getSessionId: getOrCreateSessionId,
    cart: createCartService(),
    revalidate: revalidatePath,
  });
}

function actionsV2(): CartActionsV2 {
  return createCartActions({
    getSessionId: getOrCreateSessionId,
    readSessionId,
    cart: getCartService(),
    limiter: getRateLimiter(),
    revalidate: revalidatePath,
    redirect,
    rethrow: unstable_rethrow,
  });
}

type V2Name =
  | "saveForLater"
  | "moveToCart"
  | "applyCoupon"
  | "removeCoupon"
  | "selectShippingMethod"
  | "buyNow"
  | "addManyToCart";

/** Builds v2 deps (opens the DB) inside a guard so an init failure still settles. */
async function runV2(name: V2Name, prevState: CartActionStateV2, formData: FormData): Promise<CartActionStateV2> {
  let built: CartActionsV2;
  try {
    built = actionsV2();
  } catch (error) {
    unstable_rethrow(error);
    console.error(`[cart] ${CART_ACTION_FAILED} action=${name}`);
    return err(appError("INTERNAL_ERROR", MESSAGES_V2.unexpected));
  }
  return built[name](prevState, formData);
}

export async function addToCart(prevState: CartActionState, formData: FormData): Promise<CartActionState> {
  return actions().addToCart(prevState, formData);
}

export async function updateCartQuantity(prevState: CartActionState, formData: FormData): Promise<CartActionState> {
  return actions().updateCartQuantity(prevState, formData);
}

export async function removeFromCart(prevState: CartActionState, formData: FormData): Promise<CartActionState> {
  return actions().removeFromCart(prevState, formData);
}

export async function saveForLater(prevState: CartActionStateV2, formData: FormData): Promise<CartActionStateV2> {
  return runV2("saveForLater", prevState, formData);
}

export async function moveToCart(prevState: CartActionStateV2, formData: FormData): Promise<CartActionStateV2> {
  return runV2("moveToCart", prevState, formData);
}

export async function applyCoupon(prevState: CartActionStateV2, formData: FormData): Promise<CartActionStateV2> {
  return runV2("applyCoupon", prevState, formData);
}

export async function removeCoupon(prevState: CartActionStateV2, formData: FormData): Promise<CartActionStateV2> {
  return runV2("removeCoupon", prevState, formData);
}

export async function selectShippingMethod(prevState: CartActionStateV2, formData: FormData): Promise<CartActionStateV2> {
  return runV2("selectShippingMethod", prevState, formData);
}

/** Adds the posted quantity, then redirects to /checkout (never resolves on success). Errors return a state, no redirect. */
export async function buyNow(prevState: CartActionStateV2, formData: FormData): Promise<CartActionStateV2> {
  return runV2("buyNow", prevState, formData);
}

/** Adds 1 unit of each posted `productId` (repeated key; deduped, max 10). Success carries `perItem`. */
export async function addManyToCart(prevState: CartActionStateV2, formData: FormData): Promise<CartActionStateV2> {
  return runV2("addManyToCart", prevState, formData);
}
