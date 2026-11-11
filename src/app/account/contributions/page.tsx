import type { Metadata } from "next";

import { voteReviewHelpful } from "@/app/actions/reviews";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";

import { loadAccountContext } from "../_lib/context";
import { AccountGuestState } from "../_lib/guest-state";
import { ContributionsView } from "../_lib/contributions-view";
import { loadContributions } from "../_lib/loaders";
import { accountBreadcrumb, accountMetadata } from "../_lib/page-parts";

export async function generateMetadata(): Promise<Metadata> {
  return accountMetadata("contributions");
}

/** `/account/contributions` (T98). Guests get the sign-in invitation above the empty state (D-T98-1). */
export default async function AccountContributionsPage() {
  const { ownerKey, user } = await loadAccountContext();
  const contributions = loadContributions(ownerKey);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={accountBreadcrumb("contributions")} />
      {user === null ? <AccountGuestState page="contributions" /> : null}
      <ContributionsView contributions={contributions} voteReviewAction={voteReviewHelpful} />
    </div>
  );
}
