import NextLink from "next/link";
import type { AnchorHTMLAttributes, Ref } from "react";
import { isAllowedInternalHref } from "@/content/routes";
import { Image } from "../Image";

/**
 * - `circle` (default): round image, caption centred below (home category rail).
 * - `rounded`: 12px-radius square image, caption below.
 * - `card`: rectangular (4:5) image with a rounded-lg frame, caption below
 *   (category discovery rail).
 */
export type CategoryTileShape = "circle" | "rounded" | "card";
export type CategoryTileSize = "sm" | "md" | "lg";

export interface CategoryTileProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children"> {
  /**
   * Destination. Must pass `isAllowedInternalHref` (root-relative link to a
   * planned route, e.g. `/category/kitchen`); anything else renders `#` and
   * logs a development warning.
   */
  href: string;
  /** Visible caption (clamped to 2 lines); it is the link's accessible name. */
  label: string;
  /**
   * Image URL. Missing, empty or whitespace-only renders the fallback tile
   * (the label's initial letter on a neutral surface). An image that fails
   * to load shows the Image atom's neutral placeholder.
   */
  imageSrc: string | null | undefined;
  /**
   * Defaults to "" (decorative): the visible caption already names the link.
   * Only pass text if the image adds information the caption doesn't; it is
   * then appended to the accessible name.
   */
  imageAlt?: string;
  /** `circle` (default), `rounded` (12px square) or `card` (rectangular image card). */
  shape?: CategoryTileShape;
  /**
   * Tile width, responsive (below md -> from md):
   * circle/rounded: sm 64px, md 80 -> 96px (default), lg 80 -> 128px
   * (about four lg circles per 390px screen; matches ScrollRail
   * `itemWidth="sm"`). card: sm 112 -> 128px, md 128 -> 160px,
   * lg 160 -> 224px (pair with ScrollRail `itemWidth="auto"`).
   */
  size?: CategoryTileSize;
  /** Above-the-fold tiles (first row of the home page). */
  priority?: boolean;
  ref?: Ref<HTMLAnchorElement>;
}

/** Rendered in place of any href that fails the route allowlist. */
export const CATEGORY_TILE_UNSAFE_HREF = "#";

const squareWidths: Record<CategoryTileSize, string> = {
  sm: "w-16",
  md: "w-20 md:w-24",
  lg: "w-20 md:w-32",
};

const cardWidths: Record<CategoryTileSize, string> = {
  sm: "w-28 md:w-32",
  md: "w-32 md:w-40",
  lg: "w-40 md:w-56",
};

const squareImageSizes: Record<CategoryTileSize, string> = {
  sm: "64px",
  md: "(min-width: 768px) 96px, 80px",
  lg: "(min-width: 768px) 128px, 80px",
};

const cardImageSizes: Record<CategoryTileSize, string> = {
  sm: "(min-width: 768px) 128px, 112px",
  md: "(min-width: 768px) 160px, 128px",
  lg: "(min-width: 768px) 224px, 160px",
};

const labelClasses: Record<CategoryTileSize, string> = {
  sm: "text-caption",
  md: "text-small",
  lg: "text-small md:text-body",
};

const initialClasses: Record<CategoryTileSize, string> = {
  sm: "text-h4",
  md: "text-h2",
  lg: "text-h2 md:text-h1",
};

const maskClasses: Record<CategoryTileShape, string> = {
  circle: "aspect-square rounded-full",
  rounded: "aspect-square rounded-lg",
  card: "aspect-4/5 rounded-lg",
};

function safeHref(href: string): string {
  if (isAllowedInternalHref(href)) return href;
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `CategoryTile: href ${JSON.stringify(href)} is not an allowed internal route; rendering "${CATEGORY_TILE_UNSAFE_HREF}" instead.`,
    );
  }
  return CATEGORY_TILE_UNSAFE_HREF;
}

/** First character (code point) of the trimmed label, upper-cased; "" for a blank label. */
export function categoryTileInitial(label: string): string {
  const first = Array.from(typeof label === "string" ? label.trim() : "")[0];
  return first === undefined ? "" : first.toLocaleUpperCase("en-US");
}

/**
 * Category shortcut: an image (circle, rounded square or rectangular card)
 * with the category name below. The whole tile is ONE link (one tab stop);
 * the image is decorative so the caption is the accessible name. The focus
 * ring sits on the link (outside the overflow-hidden mask), so the round mask
 * never clips it. Server component (renders the client Image atom).
 */
export function CategoryTile({
  href,
  label,
  imageSrc,
  imageAlt = "",
  shape = "circle",
  size = "md",
  priority = false,
  className,
  ref,
  ...rest
}: CategoryTileProps) {
  const isCard = shape === "card";
  const src = typeof imageSrc === "string" ? imageSrc.trim() : "";
  const classes = [
    // min-w/min-h-touch keep the hit area >= 44px whatever the size.
    "group inline-flex min-h-touch min-w-touch shrink-0 flex-col items-center gap-2 rounded-lg text-center text-text-primary no-underline",
    // Width/offset only: the colour comes from the base layer, so the white
    // `.bg-surface-inverse :focus-visible` ring applies on dark bands (D-T131-4).
    "focus-visible:outline-2 focus-visible:outline-offset-2",
    isCard ? cardWidths[size] : squareWidths[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <NextLink {...rest} ref={ref} href={safeHref(href)} className={classes} data-shape={shape}>
      <span
        data-mask=""
        className={[
          "relative block w-full overflow-hidden border border-border-default bg-surface-sunken transition-shadow group-hover:shadow-md",
          maskClasses[shape],
        ].join(" ")}
      >
        {src === "" ? (
          <span
            {...(imageAlt === "" ? { "aria-hidden": true as const } : { role: "img", "aria-label": imageAlt })}
            data-placeholder=""
            data-fallback=""
            className={`absolute inset-0 flex items-center justify-center font-bold text-text-secondary ${initialClasses[size]}`}
          >
            {categoryTileInitial(label)}
          </span>
        ) : (
          <Image
            src={src}
            alt={imageAlt}
            fill
            sizes={isCard ? cardImageSizes[size] : squareImageSizes[size]}
            priority={priority}
            className="object-cover"
          />
        )}
      </span>
      <span
        className={`${labelClasses[size]} line-clamp-2 w-full break-words font-medium underline-offset-2 group-hover:underline`}
      >
        {label}
      </span>
    </NextLink>
  );
}
