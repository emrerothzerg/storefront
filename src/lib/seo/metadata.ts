import type { Metadata } from "next";

import { SITE_NAME, absoluteUrl } from "./site";

/** Longest page title segment (before the layout's "| Site" suffix). */
export const MAX_TITLE_LENGTH = 60;
/** Longest meta description. */
export const MAX_DESCRIPTION_LENGTH = 160;

const ELLIPSIS = "\u2026";

/** Open Graph locale; must match the root layout's `openGraph.locale`. */
export const OG_LOCALE = "en_US";

export interface MetadataImage {
  /** Site path (e.g. "/images/products/x.svg") or absolute http(s) URL. */
  readonly url: string;
  readonly alt?: string;
  readonly width?: number;
  readonly height?: number;
}

export interface BuildMetadataInput {
  /** Page title segment; the root layout appends " | <SITE_NAME>" for child segments (the root page sets an absolute title itself). */
  readonly title: string;
  readonly description: string;
  /**
   * Site path of the page, e.g. "/products/walnut-desk". Becomes the canonical
   * and Open Graph URL. Omit for pages that must not expose their URL (order
   * pages, 404).
   */
  readonly path?: string;
  /** Adds `robots: { index: false, follow: false }`. */
  readonly noindex?: boolean;
  /** Open Graph / Twitter image. Without it no image is emitted. */
  readonly image?: MetadataImage;
  /** Open Graph type; defaults to "website". */
  readonly type?: "website" | "article";
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (part) => part.segment);
  }
  // Code points: never splits a surrogate pair.
  return Array.from(value);
}

/**
 * Collapses whitespace and shortens `value` to at most `max` user-perceived
 * characters (graphemes), ending in an ellipsis when cut. Never splits a
 * surrogate pair or a combined emoji. Cuts at the last word boundary when one
 * is reasonably close to the limit.
 */
export function truncateText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!Number.isInteger(max) || max < 1) return "";
  const parts = graphemes(text);
  if (parts.length <= max) return text;
  const kept = parts.slice(0, max - 1);
  // `kept` already ends on a whole word when the next grapheme is a space.
  const endsOnWord = parts[max - 1] === " ";
  const lastSpace = kept.lastIndexOf(" ");
  const cut =
    !endsOnWord && lastSpace >= Math.floor((max - 1) * 0.6) ? kept.slice(0, lastSpace) : kept;
  return `${cut.join("").trimEnd()}${ELLIPSIS}`;
}

/**
 * Page metadata for Next's Metadata API: title, description, canonical,
 * Open Graph, Twitter card and robots. Open Graph is set as a whole object
 * (Next merges metadata shallowly), so `siteName` is repeated here.
 */
export function buildMetadata(input: BuildMetadataInput): Metadata {
  // A blank title would render as " | Site"; fall back to the site name.
  const title = truncateText(input.title, MAX_TITLE_LENGTH) || SITE_NAME;
  const description = truncateText(input.description, MAX_DESCRIPTION_LENGTH);
  const url = input.path === undefined ? undefined : absoluteUrl(input.path);
  const image = input.image
    ? {
        url: absoluteUrl(input.image.url),
        ...(input.image.alt ? { alt: input.image.alt } : {}),
        ...(input.image.width ? { width: input.image.width } : {}),
        ...(input.image.height ? { height: input.image.height } : {}),
      }
    : undefined;

  const metadata: Metadata = {
    title,
    description,
    openGraph: {
      type: input.type ?? "website",
      siteName: SITE_NAME,
      // Repeated from the layout: Next replaces openGraph as a whole object.
      locale: OG_LOCALE,
      title,
      description,
      ...(url ? { url } : {}),
      ...(image ? { images: [image] } : {}),
    },
    twitter: image
      ? { card: "summary_large_image", title, description, images: [image.url] }
      : { card: "summary", title, description },
  };
  if (url) metadata.alternates = { canonical: url };
  if (input.noindex) metadata.robots = { index: false, follow: false };
  return metadata;
}
