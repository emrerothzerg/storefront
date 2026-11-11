import { Badge } from "@/components/atoms/Badge";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Rating } from "@/components/atoms/Rating";
import type { HeadingLevel } from "@/components/atoms/Typography";
import type { Product } from "@/lib/types";
import type { CartActionFn } from "../_contracts/cart-actions";
import type { ListActionFn } from "../_contracts/list-actions";
import { CompareToggle } from "../CompareToggle";
import { PriceBlock } from "../PriceBlock";
import { StockBadge } from "../StockBadge";
import { StockUrgency } from "../StockUrgency";
import { WishlistButton } from "../WishlistButton";
import { PRODUCT_CARD_BADGES, cardBadges, normalizeCardBadges, type ProductCardBadge } from "./card-badges";
import { excerpt } from "./excerpt";
import { QuickAddForm } from "./QuickAddForm";

/** Responsive widths for a 2 (phones and up) / 3 (md) / 4 (lg+) column grid; the grid never drops to 1 column. */
export const PRODUCT_CARD_IMAGE_SIZES =
  "(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw";

/** List layout: full width on phones, a 12rem thumbnail column from `sm` up. */
export const PRODUCT_CARD_LIST_IMAGE_SIZES = "(min-width: 640px) 12rem, 100vw";

/** Compact (rail) card: about 12rem wide, a bit under half the viewport on phones. */
export const PRODUCT_CARD_COMPACT_IMAGE_SIZES = "(min-width: 640px) 12rem, 45vw";

/**
 * Stand-in clock used only when the caller omits `now`; paired with an absent
 * `publishedAt` so the "New" rule never fires. Built once at module load (with
 * an argument, so it is not a clock read).
 */
const NO_CLOCK = new Date(Number.NaN);

/** Maximum bullets shown in the list layout. */
export const PRODUCT_CARD_MAX_BULLETS = 3;

export type ProductCardLayout = "grid" | "list";
/** `default`: listing grids. `compact`: smaller card for rails (same data, tighter type and padding). */
export type ProductCardVariant = "default" | "compact";

export interface ProductCardRating {
  /** Mean rating 0-5. */
  avg: number;
  /** Number of ratings; the rating is hidden unless this is a positive integer. */
  count: number;
}

export interface ProductCardWishlist {
  inList: boolean;
  /** List holding the product (required by `removeAction` when `inList`); null = default wish list. */
  listId?: string | null;
  addAction: ListActionFn;
  removeAction: ListActionFn;
}

export interface ProductCardQuickAdd {
  /** `addToCart` server action (cart contract); posts productId + quantity=1. */
  action: CartActionFn;
}

export interface ProductCardCompare {
  /** Current `?p=` compare slugs. */
  selected: readonly string[];
  /** Listing path (with its query) for the "Add to selection" submit. */
  basePath?: string;
}

export interface ProductCardProps {
  product: Product;
  /** Above-the-fold card: loads the image eagerly with high fetch priority. */
  priority?: boolean;
  /** Outline level of the product name heading. Defaults to 3 (grid under a page h1/section h2). */
  headingLevel?: Exclude<HeadingLevel, 1>;
  className?: string;
  /** Star rating + count. Defaults to `product.ratingAvg` / `product.ratingCount`. Hidden when count is 0. */
  rating?: ProductCardRating | null;
  /** Struck "Was" price + "N% off" when greater than the price. Defaults to `product.listPriceCents`. */
  listPriceCents?: number | null;
  /**
   * Explicit badges (max 2, duplicates and unknown values ignored). When
   * omitted, badges are derived with `cardBadges(product, now)` (Sale / New /
   * Top pick). Pass `[]` for none.
   */
  badges?: readonly ProductCardBadge[];
  /**
   * Clock for the "New" badge, read once by the page loader and passed down
   * (grids, rails and pages forward ONE `now` to every card). The card never
   * reads the clock itself: when omitted, the time-based "New" badge is
   * skipped and only Sale / Top pick are derived.
   */
  now?: Date;
  /** Best-sellers position, shown as "#N" (positive integers only). */
  rank?: number;
  /** Real stock: replaces the MVP stock badge with `StockUrgency` and drives quick add. */
  stock?: number;
  /** Heart toggle (`WishlistButton variant="icon"`) over the image corner. */
  wishlist?: ProductCardWishlist;
  /** One-unit "+ Add" form under the image. Disabled "Out of stock" when stock is 0. */
  quickAdd?: ProductCardQuickAdd;
  /** Compare checkbox form (`CompareToggle mode="form"`). */
  compare?: ProductCardCompare;
  /** `list` adds a description excerpt (<= 160 chars) and up to 3 bullets. Defaults to "grid". Ignored by `compact`. */
  layout?: ProductCardLayout;
  /** Key features for the list layout (first 3 shown, as text). */
  bullets?: readonly string[];
  /** Defaults to "default". */
  variant?: ProductCardVariant;
}

