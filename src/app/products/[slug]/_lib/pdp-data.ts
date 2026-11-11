import type { Database } from "bun:sqlite";

import { formatMoney } from "@/lib/money";
import type { Product, ProductDetail, Review } from "@/lib/types";
import { createCouponService, getCouponService, type CouponService } from "@/server/pricing/coupon-service";
import { createStockAlertService, getStockAlertService, type StockAlertService } from "@/server/alerts/stock-alert-service";
import { createListingService, getListingService, type ListingService } from "@/server/catalog/listing-service";
import { SqliteProductRepository, type PublishedProductReader } from "@/server/catalog/product-repository";
import { getDatabase } from "@/server/db/client";
import { createListService, getListService, type ListService } from "@/server/lists/list-service";
import {
  createShippingService,
  estimateDelivery,
  getShippingService,
  type ShippingService,
} from "@/server/pricing/shipping-service";
import { createQaService, getQaService, type QaListResult, type QaService } from "@/server/qa/qa-service";
import {
  createRecommendationService,
  getRecommendationService,
  type Bundle,
  type RecommendationService,
} from "@/server/recommendations/recommendation-service";
import {
  createReviewService,
  getReviewService,
  type ReviewListResult,
  type ReviewService,
} from "@/server/reviews/review-service";
import { isSessionId } from "@/server/session/session-id";

import { parsePdpParams, reviewsExtraParams, type PdpParams, type RawSearchParams } from "./pdp-params";
import { isValidSlug } from "./product-detail";

/**
 * Product detail page data loader (T97). One call per render: validates the
 * slug shape before touching the DB, loads the product, 404s unpublished
 * products, then loads every section in one `Promise.all`.
 *
 * Privacy (R-1): the owner key (`sessionId`) is used only for server-side
 * lookups and is never part of the returned data.
 *
 * View recording (criterion 5): only when a valid owner key was read from the
 * cookie, exactly once per loader call, before the recently-viewed rail is
 * read. The service upserts `(session, product)`, so even a duplicated render
 * leaves one history row. Without a cookie nothing is written.
 */

export const RAIL_LIMIT = 12;
export const JSON_LD_REVIEWS_FETCH = 5;

/** Services the loader needs; tests build them over a `:memory:` DB. */
export interface PdpDeps {
  readonly products: PublishedProductReader;
  readonly reviews: Pick<ReviewService, "list" | "hasReviewed">;
  readonly qa: Pick<QaService, "list">;
  readonly recommendations: Pick<
    RecommendationService,
    "alsoBought" | "alsoViewed" | "related" | "recentlyViewed" | "frequentlyBoughtTogether" | "boughtLastMonth" | "recordView"
  >;
  readonly lists: Pick<ListService, "listLists" | "isInDefaultList">;
  readonly alerts: Pick<StockAlertService, "list">;
  readonly coupons: Pick<CouponService, "listPromoted">;
  readonly shipping: Pick<ShippingService, "cheapest">;
  readonly listing: Pick<ListingService, "breadcrumb" | "rankInCategory">;
  /** Called with a code only (never ids or input) when an optional section fails. */
  readonly logError?: (code: string) => void;
}

/** Deps over an explicit database (tests). */
export function createPdpDeps(db: Database): PdpDeps {
  return {
    products: new SqliteProductRepository(db),
    reviews: createReviewService({ db }),
    qa: createQaService({ db }),
    recommendations: createRecommendationService({ db }),
    lists: createListService({ db }),
    alerts: createStockAlertService({ db }),
    coupons: createCouponService({ db }),
    shipping: createShippingService({ db }),
    listing: createListingService({ db }),
  };
}

/** App deps: the shared database and the service singletons. */
export function defaultPdpDeps(): PdpDeps {
  return {
    products: new SqliteProductRepository(getDatabase()),
    reviews: getReviewService(),
    qa: getQaService(),
    recommendations: getRecommendationService(),
    lists: getListService(),
    alerts: getStockAlertService(),
    coupons: getCouponService(),
    shipping: getShippingService(),
    listing: getListingService(),
  };
}

