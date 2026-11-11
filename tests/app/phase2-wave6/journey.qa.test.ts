/**
 * T111b QA wave 6 part B: purchase journey at function level (T111 criterion
 * 3). PDP data -> addToCart -> applyCoupon -> selectShippingMethod ->
 * checkout page -> browser-shaped POST through the real `placeOrderV2` ->
 * history -> cancelOrder -> buyAgain. Every step goes through the real server
 * actions and page functions with mocked `next/*`; each shopper carries an
 * own cookie jar (AsyncLocalStorage), so two journeys can run concurrently.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  browserSubmit,
  cookieScope,
  installNextMocks,
  parseHtml,
  QaCookieStore,
  redirectOrState,
  serverLike,
  stockOf,
  TYPED_NEW_ADDRESS,
} from "./_t111b-harness";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { createCartService } = await import("@/server/cart/cart-service");
const { getOrderService } = await import("@/server/orders/order-service");
const { MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");
const { formatMoney } = await import("@/lib/money");
const { loadPdp } = await import("@/app/products/[slug]/_lib/pdp-data");
const cartActions = await import("@/app/actions/cart");
const { placeOrderV2 } = await import("@/app/actions/checkout-v2");
const { cancelOrder, buyAgain } = await import("@/app/actions/orders");
const { default: CheckoutPage } = await import("@/app/checkout/page");
const { default: OrdersPage } = await import("@/app/orders/page");
const { default: OrderPage } = await import("@/app/orders/[id]/page");

const SLUG = "canvas-tote-bag";
const TOTE = "prod_canvas-tote-bag";
const PIN = "prod_enamel-pin-set";
const SESSION_COOKIE = "sf_session";
const PLACED_RE = /^\/orders\/([0-9a-f-]{36})\?placed=1$/;
const TIMEOUT = 30_000;

const db = () => getDatabase();

function fd(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
}

interface OrderRow {
  session_id: string;
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  total_cents: number;
  coupon_code: string | null;
  shipping_method_id: string | null;
  fulfillment_status: string;
}

function orderRow(id: string): OrderRow | null {
  return db()
    .query<OrderRow, [string]>(
      `SELECT session_id, status, subtotal_cents, discount_cents, shipping_cents, total_cents, coupon_code,
              shipping_method_id, fulfillment_status FROM orders WHERE id = ?`,
    )
    .get(id);
}

function redemptions(code: string): { session_id: string; order_id: string | null }[] {
  return db()
    .query<{ session_id: string; order_id: string | null }, [string]>(
      "SELECT session_id, order_id FROM coupon_redemptions WHERE coupon_code = ? ORDER BY session_id",
    )
    .all(code);
}

function usedCount(code: string): number {
  return db().query<{ n: number }, [string]>("SELECT used_count AS n FROM coupons WHERE code = ?").get(code)?.n ?? -1;
}

function ordersCount(): number {
  return db().query<{ n: number }, []>("SELECT count(*) AS n FROM orders").get()?.n ?? -1;
}

function owner(store: QaCookieStore): string {
  const id = store.jar.get(SESSION_COOKIE);
  if (id === undefined) throw new Error("no session cookie minted");
  return id;
}

const inScope = <T>(store: QaCookieStore, run: () => Promise<T>): Promise<T> => cookieScope.run(store, run);

interface JourneyResult {
  readonly ownerKey: string;
  readonly orderId: string;
  readonly body: FormData;
  readonly expected: { subtotal: number; discount: number; shipping: number; total: number };
}

/** PDP -> add -> coupon -> shipping -> checkout page -> no-JS POST. Returns the placed order. */
async function shopAndPlace(store: QaCookieStore, quantity: number, shippingId: string): Promise<JourneyResult> {
  const pdp = await loadPdp({ slug: SLUG, sessionId: null });
  if (!pdp.found) throw new Error("PDP not found");
  expect(pdp.data.product.id).toBe(TOTE);

  return inScope(store, async () => {
    const added = await cartActions.addToCart(null, fd({ productId: pdp.data.product.id, quantity: String(quantity) }));
    expect(added?.ok).toBe(true);
    const ownerKey = owner(store);
    expect(store.writes.filter((w) => w === `set:${SESSION_COOKIE}`)).toHaveLength(1);

    const coupon = await cartActions.applyCoupon(null, fd({ couponCode: "welcome10" }));
    expect(coupon).toMatchObject({ ok: true, value: { kind: "coupon_applied" } });
    const ship = await cartActions.selectShippingMethod(null, fd({ shippingMethodId: shippingId }));
    expect(ship).toMatchObject({ ok: true, value: { kind: "shipping_selected" } });

    const view = createCartService().getCartView(ownerKey);
    if (!view.ok) throw new Error("view");
    const t = view.value.totals;
    const expected = { subtotal: t.subtotalCents, discount: t.discountCents, shipping: t.shippingCents, total: t.totalCents };
    expect(expected.subtotal).toBe(pdp.data.product.priceCents * quantity);
    expect(expected.discount).toBeGreaterThan(0);

    const writesBeforeRender = store.writes.length;
    const restore = serverLike([placeOrderV2]);
    let html = "";
    try {
      html = renderToStaticMarkup(await CheckoutPage());
    } finally {
      restore();
    }
    expect(store.writes.length).toBe(writesBeforeRender);
    const doc = parseHtml(html);
    expect(doc.body.textContent).toContain(formatMoney(expected.total, "USD"));
    const form = doc.body.querySelector("form");
    if (form === null) throw new Error("no checkout form");
    expect(form.querySelector('input[name="shippingMethodId"][checked]')?.getAttribute("value")).toBe(shippingId);

    const body = await browserSubmit(form, TYPED_NEW_ADDRESS);
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("url" in out)) throw new Error(`no redirect: ${JSON.stringify(out.state)}`);
    const orderId = PLACED_RE.exec(out.url)?.[1];
    if (orderId === undefined) throw new Error(`bad redirect ${out.url}`);
    return { ownerKey, orderId, body, expected };
  });
}

