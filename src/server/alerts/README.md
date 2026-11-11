# Stock alerts (`src/server/alerts`)

Session-scoped "tell me when it is back" registrations (task T41). In-app only:
no email is collected, stored, logged or sent (decision D5). The PDP and the
account hub show the status; the banner lists alerts that are back in stock and
not yet acknowledged.

## Files
- `stock-alert-repository.ts` — `SqliteStockAlertRepository`, thin SQL over `stock_alerts`. Bound parameters only; every statement is scoped by `session_id`. Reads with an invalid session id return empty results; writes throw `TypeError` (the service validates first). Returned rows never include the session id.
- `stock-alert-service.ts` — rules and the public contract below.

## Contract
```ts
export const MAX_ALERTS_PER_SESSION = 20;
export type StockAlertStatus = "waiting" | "back_in_stock";
export type StockAlertProduct = Pick<Product, "id" | "slug" | "name" | "imageUrl" | "priceCents" | "currency" | "stock">;
export interface StockAlertView extends StockAlert { readonly status: StockAlertStatus; readonly product: StockAlertProduct | null; readonly available?: boolean /* always set by the service */ }
export interface StockAlertService {
  subscribe(sessionId: string, productId: string, now?: number): Result<{ alert: StockAlert; alreadyRegistered: boolean }, AppError>;
  unsubscribe(sessionId: string, alertId: string): Result<void, AppError>;
  acknowledge(sessionId: string, alertId: string, now?: number): Result<StockAlert, AppError>;
  list(sessionId: string, now?: number): readonly StockAlertView[];
  listBackInStock(sessionId: string, now?: number): readonly StockAlertView[];
  isSubscribed(sessionId: string, productId: string): boolean;
  countFor(sessionId: string): number;
}
export function createStockAlertService(deps: { db: Database; now?: () => number; publication?: ProductPublicationLookup }): StockAlertService;
export function getStockAlertService(): StockAlertService; // globalThis singleton over getDatabase()
```
All methods are synchronous (bun:sqlite). `now` is epoch milliseconds (default: the injected `deps.now` clock, which defaults to the system clock in the factory only); a non-finite value throws `RangeError` (programmer error).

## Rules
- `sessionId` is the OWNER KEY (guest session or signed-in `owner_key`), validated with `isSessionId` before any query. Invalid: mutations return `INVALID_INPUT`; reads return `[]` / `false` / `0`.
- **subscribe** runs in one `BEGIN IMMEDIATE` transaction, in this order:
  1. non-string product id → `INVALID_INPUT`; empty, over 200 chars or unknown → `PRODUCT_NOT_FOUND` (`details.productId`);
  2. existing alert for (session, product) → `ok({ alert: existing, alreadyRegistered: true })`, no write. This wins over the stock and limit checks, so a repeated submit after a restock or at the limit is still a success;
  3. stock > 0 → `INVALID_INPUT` with `details: { reason: "already_available", productId }`;
  4. session already holds 20 → `LIMIT_REACHED` (`details.limit: 20`);
  5. insert (`id = crypto.randomUUID()`, `acknowledged_at = NULL`).
- **status** is never stored: `back_in_stock` when the product's current stock > 0, else `waiting` (also `waiting` with `product: null` if the product row is gone; normally unreachable because the FK cascades deletes). Restocking a product flips the status without any write to `stock_alerts`.
- **publication (D-T98-4, R-CART-1 family)**: `list` judges each product's publication at `now` with `filterPublishedIds(ids, nowIso)` (same rule as the catalog: `published_at <> '' AND published_at <= nowIso`). A product that is unpublished (empty or future `published_at`) keeps its alert, so it can still be stopped or acknowledged, but the view has `product.slug: ""` and `available: false`; unknown and unpublished products are not distinguished. Published: `available: true`. Gone (`product: null`): `available: false`. Status still follows stock. Callers render an unavailable alert's name as text ("No longer available"), never a product link.
- **list** is newest first (`created_at DESC`, then insertion order DESC). **listBackInStock** = `list` filtered to `back_in_stock && acknowledgedAt === null`.
- **acknowledge** is allowed in any status; the first acknowledgement time is kept on repeats. Acknowledged alerts stay in `list` (and keep their computed status) but leave the banner list.
- **unsubscribe / acknowledge**: malformed (non-string, empty, over 200 chars), unknown or another session's id → `NOT_FOUND` (foreign ids are indistinguishable from absent ones).
- Views contain only `id, productId, createdAt, acknowledgedAt, status, available, product{id, slug, name, imageUrl, priceCents, currency, stock}`. Never a session id.

## For callers (T50 actions, StockAlertForm, PDP, AccountHub)
- Actions apply the T31 limiter (`stock alert subscribe`: 10/hour per session, 500/hour global) before `subscribe`, take the session from `getOrCreateSessionId()` (never from the form), and treat `details` as data, never HTML.
- Read paths call `readSessionId()`; with no session (null) skip the call and render `[]` / `false` (a null passed through is also tolerated at runtime and yields empty results).
