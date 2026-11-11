import type { Product } from "@/lib/types";
import {
  SqliteProductRepository,
  type ProductRepository,
} from "@/server/catalog/product-repository";
import { getDatabase } from "@/server/db/client";

/** Longest slug the route accepts; anything longer is rejected before a query. */
export const MAX_SLUG_LENGTH = 128;

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Lower-case kebab-case, 1-128 chars. Anything else can never match a product. */
export function isValidSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(value)
  );
}

/**
 * The product for `slug`, or `null` when the slug is malformed (no query is
 * made) or unknown. `repo` is injectable for tests; the default opens the app DB.
 */
export function loadProduct(
  slug: string,
  repo: Pick<ProductRepository, "getBySlug"> = new SqliteProductRepository(getDatabase()),
): Product | null {
  if (!isValidSlug(slug)) return null;
  return repo.getBySlug(slug);
}

/** Document title for the detail page. */
export function productTitle(product: Pick<Product, "name"> | null): string {
  return product?.name ?? "Product not found";
}
