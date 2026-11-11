import { Disclosure } from "@/components/atoms/Disclosure";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import type { FaqEntry } from "@/content/faq";
import { faqRelatedLinkLabel, safeRelatedHrefs } from "./faq-links";

export const FAQ_RELATED_LABEL = "Related pages";

export interface FaqListProps {
  entries: readonly FaqEntry[];
  /** Slug of the entry rendered open (`<details open>`), e.g. from `?open=<slug>`. */
  openSlug?: string;
  /** Optional visible heading for the list. */
  title?: string;
  /** Level of `title` (2 default, or 3). Has no effect without `title`. */
  headingLevel?: 2 | 3;
  /** Text before each entry's related links. Defaults to "Related pages". */
  relatedLabel?: string;
  className?: string;
}

/**
 * Server-safe FAQ list. Each entry is a native `<details id={entry.slug}>`
 * (Disclosure atom): the question is the `<summary>` (keyboard operable with
 * Enter/Space), the answer paragraphs are `<p>` text children, followed by
 * related links validated with `isAllowedInternalHref` (invalid ones are
 * omitted). Works without JavaScript; `#slug` deep links scroll to the item.
 * Duplicate slugs keep only the first entry so ids stay unique.
 */
export function FaqList({
  entries,
  openSlug,
  title,
  headingLevel = 2,
  relatedLabel = FAQ_RELATED_LABEL,
  className,
}: FaqListProps) {
  const seen = new Set<string>();
  const unique = entries.filter((entry) => {
    if (seen.has(entry.slug)) return false;
    seen.add(entry.slug);
    return true;
  });

  const list = (
    <ul className="flex min-w-0 flex-col gap-3">
      {unique.map((entry) => {
        const related = safeRelatedHrefs(entry.relatedHrefs);
        return (
          <li key={entry.slug} className="min-w-0">
            <Disclosure
              id={entry.slug}
              defaultOpen={openSlug !== undefined && openSlug === entry.slug}
              summary={<span className="break-words">{entry.question}</span>}
              variant="bordered"
              className="scroll-mt-4 shadow-sm"
            >
              <div className="flex flex-col gap-3">
                {entry.answer.map((paragraph, index) => (
                  <Text key={index} className="break-words">
                    {paragraph}
                  </Text>
                ))}
                {related.length > 0 ? (
                  <div className="flex flex-col">
                    <Text variant="small" tone="secondary">
                      {relatedLabel}
                    </Text>
                    <ul className="flex flex-wrap gap-x-4">
                      {related.map((href) => (
                        <li key={href} className="flex min-h-touch items-center">
                          <Link href={href}>{faqRelatedLinkLabel(href)}</Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </Disclosure>
          </li>
        );
      })}
    </ul>
  );

  if (title === undefined || title === "") {
    return className ? <div className={className}>{list}</div> : list;
  }
  return (
    <div className={["flex min-w-0 flex-col gap-3", className].filter(Boolean).join(" ")}>
      <Heading level={headingLevel} className="break-words">
        {title}
      </Heading>
      {list}
    </div>
  );
}