export function productHref(slug: string): string {
  return `/products/${encodeURIComponent(slug)}`;
}

function join(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Validated rating to display, or null (no reviews, invalid numbers). */
export function cardRating(
  rating: ProductCardRating | null | undefined,
  product: Pick<Product, "ratingAvg" | "ratingCount">,
): ProductCardRating | null {
  const source =
    rating !== undefined
      ? rating
      : product.ratingCount !== undefined && product.ratingAvg !== undefined
        ? { avg: product.ratingAvg, count: product.ratingCount }
        : null;
  if (source === null) return null;
  const { avg, count } = source;
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  if (!Number.isFinite(avg) || avg <= 0) return null;
  return { avg: Math.min(5, avg), count };
}

/** Up to `PRODUCT_CARD_MAX_BULLETS` non-blank bullets, each excerpted to 160 chars. */
export function cardBullets(bullets: readonly string[] | undefined): string[] {
  if (bullets === undefined) return [];
  return bullets
    .filter((b): b is string => typeof b === "string")
    .map((b) => excerpt(b))
    .filter((b) => b !== "")
    .slice(0, PRODUCT_CARD_MAX_BULLETS);
}

interface VariantStyle {
  card: string;
  /** Same inset as `card` padding so the overlay sits exactly on the image box. */
  overlayInset: string;
  title: string;
  /** Grid only: min height of two title lines (the title token's line-height x 2), so prices align across a row (U14). */
  titleTwoLines: string;
  gap: string;
}

const VARIANT_STYLES: Record<ProductCardVariant, VariantStyle> = {
  default: { card: "p-3", overlayInset: "inset-x-3 top-3", title: "text-body", titleTwoLines: "min-h-12", gap: "gap-2" },
  compact: { card: "p-2", overlayInset: "inset-x-2 top-2", title: "text-small", titleTwoLines: "min-h-10", gap: "gap-1" },
};

/**
 * Product tile for listing grids, lists and (compact) rails. Server-safe; the
 * heart and "+ Add" are client islands.
 *
 * Structure (one link, no nested controls):
 * - ONE `<a>` to the product page wrapping the fixed-aspect image box
 *   (decorative image, `alt=""`) and the name heading, so image and title are
 *   a single link whose accessible name is the product name.
 * - A sibling overlay (`pointer-events-none`, same box as the image) holds the
 *   badges (top left), the heart (top right) and the "+ Add" form (bottom
 *   left); only the controls take pointer events. Controls sit in `z-raised`.
 * - Brand line, compact rating, price, stock line and compare follow as text
 *   and siblings of the link.
 */
export function ProductCard({
  product,
  priority = false,
  headingLevel = 3,
  className,
  rating,
  listPriceCents,
  badges,
  now,
  rank,
  stock,
  wishlist,
  quickAdd,
  compare,
  layout = "grid",
  bullets,
  variant = "default",
}: ProductCardProps) {
  const compact = variant === "compact";
  const style = VARIANT_STYLES[compact ? "compact" : "default"];
  const isList = layout === "list" && !compact;
  const shownLayout: ProductCardLayout = isList ? "list" : "grid";

  const shownRating = cardRating(rating, product);
  const list = listPriceCents !== undefined ? listPriceCents : product.listPriceCents;
  // Badges follow what the card shows (rating/list-price overrides included).
  // Without a caller `now` the "New" rule gets no publish date, so the card
  // never reads the clock (one clock per page: the loader's `now`).
  const shownBadges =
    badges !== undefined
      ? normalizeCardBadges(badges)
      : cardBadges(
          {
            priceCents: product.priceCents,
            listPriceCents: list,
            publishedAt: now !== undefined ? product.publishedAt : undefined,
            ratingAvg: shownRating?.avg,
            ratingCount: shownRating?.count,
          },
          now ?? NO_CLOCK,
        );
  const shownRank = rank !== undefined && Number.isSafeInteger(rank) && rank > 0 ? rank : null;
  const effectiveStock = stock ?? product.stock;
  const description = isList ? excerpt(product.description) : "";
  const shownBullets = isList ? cardBullets(bullets) : [];
  const brand = typeof product.brandName === "string" ? product.brandName.trim() : "";
  const TitleTag = `h${headingLevel}` as const;
  const hasOverlay = shownRank !== null || shownBadges.length > 0 || wishlist !== undefined || quickAdd !== undefined;

  const classes = join(
    "relative flex min-w-40 flex-col rounded-lg border border-border-default bg-surface-raised shadow-sm transition-shadow hover:shadow-md",
    style.card,
    style.gap,
    isList && "sm:flow-root",
    className,
  );

  return (
    <article className={classes} data-layout={shownLayout} data-variant={variant}>
      <Link
        href={productHref(product.slug)}
        variant="subtle"
        className={join("w-full flex-col rounded-lg", style.gap, isList && "sm:block")}
      >
        <div
          className={join(
            "relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg bg-surface-raised",
            isList && "sm:float-left sm:mr-4 sm:w-48",
          )}
          data-slot="product-card-image"
        >
          <Image
            src={product.imageUrl}
            alt=""
            width={600}
            height={600}
            sizes={
              compact ? PRODUCT_CARD_COMPACT_IMAGE_SIZES : isList ? PRODUCT_CARD_LIST_IMAGE_SIZES : PRODUCT_CARD_IMAGE_SIZES
            }
            priority={priority}
            className="h-full w-full object-contain"
          />
        </div>
        <TitleTag
          className={join(
            "w-full min-w-0 break-words text-left font-medium text-text-primary",
            isList && "sm:w-auto",
            style.title,
            isList ? "line-clamp-3" : join("line-clamp-2", style.titleTwoLines),
          )}
        >
          {product.name}
        </TitleTag>
      </Link>
      {hasOverlay ? (
        <div
          className={join(
            "pointer-events-none absolute z-raised aspect-square",
            style.overlayInset,
            isList && "sm:right-auto sm:w-48",
          )}
          data-slot="product-card-overlay"
        >
          {shownRank !== null || shownBadges.length > 0 ? (
            <div
              className={join("absolute left-1 top-1 flex max-w-full flex-wrap items-center gap-1", wishlist && "pr-12")}
              data-testid="product-card-badges"
            >
              {shownRank !== null ? (
                <span className="rounded-full bg-surface-raised px-2 py-0.5 text-caption font-semibold text-text-primary shadow-sm">
                  <span className="sr-only">Rank </span>
                  {`#${shownRank}`}
                </span>
              ) : null}
              {shownBadges.map((badge) => (
                <Badge
                  key={badge}
                  tone={PRODUCT_CARD_BADGES[badge].tone}
                  emphasis={PRODUCT_CARD_BADGES[badge].emphasis}
                  shape="pill"
                  size="sm"
                >
                  {PRODUCT_CARD_BADGES[badge].label}
                </Badge>
              ))}
            </div>
          ) : null}
          {wishlist ? (
            <div className="pointer-events-auto absolute right-0 top-0 z-raised">
              <WishlistButton
                productId={product.id}
                productSlug={product.slug}
                productName={product.name}
                inList={wishlist.inList}
                listId={wishlist.listId ?? null}
                addAction={wishlist.addAction}
                removeAction={wishlist.removeAction}
                variant="icon"
                size={compact ? "sm" : "md"}
              />
            </div>
          ) : null}
          {quickAdd ? (
            <QuickAddForm
              productId={product.id}
              productName={product.name}
              stock={effectiveStock}
              action={quickAdd.action}
              size={compact ? "sm" : "md"}
              className="pointer-events-auto absolute bottom-0 left-0 z-raised max-w-full"
            />
          ) : null}
        </div>
      ) : null}
      <div className={join("flex min-w-0 flex-1 flex-col", style.gap, isList && "sm:ml-52 sm:mt-2")}>
        {brand !== "" ? (
          <p className="min-w-0 truncate text-caption text-text-secondary" data-slot="product-card-brand">
            {brand}
          </p>
        ) : null}
        {shownRating !== null ? (
          <Rating value={shownRating.avg} count={shownRating.count} variant="compact" size="sm" />
        ) : null}
        {description !== "" ? <p className="break-words text-small text-text-secondary">{description}</p> : null}
        {shownBullets.length > 0 ? (
          <ul role="list" className="flex list-disc flex-col gap-1 pl-5 text-small text-text-primary">
            {shownBullets.map((bullet, i) => (
              <li key={i} className="break-words">
                {bullet}
              </li>
            ))}
          </ul>
        ) : null}
        <div className={join("mt-auto flex min-w-0 flex-col", style.gap)}>
          <PriceBlock
            priceCents={product.priceCents}
            currency={product.currency}
            listPriceCents={list}
            size="sm"
            display="superscript"
            layout="inline"
          />
          {stock !== undefined ? <StockUrgency stock={stock} /> : <StockBadge stock={product.stock} />}
        </div>
        {compare ? (
          <CompareToggle
            mode="form"
            productSlug={product.slug}
            productName={product.name}
            selected={compare.selected}
            basePath={compare.basePath}
            className="relative z-raised"
          />
        ) : null}
      </div>
    </article>
  );
}
