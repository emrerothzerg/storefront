"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
  type ReactNode,
} from "react";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@/components/atoms/Button";
import { Link } from "@/components/atoms/Link";
import { Text } from "@/components/atoms/Typography";
import { AddressFields } from "@/components/molecules/AddressFields";
import { PaymentFields } from "@/components/molecules/PaymentFields";
import {
  CHECKOUT_FIELD,
  initialCheckoutActionState,
  type CheckoutActionFn,
  type CheckoutActionState,
} from "../_contracts/checkout-actions";
import {
  ADDRESS_FIELDS,
  ADDRESS_ID_PREFIX,
  ADDRESS_LABELS,
  Alert,
  CARD_FIELDS,
  CARD_ID_PREFIX,
  CARD_LABELS,
  focusField,
  linkClasses,
  nextIdempotencyKey,
  readStockLines,
  splitFieldErrors,
} from "./checkout-form-shared";
import { CheckoutFormV2, type CheckoutFormV2Config } from "./CheckoutFormV2";

export { nextIdempotencyKey, readStockLines, splitFieldErrors } from "./checkout-form-shared";
export type { SplitFieldErrors, StockChangedLine } from "./checkout-form-shared";

export interface CheckoutFormMvpProps {
  /** Checkout server action matching the checkout action contract. */
  placeOrder: CheckoutActionFn;
  /** Server-rendered key so a no-JS submit carries one too. */
  initialIdempotencyKey: string;
  /** Where "Review your cart" links go. Defaults to "/cart". */
  cartHref?: string;
  className?: string;
  v2?: undefined;
}

/** v2 (T93): `placeOrder` is replaced by `v2.action`; see CheckoutFormV2.tsx. */
export interface CheckoutFormV2Props {
  /** Server-rendered key so a no-JS submit carries one too. */
  initialIdempotencyKey: string;
  className?: string;
  placeOrder?: undefined;
  cartHref?: undefined;
  v2: CheckoutFormV2Config;
}

/** MVP props (unchanged) or the v2 shape (`v2` present). */
export type CheckoutFormProps = CheckoutFormMvpProps | CheckoutFormV2Props;

/** MVP form when `v2` is absent (markup and behaviour unchanged); CheckoutForm v2 otherwise. */
export function CheckoutForm(props: CheckoutFormProps) {
  if (props.v2 !== undefined) {
    return (
      <CheckoutFormV2 config={props.v2} initialIdempotencyKey={props.initialIdempotencyKey} className={props.className} />
    );
  }
  return <CheckoutFormMvp {...props} />;
}

