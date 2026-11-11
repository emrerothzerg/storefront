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
  promoToneStyle,
  type PromoCta,
  type PromoHeadingLevel,
  type PromoImage,
  type PromoTone,
} from "./promo-shared";

export type PromoStripImagePosition = "start" | "end";

export interface PromoStripProps {
  /** Headline (plain text). Blank → the strip renders nothing. */
  heading: string;
  /** Supporting line (plain text, optional). */
  blurb?: string;
  /** The single call to action; an invalid href renders the strip without it. */
  cta?: PromoCta | null;
  /** Optional side artwork; without it the text fills the width. */
  image?: PromoImage | null;
  /** Image side from `md` up (stacked image-first below). Defaults to "end". */
  imagePosition?: PromoStripImagePosition;
  /** Token-backed tone; unknown values fall back to `neutral`. Defaults to `neutral`. */
  tone?: PromoTone;
  /** Heading level (2-4, default 3); never 1. */
  headingLevel?: PromoHeadingLevel;
  /** Id on the band, e.g. "home-shipping-promo". */
  id?: string;
  /** Eager-load the image (only when the strip is above the fold). */
  priority?: boolean;
  className?: string;
}

/** Image is at most ~40% of the band from md up; full width when stacked. */
export const PROMO_STRIP_IMAGE_SIZES = "(min-width: 768px) 40vw, 100vw";

/**
 * Wide promotional band: heading, blurb, one CTA and an optional image side
 * (delivery promo, split lifestyle banner, sign-up strip). Server component;
 * all copy comes from props. The CTA's overlay makes the whole band one click
 * area (one link, no nesting).
 */
export function PromoStrip({
  heading,
  blurb,
  cta,
  image,
  imagePosition = "end",
  tone,
  headingLevel,
  id,
  priority = false,
  className,
}: PromoStripProps) {
  const headingId = `${useId()}-heading`;
  const title = cleanPromoText(heading);
  if (title === "") return null;

  const style = promoToneStyle(tone ?? "neutral");
  const level = normalisePromoHeadingLevel(headingLevel);
  const copy = cleanPromoText(blurb);
  const action = normalisePromoCta(cta, "PromoStrip");
  const art = normalisePromoImage(image);
  const imageFirst = imagePosition === "start";

  const classes = [
    "flex w-full flex-col overflow-hidden",
    art ? (imageFirst ? "md:flex-row" : "md:flex-row-reverse") : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Card
      as="section"
      id={id}
      aria-labelledby={headingId}
      tone={style.card}
      radius="xl"
      padding="none"
      interactive={action !== null}
      className={classes}
      data-promo-tone={style.card}
    >
      {art ? (
        <div className="flex min-w-0 items-center justify-center md:w-2/5 md:shrink-0" data-promo-image="">
          <Image
            src={art.src}
            alt={art.alt}
            width={art.width}
            height={art.height}
            sizes={PROMO_STRIP_IMAGE_SIZES}
            priority={priority}
            className="block h-auto w-full"
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-3 p-6 md:p-8" data-promo-body="">
        <Heading level={level} size="h2" tone={style.heading} id={headingId} className="break-words">
          {title}
        </Heading>
        {copy !== "" ? (
          <Text tone={style.text} className="max-w-prose break-words">
            {copy}
          </Text>
        ) : null}
        {action ? (
          <Link
            href={action.href}
            variant="button"
            buttonVariant={style.cta}
            aria-describedby={headingId}
            className={`mt-1 max-w-full break-words text-center ${STRETCHED_LINK_CLASSES}`}
          >
            {action.label}
          </Link>
        ) : null}
      </div>
    </Card>
  );
}
