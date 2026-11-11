import { computeArrivals } from "@/app/_lib/arrivals";
import type { ShippingArrival } from "@/components/molecules/ShippingMethodPicker";
import type { CartSummaryCart } from "@/components/organisms/CartSummary";
import type { CartTableData, CartTableLine } from "@/components/organisms/CartTable";
import { isAllowedInternalHref } from "@/content/routes";
import type { Product } from "@/lib/types";
import {
  getCartService,
  type CartLineView,
  type CartServiceV2,
  type CartViewV2,
  type SavedForLaterLine,
} from "@/server/cart/cart-service";
import { SqliteProductRepository, type ProductRepository } from "@/server/catalog/product-repository";
import { getListingService, type ListingService } from "@/server/catalog/listing-service";
import { getDatabase } from "@/server/db/client";
import { getListService, type ListService } from "@/server/lists/list-service";
import { getRecommendationService, type RecommendationService } from "@/server/recommendations/recommendation-service";
import { isSessionId } from "@/server/session/session-id";

/**
 * Server-only loader for the `/cart` page v2 (T108). The page reads the owner
 * key with `readSessionId()` (never minted during render, SR10) and hands it
 * here. `now` is read ONCE per call and used for the cart view, every delivery
 * arrival window and the rails. Services are resolved lazily: a request
 * without a (well-formed) owner key only reads the best sellers (catalogue
 * data, D-T108-1) and never touches the cart, lists or session.
 *
 * Nothing returned carries the owner key (R-1): the cart view is copied field
 * by field into the CartTable / CartSummary props.
 */

export const ALSO_BOUGHT_TITLE = "Customers who bought items in your cart also bought";
export const RECENTLY_VIEWED_TITLE = "Your recently viewed items";
export const BEST_SELLERS_TITLE = "Best sellers";
/** Cap for every rail on the page. */
export const CART_RAIL_LIMIT = 12;

export type CartViewReader = Pick<CartServiceV2, "getCartView">;
export type SavedListReader = Pick<ListService, "listLists">;
export type CatalogReader = Pick<ProductRepository, "getManyByIds">;
export type RecommendationReader = Pick<RecommendationService, "forCart" | "recentlyViewed">;
export type BestSellerReader = Pick<ListingService, "bestSellers">;

export interface CartPageDeps {
  /** Defaults to `getCartService()`. Called only with an owner key. */
  readonly getCart?: () => CartViewReader;
  /** Defaults to `getListService()`. Called only when something is saved (save-for-later list id). */
  readonly getLists?: () => SavedListReader;
  /** Defaults to a product repository over `getDatabase()`. Called only when the cart has lines. */
  readonly getProducts?: () => CatalogReader;
  /** Defaults to `getRecommendationService()`. Called only with an owner key. */
  readonly getRecommendations?: () => RecommendationReader;
  /**
   * Defaults to `getListingService()`. Called once for an empty cart: with an
   * owner key, or with none at all (D-T108-1: best sellers are catalogue data).
   */
  readonly getListing?: () => BestSellerReader;
  /** Epoch ms; defaults to `Date.now()` (read once per call). */
  readonly now?: number;
}

export interface CartPageSaved {
  readonly items: readonly SavedForLaterLine[];
  /** The session's save-for-later list id (Delete posts it); null when nothing is saved. */
  readonly listId: string | null;
}

export interface CartPageData {
  /** The one clock used for this request (CartSummary `now`). */
  readonly now: number;
  /** CartTable `cart`: lines with `listPriceCents` from the catalogue. */
  readonly table: CartTableData;
  /** CartSummary `cart`: trimmed copy; `couponNotice` is null because the page shows it as a Notice. */
  readonly summary: CartSummaryCart;
  readonly saved: CartPageSaved;
  /** `/lists/<id>` of the save-for-later list when something is saved and the href is allowed. */
  readonly savedListHref: string | null;
  /** One-time notices from the cart view. */
  readonly couponNotice: string | null;
  /** Passed to CartSummary `shippingNotice` (page-level Notice only when there are no lines). */
  readonly shippingNotice: string | null;
  /** Arrival windows keyed by shipping method id (`estimateDelivery(method, now)`). */
  readonly arrivals: Readonly<Record<string, ShippingArrival>>;
  /** Co-purchased with the cart's items (excluding them); [] for an empty cart. */
  readonly alsoBought: readonly Product[];
  readonly recentlyViewed: readonly Product[];
  /** Suggestions for an empty cart (also without a session, D-T108-1); [] when the cart has lines. */
  readonly bestSellers: readonly Product[];
}

const ZERO_TOTALS: CartViewV2["totals"] = {
  subtotalCents: 0,
  discountCents: 0,
  shippingCents: 0,
  totalCents: 0,
  amountToFreeShippingCents: null,
};

function resolveNow(now: number | undefined): number {
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now();
}

/** The page data for "no cart yet" (no cookie), without suggestions; the loader adds best sellers. */
export function emptyCartPageData(now: number): CartPageData {
  return {
    now,
    table: { items: [], subtotalCents: 0, currency: "USD", itemCount: 0, canCheckout: false },
    summary: {
      items: [],
      itemCount: 0,
      canCheckout: false,
      currency: "USD",
      saved: [],
      coupon: null,
      couponNotice: null,
      shipping: null,
      shippingOptions: [],
      totals: ZERO_TOTALS,
    },
    saved: { items: [], listId: null },
    savedListHref: null,
    couponNotice: null,
    shippingNotice: null,
    arrivals: {},
    alsoBought: [],
    recentlyViewed: [],
    bestSellers: [],
  };
}

