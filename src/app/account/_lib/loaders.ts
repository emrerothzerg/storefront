import { unstable_rethrow } from "next/navigation";

import {
  toBackInStockItems,
  type AccountHubBackInStockItem,
  type AccountHubCounts,
} from "@/components/organisms/AccountHub";
import type { Product, Review, SavedAddress } from "@/lib/types";
import type { StockAlertView } from "@/server/alerts/stock-alert-service";
import type { ContactMessageView } from "@/server/contact/contact-service";
import type { QuestionView } from "@/server/qa/qa-service";
import { HISTORY_CAP } from "@/server/recommendations/recommendation-service";
import { isSessionId } from "@/server/session/session-id";

import { defaultAccountServices, type AccountServices, type AccountServicesSource } from "./services";

/**
 * Data loaders for the account pages (T98). Every loader takes the owner key
 * resolved by `loadAccountContext()` and reads ONLY that owner's rows
 * (criterion 2/6). A null / malformed owner key returns the empty shape
 * WITHOUT building the services, so no database read happens (criterion 1).
 * Read-only: nothing here writes or sets cookies. A failing read degrades to
 * the empty value for that section (logged), never a 500 for the whole page.
 * Results carry no owner key (R-1).
 */

export interface LoaderOptions {
  readonly services?: AccountServicesSource;
  /**
   * Epoch ms for the "available product" checks (history, orders, and alert
   * publication, D-T98-4); defaults to each service's clock.
   */
  readonly now?: number;
}

function resolveServices(ownerKey: string | null, options: LoaderOptions): AccountServices | null {
  if (ownerKey === null || !isSessionId(ownerKey)) return null;
  return (options.services ?? defaultAccountServices)();
}

function logFailure(section: string): void {
  try {
    console.error(`[account] read failed section=${section}`);
  } catch {
    // Logging must never break the render.
  }
}

/** Runs one read; any non-Next error becomes `fallback`. */
function attempt<T>(section: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (error) {
    unstable_rethrow(error);
    logFailure(section);
    return fallback;
  }
}

function withServices<T>(ownerKey: string | null, options: LoaderOptions, section: string, empty: T, read: (s: AccountServices, owner: string) => T): T {
  const services = attempt<AccountServices | null>(`${section}.init`, () => resolveServices(ownerKey, options), null);
  if (services === null || ownerKey === null) return empty;
  return attempt(section, () => read(services, ownerKey), empty);
}

// ---------------------------------------------------------------------------
// Browsing history
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  readonly product: Product;
  readonly viewedAt: string;
}

/**
 * Newest first, available products only, capped at the service's
 * `HISTORY_CAP` (50). Delegates to `RecommendationService.listHistory` (the
 * same published + in-stock rule as the "recently viewed" rail).
 */
export function loadHistory(ownerKey: string | null, options: LoaderOptions = {}): readonly HistoryEntry[] {
  return withServices<readonly HistoryEntry[]>(ownerKey, options, "history", [], (s, owner) =>
    s.history.listHistory(owner, { limit: HISTORY_CAP, now: options.now }),
  );
}

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

export interface ContributionProduct {
  readonly slug: string;
  readonly name: string;
}

export interface OwnReview {
  readonly review: Review;
  readonly product: ContributionProduct | null;
}

export interface OwnQuestion {
  readonly id: string;
  /** From `QaService.listMineWithAnswers`: `isOwn` is true, answers nested (published + own unpublished). */
  readonly question: QuestionView;
  readonly published: boolean;
  readonly product: ContributionProduct | null;
}

export interface Contributions {
  readonly reviews: readonly OwnReview[];
  readonly questions: readonly OwnQuestion[];
}

const NO_CONTRIBUTIONS: Contributions = { reviews: [], questions: [] };

