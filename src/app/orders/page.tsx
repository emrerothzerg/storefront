import type { Metadata } from "next";

import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { OrdersList } from "@/components/organisms/OrdersList";
import { buyAgainFromForm } from "@/app/actions/orders";
import { addToCart } from "@/app/actions/cart";
import { buildMetadata } from "@/lib/seo/metadata";
import { readSessionId } from "@/server/session/session";

import { loadOrdersPage } from "./_lib/load-orders";
import { ORDERS_DESCRIPTION, ORDERS_PATH, ORDERS_TITLE, ordersBreadcrumb } from "./_lib/page-parts";
import type { SearchParamsRecord } from "./_lib/params";

export interface OrdersPageProps {
  readonly searchParams: Promise<SearchParamsRecord>;
}

/** Order history is per owner: never indexed. */
export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({ title: ORDERS_TITLE, description: ORDERS_DESCRIPTION, path: ORDERS_PATH, noindex: true });
}

/** Single-argument add-to-cart for the Buy Again grid (R-T110-1). */
const addToCartFromGrid = addToCart.bind(null, null);

/**
 * `/orders` (T110). Read-only render: the owner key comes from
 * `readSessionId()` (never minted here, SR10). No cookie / unknown owner ->
 * the OrdersList empty state with status 200 (never 404).
 */
export default async function OrdersPage({ searchParams }: OrdersPageProps) {
  const ownerKey = await readSessionId();
  const data = loadOrdersPage({ ownerKey, searchParams: await searchParams });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={ordersBreadcrumb()} />
      <OrdersList
        orders={data.orders}
        tab={data.tab}
        range={data.range}
        query={data.query}
        page={data.page}
        pageCount={data.pageCount}
        basePath={ORDERS_PATH}
        buyAgainProducts={data.buyAgainProducts}
        actions={{ buyAgain: buyAgainFromForm, addToCart: addToCartFromGrid }}
        headingLevel={1}
      />
    </div>
  );
}
