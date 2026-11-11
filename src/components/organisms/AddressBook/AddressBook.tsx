import { Card } from "@/components/atoms/Card";
import { Notice } from "@/components/atoms/Notice";
import { Heading, Text } from "@/components/atoms/Typography";
import { AddressForm } from "@/components/molecules/AddressForm";
import type { SavedAddress } from "@/lib/types";
import { AddressBookList, type AddressBookListActions } from "./AddressBookList";
import {
  ADD_ADDRESS_TITLE,
  ADDRESS_BOOK_ADD_FORM_PREFIX,
  ADDRESS_BOOK_ADD_HEADING_ID,
  ADDRESS_BOOK_HEADING_ID,
  ADDRESS_BOOK_LIMIT_NOTICE_ID,
  ADDRESS_BOOK_TITLE,
  FIRST_ADDRESS_DEFAULT_TEXT,
  limitReachedText,
  normaliseLimit,
  sortAddresses,
} from "./address-book-model";

export type AddressBookActions = AddressBookListActions;

export interface AddressBookProps {
  /** From `getAddressService().list(ownerKey)` (any order; the default is sorted first here). */
  addresses: readonly SavedAddress[];
  /** `saveAddress`, `deleteAddress`, `setDefaultAddress` from `src/app/actions/addresses.ts`, unwrapped. */
  actions: AddressBookActions;
  /** Address cap. Defaults to the service's 10; invalid values fall back to it. */
  limit?: number;
  /** Level of the "Your addresses" heading (1 = page h1). Card and "Add" headings sit one level below. */
  headingLevel?: 1 | 2;
  className?: string;
}

/**
 * Account address-book body (server-safe, no `"use client"`): heading, the
 * saved addresses (client island `AddressBookList`) and the "Add a new
 * address" form, or the limit notice once the book is full. Every mutation is
 * a `<form action>` that works without JavaScript; address text is rendered
 * only as React text; no id / name / data-* / aria-* attribute carries address
 * data.
 */
export function AddressBook({ addresses, actions, limit, headingLevel = 1, className }: AddressBookProps) {
  const max = normaliseLimit(limit);
  const sorted = sortAddresses(addresses);
  const atLimit = sorted.length >= max;
  const subLevel = headingLevel === 1 ? 2 : 3;

  return (
    <section
      aria-labelledby={ADDRESS_BOOK_HEADING_ID}
      className={["flex min-w-0 flex-col gap-6 break-words", className].filter(Boolean).join(" ")}
    >
      <Heading level={headingLevel} id={ADDRESS_BOOK_HEADING_ID} tabIndex={-1} className="break-words">
        {ADDRESS_BOOK_TITLE}
      </Heading>
      <AddressBookList addresses={sorted} actions={actions} cardHeadingLevel={subLevel} />
      <Card
        as="section"
        aria-labelledby={ADDRESS_BOOK_ADD_HEADING_ID}
        data-slot="address-book-add"
        className="flex flex-col gap-4"
      >
        <Heading level={subLevel} size="h3" id={ADDRESS_BOOK_ADD_HEADING_ID}>
          {ADD_ADDRESS_TITLE}
        </Heading>
        {atLimit ? (
          <Notice tone="info" id={ADDRESS_BOOK_LIMIT_NOTICE_ID} tabIndex={-1}>
            {limitReachedText(max)}
          </Notice>
        ) : (
          <>
            {sorted.length === 0 ? <Text tone="secondary">{FIRST_ADDRESS_DEFAULT_TEXT}</Text> : null}
            <AddressForm
              action={actions.save}
              showDefaultCheckbox={sorted.length > 0}
              idPrefix={ADDRESS_BOOK_ADD_FORM_PREFIX}
              formLabel={ADD_ADDRESS_TITLE}
              submitLabel="Add address"
            />
          </>
        )}
      </Card>
    </section>
  );
}
