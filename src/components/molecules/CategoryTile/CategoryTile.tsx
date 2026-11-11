import { Icon, type IconName } from "@/components/atoms/Icon";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Text } from "@/components/atoms/Typography";
import { resolveInternalHref } from "./safe-href";

/** Structural subset of `Category` / `CategoryWithCount` (src/lib/types.ts). */
export interface CategoryTileCategory {
  slug: string;
  name: string;
  imageUrl?: string | null;
  productCount?: number;
}

export type CategoryTileSize = "sm" | "md";

export interface CategoryTileProps {
  category: CategoryTileCategory;
  /** Defaults to `/category/<encoded slug>`. Must pass `isAllowedInternalHref`, else renders `#` (dev warning). */
  href?: string;
  /** Shown when there is no image. Defaults to `grid`. */
  icon?: IconName;
  /** `md` (default): stacked square media over the name. `sm`: compact row with a 48px thumbnail. */
  size?: CategoryTileSize;
  className?: string;
}

/** Responsive widths for a 2 (mobile) / 3 (sm) / 4 (md) / 6 (lg+) column grid of md tiles. */
export const CATEGORY_TILE_IMAGE_SIZES =
  "(min-width: 1024px) 17vw, (min-width: 768px) 25vw, (min-width: 640px) 33vw, 50vw";

export function categoryHref(slug: string): string {
  return `/category/${encodeURIComponent(slug)}`;
}

/** Non-finite, negative or zero counts collapse to 0 (count hidden); fractions are floored. */
export function normaliseProductCount(count: number | undefined): number {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

export function formatProductCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "product" : "products"}`;
}

/** Accessible name: "Name, N products" / "Name, 1 product" / "Name" when the count is 0 or missing. */
export function categoryTileLabel(name: string, count: number | undefined): string {
  const n = normaliseProductCount(count);
  return n > 0 ? `${name}, ${formatProductCount(n)}` : name;
}

const frameClasses =
  "w-full rounded-lg border border-border-default bg-surface-raised p-3 shadow-sm transition-colors hover:border-border-strong hover:shadow-md";

/**
 * Category tile: ONE link wrapping the whole tile (single tab stop), named
 * "Name, N products" via `aria-label`. Image when `imageUrl` is non-blank,
 * otherwise a decorative icon on the accent tint. Server-safe.
 */
export function CategoryTile({
  category,
  href,
  icon = "grid",
  size = "md",
  className,
}: CategoryTileProps) {
  const count = normaliseProductCount(category.productCount);
  const label = categoryTileLabel(category.name, count);
  const safeHref = resolveInternalHref(href ?? categoryHref(category.slug), "CategoryTile");
  const imageUrl = typeof category.imageUrl === "string" ? category.imageUrl.trim() : "";
  const isSm = size === "sm";

  const media =
    imageUrl !== "" ? (
      <Image
        src={imageUrl}
        alt=""
        width={isSm ? 48 : 400}
        height={isSm ? 48 : 400}
        sizes={isSm ? undefined : CATEGORY_TILE_IMAGE_SIZES}
        rounded
        className={isSm ? "block size-12 shrink-0 object-cover" : "block aspect-square h-auto w-full object-cover"}
      />
    ) : (
      <span
        data-icon-fallback=""
        className={[
          "flex items-center justify-center rounded-md bg-accent-subtle text-accent",
          isSm ? "size-12 shrink-0" : "aspect-square w-full",
        ].join(" ")}
      >
        <Icon name={icon} size="lg" />
      </span>
    );

  return (
    <Link
      href={safeHref}
      variant="nav"
      aria-label={label}
      data-size={size}
      className={[frameClasses, className].filter(Boolean).join(" ")}
    >
      <span className={isSm ? "flex w-full min-w-0 items-center gap-3" : "flex w-full min-w-0 flex-col gap-3"}>
        {media}
        <span className="flex min-w-0 flex-col gap-1">
          <Text as="span" variant="body" className="font-semibold break-words">
            {category.name}
          </Text>
          {count > 0 ? (
            <Text as="span" variant="small" tone="secondary">
              {formatProductCount(count)}
            </Text>
          ) : null}
        </span>
      </span>
    </Link>
  );
}
