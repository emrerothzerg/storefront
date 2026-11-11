import type { Database } from "bun:sqlite";
import type { Brand, BrandWithCount } from "@/lib/types";

/** Brand access (server-only). Synchronous, bound parameters only. */
export interface BrandRepository {
  /** All brands ordered by name. */
  list(): Brand[];
  /**
   * All brands with their PUBLISHED product counts at `now`, ordered by name.
   * "Published" = `published_at <> '' AND published_at <= now` (the
   * `filterPublishedIds` rule). `now` is epoch ms like the listing service;
   * omitted or invalid → the current time. Brands with 0 published products
   * are still listed (count 0).
   */
  listWithCounts(now?: number): BrandWithCount[];
  /** `null` when no brand has this slug. */
  getBySlug(slug: string): Brand | null;
  /** `null` when no brand has this id. */
  getById(id: string): Brand | null;
}

/** Shape of a `brands` row as selected here. Internal. */
export interface BrandRow {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export const BRAND_COLUMNS = "id, slug, name, description";

export function toBrand(row: BrandRow): Brand {
  return { id: row.id, slug: row.slug, name: row.name, description: row.description };
}

/** Largest |epoch ms| a JS Date accepts. */
const MAX_DATE_MS = 8.64e15;

/** ISO cut-off for the publication check; invalid `now` falls back to the clock. */
function publicationCutoff(now: number | undefined): string {
  const ms = typeof now === "number" && Number.isFinite(now) && Math.abs(now) <= MAX_DATE_MS ? now : Date.now();
  return new Date(ms).toISOString();
}

/** Sitemap lastmod source for `/brand/<slug>` (CONS-B4 bm); kept off `BrandRepository` so fakes stay valid. */
export interface BrandSlugLister {
  /** Every brand's slug and `updated_at`, ordered by slug. */
  listSlugsWithUpdatedAt(): { slug: string; updatedAt: string }[];
}

export class SqliteBrandRepository implements BrandRepository, BrandSlugLister {
  constructor(private readonly db: Database) {}

  list(): Brand[] {
    return this.db
      .query<BrandRow, []>(`SELECT ${BRAND_COLUMNS} FROM brands ORDER BY name, id`)
      .all()
      .map(toBrand);
  }

  listWithCounts(now?: number): BrandWithCount[] {
    return this.db
      .query<BrandRow & { product_count: number }, [string]>(
        `SELECT b.id, b.slug, b.name, b.description,
                (SELECT COUNT(*) FROM products AS p
                  WHERE p.brand_id = b.id AND p.published_at <> '' AND p.published_at <= ?1) AS product_count
           FROM brands AS b ORDER BY b.name, b.id`,
      )
      .all(publicationCutoff(now))
      .map((row) => ({ ...toBrand(row), productCount: row.product_count }));
  }

  getBySlug(slug: string): Brand | null {
    const row = this.db
      .query<BrandRow, [string]>(`SELECT ${BRAND_COLUMNS} FROM brands WHERE slug = ?`)
      .get(slug);
    return row === null ? null : toBrand(row);
  }

  getById(id: string): Brand | null {
    const row = this.db
      .query<BrandRow, [string]>(`SELECT ${BRAND_COLUMNS} FROM brands WHERE id = ?`)
      .get(id);
    return row === null ? null : toBrand(row);
  }

  listSlugsWithUpdatedAt(): { slug: string; updatedAt: string }[] {
    return this.db
      .query<{ slug: string; updated_at: string }, []>("SELECT slug, updated_at FROM brands ORDER BY slug")
      .all()
      .map((row) => ({ slug: row.slug, updatedAt: row.updated_at }));
  }
}
