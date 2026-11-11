import { productJsonLd, toProductJsonLdInput, type ProductJsonLd } from "@/lib/seo/json-ld";
import type { ProductDetail, Review, ReviewSummary } from "@/lib/types";

/**
 * PDP structured data (T97 criterion 3), built on the P2-S helpers. The
 * `JsonLd` molecule serialises it and escapes `<`, `>`, `&`, so review text
 * containing `</script>` cannot end the script element.
 */

/** Review entries embedded in the Product graph (newest first). */
export const JSON_LD_REVIEW_CAP = 5;

export type ReviewJsonLd = {
  readonly "@type": "Review";
  readonly name: string;
  readonly reviewBody: string;
  readonly datePublished: string;
  readonly author: { readonly "@type": "Person"; readonly name: string };
  readonly reviewRating: {
    readonly "@type": "Rating";
    readonly ratingValue: number;
    readonly bestRating: 5;
    readonly worstRating: 1;
  };
};

export type PdpProductJsonLd = ProductJsonLd & { readonly review?: readonly ReviewJsonLd[] };

/** `YYYY-MM-DD` of an ISO timestamp, or "" when it does not look like one. */
function isoDate(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "";
}

function toReviewJsonLd(review: Review): ReviewJsonLd | null {
  const body = review.body.trim();
  const date = isoDate(review.createdAt);
  if (body === "" || date === "") return null;
  return {
    "@type": "Review",
    name: review.title.trim(),
    reviewBody: body,
    datePublished: date,
    author: { "@type": "Person", name: review.displayName.trim() || "Anonymous shopper" },
    reviewRating: { "@type": "Rating", ratingValue: review.rating, bestRating: 5, worstRating: 1 },
  };
}

export interface PdpJsonLdInput {
  readonly product: ProductDetail;
  /** Canonical site path, `/products/<slug>`. */
  readonly path: string;
  /** Published review summary; aggregateRating only when `count >= 1`. */
  readonly summary: ReviewSummary;
  /** Newest published reviews (only the first `JSON_LD_REVIEW_CAP` are used). */
  readonly recentReviews: readonly Review[];
}

/** Product + Offer (+ AggregateRating, Review[] when present). */
export function buildProductJsonLd({ product, path, summary, recentReviews }: PdpJsonLdInput): PdpProductJsonLd {
  const base = productJsonLd({
    ...toProductJsonLdInput({
      ...product,
      ratingCount: summary.count,
      ratingAvg: summary.avg,
    }),
    url: path,
  });
  if (summary.count < 1) return base;
  const reviews = recentReviews
    .filter((r) => r.status === "published")
    .slice(0, JSON_LD_REVIEW_CAP)
    .map(toReviewJsonLd)
    .filter((r): r is ReviewJsonLd => r !== null);
  return reviews.length > 0 ? { ...base, review: reviews } : base;
}
