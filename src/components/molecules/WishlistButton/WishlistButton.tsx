"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Icon } from "@/components/atoms/Icon";
import { IconButton } from "@/components/atoms/IconButton";
import { Select } from "@/components/atoms/Select";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import {
  LIST_FIELD,
  initialListActionState,
  type ListActionFn,
  type ListActionState,
} from "../_contracts/list-actions";
import { isListFailure, listErrorMessage } from "./list-error-message";

export interface WishlistListOption {
  readonly id: string;
  readonly name: string;
}

export type WishlistButtonSize = "sm" | "md" | "lg";
export type WishlistButtonVariant = "icon" | "button";

export interface WishlistButtonProps {
  productId: string;
  /** Posted for revalidation of the product page only. */
  productSlug: string;
  /** Used in the accessible name ("Add <name> to Wish List"); rendered as text only. */
  productName: string;
  /** Whether the product is in `listId` (or the default wish list) right now. */
  inList: boolean;
  /** `addToList` server action. */
  addAction: ListActionFn;
  /** `removeFromList` server action. It needs a list id: pass `listId` whenever `inList` is true. */
  removeAction: ListActionFn;
  /** Target list; `null`/absent = the default wish list. */
  listId?: string | null;
  /** The viewer's wish lists. With more than one, a "Save to" select is shown while adding. */
  lists?: readonly WishlistListOption[];
  /** Defaults to "md". Every size keeps a 44px target. */
  size?: WishlistButtonSize;
  /** `icon` = heart icon button (default); `button` = heart + "Add to Wish List" text. */
  variant?: WishlistButtonVariant;
  /**
   * `variant="button"` only: stretch the pill to the container width so it
   * lines up with the buy box's "Add to cart" / "Buy Now" pills. Default false.
   */
  fullWidth?: boolean;
  className?: string;
}

export const WISHLIST_ADDED_MESSAGE = "Added to your Wish List";
export const WISHLIST_ALREADY_MESSAGE = "Already in your Wish List";
export const WISHLIST_REMOVED_MESSAGE = "Removed from your Wish List";

interface Outcome {
  readonly inList?: boolean;
  readonly listId?: string;
  readonly announcement: string;
  readonly error: string | null;
}

/** What a settled action state means for the button. `null` = nothing yet. */
function outcomeOf(state: ListActionState): Outcome | null {
  if (state === null) return null;
  if (isListFailure(state)) return { announcement: "", error: listErrorMessage(state) };
  const listId = typeof state.listId === "string" && state.listId !== "" ? state.listId : undefined;
  switch (state.kind) {
    case "added":
      return { inList: true, listId, announcement: WISHLIST_ADDED_MESSAGE, error: null };
    case "already_present":
      return { inList: true, listId, announcement: WISHLIST_ALREADY_MESSAGE, error: null };
    case "removed":
      return { inList: false, announcement: WISHLIST_REMOVED_MESSAGE, error: null };
    default:
      return { announcement: state.message, error: null };
  }
}

function displayName(name: string): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed === "" ? "this item" : trimmed;
}

export function wishlistLabel(productName: string, inList: boolean): string {
  const name = displayName(productName);
  return inList ? `Remove ${name} from Wish List` : `Add ${name} to Wish List`;
}

/**
 * Heart toggle for one product. ONE `<form>` whose action is `addAction` or
 * `removeAction` depending on the current state, with hidden `productId`,
 * `productSlug` and `listId` (or a "Save to" select), so it posts without JS.
 * With JS: pending spinner, `aria-pressed` flips from the action result, the
 * result is announced politely and errors go to `role="alert"`.
 */
