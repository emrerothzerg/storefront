import type { Database } from "bun:sqlite";
import type { Product } from "@/lib/types";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import { sumCents } from "@/lib/money";
import { getDatabase } from "@/server/db/client";
import { SqliteProductRepository, type ProductRepository } from "@/server/catalog/product-repository";
import { isSessionId } from "@/server/session/session-id";
import { SqliteHistoryRepository, type HistoryRepository } from "./history-repository";
import {
  SqliteRecommendationRepository,
  type CandidateQuery,
  type RecommendationRepository,
} from "./recommendation-repository";

/**
 * Recommendations and browsing history (server-only, synchronous). Pure SQL
 * co-occurrence over paid `order_items` and `product_views` with category /
 * brand fallbacks (BACKLOG D8). See README.md in this folder.
 */

export const RECO_DEFAULT_LIMIT = 12;
export const FBT_MIN_CO_PURCHASES = 2;
export const BOUGHT_LAST_MONTH_MIN_UNITS = 5;
export const HISTORY_CAP = 50;
/** Upper bound for `RecoOptions.limit`; larger values are capped. */
export const RECO_MAX_LIMIT = 50;
/** Longest product / category id accepted before any SQL runs. */
export const MAX_ID_LENGTH = 200;
/** Window of `boughtLastMonth`. */
export const BOUGHT_LAST_MONTH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Max companions in a frequently-bought-together bundle. */
export const FBT_MAX_COMPANIONS = 2;

export interface RecoOptions {
  /** Default `RECO_DEFAULT_LIMIT`; capped at `RECO_MAX_LIMIT`; not a positive safe integer → `[]`. */
  readonly limit?: number;
  /** Epoch ms used for the "published" check; default the service clock. */
  readonly now?: number;
}

export interface Bundle {
  /** Main product first, then 0..2 companions. */
  readonly items: readonly Product[];
  /** Exact integer sum of the items' current `priceCents`. */
  readonly totalCents: number;
}

/** One browsing-history row: the product and when the owner last viewed it (ISO 8601 UTC). */
export interface HistoryItem {
  readonly product: Product;
  readonly viewedAt: string;
}

export interface RecommendationService {
  alsoViewed(productId: string, o?: RecoOptions): readonly Product[];
  alsoBought(productId: string, o?: RecoOptions): readonly Product[];
  /** `null` when the product is unknown or unavailable (unpublished / out of stock). */
  frequentlyBoughtTogether(productId: string, o?: RecoOptions): Bundle | null;
  /** Same category then same brand, rating-weighted. */
  related(productId: string, o?: RecoOptions): readonly Product[];
  /** Categories / brands of the session's recent views. */
  inspiredBy(sessionId: string, o?: RecoOptions): readonly Product[];
  buyAgain(sessionId: string, o?: RecoOptions): readonly Product[];
  /** Co-purchased with the cart's items, excluding them. */
  forCart(sessionId: string, o?: RecoOptions): readonly Product[];
  popularInCategory(categoryId: string, o?: RecoOptions): readonly Product[];
  recentlyViewed(sessionId: string, o?: RecoOptions): readonly Product[];
  /**
   * `recentlyViewed` with timestamps: same availability rule (published +
   * in stock at `o.now`), newest first. `limit` defaults to `HISTORY_CAP`
   * (capped at `RECO_MAX_LIMIT`); a bad owner key or limit → `[]`.
   */
  listHistory(ownerKey: string, o?: RecoOptions): readonly HistoryItem[];
  /** Paid units in the last 30 days; `null` below `BOUGHT_LAST_MONTH_MIN_UNITS`. */
  boughtLastMonth(productId: string, now?: number): number | null;
  /** Upsert + trim to `HISTORY_CAP`. NOT_FOUND for an unknown product; INVALID_INPUT for bad ids (no SQL). */
  recordView(sessionId: string, productId: string, now?: number): Result<void, AppError>;
  removeView(sessionId: string, productId: string): void;
  clearViews(sessionId: string): void;
}

export interface RecommendationServiceDeps {
  readonly db: Database;
  /** Clock in epoch ms; default `Date.now`. */
  readonly now?: () => number;
}

interface InternalDeps {
  readonly recos: RecommendationRepository;
  readonly history: HistoryRepository;
  readonly products: ProductRepository;
  readonly now: () => number;
}

/** Validated query context for one call. */
interface Ctx {
  readonly nowIso: string;
  readonly limit: number;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Valid epoch ms inside the Date range, else null. */
function validMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

class SqlRecommendationService implements RecommendationService {
  constructor(private readonly deps: InternalDeps) {}

  private clock(now: number | undefined): number {
    return validMs(now) ?? this.deps.now();
  }

