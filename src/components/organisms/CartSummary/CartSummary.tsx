import { useId, type ReactNode } from "react";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Price } from "@/components/atoms/Price";
import { Heading, Text } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { CouponForm } from "@/components/molecules/CouponForm";
import { FreeShippingProgress } from "@/components/molecules/FreeShippingProgress";
import { ShippingMethodPicker, type ShippingArrival } from "@/components/molecules/ShippingMethodPicker";
import { SummaryList, SummaryRow } from "@/components/molecules/SummaryRow";
import type { CartActionFnV2 } from "@/components/molecules/_contracts/cart-actions";
import { toDisplayAmount, type DisplayAmount } from "../OrderSummary/order-summary-helpers";
import {
  cartSummaryTotalCheck,
  checkoutState,
  isCartSummaryEmpty,
  nonBlank,
  resolveCheckoutHref,
  resolveCurrency,
  subtotalLabel,
  type CartSummaryCart,
} from "./cart-summary-helpers";

export interface CartSummaryActions {
  /** `applyCoupon` server action (posts `couponCode`). */
  readonly applyCoupon: CartActionFnV2;
  /** `removeCoupon` server action (posts no fields). */
  readonly removeCoupon: CartActionFnV2;
  /** `selectShippingMethod` server action (posts `shippingMethodId`). */
  readonly setShippingMethod: CartActionFnV2;
}

export interface CartSummaryProps {
  /** `getCartView()` result (or a trimmed copy with the same fields). */
  cart: CartSummaryCart;
  actions: CartSummaryActions;
  /** Default "/checkout"; a value failing `isAllowedInternalHref` falls back to it. */
  checkoutHref?: string;
  /** ISO 4217; default the cart's currency, else "USD". */
  currency?: string;
  /** Epoch ms for "Tomorrow" in arrival labels (ShippingMethodPicker). */
  now?: number;
  /** Arrival windows keyed by shipping method id (page computes them with `estimateDelivery`). */
  arrivals?: Readonly<Record<string, ShippingArrival>>;
  /**
   * One-time notice that the stored shipping method was deactivated
   * (`CartViewV2.shippingNotice`). Rendered as an info Notice
   * (`role="status"`, polite); blank/absent renders nothing.
   */
  shippingNotice?: string | null;
  /** Default 2. */
  headingLevel?: 2 | 3;
  className?: string;
}

function Money({
  amount,
  currency,
  className,
}: {
  amount: DisplayAmount;
  currency: string;
  className?: string;
}) {
  if (amount.kind === "unavailable") {
    return (
      <span>
        <span aria-hidden="true">—</span>
        <VisuallyHidden>unavailable</VisuallyHidden>
      </span>
    );
  }
  return <Price amountCents={amount.cents} currency={currency} className={className} />;
}

function NotAvailable() {
  return (
    <span>
      <span aria-hidden="true">—</span>
      <VisuallyHidden>not available</VisuallyHidden>
    </span>
  );
}

/**
 * Right-hand cart panel (T92). Server-safe: the interactive parts are the
 * client molecules, each with its own sibling `<form>` (this component never
 * renders a form). Totals are DISPLAYED from the server (`cart.totals`); the
 * OrderSummary recomputation is exposed as `data-total-check`.
 * Renders nothing when the cart has no lines and nothing is saved.
 */
