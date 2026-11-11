import type { HTMLAttributes, ReactNode } from "react";

export type TextElement = "p" | "span" | "div";
export type TextVariant = "body" | "small" | "caption";
export type TextTone = "primary" | "secondary" | "inverse" | "danger" | "success";

export interface TextProps extends HTMLAttributes<HTMLElement> {
  /** Rendered element. Defaults to `p`. */
  as?: TextElement;
  /** Type scale step. Defaults to `body`. */
  variant?: TextVariant;
  /**
   * Colour role. Defaults to `primary`. `inverse` is only for use on
   * `bg-surface-inverse`; `secondary` must not sit on status tints or fills.
   */
  tone?: TextTone;
  children?: ReactNode;
}

const variantClasses: Record<TextVariant, string> = {
  body: "text-body",
  small: "text-small",
  caption: "text-caption",
};

const toneClasses: Record<TextTone, string> = {
  primary: "text-text-primary",
  secondary: "text-text-secondary",
  inverse: "text-text-inverse",
  danger: "text-danger",
  success: "text-success",
};

export function Text({
  as: Tag = "p",
  variant = "body",
  tone = "primary",
  className,
  children,
  ...rest
}: TextProps) {
  const classes = [variantClasses[variant], toneClasses[tone], className].filter(Boolean).join(" ");
  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
