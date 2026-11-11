import { createElement, type HTMLAttributes, type ReactNode, type Ref } from "react";

export type VisuallyHiddenElement = "span" | "div" | "p" | "label" | "h1" | "h2" | "h3" | "h4";

interface VisuallyHiddenBaseProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  /**
   * Becomes visible while it (or something inside it) has focus. Use for skip
   * links: `<VisuallyHidden as="a" href="#main" focusable>Skip to content</VisuallyHidden>`.
   */
  focusable?: boolean;
  ref?: Ref<HTMLElement>;
}

interface VisuallyHiddenElementProps extends VisuallyHiddenBaseProps {
  /** Rendered element. Defaults to `span`. */
  as?: VisuallyHiddenElement;
  href?: never;
}

interface VisuallyHiddenAnchorProps extends VisuallyHiddenBaseProps {
  as: "a";
  href: string;
}

export type VisuallyHiddenProps = VisuallyHiddenElementProps | VisuallyHiddenAnchorProps;

// Shown on focus as a raised, padded box above the page (skip-link pattern).
const focusableClasses =
  "focus:not-sr-only focus-within:not-sr-only focus:absolute focus:z-toast focus:inline-block focus:rounded-md focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-body focus:text-text-primary focus:shadow-md focus-within:absolute focus-within:z-toast focus-within:inline-block focus-within:rounded-md focus-within:bg-surface-raised focus-within:px-4 focus-within:py-2 focus-within:shadow-md";

/** Content for assistive tech only (Tailwind `sr-only`). Server-component safe. */
export function VisuallyHidden({
  as = "span",
  focusable = false,
  className,
  children,
  ...rest
}: VisuallyHiddenProps) {
  const classes = ["sr-only", focusable ? focusableClasses : "", className]
    .filter(Boolean)
    .join(" ");
  return createElement(as, { ...rest, className: classes }, children);
}
