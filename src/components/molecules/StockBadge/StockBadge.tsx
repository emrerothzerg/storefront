import { Badge, type BadgeProps, type BadgeTone } from "@/components/atoms/Badge";
import { Icon, type IconName } from "@/components/atoms/Icon";

/** Stock at or below this count (and above zero) shows "Only N left". */
export const LOW_STOCK_THRESHOLD = 5;

export type StockStatus = "out" | "low" | "in";

export interface StockStatusResult {
  status: StockStatus;
  label: string;
}

/** Negative, NaN, infinite or non-integer input is treated as 0 (out of stock). */
function normalizeStock(stock: number): number {
  return Number.isSafeInteger(stock) && stock > 0 ? stock : 0;
}

/** Invalid thresholds fall back to {@link LOW_STOCK_THRESHOLD}. */
function normalizeThreshold(threshold: number): number {
  return Number.isSafeInteger(threshold) && threshold >= 0 ? threshold : LOW_STOCK_THRESHOLD;
}

/** Pure mapping from a stock count to a display status and label. */
export function getStockStatus(
  stock: number,
  threshold: number = LOW_STOCK_THRESHOLD,
): StockStatusResult {
  const units = normalizeStock(stock);
  if (units === 0) return { status: "out", label: "Out of stock" };
  if (units <= normalizeThreshold(threshold)) return { status: "low", label: `Only ${units} left` };
  return { status: "in", label: "In stock" };
}

const statusTone: Record<StockStatus, BadgeTone> = {
  out: "danger",
  low: "warning",
  in: "success",
};

// Decorative only: the label text always carries the meaning (never colour or icon alone).
const statusIcon: Record<StockStatus, IconName> = {
  out: "error-circle",
  low: "warning",
  in: "check-circle",
};

export interface StockBadgeProps extends Omit<BadgeProps, "tone" | "children" | "icon"> {
  /** Units available. Negative, NaN or non-integer values count as out of stock. */
  stock: number;
  /** Highest count shown as "Only N left". Defaults to {@link LOW_STOCK_THRESHOLD}. */
  lowStockThreshold?: number;
}

/**
 * Stock availability badge: a tinted pill (success / warning / danger role)
 * with a decorative status icon and the status as text. Server-safe (no
 * hooks, no client APIs). `shape` defaults to "pill" (Phase 3 look).
 */
export function StockBadge({
  stock,
  lowStockThreshold = LOW_STOCK_THRESHOLD,
  shape = "pill",
  ...rest
}: StockBadgeProps) {
  const { status, label } = getStockStatus(stock, lowStockThreshold);
  return (
    <Badge
      tone={statusTone[status]}
      shape={shape}
      icon={<Icon name={statusIcon[status]} size="sm" />}
      data-stock-status={status}
      {...rest}
    >
      {label}
    </Badge>
  );
}
