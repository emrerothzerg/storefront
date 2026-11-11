/**
 * Listing page promo tiles and feedback suggestions (T167, Phase 3 redesign).
 * Plain text only; `src/app/_listing/listing-page.ts` turns these into
 * `ProductGrid` promo slots and `FeedbackBlock` suggestions. Nothing here
 * touches the database or React.
 *
 * Rules (tested in `listing-promos.test.ts`):
 * - Every href passes `isAllowedInternalHref` and points at a page that exists.
 * - Copy is original and neutral (R2) and honest (R10): no retailer, partner,
 *   membership, newsletter, store or app copy, and no hardcoded money (the
 *   free-shipping threshold lives with the shipping methods, so the shipping
 *   tile links to the policy page instead of quoting an amount).
 * - Every tile has art (T178, U04): an 8:5 image whose background matches the
 *   tile surface, shown beside the copy on the two-column tile.
 * - Order matters: the listing helper takes the first `LISTING_PROMO_MAX`
 *   tiles whose CTA does not point at the current route, so the spare
 *   "Best Sellers" tile stands in for "Today's Deals" on /deals.
 */

import {
  ACCOUNT_PROMO_ART,
  BEST_SELLERS_PROMO_ART,
  DEALS_PROMO_ART,
  DELIVERY_PROMO_ART,
  type HomeArtImage,
} from "./home-art";

/** Promo surfaces (the PromoTile tones). */
export type ListingPromoTone = "primary" | "primary-subtle" | "neutral" | "accent";

export interface ListingPromoCopy {
  /** Stable key. */
  readonly id: string;
  readonly heading: string;
  readonly blurb: string;
  readonly cta: { readonly label: string; readonly href: string };
  readonly image: HomeArtImage | null;
  readonly tone: ListingPromoTone;
}

/** Candidate tiles in placement order (shipping, sale, spare sale stand-in, sign-up). */
export const LISTING_PROMOS: readonly ListingPromoCopy[] = Object.freeze([
  {
    id: "shipping",
    heading: "Free shipping on qualifying orders",
    blurb: "See delivery options, times and the order total that ships free.",
    cta: { label: "Shipping details", href: "/shipping" },
    image: DELIVERY_PROMO_ART,
    tone: "primary-subtle",
  },
  {
    id: "deals",
    heading: "Today's Deals",
    blurb: "Discounts across every department, updated as prices change.",
    cta: { label: "Shop deals", href: "/deals" },
    image: DEALS_PROMO_ART,
    tone: "accent",
  },
  {
    id: "best-sellers",
    heading: "Best Sellers",
    blurb: "See the products other shoppers buy most, ranked by units sold.",
    cta: { label: "See best sellers", href: "/best-sellers" },
    image: BEST_SELLERS_PROMO_ART,
    tone: "neutral",
  },
  {
    id: "account",
    heading: "Create an account",
    blurb: "Track your orders, keep saved lists and store addresses for checkout.",
    cta: { label: "Create account", href: "/signup" },
    image: ACCOUNT_PROMO_ART,
    tone: "primary",
  },
]);

/** Feedback block suggestion links in preference order; the helper drops the current route and keeps 3. */
export const LISTING_FEEDBACK_SUGGESTIONS: readonly { readonly label: string; readonly href: string }[] = Object.freeze([
  { label: "Browse all products", href: "/products" },
  { label: "See today's deals", href: "/deals" },
  { label: "Search help and FAQs", href: "/help" },
  { label: "See best sellers", href: "/best-sellers" },
]);
