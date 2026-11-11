import type { Ref } from "react";

export type PaymentMarkSize = "sm" | "md";

/**
 * Deliberately narrow props: no event handlers, `role`, `tabIndex` or `href`,
 * so the mark can never become interactive.
 */
export interface PaymentMarkProps {
  /**
   * Generic visible text, e.g. "Card", "Gift card", "Pay later: coming soon".
   * Never a payment brand name. Blank or whitespace-only renders nothing.
   */
  label: string;
  /** `sm` = caption text, `md` = small text (default). */
  size?: PaymentMarkSize;
  id?: string;
  className?: string;
  ref?: Ref<HTMLSpanElement>;
}

const sizeClasses: Record<PaymentMarkSize, string> = {
  sm: "px-2 py-0.5 text-caption",
  md: "px-3 py-1 text-small",
};

/**
 * PLACEHOLDER: replace with approved brand assets later.
 *
 * Neutral rounded rectangle with a generic text label (no logo, no image).
 * Plain `<span>` content: not a link, not a button, not focusable, no role.
 * Own white fill, so the text pair is always text-primary on surface-raised
 * (17.72:1). Give the list a visible heading such as "Ways to pay".
 *
 * @example
 * <ul className="flex flex-wrap gap-2" aria-label="Ways to pay">
 *   <li><PaymentMark label="Card" /></li>
 *   <li><PaymentMark label="Gift card" /></li>
 *   <li><PaymentMark label="Pay later: coming soon" /></li>
 * </ul>
 */
export function PaymentMark({ label, size = "md", id, className, ref }: PaymentMarkProps) {
  const text = typeof label === "string" ? label.trim() : "";
  if (text === "") {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[PaymentMark] label must be non-empty visible text. Rendering nothing.");
    }
    return null;
  }
  const classes = [
    "inline-flex max-w-full min-w-0 items-center rounded-md border border-border-strong bg-surface-raised font-semibold text-text-primary wrap-anywhere",
    sizeClasses[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <span ref={ref} id={id} className={classes}>
      {text}
    </span>
  );
}
