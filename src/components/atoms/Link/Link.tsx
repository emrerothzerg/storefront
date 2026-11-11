import NextLink, { type LinkProps as NextLinkProps } from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { buttonClassName, type ButtonSize } from "../Button/button-classes";

type TextLinkVariant = "inline" | "nav" | "subtle";
export type LinkVariant = TextLinkVariant | "button";
export type LinkTone = "default" | "inverse";
/** Button looks available to `variant="button"` links (navigation, not actions). */
export type LinkButtonVariant = "primary" | "secondary" | "outline" | "inverse";

interface LinkBaseProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "target" | "rel">,
    Pick<NextLinkProps, "prefetch" | "replace" | "scroll"> {
  href: string;
  /**
   * Off-site link: renders a plain `<a target="_blank" rel="noopener noreferrer">`
   * with a visually hidden "(opens in new tab)" suffix. Next.js routing props
   * (`prefetch`, `replace`, `scroll`) are ignored.
   */
  external?: boolean;
  /**
   * Marks the link as current: applies the current styling and
   * `aria-current="page"`, unless an explicit `aria-current` is passed.
   */
  isCurrent?: boolean;
  /**
   * Overrides the `aria-current` value implied by `isCurrent` (e.g. `"true"`
   * for the selected item in a set of filter links, `"step"`, `"location"`).
   * Styling still follows `isCurrent` only. Without `isCurrent` it is passed
   * through as-is.
   */
  "aria-current"?: AnchorHTMLAttributes<HTMLAnchorElement>["aria-current"];
  children: ReactNode;
}

interface TextLinkProps extends LinkBaseProps {
  /**
   * - `inline`: in running text; accent colour + underline (default).
   * - `nav`: navigation item; 44px touch target, underlined when current.
   * - `subtle`: low-emphasis (footer, meta); 44px touch target, underline on hover/current.
   * - `button`: looks like `<Button variant="primary" size="md">` (see ButtonLinkProps).
   */
  variant?: TextLinkVariant;
  /**
   * Colour context. `default` for page/raised/sunken surfaces; `inverse` only on
   * `bg-surface-inverse` (footer, toast), where every variant uses
   * `text-text-inverse` (the only verified AA text pair on that surface).
   */
  tone?: LinkTone;
  /** Only for `variant="button"`. */
  buttonVariant?: never;
  /** Only for `variant="button"`. */
  buttonSize?: never;
}

interface ButtonLinkProps extends LinkBaseProps {
  /**
   * Navigation styled as a Button pill (e.g. "Proceed to checkout", "Shop
   * now"). Still an `<a href>`; use `<Button>` for actions. On
   * `bg-surface-inverse` either use `buttonVariant="inverse"` or add
   * `className="ring-2 ring-text-inverse"` to the primary look: the accent
   * hover fill is below 3:1 against that surface (see globals.css header).
   */
  variant: "button";
  /** Button look. Defaults to "primary" (same classes as `<Button variant="primary">`). */
  buttonVariant?: LinkButtonVariant;
  /** Button size. Defaults to "md". */
  buttonSize?: ButtonSize;
  /**
   * `tone="inverse"` is disallowed at the type level: the solid accent fill
   * carries its own text colour (`text-on-accent`) on any surface.
   */
  tone?: "default";
}

export type LinkProps = TextLinkProps | ButtonLinkProps;

// Same class tables as Button (button-classes.ts); the disabled/aria-busy
// utilities are omitted because links have neither state.
function buttonLinkClasses(variant: LinkButtonVariant, size: ButtonSize): string {
  return buttonClassName({
    variant,
    size,
    withStates: false,
    className: "no-underline hover:no-underline",
  });
}

const variantClasses: Record<LinkTone, Record<TextLinkVariant, string>> = {
  default: {
    inline: "text-accent underline underline-offset-2 hover:decoration-2",
    nav: "inline-flex min-h-touch min-w-touch items-center text-text-primary underline-offset-4 hover:text-accent hover:underline",
    subtle:
      "inline-flex min-h-touch min-w-touch items-center text-text-secondary underline-offset-2 hover:text-text-primary hover:underline",
  },
  // text-secondary / accent are not verified on surface-inverse, so all
  // variants keep text-inverse and signal hover with an underline instead.
  inverse: {
    inline: "text-text-inverse underline underline-offset-2 hover:text-text-inverse hover:decoration-2",
    nav: "inline-flex min-h-touch min-w-touch items-center text-text-inverse underline-offset-4 hover:text-text-inverse hover:underline",
    subtle:
      "inline-flex min-h-touch min-w-touch items-center text-text-inverse underline-offset-2 hover:text-text-inverse hover:underline",
  },
};

// Current page is shown with an underline, never by colour alone.
const currentClasses: Record<LinkTone, Record<TextLinkVariant, string>> = {
  default: {
    inline: "decoration-2",
    nav: "text-accent underline decoration-2",
    subtle: "text-text-primary underline",
  },
  inverse: {
    inline: "decoration-2",
    nav: "underline decoration-2",
    subtle: "underline",
  },
};

export function Link({
  href,
  external = false,
  isCurrent = false,
  variant = "inline",
  tone = "default",
  prefetch,
  replace,
  scroll,
  className,
  children,
  "aria-current": ariaCurrentProp,
  buttonVariant = "primary",
  buttonSize = "md",
  ...rest
}: LinkProps) {
  // Button-styled links have no current-page styling: aria-current still applies.
  const classes = [
    variant === "button" ? buttonLinkClasses(buttonVariant, buttonSize) : variantClasses[tone][variant],
    isCurrent && variant !== "button" ? currentClasses[tone][variant] : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  // An explicit aria-current wins; isCurrent alone implies "page".
  const ariaCurrent = ariaCurrentProp ?? (isCurrent ? ("page" as const) : undefined);

  if (external) {
    return (
      <a
        {...rest}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        aria-current={ariaCurrent}
        className={classes}
      >
        {children}
        <span className="sr-only"> (opens in new tab)</span>
      </a>
    );
  }

  return (
    <NextLink
      {...rest}
      href={href}
      prefetch={prefetch}
      replace={replace}
      scroll={scroll}
      aria-current={ariaCurrent}
      className={classes}
    >
      {children}
    </NextLink>
  );
}
