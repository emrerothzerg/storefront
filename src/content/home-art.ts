/**
 * Placeholder art for the home page and promos (T136).
 *
 * Every file lives under `public/images/home/` and is an original abstract
 * SVG: no photos, no third-party art, no brand marks and no text (all copy
 * lives in HTML). Colours are the raw palette values declared in
 * `src/app/globals.css` :root only; `home-art.test.ts` enforces that, plus
 * viewBox, size (< 40 KB) and the absence of scripts and external links.
 *
 * `alt` describes the artwork for the rare case it is the only content. When a
 * visible caption or headline already names the thing (category tiles, hero
 * slides, lifestyle cards), render the image as decorative with `alt=""`.
 * `width`/`height` are the intrinsic size; use them (or an aspect box) to
 * avoid layout shift.
 */

export interface HomeArtImage {
  /** Public URL path, e.g. "/images/home/hero-slide-1.svg". */
  readonly path: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
}

export const HOME_ART_DIR = "/images/home";

function art(file: string, alt: string, width: number, height: number): HomeArtImage {
  return Object.freeze({ path: `${HOME_ART_DIR}/${file}.svg`, alt, width, height });
}

const HERO_W = 1200;
const HERO_H = 900;
const PROMO_W = 640;
const PROMO_H = 400;
const TILE = 400;

/**
 * Full-bleed hero slide art (4:3, T178). Shown edge to edge in the right half
 * of the slide from md (object-cover, so it is cropped to roughly 1.1:1 to
 * 1.5:1) and as a 16:9 block under the copy on mobile. Every composition keeps
 * its subject inside the centre (x 200-1000, y 170-730) so any of those crops
 * reads well; the background colour matches the slide surface.
 */
export const HERO_SLIDE_ART: readonly HomeArtImage[] = Object.freeze([
  art("hero-slide-1", "Illustration of wrapped gift boxes on a blue background", HERO_W, HERO_H),
  art("hero-slide-2", "Illustration of a cooking pot, chopping board and mugs on a gold background", HERO_W, HERO_H),
  art("hero-slide-3", "Illustration of a laptop, phone and headphones on a pale blue background", HERO_W, HERO_H),
]);

/** Framed product-cluster panel shown beside the hero copy (4:3). */
export const HERO_PANEL_ART: HomeArtImage = art(
  "hero-panel",
  "Illustration of toy blocks, a die, a ball and a gift in a gold frame",
  800,
  600,
);

/** Shipping promo panel (8:5). */
export const DELIVERY_PROMO_ART: HomeArtImage = art(
  "promo-delivery",
  "Illustration of a parcel with motion lines",
  PROMO_W,
  PROMO_H,
);

/**
 * Listing promo tile art (8:5, T178), one per tile. Each background matches
 * its tile surface (gold promo, light-grey sunken, primary blue) so the art
 * blends into the tile beside the copy.
 */
export const DEALS_PROMO_ART: HomeArtImage = art(
  "promo-deals",
  "Illustration of a price tag with a percent sign",
  PROMO_W,
  PROMO_H,
);

export const BEST_SELLERS_PROMO_ART: HomeArtImage = art(
  "promo-best-sellers",
  "Illustration of a three-step podium with stars",
  PROMO_W,
  PROMO_H,
);

export const ACCOUNT_PROMO_ART: HomeArtImage = art(
  "promo-account",
  "Illustration of a profile card, a heart and a parcel",
  PROMO_W,
  PROMO_H,
);

/** Split beauty banner image half (2:1). */
export const BEAUTY_PROMO_ART: HomeArtImage = art(
  "promo-beauty",
  "Illustration of a pump bottle, lotion, lipstick and compact",
  800,
  400,
);

export const LIFESTYLE_ART_KEYS = ["living", "dining", "outdoor", "wardrobe"] as const;
export type LifestyleArtKey = (typeof LIFESTYLE_ART_KEYS)[number];

/** Lifestyle cards (4:3) for the 4-column "Explore" set. */
export const LIFESTYLE_ART: Readonly<Record<LifestyleArtKey, HomeArtImage>> = Object.freeze({
  living: art("lifestyle-living", "Illustration of a sofa, lamp, plant and framed picture", 600, 450),
  dining: art("lifestyle-dining", "Illustration of a laid dining table seen from above", 600, 450),
  outdoor: art("lifestyle-outdoor", "Illustration of green hills, a tree, the sun and a ball", 600, 450),
  wardrobe: art("lifestyle-wardrobe", "Illustration of three shirts on a clothes rail", 600, 450),
});

/** The 3-column lifestyle set reuses three of the four cards. */
export const LIFESTYLE_THREE_COLUMN_KEYS: readonly LifestyleArtKey[] = Object.freeze(["living", "dining", "outdoor"]);

