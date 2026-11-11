import type { BenefitItem } from "@/components/molecules/BenefitsStrip";
import { couponPromoParts } from "@/components/organisms/SiteHeader";
import type { HeaderBenefits, PromoCoupon } from "@/components/organisms/SiteHeader";
import {
  HEADER_BENEFITS,
  HEADER_BENEFIT_AMOUNT_TOKEN,
  type HeaderBenefitCopy,
  type HeaderBenefitsContent,
  type HeaderCouponCopy,
  type HeaderFreeShippingCopy,
} from "@/content/header-benefits";
import { isAllowedInternalHref } from "@/content/routes";
import { formatMoney, isValidCents } from "@/lib/money";

/**
 * Builds the header benefits strip (T148) from the content module and real
 * facts (free-shipping threshold from the shipping methods, promoted coupon).
 * Pure; no server imports.
 *
 * Any part of the content that is missing, blank or malformed (e.g. a
 * template without `{amount}`, a disallowed href) falls back to
 * `HEADER_BENEFITS_FALLBACK` below, so the strip never renders broken copy
 * even if the content module moves (T165).
 */

/** Hardcoded safe copy used when the content module is absent or a part of it is unusable. */
export const HEADER_BENEFITS_FALLBACK: HeaderBenefitsContent = {
  label: "Store benefits",
  freeShipping: {
    id: "free-shipping",
    template: `Free standard shipping on orders of ${HEADER_BENEFIT_AMOUNT_TOKEN} or more`,
    icon: "truck",
    href: "/shipping",
  },
  items: [
    { id: "track-order", label: "Track your order", icon: "package", href: "/orders" },
    { id: "returns", label: "Returns and refunds", icon: "refresh", href: "/returns" },
  ],
  coupon: { id: "promo-code", prefix: "Use code", icon: "tag" },
};

export interface HeaderBenefitsInput {
  /** From `loadHeaderData` (lowest active `freeOverCents`); `null` omits the free-shipping item. */
  readonly freeShippingThresholdCents: number | null;
  /** ISO 4217 code used to format the threshold (the store currency). */
  readonly currency: string;
  /** First promoted coupon; `null` omits the coupon item. */
  readonly coupon: PromoCoupon | null;
  /** Defaults to `HEADER_BENEFITS`; `null` = content absent (fallback copy). */
  readonly content?: HeaderBenefitsContent | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function hasOneAmountToken(template: string): boolean {
  return template.split(HEADER_BENEFIT_AMOUNT_TOKEN).length === 2;
}

function usableFreeShipping(copy: HeaderFreeShippingCopy | undefined): HeaderFreeShippingCopy {
  const template = text(copy?.template);
  if (copy === undefined || !hasOneAmountToken(template) || !isAllowedInternalHref(copy.href)) {
    return HEADER_BENEFITS_FALLBACK.freeShipping;
  }
  return { ...copy, template };
}

function usableItems(items: readonly HeaderBenefitCopy[] | undefined): readonly HeaderBenefitCopy[] {
  const valid = Array.isArray(items)
    ? items.filter((item) => text(item?.label) !== "" && isAllowedInternalHref(item.href))
    : [];
  return valid.length > 0 ? valid : HEADER_BENEFITS_FALLBACK.items;
}

function usableCoupon(copy: HeaderCouponCopy | undefined): HeaderCouponCopy {
  return copy === undefined || text(copy.prefix) === "" ? HEADER_BENEFITS_FALLBACK.coupon : copy;
}

/**
 * "$35" for 3500 USD ("$35.50" keeps its cents). `null` when the amount or
 * currency is invalid (the free-shipping item is then omitted).
 */
export function formatThreshold(cents: number, currency: string): string | null {
  if (!isValidCents(cents) || cents <= 0) return null;
  try {
    const formatted = formatMoney(cents, currency);
    return cents % 100 === 0 ? formatted.replace(/\.00$/, "") : formatted;
  } catch {
    return null;
  }
}

export function buildHeaderBenefits(input: HeaderBenefitsInput): HeaderBenefits {
  const content = input.content === undefined ? HEADER_BENEFITS : input.content;
  const label = text(content?.label) || HEADER_BENEFITS_FALLBACK.label;
  const items: BenefitItem[] = [];

  const threshold =
    input.freeShippingThresholdCents === null ? null : formatThreshold(input.freeShippingThresholdCents, input.currency);
  if (threshold !== null) {
    const shipping = usableFreeShipping(content?.freeShipping);
    items.push({
      id: shipping.id,
      label: shipping.template.replace(HEADER_BENEFIT_AMOUNT_TOKEN, threshold),
      icon: shipping.icon,
      href: shipping.href,
    });
  }

  for (const item of usableItems(content?.items)) {
    items.push({ id: item.id, label: text(item.label), icon: item.icon, href: item.href });
  }

  const parts = couponPromoParts(input.coupon);
  if (parts !== null) {
    const coupon = usableCoupon(content?.coupon);
    items.push({ id: coupon.id, label: `${text(coupon.prefix)} ${parts.code}${parts.tail}`, icon: coupon.icon });
  }

  return { label, items };
}
