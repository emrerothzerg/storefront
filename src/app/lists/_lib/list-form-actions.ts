"use server";

import { redirect } from "next/navigation";

import { addToCart } from "@/app/actions/cart";
import { createList } from "@/app/actions/lists";
import { CART_FIELD } from "@/components/molecules/_contracts/cart-actions";

import { isListIdShape, type CreateErrorCode } from "./params";

/**
 * Form adapters for the lists pages (T99). This file may only export async
 * functions (`'use server'`). They let plain `<form action>`s in Server
 * Components (no `useActionState`, no client code in pages) post the
 * `(prevState, formData)` actions, and work without JavaScript (SR2).
 * Session handling, rate limiting and validation stay in the wrapped actions.
 */

const CREATE_ERROR_CODES: readonly CreateErrorCode[] = ["TOO_LONG", "VALIDATION_FAILED", "LIMIT_REACHED", "RATE_LIMITED"];

function toCreateErrorCode(code: string): CreateErrorCode {
  return (CREATE_ERROR_CODES as readonly string[]).includes(code) ? (code as CreateErrorCode) : "UNKNOWN";
}

/**
 * "Create a list" on `/lists`: posts `createList` (which may mint the session,
 * ruling 2026-11-07), then redirects (PRG): success -> the new list with
 * `?created=1`; failure -> `/lists?createError=<CODE>` (a fixed code, never
 * the submitted name).
 */
export async function createListFromIndex(formData: FormData): Promise<void> {
  const state = await createList(null, formData);
  if (state !== null && state.ok) {
    const id = state.listId;
    redirect(isListIdShape(id) ? `/lists/${id}?created=1` : "/lists?created=1");
  }
  const code = state === null ? "UNKNOWN" : toCreateErrorCode(state.error.code);
  redirect(`/lists?createError=${code}`);
}

/**
 * Per-item "Add to cart" in ListItemRow posts `(formData)` with only
 * `productId`; the cart action wants `(prevState, formData)` and requires
 * `quantity`. Forwards `productId` and the posted quantity, defaulting to "1"
 * (the cart action still validates both and reads nothing else).
 */
export async function addToCartFromList(formData: FormData): Promise<void> {
  const forwarded = new FormData();
  const productId = formData.get(CART_FIELD.productId);
  if (typeof productId === "string") forwarded.set(CART_FIELD.productId, productId);
  const quantity = formData.get(CART_FIELD.quantity);
  forwarded.set(CART_FIELD.quantity, typeof quantity === "string" && quantity !== "" ? quantity : "1");
  await addToCart(null, forwarded);
}
