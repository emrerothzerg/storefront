import type { Metadata } from "next";
import type { ReactNode } from "react";

import { placeOrderV2 } from "@/app/actions/checkout-v2";
import { Breadcrumb } from "@/components/atoms/Breadcrumb";
import { Card } from "@/components/atoms/Card";
import { Link } from "@/components/atoms/Link";
import { Notice } from "@/components/atoms/Notice";
import { Heading } from "@/components/atoms/Typography";
import { CheckoutForm } from "@/components/organisms/CheckoutForm";
import { buildMetadata } from "@/lib/seo/metadata";
import { readCurrentUser } from "@/server/session/current-user";
import { readSessionId } from "@/server/session/session";

import {
  CHECKOUT_BLOCKED_TITLE,
  CHECKOUT_CART_HREF,
  CHECKOUT_EMPTY_TITLE,
  loadCheckoutPageV2,
} from "./_lib/load-checkout-page";

export const metadata: Metadata = buildMetadata({
  title: "Checkout",
  description: "Enter your shipping address and payment details to place your order.",
  path: "/checkout",
  noindex: true,
});

const BREADCRUMB = [
  { label: "Home", href: "/" },
  { label: "Cart", href: CHECKOUT_CART_HREF },
  { label: "Checkout" },
];

function CartNotices({ coupon, shipping }: { coupon: string | null; shipping: string | null }) {
  return (
    <>
      {coupon !== null ? <Notice tone="warning">{coupon}</Notice> : null}
      {shipping !== null ? <Notice tone="info">{shipping}</Notice> : null}
    </>
  );
}

/**
 * Empty/blocked state (T170): the notice keeps its role and title; the way
 * back to `/cart` is a primary pill under it, both on a light-grey card.
 */
function CartStateCard({ linkText, children }: { linkText: string; children: ReactNode }) {
  return (
    <Card tone="sunken" padding="lg" className="flex flex-col gap-4">
      {children}
      <Link href={CHECKOUT_CART_HREF} variant="button" className="self-start">
        {linkText}
      </Link>
    </Card>
  );
}

/**
 * Checkout page v2 (T109). Thin: `loadCheckoutPageV2` does every read with
 * one `now`. Cookies are only read (`readSessionId`, `readCurrentUser`),
 * never set (SR10). An empty or blocked cart renders a short state with a
 * link to `/cart` (200, no redirect). The idempotency key is fresh on every
 * render, including the re-render after a no-JS post. The root layout
 * already renders `<main>`. Phase 3 (T170): light-only; the form steps are
 * Cards (T161), the empty/blocked states sit on a sunken Card.
 */
export default async function CheckoutPage() {
  const [ownerKey, user] = await Promise.all([readSessionId(), readCurrentUser()]);
  const data = loadCheckoutPageV2({ ownerKey, user });

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Breadcrumb items={BREADCRUMB} />
      <Heading level={1}>Checkout</Heading>

      {data.kind === "empty" ? (
        <CartStateCard linkText="Go to your cart">
          <Notice tone="info" title={CHECKOUT_EMPTY_TITLE} />
        </CartStateCard>
      ) : null}

      {data.kind === "blocked" ? (
        <>
          <CartNotices coupon={data.couponNotice} shipping={data.shippingNotice} />
          <CartStateCard linkText="Review your cart">
            <Notice tone="warning" title={CHECKOUT_BLOCKED_TITLE}>
              {data.message}
            </Notice>
          </CartStateCard>
        </>
      ) : null}

      {data.kind === "ready" ? (
        <>
          <CartNotices coupon={data.couponNotice} shipping={data.shippingNotice} />
          <CheckoutForm initialIdempotencyKey={crypto.randomUUID()} v2={{ ...data.form, action: placeOrderV2 }} />
        </>
      ) : null}
    </div>
  );
}
