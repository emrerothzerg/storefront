"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AccountActionState } from "@/components/molecules/_contracts/account-actions";
import { getAccountService, type AccountService } from "@/server/auth/account-service";
import { getAuthService } from "@/server/auth/auth-service";
import { getRateLimiter, type RateLimiter } from "@/server/security/rate-limiter";
import { readResolvedAuth } from "@/server/session/current-user";
import { clearAuthCookie, rotateGuestSession } from "@/server/session/session";
import { createAccountActions, type AccountActionName, type AccountActions } from "./account-core";

/**
 * Account settings Server Actions (T121). This file may only export async
 * functions (Next 16 `'use server'` rule). Each call builds the actions with
 * LAZY deps: the account service, auth service and rate limiter (and so the
 * database) are only reached when the action actually needs them, i.e. after
 * `readResolvedAuth()` found a signed-in user. Importing this module opens no
 * DB. Signature `(prevState, formData)` is what `useActionState` binds, so
 * every form also works without JavaScript. Logic lives in `account-core.ts`.
 */

const lazyAccount: AccountService = {
  updateDisplayName: (userId, raw, now) => getAccountService().updateDisplayName(userId, raw, now),
  changePassword: (userId, current, next, keepSessionId, now) =>
    getAccountService().changePassword(userId, current, next, keepSessionId, now),
  deleteAccount: (userId, password, now) => getAccountService().deleteAccount(userId, password, now),
};

const lazyLimiter: RateLimiter = {
  check: (key, rule) => getRateLimiter().check(key, rule),
};

function build(): AccountActions {
  return createAccountActions({
    account: lazyAccount,
    auth: { signOutEverywhere: (userId, now) => getAuthService().signOutEverywhere(userId, now) },
    limiter: lazyLimiter,
    readResolvedAuth,
    clearAuthCookie,
    rotateGuestSession,
    revalidatePath,
    redirect,
  });
}

function run(name: AccountActionName, prevState: AccountActionState, formData: FormData): Promise<AccountActionState> {
  return build()[name](prevState, formData);
}

export async function updateProfile(prevState: AccountActionState, formData: FormData): Promise<AccountActionState> {
  return run("updateProfile", prevState, formData);
}

export async function changePassword(prevState: AccountActionState, formData: FormData): Promise<AccountActionState> {
  return run("changePassword", prevState, formData);
}

export async function deleteAccount(prevState: AccountActionState, formData: FormData): Promise<AccountActionState> {
  return run("deleteAccount", prevState, formData);
}

export async function signOutEverywhere(prevState: AccountActionState, formData: FormData): Promise<AccountActionState> {
  return run("signOutEverywhere", prevState, formData);
}
