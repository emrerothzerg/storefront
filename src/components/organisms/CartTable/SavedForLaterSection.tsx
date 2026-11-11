"use client";

import { useActionState, useId, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Price } from "@/components/atoms/Price";
import { Heading, Text } from "@/components/atoms/Typography";
import { WishlistButton, isListFailure, listErrorMessage } from "@/components/molecules/WishlistButton";
import {
  CART_FIELD_V2,
  initialCartActionStateV2,
  type CartActionFnV2,
} from "@/components/molecules/_contracts/cart-actions";
import {
  LIST_FIELD,
  initialListActionState,
  type ListActionFn,
} from "@/components/molecules/_contracts/list-actions";
import { isAllowedInternalHref } from "@/content/routes";
import { formatMoney, isValidCents } from "@/lib/money";
import type { SavedForLaterLine } from "@/server/cart/cart-service";

export interface SavedForLaterActions {
  /** `moveToCart` server action (posts `productId`). */
  readonly moveToCart: CartActionFnV2;
  /** `removeFromList` server action; posts `listId` (the save-for-later list) + `productId`. */
  readonly removeSaved: ListActionFn;
  /** `addToList` server action; renders a WishlistButton ("Add <name> to Wish List") per available row. */
  readonly addToList?: ListActionFn;
}

export interface SavedForLaterSectionProps {
  items: readonly SavedForLaterLine[];
  actions: SavedForLaterActions;
  /** Id of the session's save-for-later list; `null` hides the Delete forms (nothing to post). */
  saveForLaterListId: string | null;
  /** Defaults to 2. */
  headingLevel?: 2 | 3;
  className?: string;
}

/** Shown for a saved item whose product left the catalogue. */
export const SAVED_UNAVAILABLE_NAME = "Unavailable product";

export type SavedAvailability = "in_stock" | "out_of_stock" | "gone";

/**
 * "gone" when the product vanished (`product` null) or the service marks the
 * item `reason: "unavailable"` (unpublished after saving, D-T82-4).
 */
export function savedAvailability(line: Pick<SavedForLaterLine, "product" | "available" | "reason">): SavedAvailability {
  if (line.product === null || line.reason === "unavailable") return "gone";
  return line.available ? "in_stock" : "out_of_stock";
}

export const SAVED_AVAILABILITY_TEXT: Record<SavedAvailability, string> = {
  in_stock: "In stock",
  out_of_stock: "Out of stock",
  gone: "No longer available",
};

/**
 * `/products/<slug>` when it passes `isAllowedInternalHref` (same guard as
 * ListView's `productHref`), else null (empty slug, or a rejected one such as
 * ".." or "."); the name then renders as plain text.
 */
export function savedProductHref(slug: string | null | undefined): string | null {
  if (typeof slug !== "string" || slug.trim() === "") return null;
  const href = `/products/${encodeURIComponent(slug)}`;
  return isAllowedInternalHref(href) ? href : null;
}

/** "Saved for later (N item[s])". */
export function savedHeading(count: number): string {
  return `Saved for later (${count} ${count === 1 ? "item" : "items"})`;
}

function tryFormat(amountCents: number, currency: string): string | null {
  if (!isValidCents(amountCents)) return null;
  try {
    return formatMoney(amountCents, currency);
  } catch {
    return null;
  }
}

/** Positive price drop as display text, else null. */
export function priceDropText(droppedByCents: number | null, currency: string): string | null {
  if (droppedByCents === null || !isValidCents(droppedByCents) || droppedByCents === 0) return null;
  const formatted = tryFormat(droppedByCents, currency);
  return formatted === null ? null : `Price dropped by ${formatted}`;
}

interface RowProps {
  line: SavedForLaterLine;
  actions: SavedForLaterActions;
  listId: string | null;
}

