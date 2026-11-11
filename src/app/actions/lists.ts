"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ListActionState } from "@/components/molecules/_contracts/list-actions";
import { getCartService } from "@/server/cart/cart-service";
import { getListService } from "@/server/lists/list-service";
import { getRateLimiter } from "@/server/security/rate-limiter";
import { getOrCreateSessionId, readSessionId } from "@/server/session/session";
import { LIST_ACTION_FAILED, createListActions, unexpectedErrorState, type ListActions } from "./lists-core";

/**
 * List Server Actions (T48). This file may only export async functions
 * (Next 16 `'use server'` rule). Each wrapper builds the actions with real
 * deps at call time (never at import time, so importing this module opens no
 * DB) and delegates to `lists-core.ts`. Signature `(prevState, formData)` is
 * what `useActionState` binds, so the forms also work without JavaScript.
 */

/** Where a successful deleteList lands (R-T85-1). */
const LIST_DELETED_PATH = "/lists?deleted=1";

function actions(): ListActions {
  return createListActions({
    lists: getListService(),
    cart: getCartService(),
    limiter: getRateLimiter(),
    getOrCreateSessionId,
    readSessionId,
    revalidatePath,
  });
}

/** Builds deps before delegating; a failure to open the DB still settles. */
async function run(
  name: keyof ListActions,
  prevState: ListActionState,
  formData: FormData,
): Promise<ListActionState> {
  let built: ListActions;
  try {
    built = actions();
  } catch {
    console.error(`[lists] ${LIST_ACTION_FAILED} action=init`);
    return unexpectedErrorState();
  }
  return built[name](prevState, formData);
}

export async function addToList(prevState: ListActionState, formData: FormData): Promise<ListActionState> {
  return run("addToList", prevState, formData);
}

export async function removeFromList(prevState: ListActionState, formData: FormData): Promise<ListActionState> {
  return run("removeFromList", prevState, formData);
}

export async function updateListItem(prevState: ListActionState, formData: FormData): Promise<ListActionState> {
  return run("updateListItem", prevState, formData);
}

export async function moveListItem(prevState: ListActionState, formData: FormData): Promise<ListActionState> {
  return run("moveListItem", prevState, formData);
}

export async function createList(prevState: ListActionState, formData: FormData): Promise<ListActionState> {
  return run("createList", prevState, formData);
}

export async function renameList(prevState: ListActionState, formData: FormData): Promise<ListActionState> {
  return run("renameList", prevState, formData);
}

/**
 * R-T85-1: the deleted list's page would 404 on re-render, so a successful
 * delete redirects to the index (`/lists?deleted=1` shows "List deleted.").
 * Works for no-JS posts too. Errors return the state unchanged.
 */
export async function deleteList(prevState: ListActionState, formData: FormData): Promise<ListActionState> {
  const state = await run("deleteList", prevState, formData);
  if (state !== null && state.ok) redirect(LIST_DELETED_PATH);
  return state;
}

export async function setListSharing(prevState: ListActionState, formData: FormData): Promise<ListActionState> {
  return run("setListSharing", prevState, formData);
}

export async function addAllToCart(prevState: ListActionState, formData: FormData): Promise<ListActionState> {
  return run("addAllToCart", prevState, formData);
}
