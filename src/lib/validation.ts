import { err, ok, type Err, type Result } from "./result";
import type { Address, CardInput } from "./types";

/**
 * Pure validators for untrusted input. Each returns a `Result`; failures are
 * plain JSON data (an `AppError` subtype) safe to send to the client.
 *
 * Card validation errors NEVER echo the card number or CVC back.
 */

// ---------------------------------------------------------------------------
// Quantity
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_QUANTITY = 99;

export type QuantityErrorReason =
  | "NOT_A_NUMBER" // typeof !== "number" (strings, null, objects...)
  | "NAN"
  | "INFINITE"
  | "NOT_INTEGER"
  | "NEGATIVE"
  | "ZERO"
  | "ABOVE_MAX";

export interface QuantityError {
  readonly code: "INVALID_QUANTITY";
  readonly message: string;
  readonly details: { readonly reason: QuantityErrorReason; readonly max: number };
}

const QUANTITY_MESSAGES: Readonly<Record<QuantityErrorReason, (max: number) => string>> = {
  NOT_A_NUMBER: () => "Quantity must be a number.",
  NAN: () => "Quantity must be a number.",
  INFINITE: () => "Quantity must be a finite number.",
  NOT_INTEGER: () => "Quantity must be a whole number.",
  NEGATIVE: () => "Quantity cannot be negative.",
  ZERO: () => "Quantity must be at least 1.",
  ABOVE_MAX: (max) => `Quantity cannot be more than ${max}.`,
};

function quantityError(reason: QuantityErrorReason, max: number): Err<QuantityError> {
  return err({
    code: "INVALID_QUANTITY",
    message: QUANTITY_MESSAGES[reason](max),
    details: { reason, max },
  });
}

/**
 * Accepts integers in `1..max` (inclusive). Only real numbers are accepted.
 *
 * @throws TypeError if `max` is not a positive safe integer (programmer error).
 */
export function validateQuantity(
  value: unknown,
  max: number = DEFAULT_MAX_QUANTITY,
): Result<number, QuantityError> {
  if (!Number.isSafeInteger(max) || max < 1) {
    throw new TypeError(`max must be a positive safe integer, got ${String(max)}`);
  }
  if (typeof value !== "number") return quantityError("NOT_A_NUMBER", max);
  if (Number.isNaN(value)) return quantityError("NAN", max);
  if (!Number.isFinite(value)) return quantityError("INFINITE", max);
  if (!Number.isInteger(value)) return quantityError("NOT_INTEGER", max);
  if (value < 0) return quantityError("NEGATIVE", max);
  if (value === 0) return quantityError("ZERO", max);
  if (value > max) return quantityError("ABOVE_MAX", max);
  return ok(value);
}

// ---------------------------------------------------------------------------
// Shared field-error shape
// ---------------------------------------------------------------------------

export type FieldErrorCode =
  | "REQUIRED"
  | "INVALID_TYPE"
  | "TOO_LONG"
  | "INVALID_EMAIL"
  | "INVALID_COUNTRY"
  | "INVALID_CHARACTERS"
  | "INVALID_LENGTH"
  | "FAILED_CHECKSUM"
  | "INVALID_MONTH"
  | "INVALID_YEAR"
  | "EXPIRED"
  | "INVALID_CVC";

export interface FieldError {
  readonly code: FieldErrorCode;
  readonly message: string;
}

export type FieldErrors<K extends string> = Readonly<Partial<Record<K, FieldError>>>;

export interface ValidationError<K extends string> {
  readonly code: "VALIDATION_FAILED";
  readonly message: string;
  readonly details: { readonly fields: FieldErrors<K> };
}

function validationFailed<K extends string>(fields: FieldErrors<K>): Err<ValidationError<K>> {
  return err({
    code: "VALIDATION_FAILED",
    message: "Some fields are invalid.",
    details: { fields },
  });
}

function asRecord(input: unknown): Readonly<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

type TextCheck = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: FieldError };

/**
 * Hard cap on any raw string field, checked before trimming or any regex so
 * oversized untrusted input is rejected in O(1).
 */
export const MAX_RAW_FIELD_LENGTH = 1000;

function isOverRawCap(raw: unknown): boolean {
  return typeof raw === "string" && raw.length > MAX_RAW_FIELD_LENGTH;
}

function tooLong(label: string): FieldError {
  return { code: "TOO_LONG", message: `${label} is too long.` };
}

/**
 * Code units treated as whitespace when trimming: everything JS `\s`
 * matches, plus the zero-width characters U+200B, U+200C, U+200D, U+2060
 * (U+FEFF is already in `\s`).
 */
