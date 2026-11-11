import type { Database } from "bun:sqlite";
import { fail, ok, type AppError, type Result } from "@/lib/result";
import type { IsoDateTimeString, ShippingMethod } from "@/lib/types";
import { getDatabase } from "@/server/db/client";
import { amountToFreeFor, checkCents, shippingPriceFor } from "./totals";

/**
 * Shipping methods, quotes and business-day delivery estimates.
 * See ./README.md.
 */

export interface ShippingQuote {
  readonly method: ShippingMethod;
  /** 0 when free. */
  readonly priceCents: number;
  readonly isFree: boolean;
  /** null when the method has no free-over threshold. */
  readonly amountToFreeCents: number | null;
}

export interface DeliveryEstimate {
  readonly start: IsoDateTimeString;
  readonly end: IsoDateTimeString;
}

export interface ShippingService {
  /** Active methods by sort_order. @throws RangeError when subtotalCents is not a non-negative safe integer. */
  listMethods(subtotalCents: number): readonly ShippingQuote[];
  /** Active method by id, else null (non-string / unknown / inactive). */
  getMethod(id: unknown): ShippingMethod | null;
  /** Lowest price (ties -> sort_order); null when no active method. @throws RangeError like listMethods. */
  cheapest(subtotalCents: number): ShippingQuote | null;
  /** INVALID_INPUT for unknown/inactive method or invalid subtotal; MONEY_OVERFLOW for an unsafe subtotal. */
  quote(methodId: string, subtotalCents: number): Result<ShippingQuote, AppError>;
}

export interface ShippingServiceDeps {
  readonly db: Database;
  /** Accepted for the shared `createXService({ db, now? })` shape; shipping quotes do not depend on time. */
  readonly now?: () => number;
}

interface ShippingRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly price_cents: number;
  readonly free_over_cents: number | null;
  readonly min_days: number;
  readonly max_days: number;
  readonly sort_order: number;
  readonly is_active: number;
}

const SHIPPING_COLUMNS = "id, name, description, price_cents, free_over_cents, min_days, max_days, sort_order, is_active";

/** Longest id accepted before touching the DB. */
const METHOD_ID_MAX_LENGTH = 64;

/** Upper bound for minDays/maxDays in estimateDelivery (guards runaway loops). */
export const MAX_DELIVERY_BUSINESS_DAYS = 365;

const DAY_MS = 86_400_000;

function toMethod(row: ShippingRow): ShippingMethod {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    freeOverCents: row.free_over_cents,
    minDays: row.min_days,
    maxDays: row.max_days,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
  };
}

/** Quote for a method at an already-validated subtotal. */
export function quoteFor(method: ShippingMethod, subtotalCents: number): ShippingQuote {
  const priceCents = shippingPriceFor(method, subtotalCents);
  return { method, priceCents, isFree: priceCents === 0, amountToFreeCents: amountToFreeFor(method, subtotalCents) };
}

function requireSubtotal(subtotalCents: number): number {
  const checked = checkCents("subtotalCents", subtotalCents);
  if (!checked.ok) throw new RangeError(checked.error.message);
  return checked.value;
}

function isWeekend(dayMs: number): boolean {
  const day = new Date(dayMs).getUTCDay();
  return day === 0 || day === 6;
}

function nextBusinessDayOnOrAfter(dayMs: number): number {
  let d = dayMs;
  while (isWeekend(d)) d += DAY_MS;
  return d;
}

function addBusinessDays(startMs: number, days: number): number {
  let d = startMs;
  for (let i = 0; i < days; i++) {
    d += DAY_MS;
    while (isWeekend(d)) d += DAY_MS;
  }
  return d;
}

/** Largest epoch ms a Date can hold (ECMA-262 time value limit); a UTC midnight. */
const MAX_DATE_MS = 8.64e15;

/** ISO date-time with no zone designator; "T" or a space (SQLite) separator. */
const ZONELESS_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)$/;

/**
 * Epoch ms for an epoch number or ISO string, or null when invalid. Zone-less
 * date-times are parsed as UTC (Date.parse would use server-local time).
 */
function toValidMs(value: unknown): number | null {
  let ms: number;
  if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    const zoneless = ZONELESS_DATE_TIME_RE.exec(trimmed);
    ms = Date.parse(zoneless === null ? trimmed : `${zoneless[1]}T${zoneless[2]}Z`);
  } else {
    return null;
  }
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : null;
}

