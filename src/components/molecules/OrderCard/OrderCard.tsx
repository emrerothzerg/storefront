import { useId, type HTMLAttributes } from "react";
import { Badge, type BadgeTone } from "@/components/atoms/Badge";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { Icon, type IconName } from "@/components/atoms/Icon";
import { Image } from "@/components/atoms/Image";
import { Link } from "@/components/atoms/Link";
import { Price } from "@/components/atoms/Price";
import { Heading } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { isAllowedInternalHref } from "@/content/routes";
import type { FulfillmentStatus } from "@/lib/types";

/** Thumbnails shown before collapsing the rest into "+N more". */
export const MAX_THUMBNAILS = 4;

export interface OrderCardItem {
  readonly productId: string;
  readonly productSlug: string | null;
  readonly name: string;
  readonly imageUrl: string | null;
  readonly quantity: number;
}

/** Plain data; the order history organism adapts the order service's `OrderView`. */
export interface OrderCardData {
  readonly id: string;
  /** ISO date-time. */
  readonly createdAt: string;
  readonly totalCents: number;
  /** ISO 4217 code. */
  readonly currency: string;
  readonly shipToName: string;
  readonly fulfillmentStatus: FulfillmentStatus;
  readonly items: readonly OrderCardItem[];
  readonly cancellable?: boolean;
}

/**
 * Every href (default or override) must pass `isAllowedInternalHref`; a
 * rejected href drops its action (dev warning) instead of rendering a link.
 */
export interface OrderCardHrefs {
  /** Defaults to `/orders/{id}`. */
  order?: string;
  /** Defaults to `/contact?topic=ordering&order={id}`. */
  help?: string;
}

export interface OrderCardProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  order: OrderCardData;
  /**
   * Server action for "Buy it again"; receives a form with a hidden `orderId`.
   * When absent, "Buy it again" links to the first item's product page.
   */
  buyAgainAction?: (formData: FormData) => void | Promise<unknown>;
  hrefs?: OrderCardHrefs;
  /** Level of the "Order # ..." heading. Defaults to 2. */
  headingLevel?: 2 | 3;
}

interface StatusPresentation {
  readonly label: string;
  readonly tone: BadgeTone;
  readonly icon: IconName;
}

export const ORDER_STATUS_PRESENTATION: Readonly<Record<FulfillmentStatus, StatusPresentation>> = {
  processing: { label: "Processing", tone: "neutral", icon: "clock" },
  packed: { label: "Packed", tone: "neutral", icon: "clock" },
  shipped: { label: "Shipped", tone: "info", icon: "truck" },
  out_for_delivery: { label: "Out for delivery", tone: "info", icon: "truck" },
  delivered: { label: "Delivered", tone: "success", icon: "check-circle" },
  cancelled: { label: "Cancelled", tone: "danger", icon: "error-circle" },
};

/** Unknown or missing status reads as processing (matches the data model default). */
export function getStatusPresentation(status: unknown): StatusPresentation {
  if (typeof status === "string" && Object.hasOwn(ORDER_STATUS_PRESENTATION, status)) {
    return ORDER_STATUS_PRESENTATION[status as FulfillmentStatus];
  }
  return ORDER_STATUS_PRESENTATION.processing;
}

// UTC so server and client render the same text.
const placedFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** "November 7, 2026"; null for missing or unparsable input. Never throws. */
export function formatPlacedDate(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  try {
    return placedFormat.format(ms);
  } catch {
    return null;
  }
}

/** `/products/{slug}` (+ suffix) when the slug yields a planned route, else null. */
export function productHref(slug: string | null | undefined, suffix = ""): string | null {
  if (typeof slug !== "string" || slug.trim() === "") return null;
  const href = `/products/${encodeURIComponent(slug)}${suffix}`;
  return isAllowedInternalHref(href) ? href : null;
}

export function defaultOrderHrefs(id: string): Required<OrderCardHrefs> {
  const encoded = encodeURIComponent(id);
  return {
    order: `/orders/${encoded}`,
    help: `/contact?topic=ordering&order=${encoded}`,
  };
}

/**
 * `href` when it passes `isAllowedInternalHref`, else null. Rejections warn
 * outside production so the bad caller (or a malformed order id) is easy to find.
 */