function toTableLine(line: CartLineView, listPriceCents: number | null): CartTableLine {
  return {
    productId: line.productId,
    name: line.name,
    slug: line.slug,
    imageUrl: line.imageUrl,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    lineTotalCents: line.lineTotalCents,
    availableStock: line.availableStock,
    status: line.status,
    listPriceCents,
  };
}

/**
 * List ("was") prices for the lines, from ONE `getManyByIds` call. A line
 * whose product vanished or was unpublished (`slug === ""`) gets null so no
 * "You save" text shows for it.
 */
function listPrices(lines: readonly CartLineView[], catalog: CatalogReader): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const products = catalog.getManyByIds(lines.map((line) => line.productId));
  const byId = new Map(products.map((p) => [p.id, p] as const));
  for (const line of lines) {
    const product = byId.get(line.productId);
    const list = product?.listPriceCents;
    out.set(
      line.productId,
      line.slug !== "" && typeof list === "number" && Number.isSafeInteger(list) && list > 0 ? list : null,
    );
  }
  return out;
}

export function toCartTableDataV2(view: CartViewV2, prices: ReadonlyMap<string, number | null>): CartTableData {
  return {
    items: view.items.map((line) => toTableLine(line, prices.get(line.productId) ?? null)),
    subtotalCents: view.subtotalCents,
    currency: view.currency,
    itemCount: view.itemCount,
    canCheckout: view.canCheckout,
  };
}

/** CartSummary input without the owner key; `couponNotice` is shown by the page instead. */
export function toCartSummaryCart(view: CartViewV2): CartSummaryCart {
  return {
    items: view.items.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      status: line.status,
      availableStock: line.availableStock,
    })),
    itemCount: view.itemCount,
    canCheckout: view.canCheckout,
    currency: view.currency,
    saved: view.saved,
    coupon: view.coupon,
    couponNotice: null,
    shipping: view.shipping,
    shippingOptions: view.shippingOptions,
    totals: view.totals,
  };
}

/** Shared with the checkout loader (CONS-B4 aq); re-exported for existing callers. */
export { computeArrivals };

function savedListHrefFor(listId: string | null): string | null {
  if (listId === null) return null;
  const href = `/lists/${encodeURIComponent(listId)}`;
  return isAllowedInternalHref(href) ? href : null;
}

/** Rails are optional page furniture: a failing recommender yields an empty (omitted) rail, never a broken cart. */
function rail(load: () => readonly Product[], exclude: ReadonlySet<string>): readonly Product[] {
  try {
    const products = load();
    return Array.isArray(products) ? products.filter((p) => !exclude.has(p.id)).slice(0, CART_RAIL_LIMIT) : [];
  } catch {
    return [];
  }
}

function nonBlank(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

const defaults = {
  getCart: (): CartViewReader => getCartService(),
  getLists: (): SavedListReader => getListService(),
  getProducts: (): CatalogReader => new SqliteProductRepository(getDatabase()),
  getRecommendations: (): RecommendationReader => getRecommendationService(),
  getListing: (): BestSellerReader => getListingService(),
};

/**
 * Loads everything the cart page renders. `sessionId` null (or not a UUID)
 * = no cart yet: {@link emptyCartPageData} plus best sellers from exactly one
 * `bestSellers` read (D-T108-1); no other service, no session read or mint.
 * Throws when the cart view itself cannot be computed (the route's
 * error boundary handles it); rail failures only empty the rail.
 */
export function loadCartPageV2(sessionId: string | null, deps: CartPageDeps = {}): CartPageData {
  const now = resolveNow(deps.now);
  if (sessionId === null || !isSessionId(sessionId)) {
    const bestSellers = rail(() => (deps.getListing ?? defaults.getListing)().bestSellers(CART_RAIL_LIMIT, { now }), new Set());
    return { ...emptyCartPageData(now), bestSellers };
  }

  // D-T108-3: the options form judges publication (lines + saved items) and
  // the coupon at this request's `now`; the cart service never reads its own clock.
  const result = (deps.getCart ?? defaults.getCart)().getCartView(sessionId, { now });
  if (!result.ok) throw new Error(`Cart could not be loaded: ${result.error.code}`);
  const view = result.value;
  const hasLines = view.items.length > 0;

  const prices = hasLines ? listPrices(view.items, (deps.getProducts ?? defaults.getProducts)()) : new Map();

  let listId: string | null = null;
  if (view.saved.length > 0) {
    const lists = (deps.getLists ?? defaults.getLists)().listLists(sessionId);
    listId = lists.find((list) => list.kind === "save_for_later")?.id ?? null;
  }

  const recos = (deps.getRecommendations ?? defaults.getRecommendations)();
  const inCart = new Set(view.items.map((line) => line.productId));
  const alsoBought = hasLines ? rail(() => recos.forCart(sessionId, { limit: CART_RAIL_LIMIT, now }), inCart) : [];
  const recentlyViewed = rail(() => recos.recentlyViewed(sessionId, { limit: CART_RAIL_LIMIT, now }), new Set());
  const bestSellers = hasLines
    ? []
    : rail(() => (deps.getListing ?? defaults.getListing)().bestSellers(CART_RAIL_LIMIT, { now }), new Set());

  return {
    now,
    table: toCartTableDataV2(view, prices),
    summary: toCartSummaryCart(view),
    saved: { items: view.saved, listId },
    savedListHref: view.saved.length > 0 ? savedListHrefFor(listId) : null,
    couponNotice: nonBlank(view.couponNotice),
    shippingNotice: nonBlank(view.shippingNotice),
    arrivals: hasLines ? computeArrivals(view.shippingOptions, now) : {},
    alsoBought,
    recentlyViewed,
    bestSellers,
  };
}
