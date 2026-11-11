// Type-only: organisms never import server code at runtime.
import type { ReviewSort } from "@/server/reviews/review-service";
import type { StarRating } from "@/lib/types";

/** Fragment every reviews URL ends with (the section id). */
export const REVIEWS_SECTION_ID = "reviews";

/** Sort the service uses when `sort` is absent; omitted from URLs. Mirrors `DEFAULT_REVIEW_SORT`. */
export const DEFAULT_REVIEWS_SORT: ReviewSort = "helpful";

/** URL search param names (D9: review list state lives in the URL). */
export const REVIEWS_PARAM = {
  sort: "sort",
  stars: "stars",
  verified: "verified",
  page: "rpage",
} as const;

/** Current review list state as reflected in the URL. */
export interface ReviewsUrlState {
  readonly sort: ReviewSort;
  readonly stars?: StarRating;
  readonly verifiedOnly?: boolean;
  /** 1-based review page; 1 / invalid is omitted. */
  readonly rpage?: number;
}

/**
 * Changes to apply. A key that is PRESENT (even as `undefined`) replaces the
 * current value; an absent key keeps it. Changing `sort`, `stars` or
 * `verifiedOnly` without also giving `rpage` resets to page 1.
 */
export interface ReviewsHrefPatch {
  readonly sort?: ReviewSort;
  readonly stars?: StarRating | undefined;
  readonly verifiedOnly?: boolean | undefined;
  readonly rpage?: number | undefined;
}

function isSort(value: unknown): value is ReviewSort {
  return value === "helpful" || value === "recent";
}

function isStar(value: unknown): value is StarRating {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

/**
 * `${basePath}?${params}#reviews` with params in the stable order
 * `sort`, `stars`, `verified`, `rpage`. Defaults are omitted (sort "helpful",
 * no stars, verified off, page 1) and invalid values are dropped. Any query
 * or fragment already on `basePath` is discarded. Pure.
 */
export function buildReviewsHref(basePath: string, query: ReviewsUrlState, patch: ReviewsHrefPatch = {}): string {
  const has = (key: keyof ReviewsHrefPatch) => Object.prototype.hasOwnProperty.call(patch, key);
  const filterChanged = has("sort") || has("stars") || has("verifiedOnly");

  const sort = has("sort") ? patch.sort : query.sort;
  const stars = has("stars") ? patch.stars : query.stars;
  const verifiedOnly = has("verifiedOnly") ? patch.verifiedOnly : query.verifiedOnly;
  const rpage = has("rpage") ? patch.rpage : filterChanged ? undefined : query.rpage;

  const params = new URLSearchParams();
  if (isSort(sort) && sort !== DEFAULT_REVIEWS_SORT) params.set(REVIEWS_PARAM.sort, sort);
  if (isStar(stars)) params.set(REVIEWS_PARAM.stars, String(stars));
  if (verifiedOnly === true) params.set(REVIEWS_PARAM.verified, "1");
  if (typeof rpage === "number" && Number.isSafeInteger(rpage) && rpage > 1) {
    params.set(REVIEWS_PARAM.page, String(rpage));
  }

  const path = basePath.split(/[?#]/, 1)[0] ?? "";
  const search = params.toString();
  return `${path}${search ? `?${search}` : ""}#${REVIEWS_SECTION_ID}`;
}
