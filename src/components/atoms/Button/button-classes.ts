/**
 * Button class tables. A plain module (no "use client") so server components
 * such as `Link variant="button"` can build the exact same class strings as
 * the client `Button` without a hand-copied mirror.
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "outline"
  | "inverse"
  | "quick-add";
export type ButtonSize = "sm" | "md" | "lg";
export type ButtonPadding = "default" | "none";
export type ButtonShape = "pill" | "rounded";

/** Layout + type shared by every variant (no radius, no colour). */
export const BUTTON_LAYOUT =
  "inline-flex min-h-touch min-w-touch select-none items-center justify-center gap-2 font-semibold transition-colors";

/** Interactive states only `<button>` has (links have neither). */
export const BUTTON_STATES =
  "disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress";

export const BUTTON_SHAPE: Record<ButtonShape, string> = {
  pill: "rounded-full",
  rounded: "rounded-md",
};

// Only verified pairs (globals.css header).
export const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-text-on-accent hover:bg-accent-hover active:bg-accent-active",
  secondary:
    "border border-border-strong bg-surface-raised text-text-primary hover:bg-accent-subtle active:bg-accent-subtle",
  ghost: "bg-transparent text-accent hover:bg-accent-subtle active:bg-accent-subtle",
  danger: "bg-danger text-text-on-accent hover:bg-danger-hover active:bg-danger-hover",
  // Accent border + text: secondary actions next to a primary ("Shop beauty").
  outline:
    "border border-accent bg-surface-raised text-accent hover:bg-accent-subtle active:bg-accent-subtle",
  // White pill for dark (bg-surface-inverse) bands. On the gold bg-promo band use primary.
  inverse:
    "border border-surface-raised bg-surface-raised text-text-primary hover:bg-surface-sunken active:bg-surface-sunken",
  // The 44px hit area is transparent; the visible pill is QUICK_ADD_PILL.
  "quick-add": "group bg-transparent text-text-primary",
};

export const BUTTON_SIZE: Record<ButtonPadding, Record<ButtonSize, string>> = {
  default: {
    sm: "px-3 py-1 text-small",
    md: "px-4 py-2 text-body",
    lg: "min-h-12 px-6 py-3 text-body",
  },
  // Same sizes without inner padding (image thumbnails that fill the button).
  none: {
    sm: "p-0 text-small",
    md: "p-0 text-body",
    lg: "min-h-12 p-0 text-body",
  },
};

/** Visible pill inside a `quick-add` button ("+ Add" over product images). */
export const QUICK_ADD_PILL: Record<ButtonSize, string> = {
  sm: "inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-caption font-semibold text-text-on-accent shadow-sm transition-colors group-hover:bg-accent-hover group-active:bg-accent-active",
  md: "inline-flex items-center gap-1 rounded-full bg-accent px-3 py-1 text-small font-semibold text-text-on-accent shadow-sm transition-colors group-hover:bg-accent-hover group-active:bg-accent-active",
  lg: "inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-body font-semibold text-text-on-accent shadow-sm transition-colors group-hover:bg-accent-hover group-active:bg-accent-active",
};

export interface ButtonClassOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  padding?: ButtonPadding;
  /** Defaults to "pill", or "rounded" when `padding` is "none" (thumbnails). */
  shape?: ButtonShape;
  fullWidth?: boolean;
  /** Include the `<button>`-only disabled/busy state utilities. Defaults to true. */
  withStates?: boolean;
  className?: string;
}

/** Resolves the default shape: pills, except edge-to-edge thumbnails. */
export function resolveButtonShape(shape: ButtonShape | undefined, padding: ButtonPadding): ButtonShape {
  return shape ?? (padding === "none" ? "rounded" : "pill");
}

/** Full class string for a Button-looking element. */
export function buttonClassName({
  variant = "primary",
  size = "md",
  padding = "default",
  shape,
  fullWidth = false,
  withStates = true,
  className,
}: ButtonClassOptions = {}): string {
  const isQuickAdd = variant === "quick-add";
  return [
    BUTTON_LAYOUT,
    // quick-add: the outer hit area follows the pill shape for the focus ring.
    BUTTON_SHAPE[isQuickAdd ? "pill" : resolveButtonShape(shape, padding)],
    withStates ? BUTTON_STATES : "",
    BUTTON_VARIANT[variant],
    // quick-add carries its padding/type on the inner pill.
    isQuickAdd ? "p-0" : BUTTON_SIZE[padding][size],
    fullWidth ? "w-full" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
}
