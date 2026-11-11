"use client";

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/atoms/Card";
import { Disclosure } from "@/components/atoms/Disclosure";
import { Text } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { AddressCard, addressTitle } from "@/components/molecules/AddressCard";
import { AddressForm } from "@/components/molecules/AddressForm";
import type { AddressActionFn } from "@/components/molecules/_contracts/address-actions";
import type { SavedAddress } from "@/lib/types";
import {
  ADDRESS_BOOK_HEADING_ID,
  ADDRESS_BOOK_LIMIT_NOTICE_ID,
  EMPTY_ADDRESSES_TEXT,
  editFormPrefix,
  planAfterChange,
  sameSnapshot,
  snapshotOf,
  type ChangePlan,
  type ListSnapshot,
} from "./address-book-model";

export interface AddressBookListActions {
  readonly save: AddressActionFn;
  readonly delete: AddressActionFn;
  readonly setDefault: AddressActionFn;
}

export interface AddressBookListProps {
  /** Already sorted / normalised by `sortAddresses`. */
  readonly addresses: readonly SavedAddress[];
  readonly actions: AddressBookListActions;
  readonly cardHeadingLevel: 2 | 3;
}

interface PendingFocus {
  readonly plan: ChangePlan;
  readonly seq: number;
}

function focusLost(doc: Document): boolean {
  const active = doc.activeElement;
  return active === null || active === doc.body || !active.isConnected || !doc.contains(active);
}

function focusElement(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus();
  return true;
}

function cardHeading(list: HTMLUListElement | null, index: number): HTMLElement | null {
  const item = list?.children.item(index);
  return item ? item.querySelector<HTMLElement>("article h2, article h3, article h4") : null;
}

/**
 * Client island for the saved-address list. Renders the `<ul>` of
 * `AddressCard`s, each followed by a sibling "Edit" `Disclosure` holding the
 * edit `AddressForm` (no nested forms; works without JS), or the empty-state
 * text. After a JS action changes the list it announces the result in a
 * polite status region and, if the focused control was removed, moves focus
 * to the next card's heading / the book heading / the limit notice.
 */
export function AddressBookList({ addresses, actions, cardHeadingLevel }: AddressBookListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const current = snapshotOf(addresses);

  // Diff against the previous render during render (React's "store previous
  // value" pattern), so the effect below only applies DOM focus.
  const [seen, setSeen] = useState<ListSnapshot>(current);
  const [pending, setPending] = useState<PendingFocus | null>(null);
  if (!sameSnapshot(seen, current)) {
    const plan = planAfterChange(seen, current);
    setSeen(current);
    if (plan) setPending((p) => ({ plan, seq: (p?.seq ?? 0) + 1 }));
  }

  useEffect(() => {
    if (pending === null || !focusLost(document)) return;
    const { target } = pending.plan;
    if (target.kind === "heading") {
      focusElement(document.getElementById(ADDRESS_BOOK_HEADING_ID));
    } else if (target.kind === "limit") {
      if (!focusElement(document.getElementById(ADDRESS_BOOK_LIMIT_NOTICE_ID))) {
        focusElement(cardHeading(listRef.current, target.fallbackIndex));
      }
    } else if (!focusElement(cardHeading(listRef.current, target.index))) {
      focusElement(document.getElementById(ADDRESS_BOOK_HEADING_ID));
    }
  }, [pending]);

  // Alternate a trailing no-break space so a repeated message is re-announced.
  const announcement =
    pending && pending.plan.announcement !== ""
      ? `${pending.plan.announcement}${pending.seq % 2 === 0 ? " " : ""}`
      : "";

  return (
    <>
      <VisuallyHidden as="p" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </VisuallyHidden>
      {addresses.length === 0 ? (
        <Card tone="sunken" data-slot="address-book-empty">
          <Text tone="secondary">{EMPTY_ADDRESSES_TEXT}</Text>
        </Card>
      ) : (
        <ul ref={listRef} role="list" className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2">
          {addresses.map((address, index) => (
            <li key={address.id} className="flex min-w-0 flex-col gap-2">
              <AddressCard
                address={address}
                actions={{ delete: actions.delete, setDefault: actions.setDefault }}
                headingLevel={cardHeadingLevel}
                className="flex-1"
              />
              <Disclosure
                variant="bordered"
                className="min-w-0 shadow-sm"
                summary={
                  <>
                    Edit
                    <VisuallyHidden>{`, ${addressTitle(address)}`}</VisuallyHidden>
                  </>
                }
              >
                <AddressForm
                  action={actions.save}
                  address={address}
                  showDefaultCheckbox
                  idPrefix={editFormPrefix(index)}
                  formLabel={`Edit address ${index + 1}`}
                  submitContext={addressTitle(address)}
                  compact
                />
              </Disclosure>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
