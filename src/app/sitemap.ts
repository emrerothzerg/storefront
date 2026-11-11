import type { MetadataRoute } from "next";
import { connection } from "next/server";

import { HELP_TOPIC_SLUGS } from "@/content/help-topics";
import { buildSiteSitemap } from "@/lib/seo/sitemap";
import { SqliteBrandRepository } from "@/server/catalog/brand-repository";
import { SqliteCategoryRepository } from "@/server/catalog/category-repository";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { getDatabase } from "@/server/db/client";

/**
 * /sitemap.xml: every public indexable route once (policy table in
 * `src/lib/seo/routes.ts`), every category (both levels) and brand, the help
 * topics and every product PUBLISHED now. `lastModified` is each row's
 * `updated_at` (`listPublishedSlugsWithUpdatedAt(nowIso)` for products,
 * `listSlugsWithUpdatedAt()` for categories and brands): one query each.
 *
 * `connection()` runs before any DB access, so the route is rendered per
 * request and `next build` never opens the database. Repository errors are
 * not caught: a 500 is better than a sitemap that silently drops pages.
 * One file only: the catalogue cannot reach 50,000 URLs (src/lib/seo/README.md).
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();
  const db = getDatabase();
  return buildSiteSitemap({
    products: new SqliteProductRepository(db).listPublishedSlugsWithUpdatedAt(new Date().toISOString()),
    categories: new SqliteCategoryRepository(db).listSlugsWithUpdatedAt(),
    brands: new SqliteBrandRepository(db).listSlugsWithUpdatedAt(),
    helpTopics: HELP_TOPIC_SLUGS.map((slug) => ({ slug })),
  });
}
