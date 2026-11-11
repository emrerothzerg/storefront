import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Link } from "@/components/atoms/Link";
import { Heading } from "@/components/atoms/Typography";
import { OrderSummary } from "@/components/organisms/OrderSummary";
import { buildMetadata } from "@/lib/seo/metadata";
import { readSessionId } from "@/server/session/session";

import { loadInvoice } from "../../_lib/load-orders";
import { INVOICE_DESCRIPTION, invoiceHeading, invoiceTitle, orderHref } from "../../_lib/page-parts";
import { isOrderIdShape } from "../../_lib/params";

export interface InvoicePageProps {
  readonly params: Promise<{ id: string }>;
}

/** "Invoice · Order #…" from the route param alone; no path (order id stays out of canonical/OG). */
export async function generateMetadata({ params }: InvoicePageProps): Promise<Metadata> {
  const { id } = await params;
  return buildMetadata({ title: invoiceTitle(id), description: INVOICE_DESCRIPTION, noindex: true });
}

/**
 * `/orders/[id]/invoice` (T110): printable invoice. Same ownership path as the
 * detail page (anything not owned -> one `notFound()`). Print-friendly by
 * structure: a single column with one heading, the read-only invoice summary
 * (snapshot prices and stored totals) and a back link; no forms, buttons or
 * scripts of its own. The project has no print-only utilities; printing is the
 * browser's own action.
 */
export default async function InvoicePage({ params }: InvoicePageProps) {
  const { id } = await params;
  // Shape first (D-T110-1): no session read / DB query for a non-UUID id.
  if (!isOrderIdShape(id)) notFound();
  const ownerKey = await readSessionId();
  const data = loadInvoice({ id, ownerKey });
  if (data === null) notFound();
  const backHref = orderHref(data.orderId);

  return (
    <div className="flex min-w-0 max-w-3xl flex-col gap-6">
      <Heading level={1} className="break-words">{invoiceHeading(data.orderId)}</Heading>
      <OrderSummary {...data.summary} heading="Invoice" headingLevel={2} />
      {backHref !== null ? (
        <div>
          <Link href={backHref} className="inline-flex min-h-touch items-center">
            Back to order
          </Link>
        </div>
      ) : null}
    </div>
  );
}