export interface PdpLoadInput {
  readonly slug: unknown;
  readonly searchParams?: RawSearchParams | null;
  /** Owner key from `readSessionId()`; `null` = no cookie (bots, first visit). */
  readonly sessionId: string | null;
  /**
   * Epoch ms for the published check, recording and recommendations.
   * Defaults to the request time (`Date.now()`) read here, in the data layer.
   */
  readonly now?: number;
}

export interface PdpCrumb {
  readonly label: string;
  /** Site path; absent for the current page (last crumb). */
  readonly href?: string;
}

export interface PdpViewer {
  /** A cookie was present (rails that need history may render). */
  readonly hasSession: boolean;
  readonly inWishlist: boolean;
  readonly wishlistId: string | null;
  readonly lists: readonly { readonly id: string; readonly name: string }[];
  readonly alertRegistered: boolean;
  readonly alertId: string | null;
  readonly alreadyReviewed: boolean;
}

export interface PdpDelivery {
  readonly estimate: { readonly start: string; readonly end: string } | null;
  readonly methodName?: string;
  readonly isFree?: boolean;
  readonly freeShippingNote?: string | null;
}

export interface PdpRails {
  readonly alsoBought: readonly Product[];
  readonly alsoViewed: readonly Product[];
  readonly related: readonly Product[];
  /** Always `[]` without a session cookie. */
  readonly recentlyViewed: readonly Product[];
}

export interface PdpData {
  readonly product: ProductDetail;
  /** `/products/<slug>` (canonical, query-free). */
  readonly path: string;
  readonly params: PdpParams;
  /** Home, department, category, product. */
  readonly breadcrumb: readonly PdpCrumb[];
  /** `/brand/<slug>` when the product has a brand. */
  readonly brandHref: string | null;
  readonly reviews: ReviewListResult;
  /** Newest published reviews for JSON-LD. */
  readonly recentReviews: readonly Review[];
  readonly qa: QaListResult;
  /** Validated review URL state to keep on Q&A pagination links. */
  readonly qaExtraParams: Readonly<Record<string, string>>;
  readonly bundle: Bundle | null;
  readonly rails: PdpRails;
  readonly boughtLastMonth: number | null;
  readonly bestSellerRank: { readonly rank: number; readonly categoryName: string; readonly categoryHref: string } | null;
  readonly viewer: PdpViewer;
  readonly delivery: PdpDelivery;
  readonly promotedCoupon: { readonly code: string; readonly description: string } | null;
  /** The view was recorded server-side during this load (the client tracker must stay inert). */
  readonly viewRecorded: boolean;
  /**
   * The request clock (epoch ms) this load used, read once here (FIX-card-now):
   * the page derives its badges and the rails' "New" badge from it instead of
   * reading the clock again during render.
   */
  readonly now: number;
}

export type PdpLoadResult = { readonly found: false } | { readonly found: true; readonly data: PdpData };

const NOT_FOUND: PdpLoadResult = Object.freeze({ found: false });

const NO_VIEWER: PdpViewer = Object.freeze({
  hasSession: false,
  inWishlist: false,
  wishlistId: null,
  lists: [],
  alertRegistered: false,
  alertId: null,
  alreadyReviewed: false,
});

/** `/<prefix>/<encoded slug>` for catalogue routes. */
function slugPath(prefix: "category" | "brand" | "products", slug: string): string {
  return `/${prefix}/${encodeURIComponent(slug)}`;
}

/** The rail without the product being viewed (a rail never repeats the current product, P-12). */
export function withoutProduct(products: readonly Product[], productId: string): readonly Product[] {
  return products.some((p) => p.id === productId) ? products.filter((p) => p.id !== productId) : products;
}

function defaultLogError(code: string): void {
  try {
    console.error(`[pdp] ${code}`);
  } catch {
    // Logging must never break the page.
  }
}

