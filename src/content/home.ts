/**
 * Home page copy and configuration (T165, Phase 3 redesign). Plain text only;
 * the home loader (`src/app/_lib/home.ts`) turns this into organism props and
 * adds the data-driven parts (products, departments, the free-shipping
 * threshold). Nothing here touches the database or React.
 *
 * Rules (tested in `home.test.ts`):
 * - Every href passes `isAllowedInternalHref` and points at a page that
 *   exists (category slugs come from the seed taxonomy).
 * - Copy is original and neutral (R2) and honest (R10): no retailer, partner,
 *   membership, newsletter, store, click and collect or app copy.
 * - Money is never hardcoded: the shipping promo carries `{amount}`, replaced
 *   with the lowest active free-shipping threshold at load time.
 * - Popular searches are a static curated list (no analytics), each with at
 *   least one result on the seeded catalogue.
 */

import {
  BEAUTY_PROMO_ART,
  DELIVERY_PROMO_ART,
  HERO_SLIDE_ART,
  LIFESTYLE_ART,
  type HomeArtImage,
} from "./home-art";
import { POPULAR_SEARCHES } from "./search-help";

/** Placeholder replaced by the formatted free-shipping threshold, e.g. "$35" (same token as the header strip). */
export const HOME_AMOUNT_TOKEN = "{amount}";

/** Surfaces a hero slide may use (a subset of the HeroBanner tones; the loader type-checks the mapping). */
export type HomeHeroTone = "neutral" | "accent" | "accent-subtle" | "promo" | "promo-subtle" | "inverse";

/** Promo surfaces (the PromoStrip / LifestyleCard tones). */
export type HomePromoTone = "primary" | "primary-subtle" | "neutral" | "accent";

export interface HomeCta {
  readonly label: string;
  /** Internal route; must pass `isAllowedInternalHref`. */
  readonly href: string;
}

export interface HomeHeroSlideCopy {
  /** Stable key. */
  readonly id: string;
  readonly headline: string;
  readonly subline: string;
  readonly cta: HomeCta;
  readonly image: HomeArtImage;
  readonly tone: HomeHeroTone;
}

export interface HomePromoCopy {
  readonly id: string;
  readonly heading: string;
  readonly blurb: string;
  readonly cta: HomeCta;
  readonly image: HomeArtImage | null;
  /** "start" = image on the left from md (split banner). */
  readonly imagePosition: "start" | "end";
  readonly tone: HomePromoTone;
}

/** Shipping promo: `heading` contains `{amount}` exactly once. */
export interface HomeShippingPromoCopy extends HomePromoCopy {
  readonly sectionId: string;
}

export interface HomeLifestyleCardCopy {
  readonly id: string;
  readonly heading: string;
  readonly blurb: string;
  readonly cta: HomeCta;
  readonly image: HomeArtImage;
}

export interface HomeLifestyleSetCopy {
  readonly sectionId: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly columns: 3 | 4;
  readonly items: readonly HomeLifestyleCardCopy[];
}

/** Which loader list feeds a top-picks tab. */
export type HomeTopPicksSource = "bestSellers" | "deals" | "newArrivals" | "topRated";

export interface HomeTopPicksTabCopy {
  /** Also the `?rail=` value. */
  readonly id: string;
  readonly label: string;
  readonly source: HomeTopPicksSource;
}

export interface HomeTopPicksCopy {
  readonly sectionId: string;
  readonly title: string;
  readonly eyebrow: string;
  /** Accessible name of the tab `nav`. */
  readonly tabsLabel: string;
  /** Contract H-14 order. */
  readonly tabs: readonly HomeTopPicksTabCopy[];
  /** Tab shown for a missing or invalid `?rail=` (contract H-15). */
  readonly defaultTabId: string;
}

export interface HomeSectionCopy {
  readonly sectionId: string;
  readonly title: string;
  readonly eyebrow: string;
}

