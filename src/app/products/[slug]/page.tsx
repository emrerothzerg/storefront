import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { addManyToCart, addToCart, buyNow } from "@/app/actions/cart";
import { addToList, removeFromList } from "@/app/actions/lists";
import { answerQuestion, askQuestion, voteAnswer, voteQuestion } from "@/app/actions/questions";
import { submitReview, voteReviewHelpful } from "@/app/actions/reviews";
import { subscribeStockAlert, unsubscribeStockAlert } from "@/app/actions/stock-alerts";
import { recordProductView } from "@/app/actions/views";
import { Badge } from "@/components/atoms/Badge";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Rating } from "@/components/atoms/Rating";
import { Table, TableBody, TableCell, TableHeaderCell, TableRow } from "@/components/atoms/Table";
import { Heading, Text } from "@/components/atoms/Typography";
import { ImageGallery } from "@/components/molecules/ImageGallery";
import { JsonLd } from "@/components/molecules/JsonLd";
import { BuyBox } from "@/components/organisms/BuyBox";
import { FrequentlyBoughtTogether } from "@/components/organisms/FrequentlyBoughtTogether";
import { ProductRail } from "@/components/organisms/ProductRail";
import { QASection } from "@/components/organisms/QASection";
import { ReviewsSection } from "@/components/organisms/ReviewsSection";
import { ViewTracker } from "@/components/organisms/ViewTracker";
import { breadcrumbListJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { readCurrentUser } from "@/server/session/current-user";
import { readSessionId } from "@/server/session/session";

import { loadPdp, loadPublishedProduct } from "./_lib/pdp-data";
import { buildPdpDescription } from "./_lib/pdp-meta";
import { buildProductJsonLd } from "./_lib/pdp-json-ld";
import type { RawSearchParams } from "./_lib/pdp-params";
import { breadcrumbItems, infoRows, pdpBadges, ratingLinkText, safeHref } from "./_lib/pdp-view";
import { productTitle } from "./_lib/product-detail";

interface ProductPageProps {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<RawSearchParams>;
}

/**
 * Metadata ignores the query string (criterion 7): canonical is always
 * `/products/<slug>`, `?img=`/review/Q&A params change neither it nor the title.
 * No session access and no writes here.
 */
export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params;
  // The DB read is synchronous; keep it out of any prerender (SPIKE-NOTES finding 2).
  await connection();
  const product = loadPublishedProduct(slug);
  if (!product) {
    // The page itself 404s; keep the metadata generic and out of the index.
    return buildMetadata({
      title: productTitle(null),
      description: "This product does not exist or is no longer available.",
      noindex: true,
    });
  }
  return buildMetadata({
    title: productTitle(product),
    // 70-160 chars from catalog copy (+ brand, category, price when the description is short).
    description: buildPdpDescription(product),
    path: `/products/${product.slug}`,
    image: { url: product.imageUrl, alt: product.name },
  });
}

/**
 * Product detail page v3 (T169; T97 v2 behaviour unchanged).
 *
 * REFERENCE PENDING: no PDP screenshot was supplied (BACKLOG-phase3 section
 * 1c, open question 1). The layout follows the listing reference's style
 * family and may get a rework pass when the reference arrives; no code
 * depends on this layout being final.
 *
 * Structure: breadcrumb -> `<article>` (one column below `lg`: gallery, then
 * title block, then buy box; from `lg` two columns: gallery 7/12 left, title
 * block + sticky BuyBox 5/12 right) -> "About this item" / description and
 * specifications / product information Cards -> Frequently bought together ->
 * reviews (`#reviews`, `#write-review`) -> questions (`#questions`) -> rails
 * (related, also bought, also viewed, recently viewed; compact cards with
 * quick add) -> ViewTracker + one JSON-LD script.
 *
 * Data comes from one loader call; the session cookie is read once with the
 * read-only `readSessionId()` and the signed-in user with the read-only
 * `readCurrentUser()` (neither mints a cookie; only `displayName` is passed
 * on). The clock is read once, in the loader (`data.now`), and passed down
 * (FIX-card-now). Sections without data are omitted; the product name is the
 * only h1.
 */
