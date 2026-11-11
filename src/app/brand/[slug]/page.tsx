import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import { JsonLd } from "@/components/molecules/JsonLd";
import { ListingTemplate } from "@/components/templates/ListingTemplate";
import { addToCart } from "@/app/actions/cart";
import { listingCardProps } from "@/app/_listing/listing-page";

import { brandMetadata, emptyBrandTitle, loadBrandPage } from "./_lib/brand-page";

interface BrandPageProps {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params, searchParams }: BrandPageProps): Promise<Metadata> {
  const { slug } = await params;
  await connection();
  return brandMetadata(slug, searchParams ? await searchParams : {});
}

/**
 * /brand/[slug] (T106). Unknown slug -> 404; brand name is the `<h1>`. No cookies, no writes.
 * v3 (T167): other-brand chips, one `now` per card, quick add, promo tiles, feedback block.
 */
export default async function BrandPage({ params, searchParams }: BrandPageProps) {
  const { slug } = await params;
  await connection();
  const loaded = loadBrandPage(slug, searchParams ? await searchParams : {});
  if (!loaded.found) notFound();
  const view = loaded.view;

  const emptyState =
    view.emptyLinks === null ? undefined : (
      <div className="flex min-w-0 flex-col items-center gap-2 rounded-lg bg-surface-sunken p-8 text-center">
        <Heading level={2} size="h3">
          {emptyBrandTitle(view.title)}
        </Heading>
        <ul role="list" className="flex flex-wrap justify-center gap-x-4">
          {view.emptyLinks.map((link) => (
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
        base={view.base}
        labels={view.labels}
        showCategoryFacet
        emptyState={emptyState}
        relatedSearches={view.relatedSearches}
        relatedSearchesLabel="More brands"
        cardProps={listingCardProps(view.now)}
        addToCart={addToCart}
        cardVariant="default"
        promoSlots={view.promoSlots}
        feedback={view.feedback}
      >
        {view.description.trim() !== "" ? <Text tone="secondary">{view.description}</Text> : null}
      </ListingTemplate>
      <JsonLd data={view.jsonLd} />
    </>
  );
}