export interface HomeContent {
  readonly hero: {
    readonly sectionId: string;
    /** Accessible name of the carousel region. */
    readonly label: string;
    readonly slides: readonly HomeHeroSlideCopy[];
  };
  readonly categories: HomeSectionCopy;
  readonly shippingPromo: HomeShippingPromoCopy;
  readonly discovery: HomeSectionCopy;
  readonly lifestyleBanner: HomePromoCopy & { readonly sectionId: string };
  readonly topPicks: HomeTopPicksCopy;
  readonly lifestyleExplore: HomeLifestyleSetCopy;
  readonly lifestyleMakeRoom: HomeLifestyleSetCopy;
  readonly popularSearches: {
    readonly sectionId: string;
    /** Visible label and accessible name of the chip `nav`. */
    readonly label: string;
    readonly terms: readonly string[];
  };
  readonly promoPair: {
    readonly sectionId: string;
    /** Section heading (visually hidden by the organism by default). */
    readonly heading: string;
    readonly items: readonly HomePromoCopy[];
  };
  readonly recentlyViewed: HomeSectionCopy & { readonly seeAllHref: string };
  readonly brands: HomeSectionCopy;
  readonly services: {
    readonly sectionId: string;
    readonly heading: string;
    /** Reference: the returns notice sits above the tile band. */
    readonly noticePlacement: "before" | "after";
  };
}

/** Upper bound for the popular-search chips (contract H-18). */
export const HOME_POPULAR_SEARCH_MAX = 12;

/** Home-only additions after the shared `/search` popular searches (each has seeded results; tested). */
const HOME_EXTRA_SEARCHES: readonly string[] = ["lamp", "puzzle", "jacket", "water bottle", "mug", "speaker"];

function uniqueTerms(terms: readonly string[], max: number): readonly string[] {
  const out: string[] = [];
  for (const term of terms) {
    const clean = term.trim();
    if (clean !== "" && !out.includes(clean)) out.push(clean);
    if (out.length >= max) break;
  }
  return Object.freeze(out);
}

function heroArt(index: number): HomeArtImage {
  const image = HERO_SLIDE_ART[index];
  if (image === undefined) throw new Error(`HERO_SLIDE_ART[${index}] is missing`);
  return image;
}

export const HOME_TOP_PICKS_SECTION_ID = "top-picks";

/** `/?rail=<id>#top-picks`: the no-JS link of a top-picks tab (contract H-14). */
export function topPicksTabHref(id: string): string {
  return `/?rail=${encodeURIComponent(id)}#${HOME_TOP_PICKS_SECTION_ID}`;
}

