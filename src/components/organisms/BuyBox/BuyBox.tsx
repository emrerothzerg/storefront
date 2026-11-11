import { Card } from "@/components/atoms/Card";
import { Icon, type IconName } from "@/components/atoms/Icon";
import { VisuallyHidden } from "@/components/atoms/VisuallyHidden";
import { CompareToggle } from "@/components/molecules/CompareToggle";
import { DeliveryEstimate } from "@/components/molecules/DeliveryEstimate";
import { PriceBlock } from "@/components/molecules/PriceBlock";
import { ShareLink } from "@/components/molecules/ShareLink";
import { SavingBadge } from "@/components/molecules/StockBadge";
import { StockAlertForm } from "@/components/molecules/StockAlertForm";
import { StockUrgency } from "@/components/molecules/StockUrgency";
import { WishlistButton } from "@/components/molecules/WishlistButton";
import {
  normalizeStock,
  type CartActionFn,
  type CartActionFnV2,
} from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import type { StockAlertActionFn } from "@/components/molecules/_contracts/stock-alert-actions";
import { SITE_NAME } from "@/lib/seo/site";
import type { Product } from "@/lib/types";
import { BuyBoxPurchase } from "./BuyBoxPurchase";

/** The product fields the BuyBox reads (`ProductDetail` and `Product` both fit). */
export type BuyBoxProduct = Pick<Product, "id" | "slug" | "name" | "priceCents" | "currency" | "stock"> & {
  readonly listPriceCents?: number | null;
  readonly brandName?: string;
};

export interface BuyBoxActions {
  addToCart: CartActionFn;
  buyNow: CartActionFnV2;
  addToList: ListActionFn;
  removeFromList: ListActionFn;
  subscribeStockAlert: StockAlertActionFn;
  unsubscribeStockAlert?: StockAlertActionFn;
}

export interface BuyBoxViewer {
  /** Server truth: the product is in the default wish list (or `wishlistId`). */
  inWishlist: boolean;
  /** List holding the product; needed to remove it. */
  wishlistId?: string | null;
  lists?: readonly { readonly id: string; readonly name: string }[];
  /** Server truth: the viewer already watches this product for restock. */
  alertRegistered: boolean;
  alertId?: string | null;
}

export interface BuyBoxDelivery {
  estimate: { readonly start: string; readonly end: string } | null;
  methodName?: string;
  isFree?: boolean;
  freeShippingNote?: string | null;
}

export interface BuyBoxProps {
  product: BuyBoxProduct;
  actions: BuyBoxActions;
  viewer: BuyBoxViewer;
  delivery: BuyBoxDelivery;
  promotedCoupon?: { readonly code: string; readonly description: string } | null;
  /** Share menu renders only when a non-empty URL/path is given. */
  shareUrl?: string | null;
  /** Compare checkbox renders only when given. */
  compare?: { readonly selected: readonly string[]; readonly basePath?: string } | null;
  /** Level of the visually hidden "Buying options" heading. Default 2. */
  headingLevel?: 2 | 3;
  /** Seller named in the trust lines. Default `SITE_NAME`. */
  sellerName?: string;
  /**
   * Sticky panel from 1024px (`lg:`) only; below that it scrolls with the page.
   * Default false. Enable only in a two-column layout whose column is taller
   * than the box (the box is never clipped or scrolled internally).
   */
  sticky?: boolean;
  className?: string;
}

/** Per-order cap on top of stock (T78 criterion 3). */
export const BUY_BOX_MAX_QUANTITY = 10;

const TRUST_LINES: readonly { readonly icon: IconName; readonly text: (seller: string) => string }[] = [
  { icon: "lock", text: () => "Secure transaction" },
  { icon: "refresh", text: () => "Free returns within 30 days (sample policy)" },
  { icon: "truck", text: (seller) => `Ships from ${seller}` },
];

function headingIdFor(slug: string): string {
  const safe = slug.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 100);
  return `buy-box-${safe}-heading`;
}

/**
 * PDP purchase panel (Phase 3 v3: white `Card` tile). Server-safe; interactive
 * parts are the client molecules. Order: superscript price with struck
 * "Was …" + `SavingBadge` ("Save $X (Y%)") + coupon line -> stock pill ->
 * delivery estimate -> in stock: one cart form (quantity, "Add to cart",
 * "Buy Now" via formAction) / out of stock: the restock alert form instead ->
 * full-width wish list pill -> compare + share row -> trust lines.
 */
