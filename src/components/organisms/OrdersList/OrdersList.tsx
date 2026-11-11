import { useId } from "react";
import { Button } from "@/components/atoms/Button";
import { Card } from "@/components/atoms/Card";
import { FormField } from "@/components/atoms/FormField";
import { Image } from "@/components/atoms/Image";
import { Input } from "@/components/atoms/Input";
import { Link } from "@/components/atoms/Link";
import { Pagination } from "@/components/atoms/Pagination";
import { Price } from "@/components/atoms/Price";
import { Select } from "@/components/atoms/Select";
import { Heading, Text } from "@/components/atoms/Typography";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { CART_FIELD } from "@/components/molecules/_contracts/cart-actions";
import { OrderCard, productHref } from "@/components/molecules/OrderCard";
import { isValidCents } from "@/lib/money";
import {
  DEFAULT_ORDERS_BASE_PATH,
  MAX_ORDER_QUERY_LENGTH,
  ORDER_RANGES,
  ORDER_RANGE_LABELS,
  ORDER_TABS,
  buildOrdersHref,
  dedupeBuyAgainProducts,
  normaliseBasePath,
  ordersEmptyState,
  parseOrderQuery,
  parseOrderRange,
  parseOrderTab,
  toOrderCardData,
  type BuyAgainProduct,
  type OrderTab,
  type OrdersListOrder,
} from "./orders-list-model";

type FormActionProp = (formData: FormData) => void | Promise<unknown>;
type FormAction = (formData: FormData) => void | Promise<void>;

export interface OrdersListActions {
  /** Posted by each OrderCard's "Buy it again" (hidden `orderId`); pass `buyAgainFromForm`. */
  buyAgain: FormActionProp;
  /** Posted by the Buy Again grid (`productId`, `quantity=1`, cart contract names). */
  addToCart: FormActionProp;
}

export interface OrdersListProps {
  /** One page of `listOrders(...).items` (OrderView fits). Ignored on the Buy Again tab. */
  orders: readonly OrdersListOrder[];
  /** Raw value is re-parsed; garbage -> "orders". */
  tab: OrderTab | string;
  /** One of `ORDER_RANGES`; garbage -> "3m". */
  range: string;
  /** Search text (re-parsed: trimmed, at most 100 characters). */
  query: string;
  page: number;
  pageCount: number;
  /** Defaults to "/orders"; query/fragment stripped, disallowed paths fall back to "/orders". */
  basePath?: string;
  /** Buy Again tab only; deduplicated by `productId`. */
  buyAgainProducts: readonly BuyAgainProduct[];
  actions: OrdersListActions;
  /** Level of the "Your orders" heading. Defaults to 1. */
  headingLevel?: 1 | 2;
  className?: string;
}

const RANGE_OPTIONS = ORDER_RANGES.map((value) => ({ value, label: ORDER_RANGE_LABELS[value] }));

/**
 * Order history body (T94). Server-safe: tabs are links, the range + search
 * filter is a GET form, every mutation is a plain `<form action>` (SR2).
 * User text (names, ship-to, query) renders as React text only.
 */
