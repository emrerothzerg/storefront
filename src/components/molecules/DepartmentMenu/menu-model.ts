import { isAllowedInternalHref } from "@/content/routes";
import type { Category } from "@/lib/types";

/**
 * Pure model for DepartmentMenu (T64): turns props into validated link lists.
 * Exactly two levels: department -> its child categories. Grandchildren (if a
 * caller ever passes them) are ignored. Every href is checked with
 * `isAllowedInternalHref`; rejected ones are omitted and reported in
 * `rejected` so the component can log a development warning.
 */

export interface MenuLink {
  readonly label: string;
  readonly href: string;
}

export type DepartmentInput = Category & { readonly children: readonly Category[] };

export interface MenuDepartment {
  readonly id: string;
  readonly name: string;
  /** "All <name>" link to the department page, when its href is allowed. */
  readonly allHref: string | null;
  readonly children: readonly MenuLink[];
}

export interface MenuModel {
  readonly departments: readonly MenuDepartment[];
  readonly primary: readonly MenuLink[];
  readonly account: readonly MenuLink[];
  /** Hrefs that failed validation (for a development warning only). */
  readonly rejected: readonly string[];
}

/** `/category/<slug>` (slug percent-encoded so `?`, `#` or `/` cannot change the path). */
export function categoryHref(slug: string): string {
  return `/category/${encodeURIComponent(slug)}`;
}

function bySortOrder(a: Category, b: Category): number {
  const sa = Number.isFinite(a.sortOrder) ? a.sortOrder : 0;
  const sb = Number.isFinite(b.sortOrder) ? b.sortOrder : 0;
  return sa - sb || a.name.localeCompare(b.name);
}

function validLinks(links: readonly MenuLink[] | undefined, rejected: string[]): MenuLink[] {
  const out: MenuLink[] = [];
  for (const link of links ?? []) {
    if (typeof link?.label !== "string" || link.label.trim() === "") continue;
    if (typeof link.href === "string" && isAllowedInternalHref(link.href)) out.push(link);
    else rejected.push(String(link.href));
  }
  return out;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function buildMenuModel(input: {
  departments: readonly DepartmentInput[];
  primaryNav: readonly MenuLink[];
  accountNav: readonly MenuLink[];
}): MenuModel {
  const rejected: string[] = [];
  const departments: MenuDepartment[] = [];
  for (const dept of [...input.departments].sort(bySortOrder)) {
    if (!hasText(dept.name) || !hasText(dept.slug)) continue;
    const ownHref = categoryHref(dept.slug);
    const allHref = isAllowedInternalHref(ownHref) ? ownHref : null;
    if (allHref === null) rejected.push(ownHref);
    const children: MenuLink[] = [];
    for (const child of [...(dept.children ?? [])].sort(bySortOrder)) {
      if (!hasText(child.name) || !hasText(child.slug)) continue;
      const href = categoryHref(child.slug);
      if (isAllowedInternalHref(href)) children.push({ label: child.name, href });
      else rejected.push(href);
    }
    if (allHref === null && children.length === 0) continue;
    departments.push({ id: dept.id, name: dept.name, allHref, children });
  }
  return {
    departments,
    primary: validLinks(input.primaryNav, rejected),
    account: validLinks(input.accountNav, rejected),
    rejected,
  };
}
