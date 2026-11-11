import { formatMoney, isValidCents } from "@/lib/money";

/**
 * Shared, pure helpers for the home sections (T88). Deterministic on server
 * and client: dates are formatted in UTC with the en-US locale.
 */

const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

const MAX_DATE_MS = 8.64e15;

/**
 * Parses an ISO 8601 date (`2026-11-09`) or date-time (`2026-11-09T12:00:00Z`,
 * offset optional; zone-less strings are read as UTC) into epoch ms. Returns
 * null for anything else, including impossible calendar dates (`2026-02-31`),
 * out-of-range times and non-strings. Never throws.
 */
export function parseIsoDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 40) return null;
  const match = ISO_PATTERN.exec(raw);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return null;
  }
  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59) return null;
  }
  const hasTime = match[4] !== undefined;
  const hasZone = match[7] !== undefined;
  const ms = Date.parse(hasTime && !hasZone ? `${raw}Z` : raw);
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  return ms;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** `{ iso, label }` ("Nov 9, 2026", UTC) for a valid ISO string, else null. */
export function formatIsoDate(value: unknown): { iso: string; label: string } | null {
  const ms = parseIsoDate(value);
  if (ms === null || typeof value !== "string") return null;
  return { iso: value.trim(), label: DATE_FORMAT.format(ms) };
}

let supportedCurrencies: ReadonlySet<string> | undefined;

/**
 * True for ISO 4217 codes the runtime knows (upper case). `Intl.NumberFormat`
 * accepts any well-formed 3-letter code ("ZZZ"), so check the supported list
 * (computed once). Mirrors `isSupportedCurrency` in `src/lib/seo/json-ld.ts`;
 * not imported from there so client bundles do not pull in the SEO module.
 */
export function isSupportedCurrency(currency: string): boolean {
  supportedCurrencies ??= new Set(Intl.supportedValuesOf("currency"));
  return supportedCurrencies.has(currency);
}

/**
 * Formatted money for valid cents and a supported ISO 4217 code (trimmed,
 * case-insensitive), else null. Unknown codes such as "ZZZ" return null.
 * Never throws.
 */
export function tryFormatMoney(amountCents: unknown, currency: unknown): string | null {
  if (!isValidCents(amountCents) || typeof currency !== "string") return null;
  const code = currency.trim().toUpperCase();
  if (!isSupportedCurrency(code)) return null;
  try {
    return formatMoney(amountCents, code, "en-US");
  } catch {
    return null;
  }
}

/** Trimmed string, or "" for non-strings. */
export function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
