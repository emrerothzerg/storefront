import { unstable_rethrow } from "next/navigation";

import type { DepartmentInput } from "@/components/molecules/DepartmentMenu";
import type { PromoCoupon } from "@/components/organisms/SiteHeader";

import { resolveHeaderCartCount, type HeaderCartTotals } from "./cart-count";

/**
 * Header data loader (T80, T148). Pure orchestration over injected readers so it is
 * unit-testable without Next or a database; `HeaderShell.tsx` wires the
 * production readers.
 *
 * Rules:
 * - Request-scoped reads first (`readSessionId`, `readCurrentUser`), so the
 *   layout is dynamic and a build-time prerender aborts before any database
 *   read. Neither reader sets cookies (SR10). Both are guarded too (their
 *   cookie lookup can hit the database): an application error falls back to
 *   a guest header (no session, no user) and is logged once per reader with
 *   the error name only (no message, stack or cookie data).
 * - Every database read is isolated: an application error is logged once per
 *   reader per process and replaced by a safe fallback (0 items, no
 *   departments, no coupon). The header must never take the page down.
 * - Every catch calls `unstable_rethrow` first so Next control-flow errors
 *   (prerender abort, dynamic bailout, redirect/notFound) are never swallowed.
 * - The user is reduced to `displayName`; ids/emails/owner keys never reach props.
 * - T148: the free-shipping threshold comes from the active shipping methods
 *   (`listShippingMethods`, the lowest positive `freeOverCents`). Never
 *   hardcoded; `null` (no reader, no free method, or a read error) means the
 *   header omits the free-shipping benefit.
 */

export interface HeaderUser {
  readonly displayName: string;
}

/** The part of a shipping method the header needs (`ShippingMethod` from `@/lib/types` fits). */
export interface HeaderShippingMethod {
  /** Subtotal (minor units) at or above which the method is free; `null` = never free. */
  readonly freeOverCents: number | null;
  /** Inactive methods are ignored. Omitted = active (the service lists active methods only). */
  readonly isActive?: boolean;
}

export interface HeaderDataDeps {
  readonly readSessionId: () => Promise<string | null>;
  readonly readCurrentUser: () => Promise<HeaderUser | null>;
  readonly getCartTotals: (sessionId: string) => HeaderCartTotals;
  readonly categoryTree: () => readonly DepartmentInput[];
  readonly listPromoted: () => readonly PromoCoupon[];
  /**
   * Active shipping methods (T148). Optional so callers written before T148
   * keep compiling; omitted = no threshold (the benefit is omitted).
   */
  readonly listShippingMethods?: () => readonly HeaderShippingMethod[];
  readonly logger?: Pick<Console, "error">;
}

export interface HeaderData {
  readonly cartCount: number;
  /** `null` = guest. */
  readonly user: HeaderUser | null;
  readonly departments: readonly DepartmentInput[];
  readonly popularSearches: readonly string[];
  readonly promoCoupon: PromoCoupon | null;
  /** Lowest free-shipping threshold of the active methods (minor units), or `null` when unknown/none. */
  readonly freeShippingThresholdCents: number | null;
}

/** How many department names are offered as popular searches. */
export const POPULAR_SEARCH_COUNT = 5;

type Reader = "session" | "user" | "cart" | "categories" | "coupons" | "shipping";

const loggedReaders = new Set<Reader>();

/** Test hook: forget which readers already logged. */
export function resetHeaderDataLogState(): void {
  loggedReaders.clear();
}

function safeRead<T>(reader: Reader, read: () => T, fallback: T, logger: Pick<Console, "error">): T {
  try {
    return read();
  } catch (error: unknown) {
    unstable_rethrow(error);
    if (!loggedReaders.has(reader)) {
      loggedReaders.add(reader);
      logger.error(`[HeaderShell] failed to read ${reader}; rendering the header without it`, error);
    }
    return fallback;
  }
}

/**
 * Guard for the request-scoped readers. Logs only the error name: their
 * failures may carry cookie or session values in the message.
 */
async function safeRequestRead<T>(
  reader: "session" | "user",
  read: () => Promise<T>,
  fallback: T,
  logger: Pick<Console, "error">,
): Promise<T> {
  try {
    return await read();
  } catch (error: unknown) {
    unstable_rethrow(error);
    if (!loggedReaders.has(reader)) {
      loggedReaders.add(reader);
      const name = error instanceof Error ? error.name : typeof error;
      logger.error(`[HeaderShell] failed to read ${reader}; rendering the header as a guest`, { name });
    }
    return fallback;
  }
}

function popularFrom(departments: readonly DepartmentInput[]): string[] {
  const names: string[] = [];
  for (const dept of departments) {
    const name = typeof dept?.name === "string" ? dept.name.trim() : "";
    if (name !== "" && !names.includes(name)) names.push(name);
    if (names.length >= POPULAR_SEARCH_COUNT) break;
  }
  return names;
}

/**
 * Lowest positive safe-integer `freeOverCents` among active methods, else
 * `null`. Malformed entries are skipped (never trusted for display).
 */
export function freeShippingThreshold(methods: readonly HeaderShippingMethod[] | null | undefined): number | null {
  if (!Array.isArray(methods)) return null;
  let lowest: number | null = null;
  for (const method of methods as readonly (HeaderShippingMethod | null | undefined)[]) {
    if (method === null || typeof method !== "object" || method.isActive === false) continue;
    const cents = method.freeOverCents;
    if (typeof cents !== "number" || !Number.isSafeInteger(cents) || cents <= 0) continue;
    if (lowest === null || cents < lowest) lowest = cents;
  }
  return lowest;
}

export async function loadHeaderData(deps: HeaderDataDeps): Promise<HeaderData> {
  const logger = deps.logger ?? console;
  const [sessionId, currentUser] = await Promise.all([
    safeRequestRead("session", () => deps.readSessionId(), null, logger),
    safeRequestRead("user", () => deps.readCurrentUser(), null, logger),
  ]);

  const totals = sessionId === null ? null : safeRead("cart", () => deps.getCartTotals(sessionId), null, logger);
  const departments = safeRead("categories", () => deps.categoryTree(), [], logger);
  const coupons = safeRead("coupons", () => deps.listPromoted(), [], logger);
  const listShippingMethods = deps.listShippingMethods;
  const freeShippingThresholdCents =
    listShippingMethods === undefined
      ? null
      : safeRead("shipping", () => freeShippingThreshold(listShippingMethods()), null, logger);

  return {
    cartCount: resolveHeaderCartCount(totals),
    user: currentUser === null ? null : { displayName: currentUser.displayName },
    departments,
    popularSearches: popularFrom(departments),
    promoCoupon: coupons[0] ?? null,
    freeShippingThresholdCents,
  };
}