export function loadContributions(ownerKey: string | null, options: LoaderOptions = {}): Contributions {
  return withServices(ownerKey, options, "contributions", NO_CONTRIBUTIONS, (s, owner) => {
    const reviews = attempt<readonly Review[]>("contributions.reviews", () => s.reviews.listMine(owner), []);
    const questions = attempt<readonly QuestionView[]>(
      "contributions.questions",
      () => s.qa.listMineWithAnswers(owner).questions,
      [],
    );
    const ids = [...reviews.map((r) => r.productId), ...questions.map((q) => q.productId)];
    const products = new Map(
      attempt<readonly Product[]>("contributions.products", () => (ids.length === 0 ? [] : s.products.getManyByIds(ids)), []).map(
        (p) => [p.id, { slug: p.slug, name: p.name }] as const,
      ),
    );
    return {
      reviews: reviews.map((review) => ({ review, product: products.get(review.productId) ?? null })),
      questions: questions.map((q) => ({
        id: q.id,
        question: q,
        published: q.status === "published",
        product: products.get(q.productId) ?? null,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Alerts, messages, addresses
// ---------------------------------------------------------------------------

/** The owner's alerts; an unpublished product at `options.now` comes back unlinked (`available: false`, D-T98-4). */
export function loadAlerts(ownerKey: string | null, options: LoaderOptions = {}): readonly StockAlertView[] {
  return withServices<readonly StockAlertView[]>(ownerKey, options, "alerts", [], (s, owner) =>
    s.alerts.list(owner, options.now),
  );
}

export function loadMessages(ownerKey: string | null, options: LoaderOptions = {}): readonly ContactMessageView[] {
  return withServices<readonly ContactMessageView[]>(ownerKey, options, "messages", [], (s, owner) =>
    s.contact.listForSession(owner),
  );
}

export function loadAddresses(ownerKey: string | null, options: LoaderOptions = {}): readonly SavedAddress[] {
  return withServices<readonly SavedAddress[]>(ownerKey, options, "addresses", [], (s, owner) => s.addresses.list(owner));
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

export interface HubData {
  readonly counts: AccountHubCounts;
  readonly backInStock: readonly AccountHubBackInStockItem[];
}

export const EMPTY_HUB_COUNTS: AccountHubCounts = {
  orders: 0,
  lists: 0,
  addresses: 0,
  history: 0,
  reviews: 0,
  questions: 0,
  alerts: 0,
  messages: 0,
};

const EMPTY_HUB: HubData = { counts: EMPTY_HUB_COUNTS, backInStock: [] };

/**
 * Tile counts + unacknowledged back-in-stock alerts. Each count is read
 * independently (one failing service shows 0 on its tile only). Orders count
 * all paid orders (range "all"); lists count wish lists (not "Saved for
 * later"); history uses the same rule as `/account/history`.
 */
export function loadHub(ownerKey: string | null, options: LoaderOptions = {}): HubData {
  return withServices(ownerKey, options, "hub", EMPTY_HUB, (s, owner) => {
    const qa = attempt("hub.qa", () => s.qa.listMine(owner), { questions: [], answers: [] });
    const counts: AccountHubCounts = {
      orders: attempt("hub.orders", () => s.orders.listOrders(owner, { range: "all" }, options.now).total, 0),
      lists: attempt("hub.lists", () => s.lists.listLists(owner).filter((l) => l.kind === "wishlist").length, 0),
      addresses: attempt("hub.addresses", () => s.addresses.countFor(owner), 0),
      history: loadHistory(owner, { ...options, services: () => s }).length,
      reviews: attempt("hub.reviews", () => s.reviews.listMine(owner).length, 0),
      questions: qa.questions.length,
      alerts: attempt("hub.alerts", () => s.alerts.countFor(owner), 0),
      messages: attempt("hub.messages", () => s.contact.listForSession(owner).length, 0),
    };
    const backInStock = attempt("hub.backInStock", () => toBackInStockItems(s.alerts.listBackInStock(owner, options.now)), []);
    return { counts, backInStock };
  });
}