export default async function ProductPage({ params, searchParams }: ProductPageProps) {
  const { slug } = await params;
  await connection();
  const query = searchParams ? await searchParams : {};
  const [sessionId, currentUser] = await Promise.all([readSessionId(), readCurrentUser()]);
  const signedInName = currentUser === null ? null : currentUser.displayName;
  const result = await loadPdp({ slug, searchParams: query, sessionId });
  if (!result.found) notFound();

  const data = result.data;
  const { product, path, viewer, rails } = data;
  const now = new Date(data.now);
  const brandHref = safeHref(data.brandHref);
  const rankHref = data.bestSellerRank === null ? null : safeHref(data.bestSellerRank.categoryHref);
  const info = infoRows(product);
  const ratingCount = data.reviews.summary.count;
  const badges = pdpBadges(product, now);
  const quickAdd = { action: addToCart };

  const paragraphs = product.description
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const hasAbout = product.bullets.length > 0 || paragraphs.length > 0;
  const hasDetails = product.specs.length > 0 || info.length > 0;

  return (
    <>
      <div className="flex min-w-0 flex-col gap-8">
        <Breadcrumb items={breadcrumbItems(data.breadcrumb)} />

        <article className="grid min-w-0 gap-6 lg:grid-cols-12 lg:gap-8">
          <div className="min-w-0 lg:col-span-7">
            <ImageGallery
              images={product.images}
              productName={product.name}
              initialIndex={data.params.img}
              basePath={path}
            />
          </div>

          {/* A block (not flex) column: it stretches to the row height, so the sticky BuyBox has room to stick. */}
          <div className="min-w-0 space-y-6 lg:col-span-5">
            <div className="flex min-w-0 flex-col items-start gap-2" data-testid="pdp-title-block">
              {/* h1 in the outline, h2-scale visually (h1 size from md): a 5/12 column cannot fit a display-size name (U09). */}
              <Heading level={1} size="h2" className="text-balance break-words md:text-h1" data-testid="pdp-title">
                {product.name}
              </Heading>
              {product.brand !== null && brandHref !== null ? (
                <Link href={brandHref} variant="inline" className="inline-flex min-h-touch items-center">
                  {`Visit the ${product.brand.name} store`}
                </Link>
              ) : null}
              {ratingCount > 0 ? (
                <Link href="#reviews" variant="subtle" aria-label={ratingLinkText(data.reviews.summary.avg, ratingCount)}>
                  <Rating value={data.reviews.summary.avg} count={ratingCount} variant="compact" />
                </Link>
              ) : null}
              {badges.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2" data-testid="pdp-badges">
                  {badges.map((badge) => (
                    <Badge key={badge.key} tone={badge.tone} emphasis={badge.emphasis} shape="pill" size="md">
                      {badge.label}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {data.boughtLastMonth !== null ? (
                <Text variant="small" tone="secondary">{`${data.boughtLastMonth}+ bought in past month`}</Text>
              ) : null}
              {data.bestSellerRank !== null ? (
                <Text variant="small">
                  {`Best Sellers Rank: #${data.bestSellerRank.rank} in `}
                  {rankHref !== null ? (
                    <Link href={rankHref} variant="inline">
                      {data.bestSellerRank.categoryName}
                    </Link>
                  ) : (
                    data.bestSellerRank.categoryName
                  )}
                </Text>
              ) : null}
            </div>

            <BuyBox
              product={product}
              actions={{ addToCart, buyNow, addToList, removeFromList, subscribeStockAlert, unsubscribeStockAlert }}
              viewer={{
                inWishlist: viewer.inWishlist,
                wishlistId: viewer.wishlistId,
                lists: viewer.lists,
                alertRegistered: viewer.alertRegistered,
                alertId: viewer.alertId,
              }}
              delivery={data.delivery}
              promotedCoupon={data.promotedCoupon}
              shareUrl={path}
              sticky
            />
          </div>
        </article>

        {hasAbout || hasDetails ? (
          <div className="grid min-w-0 gap-6 lg:grid-cols-12">
            {hasAbout ? (
              <div className={`flex min-w-0 flex-col gap-6 ${hasDetails ? "lg:col-span-7" : "lg:col-span-12"}`}>
                {product.bullets.length > 0 ? (
                  <Card as="section" aria-labelledby="about-heading" className="flex min-w-0 flex-col gap-3">
                    <Heading level={2} id="about-heading">
                      About this item
                    </Heading>
                    <ul className="flex list-disc flex-col gap-1 ps-5 text-body text-text-primary">
                      {product.bullets.map((bullet, i) => (
                        <li key={i} className="break-words">
                          {bullet}
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}
                {paragraphs.length > 0 ? (
                  <Card as="section" aria-labelledby="description-heading" className="flex min-w-0 flex-col gap-3">
                    <Heading level={2} id="description-heading">
                      Product description
                    </Heading>
                    {paragraphs.map((paragraph, i) => (
                      <Text key={i} className="break-words">
                        {paragraph}
                      </Text>
                    ))}
                  </Card>
                ) : null}
              </div>
            ) : null}

            {hasDetails ? (
              <div className={`flex min-w-0 flex-col gap-6 ${hasAbout ? "lg:col-span-5" : "lg:col-span-12"}`}>
                {product.specs.length > 0 ? (
                  <Card as="section" aria-labelledby="specs-heading" className="flex min-w-0 flex-col gap-3">
                    <Heading level={2} id="specs-heading">
                      Specifications
                    </Heading>
                    <Table label="Specifications table" density="compact" striped>
                      <TableBody>
                        {product.specs.map((spec, i) => (
                          <TableRow key={i}>
                            <TableHeaderCell scope="row">{spec.label}</TableHeaderCell>
                            <TableCell>{spec.value}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                ) : null}
                {info.length > 0 ? (
                  <Card as="section" aria-labelledby="info-heading" className="flex min-w-0 flex-col gap-3">
                    <Heading level={2} id="info-heading">
                      Product information
                    </Heading>
                    <Table label="Product information table" density="compact">
                      <TableBody>
                        {info.map((row) => (
                          <TableRow key={row.label}>
                            <TableHeaderCell scope="row">{row.label}</TableHeaderCell>
                            <TableCell>{row.value}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Card>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {data.bundle !== null ? <FrequentlyBoughtTogether bundle={data.bundle} action={addManyToCart} /> : null}

        <ReviewsSection
          productId={product.id}
          productSlug={product.slug}
          basePath={path}
          list={data.reviews}
          query={{
            sort: data.params.reviews.sort,
            ...(data.params.reviews.stars !== undefined ? { stars: data.params.reviews.stars } : {}),
            verifiedOnly: data.params.reviews.verifiedOnly,
          }}
          actions={{ submitReview, voteReviewHelpful }}
          viewer={{ signedInName, alreadyReviewed: viewer.alreadyReviewed }}
        />

        <QASection
          productId={product.id}
          productSlug={product.slug}
          basePath={path}
          list={data.qa}
          actions={{ askQuestion, answerQuestion, voteQuestion, voteAnswer }}
          viewer={{ signedInName }}
          extraParams={data.qaExtraParams}
        />

        <ProductRail id="rail-related" title="Related products" products={rails.related} quickAdd={quickAdd} now={now} />
        <ProductRail
          id="rail-also-bought"
          title="Customers who bought this also bought"
          products={rails.alsoBought}
          quickAdd={quickAdd}
          now={now}
        />
        <ProductRail
          id="rail-also-viewed"
          title="Customers also viewed"
          products={rails.alsoViewed}
          quickAdd={quickAdd}
          now={now}
        />
        {viewer.hasSession ? (
          <ProductRail
            id="rail-recently-viewed"
            title="Your recently viewed items"
            products={rails.recentlyViewed}
            quickAdd={quickAdd}
            now={now}
          />
        ) : null}
      </div>

      <ViewTracker
        productId={product.id}
        productSlug={product.slug}
        recorded={data.viewRecorded}
        recordView={recordProductView}
      />
      {/* One script holding both graphs (P2-S contract; tests/app/seo-metadata.qa.test.tsx C6). */}
      <JsonLd
        data={[
          buildProductJsonLd({
            product,
            path,
            summary: data.reviews.summary,
            recentReviews: data.recentReviews,
          }),
          breadcrumbListJsonLd(data.breadcrumb.map((c) => ({ name: c.label, path: c.href ?? path }))),
        ]}
      />
    </>
  );
}
