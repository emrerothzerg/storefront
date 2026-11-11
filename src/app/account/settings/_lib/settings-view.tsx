import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Notice } from "@/components/atoms/Notice";
import { Heading, Text } from "@/components/atoms/Typography";
import { ChangePasswordForm, DeleteAccountForm, ProfileForm } from "@/components/molecules/AccountSettingsForms";
import type { AccountActionFn } from "@/components/molecules/_contracts/account-actions";

import {
  SETTINGS_SECTION_IDS as IDS,
  SETTINGS_SECTION_TITLES as TITLES,
  SETTINGS_TITLE,
  SIGN_OUT_EVERYWHERE_ERROR,
  SIGN_OUT_EVERYWHERE_LABEL,
  SIGN_OUT_EVERYWHERE_TEXT,
  settingsBreadcrumb,
  type SettingsPageData,
} from "./settings-page";

/**
 * Presentational body of `/account/settings` (T128). Server-safe (no client
 * code of its own); the page passes the real server actions, tests pass
 * fakes. Renders the caller's email exactly once (inside ProfileForm, as
 * text) and never any identifier.
 */

export interface SettingsActions {
  readonly updateProfile: AccountActionFn;
  readonly changePassword: AccountActionFn;
  readonly deleteAccount: AccountActionFn;
  /** Plain `(formData)` server action for the no-JS "Sign out of all devices" form. */
  readonly signOutEverywhere: (formData: FormData) => Promise<void>;
}

export interface SettingsViewProps {
  readonly data: SettingsPageData;
  readonly actions: SettingsActions;
}

const SECTION = "flex flex-col gap-4";

export function SettingsView({ data, actions }: SettingsViewProps) {
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Breadcrumb items={settingsBreadcrumb()} />
      <Heading level={1}>{SETTINGS_TITLE}</Heading>

      <Card as="section" aria-labelledby={IDS.profile} className={SECTION}>
        <Heading level={2} id={IDS.profile}>
          {TITLES.profile}
        </Heading>
        <ProfileForm
          action={actions.updateProfile}
          displayName={data.user.displayName}
          email={data.user.email}
          headingId={IDS.profile}
        />
      </Card>

      <Card as="section" aria-labelledby={IDS.password} className={SECTION}>
        <Heading level={2} id={IDS.password}>
          {TITLES.password}
        </Heading>
        <ChangePasswordForm action={actions.changePassword} headingId={IDS.password} />
      </Card>

      <Card as="section" aria-labelledby={IDS.sessions} className={SECTION}>
        <Heading level={2} id={IDS.sessions}>
          {TITLES.sessions}
        </Heading>
        {data.sessionsError ? <Notice tone="danger">{SIGN_OUT_EVERYWHERE_ERROR}</Notice> : null}
        <form action={actions.signOutEverywhere} aria-labelledby={IDS.sessions} className="flex min-w-0 flex-col gap-4">
          <Text as="p" tone="secondary">
            {SIGN_OUT_EVERYWHERE_TEXT}
          </Text>
          <div>
            <Button type="submit" variant="secondary" className="w-full xs:w-auto">
              {SIGN_OUT_EVERYWHERE_LABEL}
            </Button>
          </div>
        </form>
      </Card>

      <Card
        as="section"
        aria-labelledby={IDS.delete}
        data-section="danger"
        bordered={false}
        className="flex flex-col gap-4 border border-danger"
      >
        <Heading level={2} id={IDS.delete}>
          {TITLES.delete}
        </Heading>
        <DeleteAccountForm action={actions.deleteAccount} headingId={IDS.delete} />
      </Card>
    </div>
  );
}