/**
 * Product detail without sections, or null for a malformed, unknown or
 * unpublished slug. Used by `generateMetadata` (no writes, no session).
 */
export function loadPublishedProduct(
  slug: unknown,
  now: number = Date.now(),
  products?: PublishedProductReader,
): ProductDetail | null {
  if (!isValidSlug(slug)) return null;
  const repo = products ?? new SqliteProductRepository(getDatabase());
  return repo.getPublishedDetailBySlug(slug, now);
}

/**
 * Everything the PDP renders. `deps` is only built after the slug passes the
 * shape check, so hostile slugs never open the database.
 */
export async function loadPdp(input: PdpLoadInput, deps?: PdpDeps): Promise<PdpLoadResult> {
  const { slug } = input;
  if (!isValidSlug(slug)) return NOT_FOUND;
  const now = input.now ?? Date.now();

  const d = deps ?? defaultPdpDeps();
  const product = loadPublishedProduct(slug, now, d.products);
  if (product === null) return NOT_FOUND;

  const logError = d.logError ?? defaultLogError;
  const sessionId = input.sessionId !== null && isSessionId(input.sessionId) ? input.sessionId : null;
  const params = parsePdpParams(input.searchParams);
  const path = slugPath("products", product.slug);
  const reco = { limit: RAIL_LIMIT, now };

  /** Optional sections degrade to `fallback` instead of failing the page. */
  const optional = async <T>(code: string, fallback: T, read: () => T): Promise<T> => {
    try {
      return read();
    } catch {
      logError(code);
      return fallback;
    }
  };

  // Record first (inside this single loader call) so the history rail below
  // already reflects this view. Never without a cookie (criterion 5).
  let viewRecorded = false;
  if (sessionId !== null) {
    try {
      const result = d.recommendations.recordView(sessionId, product.id, now);
      viewRecorded = result.ok;
    } catch {
      logError("PDP_RECORD_VIEW_FAILED");
    }
  }

  const [
    reviews,
    recentReviews,
    qa,
    bundle,
    alsoBought,
    alsoViewed,
    related,
    recentlyViewed,
    boughtLastMonth,
    rank,
    breadcrumbCategories,
    viewer,
    delivery,
    promotedCoupon,
  ] = await Promise.all([
    (async (): Promise<ReviewListResult> => {
      const result = d.reviews.list(
        product.id,
        {
          sort: params.reviews.sort,
          ...(params.reviews.stars !== undefined ? { stars: params.reviews.stars } : {}),
          verifiedOnly: params.reviews.verifiedOnly,
          page: params.reviews.page,
        },
        sessionId,
      );
      if (!result.ok) throw new Error(`reviews.list failed: ${result.error.code}`);
      return result.value;
    })(),
    optional<readonly Review[]>("PDP_RECENT_REVIEWS_FAILED", [], () => {
      const result = d.reviews.list(product.id, { sort: "recent", page: 1, pageSize: JSON_LD_REVIEWS_FETCH }, null);
      return result.ok ? result.value.items : [];
    }),
    (async (): Promise<QaListResult> => {
      const result = d.qa.list(product.id, { page: params.qpage }, sessionId);
      if (!result.ok) throw new Error(`qa.list failed: ${result.error.code}`);
      return result.value;
    })(),
    optional("PDP_FBT_FAILED", null, () => d.recommendations.frequentlyBoughtTogether(product.id, { now })),
    optional<readonly Product[]>("PDP_ALSO_BOUGHT_FAILED", [], () => d.recommendations.alsoBought(product.id, reco)),
    optional<readonly Product[]>("PDP_ALSO_VIEWED_FAILED", [], () => d.recommendations.alsoViewed(product.id, reco)),
    optional<readonly Product[]>("PDP_RELATED_FAILED", [], () => d.recommendations.related(product.id, reco)),
    optional<readonly Product[]>("PDP_RECENTLY_VIEWED_FAILED", [], () =>
      sessionId === null
        ? []
        : d.recommendations
            .recentlyViewed(sessionId, { limit: RAIL_LIMIT + 1, now })
            .filter((p) => p.id !== product.id)
            .slice(0, RAIL_LIMIT),
    ),
    optional("PDP_BOUGHT_LAST_MONTH_FAILED", null, () => d.recommendations.boughtLastMonth(product.id, now)),
    optional("PDP_RANK_FAILED", null, () => d.listing.rankInCategory(product.id, now)),
    optional<readonly { slug: string; name: string }[]>("PDP_BREADCRUMB_FAILED", [], () =>
      product.category === null ? [] : d.listing.breadcrumb(product.category.slug),
    ),
    optional("PDP_VIEWER_FAILED", NO_VIEWER, () => loadViewer(d, sessionId, product.id, now)),
    optional<PdpDelivery>("PDP_DELIVERY_FAILED", { estimate: null }, () => loadDelivery(d, product, now)),
    optional("PDP_COUPON_FAILED", null, () => {
      const coupon = d.coupons.listPromoted(now)[0];
      return coupon === undefined ? null : { code: coupon.code, description: coupon.description };
    }),
  ]);

  const breadcrumb: PdpCrumb[] = [
    { label: "Home", href: "/" },
    ...breadcrumbCategories.map((c) => ({ label: c.name, href: slugPath("category", c.slug) })),
    { label: product.name },
  ];

  return {
    found: true,
    data: {
      product,
      path,
      params,
      breadcrumb,
      brandHref: product.brand !== null ? slugPath("brand", product.brand.slug) : null,
      reviews,
      recentReviews,
      qa,
      qaExtraParams: reviewsExtraParams(params.reviews),
      bundle,
      rails: {
        alsoBought: withoutProduct(alsoBought, product.id),
        alsoViewed: withoutProduct(alsoViewed, product.id),
        related: withoutProduct(related, product.id),
        recentlyViewed,
      },
      boughtLastMonth,
      bestSellerRank:
        rank === null
          ? null
          : { rank: rank.rank, categoryName: rank.categoryName, categoryHref: slugPath("category", rank.categorySlug) },
      viewer: { ...viewer, hasSession: sessionId !== null },
      delivery,
      promotedCoupon,
      viewRecorded,
      now,
    },
  };
}

