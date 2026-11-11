import { useId } from "react";
import { Card } from "@/components/atoms/Card";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import {
  STRETCHED_LINK_CLASSES,
  cleanPromoText,
  normalisePromoCta,
  normalisePromoHeadingLevel,
  normalisePromoImage,
  normalisePromoTone,
  promoToneStyle,
  type PromoCta,
  type PromoHeadingLevel,
  type PromoImage,
  type PromoTone,
  type PromoToneStyle,
} from "../PromoStrip/promo-shared";

export type PromoTileSpan = 1 | 2;

export interface PromoTileProps {
  /** Headline (plain text). Blank → the tile renders nothing. */
  heading: string;
  /** Supporting line (plain text, optional). */
  blurb?: string;
  /** The single call to action; an invalid href renders the tile without it. */
  cta?: PromoCta | null;
  /** Optional artwork (on top; beside the text from `sm` when `span` is 2). */
  image?: PromoImage | null;
  /** Grid columns the tile spans (1 = one product cell). Unknown → 1. */
  span?: PromoTileSpan;
  /**
   * Token-backed tone; unknown values fall back to `neutral`. Defaults to
   * `primary-subtle`. `primary` is the brand-blue surface (`promoTileToneStyle`).
   */
  tone?: PromoTone;
  /** Heading level (2-4, default 3; product grids use 3); never 1. */
  headingLevel?: PromoHeadingLevel;
  /**
   * Root element. `article` (default) for use inside a caller's `<li>`;
   * `li` to sit directly in the product grid list (it then carries the
   * column-span class itself).
   */
  as?: "article" | "li";
  id?: string;
  className?: string;
}

/** Column-span class for the grid cell holding the tile (`li` in ProductGrid). */
export const PROMO_TILE_SPAN_CLASSES: Readonly<Record<PromoTileSpan, string>> = Object.freeze({
  1: "col-span-1",
  2: "col-span-2",
});

/** 1 or 2; anything else gives 1. */
export function normalisePromoTileSpan(span: unknown): PromoTileSpan {
  return span === 2 ? 2 : 1;
}

/** Class for the caller's grid cell (`<li className={promoTileSpanClass(span)}>`). */
export function promoTileSpanClass(span: unknown): string {
  return PROMO_TILE_SPAN_CLASSES[normalisePromoTileSpan(span)];
}

/** Product-card-sized image (1 col) or half of a 2-col tile. */
export const PROMO_TILE_IMAGE_SIZES = "(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw";

/**
 * Tile surface and text/CTA looks. Same as the shared promo styles except
 * `primary`, which is the solid brand-blue surface here (Card `accent`, white
 * text, white `inverse` CTA pill; the Card switches focus rings to white) rather
 * than the shared near-black band (T178, U04).
 */
export function promoTileToneStyle(tone: unknown): PromoToneStyle {
  if (normalisePromoTone(tone) === "primary") {
    return { card: "accent", heading: "inverse", text: "inverse", cta: "inverse", inverse: true };
  }
  return promoToneStyle(tone);
}

/**
 * Promotional tile that fits a product-grid cell (span 1) or two cells
 * (span 2). Server component; copy from props. Equal height with the cards in
 * its row (`h-full`); one CTA whose overlay covers the tile.
 */
export function PromoTile({
  heading,
  blurb,
  cta,
  image,
  span,
  tone,
  headingLevel,
  as = "article",
  id,
  className,
}: PromoTileProps) {
  const headingId = `${useId()}-heading`;
  const title = cleanPromoText(heading);
  if (title === "") return null;

  const style = promoTileToneStyle(tone ?? "primary-subtle");
  const level = normalisePromoHeadingLevel(headingLevel);
  const cols = normalisePromoTileSpan(span);
  const wide = cols === 2;
  const copy = cleanPromoText(blurb);
  const action = normalisePromoCta(cta, "PromoTile");
  const art = normalisePromoImage(image);
  const element = as === "li" ? "li" : "article";
  // Two-column tile with art: art and copy side by side from sm, both
  // vertically centred, the CTA right under the copy (T178).
  const split = wide && art !== null;

  const classes = [
    "flex h-full w-full flex-col overflow-hidden",
    split ? "sm:flex-row sm:items-center" : "",
    element === "li" ? PROMO_TILE_SPAN_CLASSES[cols] : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Card
      as={element}
      id={id}
      aria-labelledby={element === "article" ? headingId : undefined}
      tone={style.card}
      padding="none"
      interactive={action !== null}
      className={classes}
      data-promo-tone={style.card}
      data-promo-span={cols}
    >
      {art ? (
        <div className={wide ? "min-w-0 sm:w-1/2 sm:shrink-0" : "min-w-0"} data-promo-image="">
          <Image
            src={art.src}
            alt={art.alt}
            width={art.width}
            height={art.height}
            sizes={PROMO_TILE_IMAGE_SIZES}
            className="block h-auto w-full"
          />
        </div>
      ) : null}
      <div
        className={[
          "flex min-w-0 flex-1 flex-col items-start justify-center gap-2 p-4",
          split ? "sm:p-6" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-promo-body=""
      >
        <Heading level={level} size="h4" tone={style.heading} id={headingId} className="break-words">
          {title}
        </Heading>
        {copy !== "" ? (
          <Text variant="small" tone={style.text} className="break-words">
            {copy}
          </Text>
        ) : null}
        {action ? (
          <Link
            href={action.href}
            variant="button"
            buttonVariant={style.cta}
            buttonSize="sm"
            aria-describedby={headingId}
            className={`${split ? "mt-2" : "mt-auto"} max-w-full break-words text-center ${STRETCHED_LINK_CLASSES}`}
          >
            {action.label}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}
