import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { ListView } from "@/components/organisms/ListView";
import { buildMetadata } from "@/lib/seo/metadata";

import { loadSharedList } from "../../_lib/load-lists";
import { SHARED_TITLE_PREFIX } from "../../_lib/page-parts";
import { isShareTokenShape, parseListSort, type SearchParamsRecord } from "../../_lib/params";

export interface SharedListPageProps {
  readonly params: Promise<{ token: string }>;
  readonly searchParams: Promise<SearchParamsRecord>;
}

const SHARED_DESCRIPTION = "A wish list someone shared with you.";

/**
 * `robots: { index: false, follow: false }`; no `path`, so the bearer token
 * never appears in a canonical or Open Graph URL.
 */
export async function generateMetadata({ params }: SharedListPageProps): Promise<Metadata> {
  const { token } = await params;
  const shared = isShareTokenShape(token) ? loadSharedList({ token, sort: parseListSort(undefined), now: new Date() }) : null;
  return buildMetadata({
    title: shared === null ? "Shared list" : `${SHARED_TITLE_PREFIX}${shared.name}`,
    description: SHARED_DESCRIPTION,
    noindex: true,
  });
}

/**
 * `/lists/shared/[token]`: public, read-only. Reads no cookie and no owner
 * key; malformed, revoked, rotated or unknown tokens -> `notFound()`
 * (criterion 2). ListView's shared mode renders no forms and no ids.
 */
export default async function SharedListPage({ params, searchParams }: SharedListPageProps) {
  const { token } = await params;
  const sort = parseListSort((await searchParams).sort);
  const shared = isShareTokenShape(token) ? loadSharedList({ token, sort, now: new Date() }) : null;
  if (shared === null) notFound();

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: `${SHARED_TITLE_PREFIX}${shared.name}` }]} />
      <ListView mode="shared" shared={shared} sort={sort} basePath={`/lists/shared/${token}`} />
    </div>
  );
}
