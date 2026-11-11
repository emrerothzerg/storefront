import type { Database } from "bun:sqlite";
import type { Category, CategoryWithCount } from "@/lib/types";

/**
 * Category taxonomy access (server-only). Two levels: departments
 * (`parentId === null`) and their categories. Synchronous, bound parameters
 * only, returns domain objects (never raw rows).
 */
export interface CategoryRepository {
  /** Top-level categories ordered by sort_order, then name. */
  listDepartments(): Category[];
  /** Direct children of `parentId`, ordered by sort_order, then name; `[]` when none. */
  listChildren(parentId: string): Category[];
  /** `null` when no category has this slug. */
  getBySlug(slug: string): Category | null;
  /** `null` when no category has this id. */
  getById(id: string): Category | null;
  /**
   * Breadcrumb path for a category: `[department, category]`, or
   * `[department]` for a department; `[]` for an unknown id.
   */
  getPath(categoryId: string): Category[];
  /**
   * Every category with its product count, departments first (each followed
   * by its children), ordered by sort_order then name. A department's count
   * includes its children's products.
   */
  listAllWithCounts(): CategoryWithCount[];
}

/** Shape of a `categories` row as selected here. Internal. */
export interface CategoryRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  parent_id: string | null;
  sort_order: number;
  image_url: string | null;
}

export const CATEGORY_COLUMNS = "id, slug, name, description, parent_id, sort_order, image_url";

export function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    imageUrl: row.image_url,
  };
}

interface CountedRow extends CategoryRow {
  direct_count: number;
}

/** Sitemap lastmod source for `/category/<slug>` (CONS-B4 bm); kept off `CategoryRepository` so fakes stay valid. */
export interface CategorySlugLister {
  /** Every category's (departments and children) slug and `updated_at`, ordered by slug. */
  listSlugsWithUpdatedAt(): { slug: string; updatedAt: string }[];
}

export class SqliteCategoryRepository implements CategoryRepository, CategorySlugLister {
  constructor(private readonly db: Database) {}

  listDepartments(): Category[] {
    return this.db
      .query<CategoryRow, []>(
        `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE parent_id IS NULL ORDER BY sort_order, name, id`,
      )
      .all()
      .map(toCategory);
  }

  listChildren(parentId: string): Category[] {
    return this.db
      .query<CategoryRow, [string]>(
        `SELECT ${CATEGORY_COLUMNS} FROM categories WHERE parent_id = ? ORDER BY sort_order, name, id`,
      )
      .all(parentId)
      .map(toCategory);
  }

  getBySlug(slug: string): Category | null {
    const row = this.db
      .query<CategoryRow, [string]>(`SELECT ${CATEGORY_COLUMNS} FROM categories WHERE slug = ?`)
      .get(slug);
    return row === null ? null : toCategory(row);
  }

  getById(id: string): Category | null {
    const row = this.db
      .query<CategoryRow, [string]>(`SELECT ${CATEGORY_COLUMNS} FROM categories WHERE id = ?`)
      .get(id);
    return row === null ? null : toCategory(row);
  }

  getPath(categoryId: string): Category[] {
    const leaf = this.getById(categoryId);
    if (leaf === null) return [];
    if (leaf.parentId === null) return [leaf];
    const parent = this.getById(leaf.parentId);
    return parent === null ? [leaf] : [parent, leaf];
  }

  listAllWithCounts(): CategoryWithCount[] {
    const rows = this.db
      .query<CountedRow, []>(
        `SELECT ${CATEGORY_COLUMNS.split(", ").map((c) => `c.${c}`).join(", ")},
                (SELECT COUNT(*) FROM products AS p WHERE p.category_id = c.id) AS direct_count
           FROM categories AS c
          ORDER BY c.sort_order, c.name, c.id`,
      )
      .all();
    const childrenOf = new Map<string, CountedRow[]>();
    const departments: CountedRow[] = [];
    for (const row of rows) {
      if (row.parent_id === null) {
        departments.push(row);
      } else {
        const siblings = childrenOf.get(row.parent_id) ?? [];
        siblings.push(row);
        childrenOf.set(row.parent_id, siblings);
      }
    }
    const result: CategoryWithCount[] = [];
    for (const department of departments) {
      const children = childrenOf.get(department.id) ?? [];
      const total = children.reduce((sum, child) => sum + child.direct_count, department.direct_count);
      result.push({ ...toCategory(department), productCount: total });
      for (const child of children) result.push({ ...toCategory(child), productCount: child.direct_count });
    }
    return result;
  }

  listSlugsWithUpdatedAt(): { slug: string; updatedAt: string }[] {
    return this.db
      .query<{ slug: string; updated_at: string }, []>("SELECT slug, updated_at FROM categories ORDER BY slug")
      .all()
      .map((row) => ({ slug: row.slug, updatedAt: row.updated_at }));
  }
}
