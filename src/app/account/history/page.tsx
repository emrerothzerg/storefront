import type { Metadata } from "next";

import { clearHistory, removeFromHistory } from "@/app/actions/views";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";

import { loadAccountContext } from "../_lib/context";
import { AccountGuestState } from "../_lib/guest-state";
import { HistoryView } from "../_lib/history-view";
import { loadHistory } from "../_lib/loaders";
import { accountBreadcrumb, accountMetadata } from "../_lib/page-parts";

export async function generateMetadata(): Promise<Metadata> {
  return accountMetadata("history");
}

/** `/account/history` (T98, criterion 3). Guests get the sign-in invitation above the empty state (D-T98-1). */
export default async function AccountHistoryPage() {
  const { ownerKey, user } = await loadAccountContext();
  const entries = loadHistory(ownerKey);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={accountBreadcrumb("history")} />
      {user === null ? <AccountGuestState page="history" /> : null}
      <HistoryView entries={entries} removeAction={removeFromHistory} clearAction={clearHistory} />
    </div>
  );
}
