import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import {
  HeroBanner,
  normaliseHeroSlides,
  type HeroSlide,
  type HeroSlideCta,
  type HeroSlideTone,
} from "@/components/molecules/HeroBanner";
import { PriceBlock } from "@/components/molecules/PriceBlock";
import { HERO_PANEL_ART } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";
import { isValidCents } from "@/lib/money";
import { cleanText, formatIsoDate, tryFormatMoney } from "./home-format";

/** Phase 2 banner surfaces, mapped onto slide tones (`raised` becomes `neutral`). */
export type HomeHeroBannerTone = "inverse" | "accent-subtle" | "raised";

/**
 * @deprecated Phase 2 single banner. Still accepted (mapped onto ONE slide by
 * `bannerToHeroSlide`) so the Phase 2 home loader keeps compiling until T165
 * supplies `slides`. `eyebrow` and `secondaryCta` have no place on a v3 slide
 * and are ignored.
 */
export interface HomeHeroBanner {
  title: string;
  subtitle?: string | null;
  cta?: HeroSlideCta | null;
  secondaryCta?: HeroSlideCta | null;
  /** `alt: ""` marks the image decorative. Blank url -> the placeholder `HERO_PANEL_ART` (its own descriptive alt). */
  image?: { url: string; alt: string } | null;
  eyebrow?: string | null;
  /** Defaults to `accent-subtle`. */
  tone?: HomeHeroBannerTone;
}

export interface HomeHeroDeal {
  /** Product name. */
  title: string;
  priceCents: number;
  /** Struck through with "You save" text only when a safe integer > priceCents. */
  listPriceCents?: number | null;
  currency: string;
  /** Usually `/products/<slug>`; the deal is dropped when it fails `isAllowedInternalHref`. */
  href: string;
  /** ISO 8601; "Ends <date>" is shown only when valid. */
  endsAt?: string | null;
  /**
   * Product image (site-relative "/..." or https URL), shown as a decorative
   * thumbnail between the title and the price (the title names it). Missing or
   * unsafe → no thumbnail.
   */
  imageUrl?: string | null;
}

export interface HomeHeroProps {
  /**
   * Hero slides in order (built by the home content/loader). Unusable slides
   * are dropped (see `normaliseHeroSlides`) and at most `HOME_HERO_MAX_SLIDES`
   * are shown. 0 usable slides renders nothing (the deal panel included).
   * When `slides` is null/undefined the deprecated `banner` is used instead.
   */
  slides?: readonly HeroSlide[] | null;
  /** @deprecated Use `slides`. Ignored whenever `slides` is passed. */
  banner?: HomeHeroBanner | null;
  /** "Deal of the day" panel beside the carousel; omitted when missing or invalid. */
  deal?: HomeHeroDeal | null;
  /** Accessible name of the carousel region (from content). Defaults to the HeroBanner default ("Featured offers"). */
  label?: string;
  /**
   * Outline level of the first slide headline. Defaults to 1: on the home page
   * the hero headline is the page's single `<h1>` (later slides are `<h2>`).
   * The deal heading is one level below.
   */
  headingLevel?: 1 | 2;
  /** Id of the carousel region (default `HOME_HERO_ID`); also prefixes the deal heading id. */
  id?: string;
  className?: string;
}

export const DEAL_HEADING = "Deal of the day";
export const HOME_HERO_ID = "home-hero";
export const HOME_HERO_MAX_SLIDES = 3;

const BANNER_TONES: Record<HomeHeroBannerTone, HeroSlideTone> = {
  inverse: "inverse",
  "accent-subtle": "accent-subtle",
  raised: "neutral",
};

// Legacy banner images carried no intrinsic size; the Phase 2 band reserved 4:3.
const LEGACY_IMAGE_WIDTH = 800;
const LEGACY_IMAGE_HEIGHT = 600;

function devWarn(message: string): void {
  if (process.env.NODE_ENV !== "production") console.warn(`[HomeHero] ${message}`);
}

/**
 * Maps the deprecated Phase 2 banner onto one v3 slide; null when the banner
 * or its title is missing. The CTA is validated later by `normaliseHeroSlides`.
 * Never throws.
 */
export function bannerToHeroSlide(banner: HomeHeroBanner | null | undefined): HeroSlide | null {
  if (banner === null || banner === undefined || typeof banner !== "object") return null;
  const headline = cleanText(banner.title);
  if (headline === "") return null;
  const subline = cleanText(banner.subtitle);
  const imageUrl = banner.image ? cleanText(banner.image.url) : "";
  const image =
    banner.image && imageUrl !== ""
      ? {
          path: imageUrl,
          alt: typeof banner.image.alt === "string" ? banner.image.alt : "",
          width: LEGACY_IMAGE_WIDTH,
          height: LEGACY_IMAGE_HEIGHT,
        }
      : HERO_PANEL_ART;
  const tone = typeof banner.tone === "string" && banner.tone in BANNER_TONES ? BANNER_TONES[banner.tone] : "accent-subtle";
  return {
    id: "home-banner",
    headline,
    subline: subline === "" ? null : subline,
    cta: banner.cta ?? null,
    image,
    tone,
  };
}

/**
 * Usable slides for the hero: `slides` when given, else the deprecated
 * banner; normalised (bad CTAs dropped once, here) and capped at
 * `HOME_HERO_MAX_SLIDES`. Never throws.
 */