/** Wish list / restock alert / review state for the viewer (read-only). */
function loadViewer(d: PdpDeps, sessionId: string | null, productId: string, now: number): PdpViewer {
  if (sessionId === null) return NO_VIEWER;
  const wishlists = d.lists.listLists(sessionId).filter((l) => l.kind === "wishlist");
  const inWishlist = d.lists.isInDefaultList(sessionId, productId);
  const defaultList = wishlists.find((l) => l.isDefault) ?? null;
  const alert = d.alerts.list(sessionId, now).find((a) => a.productId === productId) ?? null;
  return {
    hasSession: true,
    inWishlist,
    wishlistId: inWishlist && defaultList !== null ? defaultList.id : null,
    lists: wishlists.map((l) => ({ id: l.id, name: l.name })),
    alertRegistered: alert !== null,
    alertId: alert?.id ?? null,
    alreadyReviewed: d.reviews.hasReviewed(sessionId, productId),
  };
}

/** Cheapest active shipping method for a single unit, with its date range. */
function loadDelivery(d: PdpDeps, product: ProductDetail, now: number): PdpDelivery {
  if (!Number.isSafeInteger(product.priceCents) || product.priceCents < 0) return { estimate: null };
  const quote = d.shipping.cheapest(product.priceCents);
  if (quote === null) return { estimate: null };
  const estimate = estimateDelivery(quote.method, now, now);
  const threshold = quote.method.freeOverCents;
  const freeShippingNote =
    !quote.isFree && threshold !== null && threshold > 0
      ? `Free shipping on orders of ${formatMoney(threshold, product.currency)} or more`
      : null;
  return { estimate, methodName: quote.method.name, isFree: quote.isFree, freeShippingNote };
}
