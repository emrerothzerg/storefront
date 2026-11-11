import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";

import type { IsoDateTimeString } from "@/lib/types";

import { isSessionId } from "./session-id";

export { isSessionId };

/**
 * Session cookies and OWNER-KEY resolution (T08, extended by T119).
 * Server-only: never import from a "use client" module.
 *
 * Two cookies:
 * - `sf_session`: the guest id, an opaque server-generated UUID v4.
 * - `sf_auth`: a random 43-char base64url token; its SHA-256 hash is looked up
 *   in `auth_sessions` by the auth service (T116).
 *
 * `readSessionId()` / `getOrCreateSessionId()` return the OWNER KEY: the
 * signed-in user's `users.owner_key` when `sf_auth` is valid, else the guest
 * id. Guests and users share the same shape (canonical lower-case UUID v4), so
 * services keep receiving a "session id" and validate it with
 * {@link isSessionId}. Attacker-supplied cookie values never reach SQL raw:
 * the guest id is validated first and the token is only ever hashed.
 *
 * Ruling R-1: a guest cookie whose value equals some user's `owner_key` is
 * treated as NO cookie (one indexed lookup), so an owner key can never be
 * replayed as a guest id.
 *
 * The database and the auth modules are imported lazily inside the functions
 * that need them: importing this module, or resolving a request with no
 * cookies, never opens the database.
 */

export const SESSION_COOKIE_NAME = "sf_session";

/** 30 days, in seconds (the unit `cookies().set({ maxAge })` expects). */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const AUTH_COOKIE_NAME = "sf_auth";

/** Upper bound for the `sf_auth` cookie lifetime: 30 days, in seconds. */
export const AUTH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Raw auth token: 32 random bytes as unpadded base64url = exactly 43 chars. */
const AUTH_TOKEN_LENGTH = 43;
const AUTH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** True for a well-formed raw auth token (length checked before the regex). */
function isAuthTokenShape(value: unknown): value is string {
  return typeof value === "string" && value.length === AUTH_TOKEN_LENGTH && AUTH_TOKEN_RE.test(value);
}

/** Validated cookie values of the current request (each `null` when absent or malformed). */
interface RequestCookies {
  readonly guestId: string | null;
  readonly authToken: string | null;
}

/**
 * Reads both cookies. Next.js control-flow errors are rethrown (see
 * {@link readSessionId}); any other failure (no request scope, broken store)
 * means "no cookies".
 */
async function readRequestCookies(): Promise<RequestCookies> {
  try {
    const store = await cookies();
    const guest: unknown = store.get(SESSION_COOKIE_NAME)?.value;
    const auth: unknown = store.get(AUTH_COOKIE_NAME)?.value;
    return {
      guestId: isSessionId(guest) ? guest : null,
      authToken: isAuthTokenShape(auth) ? auth : null,
    };
  } catch (error) {
    unstable_rethrow(error);
    return { guestId: null, authToken: null };
  }
}

/** Resolved `sf_auth`: the user's owner key, or null. DB errors propagate. */
async function resolveAuthOwnerKey(authToken: string | null): Promise<string | null> {
  if (authToken === null) return null;
  const { getAuthService } = await import("@/server/auth/auth-service");
  const resolved = getAuthService().resolveToken(authToken);
  if (resolved === null) return null;
  const ownerKey = resolved.user.ownerKey;
  return isSessionId(ownerKey) ? ownerKey : null;
}

/** R-1: true when `id` is some user's owner key (one indexed lookup). DB errors propagate. */
async function isUserOwnerKey(id: string): Promise<boolean> {
  const [{ getDatabase }, { createAuthRepository }] = await Promise.all([
    import("@/server/db/client"),
    import("@/server/auth/auth-repository"),
  ]);
  return createAuthRepository(getDatabase()).findUserByOwnerKey(id) !== null;
}

/** Guest id accepted by R-1, or null. DB errors propagate. */
async function acceptGuestId(guestId: string | null): Promise<string | null> {
  if (guestId === null) return null;
  return (await isUserOwnerKey(guestId)) ? null : guestId;
}

/**
 * Owner key for already-read cookies: valid `sf_auth` wins, else the R-1
 * checked guest id. An auth lookup that throws (e.g. database unavailable) is
 * treated as "not signed in"; Next.js control-flow errors are rethrown.
 */
async function resolveOwnerKey(request: RequestCookies, swallowAuthErrors: boolean): Promise<string | null> {
  let ownerKey: string | null = null;
  try {
    ownerKey = await resolveAuthOwnerKey(request.authToken);
  } catch (error) {
    unstable_rethrow(error);
    if (!swallowAuthErrors) throw error;
  }
  if (ownerKey !== null) return ownerKey;
  return acceptGuestId(request.guestId);
}

function sessionCookieOptions(maxAge: number): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  maxAge: number;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge,
    secure: process.env.NODE_ENV === "production",
  };
}

