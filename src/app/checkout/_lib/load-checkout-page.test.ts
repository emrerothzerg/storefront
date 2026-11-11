import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { computeOrderSummaryTotal } from "@/components/organisms/OrderSummary/order-summary-helpers";
import { createAddressService, AddressStorageError, type AddressService } from "@/server/addresses/address-service";
import { createCartService, type CartServiceV2 } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { estimateDelivery } from "@/server/pricing/shipping-service";
import type { CurrentUser } from "@/server/session/current-user";

import {
  CHECKOUT_CART_HREF,
  computeCheckoutArrivals,
  loadCheckoutPageV2,
  type CheckoutAddressReader,
  type CheckoutCartReader,
  type CheckoutPageDataV2,
} from "./load-checkout-page";

const TOTE = "prod_canvas-tote-bag"; // 1999 cents, stock 42
const DESK = "prod_walnut-desk"; // 125000 cents, stock 3
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-04T10:00:00.000Z"); // a Wednesday
const USER: CurrentUser = { id: "user_1", email: "ada@example.com", displayName: "Ada" };

const ADDRESS = {
  fullName: "Grace Hopper",
  line1: "7 Compiler Road",
  line2: "Suite 9",
  city: "Arlington",
  region: "VA",
  postalCode: "22201",
  country: "US",
  email: undefined,
  label: "Work",
  phone: "+1 555 0100",
} as const;

let db: Database;
let cart: CartServiceV2;
let addresses: AddressService;

beforeEach(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  cart = createCartService(db, { now: () => NOW });
  addresses = createAddressService({ db, now: () => NOW });
});

function deps(overrides: { getCart?: () => CheckoutCartReader; getAddresses?: () => CheckoutAddressReader } = {}) {
  return {
    getCart: overrides.getCart ?? ((): CheckoutCartReader => cart),
    getAddresses: overrides.getAddresses ?? ((): CheckoutAddressReader => addresses),
    now: NOW,
  };
}

const forbidden = (what: string) => (): never => {
  throw new Error(`${what} must not be called`);
};

function ready(data: CheckoutPageDataV2): Extract<CheckoutPageDataV2, { kind: "ready" }> {
  if (data.kind !== "ready") throw new Error(`expected ready, got ${data.kind}`);
  return data;
}

