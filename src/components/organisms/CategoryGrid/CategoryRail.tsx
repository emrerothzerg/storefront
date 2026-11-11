import { useId } from "react";
import { CategoryTile } from "@/components/atoms/CategoryTile";
import { ScrollRail } from "@/components/atoms/ScrollRail";
import { Heading } from "@/components/atoms/Typography";
import { FALLBACK_TILE_ART, getCategoryTileArt } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";

/**
 * Structural subset of `Category` / `CategoryWithCount`. `image`, `imageUrl`
 * and `productCount` are accepted so existing rows fit, but the tile art
 * always comes from `getCategoryTileArt(slug)` (placeholder art, T136): the
 * department tile for a department slug, else the stable per-category
 * discovery pattern (T179 U13), so leaf categories no longer all show the
 * fallback bag.
 */
export interface CategoryRailItem {
  slug: string;
  name: string;
  image?: string | null;
  imageUrl?: string | null;
  productCount?: number;
}

export interface CategoryRailProps {
  categories: readonly CategoryRailItem[];
  /** Defaults to "Shop by department". Blank falls back to the default. */
  title?: string;
  /** Defaults to 2 (section `h2`); 3 when nested under another `h2`. */
  headingLevel?: 2 | 3;
  /** Section id (the home page passes `home-categories`); heading id is `<id>-heading` (else `useId`). */
  id?: string;
  className?: string;
}

export const CATEGORY_RAIL_DEFAULT_TITLE = "Shop by department";
/** At most this many department tiles; more adds a trailing "All departments" tile. */
export const CATEGORY_RAIL_MAX_TILES = 12;
export const CATEGORY_RAIL_ALL_LABEL = "All departments";
/** No `/departments` index exists (ruling O-3): the overflow tile goes to the full catalogue. */
export const CATEGORY_RAIL_ALL_HREF = "/products";

export interface CategoryRailTile {
  slug: string;
  name: string;
  href: string;
  imageSrc: string;
}

/** `/category/<slug>`, slug percent-encoded so `?`, `#` or `/` cannot change the path. */
export function categoryRailHref(slug: string): string {
  return `/category/${encodeURIComponent(slug)}`;
}

/**
 * Valid, de-duplicated tiles in input order (not capped). Drops non-objects,
 * entries with a blank name or slug, repeated slugs, and slugs whose
 * `/category/<slug>` href fails `isAllowedInternalHref`. Never throws.
 */
export function categoryRailTiles(categories: readonly CategoryRailItem[]): CategoryRailTile[] {
  if (!Array.isArray(categories)) return [];
  const seen = new Set<string>();
  const tiles: CategoryRailTile[] = [];
  for (const category of categories as readonly unknown[]) {
    if (category === null || typeof category !== "object") continue;
    const { slug: rawSlug, name: rawName } = category as Partial<CategoryRailItem>;
    const slug = typeof rawSlug === "string" ? rawSlug.trim() : "";
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (slug === "" || name === "" || seen.has(slug)) continue;
    const href = categoryRailHref(slug);
    if (!isAllowedInternalHref(href)) continue;
    seen.add(slug);
    tiles.push({ slug, name, href, imageSrc: getCategoryTileArt(slug).path });
  }
  return tiles;
}

/**
 * Home "Shop by department" rail (reference H4): a section with an `h2` and
 * a `ScrollRail` of circular `CategoryTile`s, one per department in data
 * order. More than `CATEGORY_RAIL_MAX_TILES` valid departments: the first 12
 * plus a trailing "All departments" tile linking `/products`. No valid
 * department: renders nothing (no empty heading). Tiles contain no headings;
 * images are decorative (`alt=""`), the link name is the department name.
 * Without JS the rail is a native, keyboard-focusable horizontal scroller.
 * Server component (ScrollRail is a client island).
 */
export function CategoryRail({
  categories,
  title = CATEGORY_RAIL_DEFAULT_TITLE,
  headingLevel = 2,
  id,
  className,
}: CategoryRailProps) {
  const autoId = useId();
  const valid = categoryRailTiles(categories);
  if (valid.length === 0) return null;
  const overflow = valid.length > CATEGORY_RAIL_MAX_TILES;
  const tiles = overflow ? valid.slice(0, CATEGORY_RAIL_MAX_TILES) : valid;
  const heading =
    typeof title === "string" && title.trim() !== "" ? title.trim() : CATEGORY_RAIL_DEFAULT_TITLE;
  const headingId = `${id ?? `category-rail-${autoId}`}-heading`;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-category-rail=""
      className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      <Heading level={headingLevel} size={headingLevel === 2 ? "h3" : "h4"} id={headingId} className="break-words">
        {heading}
      </Heading>
      <ScrollRail label={`${heading}, category list`} itemWidth="sm" gap="sm">
        {tiles.map((tile) => (
          <div key={tile.slug} className="flex justify-center">
            <CategoryTile href={tile.href} label={tile.name} imageSrc={tile.imageSrc} shape="circle" size="lg" />
          </div>
        ))}
        {overflow ? (
          <div key="all-departments" className="flex justify-center">
            <CategoryTile
              href={CATEGORY_RAIL_ALL_HREF}
              label={CATEGORY_RAIL_ALL_LABEL}
              imageSrc={FALLBACK_TILE_ART.path}
              shape="circle"
              size="lg"
              data-all-departments=""
            />
          </div>
        ) : null}
      </ScrollRail>
    </section>
  );
}
