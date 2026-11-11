import { Notice } from "@/components/atoms/Notice";
import { ProgressBar } from "@/components/atoms/ProgressBar";
import { formatMoney, isValidCents } from "@/lib/money";

export interface FreeShippingProgressProps {
  /** Cart subtotal in cents (after discounts, as the shipping service sees it). */
  subtotalCents: number;
  /** Free-shipping threshold in cents; null = no free-shipping offer. */
  thresholdCents: number | null;
  /** From the shipping quote; null lets the component derive threshold - subtotal. */
  amountToFreeCents: number | null;
  /** ISO 4217 code. */
  currency: string;
  className?: string;
}

export type FreeShippingModel =
  | { readonly kind: "qualified" }
  | { readonly kind: "progress"; readonly percent: number; readonly remainingText: string };

function safeMoney(cents: number, currency: string): string | null {
  try {
    return formatMoney(cents, currency);
  } catch {
    return null;
  }
}

/**
 * Pure view model. Returns null (render nothing) for a missing/invalid
 * threshold, a non-positive or invalid subtotal, an invalid
 * `amountToFreeCents` or an unknown currency.
 */
export function freeShippingModel(
  subtotalCents: number,
  thresholdCents: number | null,
  amountToFreeCents: number | null,
  currency: string,
): FreeShippingModel | null {
  if (!isValidCents(thresholdCents) || thresholdCents <= 0) return null;
  if (!isValidCents(subtotalCents) || subtotalCents <= 0) return null;
  if (amountToFreeCents !== null && !isValidCents(amountToFreeCents)) return null;
  if (typeof currency !== "string" || safeMoney(0, currency) === null) return null;

  const remaining = amountToFreeCents ?? Math.max(0, thresholdCents - subtotalCents);
  if (remaining === 0 || subtotalCents >= thresholdCents) return { kind: "qualified" };

  const remainingText = safeMoney(remaining, currency);
  if (remainingText === null) return null;
  const percent = Math.max(0, Math.min(99, Math.floor((subtotalCents * 100) / thresholdCents)));
  return { kind: "progress", percent, remainingText };
}

/**
 * "Add $X more for free shipping" with a progress bar, or "You've got free
 * shipping!" once the threshold is reached. Server-safe; renders nothing for
 * invalid input or an empty cart.
 */
export function FreeShippingProgress({
  subtotalCents,
  thresholdCents,
  amountToFreeCents,
  currency,
  className,
}: FreeShippingProgressProps) {
  const model = freeShippingModel(subtotalCents, thresholdCents, amountToFreeCents, currency);
  if (model === null) return null;
  const wrapper = ["flex min-w-0 flex-col gap-2", className].filter(Boolean).join(" ");

  if (model.kind === "qualified") {
    return (
      <div className={wrapper}>
        <Notice tone="success">You&apos;ve got free shipping!</Notice>
        <ProgressBar
          label="Free shipping progress"
          hideLabel
          value={100}
          tone="success"
          size="sm"
        />
      </div>
    );
  }

  return (
    <div className={wrapper}>
      <p className="break-words text-small text-text-primary">
        Add <span className="font-semibold">{model.remainingText}</span> more for free shipping
      </p>
      <ProgressBar
        label="Free shipping progress"
        hideLabel
        value={model.percent}
        size="sm"
        valueText={`${model.remainingText} away from free shipping`}
      />
    </div>
  );
}
