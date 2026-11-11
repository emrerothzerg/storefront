import type { ReactNode } from "react";
import { Breadcrumb, type BreadcrumbItem } from "@/components/atoms/Breadcrumb";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Heading, Text } from "@/components/atoms/Typography";
import { SAMPLE_POLICY_NOTICE } from "@/content/policies";
import { isAllowedInternalHref } from "@/content/routes";
import { STATIC_PAGE_TOC_THRESHOLD, buildSectionIds, formatLastUpdated } from "./static-page-utils";

export const STATIC_PAGE_TOC_LABEL = "On this page";
export const STATIC_PAGE_HEADING_ID = "static-page-title";
/** Ids already used by the layout or this template; section ids never take them. */
const RESERVED_IDS: readonly string[] = ["main", STATIC_PAGE_HEADING_ID];

export interface StaticPageBreadcrumbItem {
  readonly label: string;
  /** Omit for the current page. Hrefs failing `isAllowedInternalHref` render as plain text. */
  readonly href?: string;
}

export interface StaticPageSection {
  /** Anchor id; slugified. Defaults to the slugified heading. Duplicates get `-2`, `-3`... */
  readonly id?: string;
  readonly heading: string;
  /** Plain-text paragraphs, each rendered as a `<p>` text child (never parsed as HTML). */
  readonly paragraphs: readonly string[];
}

export interface StaticPageProps {
  /** The page's only `<h1>`. */
  title: string;
  /** Root to current page (e.g. Home > Help > Shipping). */
  breadcrumb: readonly StaticPageBreadcrumbItem[];
  sections: readonly StaticPageSection[];
  /** ISO date (YYYY-MM-DD); shown as "Last updated November 7, 2026". Invalid dates are omitted. */
  lastUpdated?: string;
  /** Shows `SAMPLE_POLICY_NOTICE` in an info Notice (and drops it if it is the first paragraph). */
  sampleNotice?: boolean;
  /** Plain-text lead paragraphs above the table of contents. */
  intro?: readonly string[];
  /** Complementary content (e.g. related links) beside the prose on wide screens, below it on narrow ones. */
  aside?: ReactNode;
  /** Extra content after the sections (e.g. a FaqList or a form). */
  children?: ReactNode;
  className?: string;
}

/**
 * Server-safe template for policy, company and help pages: Breadcrumb, one
 * `<h1>`, optional "Last updated" line and sample-policy Notice, an
 * "On this page" table of contents (only for more than 3 sections), then
 * `<section id>` blocks of `<h2>` + `<p>` text at a readable prose width.
 */
export function StaticPage({
  title,
  breadcrumb,
  sections,
  lastUpdated,
  sampleNotice = false,
  intro = [],
  aside,
  children,
  className,
}: StaticPageProps) {
  const crumbs: BreadcrumbItem[] = breadcrumb.map((item) =>
    item.href !== undefined && isAllowedInternalHref(item.href)
      ? { label: item.label, href: item.href }
      : { label: item.label },
  );
  const updated = lastUpdated === undefined ? null : formatLastUpdated(lastUpdated);
  const ids = buildSectionIds(sections, RESERVED_IDS);
  const showToc = sections.length > STATIC_PAGE_TOC_THRESHOLD;
  const hasAside = aside !== undefined && aside !== null && aside !== false;

  return (
    <article
      aria-labelledby={STATIC_PAGE_HEADING_ID}
      className={["flex min-w-0 flex-col gap-6", className].filter(Boolean).join(" ")}
    >
      {crumbs.length > 0 ? <Breadcrumb items={crumbs} /> : null}
      <header className="flex max-w-prose flex-col gap-2">
        <Heading level={1} id={STATIC_PAGE_HEADING_ID} className="break-words">
          {title}
        </Heading>
        {updated ? (
          <Text variant="small" tone="secondary">
            Last updated <time dateTime={updated.dateTime}>{updated.label}</time>
          </Text>
        ) : null}
      </header>
      {sampleNotice ? (
        <Notice tone="info" className="max-w-prose">
          {SAMPLE_POLICY_NOTICE}
        </Notice>
      ) : null}
      <div className={hasAside ? "grid min-w-0 gap-8 lg:grid-cols-3" : "min-w-0"}>
        <div className="flex min-w-0 max-w-prose flex-col gap-8 lg:col-span-2">
          {intro.length > 0 ? (
            <div className="flex flex-col gap-3">
              {intro.map((paragraph, index) => (
                <Text key={index} className="break-words">
                  {paragraph}
                </Text>
              ))}
            </div>
          ) : null}
          {showToc ? (
            <Card>
              <nav aria-label={STATIC_PAGE_TOC_LABEL}>
                <Text className="font-semibold">{STATIC_PAGE_TOC_LABEL}</Text>
                <ol className="mt-1 flex flex-col">
                  {sections.map((section, index) => (
                    <li key={ids[index]}>
                      <Link href={`#${ids[index]}`} variant="nav" className="break-words">
                        {section.heading}
                      </Link>
                    </li>
                  ))}
                </ol>
              </nav>
            </Card>
          ) : null}
          {sections.map((section, index) => {
            const paragraphs =
              index === 0 && sampleNotice && section.paragraphs[0] === SAMPLE_POLICY_NOTICE
                ? section.paragraphs.slice(1)
                : section.paragraphs;
            return (
              <section key={ids[index]} id={ids[index]} className="flex scroll-mt-4 flex-col gap-3">
                <Heading level={2} className="break-words">
                  {section.heading}
                </Heading>
                {paragraphs.map((paragraph, pIndex) => (
                  <Text key={pIndex} className="break-words">
                    {paragraph}
                  </Text>
                ))}
              </section>
            );
          })}
          {children}
        </div>
        {hasAside ? <aside className="min-w-0">{aside}</aside> : null}
      </div>
    </article>
  );
}
