import type { HTMLAttributes, ReactNode } from "react";

export type BadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "accent"
  | "promo"
  | "deal";
/** `subtle` = tinted background + coloured text (default); `solid` = filled. */
export type BadgeEmphasis = "subtle" | "solid";
/** `square` = small 4px corners (product tags, default); `pill` = fully rounded. */
export type BadgeShape = "square" | "pill";
export type BadgeSize = "sm" | "md";

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  tone: BadgeTone;
  /** Visible label. Required and non-empty so meaning is never conveyed by colour alone. */
  children: Exclude<ReactNode, null | undefined | boolean>;
  /** Optional decorative leading icon; hidden from assistive tech. */
  icon?: ReactNode;
  /** Defaults to "subtle". */
  emphasis?: BadgeEmphasis;
  /** Defaults to "square". */
  shape?: BadgeShape;
  /** `sm` = caption text (default), `md` = small text. */
  size?: BadgeSize;
}

// Only verified pairs from globals.css (tint pairs and text-on-accent on fills).
const subtleClasses: Record<BadgeTone, string> = {
  neutral: "bg-surface-sunken text-text-primary",
  success: "bg-success-subtle text-success",
  warning: "bg-warning-subtle text-warning",
  danger: "bg-danger-subtle text-danger",
  info: "bg-info-subtle text-info",
  accent: "bg-accent-subtle text-accent",
  promo: "bg-promo-subtle text-text-primary",
  deal: "bg-deal-subtle text-deal",
};

const solidClasses: Record<BadgeTone, string> = {
  neutral: "bg-surface-inverse text-text-inverse",
  success: "bg-success text-text-on-accent",
  warning: "bg-warning text-text-on-accent",
  danger: "bg-danger text-text-on-accent",
  info: "bg-info text-text-on-accent",
  accent: "bg-accent text-text-on-accent",
  // Gold fill carries near-black text (10.61:1), never white.
  promo: "bg-promo text-text-primary",
  deal: "bg-deal text-text-on-accent",
};

const shapeClasses: Record<BadgeShape, string> = {
  square: "rounded-sm",
  pill: "rounded-full",
};

const sizeClasses: Record<BadgeSize, string> = {
  sm: "px-1.5 py-0.5 text-caption",
  md: "px-2 py-0.5 text-small",
};

/**
 * Ready-made merchandising badges from the Phase 3 design. Spread them:
 * `<Badge {...BADGE_PRESETS.deal}>Deal</Badge>`. The label stays the
 * caller's (so it can be localised or say "Online only" vs "Web exclusive").
 */
export const BADGE_PRESETS = {
  /** "New" — gold fill, dark text. */
  new: { tone: "promo", emphasis: "solid" },
  /** "Online only" — accent tint. */
  onlineOnly: { tone: "accent", emphasis: "subtle" },
  /** "Deal", "Save 20%" — warm orange fill. */
  deal: { tone: "deal", emphasis: "solid" },
  /** "Best seller", "Clearance" — dark fill. */
  highlight: { tone: "neutral", emphasis: "solid" },
} as const satisfies Record<string, { tone: BadgeTone; emphasis: BadgeEmphasis }>;

export type BadgePreset = keyof typeof BADGE_PRESETS;

export function Badge({
  tone,
  icon,
  emphasis = "subtle",
  shape = "square",
  size = "sm",
  className,
  children,
  ...rest
}: BadgeProps) {
  // Types cannot exclude "", so guard at runtime: a badge without text would be colour-only.
  if (typeof children === "string" && children.trim() === "") {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `[Badge] children must be non-empty visible text (tone "${tone}"); a colour-only badge is not allowed. Rendering nothing.`,
      );
    }
    return null;
  }
  const classes = [
    "inline-flex items-center gap-1 font-semibold",
    shapeClasses[shape],
    sizeClasses[size],
    emphasis === "solid" ? solidClasses[tone] : subtleClasses[tone],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} {...rest}>
      {icon != null ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}
