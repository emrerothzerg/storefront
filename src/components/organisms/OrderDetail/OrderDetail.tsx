import { useId } from "react";
import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Icon } from "@/components/atoms/Icon";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Price } from "@/components/atoms/Price";
import { Heading, Text } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { formatDeliveryRange } from "@/components/molecules/DeliveryEstimate";
import { formatPlacedDate, getStatusPresentation, productHref } from "@/components/molecules/OrderCard";
import { OrderTimeline } from "@/components/molecules/OrderTimeline";
import {
  ORDER_FIELD,
  type OrderActionFn,
  type OrderActionState,
} from "@/components/molecules/_contracts/order-actions";
import { OrderSummary } from "@/components/organisms/OrderSummary";
import { isValidCents } from "@/lib/money";
import type { FulfillmentStatus } from "@/lib/types";
import type { TimelineStep } from "@/server/fulfillment/timeline";
import { CancelOrderForm } from "./CancelOrderForm";
import {
  cancelMinutesLeft,
  invoiceHref,
  orderHelpHref,
  paymentLabel,
  refundNoticeText,
  shipToLines,
  type CardBrand,
  type ShipToInput,
} from "./order-detail-model";

export interface OrderDetailItem {
  readonly productId: string;
  readonly productSlug: string | null;
  readonly name: string;
  readonly imageUrl: string | null;
  readonly unitPriceCents: number;
  readonly quantity: number;
}

/**
 * The fields of the order service's `OrderView` this organism reads
 * (`OrderView` fits as is). Card data is limited to `cardLast4`; there is
 * deliberately no key for a card number, CVC or expiry (criterion 4). The
 * address email is not part of the type and is never rendered.
 */
export interface OrderDetailOrder {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly items: readonly OrderDetailItem[];
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly couponCode: string | null;
  readonly shippingCents: number;
  readonly shippingMethodName: string | null;
  readonly totalCents: number;
  readonly currency: string;
  readonly address: ShipToInput;
  /** Last four digits only. */
  readonly cardLast4: string;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly timeline: readonly TimelineStep[];
  readonly cancellable: boolean;
  readonly cancellableUntil: string | null;
  readonly estimatedDelivery: { readonly start: string; readonly end: string } | null;
  readonly deliveryNote: string | null;
  readonly cancelledAt?: string;
}

type FormActionProp = (formData: FormData) => void | Promise<unknown>;
type FormAction = (formData: FormData) => void | Promise<void>;

export interface OrderDetailProps {
  order: OrderDetailOrder;
  /** "confirmation" right after checkout (celebration copy), else "detail". */
  variant: "confirmation" | "detail";
  /** `cancelOrder` from `src/app/actions/orders.ts`. Without it no cancel form renders. */
  cancelAction?: OrderActionFn;
  /** Initial cancel state (null = not submitted). */
  cancelState?: OrderActionState;
  /** Per-item "Buy it again" (posts `orderId` + `productId`); pass `buyAgainFromForm`. */
  buyAgainAction: FormActionProp;
  /** Card brand for "Visa ending in 4242"; unknown/absent reads "Card ending in …". */
  paymentBrand?: CardBrand | null;
  /**
   * Epoch ms for the cancel window, supplied by the page (e.g. `Date.now()` in
   * its `_lib` loader). Required so render stays pure; non-finite hides the form.
   */
  now: number;
  /** Level of the page heading. Defaults to 1. */
  headingLevel?: 1 | 2;
  className?: string;
}

const actionLink = "inline-flex min-h-touch items-center";

/**
 * Order detail / confirmation body (T95). Server-safe; the cancel form is a
 * small client island (`useActionState`) that still works without JS. Never
 * renders the owner key, idempotency key, email or any card data beyond the
 * last four digits; user text renders as React text only.
 */
