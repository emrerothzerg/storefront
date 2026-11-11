import { Disclosure } from "@/components/atoms/Disclosure";
import { Link } from "@/components/atoms/Link";
import {
  CATEGORY_NAV_LABEL,
  CATEGORY_NAV_MORE_LABEL,
  buildCategoryNavModel,
} from "./category-nav-model";
import type { CategoryNavItem, CategoryNavLeading, CategoryNavLink } from "./category-nav-model";

export interface CategoryNavProps {
  /**
   * Departments in display order (the caller builds them, e.g. from
   * `DEPARTMENT_NAV` or the `categoryTree()` roots). Blank slugs/labels,
   * duplicate slugs and hrefs failing `isAllowedInternalHref` are dropped.
   */
  departments: readonly CategoryNavItem[];
  /** Slug of the department being viewed; its link gets `aria-current="page"`. */
  currentSlug?: string | null;
  /**
   * Direct links in the row; the rest go inside the "More" `<details>`.
   * Integer >= 1; anything else falls back to 9.
   */
  maxVisible?: number;
  /**
   * Optional link rendered first in the row (the header passes Deals ->
   * `/deals`). Allow-listed with `isAllowedInternalHref` (dropped otherwise);
   * not counted toward `maxVisible`, never moved into "More".
   */
  leading?: CategoryNavLeading | null;
  className?: string;
}

const rowLinkClasses = "shrink-0 rounded-full px-3 text-small hover:bg-surface-sunken";

function DepartmentLink({ link, className }: { link: CategoryNavLink; className: string }) {
  return (
    <Link href={link.href} variant="nav" isCurrent={link.current} className={className}>
      {link.label}
    </Link>
  );
}

/**
 * Category nav row (T143, header H2): one line of department links in
 * `<nav aria-label="Primary">`. After `maxVisible` links the rest sit inside a
 * native `<details>` "More" (no JS needed). The row never wraps: below its
 * width it scrolls horizontally inside its own container (320px safe). The
 * "More" disclosure sits outside the scrolling list so its panel is not
 * clipped. Renders nothing when no department survives validation.
 * Server-safe (no `"use client"`).
 */
export function CategoryNav({ departments, currentSlug, maxVisible, leading, className }: CategoryNavProps) {
  const model = buildCategoryNavModel({ departments, currentSlug, maxVisible, leading });

  if (model.rejected.length > 0 && process.env.NODE_ENV !== "production") {
    console.warn(`CategoryNav: omitted links with disallowed hrefs:\n${model.rejected.join("\n")}`);
  }
  if (model.visible.length === 0 && model.leading === null) return null;

  return (
    <nav
      aria-label={CATEGORY_NAV_LABEL}
      className={["flex w-full min-w-0 items-center gap-1", className].filter(Boolean).join(" ")}
    >
      <ul
        role="list"
        className="flex min-w-0 flex-1 flex-nowrap items-center gap-1 overflow-x-auto whitespace-nowrap p-1"
      >
        {model.leading !== null ? (
          <li className="shrink-0">
            <Link href={model.leading.href} variant="nav" className={`${rowLinkClasses} font-semibold`}>
              {model.leading.label}
            </Link>
          </li>
        ) : null}
        {model.visible.map((link) => (
          <li key={link.href} className="shrink-0">
            <DepartmentLink link={link} className={rowLinkClasses} />
          </li>
        ))}
      </ul>
      {model.overflow.length > 0 ? (
        <Disclosure
          className="relative h-touch shrink-0 border-b-0"
          summaryClassName="gap-1 rounded-full px-3 text-small hover:bg-surface-sunken"
          summary={CATEGORY_NAV_MORE_LABEL}
          data-testid="category-nav-more"
        >
          <ul
            role="list"
            className="absolute end-0 top-full z-dropdown mt-1 flex w-64 flex-col rounded-lg border border-border-strong bg-surface-raised p-2 shadow-md"
          >
            {model.overflow.map((link) => (
              <li key={link.href}>
                <DepartmentLink link={link} className="w-full rounded-md px-3 break-words hover:bg-surface-sunken" />
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </nav>
  );
}
