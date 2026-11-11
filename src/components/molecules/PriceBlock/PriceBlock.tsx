import type { HTMLAttributes } from "react";
import { Badge } from "@/components/atoms/Badge";
import { Icon } from "@/components/atoms/Icon";
import { Price, type PriceDisplay, type PriceSize } from "@/components/atoms/Price";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { formatMoney, isValidCents } from "@/lib/money";
import type { ValidatedCoupon } from "@/server/pricing/coupon-service";

export type PriceBlockSize = "sm" | "md" | "lg";
/**
 * `stacked` (default): price, struck list price, "You save" line, coupon.
 * `inline`: one wrapping row for product cards: price (deal colour when on
 * sale), struck "Was" price, "N% off".
 */
export type PriceBlockLayout = "stacked" | "inline";

export interface Savings {
  /** list - price, exact integer cents (> 0). */
  savingsCents: number;
  /** floor((list - price) * 100 / list); 0 when the saving is under 1%. */
  percent: number;
}

/**
 * Savings from integer cents only. Returns null unless both amounts are
 * non-negative safe integers and list > price. The percent is computed with
 * BigInt so it stays exact for amounts near Number.MAX_SAFE_INTEGER.
 */
export function computeSavings(priceCents: number, listPriceCents: number | null | undefined): Savings | null {
  if (!isValidCents(priceCents) || !isValidCents(listPriceCents)) return null;
  if (listPriceCents <= priceCents) return null;
  const savingsCents = listPriceCents - priceCents;
  const percent = Number((BigInt(savingsCents) * BigInt(100)) / BigInt(listPriceCents));
  return { savingsCents, percent };
}

function tryFormat(amountCents: number, currency: string): string | null {
  try {
    return formatMoney(amountCents, currency, "en-US");
  } catch {
    return null;
  }
}

export interface PriceBlockProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Current price in minor units. Invalid values render nothing. */
  priceCents: number;
  /** ISO 4217 code (e.g. "USD", "JPY"). Invalid codes render nothing. */
  currency: string;
  /** Shown struck through, with savings, only when a safe integer > priceCents. */
  listPriceCents?: number | null;
  /** Current price scale: sm = body, md = h3 (default), lg = h2. */
  size?: PriceBlockSize;
  /** Shows a "Deal" badge, only when there is a real saving. */
  showDealBadge?: boolean;
  /** Renders "Save with code CODE: description" as text. */
  coupon?: Pick<ValidatedCoupon, "code" | "description"> | null;
  /** Unit suffix after the price, e.g. "each". */
  unitLabel?: string;
  /** Price atom display: `superscript` = retail "$12⁵⁰" (still read as "$12.50"). Defaults to "standard". */
  display?: PriceDisplay;
  /** Defaults to "stacked". */
  layout?: PriceBlockLayout;
  /**
   * Shows the savings percent: "N% off" (inline) or the "(Y%)" suffix of
   * "You save $X (Y%)" (stacked). Defaults to true. Pass false when a sibling
   * (e.g. `SavingBadge` in the BuyBox) already states the percent.
   */
  showPercentOff?: boolean;
}

const priceSize: Record<PriceBlockSize, PriceSize> = { sm: "body", md: "h3", lg: "h2" };

/**
 * Price with optional list price, "You save $X (Y%)", Deal badge and coupon
 * line (`layout="stacked"`), or a one-row card price (`layout="inline"`; the
 * Deal badge and coupon line are not shown there). Server-safe and never
 * throws: invalid list prices fall back to the
 * plain price; an invalid price or currency renders nothing.
 */
export function PriceBlock({
  priceCents,
  currency,
  listPriceCents,
  size = "md",
  showDealBadge = false,
  coupon,
  unitLabel,
  display = "standard",
  layout = "stacked",
  showPercentOff = true,
  className,
  ...rest
}: PriceBlockProps) {
  if (!isValidCents(priceCents) || tryFormat(priceCents, currency) === null) return null;

  const savings = computeSavings(priceCents, listPriceCents);
  const listText = savings !== null && isValidCents(listPriceCents) ? tryFormat(listPriceCents, currency) : null;
  const savedText = savings !== null ? tryFormat(savings.savingsCents, currency) : null;
  const showSavings = savings !== null && listText !== null && savedText !== null;

  const unit = unitLabel?.trim() ?? "";
  const couponCode = coupon?.code.trim() ?? "";
  const couponText = coupon?.description.trim() ?? "";

  if (layout === "inline") {
    const inlineClasses = ["flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1", className]
      .filter(Boolean)
      .join(" ");
    // The current price is rendered without `compareAtCents` so its accessible
    // text is exactly "$12.50" (no "Now" prefix); the struck price reads "Was $19.00".
    return (
      <div {...rest} className={inlineClasses} data-layout="inline">
        <Price
          amountCents={priceCents}
          currency={currency}
          size={priceSize[size]}
          display={display}
          tone={showSavings ? "deal" : "default"}
        />
        {unit !== "" ? <span className="text-small text-text-secondary">{unit}</span> : null}
        {showSavings ? (
          <s className="text-small text-text-secondary">
            <VisuallyHidden>Was </VisuallyHidden>
            {listText}
          </s>
        ) : null}
        {showSavings && showPercentOff && savings.percent > 0 ? (
          <span className="text-small font-semibold text-deal">{`${savings.percent}% off`}</span>
        ) : null}
      </div>
    );
  }

  const classes = ["flex min-w-0 flex-col items-start gap-1", className].filter(Boolean).join(" ");

  return (
    <div {...rest} className={classes}>
      {showSavings && showDealBadge ? <Badge tone="danger">Deal</Badge> : null}
      <p className="flex flex-wrap items-baseline gap-x-1">
        <Price amountCents={priceCents} currency={currency} size={priceSize[size]} display={display} />
        {unit !== "" ? <span className="text-small text-text-secondary">{unit}</span> : null}
      </p>
      {showSavings ? (
        <>
          <p className="text-small text-text-secondary">
            <s>
              <VisuallyHidden>List price: </VisuallyHidden>
              {listText}
            </s>
          </p>
          <p className="text-small text-success">
            {showPercentOff && savings.percent > 0 ? `You save ${savedText} (${savings.percent}%)` : `You save ${savedText}`}
          </p>
        </>
      ) : null}
      {couponCode !== "" && couponText !== "" ? (
        <p className="inline-flex flex-wrap items-center gap-1 text-small text-text-primary">
          <Icon name="tag" size="sm" className="text-success" />
          <span>
            Save with code <span className="font-mono font-semibold">{couponCode}</span>: {couponText}
          </span>
        </p>
      ) : null}
    </div>
  );
}