function checkDays(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_DELIVERY_BUSINESS_DAYS) {
    throw new RangeError(`${name} must be an integer between 0 and ${MAX_DELIVERY_BUSINESS_DAYS}`);
  }
  return value;
}

/**
 * Business-day delivery window (UTC calendar, Sat/Sun skipped, no holidays).
 *
 * The clock starts on placedAt's UTC date, rolled forward to Monday when that
 * date is a Saturday or Sunday (weekend orders are handled on the next
 * business day). start = that day + minDays business days, end = + maxDays.
 * Both are returned as ISO midnight UTC, e.g. "2026-11-13T00:00:00.000Z".
 *
 * `placedAt` is an ISO string or epoch ms. Strings without a zone offset
 * ("2026-11-06T23:59:00", SQLite's "2026-11-06 23:59:00") are read as UTC,
 * never server-local time; strings with "Z"/"+hh:mm" and epoch ms are used
 * as is. When `placedAt` is not a valid date the estimate is taken from
 * `now`; when `now` is also missing or invalid, from `Date.now()`. A start or
 * end beyond the largest representable Date (8.64e15 ms,
 * "+275760-09-13T00:00:00.000Z") is clamped to it.
 *
 * Total except for the RangeError below; deterministic for an injected clock.
 *
 * @throws RangeError when minDays/maxDays are not integers in 0..365 or maxDays < minDays.
 */
export function estimateDelivery(
  method: Pick<ShippingMethod, "minDays" | "maxDays">,
  placedAt: IsoDateTimeString | number,
  now?: number,
): DeliveryEstimate {
  const minDays = checkDays("minDays", method.minDays);
  const maxDays = checkDays("maxDays", method.maxDays);
  if (maxDays < minDays) throw new RangeError("maxDays must be >= minDays");

  const placedMs = toValidMs(placedAt) ?? toValidMs(now) ?? Date.now();
  const placedDay = Math.floor(placedMs / DAY_MS) * DAY_MS;
  const base = nextBusinessDayOnOrAfter(placedDay);
  const start = Math.min(addBusinessDays(base, minDays), MAX_DATE_MS);
  const end = Math.min(addBusinessDays(start, maxDays - minDays), MAX_DATE_MS);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function createShippingService(deps: ShippingServiceDeps): ShippingService {
  const { db } = deps;

  function activeRows(): readonly ShippingRow[] {
    return db
      .query<ShippingRow, []>(`SELECT ${SHIPPING_COLUMNS} FROM shipping_methods WHERE is_active = 1 ORDER BY sort_order, id`)
      .all();
  }

  function getMethod(id: unknown): ShippingMethod | null {
    if (typeof id !== "string" || id.length === 0 || id.length > METHOD_ID_MAX_LENGTH) return null;
    const row = db
      .query<ShippingRow, [string]>(`SELECT ${SHIPPING_COLUMNS} FROM shipping_methods WHERE id = ? AND is_active = 1`)
      .get(id);
    return row === null ? null : toMethod(row);
  }

  function listMethods(subtotalCents: number): readonly ShippingQuote[] {
    const subtotal = requireSubtotal(subtotalCents);
    return activeRows().map((row) => quoteFor(toMethod(row), subtotal));
  }

  function cheapest(subtotalCents: number): ShippingQuote | null {
    let best: ShippingQuote | null = null;
    for (const q of listMethods(subtotalCents)) {
      if (best === null || q.priceCents < best.priceCents) best = q;
    }
    return best;
  }

  function quote(methodId: string, subtotalCents: number): Result<ShippingQuote, AppError> {
    const subtotal = checkCents("subtotalCents", subtotalCents);
    if (!subtotal.ok) return subtotal;
    const method = getMethod(methodId);
    if (method === null) return fail("INVALID_INPUT", "Choose a valid shipping method.", { field: "shippingMethodId" });
    return ok(quoteFor(method, subtotal.value));
  }

  return { listMethods, getMethod, cheapest, quote };
}

interface ShippingServiceCache {
  readonly db: Database;
  readonly service: ShippingService;
}

const globalForShipping = globalThis as typeof globalThis & { __storefrontShippingService?: ShippingServiceCache };

/** App-wide singleton bound to `getDatabase()`; rebuilt if the shared DB changes. */
export function getShippingService(): ShippingService {
  const db = getDatabase();
  const cached = globalForShipping.__storefrontShippingService;
  if (cached !== undefined && cached.db === db) return cached.service;
  const service = createShippingService({ db });
  globalForShipping.__storefrontShippingService = { db, service };
  return service;
}
