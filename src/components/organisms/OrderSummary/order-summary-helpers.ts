import { multiplyCents, sumCents } from "@/lib/money";
import { ok, type Result } from "@/lib/result";

/**
 * Display-side normalisation of an amount in cents:
 * - a non-negative safe integer is shown as is;
 * - +Infinity or an integer beyond Number.MAX_SAFE_INTEGER is "unavailable"
 *   (rendered as "—" with a visually hidden "unavailable"; never thrown);
 * - anything else (NaN, floats, negatives, non-numbers, undefined) is 0, so
 *   "NaN" can never reach the page.
 */
export type DisplayAmount =
  | { readonly kind: "ok"; readonly cents: number }
  | { readonly kind: "unavailable" };

export function toDisplayAmount(value: unknown): DisplayAmount {
  if (typeof value !== "number") return { kind: "ok", cents: 0 };
  if (Number.isSafeInteger(value) && value >= 0) return { kind: "ok", cents: value === 0 ? 0 : value }; // -0 -> 0
  if (value === Number.POSITIVE_INFINITY || (Number.isInteger(value) && value > Number.MAX_SAFE_INTEGER)) {
    return { kind: "unavailable" };
  }
  return { kind: "ok", cents: 0 };
}

/** Non-negative safe integer quantity, else 0 (never NaN in "name × qty"). */
export function toDisplayQuantity(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export interface OrderSummaryTotalInput {
  readonly items: ReadonlyArray<{ readonly unitPriceCents: number; readonly quantity: number }>;
  readonly shippingCents: number;
  readonly discountCents?: number;
}

/**
 * Exact integer total: sum(unit × qty) + shipping − discount, using
 * `multiplyCents`/`sumCents`. A discount larger than items + shipping
 * clamps to 0 (the pricing service never produces one). Errors:
 * INVALID_INPUT / MONEY_OVERFLOW from the money helpers.
 */
export function computeOrderSummaryTotal(input: OrderSummaryTotalInput): Result<number> {
  const lines: number[] = [];
  for (const item of input.items) {
    const line = multiplyCents(item.unitPriceCents, item.quantity);
    if (!line.ok) return line;
    lines.push(line.value);
  }
  const itemsTotal = sumCents(lines);
  if (!itemsTotal.ok) return itemsTotal;
  const gross = sumCents([itemsTotal.value, input.shippingCents]);
  if (!gross.ok) return gross;
  const discount = sumCents([input.discountCents ?? 0]);
  if (!discount.ok) return discount;
  if (discount.value > gross.value) return ok(0);
  return ok(gross.value - discount.value);
}

export type TotalCheck = "match" | "mismatch" | "unavailable";

/**
 * Compares the server-supplied total with the exact recomputation. Exposed
 * as `data-total-check` on the section; the component still DISPLAYS the
 * supplied total (MVP contract: the server is the source of truth).
 */
export function checkOrderSummaryTotal(input: OrderSummaryTotalInput, totalCents: number): TotalCheck {
  const computed = computeOrderSummaryTotal(input);
  if (!computed.ok) return "unavailable";
  return computed.value === totalCents ? "match" : "mismatch";
}

const placedFormat = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

/** "November 7, 2026" (en-US, UTC) or null for an unparseable value. */
export function formatPlacedDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? placedFormat.format(ms) : null;
}

/** "payment_failed" -> "Payment failed". Empty -> null. */
export function formatStatus(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Exactly four digits, else null. */
export function normaliseLast4(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}$/.test(value) ? value : null;
}

/** Trimmed non-empty string, else null. */
export function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text;
}
