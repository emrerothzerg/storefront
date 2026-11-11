import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import { JsonLd } from "@/components/molecules/JsonLd";
import { CategoryRail } from "@/components/organisms/CategoryGrid";
import { ProductRail } from "@/components/organisms/ProductRail";
import { ListingTemplate } from "@/components/templates/ListingTemplate";
import { addToCart } from "@/app/actions/cart";
import { listingCardProps } from "@/app/_listing/listing-page";

import { categoryMetadata, emptyCategoryTitle, loadCategoryPage, topSellersTitle } from "./_lib/category-page";

/** Empty category state: always a way out to the full catalogue (CONTRACTS L-22). */
const ALL_PRODUCTS_HREF = "/products";

interface CategoryPageProps {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** Canonical: page 1 -> base, page N -> itself, faceted -> page-1 base + `noindex, follow`. */
export async function generateMetadata({ params, searchParams }: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params;
  await connection();
  return categoryMetadata(slug, searchParams ? await searchParams : {});
}

/**
 * /category/[slug] (T106). Unknown slug -> 404. Hero text, subcategory tiles
 * and the top sellers rail are omitted when empty. No cookies, no writes.
 * v3 (T167): sibling-category chips, subcategories as a `CategoryRail` of
 * circle tiles, one `now` per card, quick add, promo tiles, feedback block.
 */
export default async function CategoryPage({ params, searchParams }: CategoryPageProps) {
  const { slug } = await params;
  await connection();
  const loaded = loadCategoryPage(slug, searchParams ? await searchParams : {});
  if (!loaded.found) notFound();
  const view = loaded.view;

  const emptyState =
    view.emptySiblings === null ? undefined : (
      <div className="flex min-w-0 flex-col items-center gap-2 rounded-lg bg-surface-sunken p-8 text-center">
        <Heading level={2} size="h3">
          {emptyCategoryTitle(view.title)}
        </Heading>
        {view.emptySiblings.length > 0 ? (
          <>
            <Text>{view.isDepartment ? "Try another department:" : "Try a related category:"}</Text>
            <ul role="list" className="flex flex-wrap justify-center gap-x-4">
              {view.emptySiblings.map((link) => (
                <li key={link.href}>
                  <Link variant="nav" href={link.href}>
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <Link variant="nav" href={ALL_PRODUCTS_HREF}>
          Browse all products
        </Link>
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
        showCategoryFacet={view.showCategoryFacet}
        emptyState={emptyState}
        relatedSearches={view.relatedSearches}
        relatedSearchesLabel="Related categories"
        cardProps={listingCardProps(view.now)}
        addToCart={addToCart}
        cardVariant="default"
        promoSlots={view.promoSlots}
        feedback={view.feedback}
      >
        {view.description.trim() !== "" ? <Text tone="secondary">{view.description}</Text> : null}
        {view.subcategories.length > 0 ? (
          <CategoryRail categories={view.subcategories} title={`Shop ${view.title}`} id="category-subcategories" />
        ) : null}
        {view.topSellers.length > 0 ? (
          <ProductRail
            id="category-top-sellers"
            title={topSellersTitle(view.title)}
            products={view.topSellers}
            now={view.now}
          />
        ) : null}
      </ListingTemplate>
      <JsonLd data={view.jsonLd} />
    </>
  );
}
