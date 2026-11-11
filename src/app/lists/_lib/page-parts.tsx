import type { BreadcrumbItem } from "@/components/atoms/Breadcrumb";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Heading } from "@/components/atoms/Typography";
import { LIST_FIELD, LIST_INPUT_LIMITS } from "@/components/molecules/_contracts/list-actions";

import { createListFromIndex } from "./list-form-actions";
import { CREATE_ERROR_MESSAGES, type CreateErrorCode } from "./params";

/** Shared copy and small server-only pieces for the lists pages (T99). */

export const LISTS_PATH = "/lists";
export const LISTS_TITLE = "Your lists";
export const LISTS_DESCRIPTION = "Your wish lists and saved-for-later items.";
export const LIST_DELETED_MESSAGE = "List deleted.";
export const LIST_CREATED_MESSAGE = "List created.";
export const SHARED_TITLE_PREFIX = "Shared list: ";

export const CREATE_LIST_HEADING_ID = "create-list-heading";
export const CREATE_LIST_INPUT_ID = "create-list-name";

/** Home > Your lists (current page). */
export function indexBreadcrumb(): BreadcrumbItem[] {
  return [{ label: "Home", href: "/" }, { label: LISTS_TITLE }];
}

/** Home > Your lists > <name> (current page). The name is rendered as text by the atom. */
export function listBreadcrumb(name: string): BreadcrumbItem[] {
  return [{ label: "Home", href: "/" }, { label: LISTS_TITLE, href: LISTS_PATH }, { label: name }];
}

/** `wishlist` / `save_for_later` -> badge text. */
export function listKindLabel(kind: "wishlist" | "save_for_later"): string {
  return kind === "wishlist" ? "Wish list" : "Saved for later";
}

/**
 * "Create a list" (posts `createList` through the PRG adapter; no JS needed).
 * `error` is a code parsed from `?createError=`; only fixed copy is shown.
 */
export function CreateListForm({ error }: { error: CreateErrorCode | null }) {
  return (
    <Card as="section" aria-labelledby={CREATE_LIST_HEADING_ID} className="flex max-w-prose flex-col gap-3">
      <Heading level={2} id={CREATE_LIST_HEADING_ID}>
        Create a list
      </Heading>
      <form action={createListFromIndex} className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end">
        <FormField
          id={CREATE_LIST_INPUT_ID}
          label="List name"
          required
          hint={`Up to ${LIST_INPUT_LIMITS.nameMax} characters.`}
          error={error === null ? undefined : CREATE_ERROR_MESSAGES[error]}
          className="min-w-0 flex-1"
        >
          {(control) => (
            <Input {...control} name={LIST_FIELD.name} maxLength={LIST_INPUT_LIMITS.nameMax} autoComplete="off" />
          )}
        </FormField>
        <Button type="submit">Create list</Button>
      </form>
    </Card>
  );
}
