"use client";

import { useActionState } from "react";
import { Button } from "@/components/atoms/Button";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import {
  CART_FIELD,
  initialCartActionState,
  normalizeStock,
  type CartActionFn,
} from "../_contracts/cart-actions";

/** `md` for listing cards, `sm` for the compact rail card. */
export type QuickAddFormSize = "sm" | "md";

export interface QuickAddFormProps {
  productId: string;
  /** Used for a visually hidden suffix so buttons are distinguishable across cards. Text only. */
  productName: string;
  /** Units available. NaN/negative/non-integer count as 0 (disabled "Out of stock"). */
  stock: number;
  /** `addToCart` server action (cart contract). Posted fields: productId, quantity=1. */
  action: CartActionFn;
  /** Visible pill size; both keep a 44px hit area. Defaults to "md". */
  size?: QuickAddFormSize;
  className?: string;
}

const MESSAGE_BUBBLE = "rounded-md bg-surface-raised px-2 py-1 shadow-sm";

function join(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * One-unit "+ Add" for product cards. A real `<form action>` (works without JS
 * through `useActionState` progressive enhancement) that posts only
 * `productId` and `quantity=1` as hidden inputs: never a price or total (SR9).
 * Visible text is "+ Add"; the accessible name is "Add to cart: <name>".
 * Pending: the button is `aria-busy` with a spinner. Success text goes to a
 * polite live region, errors to `role="alert"`, both as plain text.
 * Out of stock: a disabled "Out of stock" button and no form.
 */
export function QuickAddForm({ productId, productName, stock, action, size = "md", className }: QuickAddFormProps) {
  const [state, formAction, isPending] = useActionState(action, initialCartActionState);
  const name = typeof productName === "string" ? productName.trim() : "";
  const classes = join("flex min-w-0 flex-col items-start gap-1", className);

  if (normalizeStock(stock) === 0) {
    return (
      <div className={classes}>
        <Button type="button" variant="secondary" size="sm" disabled>
          Out of stock
          {name !== "" ? <VisuallyHidden>{`: ${name}`}</VisuallyHidden> : null}
        </Button>
      </div>
    );
  }

  const success = state?.ok === true ? state.value.message : null;

  return (
    <form action={formAction} className={classes}>
      <input type="hidden" name={CART_FIELD.productId} value={productId} />
      <input type="hidden" name={CART_FIELD.quantity} value="1" />
      {state?.ok === false ? (
        <p role="alert" className={join("max-w-full break-words text-small text-danger", MESSAGE_BUBBLE)}>
          {state.error.message}
        </p>
      ) : null}
      <p
        aria-live="polite"
        aria-atomic="true"
        className={join("max-w-full break-words text-small text-text-primary", success !== null && success !== "" && MESSAGE_BUBBLE)}
      >
        {success}
      </p>
      <Button type="submit" variant="quick-add" size={size} loading={isPending}>
        Add
        <VisuallyHidden>{name !== "" ? ` to cart: ${name}` : " to cart"}</VisuallyHidden>
      </Button>
    </form>
  );
}
