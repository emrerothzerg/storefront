import { SITE_NAME, absoluteUrl } from "./site";

/**
 * Typed schema.org JSON-LD builders. Each returns a plain, JSON-serialisable
 * object with `@context` and `@type`; render it with the `JsonLd` molecule
 * (which escapes it for a `<script>` tag). Relative paths are made absolute
 * with `NEXT_PUBLIC_SITE_URL` (see `site.ts`). Money is integer minor units
 * and becomes a decimal string without float math.
 */

export const SCHEMA_CONTEXT = "https://schema.org";

/**
 * Any top-level JSON-LD document accepted by the `JsonLd` component: every
 * builder result fits, and so does a hand-written object with these two keys.
 */
export type JsonLdThing = {
  readonly "@context": typeof SCHEMA_CONTEXT;
  readonly "@type": string;
};

export type ItemAvailability = "https://schema.org/InStock" | "https://schema.org/OutOfStock";

// ---------------------------------------------------------------------------
// Organization / WebSite
// ---------------------------------------------------------------------------

export type OrganizationJsonLd = {
  readonly "@context": typeof SCHEMA_CONTEXT;
  readonly "@type": "Organization";
  readonly name: string;
  readonly url: string;
};

export function organizationJsonLd(): OrganizationJsonLd {
  return { "@context": SCHEMA_CONTEXT, "@type": "Organization", name: SITE_NAME, url: absoluteUrl("/") };
}

/** Fixed search URL template (the search page reads `q`). */
export const SEARCH_URL_TEMPLATE_PATH = "/search?q={search_term_string}";

export type WebSiteJsonLd = {
  readonly "@context": typeof SCHEMA_CONTEXT;
  readonly "@type": "WebSite";
  readonly name: string;
  readonly url: string;
  readonly potentialAction: {
    readonly "@type": "SearchAction";
    readonly target: { readonly "@type": "EntryPoint"; readonly urlTemplate: string };
    readonly "query-input": "required name=search_term_string";
  };
};

export function webSiteJsonLd(): WebSiteJsonLd {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "WebSite",
    name: SITE_NAME,
    url: absoluteUrl("/"),
    potentialAction: {
      "@type": "SearchAction",
      // absoluteUrl concatenates without encoding, so the braces stay literal.
      target: { "@type": "EntryPoint", urlTemplate: absoluteUrl(SEARCH_URL_TEMPLATE_PATH) },
      "query-input": "required name=search_term_string",
    },
  };
}

// ---------------------------------------------------------------------------
// BreadcrumbList / ItemList
// ---------------------------------------------------------------------------

export interface BreadcrumbItemInput {
  readonly name: string;
  /** Site path or absolute URL. */
  readonly path: string;
}

export type ListItemJsonLd = {
  readonly "@type": "ListItem";
  readonly position: number;
  readonly name?: string;
  readonly item?: string;
  readonly url?: string;
};

export type BreadcrumbListJsonLd = {
  readonly "@context": typeof SCHEMA_CONTEXT;
  readonly "@type": "BreadcrumbList";
  readonly itemListElement: readonly ListItemJsonLd[];
};

/** Breadcrumb trail, first item = root. Positions start at 1. */
export function breadcrumbListJsonLd(items: readonly BreadcrumbItemInput[]): BreadcrumbListJsonLd {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: items.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: entry.name.trim(),
      item: absoluteUrl(entry.path),
    })),
  };
}

export interface ItemListEntryInput {
  /** Site path or absolute URL of the listed page (e.g. a PDP). */
  readonly path: string;
  readonly name?: string;
}

export type ItemListJsonLd = {
  readonly "@context": typeof SCHEMA_CONTEXT;
  readonly "@type": "ItemList";
  readonly numberOfItems: number;
  readonly itemListElement: readonly ListItemJsonLd[];
};

