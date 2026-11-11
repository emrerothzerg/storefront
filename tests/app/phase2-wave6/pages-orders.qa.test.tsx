/**
 * T111b QA wave 6 part B: order pages (T110 with T94/T95 organisms, T55 order
 * service incl. the FIX-checkout-v2 pending-claim design) and the foreign
 * access matrix (T111 criterion 4). QA-owned. Page functions are called with
 * mocked `next/*`; `:memory:` SQLite seeded through the real services.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";

import type { PaymentProvider } from "@/server/payments/payment-provider";
import { renderToStaticMarkup } from "react-dom/server";

import {
  browserSubmit,
  createSignedInUser,
  duplicateIds,
  headingViolations,
  hrefViolations,
  installNextMocks,
  isRealPostForm,
  outcomeOf,
  parseHtml,
  qa,
  resetCookies,
  serverLike,
  uuidsIn,
  type SignedInUser,
} from "./_t111b-harness";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { createCartService } = await import("@/server/cart/cart-service");
const orderModule = await import("@/server/orders/order-service");
const { createMockPaymentProvider, MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");
const { getListService } = await import("@/server/lists/list-service");
const { isAllowedInternalHref } = await import("@/content/routes");
const { CHECKOUT_NOTICE_MESSAGES } = await import("@/components/organisms/_contracts/checkout-actions");
const { cancelOrder, buyAgainFromForm } = await import("@/app/actions/orders");
const ordersPageModule = await import("@/app/orders/page");
const orderPageModule = await import("@/app/orders/[id]/page");
const invoicePageModule = await import("@/app/orders/[id]/invoice/page");
const listPageModule = await import("@/app/lists/[id]/page");
const accountPageModule = await import("@/app/account/page");

const { createOrderService, PENDING_PAYMENT_REF } = orderModule;
const OrdersPage = ordersPageModule.default;
const OrderPage = orderPageModule.default;
const InvoicePage = invoicePageModule.default;
const ListPage = listPageModule.default;
const AccountPage = accountPageModule.default;

const TOTE = "prod_canvas-tote-bag"; // "Canvas Tote Bag"
const PIN = "prod_enamel-pin-set"; // "Enamel Pin Set"
const DESK = "prod_walnut-desk"; // "Walnut Standing Desk"
const GUEST = "e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3";
const A_ORDER_EMAIL = "ada.order.contact@example.test";
const B_ORDER_EMAIL = "bob.order.contact@example.test";
const UNKNOWN_TOKEN = "Q".repeat(43);

let userA: SignedInUser;
let userB: SignedInUser;
const ids = {
  a1: "", // paid, fresh (cancellable), TOTE
  a2: "", // paid, 40 min old (not cancellable), PIN, delivery note
  a3: "", // paid, fresh, for the no-JS cancel round trip
  aDeclined: "",
  b1: "", // B's paid order, DESK
  listA: "",
  keyA1: "",
};

const db = () => getDatabase();

function address(email: string, fullName: string) {
  return { fullName, email, line1: "1 Analytical Way", city: "London", region: "LDN", postalCode: "N1 9GU", country: "GB" };
}

function service(payments: PaymentProvider = createMockPaymentProvider({ latencyMs: 0 })) {
  return createOrderService(db(), { payments, inFlight: new Map() });
}

async function place(
  owner: string,
  productId: string,
  opts: { card?: string; now?: number; email?: string; note?: string } = {},
): Promise<{ id: string; key: string; ok: boolean }> {
  const added = createCartService().addItem(owner, productId, 1);
  if (!added.ok) throw new Error(`addItem ${added.error.code}`);
  const key = `t111b-${crypto.randomUUID()}`;
  const r = await service().placeOrderV2(
    {
      sessionId: owner,
      address: address(opts.email ?? A_ORDER_EMAIL, "Ada Lovelace"),
      card: { number: opts.card ?? MOCK_CARDS.success, expMonth: 12, expYear: 2031, cvc: "987", nameOnCard: "Ada" },
      idempotencyKey: key,
      ...(opts.note === undefined ? {} : { deliveryNote: opts.note }),
    },
    opts.now,
  );
  if (r.ok) return { id: r.value.id, key, ok: true };
  const orderId = r.error.details?.orderId;
  if (typeof orderId !== "string") throw new Error(`place failed ${r.error.code}`);
  // A declined attempt leaves the cart line in place; clear it for later fixtures.
  createCartService().removeItem(owner, productId);
  return { id: orderId, key, ok: false };
}

async function html(element: Promise<ReactElement>): Promise<string> {
  return renderToStaticMarkup(await element);
}

const orderProps = (id: string, sp: Record<string, string | string[]> = {}) => ({
  params: Promise.resolve({ id }),
  searchParams: Promise.resolve(sp),
});

beforeAll(async () => {
  closeDatabase();
  seedDatabase(db());
  for (const p of [TOTE, PIN, DESK]) db().run("UPDATE products SET stock = 500 WHERE id = ?", [p]);
  userA = await createSignedInUser(db(), "Ada Account", "ada.account");
  userB = await createSignedInUser(db(), "Bob Account", "bob.account");
  const a1 = await place(userA.ownerKey, TOTE);
  ids.a1 = a1.id;
  ids.keyA1 = a1.key;
  ids.a2 = (await place(userA.ownerKey, PIN, { now: Date.now() - 40 * 60_000, note: "Ring twice" })).id;
  ids.a3 = (await place(userA.ownerKey, TOTE)).id;
  ids.aDeclined = (await place(userA.ownerKey, DESK, { card: MOCK_CARDS.declined })).id;
  ids.b1 = (await place(userB.ownerKey, DESK, { email: B_ORDER_EMAIL })).id;
  const list = getListService().createList(userA.ownerKey, "Ada Secret Gifts");
  if (!list.ok) throw new Error("list");
  ids.listA = list.value.id;
});

afterEach(() => {
  resetCookies();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

function commonLeaks(markup: string): string[] {
  const out: string[] = [];
  const needles: Record<string, string> = {
    ownerKeyA: userA.ownerKey,
    ownerKeyB: userB.ownerKey,
    tokenA: userA.token,
    tokenB: userB.token,
    emailB: B_ORDER_EMAIL,
    accountEmailB: userB.email,
    idemKey: ids.keyA1,
    card: MOCK_CARDS.success,
    cardDeclined: MOCK_CARDS.declined,
  };
  for (const [label, needle] of Object.entries(needles)) if (markup.includes(needle)) out.push(label);
  return out;
}

// ---------------------------------------------------------------------------
// Criterion 3: order pages
// ---------------------------------------------------------------------------

describe("C3 /orders (history)", () => {
  test("page sources: no clock read in page JSX; metadata noindex", async () => {
    for (const rel of ["page.tsx", "[id]/page.tsx", "[id]/invoice/page.tsx"]) {
      const src = readFileSync(join(import.meta.dir, "../../../src/app/orders", rel), "utf8");
      expect({ rel, now: src.includes("Date.now(") || /new Date\(\s*\)/.test(src) }).toEqual({ rel, now: false });
    }
    expect((await ordersPageModule.generateMetadata()).robots).toEqual({ index: false, follow: false });
    expect((await orderPageModule.generateMetadata()).robots).toEqual({ index: false, follow: false });
    const inv = await invoicePageModule.generateMetadata({ params: Promise.resolve({ id: ids.a1 }) });
    expect(inv.robots).toEqual({ index: false, follow: false });
  });

  test("owner sees only own paid orders (no declined, no B's), GET filter form, allow-listed hrefs, one h1", async () => {
    resetCookies({ sf_auth: userA.token });
    const markup = await html(OrdersPage({ searchParams: Promise.resolve({}) }));
    const doc = parseHtml(markup);
    expect(markup).toContain(ids.a1.slice(0, 8).toUpperCase());
    expect(markup).toContain(ids.a2.slice(0, 8).toUpperCase());
    expect(markup).not.toContain(ids.b1);
    expect(markup).not.toContain(ids.b1.slice(0, 8).toUpperCase());
    expect(markup).not.toContain(ids.aDeclined);
    expect(markup).not.toContain(ids.aDeclined.slice(0, 8).toUpperCase());
    const getForms = [...doc.body.querySelectorAll("form")].filter((f) => (f.getAttribute("method") ?? "").toLowerCase() === "get");
    expect(getForms.length).toBeGreaterThanOrEqual(1);
    for (const f of getForms) expect(f.getAttribute("action")).toBe("/orders");
    expect(hrefViolations(doc, isAllowedInternalHref).filter((v) => !v.startsWith("form-action:javascript"))).toEqual([]);
    expect(headingViolations(doc)).toEqual([]);
    expect(duplicateIds(doc)).toEqual([]);
    expect(doc.body.querySelector("main")).toBeNull();
    expect(doc.body.querySelector('nav[aria-label="Breadcrumb"]')).not.toBeNull();
    expect(commonLeaks(markup)).toEqual([]);
    expect(markup).not.toContain(A_ORDER_EMAIL);
    expect(qa.store.writes).toEqual([]);
  });

  test("?q= searches line names; ?tab=cancelled empty; garbage params fall back without throwing", async () => {
    resetCookies({ sf_auth: userA.token });
    const pin = await html(OrdersPage({ searchParams: Promise.resolve({ q: "enamel" }) }));
    expect(pin).toContain(ids.a2.slice(0, 8).toUpperCase());
    expect(pin).not.toContain(ids.a1.slice(0, 8).toUpperCase());
    const cancelled = await html(OrdersPage({ searchParams: Promise.resolve({ tab: "cancelled" }) }));
    expect(cancelled).not.toContain(ids.a1.slice(0, 8).toUpperCase());
    const garbage = await html(
      OrdersPage({
        searchParams: Promise.resolve({ tab: "<x>", range: ["1y", "evil"], q: "a".repeat(5000), page: "-9" }),
      }),
    );
    expect(parseHtml(garbage).body.querySelectorAll("h1")).toHaveLength(1);
    const buyAgain = await html(OrdersPage({ searchParams: Promise.resolve({ tab: "buy-again" }) }));
    expect(buyAgain).toContain("Canvas Tote Bag");
    expect(buyAgain).not.toContain("Walnut Standing Desk"); // only in the declined order and B's order
  });

  test("no cookie -> 200 empty state, no service call, no cookie write", async () => {
    const spy = spyOn(orderModule, "getOrderService");
    try {
      const markup = await html(OrdersPage({ searchParams: Promise.resolve({ tab: "orders" }) }));
      expect(parseHtml(markup).body.querySelectorAll("h1")).toHaveLength(1);
      expect(uuidsIn(markup)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(0);
      expect(qa.store.writes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("C3 /orders/[id]", () => {
  test("owner detail: one h1, breadcrumb, invoice link, cancel form (real POST) within the window, no leaks", async () => {
    resetCookies({ sf_auth: userA.token });
    const restore = serverLike([cancelOrder, buyAgainFromForm]);
    let markup = "";
    try {
      markup = await html(OrderPage(orderProps(ids.a1)));
    } finally {
      restore();
    }
    const doc = parseHtml(markup);
    expect(headingViolations(doc)).toEqual([]);
    expect(duplicateIds(doc)).toEqual([]);
    expect(doc.body.querySelector("main")).toBeNull();
    expect(doc.body.querySelector('a[href="/orders/' + ids.a1 + '/invoice"]')).not.toBeNull();
    const cancelForm = [...doc.body.querySelectorAll("form")].find(
      (f) => f.querySelector('input[name="confirm"]') !== null,
    );
    if (cancelForm === undefined) throw new Error("no cancel form");
    expect(isRealPostForm(cancelForm)).toBe(true);
    expect(cancelForm.querySelector('input[name="orderId"]')?.getAttribute("value")).toBe(ids.a1);
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
    expect(commonLeaks(markup)).toEqual([]);
    expect(markup).not.toContain(A_ORDER_EMAIL);
    expect(markup).toContain("4242");
    expect(uuidsIn(markup)).toEqual([ids.a1]);
    expect(qa.store.writes).toEqual([]);
  });

  test("cancel form absent outside the 30-minute window", async () => {
    resetCookies({ sf_auth: userA.token });
    const doc = parseHtml(await html(OrderPage(orderProps(ids.a2))));
    expect(doc.body.querySelector('input[name="confirm"]')).toBeNull();
    expect(doc.body.textContent).toContain("Ring twice");
  });

  test("?placed=1 confirmation variant; notice tokens via parseCheckoutNotice; hostile/odd params ignored", async () => {
    resetCookies({ sf_auth: userA.token });
    const conf = parseHtml(await html(OrderPage(orderProps(ids.a1, { placed: "1" }))));
    expect(conf.body.querySelector("h1")?.textContent).toContain("Order placed");
    expect(conf.body.textContent).not.toContain(CHECKOUT_NOTICE_MESSAGES.address_full);

    const full = parseHtml(await html(OrderPage(orderProps(ids.a1, { placed: "1", notice: "address_full" }))));
    expect(full.body.textContent).toContain(CHECKOUT_NOTICE_MESSAGES.address_full);
    const notSaved = parseHtml(await html(OrderPage(orderProps(ids.a1, { placed: "1", notice: "address_not_saved" }))));
    expect(notSaved.body.textContent).toContain(CHECKOUT_NOTICE_MESSAGES.address_not_saved);

    const hostile = await html(OrderPage(orderProps(ids.a1, { placed: "1", notice: "<script>alert(1)</script>" })));
    expect(hostile).not.toContain("alert(1)");
    expect(hostile).not.toContain(CHECKOUT_NOTICE_MESSAGES.address_full);

    for (const placed of ["2", "true", ""] as const) {
      const d = parseHtml(await html(OrderPage(orderProps(ids.a1, { placed }))));
      expect({ placed, h1: d.body.querySelector("h1")?.textContent?.includes("Order placed") }).toEqual({ placed, h1: false });
    }
    const arr = parseHtml(await html(OrderPage(orderProps(ids.a1, { placed: ["1", "1"] }))));
    expect(arr.body.querySelector("h1")?.textContent).not.toContain("Order placed");
  });

  test("owner's declined order: MVP fallback view, no invoice link, last4 only", async () => {
    resetCookies({ sf_auth: userA.token });
    const markup = await html(OrderPage(orderProps(ids.aDeclined)));
    const doc = parseHtml(markup);
    expect(doc.body.querySelector("h1")?.textContent).toBe("Payment failed");
    expect(headingViolations(doc)).toEqual([]);
    expect(markup).not.toContain("/invoice");
    expect(markup).toContain("0002");
    expect(commonLeaks(markup)).toEqual([]);
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
  });

  test("another owner's id, unknown id, no cookie -> 404 (same notFound)", async () => {
    resetCookies({ sf_auth: userA.token });
    expect((await outcomeOf(() => OrderPage(orderProps(ids.b1)))).kind).toBe("notFound");
    expect((await outcomeOf(() => OrderPage(orderProps(crypto.randomUUID())))).kind).toBe("notFound");
    resetCookies();
    expect((await outcomeOf(() => OrderPage(orderProps(ids.a1, { placed: "1" })))).kind).toBe("notFound");
    expect(qa.store.writes).toEqual([]);
  });

  const GARBAGE_IDS = [
    "not-a-uuid",
    "../../etc/passwd",
    "' OR 1=1 --",
    "%00",
    "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa",
    "x".repeat(5000),
    "",
  ];

  test("garbage ids -> 404 without any order-service call", async () => {
    resetCookies({ sf_auth: userA.token });
    const spy = spyOn(orderModule, "getOrderService");
    try {
      for (const id of [...GARBAGE_IDS, ids.a1.toUpperCase()]) {
        expect({ id: id.slice(0, 40), kind: (await outcomeOf(() => OrderPage(orderProps(id)))).kind }).toEqual({
          id: id.slice(0, 40),
          kind: "notFound",
        });
        expect((await outcomeOf(() => InvoicePage({ params: Promise.resolve({ id }) }))).kind).toBe("notFound");
      }
      expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  // PIN: D-T110-1
  test("garbage ids -> 404 with NO database lookup at all (guest cookie present)", async () => {
    resetCookies({ sf_session: GUEST });
    const database = db();
    const q = spyOn(database, "query");
    const p = spyOn(database, "prepare");
    try {
      expect((await outcomeOf(() => OrderPage(orderProps("not-a-uuid")))).kind).toBe("notFound");
      expect((await outcomeOf(() => InvoicePage({ params: Promise.resolve({ id: "not-a-uuid" }) }))).kind).toBe("notFound");
      expect(q.mock.calls.length + p.mock.calls.length).toBe(0);
    } finally {
      q.mockRestore();
      p.mockRestore();
    }
  });

  test("no-JS cancel round trip: browser-shaped POST through the real cancelOrder, re-render shows refund notice", async () => {
    resetCookies({ sf_auth: userA.token });
    const restore = serverLike([cancelOrder, buyAgainFromForm]);
    try {
      const doc = parseHtml(await html(OrderPage(orderProps(ids.a3))));
      const cancelForm = [...doc.body.querySelectorAll("form")].find((f) => f.querySelector('input[name="confirm"]') !== null);
      if (cancelForm === undefined) throw new Error("no cancel form");
      const body = await browserSubmit(cancelForm, { confirm: "yes" });
      const state = await cancelOrder(null, body);
      expect(state).toMatchObject({ ok: true, kind: "cancelled" });
      const after = parseHtml(await html(OrderPage(orderProps(ids.a3))));
      expect(after.body.textContent).toContain("Refund");
      expect(after.body.textContent).toMatch(/refund/i);
      expect(after.body.querySelector('input[name="confirm"]')).toBeNull();
      // B cannot cancel A's order with a forged POST
      resetCookies({ sf_auth: userB.token });
      const forged = new FormData();
      forged.append("orderId", ids.a1);
      forged.append("confirm", "yes");
      expect(await cancelOrder(null, forged)).toMatchObject({ ok: false, error: { code: "ORDER_NOT_FOUND" } });
    } finally {
      restore();
    }
  });

  // PIN: D-T110-2
  test("pending-claim row (charge in flight) is never rendered: /orders/[id] is 404", async () => {
    const outcome = await withPendingClaim(async (pendingId) => {
      resetCookies({ sf_auth: userA.token });
      return (await outcomeOf(() => OrderPage(orderProps(pendingId)))).kind;
    });
    expect(outcome).toBe("notFound");
  });
});

/** Runs `fn` while A has an order row in the FIX-checkout-v2 pending-claim state (charge awaiting a gate). */
async function withPendingClaim<T>(fn: (pendingId: string) => Promise<T>): Promise<T> {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const real = createMockPaymentProvider({ latencyMs: 0 });
  const gated = { charge: async (req: Parameters<typeof real.charge>[0]) => gate.then(() => real.charge(req)) };
  const added = createCartService().addItem(userA.ownerKey, PIN, 1);
  if (!added.ok) throw new Error("add");
  const placing = service(gated).placeOrderV2({
    sessionId: userA.ownerKey,
    address: address(A_ORDER_EMAIL, "Ada Lovelace"),
    card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2031, cvc: "987", nameOnCard: "Ada" },
    idempotencyKey: `t111b-pending-${crypto.randomUUID()}`,
  });
  try {
    let row: { id: string } | null = null;
    for (let i = 0; i < 200 && row === null; i += 1) {
      row = db().query<{ id: string }, [string]>("SELECT id FROM orders WHERE payment_ref = ?").get(PENDING_PAYMENT_REF);
      if (row === null) await Bun.sleep(5);
    }
    if (row === null) throw new Error("no pending row");
    return await fn(row.id);
  } finally {
    open();
    await placing;
  }
}

