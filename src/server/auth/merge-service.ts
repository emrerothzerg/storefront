import type { Database } from "bun:sqlite";
import { err, fail, ok, type AppError, type Result } from "@/lib/result";
import { getDatabase, withTransaction } from "@/server/db/client";
import { isSessionId } from "@/server/session/session-id";
import { createAuthRepository } from "./auth-repository";
import { createMergeRepository, type DroppedCartLine, type MergeLimits } from "./merge-repository";

/**
 * Guest-to-account merge (T117, server-only). Called by the sign-in / sign-up
 * actions (T120) after credentials are verified, with the RAW guest cookie id
 * (`readGuestSessionId()`, K-4) and the user's `owner_key`. Moves every
 * owner-keyed row from the guest id to the owner key in ONE transaction; any
 * failure rolls everything back. Idempotent: a second call finds no guest
 * rows and returns an all-zero summary without writing. See README.md.
 */

export interface MergeSummary {
  readonly movedCartLines: number;
  readonly droppedCartLines: readonly { productId: string; reason: "out_of_stock" | "unknown_product" }[];
  readonly movedLists: number;
  /** Guest wishlists dropped by the 20-list cap (their items are counted in `droppedListItems`). */
  readonly droppedLists: number;
  readonly mergedListItems: number;
  readonly droppedListItems: number;
  readonly movedViews: number;
  readonly droppedViews: number;
  readonly movedReviews: number;
  readonly droppedReviews: number;
  readonly movedQuestions: number;
  readonly movedAnswers: number;
  readonly droppedVotes: number;
  readonly movedAlerts: number;
  readonly droppedAlerts: number;
  readonly movedMessages: number;
  readonly movedAddresses: number;
  readonly droppedAddresses: number;
  readonly movedOrders: number;
  readonly movedRedemptions: number;
  readonly droppedRedemptions: number;
}

export interface MergeService {
  /**
   * Errors (nothing changes in every case): VALIDATION_FAILED with
   * `details.reason` one of "invalid_guest_id", "invalid_owner_key",
   * "same_id", "guest_is_owner_key" (guest id is a user's owner key or the
   * deleted-account tombstone), "unknown_owner" (owner key is not a user's),
   * "invalid_clock", or "merge_failed" (a database error; rolled back and
   * logged without ids or PII).
   */
  mergeGuestIntoUser(guestSessionId: unknown, ownerKey: unknown, now?: number): Result<MergeSummary, AppError>;
}

/** Caps (BACKLOG-phase2 input limits; mirrored here because other services are not imported). */
export const MERGE_LIMITS: MergeLimits = {
  maxWishlists: 20,
  maxItemsPerList: 200,
  maxListNameLength: 60,
  maxViews: 50,
  maxAlerts: 20,
  maxAddresses: 10,
};

/**
 * Tombstone owner key for deleted accounts' orders (ruling R-1, owned by T118).
 * It is a valid UUID v4, so it must never be accepted as a guest id: merging
 * it would hand every deleted user's orders to the caller.
 */
export const DELETED_OWNER_KEY = "00000000-0000-4000-8000-000000000000";

export const EMPTY_MERGE_SUMMARY: MergeSummary = Object.freeze({
  movedCartLines: 0,
  droppedCartLines: Object.freeze([]) as readonly DroppedCartLine[],
  movedLists: 0,
  droppedLists: 0,
  mergedListItems: 0,
  droppedListItems: 0,
  movedViews: 0,
  droppedViews: 0,
  movedReviews: 0,
  droppedReviews: 0,
  movedQuestions: 0,
  movedAnswers: 0,
  droppedVotes: 0,
  movedAlerts: 0,
  droppedAlerts: 0,
  movedMessages: 0,
  movedAddresses: 0,
  droppedAddresses: 0,
  movedOrders: 0,
  movedRedemptions: 0,
  droppedRedemptions: 0,
});

/** Thrown inside the transaction to roll it back; converted to `Err` outside. */
class Abort extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

