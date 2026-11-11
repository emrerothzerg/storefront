import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Badge } from "@/components/atoms/Badge";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Heading, Text } from "@/components/atoms/Typography";
import { OrderDetail } from "@/components/organisms/OrderDetail";
import { OrderSummary } from "@/components/organisms/OrderSummary";
import { CHECKOUT_NOTICE_MESSAGES } from "@/components/organisms/_contracts/checkout-actions";
import { buyAgainFromForm, cancelOrder } from "@/app/actions/orders";
import { buildMetadata } from "@/lib/seo/metadata";
import { readSessionId } from "@/server/session/session";

import { loadOrderDetail, type FailedOrder } from "../_lib/load-orders";
import { ORDER_DESCRIPTION, orderBreadcrumb, orderTitle } from "../_lib/page-parts";
import { isOrderIdShape, type SearchParamsRecord } from "../_lib/params";
import { formatAddress, orderStatusLabel, paymentFailureSentence } from "./_lib/order-page";

export interface OrderPageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams?: Promise<SearchParamsRecord>;
}

/**
 * "Order #<first 8 chars>" from the route param alone (no DB read, so the
 * title reveals nothing about existence); malformed ids read "Order". No path:
 * the full order id never goes into a canonical/OG URL, and `?placed=1`
 * cannot change the title or canonical.
 */
export async function generateMetadata(props?: { readonly params?: OrderPageProps["params"] }): Promise<Metadata> {
  // Optional props: callers without params (e.g. tests) get the generic "Order".
  const id = props?.params ? (await props.params).id : undefined;
  return buildMetadata({ title: orderTitle(id), description: ORDER_DESCRIPTION, noindex: true });
}

/** MVP (T25) page for the owner's own declined order. */
function PaymentFailed({ order }: { order: FailedOrder }) {
  const status = orderStatusLabel("payment_failed");
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <header className="flex flex-col gap-3">
        <Heading level={1}>Payment failed</Heading>
        <Text className="flex flex-wrap items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
        </Text>
        <Text>{paymentFailureSentence(order.failureCode)}</Text>
        <div>
          <Link href="/checkout" variant="button">
            Try again
          </Link>
        </div>
      </header>
      <div className="grid min-w-0 gap-8 md:grid-cols-2">
        <OrderSummary
          items={order.items}
          subtotalCents={order.subtotalCents}
          shippingCents={order.shippingCents}
          totalCents={order.totalCents}
          currency={order.currency}
          headingLevel={2}
        />
        <Card className="flex flex-col gap-8 self-start">
          <section aria-labelledby="order-shipping-heading" className="flex flex-col gap-2">
            <Heading level={2} id="order-shipping-heading">
              Shipping address
            </Heading>
            <address className="not-italic">
              {formatAddress({ ...order.address, line2: order.address.line2 ?? "", email: "" }).map((line, index) => (
                <Text key={index} className="break-words">
                  {line}
                </Text>
              ))}
            </address>
          </section>
          <section aria-labelledby="order-payment-heading" className="flex flex-col gap-2">
            <Heading level={2} id="order-payment-heading">
              Payment
            </Heading>
            <Text>Card ending in {order.cardLast4}</Text>
          </section>
        </Card>
      </div>
    </div>
  );
}

/**
 * `/orders/[id]` (T110): order detail, or the confirmation variant with
 * `?placed=1`. Owner only; malformed / unknown / foreign / no-cookie all reach
 * the SAME `notFound()` call. Never renders the owner key, idempotency key,
 * email or card data beyond the last 4 digits.
 */
export default async function OrderPage({ params, searchParams }: OrderPageProps) {
  const { id } = await params;
  // Shape first (D-T110-1): a non-UUID id reaches notFound() with no session
  // read and no DB query (readSessionId resolves the R-1 owner key via the DB).
  if (!isOrderIdShape(id)) notFound();
  const ownerKey = await readSessionId();
  const data = loadOrderDetail({ id, ownerKey, searchParams: searchParams ? await searchParams : {} });
  if (data === null) notFound();

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={orderBreadcrumb(id)} />
      {data.kind === "payment_failed" ? (
        <PaymentFailed order={data.order} />
      ) : (
        <>
          {data.notice !== null ? <Notice tone="warning">{CHECKOUT_NOTICE_MESSAGES[data.notice]}</Notice> : null}
          <OrderDetail
            order={data.order}
            variant={data.variant}
            cancelAction={cancelOrder}
            cancelState={null}
            buyAgainAction={buyAgainFromForm}
            paymentBrand={null}
            now={data.now}
            headingLevel={1}
          />
        </>
      )}
      <div>
        <Link href="/" className="inline-flex min-h-touch items-center">Continue shopping</Link>
      </div>
    </div>
  );
}