describe("C3 /orders/[id]/invoice", () => {
  test("owner's paid order: one h1, items, last4, no forms/scripts, no leaks", async () => {
    resetCookies({ sf_auth: userA.token });
    const markup = await html(InvoicePage({ params: Promise.resolve({ id: ids.a2 }) }));
    const doc = parseHtml(markup);
    expect(headingViolations(doc)).toEqual([]);
    expect(doc.body.textContent).toContain("Enamel Pin Set");
    expect(doc.body.textContent).toContain("4242");
    expect(doc.body.querySelectorAll("form, script")).toHaveLength(0);
    expect(commonLeaks(markup)).toEqual([]);
    expect(markup).not.toContain(A_ORDER_EMAIL);
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
  });

  test("declined, foreign, unknown, no cookie -> 404", async () => {
    resetCookies({ sf_auth: userA.token });
    for (const id of [ids.aDeclined, ids.b1, crypto.randomUUID()]) {
      expect((await outcomeOf(() => InvoicePage({ params: Promise.resolve({ id }) }))).kind).toBe("notFound");
    }
    resetCookies();
    expect((await outcomeOf(() => InvoicePage({ params: Promise.resolve({ id: ids.a2 }) }))).kind).toBe("notFound");
  });
});

// ---------------------------------------------------------------------------
// Criterion 5: foreign access matrix
// ---------------------------------------------------------------------------