/**
 * Square category tiles (1:1, fine for circle and card shapes) keyed by
 * department slug. Must cover every `DEPARTMENT_NAV` slug (tested); a new
 * department without art gets `FALLBACK_TILE_ART` via `getDepartmentTileArt`.
 */
export const DEPARTMENT_TILE_ART: Readonly<Record<string, HomeArtImage>> = Object.freeze({
  "home-kitchen": art("tile-home-kitchen", "Illustration of a cooking pot and a mug", TILE, TILE),
  electronics: art("tile-electronics", "Illustration of a phone and headphones", TILE, TILE),
  books: art("tile-books", "Illustration of a stack of books", TILE, TILE),
  clothing: art("tile-clothing", "Illustration of a T-shirt on a hanger", TILE, TILE),
  "sports-outdoors": art("tile-sports-outdoors", "Illustration of a ball and a water bottle", TILE, TILE),
  "beauty-personal-care": art("tile-beauty-personal-care", "Illustration of a pump bottle, lipstick and compact", TILE, TILE),
  "toys-games": art("tile-toys-games", "Illustration of toy blocks and a die", TILE, TILE),
  office: art("tile-office", "Illustration of a notebook, pencil and desk lamp", TILE, TILE),
});

/**
 * Abstract pattern tiles (1:1) for child-category cards (category discovery
 * rail), which have no dedicated art. Pick by position with `getDiscoveryTileArt`.
 */
export const DISCOVERY_TILE_ART: readonly HomeArtImage[] = Object.freeze([
  art("tile-discovery-1", "Abstract pattern of overlapping circles", TILE, TILE),
  art("tile-discovery-2", "Abstract pattern of wavy stripes", TILE, TILE),
  art("tile-discovery-3", "Abstract pattern of squares and circles in a grid", TILE, TILE),
  art("tile-discovery-4", "Abstract pattern of nested arcs", TILE, TILE),
]);

/** Neutral tile (shopping bag shape) for anything without art. */
export const FALLBACK_TILE_ART: HomeArtImage = art("tile-fallback", "Illustration of a shopping bag", TILE, TILE);

/** Department tile art, or the fallback tile for unknown/empty slugs. Never throws. */
export function getDepartmentTileArt(slug: string): HomeArtImage {
  return Object.hasOwn(DEPARTMENT_TILE_ART, slug) ? (DEPARTMENT_TILE_ART[slug] ?? FALLBACK_TILE_ART) : FALLBACK_TILE_ART;
}

/** Discovery tile for a rail position (cycles); fallback for negative, fractional or non-finite input. */
export function getDiscoveryTileArt(index: number): HomeArtImage {
  if (!Number.isInteger(index) || index < 0) return FALLBACK_TILE_ART;
  return DISCOVERY_TILE_ART[index % DISCOVERY_TILE_ART.length] ?? FALLBACK_TILE_ART;
}

/**
 * Tile art for a (leaf) category slug: the department tile when the slug is a
 * department, else a discovery pattern picked by a stable hash of the slug (so
 * a category keeps its art wherever it is listed). Blank or non-string slugs
 * get `FALLBACK_TILE_ART`. Never throws.
 */
export function getCategoryTileArt(slug: string): HomeArtImage {
  const key = typeof slug === "string" ? slug.trim() : "";
  if (key === "") return FALLBACK_TILE_ART;
  if (Object.hasOwn(DEPARTMENT_TILE_ART, key)) return getDepartmentTileArt(key);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return getDiscoveryTileArt(hash % DISCOVERY_TILE_ART.length);
}

/** Everything, keyed by purpose. */
export const HOME_ART = Object.freeze({
  heroSlides: HERO_SLIDE_ART,
  heroPanel: HERO_PANEL_ART,
  deliveryPromo: DELIVERY_PROMO_ART,
  dealsPromo: DEALS_PROMO_ART,
  bestSellersPromo: BEST_SELLERS_PROMO_ART,
  accountPromo: ACCOUNT_PROMO_ART,
  beautyPromo: BEAUTY_PROMO_ART,
  lifestyle: LIFESTYLE_ART,
  departmentTiles: DEPARTMENT_TILE_ART,
  discoveryTiles: DISCOVERY_TILE_ART,
  fallbackTile: FALLBACK_TILE_ART,
});

/** Flat list of every manifest entry (for tests and preloading decisions). */
export const ALL_HOME_ART: readonly HomeArtImage[] = Object.freeze([
  ...HERO_SLIDE_ART,
  HERO_PANEL_ART,
  DELIVERY_PROMO_ART,
  DEALS_PROMO_ART,
  BEST_SELLERS_PROMO_ART,
  ACCOUNT_PROMO_ART,
  BEAUTY_PROMO_ART,
  ...LIFESTYLE_ART_KEYS.map((key) => LIFESTYLE_ART[key]),
  ...Object.values(DEPARTMENT_TILE_ART),
  ...DISCOVERY_TILE_ART,
  FALLBACK_TILE_ART,
]);
