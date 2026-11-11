import type { Metadata } from "next";

import {
  applyCoupon,
  moveToCart,
  removeCoupon,
  removeFromCart,
  saveForLater,
  selectShippingMethod,
  updateCartQuantity,
} from "@/app/actions/cart";
import { addToList, removeFromList } from "@/app/actions/lists";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Heading } from "@/components/atoms/Typography";
import { CartSummary } from "@/components/organisms/CartSummary";
import { CartTable } from "@/components/organisms/CartTable";
import { ProductRail } from "@/components/organisms/ProductRail";
import { buildMetadata } from "@/lib/seo/metadata";
import { readSessionId } from "@/server/session/session";

import {
  ALSO_BOUGHT_TITLE,
  BEST_SELLERS_TITLE,
  RECENTLY_VIEWED_TITLE,
  loadCartPageV2,
  type CartPageData,
} from "./_lib/load-cart-page";

export const metadata: Metadata = buildMetadata({
  title: "Your cart",
  description: "Review the items in your cart before checking out.",
  path: "/cart",
  noindex: true,
});

const PAGE_HEADING = "Shopping Cart";

function EmptyCartExtras({ data, now }: { data: CartPageData; now: Date }) {
  const savedCount = data.saved.items.length;
  const hasRail = data.bestSellers.length > 0;
  if (!hasRail && data.savedListHref === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-6">
      {data.savedListHref !== null && savedCount > 0 ? (
        <Link href={data.savedListHref} variant="button" buttonVariant="outline" className="self-start">
          {`View your saved items (${savedCount})`}
        </Link>
      ) : null}
      <ProductRail id="cart-best-sellers" title={BEST_SELLERS_TITLE} products={data.bestSellers} now={now} />
    </div>
  );
}

/**
 * Cart page v2 (T108). Thin: `loadCartPageV2` does all reads with one `now`.
 * The root layout already renders `<main>`. Server actions are passed
 * straight through so every form posts without JavaScript (SR2).
 * Phase 3 (T170): light-only; the lines, summary and empty state are Cards
 * (T161). The loader's `now` is the only clock: CartSummary gets the epoch
 * and every rail gets the same instant as a Date ("New" badges).
 */
export default async function CartPage() {
  const sessionId = await readSessionId();
  const data = loadCartPageV2(sessionId);
  const hasLines = data.table.items.length > 0;
  const now = new Date(data.now);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Cart" }]} />
      <Heading level={1}>{PAGE_HEADING}</Heading>

      {data.couponNotice !== null ? <Notice tone="warning">{data.couponNotice}</Notice> : null}
      {/* With lines, CartSummary shows the shipping notice next to the shipping picker. */}
      {!hasLines && data.shippingNotice !== null ? <Notice tone="info">{data.shippingNotice}</Notice> : null}

      <div className="flex min-w-0 flex-col gap-8 lg:flex-row lg:items-start">
        <CartTable
          className="flex-1"
          cart={data.table}
          updateQuantity={updateCartQuantity}
          removeItem={removeFromCart}
          saveForLaterAction={saveForLater}
          thumbnails
          hideSummary
          saved={{
            items: data.saved.items,
            listId: data.saved.listId,
            actions: { moveToCart, removeSaved: removeFromList, addToList },
          }}
          emptyState={hasLines ? undefined : <EmptyCartExtras data={data} now={now} />}
        />
        {hasLines ? (
          <CartSummary
            className="lg:w-80 lg:shrink-0"
            cart={data.summary}
            actions={{ applyCoupon, removeCoupon, setShippingMethod: selectShippingMethod }}
            now={data.now}
            arrivals={data.arrivals}
            shippingNotice={data.shippingNotice}
          />
        ) : null}
      </div>

      <ProductRail id="cart-also-bought" title={ALSO_BOUGHT_TITLE} products={data.alsoBought} now={now} />
      <ProductRail id="cart-recently-viewed" title={RECENTLY_VIEWED_TITLE} products={data.recentlyViewed} now={now} />
    </div>
  );
}
