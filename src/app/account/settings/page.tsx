import type { Metadata } from "next";

import { changePassword, deleteAccount, updateProfile } from "@/app/actions/account";
import { buildMetadata } from "@/lib/seo/metadata";

import { signOutEverywhereFromSettings } from "./_lib/settings-form-actions";
import { SETTINGS_DESCRIPTION, SETTINGS_PATH, SETTINGS_TITLE, loadSettingsPage, type SearchParams } from "./_lib/settings-page";
import { SettingsView } from "./_lib/settings-view";

/** Account-only page: never indexed; static metadata carries no user data. */
export const metadata: Metadata = buildMetadata({
  title: SETTINGS_TITLE,
  description: SETTINGS_DESCRIPTION,
  path: SETTINGS_PATH,
  noindex: true,
});

export interface SettingsPageProps {
  readonly searchParams: Promise<SearchParams>;
}

/**
 * `/account/settings` (T128): sign-in required. Guests are redirected to
 * `/signin?next=%2Faccount%2Fsettings` by `requireUser()` before anything is
 * rendered; render never sets a cookie (SR10).
 */
export default async function AccountSettingsPage({ searchParams }: SettingsPageProps) {
  const data = await loadSettingsPage(await searchParams);
  return (
    <SettingsView
      data={data}
      actions={{ updateProfile, changePassword, deleteAccount, signOutEverywhere: signOutEverywhereFromSettings }}
    />
  );
}
