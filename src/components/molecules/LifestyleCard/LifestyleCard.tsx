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
} from "../PromoStrip/promo-shared";

export interface LifestyleCardProps {
  /** Blurb under the image (plain text). */
  blurb?: string;
  /** Optional heading above the blurb (plain text). */
  heading?: string;
  /** The single bold link under the blurb ("Shop living room"); invalid href → no link. */
  cta?: PromoCta | null;
  /** Optional image on top (decorative by default); without it the text fills the card. */
  image?: PromoImage | null;
  /**
   * Token-backed tone. Omitted → plain card on the page background (the
   * reference look). An unknown value falls back to `neutral`.
   */
  tone?: PromoTone;
  /** Heading level (2-4, default 3); never 1. */
  headingLevel?: PromoHeadingLevel;
  /** Root element: `article` (default) or `li` inside a caller's list. */
  as?: "article" | "li";
  id?: string;
  className?: string;
}

/** 4 / 2 / 1 columns (or 3 / 2 / 1). */
export const LIFESTYLE_CARD_IMAGE_SIZES = "(min-width: 1024px) 25vw, (min-width: 640px) 50vw, 100vw";

/**
 * Lifestyle card: image on top, blurb, then one bold link underneath whose
 * overlay makes the whole card the click area (one link, no nesting).
 * Server component; copy from props. Renders nothing when it has no text at
 * all (no heading, blurb or valid link).
 */
export function LifestyleCard({
  blurb,
  heading,
  cta,
  image,
  tone,
  headingLevel,
  as = "article",
  id,
  className,
}: LifestyleCardProps) {
  const headingId = `${useId()}-heading`;
  const title = cleanPromoText(heading);
  const copy = cleanPromoText(blurb);
  const action = normalisePromoCta(cta, "LifestyleCard");
  if (title === "" && copy === "" && action === null) return null;

  const plain = tone === undefined;
  const style = promoToneStyle(tone);
  const level = normalisePromoHeadingLevel(headingLevel);
  const art = normalisePromoImage(image);
  const element = as === "li" ? "li" : "article";

  // The plain card has no overflow clip, so the link's focus outline (2px +
  // 2px offset) is never cut at the card edge; the image wrapper rounds itself.
  const classes = ["flex h-full w-full flex-col", plain ? "" : "overflow-hidden", className]
    .filter(Boolean)
    .join(" ");
  const linkClasses = `min-h-touch max-w-full break-words font-semibold underline ${STRETCHED_LINK_CLASSES}`;

  const labelledBy = element === "article" && title !== "" ? headingId : undefined;
  const content = (
    <>
      {art ? (
        <div className={plain ? "min-w-0 overflow-hidden rounded-lg" : "min-w-0"} data-promo-image="">
          <Image
            src={art.src}
            alt={art.alt}
            width={art.width}
            height={art.height}
            sizes={LIFESTYLE_CARD_IMAGE_SIZES}
            className="block h-auto w-full"
          />
        </div>
      ) : null}
      <div className={`flex min-w-0 flex-1 flex-col items-start gap-2 ${plain ? "pt-3" : "p-4"}`} data-promo-body="">
        {title !== "" ? (
          <Heading level={level} size="h4" tone={style.heading} id={headingId} className="break-words">
            {title}
          </Heading>
        ) : null}
        {copy !== "" ? (
          <Text variant="small" tone={plain ? "primary" : style.text} className="break-words">
            {copy}
          </Text>
        ) : null}
        {action ? (
          <Link
            href={action.href}
            variant="nav"
            tone={style.inverse && !plain ? "inverse" : "default"}
            aria-describedby={title !== "" ? headingId : undefined}
            className={`mt-auto ${linkClasses}`}
          >
            {action.label}
          </Link>
        ) : null}
      </div>
    </>
  );

  if (plain) {
    const Plain = element;
    return (
      <Plain
        id={id}
        aria-labelledby={labelledBy}
        className={`relative min-w-0 ${classes}`}
        data-promo-tone="plain"
      >
        {content}
      </Plain>
    );
  }

  return (
    <Card
      as={element}
      id={id}
      aria-labelledby={labelledBy}
      tone={style.card}
      padding="none"
      interactive={action !== null}
      className={classes}
      data-promo-tone={style.card}
    >
      {content}
    </Card>
  );
}