  /** `null` means "return nothing" (limit 0, negative, fractional, NaN...). */
  private ctx(o: RecoOptions | undefined): Ctx | null {
    const raw = o?.limit;
    let limit = RECO_DEFAULT_LIMIT;
    if (raw !== undefined) {
      if (!Number.isSafeInteger(raw) || raw <= 0) return null;
      limit = Math.min(raw, RECO_MAX_LIMIT);
    }
    return { nowIso: toIso(this.clock(o?.now)), limit };
  }

  /**
   * Primary ids first, then the fallback chain: best sellers in `categoryIds`,
   * global best sellers, newest. Never returns an excluded or duplicate id.
   */
  private fill(
    ctx: Ctx,
    primary: readonly string[],
    exclude: readonly string[],
    categoryIds: readonly string[],
  ): Product[] {
    const chosen: string[] = [];
    const blocked = new Set(exclude);
    const take = (ids: readonly string[]) => {
      for (const id of ids) {
        if (chosen.length >= ctx.limit) return;
        if (blocked.has(id)) continue;
        blocked.add(id);
        chosen.push(id);
      }
    };
    take(primary);
    const q = (): CandidateQuery => ({ nowIso: ctx.nowIso, exclude: [...blocked], limit: ctx.limit - chosen.length });
    if (chosen.length < ctx.limit && categoryIds.length > 0) take(this.deps.recos.categoryBestSellers(categoryIds, q()));
    if (chosen.length < ctx.limit) take(this.deps.recos.globalBestSellers(q()));
    if (chosen.length < ctx.limit) take(this.deps.recos.newest(q()));
    return this.deps.products.getManyByIds(chosen);
  }

  /** Source facts + category list for product-anchored recommenders; unknown/invalid id → none. */
  private source(productId: string, ctx: Ctx) {
    const facts = isId(productId) ? this.deps.recos.productFacts(productId, ctx.nowIso) : null;
    return {
      facts,
      exclude: isId(productId) ? [productId] : [],
      categories: facts?.categoryId != null ? [facts.categoryId] : [],
    };
  }

  alsoViewed(productId: string, o?: RecoOptions): readonly Product[] {
    const ctx = this.ctx(o);
    if (ctx === null) return [];
    const { facts, exclude, categories } = this.source(productId, ctx);
    const primary =
      facts === null ? [] : this.deps.recos.coViewed(facts.id, { ...ctx, exclude }).map((s) => s.id);
    return this.fill(ctx, primary, exclude, categories);
  }

  alsoBought(productId: string, o?: RecoOptions): readonly Product[] {
    const ctx = this.ctx(o);
    if (ctx === null) return [];
    const { facts, exclude, categories } = this.source(productId, ctx);
    const primary =
      facts === null ? [] : this.deps.recos.coPurchased([facts.id], 1, { ...ctx, exclude }).map((s) => s.id);
    return this.fill(ctx, primary, exclude, categories);
  }

  frequentlyBoughtTogether(productId: string, o?: RecoOptions): Bundle | null {
    const nowIso = toIso(this.clock(o?.now));
    if (!isId(productId)) return null;
    const facts = this.deps.recos.productFacts(productId, nowIso);
    if (facts === null || !facts.available) return null;
    const [main] = this.deps.products.getManyByIds([facts.id]);
    if (main === undefined) return null;

    const sameCurrency = (p: Product) => p.currency === main.currency;
    const coIds = this.deps.recos
      .coPurchased([main.id], FBT_MIN_CO_PURCHASES, { nowIso, exclude: [main.id], limit: RECO_MAX_LIMIT })
      .map((s) => s.id);
    let companions = this.deps.products.getManyByIds(coIds).filter(sameCurrency).slice(0, FBT_MAX_COMPANIONS);
    if (companions.length === 0) {
      companions = this.related(main.id, { limit: RECO_MAX_LIMIT, now: Date.parse(nowIso) })
        .filter(sameCurrency)
        .slice(0, FBT_MAX_COMPANIONS);
    }
    let items: Product[] = [main, ...companions];
    let total = sumCents(items.map((p) => p.priceCents));
    if (!total.ok) {
      // Only reachable with absurd catalogue prices: offer the main product alone.
      items = [main];
      total = ok(main.priceCents);
    }
    return { items, totalCents: total.value };
  }

  related(productId: string, o?: RecoOptions): readonly Product[] {
    const ctx = this.ctx(o);
    if (ctx === null) return [];
    const { facts, exclude, categories } = this.source(productId, ctx);
    const primary =
      facts === null ? [] : this.deps.recos.related(facts.categoryId, facts.brandId, { ...ctx, exclude });
    return this.fill(ctx, primary, exclude, categories);
  }

  inspiredBy(sessionId: string, o?: RecoOptions): readonly Product[] {
    const ctx = this.ctx(o);
    if (ctx === null || !isSessionId(sessionId)) return [];
    const viewed = this.deps.recos.viewedIds(sessionId);
    const primary =
      viewed.length === 0
        ? []
        : this.deps.recos.inspiredBy(sessionId, { ...ctx, exclude: viewed }).map((s) => s.id);
    return this.fill(ctx, primary, viewed, this.deps.recos.categoryIdsOf(viewed));
  }

