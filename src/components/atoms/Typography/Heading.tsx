import type { HTMLAttributes, ReactNode } from "react";

export type HeadingLevel = 1 | 2 | 3 | 4;
export type HeadingSize = "h1" | "h2" | "h3" | "h4" | "h1-lg";
export type HeadingTone = "default" | "inverse" | "secondary";

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  /** Document outline level; renders `<h1>`..`<h4>`. */
  level: HeadingLevel;
  /** Visual size, decoupled from `level`. Defaults to the size matching `level`. */
  size?: HeadingSize;
  /**
   * Colour role. Defaults to `default` (text-primary). `inverse` only on
   * `bg-surface-inverse` (hero band, footer); `secondary` for muted headings
   * on page/raised/sunken surfaces (never on status tints or fills).
   */
  tone?: HeadingTone;
  children: ReactNode;
}

const sizeClasses: Record<HeadingSize, string> = {
  // h1 steps up to the large display size from md, as the token guide recommends.
  h1: "text-h1 md:text-h1-lg",
  "h1-lg": "text-h1-lg",
  h2: "text-h2",
  h3: "text-h3",
  h4: "text-h4",
};

const toneClasses: Record<HeadingTone, string> = {
  default: "text-text-primary",
  inverse: "text-text-inverse",
  secondary: "text-text-secondary",
};

const defaultSize: Record<HeadingLevel, HeadingSize> = {
  1: "h1",
  2: "h2",
  3: "h3",
  4: "h4",
};

export function Heading({
  level,
  size,
  tone = "default",
  className,
  children,
  ...rest
}: HeadingProps) {
  const Tag = `h${level}` as const;
  const classes = [sizeClasses[size ?? defaultSize[level]], toneClasses[tone], className]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
