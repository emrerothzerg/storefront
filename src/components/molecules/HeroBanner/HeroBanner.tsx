import { Image } from "@/components/atoms/Image";
import { Link, type LinkButtonVariant } from "@/components/atoms/Link";
import { Heading, Text, type HeadingTone, type TextTone } from "@/components/atoms/Typography";
import {
  heroDotLabel,
  heroSlideLabel,
  normaliseHeroSlides,
  type HeroSlide,
  type HeroSlideTone,
  type NormalisedHeroSlide,
} from "./hero-slides";

export interface HeroBannerCarouselProps {
  /**
   * Slides in order. 0 usable slides renders nothing; 1 slide renders no
   * dots; N > 1 renders a CSS scroll-snap track plus N anchor-link dots.
   */
  slides: readonly HeroSlide[];
  /** Accessible name of the carousel region. Defaults to `HERO_CAROUSEL_LABEL`. */
  label?: string;
  /**
   * Outline level of the slide headlines (default 2). With 1, only the first
   * slide's headline is an `<h1>` and the others are `<h2>`, so the page
   * never gets more than one `<h1>`.
   */
  headingLevel?: 1 | 2 | 3;
  /** Loads the first slide image eagerly with priority (default true: the hero sits above the fold). Others are always lazy. */
  priority?: boolean;
  /** Prefix for slide anchors (default "slide": `#slide-1`...). Change it only when two carousels share a page. */
  slideIdPrefix?: string;
  /** Id of the region (e.g. "home-hero"). */
  id?: string;
  className?: string;
}

/** Alias kept for importers; the deprecated `heading` band was removed in T151. */
export type HeroBannerProps = HeroBannerCarouselProps;

export const HERO_CAROUSEL_LABEL = "Featured offers";
export const HERO_SLIDE_IMAGE_SIZES = "(min-width: 1024px) 34vw, (min-width: 768px) 50vw, 100vw";

/**
 * Hero molecule (server-safe, no client JS of its own).
 *
 * - `slides` (v3, T139): no-JS carousel. A `role="region"` with
 *   `aria-roledescription="carousel"`; each slide is a group labelled
 *   "n of N" holding headline, subline and CTA in the left half and the art
 *   filling the right half edge to edge from 768px (absolute, object-cover,
 *   clipped by the slide's rounded corners; T178). Below 768px the art is a
 *   16:9 block under the copy, flush with the slide edges. Several slides sit in a
 *   horizontal CSS scroll-snap track (the track scrolls, never the page)
 *   with anchor-link dots `#slide-n` underneath. No automatic rotation, no timers;
 *   smooth scrolling only under `motion-safe:`.
 *
 * The Phase 2 single `heading` band was removed in T151 (HomeHero now passes slides).
 */
export function HeroBanner(props: HeroBannerProps) {
  return <HeroCarousel {...props} />;
}

interface SlideToneStyle {
  surface: string;
  text: TextTone;
  heading: HeadingTone;
  ctaVariant: LinkButtonVariant;
  ctaClass?: string;
}

// Pairs from the globals.css contrast header only:
// text-primary on sunken / accent-subtle / promo-subtle / promo;
// text-inverse (white) on accent and on surface-inverse; accent fill (primary
// pill) on promo 4.01 and on the tints. On solid accent the CTA is the white
// `inverse` pill and its focus ring is focus-ring-inverse (6.70 vs accent);
// inside surface-inverse the base layer switches the ring automatically.
const slideToneStyles: Record<HeroSlideTone, SlideToneStyle> = {
  neutral: { surface: "bg-surface-sunken text-text-primary", text: "primary", heading: "default", ctaVariant: "primary" },
  accent: {
    surface: "bg-accent text-text-inverse",
    text: "inverse",
    heading: "inverse",
    ctaVariant: "inverse",
    ctaClass: "focus-visible:outline-focus-ring-inverse",
  },
  "accent-subtle": { surface: "bg-accent-subtle text-text-primary", text: "primary", heading: "default", ctaVariant: "primary" },
  promo: { surface: "bg-promo text-text-primary", text: "primary", heading: "default", ctaVariant: "primary" },
  "promo-subtle": { surface: "bg-promo-subtle text-text-primary", text: "primary", heading: "default", ctaVariant: "primary" },
  inverse: { surface: "bg-surface-inverse text-text-inverse", text: "inverse", heading: "inverse", ctaVariant: "inverse" },
};

