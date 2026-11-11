import type { Metadata } from "next";
import { connection } from "next/server";

import { addToCart } from "@/app/actions/cart";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Notice } from "@/components/atoms/Notice";
import { Heading, Text } from "@/components/atoms/Typography";
import { COMPARE_PATH } from "@/components/molecules/CompareToggle/compare-path";
import { CompareTable } from "@/components/organisms/CompareTable";
import { buildMetadata } from "@/lib/seo/metadata";

import {
  COMPARE_BREADCRUMB_LABEL,
  COMPARE_CAPPED_NOTICE,
  COMPARE_DESCRIPTION,
  COMPARE_TITLE,
  COMPARE_UNAVAILABLE_NOTICE,
  compareIntro,
} from "./_lib/compare-copy";
import { loadCompare } from "./_lib/compare-data";
import type { RawSearchParams } from "./_lib/compare-params";

/**
 * Stateless query page: kept out of the index but links stay followable. The
 * canonical is the bare `/compare` (no query): every selection is a throwaway
 * URL. `buildMetadata`'s `noindex` means `follow: false`, so robots is set here.
 */
export const metadata: Metadata = {
  ...buildMetadata({
    title: COMPARE_TITLE,
    description: COMPARE_DESCRIPTION,
    path: COMPARE_PATH,
  }),
  robots: { index: false, follow: true },
};

export interface ComparePageProps {
  readonly searchParams?: Promise<RawSearchParams>;
}

/**
 * Compare page (T100). The whole state is the query string (`?p=slug` up to
 * 4, also `?p=a,b`; `diff=1`). No session, no cookies, no writes: the
 * loader only reads published products; Remove/toggle links carry only the
 * resolved slugs (they are rebuilt in the repeated `?p=a&p=b` form).
 */
export default async function ComparePage({ searchParams }: ComparePageProps) {
  // The catalog read is synchronous; keep it out of any prerender (SPIKE-NOTES finding 2).
  await connection();
  const query: unknown = searchParams ? await searchParams : {};
  const data = loadCompare(query);
  const count = data.products.length;
  const intro = compareIntro(count);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: COMPARE_BREADCRUMB_LABEL }]} />
      <div className="flex min-w-0 flex-col gap-2" data-compare-count={count}>
        <Heading level={1}>{COMPARE_TITLE}</Heading>
        {intro !== null ? <Text tone="secondary">{intro}</Text> : null}
      </div>
      {data.unavailable ? (
        <Notice tone="warning" data-compare-notice="unavailable">
          {COMPARE_UNAVAILABLE_NOTICE}
        </Notice>
      ) : null}
      {data.capped ? (
        <Notice tone="info" data-compare-notice="capped">
          {COMPARE_CAPPED_NOTICE}
        </Notice>
      ) : null}
      <CompareTable
        products={data.products}
        selectedSlugs={data.slugs}
        differencesOnly={data.differencesOnly}
        basePath={COMPARE_PATH}
        addToCart={addToCart}
      />
    </div>
  );
}