export function safeOrderHref(href: string | undefined, kind: keyof OrderCardHrefs): string | null {
  if (typeof href === "string" && isAllowedInternalHref(href)) return href;
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `OrderCard: ${kind} href ${JSON.stringify(href)} is not an allowed internal route; omitting the link.`,
    );
  }
  return null;
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Short, display-only order reference used to make the per-card action names
 * unique in a list: the first 8 characters upper-cased for a UUID order id
 * (same convention as the order pages' titles), otherwise the trimmed id;
 * null for a blank or non-string id.
 */
export function orderShortRef(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const trimmed = id.trim();
  if (trimmed === "") return null;
  return UUID_LIKE.test(trimmed) ? trimmed.slice(0, 8).toUpperCase() : trimmed;
}

/** Visually hidden name suffix for the card's actions (" for order 3F2B8C1E"); "" without a usable id. */
export function orderActionSuffix(id: unknown): string {
  const ref = orderShortRef(id);
  return ref === null ? "" : ` for order ${ref}`;
}

function firstProductHref(items: readonly OrderCardItem[], suffix = ""): string | null {
  for (const item of items) {
    const href = productHref(item.productSlug, suffix);
    if (href !== null) return href;
  }
  return null;
}

type FormAction = (formData: FormData) => void | Promise<void>;

const secondaryLink = "inline-flex min-h-touch items-center";

/**
 * One order in the order history: placed date, total, ship-to name, order
 * number, status (text + icon), up to four thumbnails and actions. Server-safe
 * (no "use client"); user text renders as React text only.
 */
export function OrderCard({
  order,
  buyAgainAction,
  hrefs,
  headingLevel = 2,
  className,
  ...rest
}: OrderCardProps) {
  const uid = useId();
  const headingId = `order-card-${uid}`;
  const defaults = defaultOrderHrefs(order.id);
  const orderHref = safeOrderHref(hrefs?.order ?? defaults.order, "order");
  const helpHref = safeOrderHref(hrefs?.help ?? defaults.help, "help");
  const items = Array.isArray(order.items) ? order.items : [];
  const shown = items.slice(0, MAX_THUMBNAILS);
  const more = items.length - shown.length;
  const placed = formatPlacedDate(order.createdAt);
  const status = getStatusPresentation(order.fulfillmentStatus);
  const reviewHref = firstProductHref(items, "#write-review");
  const buyAgainHref = firstProductHref(items);
  // Visible text stays "View order details" etc.; the hidden suffix keeps
  // names unique when several cards share a page (consistency bb).
  const suffix = orderActionSuffix(order.id);
  const context = suffix === "" ? null : <VisuallyHidden>{suffix}</VisuallyHidden>;

  return (
    <Card
      {...rest}
      as="article"
      padding="none"
      aria-labelledby={headingId}
      className={["overflow-hidden", className].filter(Boolean).join(" ")}
    >
      <header className="flex flex-col gap-3 border-b border-border-default bg-surface-sunken p-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
        <dl className="m-0 flex flex-wrap gap-x-6 gap-y-2 text-small">
          {placed !== null ? (
            <div className="flex flex-col">
              <dt className="text-text-secondary">Order placed</dt>
              <dd className="m-0">{placed}</dd>
            </div>
          ) : null}
          <div className="flex flex-col">
            <dt className="text-text-secondary">Total</dt>
            <dd className="m-0">
              <Price amountCents={order.totalCents} currency={order.currency} />
            </dd>
          </div>
          <div className="flex min-w-0 flex-col">
            <dt className="text-text-secondary">Ship to</dt>
            <dd className="m-0 break-words">{order.shipToName}</dd>
          </div>
        </dl>
        <Heading level={headingLevel} size="h4" id={headingId} className="min-w-0 break-all">
          {"Order # "}
          <span className="font-mono">{order.id}</span>
        </Heading>
      </header>

      <div className="flex flex-col gap-4 p-4 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <p className="m-0">
            <Badge tone={status.tone} icon={<Icon name={status.icon} size="sm" />}>
              {status.label}
            </Badge>
          </p>
          {shown.length > 0 ? (
            <ul role="list" className="m-0 flex list-none flex-wrap items-center gap-2 p-0">
              {shown.map((item, index) => (
                <li key={`${item.productId}-${index}`} className="shrink-0">
                  <Image
                    src={item.imageUrl}
                    alt={item.name}
                    width={64}
                    height={64}
                    sizes="64px"
                    rounded
                    className="size-16 object-cover"
                  />
                </li>
              ))}
              {more > 0 ? (
                <li className="text-small text-text-secondary">
                  {`+${more} more`}
                  <VisuallyHidden>{more === 1 ? " item" : " items"}</VisuallyHidden>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap md:flex-col md:items-stretch">
          {orderHref !== null ? (
            <Link variant="button" href={orderHref}>
              View order details
              {context}
            </Link>
          ) : null}
          {buyAgainAction !== undefined && items.length > 0 ? (
            // React ignores a plain form action's result; the cast only widens the
            // return type so actions that return a result object are accepted.
            // Wrapping would break server-action serialisation.
            <form action={buyAgainAction as FormAction} className="flex">
              <input type="hidden" name="orderId" value={order.id} />
              <Button type="submit" variant="secondary" fullWidth>
                Buy it again
                {context}
              </Button>
            </form>
          ) : buyAgainHref !== null ? (
            <Link href={buyAgainHref} variant="button" buttonVariant="secondary">
              Buy it again
              {context}
            </Link>
          ) : null}
          {reviewHref !== null ? (
            <Link href={reviewHref} className={secondaryLink}>
              Write a review
              {context}
            </Link>
          ) : null}
          {helpHref !== null ? (
            <Link href={helpHref} className={secondaryLink}>
              Get help
              {context}
            </Link>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
