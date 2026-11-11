"use client";

import { useId, useState, type ReactNode } from "react";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Price } from "@/components/atoms/Price";
import { Heading, Text } from "@/components/atoms/Typography";
import { CartLineItem, type CartLineItemData } from "@/components/molecules/CartLineItem";
import { SummaryList, SummaryRow } from "@/components/molecules/SummaryRow";
import type { CartActionFn, CartActionFnV2 } from "@/components/molecules/_contracts/cart-actions";
import type { SavedForLaterLine } from "@/server/cart/cart-service";
import { SavedForLaterSection, type SavedForLaterActions } from "./SavedForLaterSection";
import { isAllowedInternalHref } from "@/content/routes";
import { formatMoney, isValidCents } from "@/lib/money";

/** A cart line plus optional v2 display data. */
export interface CartTableLine extends CartLineItemData {
  /** "Was" price per unit (`Product.listPriceCents`); renders "You save $X" when above the unit price. */
  readonly listPriceCents?: number | null;
}

/** Mirrors the cart service's `CartView`; pages pass it straight through. */
export interface CartTableData {
  readonly items: readonly CartTableLine[];
  readonly subtotalCents: number;
  /** ISO 4217 code. */
  readonly currency: string;
  readonly itemCount: number;
  /** Server verdict; the checkout link also requires every line status to be "ok". */
  readonly canCheckout: boolean;
}

export interface CartTableProps {
  cart: CartTableData;
  updateQuantity: CartActionFn;
  removeItem: CartActionFn;
  /** Defaults to "/checkout". */
  checkoutHref?: string;
  /** Defaults to "/". */
  continueShoppingHref?: string;
  className?: string;
  // --- v2 (T82), all optional -------------------------------------------------
  /** Saved-for-later section rendered below the cart (also under the empty state). Hidden when `items` is empty. */
  saved?: {
    readonly items: readonly SavedForLaterLine[];
    /** The session's save-for-later list id (posted by Delete). */
    readonly listId: string | null;
    readonly actions: SavedForLaterActions;
    /** Defaults to 2. */
    readonly headingLevel?: 2 | 3;
  };
  /** `saveForLater` server action; adds a "Save for later" form to every line. */
  saveForLaterAction?: CartActionFnV2;
  /** Show 64px product thumbnails on the lines. */
  thumbnails?: boolean;
  /** Rendered under the "Your cart is empty" block (e.g. suggestions). */
  emptyState?: ReactNode;
  // --- T108 (additive) --------------------------------------------------------
  /**
   * Omit the built-in summary box (subtotal, warning, checkout and continue
   * links) so the page can render `CartSummary` beside the lines instead.
   * Default false: markup is unchanged.
   */
  hideSummary?: boolean;
}

export const UNAVAILABLE_WARNING = "Remove unavailable items to continue to checkout";
export const REDUCED_WARNING = "Adjust the highlighted quantities to continue to checkout";

function formatSubtotal(cents: number, currency: string): string {
  if (!isValidCents(cents)) return "";
  try {
    return formatMoney(cents, currency);
  } catch {
    return "";
  }
}

/**
 * `/products/<slug>` when it passes `isAllowedInternalHref` (same guard as
 * ListView's `productHref`); undefined for an empty slug (vanished product) or
 * a rejected one such as ".." or ".", so the name stays plain text.
 */
function productHref(slug: string): string | undefined {
  if (typeof slug !== "string" || slug.trim() === "") return undefined;
  const href = `/products/${encodeURIComponent(slug)}`;
  return isAllowedInternalHref(href) ? href : undefined;
}

export function cartAnnouncement(itemCount: number, subtotalCents: number, currency: string): string {
  const noun = itemCount === 1 ? "item" : "items";
  const subtotal = formatSubtotal(subtotalCents, currency);
  return subtotal === ""
    ? `Cart updated: ${itemCount} ${noun}`
    : `Cart updated: ${itemCount} ${noun}, subtotal ${subtotal}`;
}

/**
 * Cart page body: line list, summary and checkout call to action. Client
 * component so it can announce totals changes in a polite live region.
 */
