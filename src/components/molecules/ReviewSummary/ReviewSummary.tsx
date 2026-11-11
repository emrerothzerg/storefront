import type { Ref } from "react";
import { Link } from "@/components/atoms/Link";
import { ProgressBar } from "@/components/atoms/ProgressBar";
import { Rating } from "@/components/atoms/Rating";
import { Heading, Text } from "@/components/atoms/Typography";
import type { ReviewSummary as ReviewSummaryData, StarRating } from "@/lib/types";

/** Histogram rows top to bottom (5 stars first). */
export const REVIEW_SUMMARY_STARS: readonly StarRating[] = [5, 4, 3, 2, 1];

export interface ReviewSummaryProps {
  summary: ReviewSummaryData;
  /** Filter link for one star value, e.g. `(n) => \`?stars=${n}#reviews\``. */
  hrefForStars: (stars: StarRating) => string;
  /** Star value of the active filter; its row gets `aria-current`. */
  activeStars?: number;
  /** Outline level of the "Customer reviews" heading. Defaults to 2. */
  headingLevel?: 2 | 3;
  /** Heading id (e.g. for `aria-labelledby` on a wrapping section). */
  headingId?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Non-negative integer or 0 (NaN, Infinity, negatives and fractions are treated as bad data). */
function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Rounded share of `n` in `total`, clamped to 0..100; 0 when `total` is 0. */
export function starPercent(n: number, total: number): number {
  const count = safeCount(n);
  const all = safeCount(total);
  if (all === 0) return 0;
  return Math.min(100, Math.max(0, Math.round((count / all) * 100)));
}

const integer = new Intl.NumberFormat("en-US");

/**
 * Review overview: average stars, "N global ratings" and a 5..1 star
 * histogram whose rows are filter links named "5 star: 62%" (`aria-label`,
 * which contains the visible "5 star" and "62%" text). Server-safe; the bars
 * are decorative (the link name carries the value). With no reviews (or a
 * non-finite average) it shows "No reviews yet" and no rows; the displayed
 * average is clamped to [0, 5].
 */
export function ReviewSummary({
  summary,
  hrefForStars,
  activeStars,
  headingLevel = 2,
  headingId,
  className,
  ref,
}: ReviewSummaryProps) {
  const total = safeCount(summary.count);
  // A non-finite average is corrupt data: show "No reviews yet" rather than
  // "0.0 out of 5". The displayed number is clamped like the stars.
  const hasAvg = typeof summary.avg === "number" && Number.isFinite(summary.avg);
  const avg = hasAvg ? Math.min(5, Math.max(0, summary.avg)) : 0;
  const classes = ["flex min-w-0 flex-col gap-3", className].filter(Boolean).join(" ");

  return (
    <div ref={ref} className={classes}>
      <Heading level={headingLevel} size="h3" id={headingId}>
        Customer reviews
      </Heading>
      {total === 0 || !hasAvg ? (
        <Text tone="secondary">No reviews yet</Text>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Rating value={avg} size="md" />
            <Text as="span" variant="small">{`${avg.toFixed(1)} out of 5`}</Text>
          </div>
          <Text variant="small" tone="secondary">
            {`${integer.format(total)} global ${total === 1 ? "rating" : "ratings"}`}
          </Text>
          <ul className="flex flex-col gap-1">
            {REVIEW_SUMMARY_STARS.map((stars) => {
              const percent = starPercent(summary.histogram[stars], total);
              const isActive = activeStars === stars;
              return (
                <li key={stars}>
                  <Link
                    href={hrefForStars(stars)}
                    variant="subtle"
                    isCurrent={isActive}
                    aria-label={`${stars} star: ${percent}%`}
                    className="flex w-full min-w-0 items-center gap-3 rounded-md px-1 tabular-nums"
                  >
                    <span className="shrink-0 whitespace-nowrap">{`${stars} star`}</span>
                    <span aria-hidden="true" className="min-w-0 flex-1">
                      <ProgressBar
                        value={percent}
                        label={`${stars} star`}
                        hideLabel
                        size="md"
                        aria-hidden="true"
                      />
                    </span>
                    <span className="min-w-10 shrink-0 text-right">{`${percent}%`}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
