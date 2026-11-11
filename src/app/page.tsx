import type { Metadata } from "next";
import { connection } from "next/server";

import { addToCart } from "@/app/actions/cart";
import { Heading } from "@/components/atoms/Typography";
import { ChipRow } from "@/components/molecules/ChipRow";
import { JsonLd } from "@/components/molecules/JsonLd";
import { BrandStrip } from "@/components/organisms/BrandStrip";
import { CategoryDiscovery } from "@/components/organisms/CategoryDiscovery";
import { CategoryRail } from "@/components/organisms/CategoryGrid";
import { HomeHero } from "@/components/organisms/HomeHero";
import { LifestyleBanners } from "@/components/organisms/LifestyleBanners";
import { ProductRail } from "@/components/organisms/ProductRail";
import { PromoBanner, PromoBannerPair } from "@/components/organisms/PromoBanner";
import { ServicesBand } from "@/components/organisms/ServicesBand";
import { HOME_CONTENT } from "@/content/home";
import { buildMetadata } from "@/lib/seo/metadata";
import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/seo/site";
import { readSessionId } from "@/server/session/session";

import { HOME_TITLE, loadHomeData, type HomeLifestyleSet } from "./_lib/home";

/**
 * Static metadata: the canonical stays `/` for every `?rail=` tab (contract
 * H-22), so a tab link never creates a second indexable URL.
 */
export const metadata: Metadata = {
  ...buildMetadata({
    title: HOME_TITLE,
    description: SITE_DESCRIPTION,
    path: "/",
  }),
  // The root segment is not covered by the layout's title template, so the
  // brand is appended here explicitly (D-T175-1).
  title: { absolute: `${HOME_TITLE} | ${SITE_NAME}` },
};

interface HomePageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** Quick add on every rail card: the one-unit `addToCart` form (works without JS). */
const QUICK_ADD = { action: addToCart } as const;

function LifestyleSection({ set }: { set: HomeLifestyleSet | null }) {
  if (set === null) return null;
  return <LifestyleBanners items={set.items} columns={set.columns} heading={set.heading} eyebrow={set.eyebrow} id={set.id} />;
}

/**
 * Home page v3 (T166). `connection()` keeps the per-request reads out of any
 * prerender; the cookie is read once with `readSessionId()` (never minted,
 * SR10) and `searchParams.rail` is passed raw to the loader, which validates
 * it (`resolveRailTab`) and isolates each reader. The loader also reads the
 * clock once; rendering reads none (cards get `new Date(data.now)`).
 *
 * Section order (contract H-order, ids are part of the contract): hero
 * (`home-hero`, the page's single `<h1>`), departments (`home-categories`),
 * shipping promo, category discovery, lifestyle banner, top picks
 * (`top-picks`, link tabs `/?rail=…#top-picks`), lifestyle cards (4 columns),
 * make-room cards (3 columns), popular searches, promo pair, recently viewed
 * (owner-scoped), brands, services. Each section is omitted when its data is
 * empty. The layout renders `<main>`, the header (with the benefits strip)
 * and the Organization + WebSite JSON-LD; this page adds only the deals
 * `ItemList`.
 */
export default async function HomePage(props: HomePageProps = {}) {
  await connection();
  const searchParams = props.searchParams === undefined ? {} : await props.searchParams;
  const sessionId = await readSessionId();
  const data = await loadHomeData({ sessionId, rail: searchParams.rail ?? null });
  const now = new Date(data.now);
  const { sections, promos, topPicks, recentlyViewed, popularSearches } = data;
  const popularHeadingId = `${popularSearches.id}-heading`;

  return (
    <div className="flex flex-col gap-10">
      <HomeHero slides={data.heroSlides} deal={data.deal} label={sections.hero.label} headingLevel={1} id={sections.hero.id} />

      {data.departments.length === 0 ? null : (
        <CategoryRail categories={data.departments} title={sections.categories.title} id={sections.categories.sectionId} />
      )}

      {promos.shipping === null ? null : <PromoBanner promo={promos.shipping} id={HOME_CONTENT.shippingPromo.sectionId} />}

      {data.discoveryCategories.length === 0 ? null : (
        <CategoryDiscovery
          categories={data.discoveryCategories}
          title={sections.discovery.title}
          eyebrow={sections.discovery.eyebrow}
          id={sections.discovery.sectionId}
        />
      )}

      {promos.lifestyleBanner === null ? null : (
        <PromoBanner promo={promos.lifestyleBanner} id={HOME_CONTENT.lifestyleBanner.sectionId} />
      )}

      {topPicks === null ? null : (
        <ProductRail
          id={topPicks.id}
          title={topPicks.title}
          eyebrow={topPicks.eyebrow}
          tabs={topPicks.tabs}
          activeId={topPicks.activeId}
          tabsLabel={topPicks.tabsLabel}
          products={topPicks.products}
          quickAdd={QUICK_ADD}
          now={now}
          {...(topPicks.seeAllHref === undefined ? {} : { seeAllHref: topPicks.seeAllHref })}
        />
      )}

      <LifestyleSection set={data.lifestyle.explore} />
      <LifestyleSection set={data.lifestyle.makeRoom} />

      {popularSearches.items.length === 0 ? null : (
        <section id={popularSearches.id} aria-labelledby={popularHeadingId} className="flex flex-col gap-3">
          <Heading level={2} size="h3" id={popularHeadingId}>
            {popularSearches.label}
          </Heading>
          <ChipRow label={popularSearches.label} items={popularSearches.items} searchIcon="trailing" />
        </section>
      )}

      {promos.pair.length === 0 ? null : (
        <PromoBannerPair promos={promos.pair} heading={HOME_CONTENT.promoPair.heading} id={HOME_CONTENT.promoPair.sectionId} />
      )}

      {recentlyViewed === null ? null : (
        <ProductRail
          id={sections.recentlyViewed.sectionId}
          title={recentlyViewed.title}
          products={recentlyViewed.products}
          quickAdd={QUICK_ADD}
          now={now}
          {...(recentlyViewed.seeAllHref === undefined ? {} : { seeAllHref: recentlyViewed.seeAllHref })}
        />
      )}

      {data.brands.length === 0 ? null : (
        <BrandStrip brands={data.brands} title={sections.brands.title} id={sections.brands.sectionId} />
      )}

      <ServicesBand id={data.services.id} heading={data.services.heading} noticePlacement={data.services.noticePlacement} />

      {data.dealsJsonLd === null ? null : <JsonLd data={data.dealsJsonLd} />}
    </div>
  );
}
