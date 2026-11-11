import { Badge } from "@/components/atoms/Badge";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import type { VoteActionFn } from "@/components/molecules/_contracts/review-actions";
import { QuestionCard } from "@/components/molecules/QuestionCard";
import { ReviewCard } from "@/components/molecules/ReviewCard";

import type { Contributions, ContributionProduct } from "./loaders";
import { productHref } from "./page-parts";

export interface ContributionsViewProps {
  readonly contributions: Contributions;
  /** `voteReviewHelpful`; never posted (own reviews render without a vote form) but required by ReviewCard. */
  readonly voteReviewAction: VoteActionFn;
}

export const CONTRIBUTIONS_HEADING = "Your reviews & questions";
export const REVIEWS_EMPTY_TEXT = "You haven't reviewed any products yet.";
export const QUESTIONS_EMPTY_TEXT = "You haven't asked any questions yet.";
export const NOT_PUBLISHED_TEXT = "Not published";

function ProductLine({ prefix, product, fragment }: { prefix: string; product: ContributionProduct | null; fragment?: string }) {
  if (product === null) {
    return (
      <Text variant="small" tone="secondary">
        {`${prefix} a product that is no longer available`}
      </Text>
    );
  }
  const href = productHref(product.slug, fragment);
  return (
    <Text variant="small" tone="secondary" className="break-words">
      {`${prefix} `}
      {href !== null ? (
        <Link href={href} className="inline-flex min-h-touch items-center">
          {product.name}
        </Link>
      ) : (
        product.name
      )}
    </Text>
  );
}

/**
 * `/account/contributions` body (T98). Own reviews use `ReviewCard isOwn`
 * (no vote form). Own questions use `QuestionCard` read-only (no
 * `answerAction`, no vote actions → no `<form>` at all; helpful counts show
 * as text) with the answers nested by `QaService.listMineWithAnswers`
 * (CONS-B4 an), a "Not published" badge, and a link to the product's Q&A
 * section, where answering and voting happen. The page renders no form.
 */
export function ContributionsView({ contributions, voteReviewAction }: ContributionsViewProps) {
  const { reviews, questions } = contributions;
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Heading level={1}>{CONTRIBUTIONS_HEADING}</Heading>
      <section aria-labelledby="own-reviews-heading" className="flex min-w-0 flex-col gap-3">
        <Heading level={2} id="own-reviews-heading">
          {`Your reviews (${reviews.length})`}
        </Heading>
        {reviews.length === 0 ? (
          <Card tone="sunken">
            <Text tone="secondary">{REVIEWS_EMPTY_TEXT}</Text>
          </Card>
        ) : (
          <ul role="list" aria-label="Your reviews" className="flex min-w-0 flex-col">
            {reviews.map(({ review, product }) => (
              <li key={review.id} className="flex min-w-0 flex-col gap-1 pt-4">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <ProductLine prefix="Review of" product={product} />
                  {review.status !== "published" ? <Badge tone="warning">{NOT_PUBLISHED_TEXT}</Badge> : null}
                </div>
                <ReviewCard
                  review={{ ...review, isOwn: true }}
                  voteAction={voteReviewAction}
                  productSlug={product?.slug ?? ""}
                  headingLevel={3}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="own-questions-heading" className="flex min-w-0 flex-col gap-3">
        <Heading level={2} id="own-questions-heading">
          {`Your questions (${questions.length})`}
        </Heading>
        {questions.length === 0 ? (
          <Card tone="sunken">
            <Text tone="secondary">{QUESTIONS_EMPTY_TEXT}</Text>
          </Card>
        ) : (
          <ul role="list" aria-label="Your questions" className="flex min-w-0 flex-col gap-3">
            {questions.map(({ id, question, published, product }) => (
              <li key={id} className="flex min-w-0 flex-col gap-1">
                <ProductLine prefix="About" product={product} fragment="questions" />
                <QuestionCard
                  question={{ ...question, isOwn: true }}
                  productSlug={product?.slug ?? ""}
                  badge={published ? null : <Badge tone="warning">{NOT_PUBLISHED_TEXT}</Badge>}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
