"use client";

import { useId, useState } from "react";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";

export const PRICE_RANGE_ERROR = "Min price must be less than or equal to max price.";

export interface PriceInputsProps {
  /** Current URL value in whole dollars. */
  min?: number;
  /** Current URL value in whole dollars. */
  max?: number;
}

/** Whole dollars from a text field; anything else (blank, decimals, negatives) is `undefined`. */
export function parseWholeDollars(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d{1,9}$/.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 10);
}

/** True when both bounds are set and min > max. */
export function isPriceRangeInverted(min: number | undefined, max: number | undefined): boolean {
  return min !== undefined && max !== undefined && min > max;
}

function initial(value: number | undefined): string {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
}

/**
 * Min/Max price inputs (`name="min"` / `name="max"`, whole dollars) for the
 * listing GET form. The "min > max" message is a hint only: it is rendered
 * on the server from the current URL values and updated live with JS; the
 * server stays authoritative and the form is never blocked.
 */
export function PriceInputs({ min, max }: PriceInputsProps) {
  const baseId = useId();
  const minId = `${baseId}-min`;
  const maxId = `${baseId}-max`;
  const errorId = `${baseId}-error`;
  const [minText, setMinText] = useState(() => initial(min));
  const [maxText, setMaxText] = useState(() => initial(max));
  const inverted = isPriceRangeInverted(parseWholeDollars(minText), parseWholeDollars(maxText));
  const describedBy = inverted ? errorId : undefined;

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <FormField id={minId} label="Min price">
          {(field) => (
            <Input
              {...field}
              name="min"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={9}
              placeholder="$ Min"
              value={minText}
              onChange={(event) => setMinText(event.currentTarget.value)}
              aria-describedby={describedBy}
              invalid={inverted}
            />
          )}
        </FormField>
        <FormField id={maxId} label="Max price">
          {(field) => (
            <Input
              {...field}
              name="max"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              maxLength={9}
              placeholder="$ Max"
              value={maxText}
              onChange={(event) => setMaxText(event.currentTarget.value)}
              aria-describedby={describedBy}
              invalid={inverted}
            />
          )}
        </FormField>
      </div>
      <p id={errorId} aria-live="polite" className="m-0 text-small text-danger">
        {inverted ? PRICE_RANGE_ERROR : null}
      </p>
    </div>
  );
}
