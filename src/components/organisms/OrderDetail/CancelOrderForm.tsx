"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Checkbox } from "@/components/atoms/Checkbox";
import { Notice } from "@/components/atoms/Notice";
import { Heading, Text } from "@/components/atoms/Typography";
import {
  ORDER_CONFIRM_VALUE,
  ORDER_FIELD,
  type OrderActionFn,
  type OrderActionState,
} from "@/components/molecules/_contracts/order-actions";
import { cancelWindowText } from "./order-detail-model";

export interface CancelOrderFormProps {
  orderId: string;
  cancelAction: OrderActionFn;
  /** Initial state (e.g. from a server re-render); null = not submitted. */
  initialState?: OrderActionState;
  /** Whole minutes left; the form renders only when >= 1. */
  minutesLeft: number;
  /** Level of the "Cancel order" heading. Defaults to 2. */
  headingLevel?: 2 | 3;
}

/**
 * Cancel form island. Always mounted while the page offers cancelling (even
 * after the window closes) so the result message survives the revalidated
 * re-render. Works without JavaScript: `useActionState` with a server action
 * re-renders the page with the returned state.
 */
export function CancelOrderForm({
  orderId,
  cancelAction,
  initialState = null,
  minutesLeft,
  headingLevel = 2,
}: CancelOrderFormProps) {
  const headingId = `cancel-order-${useId()}`;
  const [state, formAction, pending] = useActionState(cancelAction, initialState);
  const cancelled = state !== null && state.ok && state.kind === "cancelled";
  const showForm = !cancelled && Number.isInteger(minutesLeft) && minutesLeft >= 1;

  if (state === null && !showForm) return null;

  return (
    <Card as="section" aria-labelledby={headingId} data-slot="order-cancel" className="flex flex-col gap-3">
      <Heading level={headingLevel} size="h4" id={headingId}>
        Cancel order
      </Heading>
      {state !== null && state.ok ? <Notice tone="success">{state.message}</Notice> : null}
      {state !== null && !state.ok ? <Notice tone="danger">{state.message}</Notice> : null}
      {showForm ? (
        <form action={formAction} className="flex min-w-0 flex-col gap-3">
          <input type="hidden" name={ORDER_FIELD.orderId} value={orderId} />
          <Text>{cancelWindowText(minutesLeft)}</Text>
          <Checkbox
            name={ORDER_FIELD.confirm}
            value={ORDER_CONFIRM_VALUE}
            required
            label="Yes, cancel this order"
            description="Items go back in stock and any promo code is released."
          />
          <div>
            <Button type="submit" variant="danger" loading={pending}>
              Cancel order
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