function CheckoutFormMvp({
  placeOrder,
  initialIdempotencyKey,
  cartHref = "/cart",
  className,
}: CheckoutFormMvpProps) {
  // Progressive enhancement: before hydration (or with JS off) the form posts
  // through useActionState and the page re-renders with its returned state.
  const [peState, peFormAction, pePending] = useActionState(placeOrder, initialCheckoutActionState);

  // With JS, submissions go through `submit` below so a thrown action
  // (network error) keeps the current state, values and idempotency key
  // instead of hitting the error boundary.
  const [clientState, setClientState] = useState<CheckoutActionState | undefined>(undefined);
  const [networkError, setNetworkError] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(initialIdempotencyKey);
  const [feedbackVersion, setFeedbackVersion] = useState(0);
  const [completedAttempts, setCompletedAttempts] = useState(0);
  const [isPending, startTransition] = useTransition();

  const state = clientState === undefined ? peState : clientState;
  const pending = isPending || pePending;
  const inFlight = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (feedbackVersion > 0) alertRef.current?.focus();
  }, [feedbackVersion]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inFlight.current || pending) return; // double-submit guard
    inFlight.current = true;
    const formData = new FormData(event.currentTarget);

    startTransition(async () => {
      try {
        const next = await placeOrder(state, formData);
        startTransition(() => {
          setClientState(next ?? null);
          setNetworkError(false);
          setIdempotencyKey((prev) => nextIdempotencyKey(prev, true));
          setFeedbackVersion((v) => v + 1);
          // Remounts the fieldsets (see `key` below).
          setCompletedAttempts((n) => n + 1);
        });
      } catch (error) {
        // redirect()/notFound() reject the call on success: let Next handle them.
        unstable_rethrow(error);
        startTransition(() => {
          setNetworkError(true);
          setFeedbackVersion((v) => v + 1);
        });
      } finally {
        inFlight.current = false;
      }
    });
  };

  const error = state?.error;
  const { address: addressErrors, card: cardErrors } = splitFieldErrors(error);
  const { nameOnCard, ...addressValues } = state?.values ?? {};

  let feedback: ReactNode = null;
  if (networkError) {
    feedback = (
      <Alert title="We couldn't place your order" alertRef={alertRef}>
        <Text>
          We couldn&apos;t reach the store, so your order was not confirmed. Check your connection and
          select &quot;Place order&quot; again. You won&apos;t be charged twice.
        </Text>
      </Alert>
    );
  } else if (error?.code === "VALIDATION_FAILED") {
    const items = [
      ...ADDRESS_FIELDS.flatMap((field) => {
        const e = addressErrors[field];
        return e ? [{ id: `${ADDRESS_ID_PREFIX}-${field}`, label: ADDRESS_LABELS[field], message: e.message }] : [];
      }),
      ...CARD_FIELDS.flatMap((field) => {
        const e = cardErrors[field];
        return e ? [{ id: `${CARD_ID_PREFIX}-${field}`, label: CARD_LABELS[field], message: e.message }] : [];
      }),
    ];
    feedback = (
      <Alert title="Please fix the following" alertRef={alertRef}>
        {items.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id}>
                <a href={`#${item.id}`} className={linkClasses} onClick={(e) => focusField(e, item.id)}>
                  {item.label}: {item.message}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <Text>{error.message}</Text>
        )}
      </Alert>
    );
  } else if (error?.code === "PAYMENT_FAILED") {
    feedback = (
      <Alert title="Your payment didn't go through" alertRef={alertRef}>
        <Text>{error.message}</Text>
        <Text>Try a different card, or check the card details and try again.</Text>
      </Alert>
    );
  } else if (error?.code === "STOCK_CHANGED") {
    const lines = readStockLines(error);
    feedback = (
      <Alert title="Some items in your cart changed" alertRef={alertRef}>
        <Text>{error.message}</Text>
        {lines.length > 0 ? (
          <ul className="flex list-disc flex-col gap-1 pl-6">
            {lines.map((line) => (
              <li key={line.productId}>
                {line.name}:{" "}
                {line.available > 0
                  ? `you asked for ${line.requested}, only ${line.available} available.`
                  : "no longer available."}
              </li>
            ))}
          </ul>
        ) : null}
        <Link href={cartHref}>Review your cart</Link>
      </Alert>
    );
  } else if (error?.code === "EMPTY_CART") {
    feedback = (
      <Alert title="Your cart is empty" alertRef={alertRef}>
        <Text>{error.message}</Text>
        <Link href={cartHref}>Go to your cart</Link>
      </Alert>
    );
  } else if (error) {
    feedback = (
      <Alert title="We couldn't place your order" alertRef={alertRef}>
        <Text>{error.message}</Text>
      </Alert>
    );
  }

  return (
    <form
      action={peFormAction}
      onSubmit={onSubmit}
      noValidate
      aria-label="Checkout"
      className={["flex flex-col gap-8", className].filter(Boolean).join(" ")}
    >
      {feedback}
      <input type="hidden" name={CHECKOUT_FIELD.idempotencyKey} value={idempotencyKey} readOnly />
      {/*
        After every completed attempt the fieldsets remount, which matches
        React's automatic <form action> reset: card number/expiry/CVC come back
        empty and address + name come back from the returned values. A plain
        form reset is not enough because React applies a changed
        <select defaultValue> only on mount, so Country would be lost.
      */}
      <AddressFields
        key={`address-${completedAttempts}`}
        idPrefix={ADDRESS_ID_PREFIX} errors={addressErrors} defaultValues={addressValues} />
      <PaymentFields
        key={`card-${completedAttempts}`}
        idPrefix={CARD_ID_PREFIX}
        errors={cardErrors}
        defaultValues={nameOnCard === undefined ? undefined : { nameOnCard }}
      />
      <Button type="submit" size="lg" fullWidth loading={pending}>
        Place order
      </Button>
    </form>
  );
}