/** Summary list (category, search, best sellers): ListItem with `url` per entry. */
export function itemListJsonLd(items: readonly ItemListEntryInput[]): ItemListJsonLd {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "ItemList",
    numberOfItems: items.length,
    itemListElement: items.map((entry, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url: absoluteUrl(entry.path),
      ...(entry.name?.trim() ? { name: entry.name.trim() } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// FAQPage
// ---------------------------------------------------------------------------

export interface FaqEntryInput {
  readonly question: string;
  /** Plain text answer. */
  readonly answer: string;
}

export type FaqPageJsonLd = {
  readonly "@context": typeof SCHEMA_CONTEXT;
  readonly "@type": "FAQPage";
  readonly mainEntity: readonly {
    readonly "@type": "Question";
    readonly name: string;
    readonly acceptedAnswer: { readonly "@type": "Answer"; readonly text: string };
  }[];
};

export function faqPageJsonLd(qa: readonly FaqEntryInput[]): FaqPageJsonLd {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "FAQPage",
    mainEntity: qa.map((entry) => ({
      "@type": "Question",
      name: entry.question.trim(),
      acceptedAnswer: { "@type": "Answer", text: entry.answer.trim() },
    })),
  };
}

// ---------------------------------------------------------------------------
// Product
// ---------------------------------------------------------------------------

/**
 * Builder input for `productJsonLd`. Deliberately independent of the domain
 * `Product` type: map today's `Product` or the richer product detail with
 * `toProductJsonLdInput`, or build it by hand.
 */
export interface ProductJsonLdInput {
  readonly name: string;
  readonly description: string;
  readonly slug: string;
  /** Site paths or absolute URLs; the first is the primary image. */
  readonly images: readonly string[];
  readonly sku?: string;
  readonly brandName?: string;
  /** Integer minor units (e.g. cents). */
  readonly priceCents: number;
  /** ISO 4217 code, e.g. "USD". */
  readonly currency: string;
  /** Units available; > 0 means in stock. */
  readonly stock: number;
  readonly ratingCount?: number;
  /** Average rating on a 1-5 scale. */
  readonly ratingAvg?: number;
  /** Canonical PDP path or URL; defaults to `/products/<slug>`. */
  readonly url?: string;
}

export type OfferJsonLd = {
  readonly "@type": "Offer";
  readonly url: string;
  readonly price: string;
  readonly priceCurrency: string;
  readonly availability: ItemAvailability;
  readonly itemCondition: "https://schema.org/NewCondition";
};

export type AggregateRatingJsonLd = {
  readonly "@type": "AggregateRating";
  readonly ratingValue: number;
  readonly ratingCount: number;
  readonly bestRating: 5;
  readonly worstRating: 1;
};

export type ProductJsonLd = {
  readonly "@context": typeof SCHEMA_CONTEXT;
  readonly "@type": "Product";
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly image: readonly string[];
  readonly sku?: string;
  readonly brand?: { readonly "@type": "Brand"; readonly name: string };
  /** Omitted when the price or currency is invalid (never emit a wrong price). */
  readonly offers?: OfferJsonLd;
  /** Present only when there is at least one rating. */
  readonly aggregateRating?: AggregateRatingJsonLd;
};

/**
 * Integer minor units as a decimal string in the currency's own minor-unit
 * digits, without float math: (1999, "USD") → "19.99", (1999, "JPY") → "1999".
 * `null` for a non-integer, negative or unsafe amount or a currency that is
 * not a supported ISO 4217 code.
 */
let supportedCurrencies: ReadonlySet<string> | undefined;

/**
 * True for ISO 4217 codes the runtime knows. `Intl.NumberFormat` accepts any
 * well-formed 3-letter code ("ABC", "BTC"), so check the supported list
 * (computed once). Case-sensitive: codes are upper case.
 */
export function isSupportedCurrency(currency: string): boolean {
  supportedCurrencies ??= new Set(Intl.supportedValuesOf("currency"));
  return supportedCurrencies.has(currency);
}

export function centsToDecimalString(amountMinor: number, currency: string): string | null {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return null;
  if (typeof currency !== "string" || !isSupportedCurrency(currency.toUpperCase())) return null;
  let digits: number;
  try {
    digits =
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
  const padded = String(amountMinor).padStart(digits + 1, "0");
  return digits === 0 ? padded : `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
}

export function availabilityFor(stock: number): ItemAvailability {
  return Number.isFinite(stock) && stock > 0
    ? "https://schema.org/InStock"
    : "https://schema.org/OutOfStock";
}

function aggregateRating(
  ratingCount: number | undefined,
  ratingAvg: number | undefined,
): AggregateRatingJsonLd | undefined {
  if (ratingCount === undefined || ratingAvg === undefined) return undefined;
  if (!Number.isSafeInteger(ratingCount) || ratingCount <= 0) return undefined;
  if (!Number.isFinite(ratingAvg) || ratingAvg < 1 || ratingAvg > 5) return undefined;
  return {
    "@type": "AggregateRating",
    ratingValue: Math.round(ratingAvg * 10) / 10,
    ratingCount,
    bestRating: 5,
    worstRating: 1,
  };
}

export function productJsonLd(input: ProductJsonLdInput): ProductJsonLd {
  const url = absoluteUrl(input.url ?? `/products/${encodeURIComponent(input.slug)}`);
  const price = centsToDecimalString(input.priceCents, input.currency);
  const rating = aggregateRating(input.ratingCount, input.ratingAvg);
  const sku = input.sku?.trim();
  const brandName = input.brandName?.trim();
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "Product",
    name: input.name.trim(),
    description: input.description.trim(),
    url,
    image: input.images
      .map((image) => image.trim())
      .filter((image) => image.length > 0)
      .map((image) => absoluteUrl(image)),
    ...(sku ? { sku } : {}),
    ...(brandName ? { brand: { "@type": "Brand", name: brandName } } : {}),
    ...(price === null
      ? {}
      : {
          offers: {
            "@type": "Offer",
            url,
            price,
            priceCurrency: input.currency.toUpperCase(),
            availability: availabilityFor(input.stock),
            itemCondition: "https://schema.org/NewCondition",
          },
        }),
    ...(rating ? { aggregateRating: rating } : {}),
  };
}

/**
 * Structural source accepted by `toProductJsonLdInput`: today's `Product`
 * (`id`, `imageUrl`) and the upcoming product detail (`images[]`, `brand`,
 * `sku`, `ratingCount`, `ratingAvg`) both fit. Unknown extra fields are ignored.
 */
export interface ProductJsonLdSource {
  readonly name: string;
  readonly description: string;
  readonly slug: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly stock: number;
  readonly id?: string;
  readonly sku?: string | null;
  readonly imageUrl?: string | null;
  readonly images?: readonly (string | { readonly url: string })[] | null;
  readonly brand?: string | { readonly name: string } | null;
  readonly brandName?: string | null;
  readonly ratingCount?: number | null;
  readonly ratingAvg?: number | null;
}

/** Maps a product-like object to `ProductJsonLdInput` (a blank/missing sku falls back to `id`). */
export function toProductJsonLdInput(source: ProductJsonLdSource): ProductJsonLdInput {
  const gallery = (source.images ?? []).map((image) => (typeof image === "string" ? image : image.url));
  const images = gallery.length > 0 ? gallery : source.imageUrl ? [source.imageUrl] : [];
  const brandName =
    source.brandName ?? (typeof source.brand === "string" ? source.brand : source.brand?.name);
  const sku = source.sku?.trim() || source.id;
  return {
    name: source.name,
    description: source.description,
    slug: source.slug,
    images,
    priceCents: source.priceCents,
    currency: source.currency,
    stock: source.stock,
    ...(sku ? { sku } : {}),
    ...(brandName ? { brandName } : {}),
    ...(source.ratingCount != null ? { ratingCount: source.ratingCount } : {}),
    ...(source.ratingAvg != null ? { ratingAvg: source.ratingAvg } : {}),
  };
}
