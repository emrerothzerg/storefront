import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Heading } from "@/components/atoms/Typography";
import { JsonLd } from "@/components/molecules/JsonLd";
import { FaqList } from "@/components/organisms/FaqList";
import { StaticPage } from "@/components/templates/StaticPage";
import { breadcrumbListJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";

import { HELP_PATH, HELP_TITLE } from "../_lib/help-page";
import { helpTopicTitle, loadHelpTopicPage, resolveHelpTopic } from "./_lib/help-topic-page";

export interface HelpTopicPageProps {
  readonly params: Promise<{ topic: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: HelpTopicPageProps): Promise<Metadata> {
  const { topic: raw } = await params;
  const topic = resolveHelpTopic(raw);
  if (topic === null) {
    return buildMetadata({
      title: "Help topic not found",
      description: "This help topic does not exist.",
      noindex: true,
    });
  }
  return buildMetadata({
    title: helpTopicTitle(topic),
    description: topic.summary,
    path: `${HELP_PATH}/${topic.slug}`,
  });
}

const ASIDE_HEADING_ID = "help-topic-aside-heading";

/**
 * One help topic: the topic's FAQ entries as native `<details id={slug}>`
 * (search results deep-link with `?open=<slug>#<slug>`), plus links back to
 * the help centre and to the contact form with the topic pre-selected.
 */
export default async function HelpTopicPage({ params, searchParams }: HelpTopicPageProps) {
  const { topic: raw } = await params;
  const data = loadHelpTopicPage(raw, await searchParams);
  if (data === null) notFound();
  const { topic, entries, openSlug, breadcrumb, contactHref, path } = data;

  return (
    <>
      <StaticPage
        title={topic.title}
        breadcrumb={breadcrumb}
        intro={[topic.summary]}
        sections={[]}
        aside={
          <Card tone="sunken">
            <nav aria-labelledby={ASIDE_HEADING_ID}>
              <Heading level={2} size="h4" id={ASIDE_HEADING_ID}>
                Still need help?
              </Heading>
              <ul className="mt-1 flex flex-col">
                <li>
                  <Link href={contactHref} variant="nav">
                    Contact us about {topic.title.toLowerCase()}
                  </Link>
                </li>
                <li>
                  <Link href={HELP_PATH} variant="nav">
                    All help topics
                  </Link>
                </li>
                <li>
                  <Link href="/faq" variant="nav">
                    All frequently asked questions
                  </Link>
                </li>
              </ul>
            </nav>
          </Card>
        }
      >
        <FaqList entries={entries} openSlug={openSlug} title="Questions and answers" />
      </StaticPage>
      <JsonLd
        data={breadcrumbListJsonLd([
          { name: "Home", path: "/" },
          { name: HELP_TITLE, path: HELP_PATH },
          { name: topic.title, path },
        ])}
      />
    </>
  );
}