export function CartTable({
  cart,
  updateQuantity,
  removeItem,
  checkoutHref = "/checkout",
  continueShoppingHref = "/",
  className,
  saved,
  saveForLaterAction,
  thumbnails = false,
  emptyState,
  hideSummary = false,
}: CartTableProps) {
  const uid = useId();
  const itemsHeadingId = `cart-items-${uid}`;
  const { items, subtotalCents, currency, itemCount, canCheckout } = cart;

  // Announce only when totals change after the first render. Previous values
  // are tracked with the "adjust state during render" pattern (no effect).
  const [previous, setPrevious] = useState({ itemCount, subtotalCents });
  const [announcement, setAnnouncement] = useState("");
  if (previous.itemCount !== itemCount || previous.subtotalCents !== subtotalCents) {
    setPrevious({ itemCount, subtotalCents });
    setAnnouncement(cartAnnouncement(itemCount, subtotalCents, currency));
  }

  const hasUnavailable = items.some((item) => item.status === "unavailable");
  const hasReduced = items.some((item) => item.status === "reduced");
  // A reduced line must be resolved first, or checkout returns STOCK_CHANGED.
  const showCheckout = canCheckout && items.every((item) => item.status === "ok");
  // Unavailable takes precedence over reduced.
  const warning = hasUnavailable ? UNAVAILABLE_WARNING : hasReduced ? REDUCED_WARNING : null;

  const liveRegion = (
    <p aria-live="polite" aria-atomic="true" className="sr-only" data-testid="cart-live-region">
      {announcement}
    </p>
  );

  const rootClasses = ["min-w-0", className].filter(Boolean).join(" ");

  const savedSection =
    saved !== undefined ? (
      <SavedForLaterSection
        items={saved.items}
        actions={saved.actions}
        saveForLaterListId={saved.listId}
        headingLevel={saved.headingLevel}
        className="mt-8"
      />
    ) : null;

  if (items.length === 0) {
    return (
      <div className={rootClasses}>
        {liveRegion}
        <Card tone="sunken" padding="lg" className="flex flex-col items-center gap-3 text-center">
          <Heading level={2} size="h3">
            Your cart is empty
          </Heading>
          <Link href={continueShoppingHref} variant="nav" className="underline">
            Continue shopping
          </Link>
        </Card>
        {emptyState !== undefined && emptyState !== null ? <div className="mt-8 min-w-0">{emptyState}</div> : null}
        {savedSection}
      </div>
    );
  }

  return (
    <div className={rootClasses}>
      {liveRegion}
      <div className="flex min-w-0 flex-col gap-8 lg:flex-row lg:items-start">
        <Card padding="none" className="flex-1">
          <h2 id={itemsHeadingId} className="sr-only">
            Cart items
          </h2>
          <ul
            role="list"
            aria-labelledby={itemsHeadingId}
            className="min-w-0 divide-y divide-border-default px-4 sm:px-5"
          >
            {items.map((item) => (
              <li key={item.productId} className="min-w-0">
                <CartLineItem
                  item={item}
                  currency={currency}
                  updateQuantity={updateQuantity}
                  removeItem={removeItem}
                  lineTotal="computed"
                  listPriceCents={item.listPriceCents}
                  saveForLaterAction={saveForLaterAction}
                  thumbnail={thumbnails ? { url: item.imageUrl, alt: item.name } : undefined}
                  productHref={productHref(item.slug)}
                />
              </li>
            ))}
          </ul>
        </Card>

        {hideSummary ? null : (
          <Card as="section" aria-label="Cart summary" className="flex flex-col gap-4 lg:w-80">
            <SummaryList>
              <SummaryRow label="Subtotal" value={<Price amountCents={subtotalCents} currency={currency} />} />
              <SummaryRow label="Shipping" value="Free" />
              <SummaryRow
                label="Estimated total"
                value={<Price amountCents={subtotalCents} currency={currency} display="superscript" />}
                emphasis
                className="flex-wrap border-t border-border-default pt-2 font-semibold"
              />
            </SummaryList>

            {warning !== null ? (
              <p role="status" className="rounded-sm bg-warning-subtle px-3 py-2 text-small text-warning">
                {warning}
              </p>
            ) : null}

            {showCheckout ? (
              <Link href={checkoutHref} variant="button" className="w-full">
                Proceed to checkout
              </Link>
            ) : null}

            <Text as="div" variant="small" className="flex flex-wrap justify-center">
              <Link href={continueShoppingHref} variant="subtle">
                Continue shopping
              </Link>
            </Text>
          </Card>
        )}
      </div>
      {savedSection}
    </div>
  );
}
