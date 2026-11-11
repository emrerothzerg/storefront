"use client";

import { useActionState, useSyncExternalStore } from "react";
import type { ChangeEvent } from "react";
import { Button } from "@/components/atoms/Button";
import { Price } from "@/components/atoms/Price";
import { Radio, RadioGroup } from "@/components/atoms/Radio";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { formatMoney, isValidCents } from "@/lib/money";
import type { ShippingQuote } from "@/server/pricing/shipping-service";
import { formatDeliveryRange } from "../DeliveryEstimate";
import {
  CART_FIELD_V2,
  initialCartActionStateV2,
  type CartActionFnV2,
  type CartActionStateV2,
} from "../_contracts/cart-actions";

/** Precomputed arrival window (ISO strings) for one method. */
export interface ShippingArrival {
  readonly start: string;
  readonly end: string;
}

export interface ShippingMethodPickerProps {
  /** `selectShippingMethod` server action (posts `shippingMethodId`). */
  action: CartActionFnV2;
  /** Quotes from the shipping service, in display order. */
  options: readonly ShippingQuote[];
  /** Method in effect; its radio is checked. Unknown ids check nothing. */
  selectedId: string | null;
  /** Arrival windows keyed by method id (computed by the page/organism). */
  arrivals?: Readonly<Record<string, ShippingArrival>>;
  /** Submit on change after hydration and hide the Update button. Default true. */
  autoSubmit?: boolean;
  /** ISO 4217 code for prices. Default "USD". */
  currency?: string;
  /** Epoch ms used only for "Tomorrow" in arrival labels. */
  now?: number;
  /** Group label. Default "Shipping method". */
  label?: string;
  className?: string;
}

const noopSubscribe = () => () => {};

/** false in server HTML and during hydration, true afterwards. */
function useIsHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

/** Drops quotes that cannot be rendered safely (missing id/name, invalid money). */
export function usableShippingOptions(options: readonly ShippingQuote[]): ShippingQuote[] {
  if (!Array.isArray(options)) return [];
  const seen = new Set<string>();
  const result: ShippingQuote[] = [];
  for (const option of options) {
    const method = option?.method;
    if (method == null || typeof method.id !== "string" || method.id === "") continue;
    if (typeof method.name !== "string" || method.name.trim() === "") continue;
    if (seen.has(method.id)) continue;
    if (option.isFree !== true && !isValidCents(option.priceCents)) continue;
    seen.add(method.id);
    result.push(option);
  }
  return result;
}

function safeMoney(cents: number, currency: string): string | null {
  if (!isValidCents(cents)) return null;
  try {
    return formatMoney(cents, currency);
  } catch {
    return null;
  }
}

// Stable id per failed state object so the radios reset to `selectedId`
// after a failed post (the server kept the previous method).
const failureKeys = new WeakMap<object, number>();
let nextFailureKey = 1;
function failureKey(state: CartActionStateV2): string {
  if (state === null || state.ok) return "";
  let key = failureKeys.get(state);
  if (key === undefined) {
    key = nextFailureKey++;
    failureKeys.set(state, key);
  }
  return `:e${key}`;
}

/**
 * Shipping method radio group inside one `<form action>`. Each option reads
 * "<name> — <price or Free> — Arrives <range>". Without JS the visible
 * "Update" button posts the choice and the page re-renders with the new
 * `selectedId`; after hydration (with `autoSubmit`) a change submits the form
 * and the button becomes visually hidden (still reachable by keyboard).
 */
export function ShippingMethodPicker({
  action,
  options,
  selectedId,
  arrivals,
  autoSubmit = true,
  currency = "USD",
  now,
  label = "Shipping method",
  className,
}: ShippingMethodPickerProps) {
  const [state, formAction, isPending] = useActionState(action, initialCartActionStateV2);
  const hydrated = useIsHydrated();
  const usable = usableShippingOptions(options);
  if (usable.length === 0) return null;

  const enhanced = hydrated && autoSubmit;
  const selected = usable.some((o) => o.method.id === selectedId) ? (selectedId ?? undefined) : undefined;
  const errorText = state?.ok === false ? state.error.message : undefined;

  const handleChange = (_value: string, event: ChangeEvent<HTMLInputElement>) => {
    if (!enhanced) return;
    const form = event.currentTarget.form;
    if (form === null) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  };

  return (
    <form action={formAction} className={["flex min-w-0 flex-col gap-2", className].filter(Boolean).join(" ")}>
      <RadioGroup
        key={`${selected ?? ""}${failureKey(state)}`}
        label={label}
        name={CART_FIELD_V2.shippingMethodId}
        defaultValue={selected}
        onChange={handleChange}
        errorText={errorText}
        aria-busy={isPending || undefined}
      >
        {usable.map((option) => {
          const { method } = option;
          const range = formatDeliveryRange(arrivals?.[method.id] ?? null, now);
          const toFree =
            !option.isFree && option.amountToFreeCents !== null && option.amountToFreeCents > 0
              ? safeMoney(option.amountToFreeCents, currency)
              : null;
          return (
            <Radio
              key={method.id}
              value={method.id}
              label={
                <span className="break-words">
                  <span className="font-semibold">{method.name}</span>
                  {" — "}
                  {option.isFree ? (
                    <span className="font-semibold">Free</span>
                  ) : (
                    <Price amountCents={option.priceCents} currency={currency} />
                  )}
                  {range !== null ? (
                    <>
                      {" — Arrives "}
                      {range.start}
                      {range.end !== null ? ` – ${range.end}` : null}
                    </>
                  ) : null}
                </span>
              }
              description={toFree !== null ? `Free with ${toFree} more in your cart` : undefined}
            />
          );
        })}
      </RadioGroup>
      <div>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={isPending}
          data-enhanced={enhanced ? "true" : undefined}
          className={enhanced ? "sr-only focus:not-sr-only" : undefined}
        >
          {isPending ? "Updating…" : "Update"}
          <VisuallyHidden> shipping method</VisuallyHidden>
        </Button>
      </div>
      <VisuallyHidden as="p" aria-live="polite" aria-atomic="true">
        {state?.ok === true ? state.value.message : null}
      </VisuallyHidden>
    </form>
  );
}
