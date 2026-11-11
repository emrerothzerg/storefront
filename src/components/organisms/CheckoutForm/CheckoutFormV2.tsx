"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Checkbox } from "@/components/atoms/Checkbox";
import { Chip } from "@/components/atoms/Chip";
import { FormField } from "@/components/atoms/FormField";
import { Input } from "@/components/atoms/Input";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Price } from "@/components/atoms/Price";
import { Radio, RadioGroup } from "@/components/atoms/Radio";
import { Textarea } from "@/components/atoms/Textarea";
import { Heading, Text } from "@/components/atoms/Typography";
import { AddressCard } from "@/components/molecules/AddressCard";
import { AddressFields } from "@/components/molecules/AddressFields";
import { PHONE_PATTERN } from "@/components/molecules/AddressForm";
import { formatDeliveryRange } from "@/components/molecules/DeliveryEstimate";
import { FreeShippingProgress } from "@/components/molecules/FreeShippingProgress";
import { PaymentFields } from "@/components/molecules/PaymentFields";
import { usableShippingOptions, type ShippingArrival } from "@/components/molecules/ShippingMethodPicker";
import { ADDRESS_MAX_LENGTH } from "@/components/molecules/_contracts/address-actions";
import { isAllowedInternalHref } from "@/content/routes";
import { formatMoney, isValidCents } from "@/lib/money";
import type { SavedAddress } from "@/lib/types";
import type { AddressField, CardField, FieldError, FieldErrors } from "@/lib/validation";
import type { ShippingQuote } from "@/server/pricing/shipping-service";
import { OrderSummary, computeOrderSummaryTotal, type OrderSummaryLine } from "../OrderSummary";
import {
  CHECKOUT_ADDRESS_MODES,
  CHECKOUT_FIELD_V2,
  CHECKOUT_MAX_LENGTH_V2,
  initialCheckoutActionStateV2,
  type CheckoutActionFnV2,
  type CheckoutActionStateV2,
  type CheckoutAddressMode,
  type CheckoutRetainedValuesV2,
} from "../_contracts/checkout-actions";
import {
  ADDRESS_FIELDS,
  ADDRESS_ID_PREFIX,
  ADDRESS_LABELS,
  Alert,
  CARD_FIELDS,
  CARD_ID_PREFIX,
  CARD_LABELS,
  isRecord,
  linkClasses,
  readStockLines,
  splitFieldErrors,
} from "./checkout-form-shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Coupon applied to the cart (read-only here; changed on the cart page). */
export interface CheckoutV2Coupon {
  readonly code: string;
  readonly description: string;
  /**
   * `true` for a free-shipping coupon (`ValidatedCoupon.kind === "free_shipping"`):
   * the client-side total estimate then keeps shipping at 0 for every method.
   */
  readonly freeShipping?: boolean;
}

/** Server totals for the review block (`getCartView().totals` + lines). */
export interface CheckoutFormV2Summary {
  readonly items: ReadonlyArray<OrderSummaryLine>;
  readonly subtotalCents: number;
  readonly discountCents: number;
  /** Shipping of `shipping.selectedId` as priced by the server. */
  readonly shippingCents: number;
  readonly totalCents: number;
}

