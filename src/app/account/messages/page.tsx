import type { Metadata } from "next";

import { Breadcrumb } from "@/components/atoms/Breadcrumb";

import { loadAccountContext } from "../_lib/context";
import { AccountGuestState } from "../_lib/guest-state";
import { loadMessages } from "../_lib/loaders";
import { MessagesView } from "../_lib/messages-view";
import { accountBreadcrumb, accountMetadata } from "../_lib/page-parts";

export async function generateMetadata(): Promise<Metadata> {
  return accountMetadata("messages");
}

/** `/account/messages` (T98). Guests get the sign-in invitation above the empty state (D-T98-1). */
export default async function AccountMessagesPage() {
  const { ownerKey, user } = await loadAccountContext();
  const messages = loadMessages(ownerKey);
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={accountBreadcrumb("messages")} />
      {user === null ? <AccountGuestState page="messages" /> : null}
      <MessagesView messages={messages} />
    </div>
  );
}