function SavedForLaterRow({ line, actions, listId }: RowProps) {
  const uid = useId();
  const availabilityId = `saved-availability-${uid}`;
  const [moveState, moveAction, isMovePending] = useActionState(actions.moveToCart, initialCartActionStateV2);
  const [removeState, removeAction, isRemovePending] = useActionState(actions.removeSaved, initialListActionState);

  const product = line.product;
  const name = product?.name ?? SAVED_UNAVAILABLE_NAME;
  const currency = product?.currency ?? "USD";
  const availability = savedAvailability(line);
  // D-T82-4: an unpublished product (still present, but withdrawn) renders
  // like an unpublished cart line: no product link, no price, no Move to
  // cart or Wish List forms, only Delete.
  const withdrawn = product !== null && availability === "gone";
  const href = withdrawn ? null : savedProductHref(product?.slug);
  const canMove = availability === "in_stock";
  const dropText = withdrawn ? null : priceDropText(line.priceDroppedByCents, currency);
  const showPrice = !withdrawn && line.priceCents !== null && isValidCents(line.priceCents);

  const moveError = moveState?.ok === false ? moveState.error.message : null;
  const removeError = isListFailure(removeState) ? listErrorMessage(removeState) : null;

  return (
    <div
      className="flex min-w-0 flex-col gap-3 py-4"
      aria-busy={isMovePending || isRemovePending || undefined}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Image
          src={product?.imageUrl ?? null}
          alt={name}
          width={64}
          height={64}
          sizes="64px"
          rounded
          className="size-16 shrink-0 object-cover"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="min-w-0 break-words">
            {href !== null ? (
              <Link href={href} variant="inline" className="inline-flex min-h-touch items-center font-semibold">
                {name}
              </Link>
            ) : (
              <Text as="span" className="font-semibold">
                {name}
              </Text>
            )}
          </span>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            {showPrice && line.priceCents !== null ? (
              <Price amountCents={line.priceCents} currency={currency} display="superscript" />
            ) : null}
            {dropText !== null ? (
              <Text as="span" variant="small" tone="success">
                {dropText}
              </Text>
            ) : null}
          </div>
          <Text
            as="p"
            variant="small"
            tone={canMove ? "success" : "secondary"}
            id={availabilityId}
            data-testid="saved-availability"
          >
            {SAVED_AVAILABILITY_TEXT[availability]}
          </Text>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {withdrawn ? null : (
          <form action={moveAction}>
            <input type="hidden" name={CART_FIELD_V2.productId} value={line.productId} />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={isMovePending}
              disabled={!canMove}
              aria-describedby={canMove ? undefined : availabilityId}
              aria-label={`${canMove ? "Move to cart" : "Unavailable"}: ${name}`}
            >
              {canMove ? "Move to cart" : "Unavailable"}
            </Button>
          </form>
        )}
        {listId !== null ? (
          <form action={removeAction}>
            <input type="hidden" name={LIST_FIELD.listId} value={listId} />
            <input type="hidden" name={LIST_FIELD.productId} value={line.productId} />
            <Button
              type="submit"
              variant="danger"
              size="sm"
              loading={isRemovePending}
              aria-label={`Delete: ${name}`}
            >
              Delete
            </Button>
          </form>
        ) : null}
        {actions.addToList !== undefined && product !== null && !withdrawn ? (
          <WishlistButton
            productId={line.productId}
            productSlug={product.slug}
            productName={name}
            inList={false}
            addAction={actions.addToList}
            removeAction={actions.removeSaved}
            variant="button"
            size="sm"
          />
        ) : null}
      </div>

      {moveError !== null ? (
        <p role="alert" className="text-small text-danger" data-testid="saved-move-error">
          {moveError}
        </p>
      ) : null}
      {removeError !== null ? (
        <p role="alert" className="text-small text-danger" data-testid="saved-remove-error">
          {removeError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Saved for later" list under the cart. Each row has plain `<form action>`s
 * (Move to cart, Delete, optional Add to Wish List) with hidden ids, so it
 * works without JS. Renders only a polite live region when there are no
 * items, so a later count change (e.g. the last item deleted) is announced.
 */
export function SavedForLaterSection({
  items,
  actions,
  saveForLaterListId,
  headingLevel = 2,
  className,
}: SavedForLaterSectionProps) {
  const uid = useId();
  const headingId = `saved-for-later-${uid}`;
  const count = items.length;

  const [previousCount, setPreviousCount] = useState(count);
  const [announcement, setAnnouncement] = useState("");
  if (previousCount !== count) {
    setPreviousCount(count);
    setAnnouncement(count === 0 ? "Saved for later is empty" : `${savedHeading(count)}`);
  }

  const liveRegion = (
    <p aria-live="polite" aria-atomic="true" className="sr-only" data-testid="saved-live-region">
      {announcement}
    </p>
  );

  if (count === 0) return liveRegion;

  return (
    <>
      {liveRegion}
      <Card
        as="section"
        aria-labelledby={headingId}
        className={["flex flex-col gap-2", className].filter(Boolean).join(" ")}
      >
        <Heading level={headingLevel} size="h3" id={headingId}>
          {savedHeading(count)}
        </Heading>
        <ul role="list" className="min-w-0 divide-y divide-border-default">
          {items.map((line) => (
            <li key={line.productId} className="min-w-0">
              <SavedForLaterRow line={line} actions={actions} listId={saveForLaterListId} />
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
