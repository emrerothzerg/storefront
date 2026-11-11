import { SiteHeader } from "@/components/organisms/SiteHeader";
import type { HeaderAccount, HeaderNavLink } from "@/components/organisms/SiteHeader";
import { DEPARTMENT_NAV } from "@/content/navigation";
import { SITE_NAME } from "@/lib/seo/site";
import { DEFAULT_CART_CURRENCY, getCartService } from "@/server/cart/cart-service";
import { getListingService } from "@/server/catalog/listing-service";
import { getCouponService } from "@/server/pricing/coupon-service";
import { getShippingService } from "@/server/pricing/shipping-service";
import { readCurrentUser } from "@/server/session/current-user";
import { readSessionId } from "@/server/session/session";

import { headerSignOut } from "./header-actions";
import { buildHeaderBenefits } from "./header-benefits";
import { loadHeaderData, type HeaderDataDeps } from "./header-data";

/**
 * Row-1 links between the account block and the cart (T148: Lists only, as
 * in the reference; orders are in the account menu, the drawer and the
 * benefits strip).
 */
export const HEADER_UTILITY_LINKS: readonly HeaderNavLink[] = [{ label: "Lists", href: "/lists", icon: "heart" }];

/** First link in the CategoryNav row (T148 ruling: Deals stays in the desktop header). */
export const HEADER_CATEGORY_LEADING = { label: "Deals", href: "/deals" } as const;

const productionDeps: HeaderDataDeps = {
  readSessionId,
  readCurrentUser,
  getCartTotals: (sessionId) => getCartService().getTotals(sessionId),
  categoryTree: () => getListingService().categoryTree(),
  listPromoted: () => getCouponService().listPromoted(),
  listShippingMethods: () => getShippingService().listMethods(0).map((quote) => quote.method),
};

/**
 * Root-layout header (T80, v3 T148). Async Server Component rendered directly
 * by `layout.tsx`: no Suspense, no `loading.tsx`, no `"use cache"`. It reads
 * cookies, so every route is dynamically rendered per request and the HTML
 * carries the real count, account state and HTTP status.
 *
 * Rows: wordmark + pill search + account/Lists/cart (+ "All" drawer below
 * md); CategoryNav (Deals first, then `DEPARTMENT_NAV`); benefits strip built from
 * `src/content/header-benefits.ts`, the shipping-method threshold and the
 * first promoted coupon.
 *
 * `currentPath` is not passed: layouts do not re-render on navigation, so no
 * header link (and no CategoryNav department) gets `aria-current`.
 */
export async function HeaderShell() {
  const data = await loadHeaderData(productionDeps);
  const account: HeaderAccount =
    data.user === null
      ? { status: "guest" }
      : {
          status: "signed-in",
          displayName: data.user.displayName,
          // Server Action wrapping `signOut` from src/app/actions/auth.ts (loaded at submit time).
          signOutAction: headerSignOut,
        };
  const benefits = buildHeaderBenefits({
    freeShippingThresholdCents: data.freeShippingThresholdCents,
    currency: DEFAULT_CART_CURRENCY,
    coupon: data.promoCoupon,
  });

  return (
    <SiteHeader
      cartCount={data.cartCount}
      storeName={SITE_NAME}
      departments={data.departments}
      popularSearches={data.popularSearches}
      account={account}
      utilityLinks={HEADER_UTILITY_LINKS}
      categoryNav={DEPARTMENT_NAV}
      categoryNavLeading={HEADER_CATEGORY_LEADING}
      benefits={benefits}
    />
  );
}
