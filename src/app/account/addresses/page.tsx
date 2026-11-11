import type { Metadata } from "next";

import { deleteAddress, saveAddress, setDefaultAddress } from "@/app/actions/addresses";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { AddressBook } from "@/components/organisms/AddressBook";

import { loadAccountContext } from "../_lib/context";
import { AccountGuestState } from "../_lib/guest-state";
import { loadAddresses } from "../_lib/loaders";
import { accountBreadcrumb, accountMetadata } from "../_lib/page-parts";

export async function generateMetadata(): Promise<Metadata> {
  return accountMetadata("addresses");
}

/**
 * `/account/addresses` (T98). The organism owns the single `<h1>` ("Your addresses").
 * Guests (no signed-in user) get the sign-in invitation above the empty state (D-T98-1).
 */
export default async function AccountAddressesPage() {
  const { ownerKey, user } = await loadAccountContext();
  const addresses = loadAddresses(ownerKey);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={accountBreadcrumb("addresses")} />
      {user === null ? <AccountGuestState page="addresses" /> : null}
      <AddressBook
        addresses={addresses}
        actions={{ save: saveAddress, delete: deleteAddress, setDefault: setDefaultAddress }}
        headingLevel={1}
      />
    </div>
  );
}