const invalid = (reason: string): AppError => ({
  code: "VALIDATION_FAILED",
  message: "Could not merge guest data into the account.",
  details: { reason },
});

/** SQLite extended result code, if any (safe to log: never contains values). */
function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
    return error.name;
  }
  return "unknown";
}

export function createMergeService(deps: { db: Database; logger?: Pick<Console, "error"> }): MergeService {
  const { db } = deps;
  const logger = deps.logger ?? console;
  const auth = createAuthRepository(db);
  const repo = createMergeRepository(db);

  return {
    mergeGuestIntoUser(guestSessionId, ownerKey, now) {
      if (!isSessionId(guestSessionId)) return err(invalid("invalid_guest_id"));
      if (!isSessionId(ownerKey)) return err(invalid("invalid_owner_key"));
      if (guestSessionId === ownerKey) return err(invalid("same_id"));
      const ms = now ?? Date.now();
      if (typeof ms !== "number" || !Number.isFinite(ms)) return err(invalid("invalid_clock"));
      const nowIso = new Date(ms).toISOString();
      const guest = guestSessionId;
      const owner = ownerKey;

      try {
        return withTransaction(db, () => {
          // Guards run inside the write transaction so they cannot go stale.
          if (guest === DELETED_OWNER_KEY || auth.findUserByOwnerKey(guest) !== null) {
            throw new Abort(invalid("guest_is_owner_key"));
          }
          if (auth.findUserByOwnerKey(owner) === null) throw new Abort(invalid("unknown_owner"));

          const cart = repo.mergeCart(guest, owner, nowIso);
          const lists = repo.mergeLists(guest, owner, nowIso, MERGE_LIMITS);
          const views = repo.mergeViews(guest, owner, MERGE_LIMITS);
          const community = repo.mergeReviewsAndQa(guest, owner);
          const alerts = repo.mergeStockAlerts(guest, owner, MERGE_LIMITS);
          const movedMessages = repo.mergeContactMessages(guest, owner);
          const addresses = repo.mergeAddresses(guest, owner, nowIso, MERGE_LIMITS);
          const movedOrders = repo.mergeOrders(guest, owner);
          const redemptions = repo.mergeCouponRedemptions(guest, owner);

          const summary: MergeSummary = {
            movedCartLines: cart.movedCartLines,
            droppedCartLines: cart.droppedCartLines,
            movedLists: lists.movedLists,
            droppedLists: lists.droppedLists,
            mergedListItems: lists.mergedListItems,
            droppedListItems: lists.droppedListItems,
            movedViews: views.moved,
            droppedViews: views.dropped,
            movedReviews: community.movedReviews,
            droppedReviews: community.droppedReviews,
            movedQuestions: community.movedQuestions,
            movedAnswers: community.movedAnswers,
            droppedVotes: community.droppedVotes,
            movedAlerts: alerts.moved,
            droppedAlerts: alerts.dropped,
            movedMessages,
            movedAddresses: addresses.moved,
            droppedAddresses: addresses.dropped,
            movedOrders,
            movedRedemptions: redemptions.moved,
            droppedRedemptions: redemptions.dropped,
          };
          return ok(summary);
        });
      } catch (error) {
        if (error instanceof Abort) return err(error.error);
        // No ids, emails or row values: only the error class/code.
        logger.error("[merge-service] guest merge failed and was rolled back", { code: errorCode(error) });
        return fail("VALIDATION_FAILED", "Could not merge guest data into the account.", { reason: "merge_failed" });
      }
    },
  };
}

interface MergeServiceCache {
  readonly db: Database;
  readonly service: MergeService;
}

const globalForMerge = globalThis as typeof globalThis & {
  __storefrontMergeService?: MergeServiceCache;
};

/**
 * The app-wide service over `getDatabase()`, cached on `globalThis` (dev HMR
 * safe). Rebuilt if the shared database handle changes.
 */
export function getMergeService(): MergeService {
  const db = getDatabase();
  const cached = globalForMerge.__storefrontMergeService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createMergeService({ db });
  globalForMerge.__storefrontMergeService = { db, service };
  return service;
}
