import { useId } from "react";
import { Card } from "@/components/atoms/Card";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import {
  FEEDBACK_COPY,
  FEEDBACK_HREF,
  feedbackHeading,
  resolveFeedbackSuggestions,
  type FeedbackSuggestion,
} from "./feedback-helpers";

export interface FeedbackBlockProps {
  /** Defaults to "Did you find what you were looking for?". Rendered as an `h2`. */
  heading?: string;
  /**
   * Suggestion links (2–3 rendered). Invalid or off-allow-list hrefs are
   * dropped; fewer than two valid ones are topped up with defaults
   * (all products, deals, help).
   */
  suggestions?: ReadonlyArray<FeedbackSuggestion>;
  id?: string;
  className?: string;
}

/**
 * "Did you find what you were looking for?" prompt under listing/search
 * results (T142). Server component, no form, no storage, no third-party
 * survey: suggestion links plus a "Give feedback" button-link to exactly
 * `/contact?topic=feedback` (the contact form preselects the topic).
 */
export function FeedbackBlock({ heading, suggestions, id, className }: FeedbackBlockProps) {
  const headingId = useId();
  const title = feedbackHeading(heading);
  const links = resolveFeedbackSuggestions(suggestions);

  return (
    <Card
      as="section"
      id={id}
      aria-labelledby={headingId}
      padding="none"
      className={["min-w-0 max-w-full overflow-hidden", className].filter(Boolean).join(" ")}
    >
      <div className="flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-4 sm:p-6">
        <span className="inline-flex size-touch shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent">
          <Icon name="question-circle" />
        </span>
        <div className="min-w-0 flex-1">
          <Heading level={2} size="h3" id={headingId} title={title.title} className="break-words">
            {title.text}
          </Heading>
          <Text as="p" tone="secondary" className="mt-1">
            {FEEDBACK_COPY.suggestionsIntro}
          </Text>
          <ul className="mt-1 flex min-w-0 flex-col">
            {links.map((link) => (
              <li key={link.href} className="min-w-0">
                {/* Truncated labels keep the full text in `title` and the accessible name (ChipRow parity). */}
                <Link
                  href={link.href}
                  variant="nav"
                  title={link.title}
                  aria-label={link.title}
                  className="underline wrap-anywhere"
                >
                  {link.text}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-3 bg-accent-subtle p-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <Text as="p" className="min-w-0 break-words">
          {FEEDBACK_COPY.band}
        </Text>
        <Link href={FEEDBACK_HREF} variant="button" className="shrink-0">
          {FEEDBACK_COPY.button}
        </Link>
      </div>
    </Card>
  );
}