function isTrimmable(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) || // \t \n \v \f \r
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200d) || // en quad..hair space, ZWSP, ZWNJ, ZWJ
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x2060 ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/**
 * Trims whitespace and zero-width characters from both ends. Linear scan
 * from each end (no regex), so it cannot backtrack on long whitespace runs.
 */
function trimText(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isTrimmable(value.charCodeAt(start))) start++;
  while (end > start && isTrimmable(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

/** Trims a string field; whitespace-only (incl. zero-width) counts as empty. */
function readText(raw: unknown, label: string, maxLength: number, required: boolean): TextCheck {
  if (raw === undefined || raw === null) {
    return required
      ? { ok: false, error: { code: "REQUIRED", message: `${label} is required.` } }
      : { ok: true, value: "" };
  }
  if (typeof raw !== "string") {
    return { ok: false, error: { code: "INVALID_TYPE", message: `${label} must be text.` } };
  }
  if (raw.length > MAX_RAW_FIELD_LENGTH) return { ok: false, error: tooLong(label) };
  const value = trimText(raw);
  if (value === "" && required) {
    return { ok: false, error: { code: "REQUIRED", message: `${label} is required.` } };
  }
  if (value.length > maxLength) {
    return {
      ok: false,
      error: { code: "TOO_LONG", message: `${label} must be at most ${maxLength} characters.` },
    };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

export type AddressField = keyof Address;
export type AddressValidationError = ValidationError<AddressField>;

const ADDRESS_MAX_LENGTH = 200;
const EMAIL_MAX_LENGTH = 254;
// Deliberately basic: local@label.label[.label...], no whitespace, one "@".
// Domain labels are non-empty, so no leading, trailing or consecutive dots.
// Linear: every repetition is delimited by a character its class excludes
// ("@" or "."), so there is no ambiguous backtracking; it also only ever runs
// on at most EMAIL_MAX_LENGTH (254) trimmed characters.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;

const ADDRESS_LABELS: Readonly<Record<AddressField, string>> = {
  fullName: "Full name",
  email: "Email",
  line1: "Address line 1",
  line2: "Address line 2",
  city: "City",
  region: "Region",
  postalCode: "Postal code",
  country: "Country",
};

/**
 * Validates and normalizes a shipping address: trims every field, drops an
 * empty `line2`, upper-cases `country`. Country is checked for ISO 3166-1
 * alpha-2 shape (two letters), not against the full code list.
 */
export function validateAddress(input: unknown): Result<Address, AddressValidationError> {
  const raw = asRecord(input);
  const errors: Partial<Record<AddressField, FieldError>> = {};
  const values: Partial<Record<AddressField, string>> = {};

  for (const field of Object.keys(ADDRESS_LABELS) as AddressField[]) {
    const maxLength = field === "email" ? EMAIL_MAX_LENGTH : ADDRESS_MAX_LENGTH;
    const checked = readText(raw[field], ADDRESS_LABELS[field], maxLength, field !== "line2");
    if (checked.ok) values[field] = checked.value;
    else errors[field] = checked.error;
  }

  if (values.email !== undefined && !EMAIL_PATTERN.test(values.email)) {
    errors.email = { code: "INVALID_EMAIL", message: "Enter a valid email address." };
  }
  if (values.country !== undefined && !COUNTRY_PATTERN.test(values.country)) {
    errors.country = {
      code: "INVALID_COUNTRY",
      message: "Country must be a two-letter ISO code, e.g. US.",
    };
  }

  const { fullName, email, line1, line2, city, region, postalCode, country } = values;
  if (
    Object.keys(errors).length > 0 ||
    fullName === undefined ||
    email === undefined ||
    line1 === undefined ||
    city === undefined ||
    region === undefined ||
    postalCode === undefined ||
    country === undefined
  ) {
    return validationFailed(errors);
  }

  return ok({
    fullName,
    email,
    line1,
    ...(line2 ? { line2 } : {}),
    city,
    region,
    postalCode,
    country: country.toUpperCase(),
  });
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export type CardField = keyof CardInput;
export type CardValidationError = ValidationError<CardField>;

/**
 * Normalized card: digits-only number, 4-digit year, trimmed name. Holds the
 * full number and CVC for the payment provider: never return it from a server
 * action and never log it.
 */
export interface ValidatedCard extends CardInput {
  readonly last4: string;
}

const CARD_MIN_DIGITS = 13;
const CARD_MAX_DIGITS = 19;
const CARD_MAX_YEARS_AHEAD = 20;
const NAME_MAX_LENGTH = 100;

/** Luhn (mod 10) checksum over a digits-only string. */
export function luhnCheck(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Month: an integer, or a string of 1–2 digits; anything else is `undefined`. */
function readMonth(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : undefined;
  if (typeof raw === "string" && /^\d{1,2}$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}

/**
 * Year: exactly 2 digits (read as 20YY) or 4 digits. A number in 0–99 counts
 * as 2 digits (numbers cannot keep a leading zero); 100–999 is rejected.
 * Strings must be exactly 2 or 4 digits, so "030" is rejected.
 */
function readYear(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) return undefined;
    if (raw < 100) return 2000 + raw;
    return raw >= 1000 && raw <= 9999 ? raw : undefined;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (/^\d{2}$/.test(t)) return 2000 + Number(t);
    if (/^\d{4}$/.test(t)) return Number(t);
  }
  return undefined;
}

/**
 * Validates card details. `number` may contain spaces or dashes; `expYear`
 * may be 2-digit (interpreted as 20YY) or 4-digit. A card is valid through
 * the end of its expiry month, compared in UTC against `now`.
 *
 * A number whose digits are all the same (e.g. all zeros) is rejected as
 * FAILED_CHECKSUM even when it passes Luhn.
 *
 * Errors never include the card number or CVC.
 *
 * @throws TypeError if `now` is not a valid Date (programmer error).
 */
export function validateCard(
  input: unknown,
  now: Date = new Date(),
): Result<ValidatedCard, CardValidationError> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }
  const raw = asRecord(input);
  const errors: Partial<Record<CardField, FieldError>> = {};

  // Number
  let number: string | undefined;
  if (isOverRawCap(raw.number)) {
    errors.number = tooLong("Card number");
  } else if (typeof raw.number !== "string" || raw.number.trim() === "") {
    errors.number = { code: "REQUIRED", message: "Card number is required." };
  } else {
    const digits = raw.number.replace(/[\s-]/g, "");
    if (!/^\d+$/.test(digits)) {
      errors.number = { code: "INVALID_CHARACTERS", message: "Card number must contain only digits." };
    } else if (digits.length < CARD_MIN_DIGITS || digits.length > CARD_MAX_DIGITS) {
      errors.number = {
        code: "INVALID_LENGTH",
        message: `Card number must be ${CARD_MIN_DIGITS} to ${CARD_MAX_DIGITS} digits.`,
      };
    } else if (!luhnCheck(digits) || /^(\d)\1*$/.test(digits)) {
      errors.number = { code: "FAILED_CHECKSUM", message: "Card number is not valid." };
    } else {
      number = digits;
    }
  }

  // Expiry
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1;
  const monthOverCap = isOverRawCap(raw.expMonth);
  const yearOverCap = isOverRawCap(raw.expYear);
  const expMonth = monthOverCap ? undefined : readMonth(raw.expMonth);
  const expYear = yearOverCap ? undefined : readYear(raw.expYear);

  if (monthOverCap) {
    errors.expMonth = tooLong("Expiry month");
  } else if (expMonth === undefined || expMonth < 1 || expMonth > 12) {
    errors.expMonth = { code: "INVALID_MONTH", message: "Expiry month must be 1 to 12." };
  }
  if (yearOverCap) {
    errors.expYear = tooLong("Expiry year");
  } else if (expYear === undefined || expYear < 2000 || expYear > nowYear + CARD_MAX_YEARS_AHEAD) {
    errors.expYear = { code: "INVALID_YEAR", message: "Expiry year is not valid." };
  }
  if (
    errors.expMonth === undefined &&
    errors.expYear === undefined &&
    expMonth !== undefined &&
    expYear !== undefined &&
    (expYear < nowYear || (expYear === nowYear && expMonth < nowMonth))
  ) {
    errors.expMonth = { code: "EXPIRED", message: "This card has expired." };
  }

  // CVC
  let cvc: string | undefined;
  if (isOverRawCap(raw.cvc)) {
    errors.cvc = tooLong("Security code");
  } else if (typeof raw.cvc !== "string" || raw.cvc.trim() === "") {
    errors.cvc = { code: "REQUIRED", message: "Security code is required." };
  } else if (!/^\d{3,4}$/.test(raw.cvc.trim())) {
    errors.cvc = { code: "INVALID_CVC", message: "Security code must be 3 or 4 digits." };
  } else {
    cvc = raw.cvc.trim();
  }

  // Name
  const name = readText(raw.nameOnCard, "Name on card", NAME_MAX_LENGTH, true);
  if (!name.ok) errors.nameOnCard = name.error;

  if (
    Object.keys(errors).length > 0 ||
    number === undefined ||
    expMonth === undefined ||
    expYear === undefined ||
    cvc === undefined ||
    !name.ok
  ) {
    return validationFailed(errors);
  }

  return ok({
    number,
    expMonth,
    expYear,
    cvc,
    nameOnCard: name.value,
    last4: number.slice(-4),
  });
}
