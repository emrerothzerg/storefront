import { QA_PAGE_PARAM } from "@/components/organisms/QASection/qa-href";
import { REVIEWS_PARAM } from "@/components/organisms/ReviewsSection/reviews-href";
import type { StarRating } from "@/lib/types";
import type { ReviewSort } from "@/server/reviews/review-service";

/**
 * Safe parser for the PDP query string (T97 criterion 4, "Page-parser rule").
 * Every value is validated here; organisms trust their typed props. Anything
 * malformed falls back to the default (never throws, never echoes input).
 */

/** Next.js `searchParams` shape (values may repeat). */
export type RawSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Gallery image index param (`?img=N`, 0-based). */
export const IMAGE_PARAM = "img";

/** Highest page number accepted for `rpage` / `qpage` (mirrors MAX_REVIEW_PAGE). */
export const MAX_PDP_PAGE = 1_000_000;

/** Highest gallery index accepted before clamping to the gallery length. */
export const MAX_IMAGE_INDEX = 99;

export interface PdpReviewParams {
  readonly sort: ReviewSort;
  readonly stars?: StarRating;
  readonly verifiedOnly: boolean;
  /** 1-based. */
  readonly page: number;
}

export interface PdpParams {
  /** 0-based gallery index (not yet clamped to the gallery length). */
  readonly img: number;
  readonly reviews: PdpReviewParams;
  /** 1-based Q&A page. */
  readonly qpage: number;
}

export const DEFAULT_PDP_PARAMS: PdpParams = Object.freeze({
  img: 0,
  reviews: Object.freeze({ sort: "helpful", verifiedOnly: false, page: 1 }),
  qpage: 1,
});

/** Longest raw value we look at; longer values are garbage by definition. */
const MAX_RAW_LENGTH = 16;

const POSITIVE_INT = /^[1-9][0-9]{0,6}$/;
const NON_NEGATIVE_INT = /^(0|[1-9][0-9]{0,6})$/;

/** First string value of a param, or undefined (arrays: first element only). */
function first(params: RawSearchParams | null | undefined, name: string): string | undefined {
  if (params === null || params === undefined || typeof params !== "object") return undefined;
  if (!Object.prototype.hasOwnProperty.call(params, name)) return undefined;
  const raw: unknown = params[name];
  const value: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_RAW_LENGTH) return undefined;
  return value;
}

/** `1..max` integer written in plain decimal, else undefined. */
export function parsePage(raw: string | undefined, max = MAX_PDP_PAGE): number | undefined {
  if (raw === undefined || !POSITIVE_INT.test(raw)) return undefined;
  const n = Number(raw);
  return n <= max ? n : undefined;
}

/** `0..MAX_IMAGE_INDEX` integer, else 0. */
export function parseImageIndex(raw: string | undefined): number {
  if (raw === undefined || !NON_NEGATIVE_INT.test(raw)) return 0;
  const n = Number(raw);
  return n <= MAX_IMAGE_INDEX ? n : 0;
}

/** "1".."5" exactly, else undefined. */
export function parseStars(raw: string | undefined): StarRating | undefined {
  switch (raw) {
    case "1":
      return 1;
    case "2":
      return 2;
    case "3":
      return 3;
    case "4":
      return 4;
    case "5":
      return 5;
    default:
      return undefined;
  }
}

export function parseSort(raw: string | undefined): ReviewSort {
  return raw === "recent" ? "recent" : "helpful";
}

/** Parses the whole PDP query; garbage, unknown keys and repeats are ignored. */
export function parsePdpParams(params: RawSearchParams | null | undefined): PdpParams {
  const stars = parseStars(first(params, REVIEWS_PARAM.stars));
  return {
    img: parseImageIndex(first(params, IMAGE_PARAM)),
    reviews: {
      sort: parseSort(first(params, REVIEWS_PARAM.sort)),
      ...(stars !== undefined ? { stars } : {}),
      verifiedOnly: first(params, REVIEWS_PARAM.verified) === "1",
      page: parsePage(first(params, REVIEWS_PARAM.page)) ?? 1,
    },
    qpage: parsePage(first(params, QA_PAGE_PARAM)) ?? 1,
  };
}

/**
 * The validated review state as URL params, for Q&A pagination links
 * (`QASection` `extraParams`). Defaults are omitted, same names and order as
 * `buildReviewsHref`. Built from parsed values only, never raw input.
 */
export function reviewsExtraParams(reviews: PdpReviewParams): Record<string, string> {
  const out: Record<string, string> = {};
  if (reviews.sort !== "helpful") out[REVIEWS_PARAM.sort] = reviews.sort;
  if (reviews.stars !== undefined) out[REVIEWS_PARAM.stars] = String(reviews.stars);
  if (reviews.verifiedOnly) out[REVIEWS_PARAM.verified] = "1";
  if (reviews.page > 1) out[REVIEWS_PARAM.page] = String(reviews.page);
  return out;
}
