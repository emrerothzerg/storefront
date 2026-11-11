import { redirect, unstable_rethrow } from "next/navigation";

import type { User } from "@/lib/types";

import { safeNext } from "./safe-next";
import { readAuthToken, readGuestSessionId } from "./session";
import { isSessionId } from "./session-id";

/**
 * Signed-in user helpers (T119). Server-only: never import from a
 * "use client" module.
 *
 * `CurrentUser` is the ONLY user shape that may reach components, props,
 * HTML or JSON: it never carries the owner key, password hash, token or
 * token hash (AR1, R-1). The full `User` (with `ownerKey`) is available to
 * server actions through {@link readResolvedAuth} only.
 *
 * None of these functions set or clear cookies (SR10, R-8).
 */

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
}

export interface ResolvedAuth {
  readonly user: User;
  readonly authSessionId: string;
}

/** Sign-in route used by {@link requireUser}. */
export const SIGN_IN_PATH = "/signin";

/** `sf_auth` → `{ user, authSessionId }` via the auth service, or null. DB errors propagate. */
async function resolveAuth(): Promise<ResolvedAuth | null> {
  const token = await readAuthToken();
  if (token === null) return null;
  const { getAuthService } = await import("@/server/auth/auth-service");
  const resolved = getAuthService().resolveToken(token);
  if (resolved === null) return null;
  return { user: resolved.user, authSessionId: resolved.authSessionId };
}

/**
 * The signed-in user for UI (`{ id, email, displayName }`, exactly these
 * keys), or `null` for guests and for expired, revoked, malformed or unknown
 * tokens and tokens of deleted users. Safe in Server Component render: never
 * sets cookies and never throws application errors (a failing lookup reads as
 * "not signed in"); Next.js control-flow errors are rethrown.
 */
export async function readCurrentUser(): Promise<CurrentUser | null> {
  try {
    const resolved = await resolveAuth();
    if (resolved === null) return null;
    const { id, email, displayName } = resolved.user;
    return { id, email, displayName };
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

/**
 * Owner key + UI user of the current request from ONE auth-token lookup
 * (consistency at). SERVER-ONLY: `ownerKey` must never reach a component,
 * URL, JSON or log (R-1).
 */
export interface OwnerAndUser {
  /** Same value `readSessionId()` returns for this request. */
  readonly ownerKey: string | null;
  /** Same value `readCurrentUser()` returns for this request. */
  readonly user: CurrentUser | null;
}

/**
 * `{ ownerKey, user }` equal to calling `readSessionId()` and
 * `readCurrentUser()` together, but `sf_auth` is resolved once: a valid
 * token gives the user and (when well-formed) their owner key; otherwise
 * the owner key is the R-1 checked guest id. Read-only: never mints, rotates
 * or clears a cookie, so it is safe in Server Component render. Application
 * errors (cookie store, database) read as "not signed in" / "no cookie",
 * exactly like the two helpers; Next.js control-flow errors are rethrown.
 * With no cookies the database is never opened.
 */
export async function readOwnerAndUser(): Promise<OwnerAndUser> {
  let resolved: ResolvedAuth | null = null;
  try {
    resolved = await resolveAuth();
  } catch (error) {
    unstable_rethrow(error);
    resolved = null;
  }
  const user: CurrentUser | null =
    resolved === null
      ? null
      : { id: resolved.user.id, email: resolved.user.email, displayName: resolved.user.displayName };
  const authOwnerKey = resolved !== null && isSessionId(resolved.user.ownerKey) ? resolved.user.ownerKey : null;
  if (authOwnerKey !== null) return { ownerKey: authOwnerKey, user };

  let ownerKey: string | null = null;
  try {
    ownerKey = await readGuestSessionId();
  } catch (error) {
    unstable_rethrow(error);
    ownerKey = null;
  }
  return { ownerKey, user };
}

/**
 * Returns the signed-in user, or throws a Next.js redirect to
 * `/signin?next=<safeNext(nextPath)>` (URL-encoded). For pages and layouts
 * (AR4). Do NOT call during `generateMetadata`. Server actions should use
 * {@link readResolvedAuth} and return `UNAUTHENTICATED` instead.
 */
export async function requireUser(nextPath?: string): Promise<CurrentUser> {
  const user = await readCurrentUser();
  if (user !== null) return user;
  redirect(`${SIGN_IN_PATH}?next=${encodeURIComponent(safeNext(nextPath))}`);
}

/**
 * Server-action helper: the resolved `{ user, authSessionId }` (the `User`
 * includes `ownerKey`; never pass it to a component, a returned action state
 * or a log), or `null` when not signed in. Never sets cookies. Cookie-store
 * failures read as `null`; database errors and Next.js control-flow errors
 * propagate so the action fails instead of answering "signed out".
 */
export async function readResolvedAuth(): Promise<ResolvedAuth | null> {
  return resolveAuth();
}
