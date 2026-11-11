import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Checkbox } from "@/components/atoms/Checkbox";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Heading, Text } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import {
  CLEAR_HISTORY_CONFIRM_VALUE,
  VIEW_FIELD,
  type ViewActionFn,
} from "@/components/molecules/_contracts/view-actions";

import { asFormAction } from "./form-action";
import type { HistoryEntry } from "./loaders";
import { formatAccountDate, isoForTimeElement, productHref } from "./page-parts";

export interface HistoryViewProps {
  readonly entries: readonly HistoryEntry[];
  readonly removeAction: ViewActionFn;
  readonly clearAction: ViewActionFn;
}

export const HISTORY_HEADING = "Your browsing history";
export const HISTORY_EMPTY_TEXT = "You haven't viewed any products yet. Items you look at will show up here.";

/**
 * `/account/history` body (T98, criterion 3). Server component: every
 * mutation is a plain `<form action>`; "Remove" works without JS and "Clear
 * history" needs the required `confirm=yes` checkbox (the action re-checks it).
 * Product names render as text.
 */
export function HistoryView({ entries, removeAction, clearAction }: HistoryViewProps) {
  const remove = asFormAction(removeAction);
  const clear = asFormAction(clearAction);
  return (
    <section aria-labelledby="history-heading" className="flex min-w-0 flex-col gap-4">
      <Heading level={1} id="history-heading">
        {HISTORY_HEADING}
      </Heading>
      {entries.length === 0 ? (
        <Card tone="sunken">
          <Text tone="secondary">{HISTORY_EMPTY_TEXT}</Text>
        </Card>
      ) : (
        <>
          <Text variant="small" tone="secondary">
            {`Showing your ${entries.length === 1 ? "most recent item" : `${entries.length} most recent items`}. We keep up to 50.`}
          </Text>
          <Card padding="none">
            <ul role="list" aria-label="Viewed products" className="flex min-w-0 flex-col divide-y divide-border-default">
              {entries.map(({ product, viewedAt }) => {
                const href = productHref(product.slug);
                const date = formatAccountDate(viewedAt);
                const dateTime = isoForTimeElement(viewedAt);
                return (
                  <li
                    key={product.id}
                    className="flex min-w-0 flex-col gap-3 p-4 sm:flex-row sm:items-center"
                  >
                    <Image src={product.imageUrl} alt="" width={64} height={64} rounded className="size-16 shrink-0 object-cover" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {href !== null ? (
                        <Link href={href} className="inline-flex min-h-touch items-center break-words">
                          {product.name}
                        </Link>
                      ) : (
                        <Text className="break-words">{product.name}</Text>
                      )}
                      {date !== null && dateTime !== null ? (
                        <Text variant="small" tone="secondary">
                          {"Viewed on "}
                          <time dateTime={dateTime}>{date}</time>
                        </Text>
                      ) : null}
                    </div>
                    <form action={remove} className="flex shrink-0">
                      <input type="hidden" name={VIEW_FIELD.productId} value={product.id} />
                      <Button type="submit" variant="secondary" size="sm">
                        Remove
                        <VisuallyHidden>{` ${product.name} from your history`}</VisuallyHidden>
                      </Button>
                    </form>
                  </li>
                );
              })}
            </ul>
          </Card>
          <Card as="section" aria-labelledby="clear-history-heading" className="flex flex-col gap-3">
            <Heading level={2} size="h3" id="clear-history-heading">
              Clear browsing history
            </Heading>
            <form action={clear} className="flex min-w-0 flex-col gap-3">
              <Checkbox
                name={VIEW_FIELD.confirm}
                value={CLEAR_HISTORY_CONFIRM_VALUE}
                required
                label="Yes, remove every item from my browsing history"
              />
              <div>
                <Button type="submit" variant="danger">
                  Clear history
                </Button>
              </div>
            </form>
          </Card>
        </>
      )}
    </section>
  );
}