describe("C5 foreign access matrix", () => {
  const actors = (): Record<string, Record<string, string>> => ({
    guest: {},
    userB: { sf_auth: userB.token },
    garbage: { sf_session: "garbage';--", sf_auth: UNKNOWN_TOKEN },
    "R-1 (guest cookie = A owner key)": { sf_session: userA.ownerKey },
    "userB + guest cookie = A owner key": { sf_auth: userB.token, sf_session: userA.ownerKey },
    "unrelated guest": { sf_session: GUEST },
  });

  function aDataIn(markup: string): string[] {
    const out: string[] = [];
    const needles: Record<string, string> = {
      a1: ids.a1,
      a2: ids.a2,
      a1short: ids.a1.slice(0, 8).toUpperCase(),
      a2short: ids.a2.slice(0, 8).toUpperCase(),
      list: ids.listA,
      listName: "Ada Secret Gifts",
      email: userA.email,
      orderEmail: A_ORDER_EMAIL,
      name: "Ada Account",
      ownerKey: userA.ownerKey,
      token: userA.token,
      note: "Ring twice",
    };
    for (const [label, needle] of Object.entries(needles)) if (markup.includes(needle)) out.push(label);
    return out;
  }

  test("positive control: user A sees own orders, invoice, list and named hub", async () => {
    resetCookies({ sf_auth: userA.token });
    expect(await html(OrdersPage({ searchParams: Promise.resolve({}) }))).toContain(ids.a1.slice(0, 8).toUpperCase());
    expect((await outcomeOf(() => OrderPage(orderProps(ids.a1)))).kind).toBe("ok");
    expect((await outcomeOf(() => InvoicePage({ params: Promise.resolve({ id: ids.a1 }) }))).kind).toBe("ok");
    const list = await outcomeOf(() => ListPage({ params: Promise.resolve({ id: ids.listA }), searchParams: Promise.resolve({}) }));
    expect(list.kind).toBe("ok");
    expect(await html(AccountPage())).toContain("Ada Account");
    expect(qa.store.writes).toEqual([]);
  });

  test("every non-owner cell is 404 or empty; no A data; no cookie writes", async () => {
    const cells: Record<string, string> = {};
    for (const [actor, cookies] of Object.entries(actors())) {
      resetCookies(cookies);
      const list = await html(OrdersPage({ searchParams: Promise.resolve({ range: "all" }) }));
      cells[`${actor} /orders`] = aDataIn(list).length === 0 ? "empty" : `LEAK ${aDataIn(list).join(",")}`;

      for (const [label, run] of [
        ["/orders/[A]", () => OrderPage(orderProps(ids.a1, { placed: "1" }))],
        ["/orders/[A declined]", () => OrderPage(orderProps(ids.aDeclined))],
        ["/orders/[A]/invoice", () => InvoicePage({ params: Promise.resolve({ id: ids.a1 }) })],
        ["/lists/[A]", () => ListPage({ params: Promise.resolve({ id: ids.listA }), searchParams: Promise.resolve({}) })],
      ] as const) {
        const o = await outcomeOf(run);
        cells[`${actor} ${label}`] = o.kind === "notFound" ? "404" : `NOT-404 ${o.kind}`;
      }

      const hub = await outcomeOf(() => AccountPage());
      if (hub.kind !== "ok") cells[`${actor} /account`] = `NOT-200 ${hub.kind}`;
      else {
        const m = renderToStaticMarkup(hub.value);
        cells[`${actor} /account`] = aDataIn(m).length === 0 ? "200 no-A-data" : `LEAK ${aDataIn(m).join(",")}`;
      }
      cells[`${actor} cookie writes`] = qa.store.writes.length === 0 ? "none" : qa.store.writes.join(",");
    }
    const bad = Object.entries(cells).filter(
      ([, v]) => !(v === "empty" || v === "404" || v === "200 no-A-data" || v === "none"),
    );
    expect(bad).toEqual([]);
    expect(Object.keys(cells)).toHaveLength(6 * 7);
  });

  test("guest hub: 200, guest notice, zero counts; B's hub shows B only", async () => {
    resetCookies();
    const guest = await html(AccountPage());
    expect(guest).toContain("device-bound");
    expect(aDataIn(guest)).toEqual([]);
    resetCookies({ sf_auth: userB.token });
    const b = await html(AccountPage());
    expect(b).toContain("Bob Account");
    expect(aDataIn(b)).toEqual([]);
    expect(qa.store.writes).toEqual([]);
  });

  test("buy-again tab and add-to-cart grid never show another owner's lines", async () => {
    resetCookies({ sf_auth: userB.token });
    const m = await html(OrdersPage({ searchParams: Promise.resolve({ tab: "buy-again" }) }));
    expect(m).not.toContain("Canvas Tote Bag");
    expect(m).not.toContain("Enamel Pin Set");
  });
});
