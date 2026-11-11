"use client";

import { useActionState, useId, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { Disclosure } from "@/components/atoms/Disclosure";
import { FormField } from "@/components/atoms/FormField";
import { Icon } from "@/components/atoms/Icon";
import { Image } from "@/components/atoms/Image";
import { Input } from "@/components/atoms/Input";
import { Link } from "@/components/atoms/Link";
import { Price } from "@/components/atoms/Price";
import { Select } from "@/components/atoms/Select";
import { Textarea } from "@/components/atoms/Textarea";
import { Heading, type HeadingLevel } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { isAllowedInternalHref } from "@/content/routes";
import { formatMoney, isValidCents } from "@/lib/money";
import type { ListItemView } from "@/server/lists/list-service";
import { CART_FIELD } from "../_contracts/cart-actions";
import {
  LIST_FIELD,
  LIST_INPUT_LIMITS,
  LIST_PRIORITY_VALUES,
  initialListActionState,
  type ListActionFn,
  type ListActionState,
} from "../_contracts/list-actions";
import { isListFailure, listErrorMessage } from "../WishlistButton/list-error-message";
import {
  NOTE_HINT,
  PRIORITY_LABELS,
  QUANTITY_HINT,
  priorityLabel,
  validateNote,
  validatePriority,
  validateQuantity,
} from "./list-item-validation";

export interface ListOption {
  readonly id: string;
  readonly name: string;
}

/** Plain form action (e.g. a cart server action adapted to `(formData) => ...`). */
export type ListAddToCartAction = (formData: FormData) => void | Promise<unknown>;

export interface ListItemRowActions {
  /** `updateListItem` */
  update: ListActionFn;
  /** `removeFromList` */
  remove: ListActionFn;
  /** `moveListItem` */
  move: ListActionFn;
  /** Receives `productId` (CART_FIELD.productId). Omit to hide "Add to cart". */
  addToCart?: ListAddToCartAction;
}

export interface ListItemRowProps {
  item: ListItemView;
  /** The list this row belongs to (posted as `listId`). */
  listId: string;
  /** Move targets: the viewer's other lists (exclude `listId`). Empty hides "Move". */
  otherLists: readonly ListOption[];
  actions: ListItemRowActions;
  /** Shared (public) view: text only, no forms. */
  readOnly?: boolean;
  /** Level of the product name heading. Defaults to 3. */
  headingLevel?: Exclude<HeadingLevel, 1>;
  /** Root element: `li` (default, put rows in a `<ul role="list">`) or `div`. */
  as?: "li" | "div";
  className?: string;
}

const PRIORITY_OPTIONS = LIST_PRIORITY_VALUES.map((value) => ({
  value,
  label: PRIORITY_LABELS[value],
}));

function safeMoney(cents: number, currency: string): string | null {
  if (!isValidCents(cents)) return null;
  try {
    return formatMoney(cents, currency);
  } catch {
    return null;
  }
}

const noopSubscribe = () => () => {};

/**
 * `/products/<slug>` when it passes `isAllowedInternalHref` (same guard as
 * ListView's `productHref`), else null: an empty slug or one such as ".."
 * renders the name as plain text (D-T85-1).
 */
function productHref(slug: string): string | null {
  if (typeof slug !== "string" || slug.trim() === "") return null;
  const href = `/products/${encodeURIComponent(slug)}`;
  return isAllowedInternalHref(href) ? href : null;
}

function failureOf(state: ListActionState): string | null {
  return isListFailure(state) ? listErrorMessage(state) : null;
}

function successOf(state: ListActionState): string {
  return state !== null && state.ok === true ? state.message : "";
}

function RowRoot({
  as,
  className,
  children,
}: {
  as: "li" | "div";
  className?: string;
  children: ReactNode;
}) {
  const classes = ["min-w-0 border-b border-border-default py-4", className].filter(Boolean).join(" ");
  return as === "li" ? <li className={classes}>{children}</li> : <div className={classes}>{children}</div>;
}

function AddToCartSubmit({ productName }: { productName: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" loading={pending}>
      <Icon name="cart" size="sm" />
      Add
      <VisuallyHidden> {productName}</VisuallyHidden> to cart
    </Button>
  );
}

/**
 * One wish list item: thumbnail, name link, current price, "Price dropped by
 * $X", "Purchased" / "Out of stock" text, desired quantity, priority and note
 * (all React text). Unless `readOnly`: an "Edit details" form (quantity /
 * priority / note with client-side range checks mirroring the server), Move,
 * Delete and Add to cart forms. Every form posts without JS.
 */
export function ListItemRow({
  item,
  listId,
  otherLists,
  actions,
  readOnly = false,
  headingLevel = 3,
  as = "li",
  className,
}: ListItemRowProps) {
  const uid = useId();
  const [removeState, removeAction, isRemovePending] = useActionState(
    actions.remove,
    initialListActionState,
  );
  const [moveState, moveAction, isMovePending] = useActionState(actions.move, initialListActionState);
  const [lastAction, setLastAction] = useState<"move" | "remove" | null>(null);
  const [seenMove, setSeenMove] = useState(moveState);
  const [seenRemove, setSeenRemove] = useState(removeState);
  if (seenMove !== moveState) {
    setSeenMove(moveState);
    setLastAction("move");
  }
  if (seenRemove !== removeState) {
    setSeenRemove(removeState);
    setLastAction("remove");
  }

  const product = item.product;

  const removeForm = (label: ReactNode) => (
    <form action={removeAction}>
      <input type="hidden" name={LIST_FIELD.listId} value={listId} />
      <input type="hidden" name={LIST_FIELD.productId} value={item.productId} />
      <Button type="submit" variant="ghost" size="sm" loading={isRemovePending}>
        {isRemovePending ? null : <Icon name="trash" size="sm" />}
        Delete
        <VisuallyHidden> {label}</VisuallyHidden>
      </Button>
    </form>
  );

  const removeError = failureOf(removeState);
  const moveError = failureOf(moveState);
  const status =
    lastAction === "move" ? successOf(moveState) : lastAction === "remove" ? successOf(removeState) : "";

  if (product === null) {
    return (
      <RowRoot as={as} className={className}>
        <article className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-body text-text-secondary">This item is no longer available</p>
          {readOnly ? null : removeForm("unavailable item")}
        </article>
        {readOnly ? null : (
          <>
            <p aria-live="polite" aria-atomic="true" className="sr-only">
              {status}
            </p>
            {removeError ? (
              <p role="alert" className="text-small text-danger">
                {removeError}
              </p>
            ) : null}
          </>
        )}
      </RowRoot>
    );
  }

  const nameId = `list-item-name-${uid}`;
  const dropped =
    item.priceDroppedByCents !== null && item.priceDroppedByCents > 0
      ? safeMoney(item.priceDroppedByCents, product.currency)
      : null;
  const canAddToCart = !readOnly && actions.addToCart !== undefined && item.available;
  // React's form action type wants `Promise<void>`; the return value is ignored either way.
  const cartAction = actions.addToCart as ((formData: FormData) => void | Promise<void>) | undefined;
  const moveSelectId = `list-item-move-${uid}`;
  const nameHref = productHref(product.slug);

  return (
    <RowRoot as={as} className={className}>
      <article
        aria-labelledby={nameId}
        aria-busy={isRemovePending || isMovePending || undefined}
        className="flex min-w-0 flex-col gap-3 sm:flex-row"
      >
        <Image
          src={product.imageUrl}
          alt={product.name}
          width={96}
          height={96}
          rounded
          className="size-24 shrink-0 object-cover"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Heading level={headingLevel} size="h4" id={nameId} className="break-words">
            {nameHref !== null ? (
              <Link href={nameHref} className="inline-flex min-h-touch items-center">
                {product.name}
              </Link>
            ) : (
              product.name
            )}
          </Heading>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Price amountCents={product.priceCents} currency={product.currency} />
            {dropped !== null ? (
              <p className="text-small font-semibold text-success">{`Price dropped by ${dropped}`}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {item.purchasedSinceAdded ? <Badge tone="success">Purchased</Badge> : null}
            {!item.available ? <Badge tone="warning">Out of stock</Badge> : null}
          </div>
          <dl className="flex flex-wrap gap-x-4 gap-y-1 text-small">
            <div className="flex gap-1">
              <dt className="text-text-secondary">Wants:</dt>
              <dd>{item.quantityDesired}</dd>
            </div>
            <div className="flex gap-1">
              <dt className="text-text-secondary">Priority:</dt>
              <dd>{priorityLabel(item.priority)}</dd>
            </div>
          </dl>
          {item.note !== null && item.note !== "" ? (
            <p className="whitespace-pre-line break-words text-small" data-testid="list-item-note">
              <span className="text-text-secondary">Note: </span>
              {item.note}
            </p>
          ) : null}

          {readOnly ? null : (
            <>
              <UpdateItemForm item={item} listId={listId} productName={product.name} action={actions.update} />
              <div className="flex flex-wrap items-end gap-2">
                {canAddToCart && cartAction ? (
                  <form action={cartAction}>
                    <input type="hidden" name={CART_FIELD.productId} value={item.productId} />
                    <AddToCartSubmit productName={product.name} />
                  </form>
                ) : null}
                {otherLists.length > 0 ? (
                  <form action={moveAction} className="flex min-w-0 flex-wrap items-end gap-2">
                    <input type="hidden" name={LIST_FIELD.listId} value={listId} />
                    <input type="hidden" name={LIST_FIELD.productId} value={item.productId} />
                    <div className="flex min-w-0 flex-col gap-1">
                      <label htmlFor={moveSelectId} className="text-small text-text-primary">
                        Move to
                      </label>
                      <Select
                        id={moveSelectId}
                        name={LIST_FIELD.toListId}
                        options={otherLists.map((list) => ({ value: list.id, label: list.name }))}
                        className="min-w-0"
                      />
                    </div>
                    <Button type="submit" variant="secondary" size="sm" loading={isMovePending}>
                      Move
                      <VisuallyHidden> {product.name}</VisuallyHidden>
                    </Button>
                  </form>
                ) : null}
                {removeForm(product.name)}
              </div>
              <p aria-live="polite" aria-atomic="true" className="sr-only">
                {status}
              </p>
              {moveError ? (
                <p role="alert" className="text-small text-danger">
                  {moveError}
                </p>
              ) : null}
              {removeError ? (
                <p role="alert" className="text-small text-danger">
                  {removeError}
                </p>
              ) : null}
            </>
          )}
        </div>
      </article>
    </RowRoot>
  );
}

type EditableField = "quantityDesired" | "priority" | "note";

interface UpdateItemFormProps {
  item: ListItemView;
  listId: string;
  productName: string;
  action: ListActionFn;
}

function initialNote(state: ListActionState, note: string | null): string {
  if (isListFailure(state) && typeof state.values?.note === "string") return state.values.note;
  return note ?? "";
}

function UpdateItemForm({ item, listId, productName, action }: UpdateItemFormProps) {
  const uid = useId();
  const ids = {
    quantityDesired: `list-item-qty-${uid}`,
    priority: `list-item-priority-${uid}`,
    note: `list-item-note-${uid}`,
  } as const;
  // Native min/max validation stays on without JS; after hydration the inline checks take over.
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [state, formAction, isPending] = useActionState(action, initialListActionState);

  const [quantity, setQuantity] = useState(String(item.quantityDesired));
  const [priority, setPriority] = useState(String(item.priority));
  const [note, setNote] = useState(() => initialNote(state, item.note));
  const [touched, setTouched] = useState<ReadonlySet<EditableField>>(new Set());
  const [editedSinceState, setEditedSinceState] = useState<ReadonlySet<EditableField>>(new Set());
  const [open, setOpen] = useState(() => isListFailure(state));

  const serverKey = `${item.quantityDesired}|${item.priority}|${item.note ?? ""}`;
  const [syncedKey, setSyncedKey] = useState(serverKey);
  if (syncedKey !== serverKey) {
    setSyncedKey(serverKey);
    setQuantity(String(item.quantityDesired));
    setPriority(String(item.priority));
    setNote(item.note ?? "");
  }
  const [seenState, setSeenState] = useState(state);
  if (seenState !== state) {
    setSeenState(state);
    setEditedSinceState(new Set());
    if (isListFailure(state)) setOpen(true);
  }

  const clientErrors: Record<EditableField, string | null> = {
    quantityDesired: validateQuantity(quantity),
    priority: validatePriority(priority),
    note: validateNote(note),
  };
  const fieldError = (field: EditableField): string | undefined => {
    if (touched.has(field) && clientErrors[field] !== null) return clientErrors[field] ?? undefined;
    if (isListFailure(state) && !editedSinceState.has(field)) return state.fieldErrors?.[field];
    return undefined;
  };
  const hasFieldErrors =
    isListFailure(state) && state.fieldErrors !== undefined && Object.keys(state.fieldErrors).length > 0;
  const formError = isListFailure(state) && !hasFieldErrors ? listErrorMessage(state) : null;

  const edit = (field: EditableField) => {
    setTouched((prev) => new Set(prev).add(field));
    setEditedSinceState((prev) => new Set(prev).add(field));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    const invalid = (Object.keys(clientErrors) as EditableField[]).filter((f) => clientErrors[f] !== null);
    if (invalid.length === 0) return;
    // Blocks the action; shows every inline error and focuses the first bad field.
    event.preventDefault();
    setTouched(new Set<EditableField>(["quantityDesired", "priority", "note"]));
    const first = invalid[0];
    if (first) document.getElementById(ids[first])?.focus();
  };

  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      summary={
        <span className="text-small">
          Edit details<VisuallyHidden> for {productName}</VisuallyHidden>
        </span>
      }
    >
      <form
        action={formAction}
        onSubmit={handleSubmit}
        noValidate={hydrated}
        className="flex min-w-0 flex-col gap-3"
      >
        <input type="hidden" name={LIST_FIELD.listId} value={listId} />
        <input type="hidden" name={LIST_FIELD.productId} value={item.productId} />
        <div className="flex min-w-0 flex-wrap gap-3">
          <FormField
            id={ids.quantityDesired}
            label="Quantity wanted"
            hint={QUANTITY_HINT}
            error={fieldError("quantityDesired")}
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                name={LIST_FIELD.quantityDesired}
                inputMode="numeric"
                min={LIST_INPUT_LIMITS.quantityMin}
                max={LIST_INPUT_LIMITS.quantityMax}
                step={1}
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.currentTarget.value);
                  edit("quantityDesired");
                }}
                className="w-24"
              />
            )}
          </FormField>
          <FormField id={ids.priority} label="Priority" error={fieldError("priority")}>
            {(p) => (
              <Select
                {...p}
                name={LIST_FIELD.priority}
                options={PRIORITY_OPTIONS}
                value={priority}
                onChange={(e) => {
                  setPriority(e.currentTarget.value);
                  edit("priority");
                }}
              />
            )}
          </FormField>
        </div>
        <FormField id={ids.note} label="Note" hint={NOTE_HINT} error={fieldError("note")}>
          {(p) => (
            <Textarea
              {...p}
              name={LIST_FIELD.note}
              maxLength={LIST_INPUT_LIMITS.noteMax}
              showCount
              rows={2}
              value={note}
              onChange={(e) => {
                setNote(e.currentTarget.value);
                edit("note");
              }}
            />
          )}
        </FormField>
        <div>
          <Button type="submit" variant="secondary" size="sm" loading={isPending}>
            Save
            <VisuallyHidden> changes to {productName}</VisuallyHidden>
          </Button>
        </div>
        <p aria-live="polite" aria-atomic="true" className="sr-only">
          {successOf(state)}
        </p>
        {formError ? (
          <p role="alert" className="text-small text-danger">
            {formError}
          </p>
        ) : null}
      </form>
    </Disclosure>
  );
}
