import { Card } from "@/components/atoms/Card";
import { Disclosure } from "@/components/atoms/Disclosure";
import { Link } from "@/components/atoms/Link";
import { Pagination, PaginationSummary } from "@/components/atoms/Pagination";
import { Heading, Text } from "@/components/atoms/Typography";
import type { QaActionFn, QaVoteActionFn } from "@/components/molecules/_contracts/qa-actions";
import { QuestionCard } from "@/components/molecules/QuestionCard";
import { QuestionForm } from "@/components/molecules/QuestionForm";
// Type-only: organisms never import server code at runtime.
import type { QaListResult } from "@/server/qa/qa-service";
import { QA_SECTION_ID, buildQaHref, type QaExtraParams } from "./qa-href";

/** Page size the Q&A service uses (`QA_PAGE_SIZE`); a test asserts they match. */
export const QA_SECTION_PAGE_SIZE = 5;
/** Answers shown per question before "See all N answers". */
export const QA_VISIBLE_ANSWERS = 2;

export const QA_HEADING = "Customer questions & answers";
export const QA_HEADING_ID = "questions-heading";
export const ASK_QUESTION_DISCLOSURE_ID = "ask-question";
export const QA_EMPTY_MESSAGE = "No questions yet. Be the first to ask.";
export const QA_PAGE_EMPTY_MESSAGE = "There are no questions on this page";

export interface QASectionActions {
  readonly askQuestion: QaActionFn;
  readonly answerQuestion: QaActionFn;
  readonly voteQuestion: QaVoteActionFn;
  readonly voteAnswer: QaVoteActionFn;
}

export interface QASectionViewer {
  /** Signed-in account display name (forms show "Posting as <name>"). */
  readonly signedInName?: string | null;
}

export interface QASectionProps {
  productId: string;
  productSlug: string;
  /** Result of `qaService.list(...)` for the current page. */
  list: QaListResult;
  /** Product page path without query, e.g. `/products/<slug>`. */
  basePath: string;
  actions: QASectionActions;
  viewer: QASectionViewer;
  /** Outline level of the section heading. Defaults to 2. */
  headingLevel?: 2 | 3;
  /** Other URL params to keep on pagination links (e.g. the reviews state). `qpage` is ignored. */
  extraParams?: QaExtraParams;
  className?: string;
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function questionCountText(total: number): string {
  const n = safeCount(total);
  return `${new Intl.NumberFormat("en-US").format(n)} ${n === 1 ? "question" : "questions"}`;
}

/**
 * Product Q&A section (`<section id="questions">`) labelled by the
 * "Customer questions & answers" heading: question count, the "Ask a question"
 * Disclosure holding QuestionForm (open when there are no questions), an
 * `<ol>` of QuestionCards (first 2 answers visible, the rest behind the card's
 * "See all N answers" Disclosure), "Showing x–y of N questions" and GET
 * pagination links (`?qpage=N#questions`). Server-safe and presentational:
 * data and server actions arrive as props; every form posts the server action
 * directly (no JS needed). User text is rendered by the molecules as text only.
 */
export function QASection({
  productId,
  productSlug,
  list,
  basePath,
  actions,
  viewer,
  headingLevel = 2,
  extraParams,
  className,
}: QASectionProps) {
  const total = safeCount(list.total);
  const pageCount = safeCount(list.pageCount);
  const page = safeCount(list.page) || 1;
  const hasQuestions = total > 0;
  const hrefFor = (p: number) => buildQaHref(basePath, { qpage: page, extra: extraParams }, { qpage: p });

  let body;
  if (!hasQuestions) {
    body = (
      <Card tone="sunken" padding="md">
        <Text className="font-semibold" data-testid="questions-empty">
          {QA_EMPTY_MESSAGE}
        </Text>
      </Card>
    );
  } else if (list.items.length === 0) {
    // Page beyond the last one (hand-edited URL).
    body = (
      <Card tone="sunken" padding="md" className="flex flex-col items-start gap-3" data-testid="questions-page-empty">
        <Text>{QA_PAGE_EMPTY_MESSAGE}</Text>
        <Link href={hrefFor(1)} variant="button" buttonVariant="outline" buttonSize="sm">
          Go to the first page of questions
        </Link>
      </Card>
    );
  } else {
    body = (
      <>
        <PaginationSummary page={page} pageSize={QA_SECTION_PAGE_SIZE} total={total} itemLabel="questions" />
        <ol role="list" aria-label="Questions" className="flex min-w-0 flex-col gap-4">
          {list.items.map((question) => (
            <li key={question.id} className="min-w-0">
              <QuestionCard
                question={question}
                voteQuestion={actions.voteQuestion}
                voteAnswer={actions.voteAnswer}
                answerAction={actions.answerQuestion}
                productSlug={productSlug}
                signedInName={viewer.signedInName}
                maxVisibleAnswers={QA_VISIBLE_ANSWERS}
              />
            </li>
          ))}
        </ol>
        <Pagination page={page} pageCount={pageCount} hrefFor={hrefFor} label="Questions pagination" />
      </>
    );
  }

  return (
    <section
      id={QA_SECTION_ID}
      aria-labelledby={QA_HEADING_ID}
      className={["flex min-w-0 flex-col gap-6", className].filter(Boolean).join(" ")}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading level={headingLevel} id={QA_HEADING_ID} className="break-words">
          {QA_HEADING}
        </Heading>
        <Text tone="secondary" data-testid="questions-count">
          {questionCountText(total)}
        </Text>
      </div>

      {hasQuestions ? null : body}

      <Disclosure
        summary="Ask a question"
        id={ASK_QUESTION_DISCLOSURE_ID}
        defaultOpen={!hasQuestions}
        variant="bordered"
        className="shadow-sm"
      >
        <QuestionForm
          action={actions.askQuestion}
          productId={productId}
          productSlug={productSlug}
          signedInName={viewer.signedInName}
          className="pt-2"
        />
      </Disclosure>

      {hasQuestions ? body : null}
    </section>
  );
}