beforeEach(() => {
  closeDatabase();
  seedDatabase(db());
  db().run("UPDATE products SET stock = 500 WHERE id IN (?, ?)", [TOTE, PIN]);
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("C4 purchase journey (function level)", () => {
  test(
    "PDP -> add -> coupon -> shipping -> placeOrderV2 -> history -> replay -> cancel -> buyAgain",
    async () => {
      const store = new QaCookieStore(true);
      const stock0 = stockOf(db(), TOTE);
      const used0 = usedCount("WELCOME10");

      const { ownerKey, orderId, body, expected } = await shopAndPlace(store, 2, "express");

      // order persisted with the server totals the page showed
      expect(orderRow(orderId)).toEqual({
        session_id: ownerKey,
        status: "paid",
        subtotal_cents: expected.subtotal,
        discount_cents: expected.discount,
        shipping_cents: expected.shipping,
        total_cents: expected.total,
        coupon_code: "WELCOME10",
        shipping_method_id: "express",
        fulfillment_status: "processing",
      });
      expect(stockOf(db(), TOTE)).toBe(stock0 - 2);
      expect(redemptions("WELCOME10")).toEqual([{ session_id: ownerKey, order_id: orderId }]);
      expect(usedCount("WELCOME10")).toBe(used0 + 1);
      const cartAfter = createCartService().getCart(ownerKey);
      expect(cartAfter.items).toHaveLength(0);

      await inScope(store, async () => {
        // history + confirmation
        const history = renderToStaticMarkup(await OrdersPage({ searchParams: Promise.resolve({}) }));
        expect(history).toContain(orderId.slice(0, 8).toUpperCase());
        expect(history).toContain(formatMoney(expected.total, "USD"));
        const confirm = parseHtml(
          renderToStaticMarkup(
            await OrderPage({ params: Promise.resolve({ id: orderId }), searchParams: Promise.resolve({ placed: "1" }) }),
          ),
        );
        expect(confirm.body.querySelector("h1")?.textContent).toContain("Order placed");
        expect(confirm.body.textContent).toContain(formatMoney(expected.total, "USD"));
        expect(confirm.body.textContent).toContain("WELCOME10");

        // same-key replay -> same order, nothing charged/reserved/redeemed again
        const ordersBefore = ordersCount();
        const replay = await redirectOrState(() => placeOrderV2(null, body));
        expect(replay).toEqual({ url: `/orders/${orderId}?placed=1` });
        expect(ordersCount()).toBe(ordersBefore);
        expect(stockOf(db(), TOTE)).toBe(stock0 - 2);
        expect(usedCount("WELCOME10")).toBe(used0 + 1);

        // single-use per owner while the order stands
        const reuse = await cartActions.addToCart(null, fd({ productId: TOTE, quantity: "1" }));
        expect(reuse?.ok).toBe(true);
        const again = await cartActions.applyCoupon(null, fd({ couponCode: "WELCOME10" }));
        expect(again).toMatchObject({ ok: false, error: { code: "COUPON_USED" } });
        await cartActions.removeFromCart(null, fd({ productId: TOTE }));

        // cancel within the window
        const cancelled = await cancelOrder(null, fd({ orderId, confirm: "yes" }));
        expect(cancelled).toMatchObject({ ok: true, kind: "cancelled" });
        expect(cancelled?.ok === true ? cancelled.message : "").toMatch(/refund is pending/i);
        expect(stockOf(db(), TOTE)).toBe(stock0);
        expect(redemptions("WELCOME10")).toEqual([]);
        expect(usedCount("WELCOME10")).toBe(used0);
        expect(orderRow(orderId)?.fulfillment_status).toBe("cancelled");
        const second = await cancelOrder(null, fd({ orderId, confirm: "yes" }));
        expect(second).toMatchObject({ ok: false, error: { code: "ORDER_NOT_CANCELLABLE" } });
        expect(stockOf(db(), TOTE)).toBe(stock0);

        const detail = parseHtml(
          renderToStaticMarkup(await OrderPage({ params: Promise.resolve({ id: orderId }), searchParams: Promise.resolve({}) })),
        );
        expect(detail.body.textContent).toContain("Refund");
        expect(detail.body.textContent).toMatch(/cancelled/i);
        expect(detail.body.querySelector('input[name="confirm"]')).toBeNull();
        const cancelledTab = renderToStaticMarkup(await OrdersPage({ searchParams: Promise.resolve({ tab: "cancelled" }) }));
        expect(cancelledTab).toContain(orderId.slice(0, 8).toUpperCase());

        // redemption released -> the coupon applies again
        await cartActions.addToCart(null, fd({ productId: TOTE, quantity: "1" }));
        expect(await cartActions.applyCoupon(null, fd({ couponCode: "WELCOME10" }))).toMatchObject({ ok: true });
        await cartActions.removeFromCart(null, fd({ productId: TOTE }));

        // buy again -> cart lines from the order
        const bought = await buyAgain(null, fd({ orderId }));
        expect(bought).toMatchObject({ ok: true, kind: "buy_again" });
        const cart = createCartService().getCart(ownerKey);
        expect(cart.items.map((l) => [l.productId, l.quantity])).toEqual([[TOTE, 2]]);
      });
      // only the first add minted the cookie; nothing else wrote one
      expect(store.writes).toEqual([`set:${SESSION_COOKIE}`]);
    },
    TIMEOUT,
  );

  test(
    "buyAgain caps at 99 per line and skips unpublished products (R-CART-1)",
    async () => {
      const store = new QaCookieStore(true);
      await inScope(store, async () => {
        expect((await cartActions.addToCart(null, fd({ productId: TOTE, quantity: "60" })))?.ok).toBe(true);
        expect((await cartActions.addToCart(null, fd({ productId: PIN, quantity: "1" })))?.ok).toBe(true);
        const ownerKey = owner(store);
        const placed = await getOrderService().placeOrderV2({
          sessionId: ownerKey,
          address: { fullName: "Cap Tester", email: "cap@example.test", line1: "1 Cap St", city: "Bend", region: "OR", postalCode: "97701", country: "US" },
          card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2031, cvc: "123", nameOnCard: "Cap Tester" },
          idempotencyKey: `t111b-cap-${crypto.randomUUID()}`,
        });
        if (!placed.ok) throw new Error(placed.error.code);
        const orderId = placed.value.id;

        expect((await cartActions.addToCart(null, fd({ productId: TOTE, quantity: "50" })))?.ok).toBe(true);
        db().run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?", [PIN]);

        const result = await buyAgain(null, fd({ orderId }));
        expect(result).toMatchObject({ ok: true, kind: "buy_again" });
        const perLine = result?.ok === true && result.kind === "buy_again" ? (result.perLine ?? []) : [];
        expect(perLine.map((l) => [l.productId, l.result]).sort()).toEqual([
          [TOTE, "capped"],
          [PIN, "unavailable"],
        ]);
        const cart = createCartService().getCart(ownerKey);
        expect(cart.items.map((l) => [l.productId, l.quantity])).toEqual([[TOTE, 99]]);

        // already at the cap -> nothing written
        const again = await buyAgain(null, fd({ orderId, productId: TOTE }));
        expect(again).toMatchObject({ ok: true });
        expect(createCartService().getCart(ownerKey).items.map((l) => l.quantity)).toEqual([99]);
      });
    },
    TIMEOUT,
  );

  test(
    "two owners' concurrent journeys never interfere",
    async () => {
      const storeA = new QaCookieStore(true);
      const storeB = new QaCookieStore(true);
      const stock0 = stockOf(db(), TOTE);
      const [a, b] = await Promise.all([shopAndPlace(storeA, 2, "express"), shopAndPlace(storeB, 3, "standard")]);
      expect(a.ownerKey).not.toBe(b.ownerKey);
      expect(a.orderId).not.toBe(b.orderId);
      expect(stockOf(db(), TOTE)).toBe(stock0 - 5);
      expect(orderRow(a.orderId)?.session_id).toBe(a.ownerKey);
      expect(orderRow(b.orderId)?.session_id).toBe(b.ownerKey);
      expect(orderRow(a.orderId)?.total_cents).toBe(a.expected.total);
      expect(orderRow(b.orderId)?.total_cents).toBe(b.expected.total);
      expect(orderRow(b.orderId)?.shipping_method_id).toBe("standard");
      expect(redemptions("WELCOME10")).toEqual(
        [
          { session_id: a.ownerKey, order_id: a.orderId },
          { session_id: b.ownerKey, order_id: b.orderId },
        ].sort((x, y) => x.session_id.localeCompare(y.session_id)),
      );

      // histories are disjoint
      const historyA = await inScope(storeA, async () =>
        renderToStaticMarkup(await OrdersPage({ searchParams: Promise.resolve({}) })),
      );
      const historyB = await inScope(storeB, async () =>
        renderToStaticMarkup(await OrdersPage({ searchParams: Promise.resolve({}) })),
      );
      expect(historyA).toContain(a.orderId.slice(0, 8).toUpperCase());
      expect(historyA).not.toContain(b.orderId.slice(0, 8).toUpperCase());
      expect(historyB).toContain(b.orderId.slice(0, 8).toUpperCase());
      expect(historyB).not.toContain(a.orderId.slice(0, 8).toUpperCase());

      // B cannot cancel or buy again A's order; A's replay key from B's jar is refused
      await inScope(storeB, async () => {
        expect(await cancelOrder(null, fd({ orderId: a.orderId, confirm: "yes" }))).toMatchObject({
          ok: false,
          error: { code: "ORDER_NOT_FOUND" },
        });
        expect(await buyAgain(null, fd({ orderId: a.orderId }))).toMatchObject({ ok: false, error: { code: "ORDER_NOT_FOUND" } });
        const stolen = await redirectOrState(() => placeOrderV2(null, a.body));
        expect("state" in stolen).toBe(true);
      });
      expect(orderRow(a.orderId)?.fulfillment_status).toBe("processing");

      // concurrent cancels restore exactly the two reservations
      const [ca, cb] = await Promise.all([
        inScope(storeA, () => cancelOrder(null, fd({ orderId: a.orderId, confirm: "yes" }))),
        inScope(storeB, () => cancelOrder(null, fd({ orderId: b.orderId, confirm: "yes" }))),
      ]);
      expect(ca).toMatchObject({ ok: true });
      expect(cb).toMatchObject({ ok: true });
      expect(stockOf(db(), TOTE)).toBe(stock0);
      expect(redemptions("WELCOME10")).toEqual([]);
    },
    TIMEOUT,
  );
});
