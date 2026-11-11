import { useId } from "react";
import { Heading, Text } from "@/components/atoms/Typography";
import { LifestyleCard } from "@/components/molecules/LifestyleCard";
import {
  cleanPromoText,
  normalisePromoCta,
  type NormalisedPromoCta,
  type PromoCta,
  type PromoImage,
  type PromoTone,
} from "@/components/molecules/PromoStrip";

/** One lifestyle card. Copy comes from the home content module (T165). */
export interface LifestyleBannerItem {
  /** Optional card heading (plain text). */
  heading?: string;
  /** Blurb under the image (plain text). */
  blurb?: string;
  /** Required: cards whose CTA is missing, blank or not an allowed internal href are dropped. */
  cta: PromoCta;
  /** Optional art (`LIFESTYLE_ART.*` fits as is; decorative by default). */
  image?: PromoImage | null;
  /** Optional token tone; omitted → plain card (reference look). */
  tone?: PromoTone;
}

export type LifestyleBannersColumns = 3 | 4;

export interface LifestyleBannersProps {
  /** Candidate cards; invalid ones are dropped, at most `columns` render. */
  items: readonly LifestyleBannerItem[] | null | undefined;
  /** Desktop column count: 4 → 4/2/1, 3 → 3/2/1. Anything else → 4. */
  columns: LifestyleBannersColumns;
  /** Section heading (plain text). Blank → "Explore more ideas". */
  heading?: string;
  /** Small line above the heading (plain text, optional). */
  eyebrow?: string;
  /** Section heading level, 2 (default) or 3; card headings are one level below. */
  headingLevel?: 2 | 3;
  /** Section id, e.g. "home-lifestyle-cards". Heading id is `<id>-heading`. */
  id?: string;
  className?: string;
}

/** Fewer valid cards than this → the section is omitted (T154 AC2). */
export const LIFESTYLE_BANNERS_MIN_ITEMS = 2;
export const LIFESTYLE_BANNERS_DEFAULT_HEADING = "Explore more ideas";

/** Static class strings (Tailwind must see them literally). */
export const LIFESTYLE_BANNERS_GRID_CLASSES: Readonly<Record<LifestyleBannersColumns, string>> = Object.freeze({
  3: "grid min-w-0 grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid min-w-0 grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4",
});

/** 3 stays 3; anything else (incl. junk) gives 4. Never throws. */
export function normaliseLifestyleColumns(columns: unknown): LifestyleBannersColumns {
  return columns === 3 ? 3 : 4;
}

export interface NormalisedLifestyleBannerItem {
  heading: string;
  blurb: string;
  cta: NormalisedPromoCta;
  image: PromoImage | null;
  tone: PromoTone | undefined;
}

/**
 * Valid cards (object with an allowed CTA), capped at `columns`; `[]` when
 * fewer than `LIFESTYLE_BANNERS_MIN_ITEMS` are valid. Never throws.
 */
export function lifestyleBannerItems(items: unknown, columns: unknown): NormalisedLifestyleBannerItem[] {
  if (!Array.isArray(items)) return [];
  const max = normaliseLifestyleColumns(columns);
  const valid: NormalisedLifestyleBannerItem[] = [];
  for (const raw of items as unknown[]) {
    if (valid.length === max) break;
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Partial<LifestyleBannerItem>;
    const cta = normalisePromoCta(item.cta, "LifestyleBanners");
    if (cta === null) continue;
    valid.push({
      heading: cleanPromoText(item.heading),
      blurb: cleanPromoText(item.blurb),
      cta,
      image: item.image ?? null,
      tone: item.tone,
    });
  }
  return valid.length < LIFESTYLE_BANNERS_MIN_ITEMS ? [] : valid;
}

function cleanId(id: unknown): string | undefined {
  const value = cleanPromoText(id);
  return value === "" ? undefined : value;
}

/**
 * Lifestyle cards section (reference H12 4-column "Explore …", H14 3-column
 * "Make room …"): `<section aria-labelledby>` with an optional eyebrow, an
 * `h2` and a `ul` grid of `LifestyleCard`s (`li`, one link each). Columns
 * 4/2/1 or 3/2/1 (lg / sm / base); stacks to one column at 320px.
 * Omitted when fewer than two cards are valid. Server component.
 */
export function LifestyleBanners({
  items,
  columns,
  heading,
  eyebrow,
  headingLevel = 2,
  id,
  className,
}: LifestyleBannersProps) {
  const autoId = useId();
  const cols = normaliseLifestyleColumns(columns);
  const cards = lifestyleBannerItems(items, cols);
  if (cards.length === 0) return null;

  const sectionId = cleanId(id);
  const headingId = `${sectionId ?? `lifestyle-banners-${autoId}`}-heading`;
  const title = cleanPromoText(heading) === "" ? LIFESTYLE_BANNERS_DEFAULT_HEADING : cleanPromoText(heading);
  const eyebrowText = cleanPromoText(eyebrow);
  const level = headingLevel === 3 ? 3 : 2;
  const cardLevel = level === 3 ? 4 : 3;

  return (
    <section
      id={sectionId}
      aria-labelledby={headingId}
      className={["flex min-w-0 flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrowText === "" ? null : (
          <Text variant="small" tone="secondary" data-eyebrow="" className="break-words">
            {eyebrowText}
          </Text>
        )}
        <Heading level={level} size="h3" id={headingId} className="break-words">
          {title}
        </Heading>
      </div>
      <ul role="list" className={LIFESTYLE_BANNERS_GRID_CLASSES[cols]} data-columns={cols}>
        {cards.map((card, index) => (
          <LifestyleCard
            key={`${index}-${card.cta.href}`}
            as="li"
            heading={card.heading === "" ? undefined : card.heading}
            blurb={card.blurb === "" ? undefined : card.blurb}
            cta={card.cta}
            image={card.image}
            tone={card.tone}
            headingLevel={cardLevel}
          />
        ))}
      </ul>
    </section>
  );
}
