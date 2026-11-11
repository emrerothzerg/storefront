"use server";

import { redirect, unstable_rethrow } from "next/navigation";

import { signOutEverywhere } from "@/app/actions/account";

import { runSignOutEverywhere } from "./sign-out-everywhere";

/**
 * Form adapter for `/account/settings` (T128). This file may only export
 * async functions (`'use server'`). Logic lives in `sign-out-everywhere.ts`;
 * auth, revocation and cookie handling stay in the wrapped action.
 */
export async function signOutEverywhereFromSettings(formData: FormData): Promise<void> {
  await runSignOutEverywhere({ action: signOutEverywhere, redirect, rethrow: unstable_rethrow }, formData);
}