/**
 * Reads the OWNER KEY for the current request: the signed-in user's
 * `owner_key` when `sf_auth` is valid (unexpired, unrevoked, user exists),
 * else the guest `sf_session` id, unless that value is some user's owner key
 * (R-1), in which case `null`.
 *
 * Safe to call anywhere, including Server Component render: it never sets or
 * clears a cookie (SR10; an expired or bad `sf_auth` is left in place, R-8).
 * Returns `null` when there is no usable cookie, or when `cookies()` or the
 * lookup fails with an application error (e.g. outside a request scope).
 * Callers on read paths should treat `null` as "nothing yet". Opens the
 * database only when a well-formed cookie is present.
 *
 * Next.js-internal control-flow errors are rethrown via `unstable_rethrow`
 * (prerender interruption / hanging-promise rejection under cacheComponents,
 * dynamic-usage bailouts, redirect/notFound). Swallowing them would let a
 * prerender continue past this await with `null` and run side effects (e.g.
 * opening the database) whose output is then discarded.
 */
export async function readSessionId(): Promise<string | null> {
  try {
    const request = await readRequestCookies();
    return await resolveOwnerKey(request, true);
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
}

/**
 * Returns the current OWNER KEY, creating and setting a guest cookie only when
 * the request has neither a valid `sf_auth` nor an acceptable guest cookie
 * (garbage, or a value equal to a user's owner key, is replaced with a fresh id).
 * With a valid `sf_auth` it returns the user's owner key and writes nothing.
 *
 * MUST NOT be called from Server Component render: Next.js only allows setting
 * cookies inside Server Actions (Server Functions) or Route Handlers, and calling
 * this during render will throw when it tries to set the cookie. Use
 * {@link readSessionId} on render/read paths instead.
 *
 * Unlike {@link readSessionId}, database errors propagate (the action fails
 * instead of silently replacing the visitor's guest cookie).
 */
export async function getOrCreateSessionId(): Promise<string> {
  const existing = await resolveOwnerKey(await readRequestCookies(), false);
  if (existing !== null) return existing;

  const id = crypto.randomUUID();
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, id, sessionCookieOptions(SESSION_MAX_AGE_SECONDS));
  return id;
}

/**
 * The RAW guest id from `sf_session` (valid UUID v4 that is not any user's
 * owner key, R-1), ignoring `sf_auth` entirely. Used by the sign-in/sign-up
 * merge (K-4): only this id is ever merged into an account.
 *
 * Never sets cookies. Cookie-store failures read as `null`; Next.js
 * control-flow errors and database errors propagate (actions only).
 */
export async function readGuestSessionId(): Promise<string | null> {
  const { guestId } = await readRequestCookies();
  return acceptGuestId(guestId);
}

/**
 * The raw `sf_auth` value when it is a well-formed token (43 chars base64url),
 * else `null`. No database access, never sets cookies. Server-only: the value
 * is a bearer credential and must never be logged, rendered or returned.
 */
export async function readAuthToken(): Promise<string | null> {
  const { authToken } = await readRequestCookies();
  return authToken;
}

/**
 * Sets `sf_auth` (Server Actions / Route Handlers only): httpOnly, SameSite
 * lax, path `/`, Secure iff `NODE_ENV === "production"`, Max-Age = seconds
 * until `expiresAt` (rounded up, capped at 30 days).
 *
 * Throws `TypeError` for a malformed token or unparseable `expiresAt`, and
 * `RangeError` when `expiresAt` is not in the future. Error messages never
 * contain the token.
 */
export async function setAuthCookie(token: string, expiresAt: IsoDateTimeString): Promise<void> {
  if (!isAuthTokenShape(token)) {
    throw new TypeError("setAuthCookie: malformed auth token");
  }
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) {
    throw new TypeError("setAuthCookie: expiresAt is not a valid date");
  }
  const seconds = Math.ceil((expiresMs - Date.now()) / 1000);
  if (seconds <= 0) {
    throw new RangeError("setAuthCookie: expiresAt must be in the future");
  }
  const store = await cookies();
  store.set(AUTH_COOKIE_NAME, token, sessionCookieOptions(Math.min(seconds, AUTH_COOKIE_MAX_AGE_SECONDS)));
}

/**
 * Expires `sf_auth` (Server Actions / Route Handlers only): sets an empty
 * value with Max-Age 0 and the same path/flags, so the browser drops it.
 */
export async function clearAuthCookie(): Promise<void> {
  const store = await cookies();
  store.set(AUTH_COOKIE_NAME, "", sessionCookieOptions(0));
}

/**
 * Writes a NEW guest id to `sf_session` and returns it (Server Actions / Route
 * Handlers only). The new id always differs from the current cookie value.
 * Used after sign-in/sign-up (session fixation defence), sign-out and account
 * deletion.
 */
export async function rotateGuestSession(): Promise<string> {
  const store = await cookies();
  let previous: unknown;
  try {
    previous = store.get(SESSION_COOKIE_NAME)?.value;
  } catch (error) {
    unstable_rethrow(error);
    previous = undefined;
  }
  let id = crypto.randomUUID();
  while (id === previous) id = crypto.randomUUID();
  store.set(SESSION_COOKIE_NAME, id, sessionCookieOptions(SESSION_MAX_AGE_SECONDS));
  return id;
}