export function OrderDetail({
  order,
  variant,
  cancelAction,
  cancelState = null,
  buyAgainAction,
  paymentBrand = null,
  now,
  headingLevel = 1,
  className,
}: OrderDetailProps) {
  const uid = useId();
  const ids = {
    heading: `order-detail-${uid}-heading`,
    items: `order-detail-${uid}-items`,
    shipTo: `order-detail-${uid}-ship-to`,
    payment: `order-detail-${uid}-payment`,
    refund: `order-detail-${uid}-refund`,
  };
  const sub: 2 | 3 = headingLevel === 1 ? 2 : 3;
  const isConfirmation = variant === "confirmation";
  const items = Array.isArray(order.items) ? order.items : [];
  const placed = formatPlacedDate(order.createdAt);
  const status = getStatusPresentation(order.fulfillmentStatus);
  const isCancelled = order.fulfillmentStatus === "cancelled";
  const range = formatDeliveryRange(order.estimatedDelivery ?? null);
  const rangeText = range === null ? null : range.end === null ? range.start : `${range.start} – ${range.end}`;
  const payment = paymentLabel(order.cardLast4, paymentBrand);
  const shipTo = shipToLines(order.address);
  // Ruling D-T95-1: an invoice exists only for a paid order (cancelled orders stay "paid").
  const printHref = order.status === "paid" ? invoiceHref(order.id) : null;
  const helpHref = orderHelpHref(order.id);
  const minutesLeft =
    order.cancellable === true && !isCancelled ? cancelMinutesLeft(order.createdAt, now, order.cancellableUntil) : 0;
  const isFree = isValidCents(order.shippingCents) && order.shippingCents === 0;
  const cancelledOn = isCancelled ? formatPlacedDate(order.cancelledAt) : null;

  return (
    <article
      aria-labelledby={ids.heading}
      className={["flex min-w-0 flex-col gap-8", className].filter(Boolean).join(" ")}
    >
      <header className="flex min-w-0 flex-col gap-3">
        {isConfirmation ? (
          <>
            <Heading level={headingLevel} id={ids.heading} className="flex items-center gap-2">
              <Icon name="check-circle" size="lg" className="shrink-0 text-success" />
              Order placed
            </Heading>
            <Text>Thank you for your order. We will let you know when it ships.</Text>
            <Text className="min-w-0 break-all">
              {"Order # "}
              <span className="font-mono">{order.id}</span>
            </Text>
            {rangeText !== null && !isCancelled ? (
              <Text className="font-semibold">{`Estimated delivery: ${rangeText}`}</Text>
            ) : null}
          </>
        ) : (
          <>
            <Heading level={headingLevel} id={ids.heading} className="min-w-0 break-all">
              {"Order # "}
              <span className="font-mono">{order.id}</span>
            </Heading>
            {placed !== null ? <Text tone="secondary">{`Placed on ${placed}`}</Text> : null}
          </>
        )}
        <p className="m-0 flex flex-wrap items-center gap-3">
          <Badge tone={status.tone} icon={<Icon name={status.icon} size="sm" />}>
            {status.label}
          </Badge>
          {printHref !== null ? (
            <Link href={printHref} className={actionLink}>
              Print invoice
            </Link>
          ) : null}
        </p>
      </header>

      {isCancelled ? (
        <Card as="section" tone="sunken" aria-labelledby={ids.refund} data-slot="order-refund" className="flex flex-col gap-2">
          <Heading level={sub} size="h4" id={ids.refund}>
            Refund
          </Heading>
          {cancelledOn !== null ? <Text>{`This order was cancelled on ${cancelledOn}.`}</Text> : <Text>This order was cancelled.</Text>}
          <Text>{refundNoticeText(order.totalCents, order.currency, order.cardLast4)}</Text>
        </Card>
      ) : null}

      <div className="grid min-w-0 gap-8 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-8 lg:col-span-2">
          <OrderTimeline steps={order.timeline} estimatedDelivery={order.estimatedDelivery} headingLevel={sub} />

          <Card as="section" aria-labelledby={ids.items} data-slot="order-items" className="flex flex-col gap-4">
            <Heading level={sub} size="h3" id={ids.items}>
              Items
            </Heading>
            <ul role="list" className="m-0 flex list-none flex-col gap-4 p-0">
              {items.map((item, index) => {
                const href = productHref(item.productSlug);
                const reviewHref = productHref(item.productSlug, "#write-review");
                return (
                  <li
                    key={`${item.productId}-${index}`}
                    className="flex min-w-0 flex-col gap-3 border-b border-border-default pb-4 last:border-b-0 last:pb-0 sm:flex-row"
                  >
                    <Image
                      src={item.imageUrl}
                      alt=""
                      width={80}
                      height={80}
                      sizes="80px"
                      rounded
                      className="size-20 shrink-0 object-cover"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <p className="m-0 min-w-0 break-words font-semibold">
                        {href !== null ? (
                          <Link href={href} className={actionLink}>
                            {item.name}
                          </Link>
                        ) : (
                          item.name
                        )}
                      </p>
                      <Text variant="small" tone="secondary" className="flex flex-wrap items-baseline gap-1">
                        <span>{`Qty ${item.quantity} ×`}</span>
                        {isValidCents(item.unitPriceCents) ? (
                          <Price amountCents={item.unitPriceCents} currency={order.currency} className="text-small" />
                        ) : null}
                      </Text>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        {/* React ignores a plain form action's result; the cast only widens the return type. */}
                        <form action={buyAgainAction as FormAction} className="flex">
                          <input type="hidden" name={ORDER_FIELD.orderId} value={order.id} />
                          <input type="hidden" name={ORDER_FIELD.productId} value={item.productId} />
                          <Button type="submit" variant="secondary">
                            Buy it again
                            <VisuallyHidden>{`: ${item.name}`}</VisuallyHidden>
                          </Button>
                        </form>
                        {reviewHref !== null ? (
                          <Link href={reviewHref} className={actionLink}>
                            Write a review
                            <VisuallyHidden>{` for ${item.name}`}</VisuallyHidden>
                          </Link>
                        ) : null}
                        {helpHref !== null ? (
                          <Link href={helpHref} className={actionLink}>
                            Get help
                            <VisuallyHidden>{` with ${item.name}`}</VisuallyHidden>
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-8">
          <OrderSummary
            items={items}
            subtotalCents={order.subtotalCents}
            discountCents={order.discountCents}
            couponCode={order.couponCode}
            shippingCents={isFree ? 0 : order.shippingCents}
            isFreeShipping={isFree}
            shippingMethodName={order.shippingMethodName}
            totalCents={order.totalCents}
            currency={order.currency}
            deliveryNote={order.deliveryNote}
            estimatedDelivery={isCancelled ? null : order.estimatedDelivery}
            variant="invoice"
            invoice={{ orderId: order.id, placedAt: order.createdAt, status: order.status }}
            headingLevel={sub}
          />

          {shipTo.length > 0 ? (
            <Card as="section" aria-labelledby={ids.shipTo} data-slot="order-ship-to" className="flex flex-col gap-2">
              <Heading level={sub} size="h4" id={ids.shipTo}>
                Ship to
              </Heading>
              <address className="not-italic">
                {shipTo.map((line, index) => (
                  <Text key={index} className="break-words">
                    {line}
                  </Text>
                ))}
              </address>
            </Card>
          ) : null}

          <Card as="section" aria-labelledby={ids.payment} data-slot="order-payment" className="flex flex-col gap-2">
            <Heading level={sub} size="h4" id={ids.payment}>
              Payment method
            </Heading>
            <Text>{payment ?? "Card details unavailable"}</Text>
          </Card>

          {cancelAction !== undefined ? (
            // Always mounted when an action is given (renders nothing when there is
            // nothing to show) so its result survives the revalidated re-render.
            <CancelOrderForm
              orderId={order.id}
              cancelAction={cancelAction}
              initialState={cancelState}
              minutesLeft={minutesLeft}
              headingLevel={sub}
            />
          ) : null}
        </div>
      </div>
    </article>
  );
}
