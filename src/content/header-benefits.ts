/**
 * Header benefits strip copy (T148, home reference H3). Plain text only; the
 * header builds the strip from this module plus real site facts:
 *
 * - the free-shipping item is shown only when the shipping-method data has a
 *   threshold; `{amount}` in its template is replaced with the formatted
 *   threshold (never hardcoded here);
 * - the static items link to pages that exist (`/orders`, `/returns`);
 * - the coupon item is shown only when a promoted coupon exists
 *   ("<prefix> CODE for <description>"; the coupon service writes whole-dollar
 *   amounts without cents, e.g. "$20", matching the threshold format).
 * - below `md` the header shows only the free-shipping and coupon items
 *   (`HEADER_BENEFIT_COMPACT_IDS`); the others appear from `md`.
 *
 * Data honesty (R10): no click and collect, same-day delivery, stores or
 * memberships. The T165 content task may move this module; the header keeps a
 * hardcoded fallback (`src/app/_layout/header-benefits.ts`) for anything
 * missing or blank here.
 */

/** Icons used by the strip; a subset of the atoms `ICON_NAMES` (checked by test and by the type of `BenefitItem.icon`). */
export const HEADER_BENEFIT_ICONS = ["truck", "package", "refresh", "tag"] as const;
export type HeaderBenefitIcon = (typeof HEADER_BENEFIT_ICONS)[number];

/** Placeholder replaced by the formatted free-shipping threshold, e.g. "$35". */
export const HEADER_BENEFIT_AMOUNT_TOKEN = "{amount}";

export interface HeaderBenefitCopy {
  /** Stable key. */
  readonly id: string;
  readonly label: string;
  readonly icon: HeaderBenefitIcon;
  /** Internal route; must pass `isAllowedInternalHref`. */
  readonly href: string;
}

export interface HeaderFreeShippingCopy {
  readonly id: string;
  /** Must contain `{amount}` exactly once. */
  readonly template: string;
  readonly icon: HeaderBenefitIcon;
  readonly href: string;
}

export interface HeaderCouponCopy {
  readonly id: string;
  /** Text before the code, e.g. "Use code". */
  readonly prefix: string;
  readonly icon: HeaderBenefitIcon;
}

export interface HeaderBenefitsContent {
  /** Accessible name of the strip's list. */
  readonly label: string;
  readonly freeShipping: HeaderFreeShippingCopy;
  /** Always-true facts, shown after the free-shipping item. */
  readonly items: readonly HeaderBenefitCopy[];
  readonly coupon: HeaderCouponCopy;
}

/**
 * Ids of the items the header keeps below `md` (U20): the free-shipping
 * threshold and the promoted coupon. Same ids as the header's fallback copy.
 */
export const HEADER_BENEFIT_COMPACT_IDS: readonly string[] = ["free-shipping", "promo-code"];

export const HEADER_BENEFITS: HeaderBenefitsContent = {
  label: "Store benefits",
  freeShipping: {
    id: "free-shipping",
    // "standard" separates this always-on threshold from a promoted
    // free-shipping coupon with a lower minimum shown in the same strip (U15).
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