export function OrdersList({
  orders,
  tab: rawTab,
  range: rawRange,
  query: rawQuery,
  page,
  pageCount,
  basePath: rawBasePath = DEFAULT_ORDERS_BASE_PATH,
  buyAgainProducts,
  actions,
  headingLevel = 1,
  className,
}: OrdersListProps) {
  const uid = useId();
  const headingId = `orders-list-${uid}-heading`;
  const rangeId = `orders-list-${uid}-range`;
  const queryId = `orders-list-${uid}-q`;
  const tab = parseOrderTab(rawTab);
  const range = parseOrderRange(rawRange);
  const query = parseOrderQuery(rawQuery);
  const basePath = normaliseBasePath(rawBasePath);
  const subLevel: 2 | 3 = headingLevel === 1 ? 2 : 3;
  const isBuyAgain = tab === "buy-again";
  const safeOrders = Array.isArray(orders) ? orders : [];
  const products = isBuyAgain ? dedupeBuyAgainProducts(buyAgainProducts) : [];
  const isEmpty = isBuyAgain ? products.length === 0 : safeOrders.length === 0;
  const empty = isEmpty ? ordersEmptyState(tab, { basePath, range, query }) : null;

  return (
    <section
      aria-labelledby={headingId}
      className={["flex min-w-0 flex-col gap-6", className].filter(Boolean).join(" ")}
    >
      <Heading level={headingLevel} id={headingId}>
        Your orders
      </Heading>

      <nav aria-label="Order views" className="min-w-0 border-b border-border-default">
        <ul role="list" className="m-0 flex list-none flex-wrap gap-x-4 p-0">
          {ORDER_TABS.map((entry) => (
            <li key={entry.value}>
              <Link
                variant="nav"
                href={buildOrdersHref(basePath, { tab: entry.value, range })}
                isCurrent={entry.value === tab}
              >
                {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {!isBuyAgain ? (
        <form
          method="get"
          action={basePath}
          role="search"
          aria-label="Search orders"
          className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
        >
          <input type="hidden" name="tab" value={tab} />
          <FormField id={rangeId} label="Orders placed in" className="sm:w-48">
            {(control) => <Select {...control} name="range" options={RANGE_OPTIONS} defaultValue={range} />}
          </FormField>
          <FormField id={queryId} label="Search all orders" className="min-w-0 sm:flex-1">
            {(control) => (
              <Input
                {...control}
                type="search"
                name="q"
                maxLength={MAX_ORDER_QUERY_LENGTH}
                defaultValue={query}
                placeholder="Product name"
                autoComplete="off"
              />
            )}
          </FormField>
          <Button type="submit" variant="secondary">
            Search orders
          </Button>
        </form>
      ) : null}

      {empty !== null ? (
        <Card tone="sunken" padding="lg" data-slot="orders-empty" className="flex flex-col gap-3">
          <Heading level={subLevel} size="h4">
            {empty.title}
          </Heading>
          <Text>{empty.body}</Text>
          {empty.links.length > 0 ? (
            <ul role="list" className="m-0 flex list-none flex-wrap gap-x-6 gap-y-2 p-0">
              {empty.links.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} className="inline-flex min-h-touch items-center">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : isBuyAgain ? (
        <BuyAgainGrid products={products} addToCart={actions.addToCart} />
      ) : (
        <>
          <ul role="list" className="m-0 flex list-none flex-col gap-4 p-0">
            {safeOrders.map((order) => (
              <li key={order.id}>
                <OrderCard
                  order={toOrderCardData(order)}
                  buyAgainAction={actions.buyAgain}
                  headingLevel={subLevel}
                />
              </li>
            ))}
          </ul>
          <Pagination
            page={page}
            pageCount={pageCount}
            label="Order pages"
            hrefFor={(target) => buildOrdersHref(basePath, { tab, range, q: query, page: target })}
          />
        </>
      )}
    </section>
  );
}

function BuyAgainGrid({
  products,
  addToCart,
}: {
  products: readonly BuyAgainProduct[];
  addToCart: FormActionProp;
}) {
  return (
    <>
      <ul role="list" aria-label="Products to buy again" className="m-0 grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
        {products.map((product) => {
          const href = productHref(product.slug);
          const price = isValidCents(product.priceCents) ? product.priceCents : null;
          return (
            <Card as="li" key={product.productId} interactive className="flex flex-col gap-3">
              <Image
                src={product.imageUrl}
                alt=""
                width={160}
                height={160}
                sizes="160px"
                rounded
                className="size-40 self-center object-cover"
              />
              <p className="m-0 min-w-0 break-words font-semibold">
                {href !== null ? <Link href={href}>{product.name}</Link> : product.name}
              </p>
              {price !== null ? <Price amountCents={price} currency={product.currency} display="superscript" /> : null}
              {product.inStock === true ? (
                // React ignores a plain form action's result; the cast only widens the return type.
                <form action={addToCart as FormAction} className="mt-auto flex">
                  <input type="hidden" name={CART_FIELD.productId} value={product.productId} />
                  <input type="hidden" name={CART_FIELD.quantity} value="1" />
                  <Button type="submit" fullWidth>
                    Add to cart
                    <VisuallyHidden>{`: ${product.name}`}</VisuallyHidden>
                  </Button>
                </form>
              ) : (
                <Text className="mt-auto" tone="secondary">
                  Out of stock
                </Text>
              )}
            </Card>
          );
        })}
      </ul>
    </>
  );
}
