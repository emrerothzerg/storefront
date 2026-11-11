import type { Metadata } from "next";

import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import { JsonLd } from "@/components/molecules/JsonLd";
import { FaqList } from "@/components/organisms/FaqList";
import { StaticPage } from "@/components/templates/StaticPage";
import { breadcrumbListJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";

import { FAQ_DESCRIPTION, FAQ_PATH, FAQ_TITLE, loadFaqPage } from "./_lib/faq-page";

export const metadata: Metadata = buildMetadata({
  title: FAQ_TITLE,
  description: FAQ_DESCRIPTION,
  path: FAQ_PATH,
});

export interface FaqPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const TOPICS_NAV_ID = "faq-topics-heading";

/**
 * Every FAQ entry, grouped by help topic, as native `<details id={slug}>`
 * (`?open=<slug>#<slug>` opens one). The FAQPage JSON-LD is built from the
 * same entries the lists render.
 */
export default async function FaqPage({ searchParams }: FaqPageProps) {
  const { groups, openSlug, jsonLd } = loadFaqPage(await searchParams);

  return (
    <>
      <StaticPage
        title={FAQ_TITLE}
        breadcrumb={[{ label: "Home", href: "/" }, { label: FAQ_TITLE }]}
        intro={["Select a question to show its answer. For more detail, browse the help center or contact us."]}
        sections={[]}
      >
        <Card>
          <nav aria-labelledby={TOPICS_NAV_ID}>
            <Text id={TOPICS_NAV_ID} className="font-semibold">
              Topics
            </Text>
            <ul className="mt-1 flex flex-wrap gap-x-6">
              {groups.map((group) => (
                <li key={group.id}>
                  <Link href={`#${group.id}`} variant="nav">
                    {group.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </Card>
        {groups.map((group) => (
          <section key={group.id} aria-labelledby={group.id} className="flex flex-col gap-3">
            <Heading level={2} id={group.id} className="scroll-mt-4 break-words">
              {group.title}
            </Heading>
            <FaqList entries={group.entries} openSlug={openSlug} />
          </section>
        ))}
        <Card tone="sunken">
          <Text>
            Still have a question? <Link href="/help">Visit the help center</Link> or{" "}
            <Link href="/contact">contact us</Link>.
          </Text>
        </Card>
      </StaticPage>
      <JsonLd
        data={[
          jsonLd,
          breadcrumbListJsonLd([
            { name: "Home", path: "/" },
            { name: FAQ_TITLE, path: FAQ_PATH },
          ]),
        ]}
      />
    </>
  );
}