export interface CheckoutFormV2Config {
  /** `placeOrderV2` from `@/app/actions/checkout-v2`. */
  readonly action: CheckoutActionFnV2;
  /** The shopper's own address book (owner key). `[]` = new address only. */
  readonly savedAddresses: readonly SavedAddress[];
  readonly shipping: {
    /** `getCartView().shippingOptions`. */
    readonly options: readonly ShippingQuote[];
    /** `getCartView().shipping?.method.id ?? null` (the method the server totals use). */
    readonly selectedId: string | null;
    /** Arrival windows keyed by method id (ISO strings). */
    readonly arrivals?: Readonly<Record<string, ShippingArrival>>;
    /** ISO 4217 code, used for every amount on the form. */
    readonly currency: string;
    /** Epoch ms for "Tomorrow" in arrival labels (pass from the loader; never `Date.now()` in render). */
    readonly now?: number;
  };
  readonly summary: CheckoutFormV2Summary;
  readonly coupon: CheckoutV2Coupon | null;
  readonly freeShipping?: {
    readonly subtotalCents: number;
    readonly thresholdCents: number | null;
    readonly amountToFreeCents: number | null;
    readonly currency: string;
  } | null;
  readonly isSignedIn: boolean;
  /** Account email (signed-in only). With `isSignedIn` it replaces the email input. */
  readonly email?: string | null;
  /** "Change in cart" / cart links. Default "/cart"; must pass `isAllowedInternalHref`. */
  readonly cartHref?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * v2 idempotency key rule: keep the key when the outcome is unknown (a
 * network error, `"network"`, or a returned INTERNAL_ERROR, per the v2
 * contract); generate a fresh one after every other completed attempt (MVP).
 */
export function nextIdempotencyKeyV2(
  prevKey: string,
  outcome: "network" | CheckoutActionStateV2,
  generate: () => string = () => crypto.randomUUID(),
): string {
  if (outcome === "network") return prevKey;
  if (outcome?.error.code === "INTERNAL_ERROR") return prevKey;
  return generate();
}

/** v2-only field names that carry their own inline error. */
export type CheckoutV2ExtraField = "addressId" | "shippingMethodId" | "deliveryNote" | "addressLabel" | "phone";
const EXTRA_FIELDS: readonly CheckoutV2ExtraField[] = ["addressId", "phone", "addressLabel", "shippingMethodId", "deliveryNote"];

export interface CheckoutV2Errors {
  readonly address: FieldErrors<AddressField>;
  readonly card: FieldErrors<CardField>;
  readonly extra: Readonly<Partial<Record<CheckoutV2ExtraField, string>>>;
}

function message(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Maps a v2 failure to inline errors. Address and v2 fields come from
 * `fieldErrors` (falling back to the MVP `details.fields` for address keys
 * only when the state has no `fieldErrors`); card errors come ONLY from
 * `error.details.fields` (the action never puts card keys in `fieldErrors`).
 * Malformed entries are ignored; values are never read.
 */
export function mapV2Errors(state: CheckoutActionStateV2): CheckoutV2Errors {
  if (state === null || !isRecord(state)) return { address: {}, card: {}, extra: {} };
  const split = splitFieldErrors(state.error);
  const raw: unknown = state.fieldErrors;
  if (!isRecord(raw)) return { address: split.address, card: split.card, extra: {} };

  const address: Partial<Record<AddressField, FieldError>> = {};
  for (const field of ADDRESS_FIELDS) {
    const text = message(raw[field]);
    if (text !== null) address[field] = { code: split.address[field]?.code ?? "INVALID_TYPE", message: text };
  }
  const extra: Partial<Record<CheckoutV2ExtraField, string>> = {};
  for (const field of EXTRA_FIELDS) {
    const text = message(raw[field]);
    if (text !== null) extra[field] = text;
  }
  return { address, card: split.card, extra };
}

/** Element ids of the v2 controls (error-summary targets). */
export const CHECKOUT_V2_IDS = {
  email: `${ADDRESS_ID_PREFIX}-email`,
  addressMode: "checkout-addressMode",
  addressId: "checkout-addressId",
  phone: "checkout-phone",
  addressLabel: "checkout-addressLabel",
  saveAddress: "checkout-saveAddress",
  shippingMethodId: "checkout-shippingMethodId",
  deliveryNote: "checkout-deliveryNote",
} as const;

const EXTRA_LABELS: Readonly<Record<CheckoutV2ExtraField, string>> = {
  addressId: "Saved address",
  phone: "Phone",
  addressLabel: "Address label",
  shippingMethodId: "Shipping method",
  deliveryNote: "Delivery note",
};

export interface ErrorSummaryItem {
  readonly id: string;
  readonly label: string;
  readonly message: string;
}

/** Summary entries in form order: email, saved address, address fields, phone, label, shipping, note, card. */
export function errorSummaryItems(errors: CheckoutV2Errors): ErrorSummaryItem[] {
  const items: ErrorSummaryItem[] = [];
  const addressItem = (field: AddressField) => {
    const e = errors.address[field];
    if (e) items.push({ id: `${ADDRESS_ID_PREFIX}-${field}`, label: ADDRESS_LABELS[field], message: e.message });
  };
  const extraItem = (field: CheckoutV2ExtraField) => {
    const text = errors.extra[field];
    if (text !== undefined) items.push({ id: CHECKOUT_V2_IDS[field], label: EXTRA_LABELS[field], message: text });
  };
  addressItem("email");
  extraItem("addressId");
  for (const field of ADDRESS_FIELDS) if (field !== "email") addressItem(field);
  extraItem("phone");
  extraItem("addressLabel");
  extraItem("shippingMethodId");
  extraItem("deliveryNote");
  for (const field of CARD_FIELDS) {
    const e = errors.card[field];
    if (e) items.push({ id: `${CARD_ID_PREFIX}-${field}`, label: CARD_LABELS[field], message: e.message });
  }
  return items;
}

export interface DisplayTotals {
  readonly shippingCents: number;
  readonly totalCents: number;
  /** True when the client re-priced shipping for a method other than the server's. */
  readonly estimated: boolean;
  readonly methodName: string | null;
}

/**
 * Totals for the review block. The server's numbers are shown unchanged
 * while the chosen method is the one they were priced with; after the
 * shopper picks another method (JS only) shipping is re-priced from that
 * quote (0 when free or with a free-shipping coupon) and the total is
 * recomputed exactly (`computeOrderSummaryTotal`). Any arithmetic failure
 * falls back to the server totals. The server re-prices at submit anyway.
 */
export function displayTotals(
  summary: CheckoutFormV2Summary,
  options: readonly ShippingQuote[],
  serverSelectedId: string | null,
  chosenId: string | null,
  coupon: CheckoutV2Coupon | null,
): DisplayTotals {
  const nameOf = (id: string | null) => options.find((o) => o.method.id === id)?.method.name ?? null;
  const server: DisplayTotals = {
    shippingCents: summary.shippingCents,
    totalCents: summary.totalCents,
    estimated: false,
    methodName: nameOf(serverSelectedId),
  };
  if (chosenId === null || chosenId === serverSelectedId) return server;
  const quote = options.find((o) => o.method.id === chosenId);
  if (quote === undefined) return server;
  const shippingCents = coupon?.freeShipping === true || quote.isFree ? 0 : quote.priceCents;
  if (!isValidCents(shippingCents)) return server;
  const total = computeOrderSummaryTotal({ items: summary.items, shippingCents, discountCents: summary.discountCents });
  if (!total.ok) return server;
  return { shippingCents, totalCents: total.value, estimated: true, methodName: quote.method.name };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const noopSubscribe = () => () => {};
/** false in server HTML and during hydration, true afterwards. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

const ADDRESS_INPUT_MAX: Readonly<Partial<Record<AddressField, number>>> = {
  fullName: ADDRESS_MAX_LENGTH.fullName,
  email: 254,
  line1: ADDRESS_MAX_LENGTH.line1,
  line2: ADDRESS_MAX_LENGTH.line2,
  city: ADDRESS_MAX_LENGTH.city,
  region: ADDRESS_MAX_LENGTH.region,
  postalCode: ADDRESS_MAX_LENGTH.postalCode,
};

const COUPON_CODES: ReadonlySet<string> = new Set([
  "COUPON_INVALID",
  "COUPON_EXPIRED",
  "COUPON_EXHAUSTED",
  "COUPON_USED",
  "COUPON_MIN_SUBTOTAL",
]);

function isAddressMode(value: unknown): value is CheckoutAddressMode {
  return (CHECKOUT_ADDRESS_MODES as readonly unknown[]).includes(value);
}

/** Error-summary link: focuses the control; a radio group focuses its checked (or first) radio. */
function focusTarget(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return; // native fragment navigation
  event.preventDefault();
  let focusable: HTMLElement = target;
  if (target.tagName === "FIELDSET") {
    const radio =
      target.querySelector<HTMLInputElement>('input[type="radio"]:checked') ??
      target.querySelector<HTMLInputElement>('input[type="radio"]');
    if (radio) focusable = radio;
  }
  focusable.focus();
  focusable.scrollIntoView?.({ block: "center" });
}

function safeMoney(cents: number, currency: string): string | null {
  if (!isValidCents(cents)) return null;
  try {
    return formatMoney(cents, currency);
  } catch {
    return null;
  }
}

/** Each checkout step is a white `Card` panel (Phase 3); `Card` adds `min-w-0`. */
const sectionClasses = "flex flex-col gap-4";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CheckoutFormV2ComponentProps {
  config: CheckoutFormV2Config;
  initialIdempotencyKey: string;
  className?: string;
}

/**
 * Checkout v2 (T93): one `<form>` posting every `CHECKOUT_FIELD_V2` name plus
 * the MVP card fields to `placeOrderV2`. Same progressive-enhancement model,
 * double-submit guard and remount-on-completion as the MVP form; the
 * idempotency key is also kept after INTERNAL_ERROR (v2 contract).
 */
export function CheckoutFormV2({ config, initialIdempotencyKey, className }: CheckoutFormV2ComponentProps) {
  const [peState, peFormAction, pePending] = useActionState(config.action, initialCheckoutActionStateV2);
  const [clientState, setClientState] = useState<CheckoutActionStateV2 | undefined>(undefined);
  const [networkError, setNetworkError] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState(initialIdempotencyKey);
  const [feedbackVersion, setFeedbackVersion] = useState(0);
  const [completedAttempts, setCompletedAttempts] = useState(0);
  const [isPending, startTransition] = useTransition();

  const state = clientState === undefined ? peState : clientState;
  const pending = isPending || pePending;
  const inFlight = useRef(false);
  const alertRef = useRef<HTMLDivElement>(null);
  const cartHref = config.cartHref !== undefined && isAllowedInternalHref(config.cartHref) ? config.cartHref : "/cart";

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
        const next = await config.action(state, formData);
        startTransition(() => {
          setClientState(next ?? null);
          setNetworkError(false);
          setIdempotencyKey((prev) => nextIdempotencyKeyV2(prev, next ?? null));
          setFeedbackVersion((v) => v + 1);
          setCompletedAttempts((n) => n + 1);
        });
      } catch (error) {
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

  const errors = mapV2Errors(state);
  const error = state?.error;
  const items = errorSummaryItems(errors);

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
  } else if (items.length > 0) {
    feedback = (
      <Alert title="Please fix the following" alertRef={alertRef}>
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.id} className="break-words">
              <a href={`#${item.id}`} className={linkClasses} onClick={(e) => focusTarget(e, item.id)}>
                {item.label}: {item.message}
              </a>
            </li>
          ))}
        </ul>
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
              <li key={line.productId} className="break-words">
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
  } else if (error !== undefined && COUPON_CODES.has(error.code)) {
    feedback = (
      <Alert title="Your promo code can't be used" alertRef={alertRef}>
        <Text>{error.message}</Text>
        <Text>Nothing was charged. Remove or change the code in your cart, then place your order.</Text>
        <Link href={cartHref} className="inline-flex min-h-touch items-center">Change in cart</Link>
      </Alert>
    );
  } else if (error?.code === "INTERNAL_ERROR") {
    feedback = (
      <Alert title="We couldn't place your order" alertRef={alertRef}>
        <Text>{error.message}</Text>
        <Text>Select &quot;Place order&quot; again. You won&apos;t be charged twice.</Text>
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
      className={["flex min-w-0 flex-col gap-8", className].filter(Boolean).join(" ")}
    >
      {feedback}
      <input type="hidden" name={CHECKOUT_FIELD_V2.idempotencyKey} value={idempotencyKey} readOnly />
      {/* Remounted after every completed attempt (see the MVP form): card data comes back empty, the rest from `values`. */}
      <CheckoutV2Body
        key={`attempt-${completedAttempts}`}
        config={config}
        cartHref={cartHref}
        values={state?.values}
        errors={errors}
        placeOrder={
          <>
            <Text variant="small" tone="secondary">
              By placing your order, you agree to our <Link href="/terms">Conditions of Use</Link> and{" "}
              <Link href="/privacy">Privacy Notice</Link>.
            </Text>
            <Button type="submit" size="lg" fullWidth loading={pending}>
              {pending ? "Placing order…" : "Place order"}
            </Button>
          </>
        }
      />
    </form>
  );
}

