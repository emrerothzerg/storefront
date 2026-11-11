import type { Metadata } from "next";

import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Card } from "@/components/atoms/Card";
import { Icon } from "@/components/atoms/Icon";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { SearchField } from "@/components/atoms/SearchField";
import { Heading, Text } from "@/components/atoms/Typography";
import { JsonLd } from "@/components/molecules/JsonLd";
import { HELP_QUERY_MAX_LENGTH } from "@/content/search-help";
import { breadcrumbListJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";

import {
  HELP_BREADCRUMB,
  HELP_DESCRIPTION,
  HELP_PATH,
  HELP_QUERY_PARAM,
  HELP_TITLE,
  isHelpSearchRequest,
  loadHelpPage,
  resultCountLabel,
} from "./_lib/help-page";

export interface HelpPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Search variants (`?q=` with any value) are not indexed; the canonical stays `/help`. */
export async function generateMetadata({ searchParams }: HelpPageProps): Promise<Metadata> {
  const params = await searchParams;
  return buildMetadata({
    title: HELP_TITLE,
    description: HELP_DESCRIPTION,
    path: HELP_PATH,
    noindex: isHelpSearchRequest(params),
  });
}

const RESULTS_HEADING_ID = "help-results-heading";
const TOPICS_HEADING_ID = "help-topics-heading";
const MORE_HEADING_ID = "help-more-heading";

/**
 * Help centre: a GET search form (`?q=`, works without JS), results or an
 * empty state, topic tiles and links to the FAQ and the contact form. The
 * query is only ever rendered as a React text child.
 */
export default async function HelpPage({ searchParams }: HelpPageProps) {
  const { query, searched, results, topics } = loadHelpPage(await searchParams);

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Breadcrumb items={[...HELP_BREADCRUMB]} />
      <header className="flex max-w-prose flex-col gap-2">
        <Heading level={1}>{HELP_TITLE}</Heading>
        <Text tone="secondary">
          Find answers about orders, payments, delivery, returns and your account.
        </Text>
      </header>

      <SearchField
        action={HELP_PATH}
        name={HELP_QUERY_PARAM}
        label="Search help"
        showLabel
        aria-label="Help"
        submitLabel="Submit help search"
        placeholder="For example: free shipping"
        defaultValue={query ?? ""}
        maxLength={HELP_QUERY_MAX_LENGTH}
        className="max-w-prose"
      />

      {searched ? (
        <Card as="section" aria-labelledby={RESULTS_HEADING_ID} className="flex max-w-prose flex-col gap-3">
          {query === null ? (
            <>
              <Heading level={2} id={RESULTS_HEADING_ID}>
                Search help
              </Heading>
              <Notice tone="info">Enter a word or phrase to search the help center.</Notice>
            </>
          ) : (
            <>
              <Heading level={2} id={RESULTS_HEADING_ID} className="break-words">
                {`Results for “${query}”`}
              </Heading>
              <Text tone="secondary">{resultCountLabel(results.length)}</Text>
              {results.length === 0 ? (
                <Notice tone="info" title="No help articles match your search">
                  Try fewer or different words, browse the topics below or contact us.
                </Notice>
              ) : (
                <ol className="flex flex-col gap-2">
                  {results.map((result) => (
                    <li key={result.key} className="flex min-w-0 flex-col">
                      <Link href={result.href} variant="nav" className="break-words font-semibold">
                        {result.title}
                      </Link>
                      <Text variant="small" tone="secondary" className="break-words">
                        {result.kind === "topic" ? `Help topic: ${result.detail}` : result.detail}
                      </Text>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </Card>
      ) : null}

      <section aria-labelledby={TOPICS_HEADING_ID} className="flex flex-col gap-4">
        <Heading level={2} id={TOPICS_HEADING_ID}>
          Browse help topics
        </Heading>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {topics.map((topic) => (
            <Card as="li" key={topic.slug} interactive padding="none" className="flex">
              <Link
                href={topic.href}
                variant="nav"
                className="flex w-full items-start gap-3 rounded-lg p-4 hover:no-underline"
              >
                <span className="flex size-touch shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent">
                  <Icon name={topic.icon} />
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <Text as="span" className="font-semibold break-words">
                    {topic.title}
                  </Text>
                  <Text as="span" variant="small" tone="secondary" className="break-words">
                    {topic.summary}
                  </Text>
                </span>
              </Link>
            </Card>
          ))}
        </ul>
      </section>

      <section aria-labelledby={MORE_HEADING_ID} className="flex max-w-prose flex-col gap-2">
        <Heading level={2} id={MORE_HEADING_ID}>
          More ways to get help
        </Heading>
        <ul className="flex flex-wrap gap-3">
          <li>
            <Link href="/faq" variant="button" buttonVariant="outline">
              Frequently asked questions
            </Link>
          </li>
          <li>
            <Link href="/contact" variant="button" buttonVariant="outline">
              Contact us
            </Link>
          </li>
        </ul>
      </section>

      <JsonLd
        data={breadcrumbListJsonLd([
          { name: "Home", path: "/" },
          { name: HELP_TITLE, path: HELP_PATH },
        ])}
      />
    </div>
  );
}
