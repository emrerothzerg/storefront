import { useId } from "react";
import { CategoryTile } from "@/components/atoms/CategoryTile";
import { ScrollRail } from "@/components/atoms/ScrollRail";
import { Heading, Text } from "@/components/atoms/Typography";
import { getCategoryTileArt } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";

/** Structural subset of `Category` (child categories of one department). */
export interface CategoryDiscoveryItem {
  slug: string;
  name: string;
}

export interface CategoryDiscoveryProps {
  /** Child categories, in display order. Invalid/duplicate entries are dropped; at most 6 are shown. */
  categories: readonly CategoryDiscoveryItem[];
  /** Section `h2`. Defaults to "Explore popular categories"; blank falls back to the default. */
  title?: string;
  /** Short line above the heading. Defaults to "Discover something new"; blank hides it. */
  eyebrow?: string;
  /** Section id; defaults to `home-discovery` (contract H-13). Heading id is `<id>-heading`. */
  id?: string;
  className?: string;
}

export const CATEGORY_DISCOVERY_DEFAULT_TITLE = "Explore popular categories";
export const CATEGORY_DISCOVERY_DEFAULT_EYEBROW = "Discover something new";
export const CATEGORY_DISCOVERY_DEFAULT_ID = "home-discovery";
export const CATEGORY_DISCOVERY_MAX_TILES = 6;

export interface CategoryDiscoveryTile {
  slug: string;
  name: string;
  href: string;
  imageSrc: string;
}

function categoryHref(slug: string): string {
  return `/category/${encodeURIComponent(slug)}`;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Up to 6 valid, de-duplicated tiles in input order. Drops non-objects, blank
 * slug/name, repeated slugs and slugs whose `/category/<slug>` href fails
 * `isAllowedInternalHref`. Art is `getCategoryTileArt(slug)` (T179 U13): the
 * same per-category art the department page's `CategoryRail` shows, stable
 * per slug whatever the tile's position. Never throws.
 */
export function categoryDiscoveryTiles(categories: readonly CategoryDiscoveryItem[]): CategoryDiscoveryTile[] {
  if (!Array.isArray(categories)) return [];
  const seen = new Set<string>();
  const tiles: CategoryDiscoveryTile[] = [];
  for (const category of categories as readonly unknown[]) {
    if (tiles.length >= CATEGORY_DISCOVERY_MAX_TILES) break;
    if (category === null || typeof category !== "object") continue;
    const { slug: rawSlug, name: rawName } = category as Partial<CategoryDiscoveryItem>;
    const slug = cleanText(rawSlug);
    const name = cleanText(rawName);
    if (slug === "" || name === "" || seen.has(slug)) continue;
    const href = categoryHref(slug);
    if (!isAllowedInternalHref(href)) continue;
    seen.add(slug);
    tiles.push({ slug, name, href, imageSrc: getCategoryTileArt(slug).path });
  }
  return tiles;
}

/**
 * Home category discovery rail (reference H8): eyebrow + `h2`, then a
 * `ScrollRail` of up to 6 rectangular `CategoryTile` cards (`shape="card"`),
 * each ONE link to `/category/<slug>` named by the caption (images
 * decorative). Tiles contain no headings. No valid category: renders nothing.
 * Server component (ScrollRail is a client island).
 */
export function CategoryDiscovery({
  categories,
  title = CATEGORY_DISCOVERY_DEFAULT_TITLE,
  eyebrow = CATEGORY_DISCOVERY_DEFAULT_EYEBROW,
  id = CATEGORY_DISCOVERY_DEFAULT_ID,
  className,
}: CategoryDiscoveryProps) {
  const autoId = useId();
  const tiles = categoryDiscoveryTiles(categories);
  if (tiles.length === 0) return null;
  const heading = cleanText(title) === "" ? CATEGORY_DISCOVERY_DEFAULT_TITLE : cleanText(title);
  const eyebrowText = cleanText(eyebrow);
  const sectionId = cleanText(id) === "" ? undefined : cleanText(id);
  const headingId = `${sectionId ?? `category-discovery-${autoId}`}-heading`;

  return (
    <section
      id={sectionId}
      aria-labelledby={headingId}
      data-category-discovery=""
      className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      <div className="flex flex-col gap-1">
        {eyebrowText === "" ? null : (
          <Text variant="small" tone="secondary" data-eyebrow="" className="break-words">
            {eyebrowText}
          </Text>
        )}
        <Heading level={2} size="h3" id={headingId} className="break-words">
          {heading}
        </Heading>
      </div>
      <ScrollRail label={`${heading}, category list`} itemWidth="auto" gap="md">
        {tiles.map((tile) => (
          <CategoryTile
            key={tile.slug}
            href={tile.href}
            label={tile.name}
            imageSrc={tile.imageSrc}
            shape="card"
            size="lg"
          />
        ))}
      </ScrollRail>
    </section>
  );
}
