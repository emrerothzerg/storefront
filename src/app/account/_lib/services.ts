import type { Database } from "bun:sqlite";

import type { Product } from "@/lib/types";
import { createAddressService, getAddressService, type AddressService } from "@/server/addresses/address-service";
import {
  createStockAlertService,
  getStockAlertService,
  type StockAlertService,
} from "@/server/alerts/stock-alert-service";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { createContactService, getContactService, type ContactService } from "@/server/contact/contact-service";
import { getDatabase } from "@/server/db/client";
import { createListService, getListService, type ListService } from "@/server/lists/list-service";
import { createOrderService, getOrderService, type OrderServiceV2 } from "@/server/orders/order-service";
import { createQaService, getQaService, type OwnQaReader, type QaService } from "@/server/qa/qa-service";
import {
  createRecommendationService,
  getRecommendationService,
  type RecommendationService,
} from "@/server/recommendations/recommendation-service";
import { createReviewService, getReviewService, type ReviewService } from "@/server/reviews/review-service";

/** The read surface the account pages use (narrowed so tests can fake it). */
export interface AccountServices {
  readonly addresses: Pick<AddressService, "list" | "countFor">;
  readonly alerts: Pick<StockAlertService, "list" | "listBackInStock" | "countFor">;
  readonly contact: Pick<ContactService, "listForSession">;
  /** Browsing history with timestamps (T36 `listHistory`; read-only). */
  readonly history: Pick<RecommendationService, "listHistory">;
  readonly lists: Pick<ListService, "listLists">;
  readonly orders: Pick<OrderServiceV2, "listOrders">;
  /** `listMine` for the hub count; `listMineWithAnswers` for the contributions page (answers nested). */
  readonly qa: Pick<QaService, "listMine"> & Pick<OwnQaReader, "listMineWithAnswers">;
  readonly reviews: Pick<ReviewService, "listMine">;
  readonly products: { getManyByIds(ids: readonly string[]): readonly Product[] };
}

/**
 * Builds services on demand. Loaders call it only once they hold an owner
 * key, so a request without a cookie never opens the database.
 */
export type AccountServicesSource = () => AccountServices;

/** Services over one database handle (tests use a seeded `:memory:` DB). */
export function createAccountServices(db: Database): AccountServices {
  return {
    addresses: createAddressService({ db }),
    alerts: createStockAlertService({ db }),
    contact: createContactService({ db }),
    history: createRecommendationService({ db }),
    lists: createListService({ db }),
    orders: createOrderService(db),
    qa: createQaService({ db }),
    reviews: createReviewService({ db }),
    products: new SqliteProductRepository(db),
  };
}

/** The app-wide `getXService()` singletons over `getDatabase()`. Opens the DB. */
export const defaultAccountServices: AccountServicesSource = () => {
  const db = getDatabase();
  return {
    addresses: getAddressService(),
    alerts: getStockAlertService(),
    contact: getContactService(),
    history: getRecommendationService(),
    lists: getListService(),
    orders: getOrderService(),
    qa: getQaService(),
    reviews: getReviewService(),
    products: new SqliteProductRepository(db),
  };
};