export function CartSummary({
  cart,
  actions,
  checkoutHref,
  currency: currencyProp,
  now,
  arrivals,
  shippingNotice,
  headingLevel = 2,
  className,
}: CartSummaryProps) {
  const headingId = `cart-summary-${useId()}`;
  if (isCartSummaryEmpty(cart)) return null;

  const currency = resolveCurrency(currencyProp, cart.currency);
  const href = resolveCheckoutHref(checkoutHref);
  const state = checkoutState(cart);
  const hasLines = Array.isArray(cart.items) && cart.items.length > 0;
  const totals = cart.totals;
  const shippingNoticeText = nonBlank(shippingNotice);
  const shippingNoticeNode =
    shippingNoticeText !== null ? (
      <Notice tone="info" data-testid="cart-summary-shipping-notice" className="break-words">
        {shippingNoticeText}
      </Notice>
    ) : null;

  const subtotal = toDisplayAmount(totals.subtotalCents);
  const discount = toDisplayAmount(totals.discountCents);
  const shippingAmount = toDisplayAmount(totals.shippingCents);
  const total = toDisplayAmount(totals.totalCents);
  const showDiscount = discount.kind === "unavailable" || discount.cents > 0;

  const coupon = cart.coupon !== null && nonBlank(cart.coupon.code) !== null ? cart.coupon : null;
  const code = coupon !== null ? nonBlank(coupon.code) : null;
  const quote = cart.shipping ?? null;
  const methodName = quote !== null ? nonBlank(quote.method?.name) : null;
  const selectedId = quote !== null && typeof quote.method?.id === "string" ? quote.method.id : null;
  const threshold = quote !== null ? (quote.method?.freeOverCents ?? null) : null;
  const isFree = quote !== null && shippingAmount.kind === "ok" && shippingAmount.cents === 0;

  let shippingValue: ReactNode;
  if (quote === null) shippingValue = <NotAvailable />;
  else {
    const price = isFree ? <span>Free</span> : <Money amount={shippingAmount} currency={currency} />;
    shippingValue =
      methodName !== null ? (
        <span className="inline-flex min-w-0 flex-wrap items-baseline justify-end gap-x-2">
          <span className="min-w-0 break-words text-small text-text-secondary">{methodName}</span> {price}
        </span>
      ) : (
        price
      );
  }

  return (
    <Card
      as="aside"
      aria-labelledby={headingId}
      data-testid="cart-summary"
      data-total-check={hasLines ? cartSummaryTotalCheck(cart) : undefined}
      data-can-checkout={state.canCheckout ? "true" : "false"}
      className={["flex flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      <Heading level={headingLevel} size="h3" id={headingId}>
        Order summary
      </Heading>

      <SummaryList>
        <SummaryRow
          label={subtotalLabel(cart.itemCount)}
          className="flex-wrap"
          value={<Money amount={subtotal} currency={currency} />}
        />
      </SummaryList>

      {hasLines ? null : shippingNoticeNode}

      {hasLines ? (
        <>
          <FreeShippingProgress
            subtotalCents={subtotal.kind === "ok" ? subtotal.cents : 0}
            thresholdCents={threshold}
            amountToFreeCents={totals.amountToFreeShippingCents}
            currency={currency}
          />

          <CouponForm
            applyAction={actions.applyCoupon}
            removeAction={actions.removeCoupon}
            appliedCoupon={coupon !== null && code !== null ? { code, description: coupon.description } : null}
            couponNotice={cart.couponNotice}
            compact
          />

          {shippingNoticeNode}

          <ShippingMethodPicker
            action={actions.setShippingMethod}
            options={Array.isArray(cart.shippingOptions) ? cart.shippingOptions : []}
            selectedId={selectedId}
            arrivals={arrivals}
            currency={currency}
            now={now}
          />

          <SummaryList className="border-t border-border-default pt-4">
            {showDiscount ? (
              <SummaryRow
                label={code !== null ? `Discount (${code})` : "Discount"}
                className="flex-wrap wrap-anywhere"
                value={
                  discount.kind === "unavailable" ? (
                    <Money amount={discount} currency={currency} />
                  ) : (
                    <span data-testid="cart-summary-discount" className="inline-flex items-baseline">
                      <span aria-hidden="true">−</span>
                      <VisuallyHidden>minus </VisuallyHidden>
                      <Price amountCents={discount.cents} currency={currency} />
                    </span>
                  )
                }
              />
            ) : null}
            <SummaryRow label="Shipping" className="flex-wrap" value={shippingValue} />
            <SummaryRow
              label="Total"
              value={
                <span data-testid="cart-summary-total">
                  <Money amount={total} currency={currency} />
                </span>
              }
              emphasis
              className="flex-wrap font-semibold"
            />
          </SummaryList>
        </>
      ) : null}

      {state.canCheckout ? (
        <Link href={href} variant="button" className="w-full">
          Proceed to checkout
        </Link>
      ) : (
        <Text data-testid="cart-summary-blocked" className="break-words">
          {state.text}
        </Text>
      )}
    </Card>
  );
}
