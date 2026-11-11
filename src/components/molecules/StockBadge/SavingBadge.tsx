import { BADGE_PRESETS, Badge, type BadgeProps } from "@/components/atoms/Badge";
import { Icon } from "@/components/atoms/Icon";
import { formatMoney } from "@/lib/money";
import { computeSavings } from "../PriceBlock";

/**
 * "Save $5.00 (20%)" from integer cents (percent floored, as `computeSavings`);
 * "Save $0.50" when the saving is under 1%. Returns null when there is no real
 * saving (no list price, list <= price, invalid cents) or the currency cannot
 * be formatted. Never throws.
 */
export function savingLabel(
  priceCents: number,
  listPriceCents: number | null | undefined,
  currency: string,
): string | null {
  const savings = computeSavings(priceCents, listPriceCents);
  if (savings === null) return null;
  let amount: string;
  try {
    amount = formatMoney(savings.savingsCents, currency, "en-US");
  } catch {
    return null;
  }
  return savings.percent > 0 ? `Save ${amount} (${savings.percent}%)` : `Save ${amount}`;
}

export interface SavingBadgeProps
  extends Omit<BadgeProps, "tone" | "children" | "icon" | "emphasis"> {
  /** Current price in minor units. */
  priceCents: number;
  /** List ("was") price in minor units. No badge unless it is a safe integer above `priceCents`. */
  listPriceCents?: number | null;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
}

/**
 * Saving badge for the buy box and cards: solid deal pill with a decorative
 * tag icon and the saving as text ("Save $5.00 (20%)"). Renders nothing when
 * there is no list price saving. Server-safe.
 */
export function SavingBadge({
  priceCents,
  listPriceCents,
  currency,
  shape = "pill",
  size = "md",
  ...rest
}: SavingBadgeProps) {
  const label = savingLabel(priceCents, listPriceCents, currency);
  if (label === null) return null;
  return (
    <Badge
      {...BADGE_PRESETS.deal}
      shape={shape}
      size={size}
      icon={<Icon name="tag" size="sm" />}
      data-saving-badge=""
      {...rest}
    >
      {label}
    </Badge>
  );
}
