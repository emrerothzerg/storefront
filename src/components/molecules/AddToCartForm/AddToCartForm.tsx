"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/atoms/Button";
import { QuantityStepper } from "@/components/atoms/QuantityStepper";
import {
  CART_FIELD,
  initialCartActionState,
  initialCartActionStateV2,
  normalizeStock,
  type CartActionFn,
  type CartActionFnV2,
  type CartActionStateV2,
} from "../_contracts/cart-actions";

/** A successful cart action state (v1 states are a subset of v2). */
export type AddToCartSuccessState = Extract<NonNullable<CartActionStateV2>, { ok: true }>;

export type AddToCartFormVariant = "default" | "buybox";

export interface AddToCartFormProps {
  productId: string;
  /** Units available to sell. `<= 0` renders a disabled "Out of stock" button. */
  stock: number;
  /** Per-order cap, applied on top of `stock`. Default 10 (so the stepper max is `min(stock, 10)`). */
  maxQuantity?: number;
  /** Server action (or any function) matching the cart action contract. */
  addToCart: CartActionFn;
  /**
   * `buyNow` server action. When set, a second submit button "Buy Now" posts
   * the SAME form (productId + quantity) via `formAction`, so it works without JS.
   * Phase 3 look: "Add to cart" is the primary (filled) pill, "Buy Now" the
   * outline pill under it; DOM (and tab) order is quantity, Add, Buy Now.
   */
  buyNowAction?: CartActionFnV2;
  /** Client callback, called once per successful submission (e.g. to raise a toast). */
  onSuccess?: (state: AddToCartSuccessState) => void;
  /** `buybox` = large buttons for the PDP purchase panel. Default "default". */
  variant?: AddToCartFormVariant;
  /** Id for the quantity input; generated when omitted. */
  id?: string;
  className?: string;
}

const MIN_QUANTITY = 1;
const DEFAULT_MAX_QUANTITY = 10;
const STOCK_ERROR_CODES: ReadonlySet<string> = new Set(["STOCK_CHANGED", "INSUFFICIENT_STOCK"]);

type Source = "add" | "buy";

interface SettleTrack {
  addState: CartActionStateV2;
  buyState: CartActionStateV2;
  addPending: boolean;
  buyPending: boolean;
  latest: Source;
  settled: number;
}

/** `details.available` of a stock error, when it is a non-negative integer; otherwise null. */
export function availableFromState(state: CartActionStateV2): number | null {
  if (state === null || state.ok || !STOCK_ERROR_CODES.has(state.error.code)) return null;
  const available = state.error.details?.available;
  return typeof available === "number" && Number.isSafeInteger(available) && available >= 0
    ? available
    : null;
}

export function AddToCartForm({
  productId,
  stock,
  maxQuantity = DEFAULT_MAX_QUANTITY,
  addToCart,
  buyNowAction,
  onSuccess,
  variant = "default",
  id,
  className,
}: AddToCartFormProps) {
  const generatedId = useId();
  const inputId = id ?? `add-to-cart-${generatedId}`;
  const [addState, addFormAction, addPending] = useActionState(addToCart, initialCartActionState);
  // Always called (hook order); the dispatcher is only rendered when `buyNowAction` is set.
  const [buyState, buyFormAction, buyPending] = useActionState(
    buyNowAction ?? noopBuyNow,
    initialCartActionStateV2,
  );
  const [quantity, setQuantity] = useState(MIN_QUANTITY);

  // Which action settled most recently decides the message shown, and every
  // settle bumps `settled` (render-time "previous value" pattern, no effect).
  // A settle is a new state object OR pending falling back to false, so an
  // action returning the identical state object twice still counts twice.
  const [track, setTrack] = useState<SettleTrack>({
    addState,
    buyState,
    addPending,
    buyPending,
    latest: "add",
    settled: 0,
  });
  const addSettled = addState !== track.addState || (track.addPending && !addPending);
  const buySettled = buyState !== track.buyState || (track.buyPending && !buyPending);
  if (addSettled || buySettled || addPending !== track.addPending || buyPending !== track.buyPending) {
    setTrack({
      addState,
      buyState,
      addPending,
      buyPending,
      latest: buySettled ? "buy" : addSettled ? "add" : track.latest,
      settled: track.settled + (addSettled || buySettled ? 1 : 0),
    });
  }
  const latest = buySettled ? "buy" : addSettled ? "add" : track.latest;
  const state: CartActionStateV2 = latest === "buy" ? buyState : addState;
  const settled = track.settled;

  const notified = useRef(0);
  useEffect(() => {
    if (settled > notified.current) {
      notified.current = settled;
      if (state?.ok === true) onSuccess?.(state);
    }
  }, [settled, state, onSuccess]);

  const available = availableFromState(state);
  // NaN / Infinity / non-integer / negative stock all count as out of stock.
  const propStock = normalizeStock(stock);
  // A stock error reporting fewer units than the page knows lowers the stepper max.
  const safeStock = available !== null && available >= MIN_QUANTITY ? Math.min(propStock, available) : propStock;
  const safeCap =
    Number.isInteger(maxQuantity) && maxQuantity >= MIN_QUANTITY ? maxQuantity : DEFAULT_MAX_QUANTITY;
  const max = Math.min(safeStock, safeCap);
  // Derived clamp: if stock drops below the chosen quantity, show (and post) the new max.
  const value = Math.max(MIN_QUANTITY, Math.min(quantity, max));
  const wrapper = ["flex flex-col gap-3", className].filter(Boolean).join(" ");
  const buttonSize = variant === "buybox" ? "lg" : "md";
  const isPending = addPending || buyPending;

  if (max < MIN_QUANTITY) {
    return (
      <div className={wrapper}>
        <Button type="button" disabled fullWidth size={buttonSize}>
          Out of stock
        </Button>
      </div>
    );
  }

  return (
    <form action={addFormAction} className={wrapper}>
      <input type="hidden" name={CART_FIELD.productId} value={productId} />
      <QuantityStepper
        className="self-start"
        id={inputId}
        name={CART_FIELD.quantity}
        value={value}
        onChange={setQuantity}
        min={MIN_QUANTITY}
        max={max}
      />
      <Button type="submit" loading={isPending} fullWidth size={buttonSize}>
        Add to cart
      </Button>
      {buyNowAction ? (
        <Button
          type="submit"
          formAction={buyFormAction}
          loading={isPending}
          fullWidth
          size={buttonSize}
          variant="outline"
        >
          Buy Now
        </Button>
      ) : null}
      {state?.ok === false ? (
        <p role="alert" className="text-danger text-small">
          {state.error.message}
          {available !== null ? ` Available now: ${available}.` : null}
        </p>
      ) : null}
      <p aria-live="polite" aria-atomic="true" className="text-small text-text-primary">
        {state?.ok === true ? state.value.message : null}
      </p>
    </form>
  );
}

/** Placeholder so `useActionState` is always called; never dispatched (no Buy Now button without `buyNowAction`). */
async function noopBuyNow(prev: CartActionStateV2): Promise<CartActionStateV2> {
  return prev;
}
