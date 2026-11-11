import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { GUEST_NOTICE_TEXT } from "@/components/organisms/AccountHub";

import { accountAuthHref, type AccountPageKey } from "./page-parts";

export interface AccountGuestStateProps {
  /** The account sub-page being rendered; its path becomes the sign-in `next`. */
  readonly page: Exclude<AccountPageKey, "hub">;
}

/** Accessible name of the invitation group (unique per page). */
export const GUEST_STATE_LABEL = "Sign in to your account";

/**
 * Guest invitation for the account sub-pages (D-T98-1): the device-bound
 * notice the hub shows (`GUEST_NOTICE_TEXT`) plus "Sign in" and "Create
 * account" links that return to this page (`?next=<path>`). Server
 * component, pure render: no heading (the page view owns the only `<h1>`),
 * no cookie or DB access. Pages render it above their (still rendered)
 * empty state when there is no signed-in user.
 */
export function AccountGuestState({ page }: AccountGuestStateProps) {
  return (
    <Card role="group" aria-label={GUEST_STATE_LABEL} className="flex flex-col gap-3">
      <Notice tone="info">{GUEST_NOTICE_TEXT}</Notice>
      <div className="flex min-w-0 flex-wrap gap-3">
        <Link href={accountAuthHref("/signin", page)} variant="button">
          Sign in
        </Link>
        <Link href={accountAuthHref("/signup", page)} variant="button" buttonVariant="outline">
          Create account
        </Link>
      </div>
    </Card>
  );
}