  buyAgain(sessionId: string, o?: RecoOptions): readonly Product[] {
    const ctx = this.ctx(o);
    if (ctx === null || !isSessionId(sessionId)) return [];
    // A history list, not a recommender: no best-seller fallback (README).
    return this.deps.products.getManyByIds(this.deps.recos.buyAgain(sessionId, { ...ctx, exclude: [] }));
  }

  forCart(sessionId: string, o?: RecoOptions): readonly Product[] {
    const ctx = this.ctx(o);
    if (ctx === null || !isSessionId(sessionId)) return [];
    const cart = this.deps.recos.cartProductIds(sessionId);
    const primary =
      cart.length === 0
        ? []
        : this.deps.recos.coPurchased(cart, 1, { ...ctx, exclude: cart }).map((s) => s.id);
    return this.fill(ctx, primary, cart, this.deps.recos.categoryIdsOf(cart));
  }

  popularInCategory(categoryId: string, o?: RecoOptions): readonly Product[] {
    const ctx = this.ctx(o);
    if (ctx === null) return [];
    const known = isId(categoryId) && this.deps.recos.categoryExists(categoryId);
    return this.fill(ctx, [], [], known ? [categoryId] : []);
  }

  recentlyViewed(sessionId: string, o?: RecoOptions): readonly Product[] {
    const ctx = this.ctx(o);
    if (ctx === null || !isSessionId(sessionId)) return [];
    // A history list, not a recommender: no best-seller fallback (README).
    const views = this.deps.history.listAvailableViews(sessionId, ctx.nowIso, ctx.limit);
    return this.deps.products.getManyByIds(views.map((v) => v.productId));
  }

  listHistory(ownerKey: string, o?: RecoOptions): readonly HistoryItem[] {
    const ctx = this.ctx({ limit: o?.limit ?? HISTORY_CAP, now: o?.now });
    if (ctx === null || !isSessionId(ownerKey)) return [];
    const views = this.deps.history.listAvailableViews(ownerKey, ctx.nowIso, ctx.limit);
    if (views.length === 0) return [];
    const byId = new Map(this.deps.products.getManyByIds(views.map((v) => v.productId)).map((p) => [p.id, p]));
    const items: HistoryItem[] = [];
    for (const view of views) {
      const product = byId.get(view.productId);
      if (product !== undefined) items.push({ product, viewedAt: view.viewedAt });
    }
    return items;
  }

  boughtLastMonth(productId: string, now?: number): number | null {
    if (!isId(productId)) return null;
    const until = this.clock(now);
    const since = Math.max(until - BOUGHT_LAST_MONTH_WINDOW_MS, -8.64e15);
    const units = this.deps.recos.unitsSold(productId, toIso(since), toIso(until));
    return units >= BOUGHT_LAST_MONTH_MIN_UNITS ? units : null;
  }

  recordView(sessionId: string, productId: string, now?: number): Result<void, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", "Invalid session");
    if (!isId(productId)) return fail("INVALID_INPUT", "Invalid product id");
    if (!this.deps.history.productExists(productId)) {
      return fail("NOT_FOUND", "Product not found", { productId });
    }
    this.deps.history.recordView(sessionId, productId, toIso(this.clock(now)), HISTORY_CAP);
    return ok(undefined);
  }

  removeView(sessionId: string, productId: string): void {
    if (!isSessionId(sessionId) || !isId(productId)) return;
    this.deps.history.removeView(sessionId, productId);
  }

  clearViews(sessionId: string): void {
    if (!isSessionId(sessionId)) return;
    this.deps.history.clearViews(sessionId);
  }
}

export function createRecommendationService(deps: RecommendationServiceDeps): RecommendationService {
  return new SqlRecommendationService({
    recos: new SqliteRecommendationRepository(deps.db),
    history: new SqliteHistoryRepository(deps.db),
    products: new SqliteProductRepository(deps.db),
    now: deps.now ?? Date.now,
  });
}

interface RecommendationServiceCache {
  readonly db: Database;
  readonly service: RecommendationService;
}

const globalForRecommendations = globalThis as typeof globalThis & {
  __storefrontRecommendationService?: RecommendationServiceCache;
};

/**
 * The app-wide service over `getDatabase()`, cached on `globalThis` (dev HMR
 * safe). Rebuilt if the shared database handle changes.
 */
export function getRecommendationService(): RecommendationService {
  const db = getDatabase();
  const cached = globalForRecommendations.__storefrontRecommendationService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createRecommendationService({ db });
  globalForRecommendations.__storefrontRecommendationService = { db, service };
  return service;
}
