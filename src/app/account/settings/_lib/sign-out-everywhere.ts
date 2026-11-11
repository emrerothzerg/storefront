import { SETTINGS_SIGN_IN_HREF } from "@/components/molecules/AccountSettingsForms";
import type { AccountActionFn } from "@/components/molecules/_contracts/account-actions";

import { SESSIONS_ERROR_HREF } from "./settings-page";

/**
 * Core of the settings page "Sign out of all devices" form adapter (T128).
 * The `signOutEverywhere` action has the `(prevState, formData)` signature
 * (useActionState), which a plain Server Component `<form action>` cannot
 * take, so the page posts this `(formData)` adapter instead; it works without
 * JavaScript (SR2). On success the wrapped action itself throws its redirect
 * to `/`, which is rethrown untouched. Every other outcome also ends in a
 * redirect (PRG), so the post never renders a blank result:
 * - `UNAUTHENTICATED` -> the sign-in page with `next=/account/settings`;
 * - any other state or an unexpected throw -> `/account/settings?sessions=error`.
 */

export interface SignOutEverywhereDeps {
  readonly action: AccountActionFn;
  /** Must throw (Next's `redirect`). */
  readonly redirect: (path: string) => never;
  /** Rethrows Next.js control-flow errors (Next's `unstable_rethrow`). */
  readonly rethrow: (error: unknown) => void;
}

export async function runSignOutEverywhere(deps: SignOutEverywhereDeps, formData: FormData): Promise<never> {
  let target = SESSIONS_ERROR_HREF;
  try {
    const state = await deps.action(null, formData);
    if (state !== null && !state.ok && state.error.code === "UNAUTHENTICATED") target = SETTINGS_SIGN_IN_HREF;
  } catch (error) {
    deps.rethrow(error);
  }
  return deps.redirect(target);
}
