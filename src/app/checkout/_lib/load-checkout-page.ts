import { computeArrivals } from "@/app/_lib/arrivals";
import {
  checkoutState,
  toOrderSummaryItems,
  type CartSummaryCart,
  type CheckoutBlockedReason,
} from "@/components/organisms/CartSummary/cart-summary-helpers";
import type { CheckoutFormV2Config } from "@/components/organisms/CheckoutForm";
import type { OrderSummaryLine } from "@/components/organisms/OrderSummary";
import type { SavedAddress } from "@/lib/types";
import { getAddressService, type AddressService } from "@/server/addresses/address-service";
import { getCartService, type CartServiceV2, type CartViewV2 } from "@/server/cart/cart-service";
import type { CurrentUser } from "@/server/session/current-user";
import { isSessionId } from "@/server/session/session-id";

/**
 * Server-only loader for the `/checkout` page v2 (T109). The page reads the
 * owner key with `readSessionId()` and the user with `readCurrentUser()`
 * (neither sets cookies, SR10) and hands both here. `now` is read ONCE per
 * call and used for the cart view and every arrival window.
 *
 * Nothing returned carries the owner key (R-1): every prop is copied field by
 * field. Without a well-formed owner key no service (and no database) is
 * touched; the address book is read only when the cart can be checked out.
 */

/** Everything the v2 form config needs except the server action (the page adds `placeOrderV2`). */
export type CheckoutFormConfigData = Omit<CheckoutFormV2Config, "action">;

export type CheckoutPageDataV2 =
  /** No cookie, or a cart without lines. */
  | { readonly kind: "empty"; readonly now: number }
  /** Lines exist but checkout is blocked (unavailable / reduced lines). */
  | {
      readonly kind: "blocked";
      readonly now: number;
      readonly reason: CheckoutBlockedReason;
      readonly message: string;
      readonly couponNotice: string | null;
      readonly shippingNotice: string | null;
    }
  | {
      readonly kind: "ready";
      readonly now: number;
      readonly form: CheckoutFormConfigData;
      /** One-time notices from the cart view (shown above the form). */
      readonly couponNotice: string | null;
      readonly shippingNotice: string | null;
    };

export type CheckoutCartReader = Pick<CartServiceV2, "getCartView">;
export type CheckoutAddressReader = Pick<AddressService, "list">;

export interface CheckoutPageInput {
  /** `readSessionId()` (the owner key) or null. Never minted here. */
  readonly ownerKey: string | null;
  /** `readCurrentUser()`; null for guests. */
  readonly user: CurrentUser | null;
}

export interface CheckoutPageDeps {
  /** Defaults to `getCartService()`. Called only with a well-formed owner key. */
  readonly getCart?: () => CheckoutCartReader;
  /** Defaults to `getAddressService()`. Called only when the cart can be checked out. */
  readonly getAddresses?: () => CheckoutAddressReader;
  /** Epoch ms; defaults to `Date.now()` (read once per call). */
  readonly now?: number;
}

/** Link target of every "back to cart" control on the page. */
export const CHECKOUT_CART_HREF = "/cart";

/** Heading of the blocked state (the detailed reason follows as text). */
export const CHECKOUT_BLOCKED_TITLE = "Some items are unavailable";
export const CHECKOUT_EMPTY_TITLE = "Your cart is empty";

function resolveNow(now: number | undefined): number {
  return typeof now === "number" && Number.isFinite(now) ? now : Date.now();
}

function nonBlank(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The CartSummary-shaped slice `checkoutState` / `toOrderSummaryItems` read; no owner key. */
export function toSummaryCart(view: CartViewV2): CartSummaryCart {
  return {
    items: view.items.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      status: line.status,
      availableStock: line.availableStock,
    })),
    itemCount: view.itemCount,
    canCheckout: view.canCheckout,
    currency: view.currency,
    saved: [],
    coupon: view.coupon,
    couponNotice: null,
    shipping: view.shipping,
    shippingOptions: view.shippingOptions,
    totals: view.totals,
  };
}

