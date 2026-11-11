import type { Metadata } from "next";

import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import { SearchBox, type SearchBoxDepartment } from "@/components/molecules/SearchBox";
import { categoryHref } from "@/components/molecules/DepartmentMenu";
import { DEPARTMENT_NAV, FOOTER_COLUMNS, PRIMARY_NAV, type NavLink } from "@/content/navigation";
import { isAllowedInternalHref, type PlannedRoute } from "@/content/routes";
import { buildMetadata } from "@/lib/seo/metadata";

export const metadata: Metadata = buildMetadata({
  title: "Page not found",
  description: "The page you are looking for does not exist or may have been moved.",
  noindex: true,
});

/** Helpful destinations, in display order. Labels come from the navigation content. */
export const NOT_FOUND_LINK_HREFS: readonly PlannedRoute[] = [
  "/products",
  "/deals",
  "/best-sellers",
  "/new-arrivals",
  "/help",
];

const CONTENT_LINKS: readonly NavLink[] = [...PRIMARY_NAV, ...FOOTER_COLUMNS.flatMap((column) => column.links)];

/** Resolves each helpful href to its content label; drops anything that fails the allowlist. */
export function notFoundLinks(): NavLink[] {
  const out: NavLink[] = [];
  for (const href of NOT_FOUND_LINK_HREFS) {
    const label = CONTENT_LINKS.find((link) => link.href === href)?.label;
    if (label !== undefined && isAllowedInternalHref(href)) out.push({ label, href });
  }
  return out;
}

/** Accessible label of the 404 search field (distinct from the header's "Search products"). */
export const NOT_FOUND_SEARCH_LABEL = "Search the store";

/**
 * Department links from static content (`DEPARTMENT_NAV`, kept in sync with
 * the taxonomy seed by a content test): a 404 page never touches the
 * database, so it renders even when the database is unavailable.
 */
export function notFoundDepartments(): SearchBoxDepartment[] {
  return DEPARTMENT_NAV.filter(
    (dept) => dept.slug !== "" && dept.label.trim() !== "" && isAllowedInternalHref(categoryHref(dept.slug)),
  ).map((dept) => ({ slug: dept.slug, name: dept.label }));
}

/**
 * Root not-found UI (T103). Synchronous server component: no cookies, no
 * database, no clock, no Suspense, so nothing can delay or break the 404 that
 * Next sets before streaming (MVP soft-404 lesson: never add a root
 * `loading.tsx`). The only form is the search GET form to `/search` (field
 * `q`, plus the optional `dept` select joined via the `form` attribute).
 */
export default function NotFound() {
  const departments = notFoundDepartments();
  const links = notFoundLinks();

  return (
    <div className="flex min-w-0 flex-col gap-6 py-6 sm:py-10">
      <Card as="section" padding="lg" radius="xl" className="flex flex-col items-start gap-4">
        <Heading level={1}>Page not found</Heading>
        <Text tone="secondary">
          Sorry, we couldn&apos;t find that page. It may have been moved, or the address may be mistyped. Try a
          search or one of the links below.
        </Text>
        <SearchBox
          departments={departments}
          label={NOT_FOUND_SEARCH_LABEL}
          landmarkLabel={NOT_FOUND_SEARCH_LABEL}
          className="max-w-2xl"
        />
        <Link href="/" variant="button" buttonVariant="outline">
          Back to the catalog
        </Link>
      </Card>

      {links.length > 0 ? (
        <Card>
          <nav aria-labelledby="not-found-links-heading" className="flex min-w-0 flex-col gap-2">
            <Heading level={2} size="h3" id="not-found-links-heading">
              Helpful links
            </Heading>
            <ul className="flex flex-wrap gap-x-6">
              {links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} variant="nav">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </Card>
      ) : null}

      {departments.length > 0 ? (
        <Card>
          <nav aria-labelledby="not-found-departments-heading" className="flex min-w-0 flex-col gap-2">
            <Heading level={2} size="h3" id="not-found-departments-heading">
              Shop by department
            </Heading>
            <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2 md:grid-cols-3">
              {departments.map((dept) => (
                <li key={dept.slug} className="min-w-0">
                  <Link href={categoryHref(dept.slug)} variant="nav" className="break-words">
                    {dept.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </Card>
      ) : null}
    </div>
  );
}