export function resolveHomeHeroSlides(
  slides: readonly HeroSlide[] | null | undefined,
  banner?: HomeHeroBanner | null,
): HeroSlide[] {
  const source: readonly HeroSlide[] =
    slides !== null && slides !== undefined ? slides : [bannerToHeroSlide(banner)].filter((s): s is HeroSlide => s !== null);
  return normaliseHeroSlides(source)
    .slice(0, HOME_HERO_MAX_SLIDES)
    .map((slide) => ({
      id: slide.key,
      headline: slide.headline,
      subline: slide.subline,
      cta: slide.cta,
      image: slide.image,
      tone: slide.tone,
    }));
}

interface NormalisedDeal {
  title: string;
  priceCents: number;
  listPriceCents: number | null;
  currency: string;
  href: string;
  ends: { iso: string; label: string } | null;
  imageUrl: string | null;
}

/** Edge length of the deal thumbnail box (Tailwind `size-28` = 112px). */
export const DEAL_THUMBNAIL_SIZES = "112px";

/** Whitespace or control characters anywhere: browsers strip tab/LF/CR, so "/\t/evil" would load as "//evil". */
const UNSAFE_URL_CHARS = /[\s\u0000-\u001f\u007f]/;

/**
 * A site-relative ("/x", not "//x" or with a backslash) or https image URL,
 * else null. Leading/trailing spaces are trimmed; any whitespace or control
 * character left inside rejects the URL (D-T181-1).
 */
export function safeDealImageUrl(value: unknown): string | null {
  const url = cleanText(value);
  if (url === "" || UNSAFE_URL_CHARS.test(url)) return null;
  if (url.startsWith("/")) return url.startsWith("//") || url.includes("\\") ? null : url;
  return url.startsWith("https://") ? url : null;
}

/** Validates a deal; null when anything required is missing or unsafe. Never throws. */
export function normaliseDeal(deal: HomeHeroDeal | null | undefined): NormalisedDeal | null {
  if (deal === null || deal === undefined || typeof deal !== "object") return null;
  const title = cleanText(deal.title);
  if (title === "") return null;
  if (tryFormatMoney(deal.priceCents, deal.currency) === null) return null;
  if (typeof deal.href !== "string" || !isAllowedInternalHref(deal.href)) {
    devWarn("deal dropped: href is not an allowed internal link.");
    return null;
  }
  return {
    title,
    priceCents: deal.priceCents,
    listPriceCents: isValidCents(deal.listPriceCents) ? deal.listPriceCents : null,
    currency: deal.currency.trim().toUpperCase(),
    href: deal.href,
    ends: formatIsoDate(deal.endsAt),
    imageUrl: safeDealImageUrl(deal.imageUrl),
  };
}

function safeId(value: string | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z][\w-]*$/.test(trimmed) ? trimmed : null;
}

/**
 * Home page hero (T151, server-safe): the v3 `HeroBanner` carousel (no
 * autoplay, no-JS scroll-snap, region `#home-hero`, first headline = the
 * page `<h1>`) plus an optional "Deal of the day" panel (stacked at 320px,
 * beside the carousel from `lg`). Renders nothing with 0 usable slides; an
 * invalid deal is omitted.
 */
export function HomeHero({ slides, banner, deal, label, headingLevel = 1, id, className }: HomeHeroProps) {
  const usable = resolveHomeHeroSlides(slides, banner);
  if (usable.length === 0) return null;

  const regionId = safeId(id) ?? HOME_HERO_ID;
  const normalisedDeal = normaliseDeal(deal);
  const dealHeadingId = `${regionId}-deal-heading`;
  const dealLevel = headingLevel === 1 ? 2 : 3;

  const classes = ["grid min-w-0 gap-4", normalisedDeal !== null ? "lg:grid-cols-3" : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} data-home-hero="">
      <HeroBanner
        slides={usable}
        label={label}
        headingLevel={headingLevel}
        id={regionId}
        priority
        className={normalisedDeal !== null ? "lg:col-span-2" : undefined}
      />
      {normalisedDeal !== null ? (
        <section
          aria-labelledby={dealHeadingId}
          className="flex min-w-0 flex-col items-start gap-3 rounded-xl border border-border-default bg-surface-raised p-6 shadow-sm"
        >
          <Heading level={dealLevel} size="h3" id={dealHeadingId}>
            {DEAL_HEADING}
          </Heading>
          <Text className="font-semibold break-words">{normalisedDeal.title}</Text>
          <div className="flex w-full min-w-0 items-center gap-4" data-deal-body="">
            {normalisedDeal.imageUrl !== null ? (
              <div
                className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border-default bg-surface-raised"
                data-deal-thumbnail=""
              >
                <Image
                  src={normalisedDeal.imageUrl}
                  alt=""
                  width={600}
                  height={600}
                  sizes={DEAL_THUMBNAIL_SIZES}
                  className="h-full w-full object-contain"
                />
              </div>
            ) : null}
            <div className="min-w-0 flex-1">
              <PriceBlock
                priceCents={normalisedDeal.priceCents}
                currency={normalisedDeal.currency}
                listPriceCents={normalisedDeal.listPriceCents}
                size="md"
                display="superscript"
                showDealBadge
              />
            </div>
          </div>
          {normalisedDeal.ends !== null ? (
            <Text variant="small" tone="secondary">
              Ends <time dateTime={normalisedDeal.ends.iso}>{normalisedDeal.ends.label}</time>
            </Text>
          ) : null}
          <Link href={normalisedDeal.href} variant="button" className="mt-auto">
            View deal<span className="sr-only">{`: ${normalisedDeal.title}`}</span>
          </Link>
        </section>
      ) : null}
    </div>
  );
}
