import type { CardTone } from "@/components/atoms/Card";
import type { LinkButtonVariant } from "@/components/atoms/Link";
import type { HeadingTone, TextTone } from "@/components/atoms/Typography";
import { isAllowedInternalHref } from "@/content/routes";

/**
 * Shared helpers for the T141 promo molecules (PromoStrip, PromoTile,
 * LifestyleCard). Pure functions only; no copy lives here.
 */

/** Token-backed promo tones. Anything else falls back to `neutral`. */
export const PROMO_TONES = ["primary", "primary-subtle", "neutral", "accent"] as const;
export type PromoTone = (typeof PROMO_TONES)[number];

/**
 * Promo tone → `Card` tone (designer's verified surface/text pairs):
 * - `primary`: bold dark band (`inverse`, white text, `inverse` CTA). The Card
 *   atom has no solid-accent tone, so the bold band is the inverse surface.
 * - `primary-subtle`: primary tint (`accent-subtle`).
 * - `neutral`: light-grey band (`sunken`).
 * - `accent`: bold gold promotional band (`promo`, near-black text, primary CTA).
 */
export const PROMO_TONE_CARD: Readonly<Record<PromoTone, CardTone>> = Object.freeze({
  primary: "inverse",
  "primary-subtle": "accent-subtle",
  neutral: "sunken",
  accent: "promo",
});

const TONE_SET: ReadonlySet<string> = new Set(PROMO_TONES);

/** Returns a known tone; unknown, blank or non-string input gives `neutral`. Never throws. */
export function normalisePromoTone(tone: unknown): PromoTone {
  return typeof tone === "string" && TONE_SET.has(tone) ? (tone as PromoTone) : "neutral";
}

export interface PromoToneStyle {
  card: CardTone;
  heading: HeadingTone;
  text: TextTone;
  cta: LinkButtonVariant;
  /** True on the dark inverse band (links use `tone="inverse"`). */
  inverse: boolean;
}

/** Card surface plus the verified text/CTA looks for that surface. */
export function promoToneStyle(tone: unknown): PromoToneStyle {
  const card = PROMO_TONE_CARD[normalisePromoTone(tone)];
  const inverse = card === "inverse";
  return {
    card,
    heading: inverse ? "inverse" : "default",
    text: inverse ? "inverse" : "primary",
    cta: inverse ? "inverse" : "primary",
    inverse,
  };
}

/** Heading levels a promo may use. Never 1: the page owns its h1. */
export type PromoHeadingLevel = 2 | 3 | 4;

/** 2, 3 or 4; anything else (incl. 1) gives the default 3. */
export function normalisePromoHeadingLevel(level: unknown): PromoHeadingLevel {
  return level === 2 || level === 3 || level === 4 ? level : 3;
}

/** Trimmed string, or "" for non-strings. */
export function cleanPromoText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Returns `href` when it passes `isAllowedInternalHref`, else `null` (warns outside production). */
export function safePromoHref(href: unknown, component = "Promo"): string | null {
  if (typeof href === "string" && isAllowedInternalHref(href)) return href;
  if (process.env.NODE_ENV !== "production") {
    console.warn(`${component}: href ${JSON.stringify(href)} is not an allowed internal route; rendering without a link.`);
  }
  return null;
}

/** Caller-supplied call to action. Copy comes from the content module. */
export interface PromoCta {
  /** Visible link text, rendered as plain text. Blank → no CTA. */
  label: string;
  /** Internal destination; must pass `isAllowedInternalHref` or the CTA is dropped. */
  href: string;
}

export interface NormalisedPromoCta {
  label: string;
  href: string;
}

/** Valid CTA or `null` (missing, blank label or rejected href). Never throws. */
export function normalisePromoCta(cta: PromoCta | null | undefined, component?: string): NormalisedPromoCta | null {
  if (!cta || typeof cta !== "object") return null;
  const label = cleanPromoText(cta.label);
  if (label === "") return null;
  const href = safePromoHref(cta.href, component);
  return href === null ? null : { label, href };
}

/**
 * Optional artwork. Shape matches `HomeArtImage` from `src/content/home-art.ts`
 * (`path`, `width`, `height`, `alt`), so manifest entries can be passed as is.
 */
export interface PromoImage {
  /** Public path ("/images/...") or https URL. */
  path: string;
  width: number;
  height: number;
  /** Used only when `decorative` is false. */
  alt?: string;
  /**
   * Defaults to true: the heading / link text carries the meaning, so the
   * image renders with `alt=""`. Set false (with a non-blank `alt`) when the
   * picture adds information the text does not.
   */
  decorative?: boolean;
}

export interface NormalisedPromoImage {
  src: string;
  alt: string;
  width: number;
  height: number;
}

function isSafeImageSrc(src: string): boolean {
  if (src.startsWith("/")) return !src.startsWith("//") && !src.includes("\\");
  return src.startsWith("https://");
}

function isPositiveSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Valid image or `null` (missing/blank/unsafe path, bad size). Decorative unless opted out. */
export function normalisePromoImage(image: PromoImage | null | undefined): NormalisedPromoImage | null {
  if (!image || typeof image !== "object") return null;
  const src = cleanPromoText(image.path);
  if (src === "" || !isSafeImageSrc(src)) return null;
  if (!isPositiveSize(image.width) || !isPositiveSize(image.height)) return null;
  const alt = image.decorative === false ? cleanPromoText(image.alt) : "";
  return { src, alt, width: Math.round(image.width), height: Math.round(image.height) };
}

/**
 * Stretched-link overlay: the single CTA's `::after` covers the whole card
 * (the Card atom is `relative`), so the card is one click area with one tab
 * stop and no nested links.
 */
export const STRETCHED_LINK_CLASSES = "after:absolute after:inset-0 after:z-raised";
