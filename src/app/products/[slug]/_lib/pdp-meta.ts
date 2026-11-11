import { formatMoney, isValidCents } from "@/lib/money";
import { isSupportedCurrency } from "@/lib/seo/json-ld";
import { SITE_NAME } from "@/lib/seo/site";
import type { ProductDetail } from "@/lib/types";

/** Audit bounds for a meta description (T112 `metadata-audit.test.ts`), in UTF-16 code units. */
export const PDP_DESCRIPTION_MIN = 70;
export const PDP_DESCRIPTION_MAX = 160;

const ELLIPSIS = "…";

/** The product fields the builder reads: catalog copy only, never owner or viewer data. */
export type PdpDescriptionSource = Pick<ProductDetail, "name" | "description" | "priceCents" | "currency" | "bullets"> & {
  readonly brand: Pick<NonNullable<ProductDetail["brand"]>, "name"> | null;
  readonly category: Pick<NonNullable<ProductDetail["category"]>, "name"> | null;
};

function collapse(text: unknown): string {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

/** Ends a fragment with sentence punctuation so appended facts read as a new sentence. */
function asSentence(text: string): string {
  if (text === "") return "";
  return /[.!?…]$/u.test(text) ? text : `${text}.`;
}

function priceText(priceCents: number, currency: string): string | null {
  // Intl accepts any well-formed code ("ZZZ"); only runtime-supported ISO 4217 codes are shown.
  if (!isValidCents(priceCents) || typeof currency !== "string" || !isSupportedCurrency(currency)) return null;
  try {
    return formatMoney(priceCents, currency);
  } catch {
    return null; // unsupported currency code: leave the price out
  }
}

/** "<Name> by <Brand> in <Category>, <price>." with every missing part left out. */
export function productFactsSentence(product: PdpDescriptionSource): string {
  const name = collapse(product.name);
  const brand = collapse(product.brand?.name);
  const category = collapse(product.category?.name);
  const price = priceText(product.priceCents, product.currency);
  let sentence = name;
  if (brand !== "") sentence += sentence === "" ? `By ${brand}` : ` by ${brand}`;
  if (category !== "") sentence += sentence === "" ? `In ${category}` : ` in ${category}`;
  if (price !== null) sentence += sentence === "" ? price : `, ${price}`;
  return asSentence(sentence);
}

/**
 * Shortens `text` to at most `max` UTF-16 code units, cutting on the last
 * word boundary in the second half of the budget (else mid-word, never
 * inside a surrogate pair), dropping trailing punctuation and spaces, and
 * ending with an ellipsis.
 */
export function truncateOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  if (!Number.isInteger(max) || max < 2) return "";
  let cut = text.slice(0, max - 1);
  const atBoundary = text[max - 1] === " ";
  const lastSpace = cut.lastIndexOf(" ");
  if (!atBoundary && lastSpace >= Math.floor((max - 1) / 2)) cut = cut.slice(0, lastSpace);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.replace(/[\s,;:\-–—]+$/u, "")}${ELLIPSIS}`;
}

/**
 * PDP meta description (CONS-B4, T112 audit): the product's own description
 * when it already fits 70..160 characters; a longer one is cut on a word
 * boundary. A shorter one is extended, in order and only as far as needed,
 * with a facts sentence (name, brand, category, price), then the "About this
 * item" bullets, then "Available at <site>." The result is whitespace
 * collapsed, at most 160 code units, and built from catalog data only.
 */
export function buildPdpDescription(product: PdpDescriptionSource): string {
  const own = collapse(product.description);
  if (own.length >= PDP_DESCRIPTION_MIN) return truncateOnWord(own, PDP_DESCRIPTION_MAX);

  const extras = [
    productFactsSentence(product),
    ...product.bullets.map((bullet) => asSentence(collapse(bullet))),
    `Available at ${SITE_NAME}.`,
  ].filter((part) => part !== "");

  let text = asSentence(own);
  for (const part of extras) {
    if (text.length >= PDP_DESCRIPTION_MIN) break;
    text = text === "" ? part : `${text} ${part}`;
  }
  return truncateOnWord(text, PDP_DESCRIPTION_MAX);
}