export function WishlistButton({
  productId,
  productSlug,
  productName,
  inList,
  addAction,
  removeAction,
  listId = null,
  lists,
  size = "md",
  variant = "icon",
  fullWidth = false,
  className,
}: WishlistButtonProps) {
  const uid = useId();
  const selectId = `wishlist-list-${uid}`;
  const [addState, addFormAction, isAddPending] = useActionState(addAction, initialListActionState);
  const [removeState, removeFormAction, isRemovePending] = useActionState(
    removeAction,
    initialListActionState,
  );

  // Initial values also honour a state present on first render (no-JS replay).
  const [current, setCurrent] = useState(() => {
    const removed = outcomeOf(removeState)?.inList;
    const added = outcomeOf(addState)?.inList;
    return removed ?? added ?? inList;
  });
  const [activeListId, setActiveListId] = useState<string | null>(
    () => outcomeOf(addState)?.listId ?? listId,
  );
  const [feedback, setFeedback] = useState<Outcome | null>(
    () => outcomeOf(removeState) ?? outcomeOf(addState),
  );
  const [syncedInList, setSyncedInList] = useState(inList);
  const [syncedListId, setSyncedListId] = useState(listId);
  const [seenAdd, setSeenAdd] = useState(addState);
  const [seenRemove, setSeenRemove] = useState(removeState);

  // Server data wins when it changes (revalidation after the action).
  if (syncedInList !== inList) {
    setSyncedInList(inList);
    setCurrent(inList);
  }
  if (syncedListId !== listId) {
    setSyncedListId(listId);
    setActiveListId(listId);
  }
  const applyOutcome = (outcome: Outcome | null) => {
    if (outcome === null) return;
    setFeedback(outcome);
    if (outcome.inList !== undefined) setCurrent(outcome.inList);
    if (outcome.listId !== undefined) setActiveListId(outcome.listId);
  };
  if (seenAdd !== addState) {
    setSeenAdd(addState);
    applyOutcome(outcomeOf(addState));
  }
  if (seenRemove !== removeState) {
    setSeenRemove(removeState);
    applyOutcome(outcomeOf(removeState));
  }

  const pending = isAddPending || isRemovePending;
  const label = wishlistLabel(productName, current);
  const showPicker = !current && lists !== undefined && lists.length > 1;
  const pickerDefault =
    lists !== undefined && lists.some((list) => list.id === activeListId)
      ? (activeListId ?? undefined)
      : lists?.[0]?.id;
  const buttonSize = size;
  const iconSize = size === "lg" ? "md" : "sm";

  return (
    <form
      action={current ? removeFormAction : addFormAction}
      className={["flex min-w-0 flex-col gap-2", className].filter(Boolean).join(" ")}
    >
      <input type="hidden" name={LIST_FIELD.productId} value={productId} />
      <input type="hidden" name={LIST_FIELD.productSlug} value={productSlug} />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* The "Save to" picker (when shown) precedes the button so focus meets it first. */}
        {showPicker ? (
          <div className="flex min-w-0 items-center gap-2">
            <label htmlFor={selectId} className="text-small text-text-primary">
              Save to
            </label>
            <Select
              id={selectId}
              name={LIST_FIELD.listId}
              defaultValue={pickerDefault}
              options={(lists ?? []).map((list) => ({ value: list.id, label: list.name }))}
              className="min-w-0"
            />
          </div>
        ) : (
          <input type="hidden" name={LIST_FIELD.listId} value={activeListId ?? ""} />
        )}
        {variant === "icon" ? (
          <IconButton
            type="submit"
            icon={current ? "heart-filled" : "heart"}
            label={label}
            pressed={current}
            loading={pending}
            size={size}
            variant="outline"
          />
        ) : (
          <Button
            type="submit"
            variant="secondary"
            size={buttonSize}
            loading={pending}
            fullWidth={fullWidth}
            aria-pressed={current}
            className="aria-pressed:border-accent aria-pressed:bg-accent-subtle aria-pressed:text-accent"
          >
            {pending ? null : <Icon name={current ? "heart-filled" : "heart"} size={iconSize} />}
            {/* One inline span, so the flex gap never lands between the words: visible
                "Add to Wish List", accessible name "Add <name> to Wish List" (U17). */}
            <span data-slot="wishlist-label">
              {current ? "Remove" : "Add"}
              <VisuallyHidden> {displayName(productName)}</VisuallyHidden>
              {current ? " from Wish List" : " to Wish List"}
            </span>
          </Button>
        )}
      </div>
      <p aria-live="polite" aria-atomic="true" className="sr-only" data-testid="wishlist-status">
        {feedback?.announcement ?? ""}
      </p>
      {feedback?.error ? (
        <p role="alert" className="text-small text-danger">
          {feedback.error}
        </p>
      ) : null}
    </form>
  );
}
