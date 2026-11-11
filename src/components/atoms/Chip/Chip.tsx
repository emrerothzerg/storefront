"use client";

import NextLink from "next/link";
import type { AnchorHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { Icon, type IconName } from "../Icon";
import { IconButton } from "../IconButton";

export type ChipSize = "sm" | "md";
/**
 * `outline`: white pill with a strong border (filters, default).
 * `filled`: borderless light-grey pill (popular / related searches). The
 * visible text identifies it; selected chips of both variants get the accent
 * border + tint + check icon.
 */
export type ChipVariant = "outline" | "filled";

interface ChipBaseProps {
  /** Visible text; also used in the remove button's name ("Remove <label>"). */
  label: string;
  /** Selected look (accent tint + check icon). */
  selected?: boolean;
  /** Renders a trailing "Remove <label>" icon button. */
  onRemove?: () => void;
  /**
   * Accessible name of the remove button. Defaults to "Remove <label>".
   * Keep the visible label inside it (WCAG 2.5.3), e.g. "Remove filter: Brand Acme"
   * for a chip showing "Acme".
   */
  removeLabel?: string;
  /** Defaults to "md". Both sizes keep a 44px hit area. */
  size?: ChipSize;
  /** Optional decorative content before the label (e.g. a colour swatch). */
  leading?: ReactNode;
  /** Decorative icon after the label (e.g. "search" on popular-search chips). Hidden from assistive tech. */
  trailingIcon?: IconName;
  /** Defaults to "outline". */
  variant?: ChipVariant;
  /**
   * Native tooltip on the chip's main element (the button, link or span that
   * holds the label; not the remove button). Use it for the full text of a
   * truncated label. Supplementary only: never the only place information
   * lives. Blank values are dropped.
   */
  title?: string;
  className?: string;
}

export interface ChipButtonProps extends ChipBaseProps {
  as?: "button";
  /** Makes it a toggle: `aria-pressed={selected}`. */
  onToggle?: (nextSelected: boolean, event: MouseEvent<HTMLButtonElement>) => void;
  /** For a plain action chip (no toggle state). */
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  href?: never;
  /**
   * Overrides the accessible name of the chip itself (default: its visible
   * content). Must contain the visible label (WCAG 2.5.3), e.g. "Brand: Acme".
   */
  "aria-label"?: string;
  "aria-current"?: never;
  ref?: Ref<HTMLButtonElement>;
}

export interface ChipLinkProps extends ChipBaseProps {
  as: "a";
  /** Filter URL. A selected link chip gets `aria-current="true"`. */
  href: string;
  /**
   * Overrides the `aria-current` value implied by `selected` (e.g. `"page"`
   * when the chip's URL is the page being shown). Styling still follows
   * `selected` only. Without `selected` it is passed through as-is.
   */
  "aria-current"?: AnchorHTMLAttributes<HTMLAnchorElement>["aria-current"];
  onToggle?: never;
  onClick?: never;
  disabled?: never;
  /**
   * Overrides the accessible name of the chip itself (default: its visible
   * content). Must contain the visible label (WCAG 2.5.3), e.g. "Brand: Acme".
   */
  "aria-label"?: string;
  ref?: Ref<HTMLAnchorElement>;
}

export interface ChipStaticProps extends ChipBaseProps {
  as: "span";
  onToggle?: never;
  onClick?: never;
  disabled?: never;
  href?: never;
  "aria-current"?: never;
  /**
   * Not allowed: a plain span has no role, so a name on it is not announced.
   * Use `removeLabel` to name the remove action instead.
   */
  "aria-label"?: never;
  ref?: Ref<HTMLSpanElement>;
}

export type ChipProps = ChipButtonProps | ChipLinkProps | ChipStaticProps;

const sizeClasses: Record<ChipSize, string> = {
  sm: "px-3 text-small",
  md: "px-4 text-body",
};
// Removable: the trailing 44px IconButton supplies the right-hand space.
const removableSizeClasses: Record<ChipSize, string> = {
  sm: "pl-3 text-small",
  md: "pl-4 text-body",
};

// Verified pairs: text-primary on raised/sunken/border-default, accent on accent-subtle.
const pill = (selected: boolean, variant: ChipVariant) =>
  selected
    ? "border-accent bg-accent-subtle text-accent"
    : variant === "filled"
      ? "border-transparent bg-surface-sunken text-text-primary"
      : "border-border-strong bg-surface-raised text-text-primary";

const interactiveHover = (selected: boolean, variant: ChipVariant) =>
  selected ? "" : variant === "filled" ? "hover:bg-border-default" : "hover:bg-surface-sunken";

function join(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Filter chip. `as="button"` (default; toggle with `onToggle`), `as="a"`
 * (filter link) or `as="span"` (static, e.g. an applied filter with only a
 * remove button). Selection shows a check icon, never colour alone.
 */
export function Chip(props: ChipProps) {
  const {
    label,
    selected = false,
    onRemove,
    removeLabel,
    size = "md",
    leading,
    trailingIcon,
    variant = "outline",
    title: rawTitle,
    className,
  } = props;
  const title = rawTitle?.trim() ? rawTitle : undefined;

  const content = (
    <>
      {selected ? <Icon name="check" size="sm" /> : null}
      {leading != null ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {leading}
        </span>
      ) : null}
      <span>{label}</span>
      {trailingIcon ? <Icon name={trailingIcon} size="sm" className="shrink-0" /> : null}
    </>
  );

  const removable = onRemove !== undefined;
  // Without a remove button the main element is the pill; with one, a span
  // pill wraps the main element and the button (no nested interactives).
  const pillClasses = join(
    // min-w-touch: a one-character label ("S", "4+") still gives a 44px-wide target (D-T131-3).
    "inline-flex min-h-touch min-w-touch items-center justify-center gap-1.5 rounded-full border select-none",
    pill(selected, variant),
    removable ? removableSizeClasses[size] : sizeClasses[size],
  );
  const mainClasses = removable
    ? "inline-flex min-h-touch min-w-touch items-center justify-center gap-1.5 rounded-full"
    : pillClasses;
  // className is merged last on the outermost element.
  const mainClassName = removable ? undefined : className;

  let main: ReactNode;
  if (props.as === "a") {
    const { ref, href } = props;
    // An explicit aria-current wins; selected alone implies "true".
    const ariaCurrent = props["aria-current"] ?? (selected ? ("true" as const) : undefined);
    main = (
      <NextLink
        ref={ref}
        href={href}
        title={title}
        aria-label={props["aria-label"]}
        aria-current={ariaCurrent}
        className={join(
          mainClasses,
          "no-underline",
          !removable && interactiveHover(selected, variant),
          mainClassName,
        )}
      >
        {content}
      </NextLink>
    );
  } else if (props.as === "span") {
    const { ref } = props;
    main = (
      <span ref={ref} title={title} className={join(mainClasses, mainClassName)}>
        {content}
      </span>
    );
  } else {
    const { onToggle, onClick, disabled, ref } = props;
    const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      onToggle?.(!selected, event);
    };
    main = (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        title={title}
        aria-label={props["aria-label"]}
        aria-pressed={onToggle ? selected : undefined}
        onClick={handleClick}
        className={join(
          mainClasses,
          "cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
          !removable && interactiveHover(selected, variant),
          mainClassName,
        )}
      >
        {content}
      </button>
    );
  }

  if (!removable) return main;

  return (
    <span className={join(pillClasses, className)}>
      {main}
      <IconButton icon="close" size="sm" label={removeLabel ?? `Remove ${label}`} onClick={onRemove} />
    </span>
  );
}
