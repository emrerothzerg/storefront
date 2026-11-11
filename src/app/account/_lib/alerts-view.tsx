import { Badge } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Heading, Text } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import {
  STOCK_ALERT_FIELD,
  type StockAlertActionFn,
} from "@/components/molecules/_contracts/stock-alert-actions";
import type { StockAlertView } from "@/server/alerts/stock-alert-service";

import { asFormAction } from "./form-action";
import { alertStatusText, formatAccountDate, isoForTimeElement, productHref } from "./page-parts";

export interface AlertsViewProps {
  readonly alerts: readonly StockAlertView[];
  readonly unsubscribeAction: StockAlertActionFn;
  readonly acknowledgeAction: StockAlertActionFn;
}

export const ALERTS_HEADING = "Your stock alerts";
export const ALERTS_EMPTY_TEXT =
  "You're not watching any products. Choose “Notify me when available” on an out-of-stock product to get an alert here.";

/** Badge/text for an alert whose product is unpublished or gone (D-T98-4). */
export const ALERT_UNAVAILABLE_TEXT = "No longer available";

const ALERT_ID = /^[A-Za-z0-9-]{1,100}$/;
const SLUG = /^[a-z0-9-]{1,100}$/;

/**
 * `/account/alerts` body (T98, criterion 4). Server component; plain forms:
 * "Stop watching" posts `unsubscribeStockAlert`, and an unacknowledged
 * back-in-stock alert shows a success notice with an "Acknowledge" form
 * posting `acknowledgeStockAlert`. Hidden fields carry only the opaque alert
 * id and product slug (R-T87-3). An alert whose product is no longer
 * offered (`available: false` from the service, or `product: null`) shows
 * the name as text with "No longer available" and keeps only its forms
 * (D-T98-4): no product link, no slug field.
 */
export function AlertsView({ alerts, unsubscribeAction, acknowledgeAction }: AlertsViewProps) {
  const unsubscribe = asFormAction(unsubscribeAction);
  const acknowledge = asFormAction(acknowledgeAction);
  return (
    <section aria-labelledby="alerts-heading" className="flex min-w-0 flex-col gap-4">
      <Heading level={1} id="alerts-heading">
        {ALERTS_HEADING}
      </Heading>
      <Text variant="small" tone="secondary">
        We show alerts here and in Your Account. We don&apos;t send email.
      </Text>
      {alerts.length === 0 ? (
        <Card tone="sunken">
          <Text tone="secondary">{ALERTS_EMPTY_TEXT}</Text>
        </Card>
      ) : (
        <Card padding="none">
          <ul role="list" aria-label="Watched products" className="flex min-w-0 flex-col divide-y divide-border-default">
            {alerts.map((alert) => {
              const name = alert.product?.name ?? "Product no longer available";
              const available = alert.product !== null && alert.available !== false;
              const href = available && alert.product !== null ? productHref(alert.product.slug) : null;
              const slug = available && alert.product !== null && SLUG.test(alert.product.slug) ? alert.product.slug : null;
              const postable = ALERT_ID.test(alert.id);
              const backInStock = alert.status === "back_in_stock";
              const needsAck = backInStock && alert.acknowledgedAt === null;
              const since = formatAccountDate(alert.createdAt);
              const sinceIso = isoForTimeElement(alert.createdAt);
              return (
                <li key={alert.id} className="flex min-w-0 flex-col gap-3 p-4">
                  <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
                    <Image
                      src={alert.product?.imageUrl ?? null}
                      alt=""
                      width={64}
                      height={64}
                      rounded
                      className="size-16 shrink-0 object-cover"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {href !== null ? (
                        <Link href={href} className="inline-flex min-h-touch items-center break-words">
                          {name}
                        </Link>
                      ) : (
                        <Text className="break-words">{name}</Text>
                      )}
                      <div className="flex flex-wrap items-center gap-2">
                        {available ? (
                          <Badge tone={backInStock ? "success" : "neutral"}>{alertStatusText(alert.status)}</Badge>
                        ) : (
                          <Badge tone="neutral">{ALERT_UNAVAILABLE_TEXT}</Badge>
                        )}
                        {since !== null && sinceIso !== null ? (
                          <Text as="span" variant="small" tone="secondary">
                            {"Watching since "}
                            <time dateTime={sinceIso}>{since}</time>
                          </Text>
                        ) : null}
                      </div>
                    </div>
                    {postable ? (
                      <form action={unsubscribe} className="flex shrink-0">
                        <input type="hidden" name={STOCK_ALERT_FIELD.alertId} value={alert.id} />
                        {slug !== null ? <input type="hidden" name={STOCK_ALERT_FIELD.productSlug} value={slug} /> : null}
                        <Button type="submit" variant="secondary" size="sm">
                          Stop watching
                          <VisuallyHidden>{` ${name}`}</VisuallyHidden>
                        </Button>
                      </form>
                    ) : null}
                  </div>
                  {needsAck ? (
                    <Notice
                      tone={available ? "success" : "info"}
                      title={available ? "Back in stock" : ALERT_UNAVAILABLE_TEXT}
                    >
                      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <span className="break-words">
                          {available ? `${name} is available again.` : `${name} is no longer available.`}
                        </span>
                        {postable ? (
                          <form action={acknowledge} className="flex shrink-0">
                            <input type="hidden" name={STOCK_ALERT_FIELD.alertId} value={alert.id} />
                            {slug !== null ? (
                              <input type="hidden" name={STOCK_ALERT_FIELD.productSlug} value={slug} />
                            ) : null}
                            <Button type="submit" variant="secondary" size="sm">
                              Acknowledge
                              <VisuallyHidden>{` back-in-stock alert for ${name}`}</VisuallyHidden>
                            </Button>
                          </form>
                        ) : null}
                      </div>
                    </Notice>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </section>
  );
}
