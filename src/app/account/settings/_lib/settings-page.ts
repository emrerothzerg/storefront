import type { BreadcrumbItem } from "@/components/atoms/Breadcrumb";
import { requireUser, type CurrentUser } from "@/server/session/current-user";

/**
 * Data + constants for `/account/settings` (T128). Read-only: resolves the
 * signed-in user through `requireUser()` (which reads `sf_auth` only, never
 * mints, rotates or clears a cookie: SR10, R-8) and redirects guests to
 * `/signin?next=%2Faccount%2Fsettings` (criterion 1).
 *
 * The view model deliberately drops `CurrentUser.id`: the page renders no
 * identifier of any kind (criterion 4).
 */

export const SETTINGS_PATH = "/account/settings";
/** Matches the AccountHub tile label (R-T87-2). */
export const SETTINGS_TITLE = "Login & security";
export const SETTINGS_DESCRIPTION = "Change your display name and password, sign out of all devices, or delete your account.";
export const ACCOUNT_PATH = "/account";
export const ACCOUNT_LABEL = "Your Account";

/** Section heading ids, passed to the forms as `headingId` (one instance each per page). */
export const SETTINGS_SECTION_IDS = {
  profile: "settings-profile-heading",
  password: "settings-password-heading",
  sessions: "settings-sessions-heading",
  delete: "settings-delete-heading",
} as const;

export const SETTINGS_SECTION_TITLES = {
  profile: "Profile",
  password: "Password",
  sessions: "Sessions",
  delete: "Delete account",
} as const;

export const SIGN_OUT_EVERYWHERE_LABEL = "Sign out of all devices";
export const SIGN_OUT_EVERYWHERE_TEXT =
  "Signs you out on every device and browser where you are signed in, including this one.";
export const SIGN_OUT_EVERYWHERE_ERROR = "We could not sign you out of all devices. Please try again.";

/** `?sessions=error` is set by the sign-out-everywhere adapter after a failed attempt. */
export const SESSIONS_PARAM = "sessions";
export const SESSIONS_ERROR_VALUE = "error";
export const SESSIONS_ERROR_HREF = `${SETTINGS_PATH}?${SESSIONS_PARAM}=${SESSIONS_ERROR_VALUE}`;

/** Home › Your Account › Login & security (fresh array: the atom takes a mutable list). */
export function settingsBreadcrumb(): BreadcrumbItem[] {
  return [{ label: "Home", href: "/" }, { label: ACCOUNT_LABEL, href: ACCOUNT_PATH }, { label: SETTINGS_TITLE }];
}

export type SearchParams = Record<string, string | string[] | undefined>;

/** What the settings view may show about the caller: no id, no owner key, no token. */
export interface SettingsUser {
  readonly email: string;
  readonly displayName: string;
}

export interface SettingsPageData {
  readonly user: SettingsUser;
  readonly sessionsError: boolean;
}

export interface SettingsPageDeps {
  /** Returns the signed-in user or throws the sign-in redirect. */
  readonly requireUser: (nextPath: string) => Promise<CurrentUser>;
}

const defaultDeps: SettingsPageDeps = { requireUser: (nextPath) => requireUser(nextPath) };

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseSessionsError(params: SearchParams): boolean {
  return firstValue(params[SESSIONS_PARAM]) === SESSIONS_ERROR_VALUE;
}

/** Guests never get past `requireUser` (it throws the redirect before any data is built). */
export async function loadSettingsPage(params: SearchParams, deps: SettingsPageDeps = defaultDeps): Promise<SettingsPageData> {
  const current = await deps.requireUser(SETTINGS_PATH);
  return {
    user: { email: current.email, displayName: current.displayName },
    sessionsError: parseSessionsError(params),
  };
}