function save(owner: string, overrides: Partial<Record<keyof typeof ADDRESS, string>> = {}): string {
  const r = addresses.create(owner, { ...ADDRESS, ...overrides });
  if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r.error)}`);
  return r.value.id;
}

describe("loadCheckoutPageV2: empty", () => {
  test("no cookie: empty without touching any service", () => {
    const data = loadCheckoutPageV2(
      { ownerKey: null, user: null },
      { getCart: forbidden("getCart"), getAddresses: forbidden("getAddresses"), now: NOW },
    );
    expect(data).toEqual({ kind: "empty", now: NOW });
  });

  test("a malformed owner key reads as no cookie", () => {
    const data = loadCheckoutPageV2(
      { ownerKey: "not-a-uuid", user: null },
      { getCart: forbidden("getCart"), getAddresses: forbidden("getAddresses"), now: NOW },
    );
    expect(data.kind).toBe("empty");
  });

  test("a cart without lines is empty and the address book is never read (no address data)", () => {
    save(OWNER);
    const data = loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps({ getAddresses: forbidden("getAddresses") }));
    expect(data).toEqual({ kind: "empty", now: NOW });
    expect(JSON.stringify(data)).not.toContain("Grace");
  });

  test("now defaults to a finite clock reading", () => {
    const data = loadCheckoutPageV2({ ownerKey: null, user: null });
    expect(Number.isFinite(data.now)).toBe(true);
  });
});

describe("loadCheckoutPageV2: blocked", () => {
  test("an unavailable line blocks checkout; addresses are not read", () => {
    cart.addItem(OWNER, TOTE, 1);
    cart.addItem(OWNER, DESK, 1);
    db.run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    const data = loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps({ getAddresses: forbidden("getAddresses") }));
    expect(data.kind).toBe("blocked");
    if (data.kind !== "blocked") return;
    expect(data.reason).toBe("someUnavailable");
    expect(data.message).toContain("out of stock");
  });

  test("a reduced line (quantity above stock) blocks checkout (UI strict rule)", () => {
    cart.addItem(OWNER, DESK, 3);
    db.run("UPDATE products SET stock = 1 WHERE id = ?", [DESK]);
    const data = loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps({ getAddresses: forbidden("getAddresses") }));
    expect(data.kind).toBe("blocked");
    if (data.kind === "blocked") expect(data.reason).toBe("reduced");
  });

  test("a line exactly at stock is ready", () => {
    cart.addItem(OWNER, DESK, 3);
    db.run("UPDATE products SET stock = 3 WHERE id = ?", [DESK]);
    expect(loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps()).kind).toBe("ready");
  });
});

describe("loadCheckoutPageV2: ready", () => {
  test("cart with a coupon + two owners' address books: own addresses only, server totals, full config", () => {
    expect(cart.addItem(OWNER, TOTE, 2).ok).toBe(true); // 3998
    expect(cart.applyCoupon(OWNER, "WELCOME10", NOW).ok).toBe(true);
    const own = save(OWNER, { label: "Home" });
    save(OTHER, { fullName: "Mallory Other", line1: "1 Foreign Way" });

    const data = ready(loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps()));
    const view = cart.getCartView(OWNER, NOW);
    if (!view.ok) throw new Error("view");
    const { form } = data;

    expect(form.savedAddresses.map((a) => a.id)).toEqual([own]);
    expect(JSON.stringify(data)).not.toContain("Mallory");
    expect(form.summary).toEqual({
      items: [{ productId: TOTE, name: "Canvas Tote Bag", quantity: 2, unitPriceCents: 1999 }],
      subtotalCents: view.value.totals.subtotalCents,
      discountCents: view.value.totals.discountCents,
      shippingCents: view.value.totals.shippingCents,
      totalCents: view.value.totals.totalCents,
    });
    expect(form.summary.discountCents).toBe(399); // 10% of 3998, rounded down by the pricing service
    expect(form.summary.shippingCents).toBe(0); // standard is free over 3500 on the subtotal
    expect(form.summary.totalCents).toBe(3998 - 399);
    const recomputed = computeOrderSummaryTotal({
      items: form.summary.items,
      shippingCents: form.summary.shippingCents,
      discountCents: form.summary.discountCents,
    });
    expect(recomputed).toEqual({ ok: true, value: form.summary.totalCents });

    expect(form.coupon).toEqual({ code: "WELCOME10", description: view.value.coupon?.description ?? "", freeShipping: false });
    expect(form.shipping.selectedId).toBe("standard");
    expect(form.shipping.currency).toBe("USD");
    expect(form.shipping.now).toBe(NOW);
    expect(form.shipping.options.map((o) => o.method.id)).toEqual(["standard", "express", "next_day"]);
    expect(form.freeShipping).toEqual({ subtotalCents: 3998, thresholdCents: 3500, amountToFreeCents: 0, currency: "USD" });
    expect(form.isSignedIn).toBe(false);
    expect(form.email).toBeNull();
    expect(form.cartHref).toBe(CHECKOUT_CART_HREF);
    expect(data.couponNotice).toBeNull();
    expect(data.shippingNotice).toBeNull();
  });

  test("arrivals: one entry per option, all from the same now", () => {
    cart.addItem(OWNER, TOTE, 1);
    const { form } = ready(loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps()));
    const arrivals = form.shipping.arrivals ?? {};
    expect(Object.keys(arrivals).sort()).toEqual(["express", "next_day", "standard"]);
    for (const option of form.shipping.options) {
      expect(arrivals[option.method.id]).toEqual(estimateDelivery(option.method, NOW, NOW));
    }
  });

  test("FREESHIP coupon: coupon.freeShipping true and shipping 0 for the selected method", () => {
    cart.addItem(OWNER, TOTE, 1); // 1999 < 3500 threshold
    expect(cart.selectShippingMethod(OWNER, "express").ok).toBe(true);
    db.run("UPDATE products SET price_cents = 2500 WHERE id = ?", [TOTE]);
    const applied = cart.applyCoupon(OWNER, "FREESHIP", NOW);
    expect(applied.ok).toBe(true);
    const { form } = ready(loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps()));
    expect(form.coupon?.freeShipping).toBe(true);
    expect(form.shipping.selectedId).toBe("express");
    expect(form.summary.shippingCents).toBe(0);
    expect(form.summary.totalCents).toBe(form.summary.subtotalCents - form.summary.discountCents);
  });

  test("paid shipping below the threshold is in the total", () => {
    cart.addItem(OWNER, TOTE, 1); // 1999
    const { form } = ready(loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps()));
    expect(form.summary.shippingCents).toBe(499);
    expect(form.summary.totalCents).toBe(1999 + 499);
    expect(form.freeShipping?.amountToFreeCents).toBe(3500 - 1999);
  });

  test("signed-in user: isSignedIn + account email; the owner key never appears in the data", () => {
    cart.addItem(OWNER, TOTE, 1);
    save(OWNER);
    const data = ready(loadCheckoutPageV2({ ownerKey: OWNER, user: USER }, deps()));
    expect(data.form.isSignedIn).toBe(true);
    expect(data.form.email).toBe("ada@example.com");
    expect(JSON.stringify(data)).not.toContain(OWNER);
    expect(Object.keys(data.form.savedAddresses[0] ?? {})).not.toContain("sessionId");
  });

  test("address storage failure degrades to an empty address book", () => {
    cart.addItem(OWNER, TOTE, 1);
    const failing: CheckoutAddressReader = {
      list: () => {
        throw new AddressStorageError("list", "SQLITE_BUSY");
      },
    };
    const { form } = ready(loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps({ getAddresses: () => failing })));
    expect(form.savedAddresses).toEqual([]);
  });

  test("a stored coupon dropped on this read surfaces its one-time notice", () => {
    cart.addItem(OWNER, TOTE, 2); // 3998 >= SAVE5 min 2500
    expect(cart.applyCoupon(OWNER, "SAVE5", NOW).ok).toBe(true);
    cart.setQuantity(OWNER, TOTE, 1); // 1999 < 2500
    const data = ready(loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps()));
    expect(data.couponNotice).not.toBeNull();
    expect(data.form.coupon).toBeNull();
  });

  test("a failing cart view throws (error boundary)", () => {
    const broken: CheckoutCartReader = {
      getCartView: () => ({ ok: false, error: { code: "INTERNAL_ERROR", message: "boom" } }),
    };
    expect(() => loadCheckoutPageV2({ ownerKey: OWNER, user: null }, deps({ getCart: () => broken }))).toThrow(
      "Cart could not be loaded: INTERNAL_ERROR",
    );
  });
});

describe("computeCheckoutArrivals", () => {
  test("skips a method with impossible day counts", () => {
    cart.addItem(OWNER, TOTE, 1);
    const view = cart.getCartView(OWNER, NOW);
    if (!view.ok) throw new Error("view");
    const [first, ...rest] = view.value.shippingOptions;
    if (first === undefined) throw new Error("no options");
    const bad = { ...first, method: { ...first.method, id: "bad", minDays: 5, maxDays: 1 } };
    const arrivals = computeCheckoutArrivals([bad, first, ...rest], NOW);
    expect(arrivals.bad).toBeUndefined();
    expect(Object.keys(arrivals)).toHaveLength(view.value.shippingOptions.length);
  });
});
