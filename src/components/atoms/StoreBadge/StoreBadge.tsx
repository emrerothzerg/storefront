import type { Ref } from "react";
import { Icon } from "../Icon";

export type StoreBadgeSize = "sm" | "md";

/** Default text: no mobile app exists yet (BACKLOG-phase3 R10, section 4). */
export const STORE_BADGE_DEFAULT_LABEL = "Mobile app coming soon";

/**
 * Deliberately narrow props: no event handlers, `role`, `tabIndex` or `href`,
 * so the badge can never become interactive or look like a store link.
 */
export interface StoreBadgeProps {
  /** Visible text. Blank or whitespace-only falls back to the default. */
  label?: string;
  /** `sm` = caption text, `md` = small text (default). */
  size?: StoreBadgeSize;
  id?: string;
  className?: string;
  ref?: Ref<HTMLSpanElement>;
}

const sizeClasses: Record<StoreBadgeSize, string> = {
  sm: "gap-1 px-2 py-0.5 text-caption",
  md: "gap-1.5 px-3 py-1 text-small",
};

/**
 * PLACEHOLDER: replace with approved brand assets later.
 *
 * Neutral outlined pill with a decorative phone icon and readable text. It is
 * plain `<span>` content: not a link, not a button, not focusable, no role.
 * The pill carries its own white fill, so the text pair is always
 * text-primary on surface-raised (17.72:1) whatever band it sits on.
 *
 * @example
 * <ul className="flex flex-wrap gap-2">
 *   <li><StoreBadge /></li>
 * </ul>
 */
export function StoreBadge({ label, size = "md", id, className, ref }: StoreBadgeProps) {
  const text = label?.trim() || STORE_BADGE_DEFAULT_LABEL;
  const classes = [
    "inline-flex max-w-full min-w-0 items-center rounded-full border border-border-strong bg-surface-raised font-medium text-text-primary wrap-anywhere",
    sizeClasses[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span ref={ref} id={id} className={classes}>
      <Icon name="phone" size="sm" className="shrink-0" />
      <span className="min-w-0">{text}</span>
    </span>
  );
}