export function BuyBox({
  product,
  actions,
  viewer,
  delivery,
  promotedCoupon = null,
  shareUrl = null,
  compare = null,
  headingLevel = 2,
  sellerName = SITE_NAME,
  sticky = false,
  className,
}: BuyBoxProps) {
  const stock = normalizeStock(product.stock);
  const inStock = stock > 0;
  const headingId = headingIdFor(product.slug);
  const share = typeof shareUrl === "string" && shareUrl.trim() !== "" ? shareUrl : null;
  const couponCode = promotedCoupon?.code.trim() ?? "";
  const couponText = promotedCoupon?.description.trim() ?? "";
  const classes = [
    "flex flex-col gap-4",
    // Focused controls keep a margin when scrolled into view (P-14).
    "**:scroll-mt-4 **:scroll-mb-4",
    sticky ? "lg:sticky lg:top-4 lg:self-start" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Card as="section" aria-labelledby={headingId} className={classes} data-sticky={sticky ? "" : undefined}>
      <VisuallyHidden as={headingLevel === 3 ? "h3" : "h2"} id={headingId}>
        Buying options
      </VisuallyHidden>
      <div className="flex min-w-0 flex-col items-start gap-2" data-slot="buy-box-price">
        <PriceBlock
          priceCents={product.priceCents}
          currency={product.currency}
          listPriceCents={product.listPriceCents ?? null}
          size="lg"
          display="superscript"
          layout="inline"
          showPercentOff={false}
        />
        <SavingBadge
          priceCents={product.priceCents}
          listPriceCents={product.listPriceCents ?? null}
          currency={product.currency}
        />
        {couponCode !== "" && couponText !== "" ? (
          <p className="flex w-full min-w-0 items-start gap-1 text-small text-text-primary" data-slot="buy-box-coupon">
            <Icon name="tag" size="sm" className="mt-0.5 shrink-0 text-success" />
            <span className="min-w-0 flex-1 break-words">
              Save with code <span className="font-mono font-semibold">{couponCode}</span>: {couponText}
            </span>
          </p>
        ) : null}
      </div>
      <StockUrgency stock={stock} />
      <DeliveryEstimate
        estimate={delivery.estimate}
        inStock={inStock}
        methodName={delivery.methodName}
        isFree={delivery.isFree}
        freeShippingNote={delivery.freeShippingNote ?? null}
      />
      {inStock ? (
        <BuyBoxPurchase
          productId={product.id}
          productName={product.name}
          stock={stock}
          maxQuantity={BUY_BOX_MAX_QUANTITY}
          addToCart={actions.addToCart}
          buyNow={actions.buyNow}
        />
      ) : (
        <StockAlertForm
          action={actions.subscribeStockAlert}
          unsubscribeAction={actions.unsubscribeStockAlert}
          productId={product.id}
          productSlug={product.slug}
          registered={viewer.alertRegistered}
          alertId={viewer.alertId ?? null}
        />
      )}
      <WishlistButton
        productId={product.id}
        productSlug={product.slug}
        productName={product.name}
        inList={viewer.inWishlist}
        listId={viewer.wishlistId ?? null}
        lists={viewer.lists}
        addAction={actions.addToList}
        removeAction={actions.removeFromList}
        variant="button"
        fullWidth
      />
      {compare || share !== null ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-slot="buy-box-secondary">
          {compare ? (
            <CompareToggle
              productSlug={product.slug}
              productName={product.name}
              selected={compare.selected}
              basePath={compare.basePath}
            />
          ) : null}
          {share !== null ? <ShareLink url={share} title={product.name} size="sm" /> : null}
        </div>
      ) : null}
      <ul className="flex flex-col gap-2 border-t border-border-default pt-4 text-small text-text-secondary">
        {TRUST_LINES.map((line) => (
          <li key={line.icon} className="flex items-start gap-2">
            <Icon name={line.icon} size="sm" className="mt-0.5" />
            <span className="min-w-0 break-words">{line.text(sellerName)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
