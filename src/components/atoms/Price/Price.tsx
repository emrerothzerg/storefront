import type { HTMLAttributes } from "react";
import { formatMoney, isValidCents } from "@/lib/money";

export type PriceSize = "body" | "h3" | "h2";
/**
 * `standard`: "$19.99" in one run of text (default).
 * `superscript`: retail style, the currency symbol and cents raised and
 * smaller ("$19⁹⁹"); whole amounts drop ".00" ("$10"). Assistive tech still
 * gets the full "$19.99" (the split visual is aria-hidden).
 */
export type PriceDisplay = "standard" | "superscript";
/** `default` = near-black; `deal` = warm deal colour for sale prices. */
export type PriceTone = "default" | "deal";

export interface PriceProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Current price in minor units (cents). Must be a non-negative safe integer. */
  amountCents: number;
  /** ISO 4217 code. Defaults to "USD". */
  currency?: string;
  /**
   * Original price in minor units. Shown struck through (announced as "Was …")
   * only when greater than `amountCents`; otherwise ignored.
   */
  compareAtCents?: number;
  /** Type scale step for the current price. Defaults to `body`. */
  size?: PriceSize;
  /** Defaults to "standard". */
  display?: PriceDisplay;
  /** Colour of the current price. Defaults to "default". */
  tone?: PriceTone;
}

const LOCALE = "en-US";

const sizeClasses: Record<PriceSize, string> = {
  body: "text-body",
  h3: "text-h3",
  h2: "text-h2",
};

const compareSizeClasses: Record<PriceSize, string> = {
  body: "text-small",
  h3: "text-body",
  h2: "text-body",
};

// Superscript display: big whole units, raised symbol/cents at about half size.
const superMainClasses: Record<PriceSize, string> = {
  body: "text-h3 font-bold leading-none",
  h3: "text-price leading-none",
  h2: "text-price-lg leading-none",
};
const superMinorClasses: Record<PriceSize, string> = {
  body: "text-caption font-bold leading-none mt-0.5",
  h3: "text-small font-bold leading-none mt-0.5",
  h2: "text-body font-bold leading-none mt-1",
};

const toneClasses: Record<PriceTone, string> = {
  default: "text-text-primary",
  deal: "text-deal",
};

/** Visual pieces of a formatted price for the superscript display. */
export interface PriceParts {
  /** Everything before the whole units, e.g. "$" or "CA$". */
  prefix: string;
  /** Whole units with grouping, e.g. "1,299". */
  whole: string;
  /** Minor units without the separator, e.g. "99"; "" for zero-decimal currencies. */
  fraction: string;
  /** Anything after the number (rare in en-US). */
  suffix: string;
}

/** Splits a price into display parts, or `null` for invalid input. */
export function splitPrice(amountCents: number, currency: string): PriceParts | null {
  if (!isValidCents(amountCents)) return null;
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(LOCALE, { style: "currency", currency });
  } catch {
    return null;
  }
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const padded = String(amountCents).padStart(digits + 1, "0");
  const decimal = digits === 0 ? padded : `${padded.slice(0, -digits)}.${padded.slice(-digits)}`;
  const parts: PriceParts = { prefix: "", whole: "", fraction: "", suffix: "" };
  let seenNumber = false;
  for (const part of formatter.formatToParts(decimal as `${number}`)) {
    if (part.type === "integer" || part.type === "group") {
      parts.whole += part.value;
      seenNumber = true;
    } else if (part.type === "fraction") {
      parts.fraction += part.value;
    } else if (part.type === "decimal") {
      continue;
    } else if (seenNumber) {
      parts.suffix += part.value;
    } else {
      parts.prefix += part.value;
    }
  }
  return parts;
}

function warnInvalid(message: string): void {
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[Price] ${message} Rendering nothing.`);
  }
}

function tryFormat(amountCents: number, currency: string): string | null {
  try {
    return formatMoney(amountCents, currency, LOCALE);
  } catch {
    return null;
  }
}

function SuperscriptAmount({
  parts,
  size,
}: {
  parts: PriceParts;
  size: PriceSize;
}) {
  const minor = superMinorClasses[size];
  // Whole amounts drop the ".00" (retail convention: "$10").
  const showFraction = parts.fraction !== "" && /[1-9]/.test(parts.fraction);
  return (
    <span aria-hidden="true" className="inline-flex items-start" data-slot="price-superscript">
      {parts.prefix !== "" ? <span className={minor}>{parts.prefix}</span> : null}
      <span className={superMainClasses[size]}>{parts.whole}</span>
      {showFraction ? <span className={minor}>{parts.fraction}</span> : null}
      {parts.suffix !== "" ? <span className={minor}>{parts.suffix}</span> : null}
    </span>
  );
}

/**
 * Formatted price with an optional compare-at (was) price. Renders `null` for
 * invalid input instead of throwing, and logs one warning per render outside
 * production.
 */
export function Price({
  amountCents,
  currency = "USD",
  compareAtCents,
  size = "body",
  display = "standard",
  tone = "default",
  className,
  ...rest
}: PriceProps) {
  if (!isValidCents(amountCents)) {
    warnInvalid(`amountCents must be a non-negative safe integer, got ${String(amountCents)}.`);
    return null;
  }
  if (compareAtCents !== undefined && !isValidCents(compareAtCents)) {
    warnInvalid(
      `compareAtCents must be a non-negative safe integer when provided, got ${String(compareAtCents)}.`,
    );
    return null;
  }

  const current = tryFormat(amountCents, currency);
  if (current === null) {
    warnInvalid(`currency must be a valid ISO 4217 code, got ${JSON.stringify(currency)}.`);
    return null;
  }

  const onSale = compareAtCents !== undefined && compareAtCents > amountCents;
  const previous = onSale ? tryFormat(compareAtCents, currency) : null;
  const parts = display === "superscript" ? splitPrice(amountCents, currency) : null;

  const classes = ["inline-flex flex-wrap items-baseline gap-x-2", className]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} {...rest}>
      {parts !== null ? (
        <span className={toneClasses[tone]}>
          {previous !== null ? <span className="sr-only">Now </span> : null}
          <span className="sr-only">{current}</span>
          <SuperscriptAmount parts={parts} size={size} />
        </span>
      ) : (
        <span className={`${sizeClasses[size]} ${toneClasses[tone]}`}>
          {previous !== null ? <span className="sr-only">Now </span> : null}
          {current}
        </span>
      )}
      {previous !== null ? (
        <s className={`${compareSizeClasses[size]} text-text-secondary line-through`}>
          <span className="sr-only">Was </span>
          {previous}
        </s>
      ) : null}
    </span>
  );
}
