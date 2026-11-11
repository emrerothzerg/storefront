import type { Metadata } from "next";
import { connection } from "next/server";

import { JsonLd } from "@/components/molecules/JsonLd";
import { ListingTemplate } from "@/components/templates/ListingTemplate";
import { addToCart } from "@/app/actions/cart";
import { collectionMetadata, listingCardProps, loadCollectionPage } from "@/app/_listing/listing-page";

interface CollectionPageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** Canonical from the shared parser; faceted or re-sorted URLs are `noindex, follow`. No DB access. */
export async function generateMetadata({ searchParams }: CollectionPageProps): Promise<Metadata> {
  await connection();
  return collectionMetadata("top-rated", searchParams ? await searchParams : {});
}

/**
 * /top-rated (CONS-B1): thin page over the shared listing loader, default
 * sort `rating` (highest average rating first). One `list()` call feeds the
 * template's `params` and `facets`; no cookies, no writes. Indexable with a
 * canonical; ItemList + BreadcrumbList JSON-LD like the other collections.
 * v3 (T167): one `now` per card, quick add, promo tiles and feedback block.
 */
export default async function TopRatedPage({ searchParams }: CollectionPageProps) {
  await connection();
  const view = loadCollectionPage("top-rated", searchParams ? await searchParams : {});

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
        cardProps={listingCardProps(view.now)}
        addToCart={addToCart}
        cardVariant="default"
        promoSlots={view.promoSlots}
        feedback={view.feedback}
      />
      <JsonLd data={view.jsonLd} />
    </>
  );
}
