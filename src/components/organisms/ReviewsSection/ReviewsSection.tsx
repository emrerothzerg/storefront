import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Chip } from "@/components/atoms/Chip";
import { Disclosure } from "@/components/atoms/Disclosure";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { Pagination, PaginationSummary } from "@/components/atoms/Pagination";
import { Select, type SelectOption } from "@/components/atoms/Select";
import { Text } from "@/components/atoms/Typography";
import type { ReviewActionFn, VoteActionFn } from "@/components/molecules/_contracts/review-actions";
import { ReviewCard } from "@/components/molecules/ReviewCard";
import { REVIEW_FORM_ID, ReviewForm } from "@/components/molecules/ReviewForm";
import { ReviewSummary } from "@/components/molecules/ReviewSummary";
import type { StarRating } from "@/lib/types";
// Type-only: organisms never import server code at runtime.
import type { ReviewListResult, ReviewSort } from "@/server/reviews/review-service";
import {
  REVIEWS_PARAM,
  REVIEWS_SECTION_ID,
  buildReviewsHref,
  type ReviewsUrlState,
} from "./reviews-href";

/** Page size the review service uses (`DEFAULT_REVIEW_PAGE_SIZE`); a test asserts they match. */
export const REVIEWS_PAGE_SIZE = 10;

export const REVIEWS_HEADING_ID = "reviews-heading";
export const WRITE_REVIEW_DISCLOSURE_ID = "write-review-disclosure";
export const REVIEWS_SORT_SELECT_ID = "reviews-sort";

export const REVIEWS_EMPTY_MESSAGE = "Be the first to review this product";
export const REVIEWS_NO_MATCH_MESSAGE = "No reviews match your filters";
export const REVIEWS_PAGE_EMPTY_MESSAGE = "There are no reviews on this page";

export const REVIEW_SORT_OPTIONS: ReadonlyArray<SelectOption & { value: ReviewSort }> = [
  { value: "helpful", label: "Top reviews" },
  { value: "recent", label: "Most recent" },
];

export interface ReviewsQuery {
  readonly sort: ReviewSort;
  readonly stars?: StarRating;
  readonly verifiedOnly?: boolean;
}

export interface ReviewsSectionActions {
  readonly submitReview: ReviewActionFn;
  readonly voteReviewHelpful: VoteActionFn;
}

export interface ReviewsSectionViewer {
  /** Signed-in account display name (the form shows "Posting as <name>"). */
  readonly signedInName?: string | null;
  /** The viewer already reviewed this product: the form is replaced by a notice. */
  readonly alreadyReviewed: boolean;
}

export interface ReviewsSectionProps {
  productId: string;
  productSlug: string;
  /** Result of `reviewService.list(...)` for the current query. */
  list: ReviewListResult;
  /** Current sort/filter state, parsed from the URL by the page. */
  query: ReviewsQuery;
  /** Product page path without query, e.g. `/products/<slug>`. */
  basePath: string;
  actions: ReviewsSectionActions;
  viewer: ReviewsSectionViewer;
  /** Outline level of "Customer reviews"; review titles use one level below. Defaults to 2. */
  headingLevel?: 2 | 3;
  /** Reviews per page used for "Showing 1–10 of N reviews". Defaults to the service default (10). */
  pageSize?: number;
  className?: string;
}

