import type { BadgeEmphasis, BadgeTone } from "@/components/atoms/Badge";
import type { Product } from "@/lib/types";
import { computeSavings } from "../PriceBlock";

/**
 * Merchandising badges on a product card.
 * - `sale`, `new`, `top_pick`: derived from product data by `cardBadges(product, now)` (Phase 3).
 * - `deal`, `best_seller`: Phase 2 labels, only shown when a caller passes them explicitly.
 */
export type ProductCardBadge = "sale" | "new" | "top_pick" | "deal" | "best_seller";

/** Badges `cardBadges(product, now)` can return, in priority order. */
export type DerivedCardBadge = "sale" | "new" | "top_pick";

/** At most this many badges are shown on one card. */
export const CARD_BADGE_MAX = 2;
/** "New" while `publishedAt` is at most this many days before `now` (inclusive). */
export const CARD_BADGE_NEW_DAYS = 30;
/** "Top pick" needs an average rating of at least this... */
export const CARD_BADGE_TOP_PICK_MIN_RATING = 4.5;
/** ...from at least this many reviews. */
export const CARD_BADGE_TOP_PICK_MIN_REVIEWS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Badge text and look; meaning is always carried by the text. */
export const PRODUCT_CARD_BADGES: Readonly<
  Record<ProductCardBadge, { label: string; tone: BadgeTone; emphasis: BadgeEmphasis }>
> = {
  sale: { label: "Sale", tone: "deal", emphasis: "solid" },
  new: { label: "New", tone: "promo", emphasis: "solid" },
  top_pick: { label: "Top pick", tone: "accent", emphasis: "solid" },
  deal: { label: "Deal", tone: "deal", emphasis: "solid" },
  best_seller: { label: "Best Seller", tone: "neutral", emphasis: "solid" },
};

/** Product fields the badge rules read. */
export type CardBadgeProduct = Pick<
  Product,
  "priceCents" | "listPriceCents" | "publishedAt" | "ratingAvg" | "ratingCount"
>;

function isNew(publishedAt: string | undefined, now: Date): boolean {
  if (typeof publishedAt !== "string" || publishedAt === "") return false;
  const published = Date.parse(publishedAt);
  // Brand check rather than \`instanceof\`: a Date from another realm, or one
  // made before \`globalThis.Date\` was swapped (clock-counting tests), is valid.
  const nowMs = Object.prototype.toString.call(now) === "[object Date]" ? now.getTime() : Number.NaN;
  if (!Number.isFinite(published) || !Number.isFinite(nowMs)) return false;
  const elapsed = nowMs - published;
  // Future-dated (not yet published) products are never "New".
  return elapsed >= 0 && elapsed <= CARD_BADGE_NEW_DAYS * DAY_MS;
}

function isTopPick(avg: number | undefined, count: number | undefined): boolean {
  return (
    typeof avg === "number" &&
    Number.isFinite(avg) &&
    avg >= CARD_BADGE_TOP_PICK_MIN_RATING &&
    typeof count === "number" &&
    Number.isSafeInteger(count) &&
    count >= CARD_BADGE_TOP_PICK_MIN_REVIEWS
  );
}

function deriveBadges(product: CardBadgeProduct, now: Date): DerivedCardBadge[] {
  const out: DerivedCardBadge[] = [];
  if (computeSavings(product.priceCents, product.listPriceCents) !== null) out.push("sale");
  if (isNew(product.publishedAt, now)) out.push("new");
  if (isTopPick(product.ratingAvg, product.ratingCount)) out.push("top_pick");
  return out.slice(0, CARD_BADGE_MAX);
}

function isBadgeList(value: unknown): value is readonly ProductCardBadge[] {
  return Array.isArray(value);
}

function isKnownBadge(value: unknown): value is ProductCardBadge {
  return typeof value === "string" && Object.hasOwn(PRODUCT_CARD_BADGES, value);
}

/**
 * Explicit badge list from a caller: known keys only, first occurrence wins,
 * order kept, capped at `CARD_BADGE_MAX`. Prototype keys ("toString",
 * "__proto__") are ignored.
 */
export function normalizeCardBadges(badges: readonly ProductCardBadge[] | undefined): ProductCardBadge[] {
  if (!isBadgeList(badges)) return [];
  const out: ProductCardBadge[] = [];
  for (const badge of badges) {
    if (isKnownBadge(badge) && !out.includes(badge)) out.push(badge);
  }
  return out.slice(0, CARD_BADGE_MAX);
}

/**
 * Card badges derived from product data, in priority order sale > new > top
 * pick, at most `CARD_BADGE_MAX`:
 * - `sale`: a valid list price strictly above the price.
 * - `new`: `publishedAt` between `now - 30 days` and `now`, both inclusive.
 * - `top_pick`: `ratingAvg >= 4.5` and `ratingCount >= 5`.
 * Pure: the same input and `now` always give the same output; invalid data
 * (NaN, bad dates, an invalid `now`) never throws, it just yields no badge.
 */
export function cardBadges(product: CardBadgeProduct, now: Date): DerivedCardBadge[];
/**
 * @deprecated Phase 2 form kept so existing callers compile: normalises an
 * explicit list. Use `normalizeCardBadges(badges)`.
 */
export function cardBadges(badges: readonly ProductCardBadge[] | undefined): ProductCardBadge[];
export function cardBadges(
  input: CardBadgeProduct | readonly ProductCardBadge[] | undefined,
  now?: Date,
): ProductCardBadge[] {
  if (input === undefined || isBadgeList(input)) return normalizeCardBadges(input);
  if (input === null || typeof input !== "object") return [];
  return deriveBadges(input, now ?? new Date(Number.NaN));
}
