"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/atoms/Button";
import {
  STOCK_ALERT_FIELD,
  initialStockAlertActionState,
  type StockAlertActionFn,
  type StockAlertActionState,
} from "../_contracts/stock-alert-actions";

export interface StockAlertFormProps {
  /** Subscribe action (`subscribeStockAlert`). */
  action: StockAlertActionFn;
  /** Unsubscribe action (`unsubscribeStockAlert`). "Stop watching" renders only with this AND `alertId`. */
  unsubscribeAction?: StockAlertActionFn;
  productId: string;
  /** Posted so the action can revalidate the product page. */
  productSlug: string;
  /** Server truth: the current visitor already watches this product. */
  registered: boolean;
  /** Id of the visitor's alert for this product (needed to stop watching). */
  alertId?: string | null;
  className?: string;
}

export const STOCK_ALERT_COPY = {
  submit: "Notify me when available",
  pending: "Saving…",
  helper: "You'll see a notice here and in your account when it's back; we don't send email.",
  registered: "We'll let you know when this is back in stock.",
  stop: "Stop watching",
  stopPending: "Stopping…",
  unsubscribed: "You're no longer watching this item.",
  alreadyAvailable: "Good news: this item is available now.",
  generic: "We couldn't save that. Please try again.",
} as const;

function minutesFrom(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.max(1, Math.ceil(seconds / 60));
}

/** User-facing text for a failed stock alert state (null when not an error). */
export function stockAlertErrorText(state: StockAlertActionState): string | null {
  if (state === null || state.ok) return null;
  const { error } = state;
  if (error.code === "INVALID_INPUT" && error.details?.reason === "already_available") {
    return STOCK_ALERT_COPY.alreadyAvailable;
  }
  if (error.code === "LIMIT_REACHED") {
    const raw = error.details?.limit;
    const limit = typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : 20;
    return `You're already watching ${limit} items, the maximum. Stop watching one in your account to add this one.`;
  }
  if (error.code === "RATE_LIMITED") {
    const minutes = minutesFrom(state.retryAfterSeconds);
    return `Too many requests. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  return state.message.trim() === "" ? STOCK_ALERT_COPY.generic : state.message;
}

const SUBSCRIBED_KINDS: ReadonlySet<string> = new Set(["subscribed", "already_registered"]);

interface Tracked {
  readonly registeredProp: boolean;
  readonly subscribeState: StockAlertActionState;
  readonly unsubscribeState: StockAlertActionState;
  readonly registered: boolean;
}

/** Never-called fallback so the unsubscribe hook is unconditional. */
const noopAction: StockAlertActionFn = async (prev) => prev;

export function StockAlertForm({
  action,
  unsubscribeAction,
  productId,
  productSlug,
  registered,
  alertId,
  className,
}: StockAlertFormProps) {
  const [subscribeState, subscribeFormAction, subscribePending] = useActionState(
    action,
    initialStockAlertActionState,
  );
  const [unsubscribeState, unsubscribeFormAction, unsubscribePending] = useActionState(
    unsubscribeAction ?? noopAction,
    initialStockAlertActionState,
  );

  // Derived state: the most recent signal wins (a new `registered` prop after
  // revalidation, a subscribe success, or an unsubscribe success).
  const [tracked, setTracked] = useState<Tracked>({
    registeredProp: registered,
    subscribeState,
    unsubscribeState,
    registered,
  });
  let isRegistered = tracked.registered;
  if (
    tracked.registeredProp !== registered ||
    tracked.subscribeState !== subscribeState ||
    tracked.unsubscribeState !== unsubscribeState
  ) {
    if (tracked.registeredProp !== registered) isRegistered = registered;
    if (tracked.subscribeState !== subscribeState && subscribeState?.ok === true && SUBSCRIBED_KINDS.has(subscribeState.kind)) {
      isRegistered = true;
    }
    if (tracked.unsubscribeState !== unsubscribeState && unsubscribeState?.ok === true && unsubscribeState.kind === "unsubscribed") {
      isRegistered = false;
    }
    setTracked({ registeredProp: registered, subscribeState, unsubscribeState, registered: isRegistered });
  }

  const errorText = isRegistered ? stockAlertErrorText(unsubscribeState) : stockAlertErrorText(subscribeState);
  const showUnsubscribed = !isRegistered && unsubscribeState?.ok === true && unsubscribeState.kind === "unsubscribed";
  const canStop = isRegistered && unsubscribeAction !== undefined && typeof alertId === "string" && alertId !== "";
  const wrapper = ["flex flex-col gap-3", className].filter(Boolean).join(" ");

  return (
    <div className={wrapper}>
      {isRegistered ? null : (
        <form action={subscribeFormAction} className="flex flex-col gap-2">
          <input type="hidden" name={STOCK_ALERT_FIELD.productId} value={productId} />
          <input type="hidden" name={STOCK_ALERT_FIELD.productSlug} value={productSlug} />
          <Button type="submit" variant="secondary" fullWidth loading={subscribePending}>
            {subscribePending ? STOCK_ALERT_COPY.pending : STOCK_ALERT_COPY.submit}
          </Button>
          <p className="text-small text-text-secondary">{STOCK_ALERT_COPY.helper}</p>
        </form>
      )}
      <p aria-live="polite" aria-atomic="true" className="text-small text-text-primary">
        {isRegistered ? STOCK_ALERT_COPY.registered : showUnsubscribed ? STOCK_ALERT_COPY.unsubscribed : null}
      </p>
      {canStop ? (
        <form action={unsubscribeFormAction}>
          <input type="hidden" name={STOCK_ALERT_FIELD.alertId} value={alertId} />
          <input type="hidden" name={STOCK_ALERT_FIELD.productSlug} value={productSlug} />
          <Button type="submit" variant="ghost" loading={unsubscribePending}>
            {unsubscribePending ? STOCK_ALERT_COPY.stopPending : STOCK_ALERT_COPY.stop}
          </Button>
        </form>
      ) : null}
      {errorText !== null ? (
        <p role="alert" className="text-small text-danger">
          {errorText}
        </p>
      ) : null}
    </div>
  );
}
