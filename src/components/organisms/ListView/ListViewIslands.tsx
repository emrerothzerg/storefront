"use client";

import { useActionState, useId, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button, type ButtonVariant } from "@/components/atoms/Button";
import { Checkbox } from "@/components/atoms/Checkbox";
import { Chip } from "@/components/atoms/Chip";
import { Dialog } from "@/components/atoms/Dialog";
import { Disclosure } from "@/components/atoms/Disclosure";
import { FormField } from "@/components/atoms/FormField";
import { Icon } from "@/components/atoms/Icon";
import { Input } from "@/components/atoms/Input";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Select } from "@/components/atoms/Select";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { ListItemRow, type ListItemRowActions } from "@/components/molecules/ListItemRow";
import { isListFailure, listErrorMessage } from "@/components/molecules/WishlistButton";
import {
  LIST_FIELD,
  LIST_INPUT_LIMITS,
  initialListActionState,
  type ListActionFn,
  type ListActionState,
} from "@/components/molecules/_contracts/list-actions";
import type { HeadingLevel } from "@/components/atoms/Typography";
import type { ListItemView } from "@/server/lists/list-service";
import { LISTS_INDEX_PATH, describeAddAllResults } from "./list-view-model";

export const DELETE_CONFIRM_LABEL = "Yes, delete this list and its items";
export const ADD_ALL_NONE_TEXT = "No items in this list are in stock right now.";

const noopSubscribe = () => () => {};

