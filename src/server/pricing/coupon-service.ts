import type { Database } from "bun:sqlite";
import { formatMoney } from "@/lib/money";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import type { CouponKind } from "@/lib/types";
import { getDatabase, withTransaction } from "@/server/db/client";
import { normalizeCouponCode } from "@/server/security/text-guard";
import { isSessionId } from "@/server/session/session-id";
import { checkCents } from "./totals";

/**
 * Coupon validation, promoted-coupon listing and redemption SQL helpers.
 * See ./README.md for the error-code order and the redemption protocol.
 */

/** Currency used in human-readable coupon descriptions (single-currency store). */
export const COUPON_DESCRIPTION_CURRENCY = "USD";

/** One message for every COUPON_INVALID cause so codes cannot be enumerated. */
export const COUPON_INVALID_MESSAGE = "That promo code is not valid.";

export interface ValidatedCoupon {
  readonly code: string;
  readonly kind: CouponKind;
  readonly value: number;
  readonly promoted: boolean;
  /** Human text, e.g. "10% off", "$5 off orders of $25 or more" (whole dollars without cents). */
  readonly description: string;
}

/**
 * Promoted coupon view (`listPromoted`): a `ValidatedCoupon` plus the
 * conditions a banner shows. Additive (T96); `validate` still returns the
 * plain `ValidatedCoupon`.
 */
export interface PromotedCoupon extends ValidatedCoupon {
  /** Minimum subtotal in cents; `null` when the coupon has no minimum (0). */
  readonly minSubtotalCents: number | null;
  /** Expiry instant as ISO 8601 UTC (`toISOString()`); `null` when the coupon never expires. */
  readonly expiresAt: string | null;
}

export interface CouponService {
  /**
   * Error order: COUPON_INVALID (charset/length, unknown, inactive; one
   * message) -> COUPON_EXPIRED -> COUPON_EXHAUSTED -> COUPON_USED ->
   * COUPON_MIN_SUBTOTAL (details.shortfallCents, minSubtotalCents).
   * Invalid subtotal -> INVALID_INPUT / MONEY_OVERFLOW (checked first).
   * `sessionId` null or not a UUID -> no per-session check.
   */
  validate(code: unknown, subtotalCents: number, sessionId: string | null, now?: number): Result<ValidatedCoupon, AppError>;
  /** Active, promoted, inside its date window and not exhausted; ordered by code. */
  listPromoted(now?: number): readonly PromotedCoupon[];
  /**
   * Atomically records one redemption (INSERT redemption + guarded
   * used_count increment) in a savepoint; call it inside the order
   * transaction. Errors: COUPON_INVALID (bad/unknown/inactive code),
   * INVALID_INPUT (bad session or order id), COUPON_USED (session already
   * redeemed), COUPON_EXHAUSTED (max_uses reached). On error nothing is written.
   */
  recordRedemption(db: Database, code: string, sessionId: string, orderId: string): Result<void, AppError>;
  /** Deletes the session's redemption and decrements used_count (never below 0). No-op when absent or inputs invalid. */
  releaseRedemption(db: Database, code: string, sessionId: string): void;
  /**
   * Deletes only the redemption row recorded for `orderId` (code + owner key +
   * order id) and decrements used_count only when that row was deleted (never
   * below 0). A row owned by another order (e.g. kept after a guest merge) is
   * left alone. No-op when absent or inputs invalid.
   */
  releaseRedemptionForOrder(db: Database, code: string, ownerKey: string, orderId: string): void;
}

export interface CouponServiceDeps {
  readonly db: Database;
  /** Default clock (epoch ms) when a call does not pass `now`. */
  readonly now?: () => number;
}

interface CouponRow {
  readonly code: string;
  readonly kind: string;
  readonly value: number;
  readonly min_subtotal_cents: number;
  readonly max_uses: number | null;
  readonly used_count: number;
  readonly starts_at: string | null;
  readonly expires_at: string | null;
  readonly is_active: number;
  readonly promoted: number;
}

const COUPON_COLUMNS =
  "code, kind, value, min_subtotal_cents, max_uses, used_count, starts_at, expires_at, is_active, promoted";

/** Max order id length accepted by recordRedemption (order ids are UUIDs; generous cap). */
const ORDER_ID_MAX_LENGTH = 128;

function isCouponKind(value: string): value is CouponKind {
  return value === "percent" || value === "fixed" || value === "free_shipping";
}

function money(cents: number): string {
  return formatMoney(cents, COUPON_DESCRIPTION_CURRENCY);
}

