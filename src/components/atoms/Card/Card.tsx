import type { HTMLAttributes, ReactNode, Ref } from "react";

export type CardTone =
  | "raised"
  | "sunken"
  | "accent-subtle"
  | "promo-subtle"
  | "deal-subtle"
  | "promo"
  | "inverse"
  | "accent";
export type CardPadding = "none" | "sm" | "md" | "lg";
export type CardElevation = "none" | "sm" | "md";
export type CardRadius = "lg" | "xl";
export type CardElement = "div" | "article" | "section" | "li" | "aside";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Element to render. Defaults to "div". Use `article` for product cards, `li` inside lists. */
  as?: CardElement;
  /**
   * Surface. Defaults to "raised" (white).
   * - `raised` / `sunken`: content cards and light-grey tiles.
   * - `accent-subtle` / `promo-subtle` / `deal-subtle`: soft promotional panels
   *   (use `text-text-primary`, or `text-accent` / `text-deal` for emphasis;
   *   never `text-promo`).
   * - `promo`: bold gold band with near-black text; put primary (blue)
   *   Buttons/Links on it (4.01:1 fill contrast), keeps the blue focus ring.
   * - `inverse`: dark band, `text-text-inverse`; focus rings inside switch
   *   to white automatically (globals.css). Put actions on it as Button/Link
   *   `inverse`.
   * - `accent`: bold primary-blue band, `text-text-on-accent` (6.70:1). Focus
   *   rings of every descendant turn white (`focus-ring-inverse` on accent
   *   6.70:1) via a `**:focus-visible` utility on the card. Use `inverse`
   *   Buttons/Links and inverse text tones on it; never a primary (blue) button,
   *   `text-secondary` or a nested white card.
   */
  tone?: CardTone;
  /** Inner padding: none / 12px / 16px (20px from sm:) / 24px (32px from md:). Defaults to "md". */
  padding?: CardPadding;
  /** Shadow. Defaults to "sm" for raised cards and "none" for every other tone. */
  elevation?: CardElevation;
  /**
   * Soft 1px `border-border-default` edge (decorative; the card is not a
   * control). Defaults to true for `raised`, false otherwise.
   */
  bordered?: boolean;
  /**
   * Hover lift (shadow-md) for cards whose main link covers the card. The
   * card itself is never focusable; the link inside carries focus.
   */
  interactive?: boolean;
  /** Corner radius: 12px (`lg`, default) or 16px (`xl`, promo panels). */
  radius?: CardRadius;
  children?: ReactNode;
  ref?: Ref<HTMLElement>;
}

// Only verified text/surface pairs (globals.css header).
const toneClasses: Record<CardTone, string> = {
  raised: "bg-surface-raised text-text-primary",
  sunken: "bg-surface-sunken text-text-primary",
  "accent-subtle": "bg-accent-subtle text-text-primary",
  "promo-subtle": "bg-promo-subtle text-text-primary",
  "deal-subtle": "bg-deal-subtle text-text-primary",
  promo: "bg-promo text-text-primary",
  inverse: "bg-surface-inverse text-text-inverse",
  // The blue ring would be 1.30:1 on the blue fill, so descendants get the white one.
  accent: "bg-accent text-text-on-accent **:focus-visible:outline-focus-ring-inverse",
};

const paddingClasses: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4 sm:p-5",
  lg: "p-6 md:p-8",
};

const elevationClasses: Record<CardElevation, string> = {
  none: "",
  sm: "shadow-sm",
  md: "shadow-md",
};

const radiusClasses: Record<CardRadius, string> = {
  lg: "rounded-lg",
  xl: "rounded-xl",
};

/**
 * Surface container with the Phase 3 look: white card, soft border, soft
 * shadow, 12px corners; or a tinted / bold promotional panel. Purely
 * presentational (server component, no state).
 */
export function Card({
  as: Element = "div",
  tone = "raised",
  padding = "md",
  elevation,
  bordered,
  interactive = false,
  radius = "lg",
  className,
  children,
  ref,
  ...rest
}: CardProps) {
  const isRaised = tone === "raised";
  const shadow = elevation ?? (isRaised ? "sm" : "none");
  const border = bordered ?? isRaised;
  const classes = [
    "relative min-w-0",
    radiusClasses[radius],
    toneClasses[tone],
    border ? "border border-border-default" : "",
    elevationClasses[shadow],
    paddingClasses[padding],
    interactive ? "transition-shadow hover:shadow-md" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // Ref typing: every CardElement is an HTMLElement; React accepts Ref<HTMLElement> on each.
  return (
    <Element {...rest} ref={ref as Ref<never>} className={classes}>
      {children}
    </Element>
  );
}