function useMounted(): boolean {
  // false in server markup and during hydration, true afterwards (JS-only controls).
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

function PendingSubmit({
  variant = "primary",
  disabled,
  children,
}: {
  variant?: ButtonVariant;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size="sm" loading={pending} disabled={disabled}>
      {children}
    </Button>
  );
}

function ErrorText({ state }: { state: ListActionState }) {
  return isListFailure(state) ? (
    <p role="alert" className="text-small text-danger">
      {listErrorMessage(state)}
    </p>
  ) : null;
}

function successText(state: ListActionState): string {
  return state !== null && state.ok === true ? state.message : "";
}

/* ------------------------------------------------------------------ Rename */

export interface RenameListFormProps {
  listId: string;
  /** Current name (text only). */
  listName: string;
  action: ListActionFn;
}

/**
 * "Rename list" disclosure (two steps: open, then Save) holding
 * `<form action>` with hidden `listId` and `name` (maxLength 60).
 */
export function RenameListForm({ listId, listName, action }: RenameListFormProps) {
  const uid = useId();
  const inputId = `rename-list-${uid}`;
  const [state, formAction] = useActionState(action, initialListActionState);
  const failed = isListFailure(state);
  const fieldError = failed ? state.fieldErrors?.[LIST_FIELD.name] : undefined;
  const echoed = failed && typeof state.values?.[LIST_FIELD.name] === "string" ? state.values[LIST_FIELD.name] : undefined;
  return (
    <Disclosure
      defaultOpen={failed}
      summary={
        <span className="text-small">
          Rename list<VisuallyHidden> {listName}</VisuallyHidden>
        </span>
      }
    >
      <form action={formAction} className="flex min-w-0 flex-col gap-2">
        <input type="hidden" name={LIST_FIELD.listId} value={listId} />
        <FormField id={inputId} label="New list name" required error={fieldError}>
          {(p) => (
            <Input
              {...p}
              // Re-mount on a new server name or a new failure so the field shows the latest value.
              key={`${listName}|${echoed ?? ""}`}
              name={LIST_FIELD.name}
              maxLength={LIST_INPUT_LIMITS.nameMax}
              defaultValue={echoed ?? listName}
              autoComplete="off"
              className="min-w-0"
            />
          )}
        </FormField>
        <div>
          <PendingSubmit variant="secondary">Save name</PendingSubmit>
        </div>
        <p aria-live="polite" aria-atomic="true" className="text-small text-text-primary">
          {successText(state)}
        </p>
        {fieldError === undefined ? <ErrorText state={state} /> : null}
      </form>
    </Disclosure>
  );
}

/* ------------------------------------------------------------------ Delete */

export interface DeleteListFormProps {
  listId: string;
  listName: string;
  action: ListActionFn;
}

/**
 * Two-step delete. With JS: "Delete list" opens a confirm Dialog whose form
 * posts `confirm=yes`. Without JS (and in server markup): a disclosure with a
 * required "Yes, delete..." checkbox (`confirm=yes`) and a submit button.
 */
export function DeleteListForm({ listId, listName, action }: DeleteListFormProps) {
  const uid = useId();
  const confirmId = `delete-list-confirm-${uid}`;
  const mounted = useMounted();
  const [state, formAction] = useActionState(action, initialListActionState);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(state);
  if (seen !== state) {
    setSeen(state);
    setOpen(false);
  }
  const deleted = state !== null && state.ok === true && state.kind === "deleted";

  if (deleted) {
    return (
      <Notice tone="success" aria-live="polite">
        {state.message} <Link href={LISTS_INDEX_PATH}>Back to your lists</Link>
      </Notice>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {mounted ? (
        <>
          <div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
              <Icon name="trash" size="sm" />
              Delete list<VisuallyHidden> {listName}</VisuallyHidden>
            </Button>
          </div>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            title="Delete this list?"
            description="The list and every item in it will be removed. This cannot be undone."
            alert
            size="sm"
          >
            <form action={formAction} className="flex flex-wrap justify-end gap-2">
              <input type="hidden" name={LIST_FIELD.listId} value={listId} />
              <input type="hidden" name={LIST_FIELD.confirm} value="yes" />
              <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <PendingSubmit variant="danger">Delete list</PendingSubmit>
            </form>
          </Dialog>
        </>
      ) : (
        <Disclosure
          summary={
            <span className="text-small">
              Delete list<VisuallyHidden> {listName}</VisuallyHidden>
            </span>
          }
        >
          <form action={formAction} className="flex min-w-0 flex-col gap-2">
            <input type="hidden" name={LIST_FIELD.listId} value={listId} />
            <p className="text-small text-text-secondary">
              The list and every item in it will be removed. This cannot be undone.
            </p>
            <Checkbox id={confirmId} name={LIST_FIELD.confirm} value="yes" required label={DELETE_CONFIRM_LABEL} />
            <div>
              <PendingSubmit variant="danger">Delete list</PendingSubmit>
            </div>
          </form>
        </Disclosure>
      )}
      <ErrorText state={state} />
    </div>
  );
}

/* ------------------------------------------------------------- Add all */

export interface AddAllToCartFormProps {
  listId: string;
  /** In-stock items the action will try (shown in the button). */
  count: number;
  /** productId -> name, for the per-item result text. */
  names: readonly (readonly [string, string])[];
  action: ListActionFn;
  /** Last addAllToCart state from the page (used as the initial state). */
  initialState?: ListActionState;
}

/** "Add all to cart (N)" form (hidden `listId`) + per-item results as text. */
export function AddAllToCartForm({ listId, count, names, action, initialState = null }: AddAllToCartFormProps) {
  const [state, formAction] = useActionState(action, initialState);
  const nameMap = new Map(names);
  const success = state !== null && state.ok === true && state.kind === "add_all" ? state : null;
  const detail = success ? describeAddAllResults(success.perItem, nameMap) : "";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <form action={formAction}>
        <input type="hidden" name={LIST_FIELD.listId} value={listId} />
        <PendingSubmit disabled={count === 0}>
          <Icon name="cart" size="sm" />
          {`Add all to cart (${count})`}
        </PendingSubmit>
      </form>
      {count === 0 ? <p className="text-small text-text-secondary">{ADD_ALL_NONE_TEXT}</p> : null}
      <div aria-live="polite" aria-atomic="true" data-testid="add-all-results">
        {success ? (
          <Notice tone="success">
            <p>{success.message}</p>
            {detail !== "" ? <p className="break-words">{detail}</p> : null}
          </Notice>
        ) : null}
      </div>
      <ErrorText state={state} />
    </div>
  );
}

/* ------------------------------------------------------------ Switcher */

export interface ListSwitcherEntry {
  readonly href: string;
  readonly label: string;
}

export interface ListSwitcherProps {
  lists: readonly ListSwitcherEntry[];
  /** Navigation hook (tests); defaults to `window.location.assign`. */
  navigate?: (href: string) => void;
}

function defaultNavigate(href: string): void {
  window.location.assign(href);
}

/**
 * "Your other lists": a plain list of links in server markup / without JS;
 * after hydration a `Select` + "Go" form that navigates to the chosen list.
 */
export function ListSwitcher({ lists, navigate = defaultNavigate }: ListSwitcherProps) {
  const uid = useId();
  const selectId = `list-switcher-${uid}`;
  const mounted = useMounted();
  const [choice, setChoice] = useState(lists[0]?.href ?? "");
  if (lists.length === 0) return null;

  if (!mounted) {
    return (
      <nav aria-label="Your other lists" className="min-w-0">
        <p className="text-small font-semibold text-text-primary">Your other lists</p>
        <ul className="mt-1 flex min-w-0 flex-wrap gap-2">
          {lists.map((entry) => (
            <li key={entry.href} className="min-w-0 break-words">
              <Chip as="a" size="sm" href={entry.href} label={entry.label} />
            </li>
          ))}
        </ul>
      </nav>
    );
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = lists.find((entry) => entry.href === choice);
    if (target) navigate(target.href);
  };

  return (
    <form
      method="get"
      action={LISTS_INDEX_PATH}
      onSubmit={handleSubmit}
      aria-label="Switch list"
      className="flex min-w-0 flex-wrap items-end gap-2"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={selectId} className="text-small font-semibold text-text-primary">
          Your other lists
        </label>
        <Select
          id={selectId}
          options={lists.map((entry) => ({ value: entry.href, label: entry.label }))}
          value={choice}
          onChange={(event) => setChoice(event.currentTarget.value)}
          className="min-w-0"
        />
      </div>
      <Button type="submit" variant="outline">
        Go<VisuallyHidden> to list</VisuallyHidden>
      </Button>
    </form>
  );
}

/* --------------------------------------------------------- Shared rows */

async function noAction(): Promise<ListActionState> {
  return null;
}

/** Actions are never invoked: `readOnly` rows render no forms. */
const READ_ONLY_ACTIONS: ListItemRowActions = { update: noAction, remove: noAction, move: noAction };

export interface SharedListItemRowProps {
  item: ListItemView;
  headingLevel: Exclude<HeadingLevel, 1>;
}

/**
 * Read-only row for a shared list. Lives in the client module so no function
 * props cross the server/client boundary.
 */
export function SharedListItemRow({ item, headingLevel }: SharedListItemRowProps) {
  return (
    <ListItemRow
      item={item}
      listId=""
      otherLists={[]}
      actions={READ_ONLY_ACTIONS}
      readOnly
      headingLevel={headingLevel}
      as="div"
    />
  );
}
