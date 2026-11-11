import type { Metadata } from "next";
import { connection } from "next/server";

import { Heading, Text } from "@/components/atoms/Typography";
import { Link } from "@/components/atoms/Link";
import { JsonLd } from "@/components/molecules/JsonLd";
import { ListingTemplate, positionRankCardProps } from "@/components/templates/ListingTemplate";
import { addToCart } from "@/app/actions/cart";
import {
  collectionMetadata,
  listingCardProps,
  loadCollectionPage,
  NO_DEALS_TEXT,
  NO_DEALS_TITLE,
} from "@/app/_listing/listing-page";

interface CollectionPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** Canonical from the shared parser; faceted or re-sorted URLs are `noindex, follow`. No DB access. */
export async function generateMetadata({ searchParams }: CollectionPageProps): Promise<Metadata> {
  await connection();
  return collectionMetadata("new-arrivals", searchParams ? await searchParams : {});
}

/**
 * /new-arrivals (T107): thin page over the shared listing loader. One `list()`
 * call feeds the template's `params` and `facets`; no cookies, no writes.
 * v3 (T167): one `now` from the loader reaches every card (`cardProps`),
 * quick add posts to the cart action, promo tiles and the feedback block
 * come from the loader; no related chips on collections.
 */
export default async function NewArrivalsPage({ searchParams }: CollectionPageProps) {
  await connection();
  const view = loadCollectionPage("new-arrivals", searchParams ? await searchParams : {});
  const emptyState =
    view.noDealsLinks === null ? undefined : (
      <div className="flex min-w-0 flex-col items-center gap-2 rounded-lg bg-surface-sunken p-8 text-center">
        <Heading level={2} size="h3">
          {NO_DEALS_TITLE}
        </Heading>
        <Text>{NO_DEALS_TEXT}</Text>
        <ul role="list" className="flex flex-wrap justify-center gap-x-4">
          {view.noDealsLinks.map((link) => (
            <li key={link.href}>
              <Link variant="nav" href={link.href}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <>
      {view.rel.prev !== undefined ? <link rel="prev" href={view.rel.prev} /> : null}
      {view.rel.next !== undefined ? <link rel="next" href={view.rel.next} /> : null}
      <ListingTemplate
        title={view.title}
        breadcrumb={view.breadcrumb}
        params={view.params}
        facets={view.facets}
        result={view.result}
        sort={view.sort}
        {...(view.defaultSort !== undefined ? { defaultSort: view.defaultSort } : {})}
        base={view.base}
        labels={view.labels}
        emptyState={emptyState}
        cardProps={listingCardProps(
          view.now,
          view.ranked ? positionRankCardProps(view.result.page, view.result.pageSize) : undefined,
        )}
        addToCart={addToCart}
        cardVariant="default"
        promoSlots={view.promoSlots}
        feedback={view.feedback}
      />
      <JsonLd data={view.jsonLd} />
    </>
  );
}
