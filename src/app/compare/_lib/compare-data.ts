import { COMPARE_MAX } from "@/components/molecules/CompareToggle/compare-path";
import type { ProductDetail } from "@/lib/types";
import { SqliteProductRepository, type PublishedProductReader } from "@/server/catalog/product-repository";
import { getDatabase } from "@/server/db/client";

import { parseCompareParams } from "./compare-params";

/** Read-only catalog access the compare page needs (one SELECT per candidate; shared publication rule). */
export type CompareProductSource = PublishedProductReader;

export interface CompareLoadOptions {
  /** Defaults to the shared app database's product repository (opened lazily). */
  readonly products?: CompareProductSource;
  /** Epoch ms used for the publication check. Defaults to `Date.now()`. */
  readonly now?: number;
}

export interface CompareData {
  /** Published products in URL order, deduped, at most 4. */
  readonly products: readonly ProductDetail[];
  /** Slugs of `products`, in the same order: the only slugs Remove/toggle links may carry. */
  readonly slugs: readonly string[];
  readonly differencesOnly: boolean;
  /** Something requested was dropped: malformed, unknown or unpublished. Drives a notice; never echoes the values. */
  readonly unavailable: boolean;
  /** More than 4 usable selections were requested; only the first 4 are shown. */
  readonly capped: boolean;
}

/**
 * Resolves the compare selection (T100). Stateless and read-only: no session,
 * no cookies, no writes. Unknown or unpublished slugs are dropped, then the
 * first 4 survivors are kept in URL order. The database is not touched when
 * no slug-shaped value is present.
 */
export function loadCompare(searchParams: unknown, options: CompareLoadOptions = {}): CompareData {
  const { candidates, differencesOnly, rejected, overflow } = parseCompareParams(searchParams);
  if (candidates.length === 0) {
    return { products: [], slugs: [], differencesOnly, unavailable: rejected, capped: false };
  }

  const now = options.now ?? Date.now();
  const repo = options.products ?? new SqliteProductRepository(getDatabase());
  const products: ProductDetail[] = [];
  let missing = false;
  let looked = 0;
  for (const slug of candidates) {
    if (products.length >= COMPARE_MAX) break;
    looked += 1;
    const product = repo.getPublishedDetailBySlug(slug, now);
    if (product === null || product.slug !== slug) {
      missing = true;
      continue;
    }
    if (products.some((p) => p.id === product.id)) continue;
    products.push(product);
  }
  const leftOver = looked < candidates.length || overflow;
  return {
    products,
    slugs: products.map((p) => p.slug),
    differencesOnly,
    unavailable: rejected || missing,
    capped: products.length >= COMPARE_MAX && leftOver,
  };
}
