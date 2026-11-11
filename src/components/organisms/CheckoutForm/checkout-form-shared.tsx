import type { MouseEvent, ReactNode, Ref } from "react";
import { Heading } from "@/components/atoms/Typography";
import type { AppError } from "@/lib/result";
import type { AddressField, CardField, FieldError, FieldErrors } from "@/lib/validation";

/**
 * Helpers shared by the MVP CheckoutForm and CheckoutForm v2 (T93). Moved
 * here verbatim from CheckoutForm.tsx so both variants use one copy;
 * CheckoutForm.tsx re-exports the public ones (MVP import paths unchanged).
 */

/** Element-id prefixes; must match the molecules' defaults (`${prefix}-${field}`). */
export const ADDRESS_ID_PREFIX = "address";
export const CARD_ID_PREFIX = "card";

/** Labels in form order, matching the molecules' visible labels. */
export const ADDRESS_LABELS: Readonly<Record<AddressField, string>> = {
  fullName: "Full name",
  email: "Email",
  line1: "Address line 1",
  line2: "Address line 2",
  city: "City",
  region: "State / province / region",
  postalCode: "Postal code",
  country: "Country",
};

export const CARD_LABELS: Readonly<Record<CardField, string>> = {
  nameOnCard: "Name on card",
  number: "Card number",
  expMonth: "Expiry month",
  expYear: "Expiry year",
  cvc: "Security code (CVC)",
};

export const ADDRESS_FIELDS = Object.keys(ADDRESS_LABELS) as AddressField[];
export const CARD_FIELDS = Object.keys(CARD_LABELS) as CardField[];

/**
 * Idempotency key rule: keep the key while retrying the SAME attempt (the
 * request failed before an outcome arrived, e.g. a network error), and
 * generate a fresh one once an attempt has completed with any outcome.
 */
export function nextIdempotencyKey(
  prevKey: string,
  attemptCompleted: boolean,
  generate: () => string = () => crypto.randomUUID(),
): string {
  return attemptCompleted ? generate() : prevKey;
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFieldError(value: unknown): value is FieldError {
  return isRecord(value) && typeof value.code === "string" && typeof value.message === "string";
}

function pickFieldErrors<K extends string>(fields: unknown, keys: readonly K[]): FieldErrors<K> {
  const out: Partial<Record<K, FieldError>> = {};
  if (!isRecord(fields)) return out;
  for (const key of keys) {
    const value = fields[key];
    if (isFieldError(value)) out[key] = value;
  }
  return out;
}

export interface SplitFieldErrors {
  readonly address: FieldErrors<AddressField>;
  readonly card: FieldErrors<CardField>;
}

/** Splits `VALIDATION_FAILED` `details.fields` into address and card errors. Ignores anything malformed. */
export function splitFieldErrors(error: AppError | undefined): SplitFieldErrors {
  if (error?.code !== "VALIDATION_FAILED") return { address: {}, card: {} };
  const fields = error.details?.fields;
  return {
    address: pickFieldErrors(fields, ADDRESS_FIELDS),
    card: pickFieldErrors(fields, CARD_FIELDS),
  };
}

export interface StockChangedLine {
  readonly productId: string;
  readonly name: string;
  readonly requested: number;
  readonly available: number;
}

function isStockLine(value: unknown): value is StockChangedLine {
  return (
    isRecord(value) &&
    typeof value.productId === "string" &&
    typeof value.name === "string" &&
    typeof value.requested === "number" &&
    typeof value.available === "number"
  );
}

/** Reads `STOCK_CHANGED` `details.lines`, dropping malformed entries. */
export function readStockLines(error: AppError | undefined): readonly StockChangedLine[] {
  const lines = error?.details?.lines;
  return Array.isArray(lines) ? lines.filter(isStockLine) : [];
}

export const alertBox = "flex flex-col gap-3 rounded-lg border-2 border-danger bg-surface-raised p-4";
export const linkClasses = "text-accent underline underline-offset-2 hover:decoration-2";

export interface AlertProps {
  title: string;
  children: ReactNode;
  alertRef: Ref<HTMLDivElement>;
}

export function Alert({ title, children, alertRef }: AlertProps) {
  return (
    <div ref={alertRef} role="alert" tabIndex={-1} className={alertBox}>
      <Heading level={2} size="h4">
        {title}
      </Heading>
      {children}
    </div>
  );
}

export function focusField(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return; // fall back to native fragment navigation
  event.preventDefault();
  target.focus();
  target.scrollIntoView?.({ block: "center" });
}
