"use client";

import { useActionState, useId } from "react";
import type { FormEvent } from "react";
import { Button } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { FormField } from "@/components/atoms/FormField";
import { Icon } from "@/components/atoms/Icon";
import { Input } from "@/components/atoms/Input";
import { Notice } from "@/components/atoms/Notice";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import type { AppError } from "@/lib/result";
import {
  CART_FIELD_V2,
  COUPON_CODE_MAX_LENGTH,
  initialCartActionStateV2,
  type CartActionFnV2,
} from "../_contracts/cart-actions";

export interface AppliedCouponView {
  readonly code: string;
  /** Human text from the coupon service, e.g. "10% off". Rendered as text. */
  readonly description: string;
}

export interface CouponFormProps {
  /** `applyCoupon` server action (posts `couponCode`). */
  applyAction: CartActionFnV2;
  /** `removeCoupon` server action (posts no fields). */
  removeAction: CartActionFnV2;
  /** Coupon currently on the cart (from `getCartView`); null shows the entry form. */
  appliedCoupon: AppliedCouponView | null;
  /** Shown as a warning when a stored code was dropped (from `getCartView`). */
  couponNotice?: string | null;
  /** Tighter layout for the cart summary / checkout sidebar. */
  compact?: boolean;
  /** Id for the code input; generated when omitted. */
  id?: string;
  className?: string;
}

/** Same text for every invalid / unknown code so codes cannot be enumerated. */
export const COUPON_INVALID_TEXT = "That promo code is not valid.";

const GENERIC_ERROR_TEXT = "Something went wrong. Please try again.";

function minutesFrom(details: AppError["details"]): number {
  const raw = details?.retryAfterSeconds;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 1;
  return Math.max(1, Math.ceil(raw / 60));
}

/** Shopper-facing text for an apply/remove failure. */
export function couponErrorMessage(error: AppError): string {
  switch (error.code) {
    case "COUPON_INVALID":
      return COUPON_INVALID_TEXT;
    case "RATE_LIMITED": {
      const minutes = minutesFrom(error.details);
      return `Too many promo code attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    }
    default: {
      const message = typeof error.message === "string" ? error.message.trim() : "";
      return message === "" ? GENERIC_ERROR_TEXT : message;
    }
  }
}

/** Trim + upper-case + cap at the code limit (the server normalises too). */
export function normalizeCouponInput(value: string): string {
  return value.trim().toUpperCase().slice(0, COUPON_CODE_MAX_LENGTH);
}

function upperCaseOnSubmit(event: FormEvent<HTMLFormElement>): void {
  // Runs before React builds the action's FormData, so the posted value is
  // upper-cased with JS. Without JS the typed value posts as-is.
  const field = event.currentTarget.elements.namedItem(CART_FIELD_V2.couponCode);
  if (field instanceof HTMLInputElement) field.value = normalizeCouponInput(field.value);
}

/**
 * Promo code entry. Not applied: `<form action={applyAction}>` with a
 * "Promo code" input (`name="couponCode"`, maxLength 32) and an "Apply"
 * button. Applied: a static chip with the code and description, plus a
 * `<form action={removeAction}>` "Remove" button. Both are real forms, so
 * everything works without JavaScript; the applied state comes from the
 * `appliedCoupon` prop (the action revalidates the cart page).
 */
export function CouponForm({
  applyAction,
  removeAction,
  appliedCoupon,
  couponNotice,
  compact = false,
  id,
  className,
}: CouponFormProps) {
  const generatedId = useId();
  const inputId = id ?? `coupon-${generatedId}`;
  const errorId = `${inputId}-error`;
  const [applyState, applyFormAction, applyPending] = useActionState(applyAction, initialCartActionStateV2);
  const [removeState, removeFormAction, removePending] = useActionState(removeAction, initialCartActionStateV2);

  const notice = typeof couponNotice === "string" && couponNotice.trim() !== "" ? couponNotice : null;
  const buttonSize = compact ? "sm" : "md";
  const wrapper = ["flex min-w-0 flex-col", compact ? "gap-2" : "gap-3", className]
    .filter(Boolean)
    .join(" ");

  const applied =
    appliedCoupon !== null && typeof appliedCoupon.code === "string" && appliedCoupon.code.trim() !== ""
      ? appliedCoupon
      : null;

  if (applied !== null) {
    const description = typeof applied.description === "string" ? applied.description.trim() : "";
    return (
      <div className={wrapper}>
        {notice !== null ? <Notice tone="warning">{notice}</Notice> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Chip
            as="span"
            size={compact ? "sm" : "md"}
            selected
            label={applied.code}
            leading={<Icon name="tag" size="sm" />}
            className="max-w-full break-all font-mono"
          />
          {description !== "" ? (
            <span className="min-w-0 break-words text-small text-text-primary">{description}</span>
          ) : null}
          <form action={removeFormAction} className="ml-auto">
            <Button type="submit" variant="danger" size={buttonSize} loading={removePending}>
              {removePending ? "Removing…" : "Remove"}
              <VisuallyHidden> promo code {applied.code}</VisuallyHidden>
            </Button>
          </form>
        </div>
        {removeState?.ok === false ? (
          <p role="alert" className="text-small text-danger">
            {couponErrorMessage(removeState.error)}
          </p>
        ) : null}
        <VisuallyHidden as="p" aria-live="polite" aria-atomic="true">
          {applyState?.ok === true ? applyState.value.message : null}
        </VisuallyHidden>
      </div>
    );
  }

  const applyError = applyState?.ok === false ? couponErrorMessage(applyState.error) : undefined;

  return (
    <div className={wrapper}>
      {notice !== null ? <Notice tone="warning">{notice}</Notice> : null}
      <form action={applyFormAction} onSubmit={upperCaseOnSubmit} className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <FormField id={inputId} label="Promo code" className="min-w-0 flex-1">
            {(controlProps) => (
              <Input
                {...controlProps}
                aria-describedby={applyError !== undefined ? errorId : undefined}
                invalid={applyError !== undefined}
                name={CART_FIELD_V2.couponCode}
                maxLength={COUPON_CODE_MAX_LENGTH}
                autoCapitalize="characters"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                className="font-mono uppercase"
              />
            )}
          </FormField>
          <Button type="submit" variant="secondary" size={buttonSize} loading={applyPending}>
            {applyPending ? "Applying…" : "Apply"}
          </Button>
        </div>
        {applyError !== undefined ? (
          <p id={errorId} role="alert" className="text-small text-danger">
            {applyError}
          </p>
        ) : null}
      </form>
      <VisuallyHidden as="p" aria-live="polite" aria-atomic="true">
        {removeState?.ok === true ? removeState.value.message : null}
      </VisuallyHidden>
    </div>
  );
}