/** Description money: whole-dollar amounts drop the cents ("$20", "$10,000"); others keep them ("$4.50"). */
function descriptionMoney(cents: number): string {
  const formatted = money(cents);
  return cents % 100 === 0 ? formatted.replace(/\.00$/, "") : formatted;
}

/** Human description of a coupon, e.g. "Free shipping on orders of $20 or more", "$4.50 off". */
export function describeCoupon(kind: CouponKind, value: number, minSubtotalCents: number): string {
  const base = kind === "percent" ? `${value}% off` : kind === "fixed" ? `${descriptionMoney(value)} off` : "Free shipping";
  if (minSubtotalCents <= 0) return base;
  const joiner = kind === "free_shipping" ? " on" : "";
  return `${base}${joiner} orders of ${descriptionMoney(minSubtotalCents)} or more`;
}

function toValidated(row: CouponRow, kind: CouponKind): ValidatedCoupon {
  return {
    code: row.code,
    kind,
    value: row.value,
    promoted: row.promoted === 1,
    description: describeCoupon(kind, row.value, row.min_subtotal_cents),
  };
}

/** `expires_at` as the instant `windowState` enforces, normalised to ISO UTC; null when absent/unparseable. */
function expiryIso(raw: string | null): string | null {
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function toPromoted(row: CouponRow, kind: CouponKind): PromotedCoupon {
  return {
    ...toValidated(row, kind),
    minSubtotalCents: row.min_subtotal_cents > 0 ? row.min_subtotal_cents : null,
    expiresAt: expiryIso(row.expires_at),
  };
}

type WindowState = "open" | "expired" | "corrupt";

/** Before starts_at or after expires_at -> expired (the exact expires_at instant is still valid). */
function windowState(row: CouponRow, now: number): WindowState {
  if (row.starts_at !== null) {
    const start = Date.parse(row.starts_at);
    if (Number.isNaN(start)) return "corrupt";
    if (now < start) return "expired";
  }
  if (row.expires_at !== null) {
    const end = Date.parse(row.expires_at);
    if (Number.isNaN(end)) return "corrupt";
    if (now > end) return "expired";
  }
  return "open";
}

function isExhausted(row: CouponRow): boolean {
  return row.max_uses !== null && row.used_count >= row.max_uses;
}

function invalid(): Result<never, AppError> {
  return fail("COUPON_INVALID", COUPON_INVALID_MESSAGE);
}

/** Thrown inside the savepoint to roll back; converted to a Result. */
class RedemptionAbort extends Error {
  constructor(readonly appError: AppError) {
    super(appError.message);
  }
}

function findCoupon(db: Database, code: string): CouponRow | null {
  return db.query<CouponRow, [string]>(`SELECT ${COUPON_COLUMNS} FROM coupons WHERE code = ?`).get(code);
}

function hasRedeemed(db: Database, code: string, sessionId: string): boolean {
  return (
    db
      .query<{ one: number }, [string, string]>(
        "SELECT 1 AS one FROM coupon_redemptions WHERE coupon_code = ? AND session_id = ?",
      )
      .get(code, sessionId) !== null
  );
}

export function recordRedemption(db: Database, code: string, sessionId: string, orderId: string): Result<void, AppError> {
  const normalized = normalizeCouponCode(code);
  if (!normalized.ok) return normalized;
  if (!isSessionId(sessionId)) return fail("INVALID_INPUT", "Invalid session", { field: "sessionId" });
  if (typeof orderId !== "string" || orderId.length === 0 || orderId.length > ORDER_ID_MAX_LENGTH) {
    return fail("INVALID_INPUT", "Invalid order id", { field: "orderId" });
  }
  const couponCode = normalized.value;
  try {
    withTransaction(db, (tx) => {
      const row = findCoupon(tx, couponCode);
      if (row === null || row.is_active !== 1) throw new RedemptionAbort({ code: "COUPON_INVALID", message: COUPON_INVALID_MESSAGE });
      const inserted = tx
        .query<unknown, [string, string, string]>(
          "INSERT INTO coupon_redemptions (coupon_code, session_id, order_id) VALUES (?, ?, ?) ON CONFLICT (coupon_code, session_id) DO NOTHING",
        )
        .run(couponCode, sessionId, orderId);
      if (inserted.changes === 0) {
        throw new RedemptionAbort({ code: "COUPON_USED", message: "You have already used this promo code." });
      }
      const updated = tx
        .query<unknown, [string]>(
          "UPDATE coupons SET used_count = used_count + 1 WHERE code = ? AND is_active = 1 AND (max_uses IS NULL OR used_count < max_uses)",
        )
        .run(couponCode);
      if (updated.changes === 0) {
        throw new RedemptionAbort({ code: "COUPON_EXHAUSTED", message: "This promo code has reached its usage limit." });
      }
    });
  } catch (error) {
    if (error instanceof RedemptionAbort) return { ok: false, error: error.appError };
    throw error;
  }
  return ok(undefined);
}

export function releaseRedemption(db: Database, code: string, sessionId: string): void {
  const normalized = normalizeCouponCode(code);
  if (!normalized.ok || !isSessionId(sessionId)) return;
  const couponCode = normalized.value;
  withTransaction(db, (tx) => {
    const deleted = tx
      .query<unknown, [string, string]>("DELETE FROM coupon_redemptions WHERE coupon_code = ? AND session_id = ?")
      .run(couponCode, sessionId);
    if (deleted.changes === 0) return;
    tx.query<unknown, [string]>(
      "UPDATE coupons SET used_count = used_count - 1 WHERE code = ? AND used_count > 0",
    ).run(couponCode);
  });
}

export function releaseRedemptionForOrder(db: Database, code: string, ownerKey: string, orderId: string): void {
  const normalized = normalizeCouponCode(code);
  if (!normalized.ok || !isSessionId(ownerKey)) return;
  if (typeof orderId !== "string" || orderId.length === 0 || orderId.length > ORDER_ID_MAX_LENGTH) return;
  const couponCode = normalized.value;
  withTransaction(db, (tx) => {
    const deleted = tx
      .query<unknown, [string, string, string]>(
        "DELETE FROM coupon_redemptions WHERE coupon_code = ? AND session_id = ? AND order_id = ?",
      )
      .run(couponCode, ownerKey, orderId);
    if (deleted.changes === 0) return;
    tx.query<unknown, [string]>(
      "UPDATE coupons SET used_count = used_count - 1 WHERE code = ? AND used_count > 0",
    ).run(couponCode);
  });
}

export function createCouponService(deps: CouponServiceDeps): CouponService {
  const { db } = deps;
  const clock = deps.now ?? Date.now;

  function validate(code: unknown, subtotalCents: number, sessionId: string | null, now?: number): Result<ValidatedCoupon, AppError> {
    const subtotal = checkCents("subtotalCents", subtotalCents);
    if (!subtotal.ok) return subtotal;
    const normalized = normalizeCouponCode(code);
    if (!normalized.ok) return invalid();
    const row = findCoupon(db, normalized.value);
    if (row === null || row.is_active !== 1 || !isCouponKind(row.kind)) return invalid();
    const at = now ?? clock();
    const window = windowState(row, at);
    if (window === "corrupt") return invalid();
    if (window === "expired") return fail("COUPON_EXPIRED", "This promo code has expired.");
    if (isExhausted(row)) return fail("COUPON_EXHAUSTED", "This promo code has reached its usage limit.");
    if (isSessionId(sessionId) && hasRedeemed(db, row.code, sessionId)) {
      return fail("COUPON_USED", "You have already used this promo code.");
    }
    if (subtotal.value < row.min_subtotal_cents) {
      const shortfallCents = row.min_subtotal_cents - subtotal.value;
      return fail("COUPON_MIN_SUBTOTAL", `Add ${money(shortfallCents)} more to use this promo code.`, {
        shortfallCents,
        minSubtotalCents: row.min_subtotal_cents,
      });
    }
    return ok(toValidated(row, row.kind));
  }

  function listPromoted(now?: number): readonly PromotedCoupon[] {
    const at = now ?? clock();
    const rows = db
      .query<CouponRow, []>(`SELECT ${COUPON_COLUMNS} FROM coupons WHERE is_active = 1 AND promoted = 1 ORDER BY code`)
      .all();
    const result: PromotedCoupon[] = [];
    for (const row of rows) {
      if (!isCouponKind(row.kind) || windowState(row, at) !== "open" || isExhausted(row)) continue;
      result.push(toPromoted(row, row.kind));
    }
    return result;
  }

  return { validate, listPromoted, recordRedemption, releaseRedemption, releaseRedemptionForOrder };
}

interface CouponServiceCache {
  readonly db: Database;
  readonly service: CouponService;
}

const globalForCoupons = globalThis as typeof globalThis & { __storefrontCouponService?: CouponServiceCache };

/** App-wide singleton bound to `getDatabase()`; rebuilt if the shared DB changes. */
export function getCouponService(): CouponService {
  const db = getDatabase();
  const cached = globalForCoupons.__storefrontCouponService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createCouponService({ db });
  globalForCoupons.__storefrontCouponService = { db, service };
  return service;
}
