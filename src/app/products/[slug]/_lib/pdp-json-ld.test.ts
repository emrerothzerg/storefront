import { describe, expect, test } from "bun:test";
import { serializeJsonLd } from "@/components/molecules/JsonLd/JsonLd";
import type { ProductDetail, Review, ReviewSummary } from "@/lib/types";
import { JSON_LD_REVIEW_CAP, buildProductJsonLd } from "./pdp-json-ld";

const PRODUCT: ProductDetail = {
  id: "prod_x",
  slug: "x",
  name: "Thing X",
  description: "A thing.",
  priceCents: 1999,
  currency: "USD",
  imageUrl: "/x.svg",
  stock: 3,
  bullets: [],
  specs: [],
  images: [{ url: "/x.svg", alt: "" }, { url: "/x-2.svg", alt: "" }],
  listPriceCents: null,
  ratingCount: 0,
  ratingAvg: 0,
  brand: { id: "b", slug: "acme", name: "Acme", description: "" },
  category: null,
  publishedAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
  sku: "SKU-X",
};

const ZERO: ReviewSummary = { count: 0, avg: 0, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };

function review(n: number, body = `Body ${n}`): Review {
  return {
    id: `rev_${n}`,
    productId: "prod_x",
    displayName: `Person ${n}`,
    rating: 4,
    title: `Title ${n}`,
    body,
    verifiedPurchase: false,
    helpfulCount: 0,
    status: "published",
    createdAt: `2026-01-${String(10 + n).padStart(2, "0")}T10:00:00.000Z`,
    updatedAt: `2026-01-${String(10 + n).padStart(2, "0")}T10:00:00.000Z`,
  };
}

describe("buildProductJsonLd", () => {
  test("Product + Offer structure, price as 2-decimal string", () => {
    const ld = buildProductJsonLd({ product: PRODUCT, path: "/products/x", summary: ZERO, recentReviews: [] });
    expect(ld).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Thing X",
      description: "A thing.",
      sku: "SKU-X",
      brand: { "@type": "Brand", name: "Acme" },
      offers: { "@type": "Offer", price: "19.99", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    });
    expect(ld.image).toHaveLength(2);
    expect(ld.offers?.url).toMatch(/\/products\/x$/);
    expect(ld.url).toBe(ld.offers?.url ?? "");
  });

  test("0 reviews: no aggregateRating, no review", () => {
    const ld = buildProductJsonLd({ product: PRODUCT, path: "/products/x", summary: ZERO, recentReviews: [review(1)] });
    expect(ld).not.toHaveProperty("aggregateRating");
    expect(ld).not.toHaveProperty("review");
  });

  test("out of stock -> OutOfStock", () => {
    const ld = buildProductJsonLd({ product: { ...PRODUCT, stock: 0 }, path: "/products/x", summary: ZERO, recentReviews: [] });
    expect(ld.offers?.availability).toBe("https://schema.org/OutOfStock");
  });

  test("unsupported currency -> no offers", () => {
    const ld = buildProductJsonLd({ product: { ...PRODUCT, currency: "ABC" }, path: "/products/x", summary: ZERO, recentReviews: [] });
    expect(ld).not.toHaveProperty("offers");
  });

  test("reviews capped at 5, plain strings, aggregateRating from the summary; </script> escaped", () => {
    const hostile = "</script><script>alert(1)</script>";
    const reviews = [review(7, hostile), ...[6, 5, 4, 3, 2, 1].map((n) => review(n))];
    const summary: ReviewSummary = { count: 7, avg: 4, histogram: { 1: 0, 2: 0, 3: 0, 4: 7, 5: 0 } };
    const ld = buildProductJsonLd({ product: PRODUCT, path: "/products/x", summary, recentReviews: reviews });
    expect(ld.aggregateRating).toMatchObject({ ratingValue: 4, ratingCount: 7 });
    expect(ld.review).toHaveLength(JSON_LD_REVIEW_CAP);
    expect(ld.review?.[0]).toEqual({
      "@type": "Review",
      name: "Title 7",
      reviewBody: hostile,
      datePublished: "2026-01-17",
      author: { "@type": "Person", name: "Person 7" },
      reviewRating: { "@type": "Rating", ratingValue: 4, bestRating: 5, worstRating: 1 },
    });
    const text = serializeJsonLd(ld);
    expect(text).not.toContain("</script");
    expect(text).not.toContain("<");
    expect((JSON.parse(text) as { review: { reviewBody: string }[] }).review[0]?.reviewBody).toBe(hostile);
  });

  test("hidden reviews and reviews without a date are skipped", () => {
    const summary: ReviewSummary = { count: 2, avg: 4, histogram: { 1: 0, 2: 0, 3: 0, 4: 2, 5: 0 } };
    const ld = buildProductJsonLd({
      product: PRODUCT,
      path: "/products/x",
      summary,
      recentReviews: [{ ...review(1), status: "hidden" }, { ...review(2), createdAt: "bad" }],
    });
    expect(ld).not.toHaveProperty("review");
  });
});
