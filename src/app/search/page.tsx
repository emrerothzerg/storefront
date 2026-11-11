import type { Metadata } from "next";
import { connection } from "next/server";

import { addToCart } from "@/app/actions/cart";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import { ChipRow } from "@/components/molecules/ChipRow";
import { ListingTemplate } from "@/components/templates/ListingTemplate";
import type { PageLink } from "@/app/_listing/listing-page";

import { loadSearchPage, NO_RESULTS_TITLE, searchMetadata, type NoResultsView } from "./_lib/search-page";

interface SearchPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** Always `noindex, follow`; canonical `/search?q=<q>` without facets. No DB access. */
export async function generateMetadata({ searchParams }: SearchPageProps): Promise<Metadata> {
  await connection();
  return searchMetadata(searchParams ? await searchParams : {});
}

/** One zero-results help Card: an `h3` and a wrapping chip row of links (the nav is named by the heading text). */
function LinkCard({ id, title, links }: { id: string; title: string; links: readonly PageLink[] }) {
  if (links.length === 0) return null;
  return (
    <Card as="section" aria-labelledby={id} padding="md" className="flex min-w-0 flex-col gap-3">
      <Heading level={3} size="h4" id={id}>
        {title}
      </Heading>
      <ChipRow label={title} items={links} layout="wrap" />
    </Card>
  );
}

function NoResults({ view }: { view: NoResultsView }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card tone="sunken" padding="lg" className="flex min-w-0 flex-col gap-3">
        <Heading level={2} size="h3">
          {NO_RESULTS_TITLE}
        </Heading>
        <Text>We could not find any products that match your search.</Text>
        {view.clearFiltersHref !== null ? (
          <Link variant="nav" href={view.clearFiltersHref}>
            Clear filters
          </Link>
        ) : null}
      </Card>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <Card as="section" aria-labelledby="search-tips" padding="md" className="flex min-w-0 flex-col gap-3">
          <Heading level={3} size="h4" id="search-tips">
            Search tips
          </Heading>
          <ul className="list-disc pl-6">
            {view.tips.map((tip) => (
              <li key={tip}>
                <Text>{tip}</Text>
              </li>
            ))}
          </ul>
        </Card>
        <LinkCard id="search-popular" title="Popular searches" links={view.popular} />
      </div>
      <LinkCard id="search-departments" title="Shop by department" links={view.departments} />
    </div>
  );
}

/**
 * /search (T105, v3 T168). The query is echoed only as text in the `<h1>`
 * (React escapes it) and in chip labels. No cookies, no writes; one `list()`
 * call feeds the template; the loader's single `now` goes to every card.
 */
export default async function SearchPage({ searchParams }: SearchPageProps) {
  await connection();
  const view = loadSearchPage(searchParams ? await searchParams : {});
  const now = view.now;

  return (
    <ListingTemplate
      title={view.title}
      breadcrumb={view.breadcrumb}
      params={view.params}
      facets={view.facets}
      result={view.result}
      sort={view.sort}
      base={view.base}
      labels={view.labels}
      showFilters={view.showFilters}
      relatedSearches={view.relatedSearches}
      promoSlots={view.promoSlots}
      feedback={view.feedback}
      addToCart={addToCart}
      cardProps={() => ({ now })}
      emptyState={view.noResults !== null ? <NoResults view={view.noResults} /> : undefined}
    >
      {view.didYouMean !== null ? (
        <Text>
          {"Did you mean "}
          <Link variant="inline" href={view.didYouMean.href}>
            {view.didYouMean.label}
          </Link>
          {"?"}
        </Text>
      ) : null}
    </ListingTemplate>
  );
}
