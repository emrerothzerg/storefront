import type { Database } from "bun:sqlite";
import type { Product, StockAlert } from "@/lib/types";
import { err, fail, ok, type AppError, type Result } from "@/lib/result";
import { getDatabase, withTransaction } from "@/server/db/client";
import {
  SqliteProductRepository,
  type ProductPublicationLookup,
  type ProductRepository,
} from "@/server/catalog/product-repository";
import { isSessionId } from "@/server/session/session-id";
import { SqliteStockAlertRepository, type StockAlertRepository } from "./stock-alert-repository";

/**
 * Back-in-stock alerts (server-only, in-app only: no email is collected,
 * stored or sent). `sessionId` is the OWNER KEY (guest session or a
 * signed-in user's owner key, both UUID v4). Status is never stored: it is
 * computed from the product's current stock on every read, so restocking a
 * product needs no write to `stock_alerts`. See README.md in this folder.
 */

/** Maximum alerts one session may hold (BACKLOG-phase2 input limits). */
export const MAX_ALERTS_PER_SESSION = 20;

export type StockAlertStatus = "waiting" | "back_in_stock";

export type StockAlertProduct = Pick<Product, "id" | "slug" | "name" | "imageUrl" | "priceCents" | "currency" | "stock">;

export interface StockAlertView extends StockAlert {
  readonly status: StockAlertStatus;
  /**
   * Current product, or null if it is gone (normally unreachable: the FK
   * cascades). When the product is not published at the read's `now`
   * (R-CART-1 family, D-T98-4) its `slug` is "" so no caller can link to a
   * product page that 404s.
   */
  readonly product: StockAlertProduct | null;
  /**
   * True when the product exists and is published at the read's `now`;
   * false when it is unpublished (`published_at` empty or later than `now`)
   * or gone. The service always sets it; optional in the type only so
   * existing hand-built `StockAlertView` literals stay valid (absent = true
   * when `product` is non-null).
   */
  readonly available?: boolean;
}

export interface StockAlertService {
  /**
   * Registers an alert for an out-of-stock product. Idempotent: an existing
   * alert for the same product is returned with `alreadyRegistered: true`
   * (even if the product is back in stock or the session is at the limit).
   * Errors: INVALID_INPUT (invalid session or non-string product id),
   * PRODUCT_NOT_FOUND, INVALID_INPUT with `details.reason: "already_available"`
   * (stock > 0), LIMIT_REACHED (`details.limit`).
   */
  subscribe(sessionId: string, productId: string, now?: number): Result<{ alert: StockAlert; alreadyRegistered: boolean }, AppError>;
  /** Deletes the alert. Errors: INVALID_INPUT (invalid session), NOT_FOUND (malformed, unknown or foreign id). */
  unsubscribe(sessionId: string, alertId: string): Result<void, AppError>;
  /**
   * Sets `acknowledgedAt` (first acknowledgement wins; repeating it is a
   * success that keeps the original time). Allowed in any status.
   * Errors: INVALID_INPUT (invalid session), NOT_FOUND (malformed, unknown or foreign id).
   */
  acknowledge(sessionId: string, alertId: string, now?: number): Result<StockAlert, AppError>;
  /**
   * The session's alerts, newest first, with status from current stock and
   * `available` from publication at `now` (epoch ms; defaults to the
   * service clock). Unpublished products keep their alert (so it can still
   * be stopped or acknowledged) with `product.slug` "" and `available: false`.
   * Invalid session: `[]`. Non-finite `now`: RangeError.
   */
  list(sessionId: string, now?: number): readonly StockAlertView[];
  /** `list` filtered to status back_in_stock and not acknowledged (the banner). */
  listBackInStock(sessionId: string, now?: number): readonly StockAlertView[];
  /** Whether the session has an alert for the product. Invalid input: false. */
  isSubscribed(sessionId: string, productId: string): boolean;
  /** Number of alerts the session holds. Invalid session: 0. */
  countFor(sessionId: string): number;
}

/** Longest id string we bother to look up; anything longer cannot exist. */
const MAX_ID_LENGTH = 200;

/** Thrown inside a transaction to roll it back; converted to `Err` outside. */
class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

function isLookupId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

function toIso(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new RangeError("StockAlertService: now must be a finite epoch-ms number");
  }
  return new Date(ms).toISOString();
}

function toProductSummary(product: Product, published: boolean): StockAlertProduct {
  return {
    id: product.id,
    slug: published ? product.slug : "",
    name: product.name,
    imageUrl: product.imageUrl,
    priceCents: product.priceCents,
    currency: product.currency,
    stock: product.stock,
  };
}

function toView(alert: StockAlert, product: Product | undefined, published: boolean): StockAlertView {
  return {
    id: alert.id,
    productId: alert.productId,
    createdAt: alert.createdAt,
    acknowledgedAt: alert.acknowledgedAt,
    status: product !== undefined && product.stock > 0 ? "back_in_stock" : "waiting",
    product: product === undefined ? null : toProductSummary(product, published),
    available: product !== undefined && published,
  };
}

const INVALID_SESSION_MESSAGE = "A valid session is required for stock alerts";
const NOT_FOUND_MESSAGE = "Stock alert not found";

interface InternalDeps {
  readonly db: Database;
  readonly alerts: StockAlertRepository;
  readonly products: ProductRepository;
  readonly publication: ProductPublicationLookup;
  readonly idGenerator: () => string;
  /** Epoch-ms clock used when a call passes no `now`. */
  readonly now: () => number;
}

class SqliteStockAlertService implements StockAlertService {
  constructor(private readonly deps: InternalDeps) {}

