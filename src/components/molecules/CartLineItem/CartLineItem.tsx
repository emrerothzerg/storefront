"use client";

import { useActionState, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/atoms/Button";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Price } from "@/components/atoms/Price";
import { QuantityStepper } from "@/components/atoms/QuantityStepper";
import { Text } from "@/components/atoms/Typography";
import { computeSavings } from "@/components/molecules/PriceBlock";
import { formatMoney, multiplyCents } from "@/lib/money";
import {
  CART_FIELD,
  CART_FIELD_V2,
  initialCartActionState,
  initialCartActionStateV2,
  normalizeStock,
  type CartActionFn,
  type CartActionFnV2,
  type CartActionState,
  type CartActionStateV2,
} from "../_contracts/cart-actions";

export type CartLineStatus = "ok" | "unavailable" | "reduced";

/** Mirrors the cart service's `CartLineView`; the organism adapts to it. */
export interface CartLineItemData {
  readonly productId: string;
  readonly name: string;
  readonly slug: string;
  readonly imageUrl: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  /** Rendered as-is; the server computes unitPriceCents x quantity. */
  readonly lineTotalCents: number;
  readonly availableStock: number;
  readonly status: CartLineStatus;
}

/** V2 (T82): where the line total comes from. */
export type CartLineTotalSource = "server" | "computed";

export interface CartLineThumbnail {
  /** Empty / null renders the Image placeholder. */
  readonly url: string | null;
  /** Usually the product name. */
  readonly alt: string;
}

export interface CartLineItemProps {
  item: CartLineItemData;
  /** ISO 4217 code. */
  currency: string;
  updateQuantity: CartActionFn;
  removeItem: CartActionFn;
  className?: string;
  // --- v2 (T82), all optional; omitted = MVP rendering -----------------------
  /** 64px thumbnail before the name. */
  thumbnail?: CartLineThumbnail;
  /** `saveForLater` server action: renders a separate "Save for later" form posting `productId`. */
  saveForLaterAction?: CartActionFnV2;
  /** "Was" price per unit; a positive difference renders "You save $X" for the line. */
  listPriceCents?: number | null;
  /** Product page; the name becomes a link. */
  productHref?: string;
  /**
   * "server" (default, MVP): `lineTotalCents` rendered as-is behind a hidden
   * "Line total" label. "computed": visible "Line total: $X" where
   * X = unitPriceCents x billable quantity in exact integer cents (falls back
   * to `lineTotalCents` if the product is not a safe integer).
   */
  lineTotal?: CartLineTotalSource;
}

const MIN_QUANTITY = 1;

type LineAction = "update" | "remove" | "save";

/**
 * Units the shopper will actually be charged for, matching the cart service:
 * 0 for an unavailable line, otherwise min(quantity, available stock).
 */
export function billableQuantity(item: Pick<CartLineItemData, "quantity" | "availableStock" | "status">): number {
  if (item.status === "unavailable") return 0;
  const quantity = Number.isSafeInteger(item.quantity) ? Math.max(0, item.quantity) : 0;
  return Math.min(quantity, normalizeStock(item.availableStock));
}

/** unit x quantity in exact integer cents; null when an input is invalid or the result overflows. */
export function computeLineTotalCents(unitPriceCents: number, quantity: number): number | null {
  const result = multiplyCents(unitPriceCents, quantity);
  return result.ok ? result.value : null;
}

/** Total saving for the line ((list - unit) x quantity); null unless strictly positive and exact. */
export function computeLineSavingsCents(
  unitPriceCents: number,
  listPriceCents: number | null | undefined,
  quantity: number,
): number | null {
  const savings = computeSavings(unitPriceCents, listPriceCents);
  if (savings === null) return null;
  const total = computeLineTotalCents(savings.savingsCents, quantity);
  return total !== null && total > 0 ? total : null;
}

function tryFormat(amountCents: number, currency: string): string | null {
  try {
    return formatMoney(amountCents, currency);
  } catch {
    return null;
  }
}

function errorOf(state: CartActionState | CartActionStateV2): string | null {
  return state?.ok === false ? state.error.message : null;
}

export function CartLineItem({
  item,
  currency,
  updateQuantity,
  removeItem,
  className,
  thumbnail,
  saveForLaterAction,
  listPriceCents,
  productHref,
  lineTotal = "server",
}: CartLineItemProps) {
  const uid = useId();
  const inputId = `cart-line-qty-${uid}`;
  const updateFormRef = useRef<HTMLFormElement>(null);
  const updateButtonRef = useRef<HTMLButtonElement>(null);

  const [updateState, updateAction, isUpdatePending] = useActionState(
    updateQuantity,
    initialCartActionState,
  );
  const [removeState, removeAction, isRemovePending] = useActionState(
    removeItem,
    initialCartActionState,
  );
  // Always called (hooks order); without the prop the form is not rendered.
  const [saveState, saveAction, isSavePending] = useActionState<CartActionStateV2, FormData>(
    saveForLaterAction ?? noopSave,
    initialCartActionStateV2,
  );

  // Local quantity, re-synced whenever the server sends a new quantity, and
  // reverted to the server's quantity when an update is rejected.
  const [quantity, setQuantity] = useState(item.quantity);
  const [syncedQuantity, setSyncedQuantity] = useState(item.quantity);
  const [seenUpdateState, setSeenUpdateState] = useState(updateState);
  // Which action settled most recently; its error is the one shown (D-T82-1).
  const [lastAction, setLastAction] = useState<LineAction | null>(null);
  const [seenRemoveState, setSeenRemoveState] = useState(removeState);
  const [seenSaveState, setSeenSaveState] = useState(saveState);
  if (syncedQuantity !== item.quantity) {
    setSyncedQuantity(item.quantity);
    setQuantity(item.quantity);
  }
  if (seenUpdateState !== updateState) {
    setSeenUpdateState(updateState);
    setLastAction("update");
    if (updateState?.ok === false) setQuantity(item.quantity);
  }
  if (seenRemoveState !== removeState) {
    setSeenRemoveState(removeState);
    setLastAction("remove");
  }
  if (seenSaveState !== saveState) {
    setSeenSaveState(saveState);
    setLastAction("save");
  }

  const unavailable = item.status === "unavailable";
  // Stepper max is the available stock; an unavailable line shows its quantity, disabled.
  const availableStock = normalizeStock(item.availableStock);
  const max = Math.max(MIN_QUANTITY, availableStock);
  const value = unavailable ? item.quantity : Math.max(MIN_QUANTITY, Math.min(quantity, max));

  const handleQuantityChange = (next: number) => {
    // Commit the new value to the DOM first so FormData carries it.
    flushSync(() => setQuantity(next));
    // Passing the submitter keeps happy-dom (tests) and browsers on the same path.
    updateFormRef.current?.requestSubmit(updateButtonRef.current);
  };

  // Only the most recently settled action's failure is shown: a newer success
  // clears an older error, and a newer failure replaces it.
  const error =
    lastAction === "update"
      ? errorOf(updateState)
      : lastAction === "remove"
        ? errorOf(removeState)
        : lastAction === "save" && saveForLaterAction !== undefined
          ? errorOf(saveState)
          : null;

  const billable = billableQuantity(item);
  const computedTotal =
    lineTotal === "computed" ? computeLineTotalCents(item.unitPriceCents, billable) : null;
  const displayedTotal = computedTotal ?? item.lineTotalCents;
  const savingsCents = computeLineSavingsCents(item.unitPriceCents, listPriceCents, billable);
  const savingsText = savingsCents === null ? null : tryFormat(savingsCents, currency);

  const nameNode =
    productHref !== undefined && productHref !== "" ? (
      <Link href={productHref} variant="inline" className="inline-flex min-h-touch items-center font-semibold">
        {item.name}
      </Link>
    ) : (
      <Text as="span" className="font-semibold">
        {item.name}
      </Text>
    );

  return (
    <div
      className={["flex flex-col gap-3 py-4", className].filter(Boolean).join(" ")}
      aria-busy={isUpdatePending || isRemovePending || isSavePending || undefined}
    >
      <div className="flex min-w-0 items-start gap-3">
        {thumbnail !== undefined ? (
          <Image
            src={thumbnail.url}
            alt={thumbnail.alt}
            width={64}
            height={64}
            sizes="64px"
            rounded
            className="size-16 shrink-0 object-cover"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-2">
          <span className="min-w-0 break-words">{nameNode}</span>
          <Price amountCents={item.unitPriceCents} currency={currency} />
        </div>
      </div>

      {savingsText !== null ? (
        <Text as="p" variant="small" tone="success" data-testid="line-savings">
          {`You save ${savingsText}`}
        </Text>
      ) : null}

      {unavailable ? (
        <p role="status" className="rounded-sm bg-warning-subtle px-2 py-1 text-small text-warning">
          No longer available
        </p>
      ) : null}
      {item.status === "reduced" ? (
        <p role="status" className="rounded-sm bg-warning-subtle px-2 py-1 text-small text-warning">
          {`Only ${availableStock} left. Lower the quantity to continue.`}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <form ref={updateFormRef} action={updateAction} className="flex items-end gap-2">
          <input type="hidden" name={CART_FIELD.productId} value={item.productId} />
          <QuantityStepper
            id={inputId}
            name={CART_FIELD.quantity}
            label={`Quantity for ${item.name}`}
            showLabel={false}
            value={value}
            onChange={handleQuantityChange}
            min={MIN_QUANTITY}
            max={max}
            disabled={unavailable}
          />
          <Button
            ref={updateButtonRef}
            type="submit"
            variant="secondary"
            size="sm"
            loading={isUpdatePending}
            disabled={unavailable}
            className="sr-only focus:not-sr-only"
            aria-label={`Update quantity for ${item.name}`}
          >
            Update
          </Button>
        </form>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {lineTotal === "computed" ? (
            <span className="text-small text-text-secondary" data-testid="line-total-label">
              Line total:
            </span>
          ) : (
            <span className="sr-only">Line total</span>
          )}
          <Price amountCents={displayedTotal} currency={currency} data-testid="line-total" />
          {saveForLaterAction !== undefined ? (
            <form action={saveAction}>
              <input type="hidden" name={CART_FIELD_V2.productId} value={item.productId} />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                loading={isSavePending}
                aria-label={`Save for later: ${item.name}`}
              >
                Save for later
              </Button>
            </form>
          ) : null}
          <form action={removeAction}>
            <input type="hidden" name={CART_FIELD.productId} value={item.productId} />
            <Button
              type="submit"
              variant="danger"
              size="sm"
              loading={isRemovePending}
              aria-label={`Remove ${item.name}`}
            >
              Remove
            </Button>
          </form>
        </div>
      </div>

      {/* Update success; remove/save success unmounts the line, so CartTable announces it. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only" data-testid="line-status">
        {updateState?.ok === true ? updateState.value.message : null}
      </p>

      {error !== null ? (
        <p role="alert" className="text-danger text-small">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Placeholder for `useActionState` when no save action is passed (never invoked: no form is rendered). */
async function noopSave(prev: CartActionStateV2): Promise<CartActionStateV2> {
  return prev;
}