interface BodyProps {
  config: CheckoutFormV2Config;
  cartHref: string;
  values: CheckoutRetainedValuesV2 | undefined;
  errors: CheckoutV2Errors;
  /** Terms line + "Place order" submit; rendered under the review card in the summary column. */
  placeOrder: ReactNode;
}

/**
 * Layout (U06): one column below `lg` (steps, then review, then "Place
 * order" last); from `lg` two columns, steps left (flex-1, max-w-3xl), review +
 * "Place order" right (fixed basis 20rem, 24rem from `xl`, like the cart summary) and sticky under the ~64px sticky header (`top-20`).
 * Both columns are inside the one checkout `<form>`; DOM order is the
 * reading and tab order at every width.
 */
function CheckoutV2Body({ config, cartHref, values, errors, placeOrder }: BodyProps) {
  const hydrated = useHydrated();
  const { savedAddresses, shipping, summary, coupon, freeShipping } = config;
  const saved = Array.isArray(savedAddresses) ? savedAddresses : [];
  const hasSaved = saved.length > 0;
  const options = usableShippingOptions(shipping.options);
  const currency = shipping.currency;

  const [mode, setMode] = useState<CheckoutAddressMode>(() => {
    if (!hasSaved) return "new";
    return isAddressMode(values?.addressMode) ? values.addressMode : "saved";
  });
  const [shippingId, setShippingId] = useState<string | null>(() => {
    const has = (id: string | null | undefined): id is string => typeof id === "string" && options.some((o) => o.method.id === id);
    if (has(values?.shippingMethodId)) return values.shippingMethodId;
    return has(shipping.selectedId) ? shipping.selectedId : null;
  });

  const checkedAddressId =
    saved.find((a) => a.id === values?.addressId)?.id ?? saved.find((a) => a.isDefault)?.id ?? saved[0]?.id;

  // Email: account email (text + hidden input) / its own field next to saved
  // addresses (it must post in both modes) / inside AddressFields (MVP shape).
  const accountEmail = config.isSignedIn && typeof config.email === "string" && config.email.trim() !== "" ? config.email : null;
  const emailPlacement: "account" | "standalone" | "inline" = accountEmail !== null ? "account" : hasSaved ? "standalone" : "inline";
  const totals = displayTotals(summary, options, shipping.selectedId, shippingId, coupon);
  const arrival = shippingId !== null ? (shipping.arrivals?.[shippingId] ?? null) : null;

  return (
    <div data-testid="checkout-layout" className="flex min-w-0 flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
      <div data-testid="checkout-steps" className="flex min-w-0 flex-col gap-8 lg:max-w-3xl lg:flex-1">
        <Card as="section" aria-labelledby="checkout-step-address" className={sectionClasses}>
          <Heading level={2} size="h3" id="checkout-step-address">
            Delivery address
          </Heading>

          {emailPlacement === "account" ? (
            <div className="flex min-w-0 flex-col gap-1">
              <Text id={CHECKOUT_V2_IDS.email} tabIndex={-1} className="break-words">
                Order updates go to <strong>{accountEmail}</strong>
              </Text>
              <input type="hidden" name="email" value={accountEmail ?? ""} />
            </div>
          ) : null}
          {emailPlacement === "standalone" ? (
            <FormField id={CHECKOUT_V2_IDS.email} label="Email" required error={errors.address.email?.message} hint="For your order confirmation.">
              {(p) => (
                <Input
                  {...p}
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  spellCheck={false}
                  maxLength={254}
                  defaultValue={values?.email}
                />
              )}
            </FormField>
          ) : null}

          {hasSaved ? (
            <>
              <RadioGroup
                id={CHECKOUT_V2_IDS.addressMode}
                label="Where should we deliver?"
                name={CHECKOUT_FIELD_V2.addressMode}
                value={mode}
                onChange={(next) => {
                  if (isAddressMode(next)) setMode(next);
                }}
              >
                <Radio value="saved" label="Deliver to a saved address" />
                <Radio value="new" label="Use a new address" />
              </RadioGroup>
              <RadioGroup
                id={CHECKOUT_V2_IDS.addressId}
                label="Your saved addresses"
                name={CHECKOUT_FIELD_V2.addressId}
                errorText={errors.extra.addressId}
                onChange={() => setMode("saved")}
              >
                <ul className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-2">
                  {saved.map((address) => (
                    <li key={address.id} className="min-w-0">
                      <AddressCard
                        address={address}
                        compact
                        headingLevel={3}
                        selectable={{ name: CHECKOUT_FIELD_V2.addressId, value: address.id, checked: address.id === checkedAddressId }}
                      />
                    </li>
                  ))}
                </ul>
              </RadioGroup>
            </>
          ) : (
            <input type="hidden" name={CHECKOUT_FIELD_V2.addressMode} value="new" />
          )}

          {/* Without JS (and before hydration) this is always shown; the server decides by `addressMode`. */}
          <div
            data-testid="checkout-new-address"
            hidden={hydrated && mode !== "new"}
            className="flex min-w-0 flex-col gap-4"
          >
            {hasSaved ? (
              <Text variant="small" tone="secondary" data-testid="checkout-new-address-hint">
                Fill this in only if you chose &quot;Use a new address&quot;. Otherwise we deliver to the saved address you
                selected.
              </Text>
            ) : null}
            <AddressFields
              idPrefix={ADDRESS_ID_PREFIX}
              legend={hasSaved ? "New shipping address" : "Shipping address"}
              // "Shipping address" repeats the card's "Delivery address" heading: keep it for AT only.
              hideLegend={!hasSaved}
              omit={emailPlacement === "inline" ? undefined : ["email"]}
              maxLengths={ADDRESS_INPUT_MAX}
              errors={errors.address}
              defaultValues={values}
            />
            <FormField id={CHECKOUT_V2_IDS.phone} label="Phone (optional)" error={errors.extra.phone}>
              {(p) => (
                <Input
                  {...p}
                  name={CHECKOUT_FIELD_V2.phone}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  maxLength={CHECKOUT_MAX_LENGTH_V2.phone}
                  pattern={PHONE_PATTERN}
                  defaultValue={values?.phone}
                />
              )}
            </FormField>
            <Checkbox
              id={CHECKOUT_V2_IDS.saveAddress}
              name={CHECKOUT_FIELD_V2.saveAddress}
              value="on"
              label="Save this address"
              description="Adds it to your address book after the order is placed."
              defaultChecked={values?.saveAddress === true}
            />
            <FormField
              id={CHECKOUT_V2_IDS.addressLabel}
              label="Address label (optional)"
              hint="e.g. Home, Office. Used only when you save the address."
              error={errors.extra.addressLabel}
            >
              {(p) => (
                <Input
                  {...p}
                  name={CHECKOUT_FIELD_V2.addressLabel}
                  maxLength={CHECKOUT_MAX_LENGTH_V2.addressLabel}
                  autoComplete="off"
                  defaultValue={values?.addressLabel}
                />
              )}
            </FormField>
          </div>
        </Card>

        <Card as="section" aria-labelledby="checkout-step-shipping" className={sectionClasses}>
          <Heading level={2} size="h3" id="checkout-step-shipping">
            Shipping method
          </Heading>
          {options.length > 0 ? (
            <RadioGroup
              id={CHECKOUT_V2_IDS.shippingMethodId}
              label="Choose a shipping method"
              hideLabel
              name={CHECKOUT_FIELD_V2.shippingMethodId}
              value={shippingId ?? ""}
              onChange={(next) => setShippingId(next)}
              errorText={errors.extra.shippingMethodId}
            >
              {options.map((option) => {
                const { method } = option;
                const range = formatDeliveryRange(shipping.arrivals?.[method.id] ?? null, shipping.now);
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
          ) : (
            <Notice tone="info">We&apos;ll use the shipping method from your cart.</Notice>
          )}
        </Card>

        <Card as="section" aria-labelledby="checkout-step-note" className={sectionClasses}>
          <Heading level={2} size="h3" id="checkout-step-note">
            Delivery instructions
          </Heading>
          <FormField
            id={CHECKOUT_V2_IDS.deliveryNote}
            label="Delivery note (optional)"
            hint="e.g. Leave the parcel at the side door."
            error={errors.extra.deliveryNote}
          >
            {(p) => (
              <Textarea
                {...p}
                name={CHECKOUT_FIELD_V2.deliveryNote}
                maxLength={CHECKOUT_MAX_LENGTH_V2.deliveryNote}
                showCount
                rows={3}
                defaultValue={values?.deliveryNote}
              />
            )}
          </FormField>
        </Card>

        <Card as="section" aria-labelledby="checkout-step-promo" className={sectionClasses}>
          <Heading level={2} size="h3" id="checkout-step-promo">
            Promo code
          </Heading>
          {coupon !== null && coupon.code.trim() !== "" ? (
            <div data-testid="checkout-coupon" className="flex min-w-0 flex-wrap items-center gap-3">
              <Chip as="span" label={coupon.code} selected className="max-w-full break-all" />
              {coupon.description.trim() !== "" ? (
                <Text className="min-w-0 break-words">{coupon.description}</Text>
              ) : null}
              <Link href={cartHref} className="inline-flex min-h-touch items-center">Change in cart</Link>
            </div>
          ) : (
            <Text>
              Have a promo code? <Link href={cartHref}>Add it in your cart</Link>
            </Text>
          )}
        </Card>

        <Card as="section" aria-labelledby="checkout-step-payment" className={sectionClasses}>
          <Heading level={2} size="h3" id="checkout-step-payment">
            Payment
          </Heading>
          <PaymentFields
            idPrefix={CARD_ID_PREFIX}
            hideLegend
            errors={errors.card}
            defaultValues={values?.nameOnCard === undefined ? undefined : { nameOnCard: values.nameOnCard }}
          />
        </Card>

      </div>

      <div
        data-testid="checkout-review-column"
        className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-20 lg:shrink-0 lg:basis-80 xl:basis-96"
      >
        <Card as="section" aria-labelledby="checkout-step-review" className={sectionClasses}>
          <Heading level={2} size="h3" id="checkout-step-review">
            Review your order
          </Heading>
          {freeShipping ? (
            <FreeShippingProgress
              subtotalCents={freeShipping.subtotalCents}
              thresholdCents={freeShipping.thresholdCents}
              amountToFreeCents={freeShipping.amountToFreeCents}
              currency={freeShipping.currency}
            />
          ) : null}
          <OrderSummary
            headingLevel={3}
            items={summary.items}
            subtotalCents={summary.subtotalCents}
            discountCents={summary.discountCents}
            couponCode={coupon?.code ?? null}
            shippingCents={totals.shippingCents}
            shippingMethodName={totals.methodName}
            totalCents={totals.totalCents}
            currency={currency}
            estimatedDelivery={arrival}
          />
          <Text variant="small" tone="secondary" aria-live="polite" data-testid="checkout-total-note">
            {totals.estimated
              ? `Shipping and total updated for ${totals.methodName ?? "your chosen method"}. The final amount is confirmed when you place your order.`
              : null}
          </Text>
        </Card>
        {placeOrder}
      </div>
    </div>
  );
}