function slideAnchorPrefix(prefix: string | undefined): string {
  const trimmed = typeof prefix === "string" ? prefix.trim() : "";
  return /^[A-Za-z][\w-]*$/.test(trimmed) ? trimmed : "slide";
}

interface HeroSlideViewProps {
  slide: NormalisedHeroSlide;
  position: number;
  total: number;
  anchorId: string;
  headingLevel: 1 | 2 | 3;
  priority: boolean;
}

function HeroSlideView({ slide, position, total, anchorId, headingLevel, priority }: HeroSlideViewProps) {
  const style = slideToneStyles[slide.tone];
  return (
    <div
      id={anchorId}
      role="group"
      aria-roledescription="slide"
      aria-label={heroSlideLabel(position, total)}
      data-hero-slide=""
      data-tone={slide.tone}
      className={[
        "relative flex w-full min-w-0 shrink-0 snap-start flex-col overflow-hidden rounded-xl md:min-h-72",
        style.surface,
      ].join(" ")}
    >
      <div
        className="flex min-w-0 flex-col items-start justify-center gap-3 p-6 md:w-1/2 md:flex-1 md:p-10"
        data-hero-copy=""
      >
        <Heading level={headingLevel} size="h1" tone={style.heading} className="break-words">
          {slide.headline}
        </Heading>
        {slide.subline !== null ? (
          <Text tone={style.text} className="max-w-prose break-words">
            {slide.subline}
          </Text>
        ) : null}
        {slide.cta !== null ? (
          <div className="pt-2">
            <Link
              href={slide.cta.href}
              variant="button"
              buttonVariant={style.ctaVariant}
              buttonSize="lg"
              className={style.ctaClass}
            >
              {slide.cta.label}
            </Link>
          </div>
        ) : null}
      </div>
      <div
        className="relative aspect-video w-full min-w-0 md:absolute md:inset-y-0 md:right-0 md:aspect-auto md:w-1/2"
        data-hero-art=""
      >
        <Image
          src={slide.image.path}
          alt={slide.image.alt}
          width={slide.image.width}
          height={slide.image.height}
          sizes={HERO_SLIDE_IMAGE_SIZES}
          priority={priority}
          className="block h-full w-full object-cover"
        />
      </div>
    </div>
  );
}

function HeroCarousel({
  slides,
  label,
  headingLevel = 2,
  priority = true,
  slideIdPrefix,
  id,
  className,
}: HeroBannerProps) {
  const usable = normaliseHeroSlides(slides);
  const total = usable.length;
  if (total === 0) return null;
  const regionLabel = typeof label === "string" && label.trim() !== "" ? label.trim() : HERO_CAROUSEL_LABEL;
  const prefix = slideAnchorPrefix(slideIdPrefix);
  const anchor = (position: number) => `${prefix}-${position}`;
  const multiple = total > 1;

  return (
    <div
      id={id}
      role="region"
      aria-roledescription="carousel"
      aria-label={regionLabel}
      data-hero-carousel=""
      className={["flex w-full min-w-0 flex-col gap-2", className].filter(Boolean).join(" ")}
    >
      <div
        data-hero-track=""
        className={
          multiple
            ? "flex min-w-0 snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain motion-safe:scroll-smooth"
            : "flex min-w-0"
        }
      >
        {usable.map((slide, index) => (
          <HeroSlideView
            key={slide.key}
            slide={slide}
            position={index + 1}
            total={total}
            anchorId={anchor(index + 1)}
            headingLevel={headingLevel === 1 && index > 0 ? 2 : headingLevel}
            priority={priority && index === 0}
          />
        ))}
      </div>
      {multiple ? (
        <ol role="list" data-hero-dots="" className="flex flex-wrap items-center justify-center gap-1">
          {usable.map((slide, index) => (
            <li key={slide.key}>
              <Link
                href={`#${anchor(index + 1)}`}
                variant="nav"
                aria-current={index === 0 ? "true" : undefined}
                className="justify-center"
              >
                <span
                  aria-hidden="true"
                  className={[
                    "block h-2 rounded-full",
                    index === 0 ? "w-6 bg-accent" : "w-2 bg-border-strong",
                  ].join(" ")}
                />
                <span className="sr-only">{heroDotLabel(index + 1, total)}</span>
              </Link>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