/**
 * Review-block lines: names from the view, BILLABLE quantities from
 * `toOrderSummaryItems` (T92) so OrderSummary's recomputation equals the
 * server total (`data-total-check="match"`).
 */
export function toCheckoutSummaryItems(view: CartViewV2): OrderSummaryLine[] {
  const billable = toOrderSummaryItems(toSummaryCart(view));
  return view.items.map((line, index) => ({
    productId: line.productId,
    name: line.name,
    quantity: billable[index]?.quantity ?? 0,
    unitPriceCents: line.unitPriceCents,
  }));
}

/** Same helper as the cart page (CONS-B4 aq: `src/app/_lib/arrivals.ts`); the old name stays exported. */
export const computeCheckoutArrivals = computeArrivals;

/** The owner's address book; a storage failure degrades to "new address only" instead of breaking checkout. */
function readAddressBook(reader: CheckoutAddressReader, ownerKey: string): readonly SavedAddress[] {
  try {
    const list = reader.list(ownerKey);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Builds the v2 form config (minus the action) from a checkout-able cart view. */
export function toCheckoutFormConfig(
  view: CartViewV2,
  savedAddresses: readonly SavedAddress[],
  user: CurrentUser | null,
  now: number,
): CheckoutFormConfigData {
  const { totals } = view;
  const quote = view.shipping;
  return {
    savedAddresses,
    shipping: {
      options: view.shippingOptions,
      selectedId: quote?.method.id ?? null,
      arrivals: computeArrivals(view.shippingOptions, now),
      currency: view.currency,
      now,
    },
    summary: {
      items: toCheckoutSummaryItems(view),
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      shippingCents: totals.shippingCents,
      totalCents: totals.totalCents,
    },
    coupon:
      view.coupon === null
        ? null
        : {
            code: view.coupon.code,
            description: view.coupon.description,
            freeShipping: view.coupon.kind === "free_shipping",
          },
    freeShipping:
      quote === null
        ? null
        : {
            subtotalCents: totals.subtotalCents,
            thresholdCents: quote.method.freeOverCents,
            amountToFreeCents: totals.amountToFreeShippingCents,
            currency: view.currency,
          },
    isSignedIn: user !== null,
    email: user?.email ?? null,
    cartHref: CHECKOUT_CART_HREF,
  };
}

const defaults = {
  getCart: (): CheckoutCartReader => getCartService(),
  getAddresses: (): CheckoutAddressReader => getAddressService(),
};

/**
 * Loads the checkout page. `ownerKey` null (or not a UUID) or a cart with no
 * lines -> `empty` (no service touched for a missing key). Lines that block
 * checkout (the UI's strict rule: any line not "ok", or `!canCheckout`) ->
 * `blocked`. Otherwise `ready` with the full v2 form config: all totals are
 * the server's (`getCartView().totals`). Throws when the cart view itself
 * cannot be computed (the route's error boundary handles it).
 */
export function loadCheckoutPageV2(input: CheckoutPageInput, deps: CheckoutPageDeps = {}): CheckoutPageDataV2 {
  const now = resolveNow(deps.now);
  const { ownerKey, user } = input;
  if (ownerKey === null || !isSessionId(ownerKey)) return { kind: "empty", now };

  const result = (deps.getCart ?? defaults.getCart)().getCartView(ownerKey, now);
  if (!result.ok) throw new Error(`Cart could not be loaded: ${result.error.code}`);
  const view = result.value;
  if (view.items.length === 0) return { kind: "empty", now };

  const couponNotice = nonBlank(view.couponNotice);
  const shippingNotice = nonBlank(view.shippingNotice);
  const state = checkoutState(toSummaryCart(view));
  if (!state.canCheckout) {
    return { kind: "blocked", now, reason: state.reason, message: state.text, couponNotice, shippingNotice };
  }

  const savedAddresses = readAddressBook((deps.getAddresses ?? defaults.getAddresses)(), ownerKey);
  return {
    kind: "ready",
    now,
    form: toCheckoutFormConfig(view, savedAddresses, user, now),
    couponNotice,
    shippingNotice,
  };
}
