import { useId, type ReactNode } from "react";
import { Card } from "@/components/atoms/Card";
import { Price } from "@/components/atoms/Price";
import { Heading, Text } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { formatDeliveryRange } from "@/components/molecules/DeliveryEstimate";
import { SummaryList, SummaryRow } from "@/components/molecules/SummaryRow";
import { multiplyCents } from "@/lib/money";
import {
  checkOrderSummaryTotal,
  formatPlacedDate,
  formatStatus,
  nonEmpty,
  normaliseLast4,
  toDisplayAmount,
  toDisplayQuantity,
  type DisplayAmount,
} from "./order-summary-helpers";

export interface OrderSummaryLine {
  readonly productId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  /** Accepted so `OrderViewItem`/cart lines can be passed as is; not rendered (no links in the summary). */
  readonly productSlug?: string | null;
  /** Accepted for the same reason; not rendered. */
  readonly imageUrl?: string | null;
}

export interface OrderSummaryShipTo {
  readonly fullName: string;
  readonly line1: string;
  readonly line2?: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly country: string;
}

export interface OrderSummaryInvoice {
  readonly orderId: string;
  /** ISO date-time; shown en-US, UTC ("November 7, 2026"). */
  readonly placedAt: string;
  /** e.g. "paid", "payment_failed"; shown humanised ("Payment failed"). */
  readonly status: string;
  /** Exactly four digits, otherwise the payment line is omitted. */
  readonly paymentLast4?: string | null;
  readonly billToName?: string | null;
  readonly shipTo?: OrderSummaryShipTo | null;
}

export type OrderSummaryVariant = "default" | "invoice";

export interface OrderSummaryProps {
  items: ReadonlyArray<OrderSummaryLine>;
  subtotalCents: number;
  /** 0 is displayed as "Free". */
  shippingCents: number;
  /**
   * Displayed as given; the server computes it (not re-derived here). The
   * exact recomputation (items + shipping − discount) is exposed as
   * `data-total-check="match" | "mismatch" | "unavailable"` on the section.
   */
  totalCents: number;
  /** ISO 4217 code. */
  currency: string;
  /** Defaults to "Order summary". */
  heading?: string;
  /** Defaults to 2. */
  headingLevel?: 2 | 3;
  className?: string;
  /** Discount in cents; the row is shown only when > 0. */
  discountCents?: number;
  /** Shown in the discount label: "Discount (WELCOME10)". */
  couponCode?: string | null;
  /** Shown in the shipping row next to the price or "Free". */
  shippingMethodName?: string | null;
  /** Forces "Free" in the shipping row (display only; pass shippingCents 0 too). */
  isFreeShipping?: boolean;
  /** Customer text; rendered as text (whitespace-pre-line) only when non-empty. */
  deliveryNote?: string | null;
  /** ISO range from the shipping service; invalid ranges are omitted. */
  estimatedDelivery?: { readonly start: string; readonly end: string } | null;
  /** "invoice" adds the order header block; no interactive controls in either variant. */
  variant?: OrderSummaryVariant;
  /** Header data for `variant="invoice"`; ignored otherwise. */
  invoice?: OrderSummaryInvoice | null;
}

function Unavailable() {
  return (
    <span>
      <span aria-hidden="true">—</span>
      <VisuallyHidden>unavailable</VisuallyHidden>
    </span>
  );
}

function Money({
  amount,
  currency,
  className,
  testId,
}: {
  amount: DisplayAmount;
  currency: string;
  className?: string;
  testId?: string;
}) {
  if (amount.kind === "unavailable") return <Unavailable />;
  return (
    <Price amountCents={amount.cents} currency={currency} className={className} data-testid={testId} />
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="presentation" className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-small text-text-secondary">{label}</dt>
      <dd className="min-w-0 break-words text-body text-text-primary">{children}</dd>
    </div>
  );
}

function InvoiceHeader({ invoice }: { invoice: OrderSummaryInvoice }) {
  const orderId = nonEmpty(invoice.orderId);
  const placed = formatPlacedDate(invoice.placedAt);
  const status = formatStatus(invoice.status);
  const last4 = normaliseLast4(invoice.paymentLast4);
  const billTo = nonEmpty(invoice.billToName);
  const shipTo = invoice.shipTo ?? null;
  const shipLines: string[] = [];
  if (shipTo !== null) {
    const cityLine = [nonEmpty(shipTo.city), [nonEmpty(shipTo.region), nonEmpty(shipTo.postalCode)].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", ");
    for (const line of [shipTo.fullName, shipTo.line1, shipTo.line2, cityLine, shipTo.country]) {
      const text = nonEmpty(line);
      if (text !== null) shipLines.push(text);
    }
  }

  return (
    <dl
      data-testid="order-summary-invoice"
      className="grid min-w-0 grid-cols-1 gap-3 border-b border-border-default pb-4 sm:grid-cols-2"
    >
      <DetailRow label="Order number">
        {orderId !== null ? <span className="font-mono break-all">{orderId}</span> : <Unavailable />}
      </DetailRow>
      <DetailRow label="Order placed">{placed !== null ? placed : <Unavailable />}</DetailRow>
      <DetailRow label="Status">{status !== null ? status : <Unavailable />}</DetailRow>
      {last4 !== null ? <DetailRow label="Payment">{`Paid with card ending in ${last4}`}</DetailRow> : null}
      {billTo !== null ? <DetailRow label="Bill to">{billTo}</DetailRow> : null}
      {shipLines.length > 0 ? (
        <DetailRow label="Ship to">
          {shipLines.map((line, index) => (
            <span key={index} className="block">
              {line}
            </span>
          ))}
        </DetailRow>
      ) : null}
    </dl>
  );
}

