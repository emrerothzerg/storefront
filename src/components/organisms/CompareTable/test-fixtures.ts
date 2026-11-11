import type { ProductDetail, ProductSpec } from "@/lib/types";

/** Test-only ProductDetail factory for CompareTable tests. */
export function makeDetail(
  n: number,
  overrides: Partial<ProductDetail> = {},
  specs: readonly ProductSpec[] = [],
): ProductDetail {
  return {
    id: `p${n}`,
    slug: `product-${n}`,
    name: `Product ${n}`,
    description: "",
    priceCents: 1000 + n,
    currency: "USD",
    imageUrl: `/images/p${n}.svg`,
    stock: 20,
    bullets: [],
    specs,
    images: [{ url: `/images/p${n}.svg`, alt: `Product ${n}` }],
    listPriceCents: null,
    ratingCount: 0,
    ratingAvg: 0,
    brand: null,
    category: null,
    publishedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
