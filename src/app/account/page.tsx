import type { Metadata } from "next";

import { acknowledgeStockAlert } from "@/app/actions/stock-alerts";
import { signOut } from "@/app/actions/auth";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { AccountHub } from "@/components/organisms/AccountHub";

import { loadAccountContext } from "./_lib/context";
import { loadHub } from "./_lib/loaders";
import { accountBreadcrumb, accountMetadata } from "./_lib/page-parts";

export async function generateMetadata(): Promise<Metadata> {
  return accountMetadata("hub");
}

/**
 * `/account` (T98). Guests (no cookie, garbage cookie, unknown owner) get the
 * guest hub with the device-bound notice and status 200 — never a 404, never
 * a minted session (criteria 1/6). With no cookie nothing reads the DB.
 * AccountHub binds `prevState = null` on both actions itself.
 */
export default async function AccountPage() {
  const { ownerKey, user } = await loadAccountContext();
  const { counts, backInStock } = loadHub(ownerKey);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={accountBreadcrumb("hub")} />
      <AccountHub
        user={user === null ? null : { displayName: user.displayName, email: user.email }}
        counts={counts}
        backInStock={backInStock}
        actions={{ signOut, acknowledgeAlert: acknowledgeStockAlert }}
      />
    </div>
  );
}
