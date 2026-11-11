import type { HomeArtImage } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";

/**
 * Slide surfaces. Every value maps to a documented text/surface pair in the
 * globals.css contrast header; anything else falls back to `neutral`.
 */
export const HERO_SLIDE_TONES = ["neutral", "accent", "accent-subtle", "promo", "promo-subtle", "inverse"] as const;
export type HeroSlideTone = (typeof HERO_SLIDE_TONES)[number];
export const DEFAULT_HERO_SLIDE_TONE: HeroSlideTone = "neutral";

export interface HeroSlideCta {
  label: string;
  /** Must pass `isAllowedInternalHref`; otherwise the CTA is dropped (the slide stays). */
  href: string;
}

export interface HeroSlide {
  /** Stable key (React key only; anchors are positional: `#slide-1`...). */
  id: string;
  headline: string;
  subline?: string | null;
  cta?: HeroSlideCta | null;
  /** Framed panel image (`alt: ""` = decorative). Width/height reserve the box. */
  image: HomeArtImage;
  /** Defaults to `neutral`; unknown values fall back to `neutral`. */
  tone?: HeroSlideTone;
}

export interface NormalisedHeroSlide {
  key: string;
  headline: string;
  subline: string | null;
  cta: HeroSlideCta | null;
  image: HomeArtImage;
  tone: HeroSlideTone;
}

function devWarn(message: string): void {
  if (process.env.NODE_ENV !== "production") console.warn(`[HeroBanner] ${message}`);
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isHeroSlideTone(value: unknown): value is HeroSlideTone {
  return typeof value === "string" && (HERO_SLIDE_TONES as readonly string[]).includes(value);
}

/** Token-backed tone or the neutral fallback. */
export function resolveHeroSlideTone(value: unknown): HeroSlideTone {
  return isHeroSlideTone(value) ? value : DEFAULT_HERO_SLIDE_TONE;
}

/** A CTA with a non-blank label and an allowed internal href, else null (dev warning for a bad href). */
export function safeHeroCta(cta: HeroSlideCta | null | undefined): HeroSlideCta | null {
  if (cta === null || cta === undefined || typeof cta !== "object") return null;
  const label = cleanText(cta.label);
  if (label === "") return null;
  if (typeof cta.href !== "string" || !isAllowedInternalHref(cta.href)) {
    devWarn(`CTA ${JSON.stringify(label)} dropped: href is not an allowed internal link.`);
    return null;
  }
  return { label, href: cta.href };
}

function safeImage(image: HomeArtImage | null | undefined): HomeArtImage | null {
  if (image === null || image === undefined || typeof image !== "object") return null;
  const { width, height } = image;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    path: typeof image.path === "string" ? image.path : "",
    alt: typeof image.alt === "string" ? image.alt : "",
    width,
    height,
  };
}

/**
 * Drops slides that cannot render (not an object, blank headline, missing or
 * unsized image); trims text; drops unsafe CTAs; resolves the tone. Never throws.
 */
export function normaliseHeroSlides(slides: readonly HeroSlide[] | null | undefined): NormalisedHeroSlide[] {
  if (!Array.isArray(slides)) return [];
  const out: NormalisedHeroSlide[] = [];
  const seenKeys = new Set<string>();
  slides.forEach((slide: HeroSlide | null | undefined, index) => {
    if (slide === null || slide === undefined || typeof slide !== "object") return;
    const headline = cleanText(slide.headline);
    if (headline === "") return;
    const image = safeImage(slide.image);
    if (image === null) return;
    const subline = cleanText(slide.subline);
    const rawKey = cleanText(slide.id);
    const key = rawKey === "" || seenKeys.has(rawKey) ? `slide-index-${index}` : rawKey;
    seenKeys.add(key);
    out.push({ key, headline, subline: subline === "" ? null : subline, cta: safeHeroCta(slide.cta), image, tone: resolveHeroSlideTone(slide.tone) });
  });
  return out;
}

/** Visible-to-AT slide label, e.g. "2 of 3". */
export function heroSlideLabel(position: number, total: number): string {
  return `${position} of ${total}`;
}

/** Pager dot name, e.g. "Slide 2 of 3". */
export function heroDotLabel(position: number, total: number): string {
  return `Slide ${heroSlideLabel(position, total)}`;
}