  subscribe(
    sessionId: string,
    productId: string,
    now?: number,
  ): Result<{ alert: StockAlert; alreadyRegistered: boolean }, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", INVALID_SESSION_MESSAGE);
    if (typeof productId !== "string") return fail("INVALID_INPUT", "Product id must be a string");
    if (!isLookupId(productId)) return fail("PRODUCT_NOT_FOUND", "Product not found", { productId });
    const createdAt = toIso(now ?? this.deps.now());
    const { db, alerts, products, idGenerator } = this.deps;

    try {
      return ok(
        withTransaction(db, () => {
          const product = products.getById(productId);
          if (product === null) {
            throw new Abort({ code: "PRODUCT_NOT_FOUND", message: "Product not found", details: { productId } });
          }
          const existing = alerts.findByProduct(sessionId, productId);
          if (existing !== null) return { alert: existing, alreadyRegistered: true };
          if (product.stock > 0) {
            throw new Abort({
              code: "INVALID_INPUT",
              message: `${product.name} is already available`,
              details: { reason: "already_available", productId },
            });
          }
          if (alerts.countForSession(sessionId) >= MAX_ALERTS_PER_SESSION) {
            throw new Abort({
              code: "LIMIT_REACHED",
              message: `You can keep up to ${MAX_ALERTS_PER_SESSION} stock alerts`,
              details: { limit: MAX_ALERTS_PER_SESSION },
            });
          }
          const id = idGenerator();
          if (!alerts.insert(sessionId, { id, productId, createdAt })) {
            // Unreachable under BEGIN IMMEDIATE; kept so a racing writer still yields the existing row.
            const raced = alerts.findByProduct(sessionId, productId);
            if (raced !== null) return { alert: raced, alreadyRegistered: true };
            throw new Error("StockAlertService: insert ignored but no row found");
          }
          const alert: StockAlert = { id, productId, createdAt, acknowledgedAt: null };
          return { alert, alreadyRegistered: false };
        }),
      );
    } catch (e) {
      if (e instanceof Abort) return err(e.error);
      throw e;
    }
  }

  unsubscribe(sessionId: string, alertId: string): Result<void, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", INVALID_SESSION_MESSAGE);
    if (!isLookupId(alertId)) return fail("NOT_FOUND", NOT_FOUND_MESSAGE);
    if (!this.deps.alerts.delete(sessionId, alertId)) return fail("NOT_FOUND", NOT_FOUND_MESSAGE);
    return ok(undefined);
  }

  acknowledge(sessionId: string, alertId: string, now?: number): Result<StockAlert, AppError> {
    if (!isSessionId(sessionId)) return fail("INVALID_INPUT", INVALID_SESSION_MESSAGE);
    if (!isLookupId(alertId)) return fail("NOT_FOUND", NOT_FOUND_MESSAGE);
    const at = toIso(now ?? this.deps.now());
    const { db, alerts } = this.deps;
    const updated = withTransaction(db, () => {
      if (!alerts.acknowledge(sessionId, alertId, at)) return null;
      return alerts.findById(sessionId, alertId);
    });
    return updated === null ? fail("NOT_FOUND", NOT_FOUND_MESSAGE) : ok(updated);
  }

  list(sessionId: string, now?: number): readonly StockAlertView[] {
    if (!isSessionId(sessionId)) return [];
    const nowIso = toIso(now ?? this.deps.now());
    const rows = this.deps.alerts.listForSession(sessionId);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.productId);
    const byId = new Map(this.deps.products.getManyByIds(ids).map((p) => [p.id, p]));
    const published = this.deps.publication.filterPublishedIds(ids, nowIso);
    return rows.map((row) => toView(row, byId.get(row.productId), published.has(row.productId)));
  }

  listBackInStock(sessionId: string, now?: number): readonly StockAlertView[] {
    return this.list(sessionId, now).filter((v) => v.status === "back_in_stock" && v.acknowledgedAt === null);
  }

  isSubscribed(sessionId: string, productId: string): boolean {
    if (!isSessionId(sessionId) || !isLookupId(productId)) return false;
    return this.deps.alerts.findByProduct(sessionId, productId) !== null;
  }

  countFor(sessionId: string): number {
    if (!isSessionId(sessionId)) return 0;
    return this.deps.alerts.countForSession(sessionId);
  }
}

export interface StockAlertServiceDeps {
  readonly db: Database;
  /**
   * Epoch-ms clock for calls that pass no `now` (subscribe/acknowledge
   * timestamps, list publication checks). Defaults to the system clock.
   */
  readonly now?: () => number;
  /** Publication check for `list` (R-CART-1). Defaults to a `SqliteProductRepository` over `db`. */
  readonly publication?: ProductPublicationLookup;
}

export function createStockAlertService(deps: StockAlertServiceDeps): StockAlertService {
  const products = new SqliteProductRepository(deps.db);
  return new SqliteStockAlertService({
    db: deps.db,
    alerts: new SqliteStockAlertRepository(deps.db),
    products,
    publication: deps.publication ?? products,
    idGenerator: () => globalThis.crypto.randomUUID(),
    now: deps.now ?? (() => Date.now()),
  });
}

interface StockAlertServiceCache {
  readonly db: Database;
  readonly service: StockAlertService;
}

const globalForStockAlerts = globalThis as typeof globalThis & {
  __storefrontStockAlertService?: StockAlertServiceCache;
};

/**
 * The app-wide service over `getDatabase()`, cached on `globalThis` (dev HMR
 * safe). Rebuilt if the shared database handle changes.
 */
export function getStockAlertService(): StockAlertService {
  const db = getDatabase();
  const cached = globalForStockAlerts.__storefrontStockAlertService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createStockAlertService({ db });
  globalForStockAlerts.__storefrontStockAlertService = { db, service };
  return service;
}
