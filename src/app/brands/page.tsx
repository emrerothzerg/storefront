import type { Metadata } from "next";
import { connection } from "next/server";

import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Heading, Text } from "@/components/atoms/Typography";
import { JsonLd } from "@/components/molecules/JsonLd";

import {
  BRANDS_GRID_HEADING,
  BRANDS_GRID_HEADING_ID,
  brandCountLabel,
  brandTotalLabel,
  brandsMetadata,
  loadBrandsPage,
} from "./_lib/brands-page";

export function generateMetadata(): Metadata {
  return brandsMetadata();
}

/**
 * /brands (T106): brand index with product counts. No cookies, no writes.
 * T177 (U05): one section, labelled by its h2, holding a responsive grid of
 * brand tiles (name + "N products"; 2 columns, 3 from md, 4 from lg) in
 * alphabetical order ("#" names last). The brand name link stretches over its
 * tile, so the whole tile is clickable while the link name stays the brand.
 */
export default async function BrandsPage() {
  await connection();
  const view = loadBrandsPage();

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={[...view.breadcrumb]} />
      <Heading level={1}>{view.title}</Heading>
      {view.brands.length === 0 ? (
        <Notice tone="info" title="No brands yet">
          <Link variant="inline" href="/products">
            Browse all products
          </Link>
        </Notice>
      ) : (
        <section aria-labelledby={BRANDS_GRID_HEADING_ID} className="flex min-w-0 flex-col gap-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <Heading level={2} size="h4" id={BRANDS_GRID_HEADING_ID}>
              {BRANDS_GRID_HEADING}
            </Heading>
            <Text as="span" variant="small" tone="secondary">
              {brandTotalLabel(view.brands.length)}
            </Text>
          </div>
          <ul role="list" className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-4">
            {view.brands.map((brand) => (
              <Card
                as="li"
                key={brand.slug}
                padding="sm"
                interactive
                className="relative flex min-w-0 flex-col gap-1"
                data-testid="brand-tile"
              >
                <Link
                  variant="nav"
                  href={brand.href}
                  className="min-w-0 font-semibold break-words after:absolute after:inset-0 after:z-raised after:rounded-lg"
                >
                  {brand.name}
                </Link>
                <Text as="span" variant="small" tone="secondary">
                  {brandCountLabel(brand.productCount)}
                </Text>
              </Card>
            ))}
          </ul>
        </section>
      )}
      <JsonLd data={view.jsonLd} />
    </div>
  );
}
