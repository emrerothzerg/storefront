import type { ReactNode } from "react";
import { Heading, Text } from "@/components/atoms/Typography";
import { ProductCard, type ProductCardLayout, type ProductCardProps } from "@/components/molecules/ProductCard";
import { PromoTile, type PromoTileProps } from "@/components/molecules/PromoTile";
import type { Product } from "@/lib/types";
import { placePromos, type PromoSlot } from "./place-promos";

/** Tile props a grid slot may set; ProductGrid owns `as`, `span` default and the heading level clamp. */
export type ProductGridPromoTile = Omit<PromoTileProps, "as">;

/** A promo tile shown right after the product at 0-based `afterIndex` (grid layout, page 1 only). */
export type ProductGridPromoSlot = PromoSlot<ProductGridPromoTile>;

/** Per-card extras supplied by the page (badges, wishlist state, compare selection, ...). */
export type ProductGridCardExtras = Partial<Omit<ProductCardProps, "product">>;

export interface ProductGridProps<P extends Product = Product> {
  products: readonly P[];
  /** The first N cards load their image eagerly (above the fold). Defaults to 4. */
  priorityCount?: number;
  /** Outline level of each card's product-name heading. Defaults to 3. */
  headingLevel?: 2 | 3 | 4;
  /** Body text of the default empty state. */
  emptyMessage?: string;
  /** Replaces the default empty state when `products` is empty. */
  emptyState?: ReactNode;
  /** `grid` (default): 2 / 3 (md) / 4 (lg) columns. `list`: one full-width row per product. */
  layout?: ProductCardLayout;
  /** Per-card props from the page; `product` cannot be overridden. `index` counts products only. */
  cardProps?: (product: P, index: number) => ProductGridCardExtras;
  /**
   * Promo tiles interspersed in the grid (`<PromoTile as="li">` siblings of
   * the product `<li>`s). Max 3 honoured; only when `page` is 1; ignored in
   * the list layout and for an empty grid. Rules: `placePromos`.
   */
  promoSlots?: readonly ProductGridPromoSlot[];
  /** Current listing page; promos render only on page 1. Defaults to 1. */
  page?: number;
  /** Full page size; a tile after the last product is kept only on a full page. */
  pageSize?: number;
  /**
   * The page's single clock (read once by its loader), forwarded to every
   * card for the "New" badge. A `now` set by `cardProps` (not undefined) wins for that card.
   * Omitted: cards skip the "New" badge and nothing reads the clock.
   */
  now?: Date;
  className?: string;
}

export const DEFAULT_PRIORITY_COUNT = 4;
export const DEFAULT_EMPTY_MESSAGE = "Check back soon: new products are on their way.";

/**
 * 2 columns down to 320px (never 1), 3 from `md`, 4 from `lg`. The small
 * 8px column gap below `xs` lets two 160px (`min-w-40`) cards fit at 360px
 * inside the page's 16px gutters; rows stretch so cards in a row share a height.
 */
export const PRODUCT_GRID_CLASSES =
  "grid min-w-0 grid-cols-2 gap-x-2 gap-y-4 xs:gap-4 md:grid-cols-3 lg:grid-cols-4 lg:gap-6";

/**
 * Grid cards may shrink below their 160px minimum only under `xs`, i.e. below
 * 360px where two 160px columns cannot fit (320px viewport), so the page
 * never scrolls sideways (R9). From 360px the track is at least 160px anyway.
 */
export const PRODUCT_GRID_CARD_CLASS = "max-xs:min-w-0";

const layoutClasses: Record<ProductCardLayout, string> = {
  grid: PRODUCT_GRID_CLASSES,
  list: "flex min-w-0 flex-col gap-4",
};

/** Promo headings inside the grid are h3 (or h4), never h1/h2 (CONTRACTS L-17). */
function promoHeadingLevel(level: ProductGridPromoTile["headingLevel"]): 3 | 4 {
  return level === 4 ? 4 : 3;
}

function hasHeading(tile: ProductGridPromoTile): boolean {
  return typeof tile.heading === "string" && tile.heading.trim() !== "";
}

function join(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Product listing as a semantic `<ul role="list">` of `ProductCard`s, in a
 * responsive grid or a single-column list. Server-safe. An empty list renders
 * `emptyState` (or the default explanatory empty state) instead of a blank area.
 * In the grid, up to 3 `promoSlots` render as `PromoTile` `<li>`s (2 columns
 * wide by default) between the product `<li>`s, on page 1 only.
 */
export function ProductGrid<P extends Product = Product>({
  products,
  priorityCount = DEFAULT_PRIORITY_COUNT,
  headingLevel = 3,
  emptyMessage = DEFAULT_EMPTY_MESSAGE,
  emptyState,
  layout = "grid",
  cardProps,
  promoSlots,
  page,
  pageSize,
  now,
  className,
}: ProductGridProps<P>) {
  if (products.length === 0) {
    if (emptyState !== undefined && emptyState !== null && emptyState !== false) {
      return <div className={join("min-w-0", className)}>{emptyState}</div>;
    }
    return (
      <div
        className={join(
          "flex min-w-0 flex-col items-center gap-2 rounded-lg bg-surface-sunken p-8 text-center",
          className,
        )}
      >
        <Heading level={2} size="h3">
          No products yet
        </Heading>
        <Text>{emptyMessage}</Text>
      </div>
    );
  }

  const mode: ProductCardLayout = layout === "list" ? "list" : "grid";

  const isGrid = mode === "grid";
  const entries = placePromos(products, isGrid ? promoSlots : undefined, {
    page,
    pageSize,
    isValidTile: hasHeading,
  });

  return (
    <ul role="list" data-layout={mode} className={join(layoutClasses[mode], className)}>
      {entries.map((entry) => {
        if (entry.kind === "promo") {
          const { tile } = entry;
          return (
            <PromoTile
              key={`promo-${entry.afterIndex}`}
              {...tile}
              as="li"
              span={tile.span ?? 2}
              headingLevel={promoHeadingLevel(tile.headingLevel)}
            />
          );
        }
        const { item: product, index } = entry;
        const extras = cardProps ? cardProps(product, index) : {};
        return (
          <li key={product.id} className="flex min-w-0">
            <ProductCard
              priority={index < priorityCount}
              headingLevel={headingLevel}
              layout={mode}
              {...extras}
              now={extras.now ?? now}
              product={product}
              className={join("w-full", isGrid && PRODUCT_GRID_CARD_CLASS, extras.className)}
            />
          </li>
        );
      })}
    </ul>
  );
}
