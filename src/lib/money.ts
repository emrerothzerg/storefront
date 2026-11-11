import { fail, ok, type Result } from "./result";

/**
 * Integer money helpers. Amounts are non-negative integers in minor units
 * (cents). Floats are rejected rather than rounded.
 *
 * Error codes:
 * - INVALID_INPUT: an input is not a non-negative integer (NaN, float, negative, non-number)
 * - MONEY_OVERFLOW: an input or the result exceeds Number.MAX_SAFE_INTEGER
 */

/** True for a non-negative safe integer amount in minor units. */
export function isValidCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Normalises -0 to 0 so ok values never carry a negative zero. */
function okCents(value: number): Result<number> {
  return ok(Object.is(value, -0) ? 0 : value);
}

function checkOperand(name: string, value: unknown): Result<number> {
  // Runtime check too: callers may pass data that bypassed the type system.
  const isNumber = typeof value === "number";
  if (isNumber && value === Number.POSITIVE_INFINITY) {
    return fail("MONEY_OVERFLOW", `${name} exceeds the maximum safe amount`, { operand: name });
  }
  if (!isNumber || !Number.isInteger(value) || value < 0) {
    return fail("INVALID_INPUT", `${name} must be a non-negative integer`, { operand: name });
  }
  if (!Number.isSafeInteger(value)) {
    return fail("MONEY_OVERFLOW", `${name} exceeds the maximum safe amount`, { operand: name });
  }
  return okCents(value);
}

function overflow(): Result<number> {
  return fail("MONEY_OVERFLOW", "Amount exceeds the maximum safe amount", {
    max: Number.MAX_SAFE_INTEGER,
  });
}

export function addCents(a: number, b: number): Result<number> {
  const ra = checkOperand("a", a);
  if (!ra.ok) return ra;
  const rb = checkOperand("b", b);
  if (!rb.ok) return rb;
  if (ra.value > Number.MAX_SAFE_INTEGER - rb.value) return overflow();
  return okCents(ra.value + rb.value);
}

export function multiplyCents(unitCents: number, quantity: number): Result<number> {
  const ru = checkOperand("unitCents", unitCents);
  if (!ru.ok) return ru;
  const rq = checkOperand("quantity", quantity);
  if (!rq.ok) return rq;
  const unit = ru.value;
  const qty = rq.value;
  if (qty !== 0 && unit > Math.floor(Number.MAX_SAFE_INTEGER / qty)) return overflow();
  return okCents(unit * qty);
}

/** Never throws: a non-array argument is an `INVALID_INPUT` result. */
export function sumCents(amounts: readonly number[]): Result<number> {
  if (!Array.isArray(amounts)) {
    return fail("INVALID_INPUT", "amounts must be an array", { operand: "amounts" });
  }
  let total = 0;
  for (let index = 0; index < amounts.length; index++) {
    const r = checkOperand(`amounts[${index}]`, amounts[index]);
    if (!r.ok) return r;
    if (total > Number.MAX_SAFE_INTEGER - r.value) return overflow();
    total += r.value;
  }
  return okCents(total);
}

/**
 * Formats an integer amount in minor units as a localized currency string.
 * Minor-unit digits come from the currency itself, so JPY (0 decimals) and
 * USD (2 decimals) are both handled.
 *
 * formatMoney(1999, "USD") === "$19.99"
 * formatMoney(1999, "JPY") === "¥1,999"
 *
 * Exact for every safe integer: the amount is turned into a decimal string by
 * slicing digits (no float division) and passed to `Intl.NumberFormat`, which
 * accepts decimal strings (Intl.NumberFormat v3; verified on Bun 1.4.4).
 *
 * Display code must guard with `isValidCents` first; this function throws on
 * anything that is not a valid amount.
 *
 * @throws RangeError if `amountMinor` is not a non-negative safe integer, or
 *   `currency` is not a valid ISO 4217 code.
 */
export function formatMoney(
  amountMinor: number,
  currency: string,
  locale: string = "en-US",
): string {
  if (!Number.isInteger(amountMinor)) {
    throw new RangeError(`amountMinor must be an integer, got ${amountMinor}`);
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new RangeError(
      `amountMinor must be a non-negative safe integer, got ${amountMinor}`,
    );
  }
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  // String(-0) === "0", so negative zero formats as zero.
  const padded = String(amountMinor).padStart(digits + 1, "0");
  const decimal =
    digits === 0 ? padded : `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
  return formatter.format(decimal as `${number}`);
}
