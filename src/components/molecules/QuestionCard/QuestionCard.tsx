"use client";

import { useId, type ReactNode } from "react";
import { Avatar } from "@/components/atoms/Avatar";
import { Badge } from "@/components/atoms/Badge";
import { Card } from "@/components/atoms/Card";
import { Disclosure } from "@/components/atoms/Disclosure";
import { Text } from "@/components/atoms/Typography";
import type { AnswerView, QuestionView } from "@/server/qa/qa-service";
import type { QaActionFn, QaVoteActionFn } from "../_contracts/qa-actions";
import { AnswerForm } from "../AnswerForm";
import { formatQaDate } from "../QuestionForm/qa-shared";
import { HelpfulVote, helpfulCountText } from "./HelpfulVote";

export interface QuestionCardProps {
  question: QuestionView;
  /** `voteQuestion` server action; absent → no question vote form (the count shows as text). */
  voteQuestion?: QaVoteActionFn;
  /** `voteAnswer` server action; absent → no answer vote forms (counts show as text). */
  voteAnswer?: QaVoteActionFn;
  /**
   * `answerQuestion` server action. When absent the card renders read-only:
   * no inline `AnswerForm` (e.g. the owner's own questions on
   * `/account/contributions`).
   */
  answerAction?: QaActionFn;
  productSlug: string;
  signedInName?: string | null;
  /** Answers shown before the "See all N answers" Disclosure. Default 2. */
  maxVisibleAnswers?: number;
  /** Optional status badge shown beside the asker line (e.g. a "Not published" `Badge`). */
  badge?: ReactNode;
  className?: string;
}

export const DEFAULT_MAX_VISIBLE_ANSWERS = 2;

function Byline({ verb, name, createdAt }: { verb: string; name: string; createdAt: string }) {
  const date = formatQaDate(createdAt);
  return (
    <Text variant="small" tone="secondary" className="min-w-0 break-words">
      {`${verb} by `}
      <span className="font-semibold">{name}</span>
      {date !== "" ? (
        <>
          {" on "}
          <time dateTime={createdAt}>{date}</time>
        </>
      ) : null}
    </Text>
  );
}

interface AnswerItemProps {
  answer: AnswerView;
  voteAnswer?: QaVoteActionFn;
  productSlug: string;
}

/** Count as text, no form: own content, or a read-only card without a vote action. */
function HelpfulCountText({ count }: { count: number }) {
  return Number.isInteger(count) && count > 0 ? (
    <Text variant="small" tone="secondary">
      {helpfulCountText(count)}
    </Text>
  ) : null;
}

function AnswerItem({ answer, voteAnswer, productSlug }: AnswerItemProps) {
  const bodyId = `answer-text-${useId()}`;
  return (
    <li className="flex min-w-0 flex-col gap-2 border-l-2 border-border-default pl-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Avatar name={answer.displayName} size="sm" decorative />
        {answer.isStore ? <Badge tone="info">Store answer</Badge> : null}
        <Byline verb="Answered" name={answer.displayName} createdAt={answer.createdAt} />
      </div>
      <Text id={bodyId} className="min-w-0 whitespace-pre-line break-words">
        {answer.body}
      </Text>
      {voteAnswer !== undefined ? (
        <HelpfulVote
          action={voteAnswer}
          target="answer"
          targetId={answer.id}
          productSlug={productSlug}
          helpfulCount={answer.helpfulCount}
          isOwn={answer.isOwn}
          votedByViewer={answer.votedByViewer}
          describedBy={bodyId}
        />
      ) : (
        <HelpfulCountText count={answer.helpfulCount} />
      )}
    </li>
  );
}

/**
 * One product question with its answers, helpful votes (when the vote
 * actions are given) and an inline answer form (when `answerAction` is
 * given). With none of the three it is fully read-only: no `<form>` at all. All user text is rendered
 * as React text children only.
 */
export function QuestionCard({
  question,
  voteQuestion,
  voteAnswer,
  answerAction,
  productSlug,
  signedInName,
  maxVisibleAnswers = DEFAULT_MAX_VISIBLE_ANSWERS,
  badge,
  className,
}: QuestionCardProps) {
  const questionTextId = `question-text-${useId()}`;
  const limit =
    Number.isInteger(maxVisibleAnswers) && maxVisibleAnswers >= 0 ? maxVisibleAnswers : DEFAULT_MAX_VISIBLE_ANSWERS;
  const answers = question.answers;
  const visible = answers.slice(0, limit);
  const hidden = answers.slice(limit);

  const renderAnswer = (answer: AnswerView) => (
    <AnswerItem key={answer.id} answer={answer} voteAnswer={voteAnswer} productSlug={productSlug} />
  );

  return (
    <Card as="article" className={["flex flex-col gap-3", className].filter(Boolean).join(" ")}>
      <div className="flex min-w-0 flex-col gap-1">
        <Text className="min-w-0 whitespace-pre-line break-words font-semibold">
          <span className="text-text-secondary">Q: </span>
          {/* Names the answer form and describes the helpful button. */}
          <span id={questionTextId} className="break-words">
            {question.body}
          </span>
        </Text>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Avatar name={question.displayName} size="sm" decorative />
          <Byline verb="Asked" name={question.displayName} createdAt={question.createdAt} />
          {badge ?? null}
        </div>
      </div>
      {voteQuestion !== undefined ? (
        <HelpfulVote
          action={voteQuestion}
          target="question"
          targetId={question.id}
          productSlug={productSlug}
          helpfulCount={question.helpfulCount}
          isOwn={question.isOwn}
          votedByViewer={question.votedByViewer}
          describedBy={questionTextId}
        />
      ) : (
        <HelpfulCountText count={question.helpfulCount} />
      )}
      {answers.length === 0 ? (
        <Text variant="small" tone="secondary">
          No answers yet.
        </Text>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          <ul aria-label={`Answers (${answers.length})`} className="flex min-w-0 flex-col gap-4">
            {visible.map(renderAnswer)}
          </ul>
          {hidden.length > 0 ? (
            <Disclosure summary={`See all ${answers.length} answers`}>
              <ul aria-label="More answers" className="flex min-w-0 flex-col gap-4 pt-2">
                {hidden.map(renderAnswer)}
              </ul>
            </Disclosure>
          ) : null}
        </div>
      )}
      {answerAction !== undefined ? (
        <AnswerForm
          action={answerAction}
          questionId={question.id}
          productSlug={productSlug}
          signedInName={signedInName}
          questionLabelId={questionTextId}
        />
      ) : null}
    </Card>
  );
}