export const HOME_CONTENT: HomeContent = {
  hero: {
    sectionId: "home-hero",
    label: "Featured offers",
    slides: [
      {
        id: "everyday",
        // Kept from Phase 2: this headline is the page's single h1.
        headline: "Everyday essentials, all in one place",
        subline: "Shop by department, browse today's deals and discover what other shoppers love.",
        cta: { label: "Shop today's deals", href: "/deals" },
        image: heroArt(0),
        tone: "accent",
      },
      {
        id: "kitchen",
        headline: "Fresh picks for the kitchen",
        subline: "Cookware, coffee gear and table essentials for everyday cooking.",
        cta: { label: "Shop home and kitchen", href: "/category/home-kitchen" },
        image: heroArt(1),
        tone: "promo",
      },
      {
        id: "tech",
        headline: "Tech that keeps up with you",
        subline: "Headphones, chargers and smart home basics for work and play.",
        cta: { label: "Shop electronics", href: "/category/electronics" },
        image: heroArt(2),
        tone: "accent-subtle",
      },
    ],
  },
  categories: { sectionId: "home-categories", title: "Shop by department", eyebrow: "" },
  shippingPromo: {
    sectionId: "home-shipping-promo",
    id: "shipping",
    heading: `Free shipping on orders of ${HOME_AMOUNT_TOKEN} or more`,
    blurb: "Standard shipping is on us once your order reaches the threshold. Faster options are shown at checkout.",
    cta: { label: "See shipping options", href: "/shipping" },
    image: DELIVERY_PROMO_ART,
    imagePosition: "end",
    tone: "primary-subtle",
  },
  discovery: { sectionId: "home-discovery", title: "Explore popular categories", eyebrow: "Discover something new" },
  lifestyleBanner: {
    sectionId: "home-lifestyle-banner",
    id: "beauty",
    heading: "Beauty and self-care picks",
    blurb: "Skincare, hair and body care and fragrance to refresh your routine.",
    cta: { label: "Shop beauty", href: "/category/beauty-personal-care" },
    image: BEAUTY_PROMO_ART,
    imagePosition: "start",
    tone: "neutral",
  },
  topPicks: {
    sectionId: HOME_TOP_PICKS_SECTION_ID,
    title: "Top picks",
    eyebrow: "Popular right now",
    tabsLabel: "Top picks lists",
    tabs: [
      { id: "best-sellers", label: "Best sellers", source: "bestSellers" },
      { id: "deals", label: "Deals", source: "deals" },
      { id: "new-arrivals", label: "New arrivals", source: "newArrivals" },
      { id: "top-rated", label: "Top rated", source: "topRated" },
    ],
    defaultTabId: "best-sellers",
  },
  lifestyleExplore: {
    sectionId: "home-lifestyle-cards",
    eyebrow: "Ideas for every room",
    heading: "Explore ideas for home and everyday life",
    columns: 4,
    items: [
      {
        id: "living",
        heading: "Cosy living spaces",
        blurb: "Throws, candles and prints that make a room feel finished.",
        cta: { label: "Shop decor and textiles", href: "/category/decor-textiles" },
        image: LIFESTYLE_ART.living,
      },
      {
        id: "dining",
        heading: "Set the table",
        blurb: "Pans, boards and table linen for meals worth sitting down for.",
        cta: { label: "Shop cookware and dining", href: "/category/cookware-dining" },
        image: LIFESTYLE_ART.dining,
      },
      {
        id: "outdoor",
        heading: "Head outside",
        blurb: "Bottles, lights and camp kit for days out and nights under the stars.",
        cta: { label: "Shop camping and hydration", href: "/category/camping-hydration" },
        image: LIFESTYLE_ART.outdoor,
      },
      {
        id: "wardrobe",
        heading: "Wardrobe refresh",
        blurb: "Easy tees, shirts and layers to wear on repeat.",
        cta: { label: "Shop tops and tees", href: "/category/tops" },
        image: LIFESTYLE_ART.wardrobe,
      },
    ],
  },
  lifestyleMakeRoom: {
    sectionId: "home-lifestyle-make-room",
    eyebrow: "At home and outdoors",
    heading: "Spaces worth spending time in",
    columns: 3,
    items: [
      {
        id: "home",
        heading: "Make yourself at home",
        blurb: "Furniture, lighting and soft furnishings for rooms you love coming back to.",
        cta: { label: "Shop home and kitchen", href: "/category/home-kitchen" },
        image: LIFESTYLE_ART.living,
      },
      {
        id: "coffee",
        heading: "Slow mornings",
        blurb: "Brewers, kettles and mugs for a better first cup.",
        cta: { label: "Shop coffee and tea", href: "/category/coffee-tea" },
        image: LIFESTYLE_ART.dining,
      },
      {
        id: "play",
        heading: "Get out and play",
        blurb: "Fitness, cycling and outdoor gear for active weekends.",
        cta: { label: "Shop sports and outdoors", href: "/category/sports-outdoors" },
        image: LIFESTYLE_ART.outdoor,
      },
    ],
  },
  popularSearches: {
    sectionId: "home-popular-searches",
    label: "Everyone's looking for",
    terms: uniqueTerms([...POPULAR_SEARCHES, ...HOME_EXTRA_SEARCHES], HOME_POPULAR_SEARCH_MAX),
  },
  promoPair: {
    sectionId: "home-promo-pair",
    heading: "More to explore",
    items: [
      {
        id: "new-arrivals",
        heading: "New arrivals",
        blurb: "The latest additions to the store, updated as new products land.",
        cta: { label: "Shop new arrivals", href: "/new-arrivals" },
        image: null,
        imagePosition: "end",
        tone: "primary-subtle",
      },
      {
        id: "top-rated",
        heading: "Top rated",
        blurb: "The products our reviewers rate the highest, across every department.",
        cta: { label: "Shop top rated", href: "/top-rated" },
        image: null,
        imagePosition: "end",
        tone: "neutral",
      },
    ],
  },
  recentlyViewed: {
    sectionId: "home-recently-viewed",
    title: "Your recently viewed items",
    eyebrow: "",
    seeAllHref: "/account/history",
  },
  brands: { sectionId: "home-brands", title: "Featured brands", eyebrow: "" },
  services: { sectionId: "home-services", heading: "Customer services", noticePlacement: "before" },
};
