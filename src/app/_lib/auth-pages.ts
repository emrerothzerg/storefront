import { redirect } from "next/navigation";

import { SITE_NAME } from "@/lib/seo/site";
import { readCurrentUser, type CurrentUser } from "@/server/session/current-user";
import { DEFAULT_SAFE_NEXT, safeNext } from "@/server/session/safe-next";

/**
 * Shared logic for `/signin` and `/signup` (T127). Pages stay thin renderers:
 * they call {@link loadAuthPage} and pass the result to the form molecule.
 *
 * Read-only: the only I/O is `readCurrentUser()` (one `sf_auth` lookup; it
 * never sets or clears cookies and reads garbage, expired or revoked tokens
 * as "signed out"), so render never writes cookies (SR10).
 */

export type AuthPageSearchParams = Record<string, string | string[] | undefined>;

export const SIGN_IN_PATH = "/signin";
export const SIGN_UP_PATH = "/signup";
export const SIGN_IN_TITLE = "Sign in";
export const SIGN_UP_TITLE = "Create account";
export const SIGN_IN_DESCRIPTION = `Sign in to your ${SITE_NAME} account to see your orders, lists and saved addresses.`;
export const SIGN_UP_DESCRIPTION = `Create a ${SITE_NAME} account to keep your cart, orders and lists across devices and browsers.`;

/** Where a signed-in visitor goes when there is no usable `next`. */
export const SIGNED_IN_FALLBACK = DEFAULT_SAFE_NEXT;

const AUTH_PAGE_PATHS: ReadonlySet<string> = new Set([SIGN_IN_PATH, SIGN_UP_PATH]);

function pathOf(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/**
 * The sanitised `next` path, or `null`. Only a single string value counts
 * (repeated `?next=a&next=b` arrays are ignored). The value must pass
 * `safeNext` (same-origin path; no `//`, scheme, backslash or encoded
 * tricks). A `next` that points back at `/signin` or `/signup` is dropped as
 * well, so a signed-in visitor is never bounced between the auth pages.
 */
export function sanitizeNextParam(searchParams: AuthPageSearchParams): string | null {
  const raw = searchParams.next;
  if (typeof raw !== "string") return null;
  const safe = safeNext(raw, "");
  if (safe === "") return null;
  if (AUTH_PAGE_PATHS.has(pathOf(safe))) return null;
  return safe;
}

/** Redirect target for a signed-in visitor: the sanitised `next` or `/account`. */
export function signedInRedirectTarget(next: string | null): string {
  return next ?? SIGNED_IN_FALLBACK;
}

export interface AuthPageDeps {
  readonly readCurrentUser: () => Promise<CurrentUser | null>;
  readonly redirect: (url: string) => never;
}

const defaultDeps: AuthPageDeps = { readCurrentUser, redirect };

export interface AuthPageData {
  /** Sanitised `next` for the form's hidden field and cross-link, or null. */
  readonly next: string | null;
}

/**
 * Guests get `{ next }`; a signed-in visitor is redirected (Next.js redirect
 * error is thrown) to the sanitised `next` or `/account`, so the form is
 * never rendered for them.
 */
export async function loadAuthPage(
  searchParams: AuthPageSearchParams,
  deps: AuthPageDeps = defaultDeps,
): Promise<AuthPageData> {
  const next = sanitizeNextParam(searchParams);
  const user = await deps.readCurrentUser();
  if (user !== null) deps.redirect(signedInRedirectTarget(next));
  return { next };
}