function starsLabel(stars: StarRating): string {
  return `${stars} ${stars === 1 ? "star" : "stars"}`;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Product reviews section (`<section id="reviews">`): summary + histogram,
 * GET-only filter/sort controls (links and a `method="get"` form, so they work
 * without JavaScript; the state lives in the URL), the list of ReviewCards,
 * pagination, and the "Write a review" disclosure holding ReviewForm
 * (`#write-review`). Server-safe and presentational: data and server actions
 * arrive as props. Review text is rendered by ReviewCard as React text only.
 */
export function ReviewsSection({
  productId,
  productSlug,
  list,
  query,
  basePath,
  actions,
  viewer,
  headingLevel = 2,
  pageSize = REVIEWS_PAGE_SIZE,
  className,
}: ReviewsSectionProps) {
  const summaryCount = safeCount(list.summary.count);
  const total = safeCount(list.total);
  const pageCount = safeCount(list.pageCount);
  const page = safeCount(list.page) || 1;
  const hasReviews = summaryCount > 0;

  const state: ReviewsUrlState = {
    sort: query.sort,
    stars: query.stars,
    verifiedOnly: query.verifiedOnly,
    rpage: page,
  };
  const href = (patch: Parameters<typeof buildReviewsHref>[2]) => buildReviewsHref(basePath, state, patch);
  const sortAction = `${basePath.split(/[?#]/, 1)[0] ?? ""}#${REVIEWS_SECTION_ID}`;
  const cardHeadingLevel: 3 | 4 = headingLevel === 2 ? 3 : 4;

  const classes = ["flex min-w-0 flex-col gap-6", className].filter(Boolean).join(" ");

  let body;
  if (!hasReviews) {
    body = (
      <Card tone="sunken" padding="md">
        <Text className="font-semibold" data-testid="reviews-empty">
          {REVIEWS_EMPTY_MESSAGE}
        </Text>
      </Card>
    );
  } else if (list.items.length === 0 && total === 0) {
    body = (
      <Card tone="sunken" padding="md" className="flex flex-col items-start gap-3" data-testid="reviews-no-match">
        <Text>{REVIEWS_NO_MATCH_MESSAGE}</Text>
        <Link
          href={href({ stars: undefined, verifiedOnly: undefined })}
          variant="button"
          buttonVariant="outline"
          buttonSize="sm"
        >
          Clear filters
        </Link>
      </Card>
    );
  } else if (list.items.length === 0) {
    // Page beyond the last one (hand-edited URL).
    body = (
      <Card tone="sunken" padding="md" className="flex flex-col items-start gap-3" data-testid="reviews-page-empty">
        <Text>{REVIEWS_PAGE_EMPTY_MESSAGE}</Text>
        <Link href={href({ rpage: undefined })} variant="button" buttonVariant="outline" buttonSize="sm">
          Go to the first page of reviews
        </Link>
      </Card>
    );
  } else {
    body = (
      <>
        <PaginationSummary page={page} pageSize={pageSize} total={total} itemLabel="reviews" />
        {/* White card; each ReviewCard keeps its own bottom divider. */}
        <Card padding="none" className="px-4 sm:px-5" data-testid="reviews-list-card">
          <ul role="list" aria-label="Reviews" className="flex min-w-0 flex-col">
            {list.items.map((review) => (
              <li key={review.id} className="min-w-0">
                <ReviewCard
                  review={review}
                  voteAction={actions.voteReviewHelpful}
                  productSlug={productSlug}
                  headingLevel={cardHeadingLevel}
                />
              </li>
            ))}
          </ul>
        </Card>
        <Pagination
          page={page}
          pageCount={pageCount}
          hrefFor={(p) => href({ rpage: p })}
          label="Reviews pagination"
        />
      </>
    );
  }

  return (
    <section id={REVIEWS_SECTION_ID} aria-labelledby={REVIEWS_HEADING_ID} className={classes}>
      <Card padding="md" data-testid="reviews-summary-card">
        <ReviewSummary
          summary={list.summary}
          hrefForStars={(stars) => href({ stars, rpage: undefined })}
          activeStars={query.stars}
          headingLevel={headingLevel}
          headingId={REVIEWS_HEADING_ID}
        />
      </Card>

      {hasReviews ? (
        <Card tone="sunken" padding="sm" className="flex flex-col gap-3" data-testid="reviews-controls">
          <ul role="list" aria-label="Review filters" className="flex min-w-0 flex-wrap items-center gap-2">
            <li>
              <Chip
                as="a"
                href={href({ stars: undefined })}
                label="All stars"
                selected={query.stars === undefined}
                size="sm"
              />
            </li>
            {query.stars !== undefined ? (
              <li>
                <Chip
                  as="a"
                  href={href({ stars: undefined })}
                  label={`Remove filter: ${starsLabel(query.stars)}`}
                  leading={<Icon name="close" size="sm" />}
                  size="sm"
                />
              </li>
            ) : null}
            <li>
              <Chip
                as="a"
                href={href({ verifiedOnly: query.verifiedOnly !== true })}
                label="Verified purchase only"
                selected={query.verifiedOnly === true}
                size="sm"
              />
            </li>
          </ul>
          <form
            method="get"
            action={sortAction}
            className="flex min-w-0 flex-wrap items-end gap-2"
            aria-label="Sort reviews"
          >
            {query.stars !== undefined ? (
              <input type="hidden" name={REVIEWS_PARAM.stars} value={String(query.stars)} />
            ) : null}
            {query.verifiedOnly === true ? <input type="hidden" name={REVIEWS_PARAM.verified} value="1" /> : null}
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={REVIEWS_SORT_SELECT_ID} className="text-small font-semibold text-text-primary">
                Sort by
              </label>
              <Select
                id={REVIEWS_SORT_SELECT_ID}
                name={REVIEWS_PARAM.sort}
                options={REVIEW_SORT_OPTIONS}
                defaultValue={query.sort}
              />
            </div>
            <Button type="submit" variant="outline">
              Apply
            </Button>
          </form>
        </Card>
      ) : null}

      {body}

      {viewer.alreadyReviewed ? (
        <div id={REVIEW_FORM_ID}>
          <ReviewForm
            action={actions.submitReview}
            productId={productId}
            productSlug={productSlug}
            signedInName={viewer.signedInName}
            alreadyReviewed
          />
        </div>
      ) : (
        <Disclosure
          summary="Write a review"
          id={WRITE_REVIEW_DISCLOSURE_ID}
          defaultOpen={!hasReviews}
          variant="bordered"
          className="shadow-sm"
        >
          <ReviewForm
            action={actions.submitReview}
            productId={productId}
            productSlug={productSlug}
            signedInName={viewer.signedInName}
            alreadyReviewed={false}
          />
        </Disclosure>
      )}
    </section>
  );
}
