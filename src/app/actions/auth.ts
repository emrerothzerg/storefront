"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { AuthActionState } from "@/components/molecules/_contracts/auth-actions";
import { getAuthService, type AuthService } from "@/server/auth/auth-service";
import { getMergeService, type MergeService } from "@/server/auth/merge-service";
import {
  clearAuthCookie,
  readAuthToken,
  readGuestSessionId,
  rotateGuestSession,
  setAuthCookie,
} from "@/server/session/session";
import { createAuthActions, type AuthActionName, type AuthActions } from "./auth-core";

/**
 * Auth Server Actions (T120). This file may only export async functions
 * (Next 16 `'use server'` rule). Each call builds the actions with LAZY
 * service deps: the auth/merge services (and so the database) are reached
 * only when a step needs them. Importing this module opens no DB. Signature
 * `(prevState, formData)` is what `useActionState` binds, so every form also
 * works without JavaScript. Logic lives in `auth-core.ts`.
 */

const lazyAuth: AuthService = {
  signUp: (input, ctx) => getAuthService().signUp(input, ctx),
  signIn: (input, ctx) => getAuthService().signIn(input, ctx),
  resolveToken: (rawToken, now) => getAuthService().resolveToken(rawToken, now),
  signOut: (rawToken, now) => getAuthService().signOut(rawToken, now),
  signOutEverywhere: (userId, now) => getAuthService().signOutEverywhere(userId, now),
  verifyPassword: (userId, password, now) => getAuthService().verifyPassword(userId, password, now),
  issueSessionFor: (userId, ctx) => getAuthService().issueSessionFor(userId, ctx),
};

const lazyMerge: MergeService = {
  mergeGuestIntoUser: (guestSessionId, ownerKey, now) => getMergeService().mergeGuestIntoUser(guestSessionId, ownerKey, now),
};

/**
 * The guest id for the limiter key (R-3): the existing valid guest cookie, or
 * a freshly minted one. Unlike `getOrCreateSessionId()` this never returns a
 * signed-in user's owner key, so the per-session bucket is always the
 * browser's guest bucket.
 */
async function getOrCreateGuestSessionId(): Promise<string> {
  return (await readGuestSessionId()) ?? (await rotateGuestSession());
}

async function userAgent(): Promise<string | null> {
  return (await headers()).get("user-agent");
}

function build(): AuthActions {
  return createAuthActions({
    auth: lazyAuth,
    merge: lazyMerge,
    getOrCreateGuestSessionId,
    readGuestSessionId,
    readAuthToken,
    setAuthCookie,
    clearAuthCookie,
    rotateGuestSession,
    userAgent,
    revalidatePath,
    redirect,
  });
}

function run(name: AuthActionName, prevState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  return build()[name](prevState, formData);
}

export async function signUp(prevState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  return run("signUp", prevState, formData);
}

export async function signIn(prevState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  return run("signIn", prevState, formData);
}

export async function signOut(prevState: AuthActionState, formData: FormData): Promise<AuthActionState> {
  return run("signOut", prevState, formData);
}
