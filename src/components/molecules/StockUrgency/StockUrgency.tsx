import type { HTMLAttributes } from "react";
import { Icon, type IconName } from "@/components/atoms/Icon";

/** Default highest count shown as "Only N left in stock". */
export const STOCK_URGENCY_THRESHOLD = 5;

export type StockUrgencyStatus = "out" | "low" | "in";

/** Finite integer >= 0, else 0 (same rule as `normalizeStock` in _contracts/cart-actions). */
function normalizeCount(stock: number): number {
  return Number.isFinite(stock) && Number.isInteger(stock) ? Math.max(0, stock) : 0;
}

/** Invalid thresholds (NaN, negative, non-integer) fall back to the default. */
function normalizeThreshold(threshold: number): number {
  return Number.isFinite(threshold) && Number.isInteger(threshold) && threshold >= 0
    ? threshold
    : STOCK_URGENCY_THRESHOLD;
}

export interface StockUrgencyResult {
  status: StockUrgencyStatus;
  label: string;
}

/** Pure mapping from real stock to a status and its text label. */
export function getStockUrgency(stock: number, lowThreshold: number = STOCK_URGENCY_THRESHOLD): StockUrgencyResult {
  const units = normalizeCount(stock);
  if (units === 0) return { status: "out", label: "Out of stock" };
  if (units <= normalizeThreshold(lowThreshold)) return { status: "low", label: `Only ${units} left in stock` };
  return { status: "in", label: "In stock" };
}

// Verified status pairs (role text on its own tint). Colour reinforces the text, never replaces it.
const statusStyle: Record<StockUrgencyStatus, { text: string; surface: string; icon: IconName }> = {
  out: { text: "text-danger", surface: "bg-danger-subtle", icon: "error-circle" },
  low: { text: "text-warning", surface: "bg-warning-subtle", icon: "warning" },
  in: { text: "text-success", surface: "bg-success-subtle", icon: "check-circle" },
};

export interface StockUrgencyProps extends Omit<HTMLAttributes<HTMLParagraphElement>, "children"> {
  /** Real units available. NaN, negative or non-integer counts as 0. */
  stock: number;
  /** Highest count shown as "Only N left in stock". Defaults to 5. */
  lowThreshold?: number;
}

/**
 * Stock line from real stock only (D13: no countdowns, no fake urgency).
 * Phase 3 look: a tinted status pill (success / warning / danger role).
 * State is always in text; the icon is decorative. Server-safe.
 */
export function StockUrgency({ stock, lowThreshold = STOCK_URGENCY_THRESHOLD, className, ...rest }: StockUrgencyProps) {
  const { status, label } = getStockUrgency(stock, lowThreshold);
  const style = statusStyle[status];
  const classes = [
    "inline-flex w-fit max-w-full items-center gap-1 rounded-full px-3 py-1 text-small font-semibold",
    style.surface,
    style.text,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <p {...rest} data-stock-status={status} className={classes}>
      <Icon name={style.icon} size="sm" />
      <span>{label}</span>
    </p>
  );
}
