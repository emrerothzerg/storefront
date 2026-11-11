import type { CartLineItemData } from "@/components/molecules/CartLineItem";
import type { CartTableData } from "@/components/organisms/CartTable";
import { createCartService, type CartLineView, type CartService, type CartView } from "@/server/cart/cart-service";

/**
 * Server-only helpers for the `/cart` page (T23).
 *
 * Every field is copied explicitly (no spreads) so a server-only field on
 * `CartView` / `CartLineView` (e.g. `sessionId`) can never leak into the
 * client component props.
 */

function toLineItemData(line: CartLineView): CartLineItemData {
  return {
    productId: line.productId,
    name: line.name,
    slug: line.slug,
    imageUrl: line.imageUrl,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    lineTotalCents: line.lineTotalCents,
    availableStock: line.availableStock,
    status: line.status,
  };
}

export function toCartTableData(view: CartView): CartTableData {
  return {
    items: view.items.map(toLineItemData),
    subtotalCents: view.subtotalCents,
    currency: view.currency,
    itemCount: view.itemCount,
    canCheckout: view.canCheckout,
  };
}

/** Loads the cart for `sessionId` (null = no session = empty cart) as client-safe props. */
export function loadCartPage(sessionId: string | null, cart: CartService = createCartService()): CartTableData {
  return toCartTableData(cart.getCart(sessionId));
}
