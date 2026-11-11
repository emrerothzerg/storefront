import { isAllowedInternalHref } from "@/content/routes";
import { formatMoney, isValidCents } from "@/lib/money";

/** Pure helpers for OrderDetail (T95). Never throw. */

/** Cancel window from placement (order service: 30 minutes, inclusive). */
export const CANCEL_WINDOW_MINUTES = 30;
const MINUTE_MS = 60_000;

/** Brands the payment line may name; anything else reads "Card". */
export const CARD_BRANDS = ["Visa", "Mastercard", "American Express", "Discover"] as const;
export type CardBrand = (typeof CARD_BRANDS)[number];

/**
 * Whole minutes left in the cancel window: deadline = placedAt + 30 min
 * (or the service's `cancellableUntil` when that is earlier), floored. Returns
 * 0 when less than a minute is left, the date is invalid, or `now` is invalid,
 * so the form is hidden rather than offered when it would likely fail.
 */
export function cancelMinutesLeft(
  placedAt: unknown,
  now: number,
  cancellableUntil?: string | null,
): number {
  if (typeof placedAt !== "string" || !Number.isFinite(now)) return 0;
  const placed = Date.parse(placedAt);
  if (!Number.isFinite(placed)) return 0;
  let deadline = placed + CANCEL_WINDOW_MINUTES * MINUTE_MS;
  if (typeof cancellableUntil === "string") {
    const until = Date.parse(cancellableUntil);
    if (Number.isFinite(until)) deadline = Math.min(deadline, until);
  }
  const left = Math.floor((deadline - now) / MINUTE_MS);
  return Math.max(0, Math.min(CANCEL_WINDOW_MINUTES, left));
}

/** "You can cancel for 12 more minutes." */
export function cancelWindowText(minutes: number): string {
  return `You can cancel for ${minutes} more ${minutes === 1 ? "minute" : "minutes"}.`;
}

/** Exactly four ASCII digits, else null. */
export function normaliseLast4(value: unknown): string | null {
  return typeof value === "string" && /^[0-9]{4}$/.test(value) ? value : null;
}

/** "Visa ending in 4242" / "Card ending in 4242"; null when last4 is not four digits. */
export function paymentLabel(last4: unknown, brand?: unknown): string | null {
  const digits = normaliseLast4(last4);
  if (digits === null) return null;
  const name = (CARD_BRANDS as readonly unknown[]).includes(brand) ? (brand as CardBrand) : "Card";
  return `${name} ending in ${digits}`;
}

export interface ShipToInput {
  readonly fullName: string;
  readonly line1: string;
  readonly line2?: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Name, street lines, "City, Region Postal", country. Email/phone are never included. */
export function shipToLines(address: ShipToInput | null | undefined): string[] {
  if (address == null) return [];
  const regionPostal = [text(address.region), text(address.postalCode)].filter(Boolean).join(" ");
  const cityLine = [text(address.city), regionPostal === "" ? null : regionPostal].filter(Boolean).join(", ");
  return [address.fullName, address.line1, address.line2, cityLine, address.country]
    .map(text)
    .filter((line): line is string => line !== null);
}

function safe(href: string): string | null {
  return isAllowedInternalHref(href) ? href : null;
}

export function invoiceHref(orderId: string): string | null {
  return safe(`/orders/${encodeURIComponent(orderId)}/invoice`);
}

export function orderHelpHref(orderId: string): string | null {
  return safe(`/contact?topic=ordering&order=${encodeURIComponent(orderId)}`);
}

/**
 * Refund notice for a cancelled order (T55 decision: the mock provider has no
 * refund method; cancellation records `refund_pending` only, no money moves).
 */
export function refundNoticeText(totalCents: unknown, currency: string, last4: unknown): string {
  if (totalCents === 0) return "No payment was taken for this order, so there is nothing to refund.";
  let amount: string | null = null;
  if (isValidCents(totalCents)) {
    try {
      amount = formatMoney(totalCents, currency);
    } catch {
      amount = null;
    }
  }
  const digits = normaliseLast4(last4);
  const what = amount !== null ? `A refund of ${amount}` : "A refund";
  const where = digits !== null ? ` to the card ending in ${digits}` : "";
  return `${what}${where} is pending. Payments in this store are simulated, so no money is moved.`;
}
