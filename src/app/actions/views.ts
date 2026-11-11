"use server";

import { revalidatePath } from "next/cache";
import type { ViewActionState } from "@/components/molecules/_contracts/view-actions";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { getDatabase } from "@/server/db/client";
import { getRecommendationService } from "@/server/recommendations/recommendation-service";
import { getRateLimiter } from "@/server/security/rate-limiter";
import { getOrCreateSessionId, readSessionId } from "@/server/session/session";
import { VIEW_ACTION_FAILED, createViewActions, unexpectedErrorState, type ViewActions } from "./views-core";

/**
 * View-tracking and browsing-history Server Actions (T52). This file may only
 * export async functions (Next 16 `'use server'` rule). Each wrapper builds
 * the actions with real deps at call time (never at import time, so importing
 * this module opens no DB) and delegates to `views-core.ts`.
 */

function actions(): ViewActions {
  const products = new SqliteProductRepository(getDatabase());
  return createViewActions({
    service: getRecommendationService(),
    findProductIdBySlug: (slug) => products.getBySlug(slug)?.id ?? null,
    productExists: (productId) => products.getById(productId) !== null,
    limiter: getRateLimiter(),
    getOrCreateSessionId,
    readSessionId,
    revalidatePath,
  });
}

function logFailure(name: string): void {
  try {
    console.error(`[views] ${VIEW_ACTION_FAILED} action=${name}`);
  } catch {
    // A failing logger must never stop the action from settling.
  }
}

/**
 * Builds deps and runs the picked action inside one try, so a failure to open
 * the DB, or anything the core lets escape, still settles with a state.
 */
async function run(name: string, call: (built: ViewActions) => Promise<ViewActionState>): Promise<ViewActionState> {
  try {
    return await call(actions());
  } catch {
    logFailure(name);
    return unexpectedErrorState();
  }
}

/** Beacon for the PDP ViewTracker. Never throws; unknown input is "ignored". */
export async function recordProductView(input: { productId?: string; productSlug?: string }): Promise<ViewActionState> {
  return run("record", (a) => a.recordProductView(input));
}

export async function recordProductViewForm(prevState: ViewActionState, formData: FormData): Promise<ViewActionState> {
  return run("recordForm", (a) => a.recordProductViewForm(prevState, formData));
}

export async function removeFromHistory(prevState: ViewActionState, formData: FormData): Promise<ViewActionState> {
  return run("remove", (a) => a.removeFromHistory(prevState, formData));
}

export async function clearHistory(prevState: ViewActionState, formData: FormData): Promise<ViewActionState> {
  return run("clear", (a) => a.clearHistory(prevState, formData));
}
