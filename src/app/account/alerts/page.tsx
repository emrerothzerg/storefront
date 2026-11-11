import type { Metadata } from "next";

import { acknowledgeStockAlert, unsubscribeStockAlert } from "@/app/actions/stock-alerts";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";

import { AlertsView } from "../_lib/alerts-view";
import { loadAccountContext } from "../_lib/context";
import { AccountGuestState } from "../_lib/guest-state";
import { loadAlerts } from "../_lib/loaders";
import { accountBreadcrumb, accountMetadata } from "../_lib/page-parts";

export async function generateMetadata(): Promise<Metadata> {
  return accountMetadata("alerts");
}

/** `/account/alerts` (T98, criterion 4). Guests get the sign-in invitation above the empty state (D-T98-1). */
export default async function AccountAlertsPage() {
  const { ownerKey, user } = await loadAccountContext();
  const alerts = loadAlerts(ownerKey);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={accountBreadcrumb("alerts")} />
      {user === null ? <AccountGuestState page="alerts" /> : null}
      <AlertsView alerts={alerts} unsubscribeAction={unsubscribeStockAlert} acknowledgeAction={acknowledgeStockAlert} />
    </div>
  );
}
