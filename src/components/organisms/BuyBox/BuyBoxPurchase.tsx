"use client";

import { useCallback, useState } from "react";
import { AddToCartForm } from "@/components/molecules/AddToCartForm";
import type { CartActionFn, CartActionFnV2 } from "@/components/molecules/_contracts/cart-actions";
import { AddedToCartToast, type AddedToCartTrigger } from "@/components/organisms/ToastRegion";

export interface BuyBoxPurchaseProps {
  productId: string;
  /** Used as the toast description; rendered as text. */
  productName: string;
  stock: number;
  maxQuantity: number;
  addToCart: CartActionFn;
  buyNow: CartActionFnV2;
}

/**
 * Client island of the BuyBox: the cart form (Add to cart + Buy Now on one
 * form) and the success toast trigger. Server actions are passed straight
 * through so both buttons keep working without JavaScript.
 */
export function BuyBoxPurchase({ productId, productName, stock, maxQuantity, addToCart, buyNow }: BuyBoxPurchaseProps) {
  const [trigger, setTrigger] = useState<AddedToCartTrigger | null>(null);
  const handleSuccess = useCallback(() => {
    setTrigger((prev) => ({ count: (prev?.count ?? 0) + 1, description: productName }));
  }, [productName]);

  return (
    <>
      <AddToCartForm
        productId={productId}
        stock={stock}
        maxQuantity={maxQuantity}
        addToCart={addToCart}
        buyNowAction={buyNow}
        onSuccess={handleSuccess}
        variant="buybox"
      />
      <AddedToCartToast trigger={trigger} />
    </>
  );
}
