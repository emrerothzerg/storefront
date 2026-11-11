"use client";

import type { ComponentPropsWithRef, MouseEvent } from "react";
import { Icon } from "../Icon";
import { Spinner, type SpinnerSize } from "../Spinner";
import {
  QUICK_ADD_PILL,
  buttonClassName,
  type ButtonPadding,
  type ButtonShape,
  type ButtonSize,
  type ButtonVariant,
} from "./button-classes";

export type { ButtonPadding, ButtonShape, ButtonSize, ButtonVariant };

export interface ButtonProps extends ComponentPropsWithRef<"button"> {
  /**
   * Visual style. Defaults to "primary".
   * - `primary`: filled accent pill (main call to action).
   * - `secondary`: neutral bordered pill.
   * - `outline`: accent border + accent text pill.
   * - `ghost`: text-only accent button.
   * - `danger`: filled danger pill (destructive).
   * - `inverse`: white pill for dark `bg-surface-inverse` bands (on the gold
   *   `bg-promo` band use `primary`).
   * - `quick-add`: compact "+ Add" pill (product cards). The visible pill is
   *   small but the hit area stays 44x44. Children default to "Add"; give
   *   the button a specific name, e.g. `aria-label="Add Desk lamp to cart"`.
   */
  variant?: ButtonVariant;
  /** Size. Every size keeps a 44x44px minimum hit area. Defaults to "md". */
  size?: ButtonSize;
  /**
   * Corner shape. Defaults to "pill" (fully rounded), or "rounded" (8px)
   * when `padding="none"` so image thumbnails keep square-ish corners.
   * `quick-add` is always a pill.
   */
  shape?: ButtonShape;
  /**
   * Busy state: shows a Spinner before the label, sets `aria-busy` and
   * `aria-disabled`, and swallows clicks (including form submission) while
   * keeping the button focusable and exposed to assistive tech.
   */
  loading?: boolean;
  /** Stretch to the full width of the container. */
  fullWidth?: boolean;
  /**
   * `none` drops the size's inner padding (keeps text size, the 44px minimum
   * hit area and the focus outline) so content such as an image thumbnail
   * fills the button edge to edge. Pair with `overflow-hidden` via className
   * if the content should be clipped to the radius. Defaults to "default".
   */
  padding?: ButtonPadding;
}

const spinnerSize: Record<ButtonSize, SpinnerSize> = {
  sm: "sm",
  md: "sm",
  lg: "md",
};

export function Button({
  variant = "primary",
  size = "md",
  shape,
  loading = false,
  fullWidth = false,
  padding = "default",
  disabled,
  type = "button",
  className,
  onClick,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      // Blocks form submission for type="submit" and suppresses the handler.
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };

  const classes = buttonClassName({ variant, size, padding, shape, fullWidth, className });
  const spinner = loading ? <Spinner size={spinnerSize[size]} /> : null;

  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      className={classes}
      onClick={handleClick}
    >
      {variant === "quick-add" ? (
        <span className={QUICK_ADD_PILL[size]} data-slot="quick-add-pill">
          {spinner ?? <Icon name="plus" size="sm" />}
          {children ?? "Add"}
        </span>
      ) : (
        <>
          {spinner}
          {children}
        </>
      )}
    </button>
  );
}