/**
 * Read-only order breakdown for cart, checkout, confirmation, order detail
 * and invoice. Server-safe. Line totals are unit x quantity; subtotal,
 * discount, shipping and total are shown exactly as supplied by the server.
 * Invalid amounts display as 0; amounts beyond MAX_SAFE_INTEGER display "—"
 * with a visually hidden "unavailable" (never throws, never renders NaN).
 */
export function OrderSummary({
  items,
  subtotalCents,
  shippingCents,
  totalCents,
  currency,
  heading = "Order summary",
  headingLevel = 2,
  className,
  discountCents,
  couponCode,
  shippingMethodName,
  isFreeShipping = false,
  deliveryNote,
  estimatedDelivery,
  variant = "default",
  invoice,
}: OrderSummaryProps) {
  const headingId = `order-summary-${useId()}`;
  const isInvoice = variant === "invoice";
  const safeItems = Array.isArray(items) ? items : [];

  const subtotal = toDisplayAmount(subtotalCents);
  const shipping = toDisplayAmount(shippingCents);
  const total = toDisplayAmount(totalCents);
  const discount = toDisplayAmount(discountCents);
  const showDiscount = discount.kind === "unavailable" || discount.cents > 0;
  const code = nonEmpty(couponCode);
  const method = nonEmpty(shippingMethodName);
  const isFree = isFreeShipping === true || (shipping.kind === "ok" && shipping.cents === 0);
  const note = nonEmpty(deliveryNote);
  const range = formatDeliveryRange(estimatedDelivery ?? null);

  const totalCheck = checkOrderSummaryTotal(
    { items: safeItems, shippingCents, discountCents: discountCents ?? 0 },
    totalCents,
  );

  return (
    <Card
      as="section"
      aria-labelledby={headingId}
      data-variant={variant}
      data-total-check={totalCheck}
      className={["flex flex-col gap-4", className].filter(Boolean).join(" ")}
    >
      <Heading level={headingLevel} size="h3" id={headingId}>
        {heading}
      </Heading>

      {isInvoice && invoice != null ? <InvoiceHeader invoice={invoice} /> : null}

      {safeItems.length > 0 ? (
        <ul role="list" className="flex min-w-0 flex-col gap-3">
          {safeItems.map((item, index) => {
            const quantity = toDisplayQuantity(item.quantity);
            const unit = toDisplayAmount(item.unitPriceCents);
            const lineTotal =
              unit.kind === "ok" ? multiplyCents(unit.cents, quantity) : null;
            return (
              <li
                key={`${String(item.productId)}:${index}`}
                className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
              >
                <span className="flex min-w-0 flex-col">
                  <Text as="span" className="min-w-0 break-words">
                    {`${String(item.name ?? "")} × ${quantity}`}
                  </Text>
                  {isInvoice && lineTotal !== null && lineTotal.ok && unit.kind === "ok" ? (
                    <Text as="span" variant="small" tone="secondary" className="flex flex-wrap items-baseline gap-1">
                      <Price amountCents={unit.cents} currency={currency} className="text-small" />
                      <span>each</span>
                    </Text>
                  ) : null}
                </span>
                {lineTotal !== null && lineTotal.ok ? (
                  <Price amountCents={lineTotal.value} currency={currency} data-testid="order-line-total" />
                ) : (
                  <Text as="span" variant="small" className="flex flex-wrap items-baseline gap-1">
                    <Money amount={unit} currency={currency} />
                    <span>{`each, quantity ${quantity}`}</span>
                  </Text>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      <SummaryList className="border-t border-border-default pt-4">
        <SummaryRow label="Subtotal" value={<Money amount={subtotal} currency={currency} />} />
        {showDiscount ? (
          <SummaryRow
            label={code !== null ? `Discount (${code})` : "Discount"}
            className="flex-wrap wrap-anywhere"
            value={
              discount.kind === "unavailable" ? (
                <Unavailable />
              ) : (
                <span data-testid="order-discount" className="inline-flex items-baseline">
                  <span aria-hidden="true">−</span>
                  <VisuallyHidden>minus </VisuallyHidden>
                  <Price amountCents={discount.cents} currency={currency} />
                </span>
              )
            }
          />
        ) : null}
        <SummaryRow
          label="Shipping"
          className="flex-wrap"
          value={
            method !== null ? (
              <span className="inline-flex flex-wrap items-baseline justify-end gap-x-2">
                <span className="break-words text-small text-text-secondary">{method}</span>{" "}
                {isFree ? <span>Free</span> : <Money amount={shipping} currency={currency} />}
              </span>
            ) : isFree ? (
              "Free"
            ) : (
              <Money amount={shipping} currency={currency} />
            )
          }
        />
        <SummaryRow
          label="Total"
          value={<Money amount={total} currency={currency} />}
          emphasis
          className="flex-wrap font-semibold"
        />
      </SummaryList>

      {range !== null || note !== null ? (
        <dl className="flex min-w-0 flex-col gap-3 border-t border-border-default pt-4" aria-label="Delivery details">
          {range !== null ? (
            <DetailRow label="Estimated delivery">
              <span data-testid="order-estimated-delivery">
                {range.start}
                {range.end !== null ? (
                  <>
                    {" "}
                    <span aria-hidden="true">–</span>{" "}
                    <VisuallyHidden>to</VisuallyHidden> {range.end}
                  </>
                ) : null}
              </span>
            </DetailRow>
          ) : null}
          {note !== null ? (
            <DetailRow label="Delivery note">
              <span data-testid="order-delivery-note" className="whitespace-pre-line">
                {note}
              </span>
            </DetailRow>
          ) : null}
        </dl>
      ) : null}
    </Card>
  );
}
