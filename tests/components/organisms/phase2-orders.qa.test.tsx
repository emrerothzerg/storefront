// QA (QA-W4-organisms-F): T94 OrdersList + T95 OrderDetail.
// Realistic fixtures come from the REAL order service (placeOrderV2 / listOrders /
// cancelOrder / getBuyAgainLines) on a seeded `:memory:` DB.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Database } from "bun:sqlite";
import { isAllowedInternalHref } from "@/content/routes";
import { ok } from "@/lib/result";
import type { CartActionFnV2 } from "@/components/molecules/_contracts/cart-actions";
import type { OrderActionFn, OrderActionState } from "@/components/molecules/_contracts/order-actions";
import { CartSummary } from "@/components/organisms/CartSummary";
import {
  OrdersList,
  buildOrdersHref,
  dedupeBuyAgainProducts,
  parseOrderPage,
  parseOrderQuery,
  parseOrderRange,
  parseOrderTab,
  type BuyAgainProduct,
  type OrdersListOrder,
  type OrdersListProps,
} from "@/components/organisms/OrdersList";
import {
  OrderDetail,
  cancelMinutesLeft,
  normaliseLast4,
  paymentLabel,
  refundNoticeText,
  type OrderDetailOrder,
  type OrderDetailProps,
} from "@/components/organisms/OrderDetail";
import { createCartService, type CartServiceV2 } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createOrderService, type OrderServiceV2, type OrderView } from "@/server/orders/order-service";
import { MOCK_CARDS, createMockPaymentProvider } from "@/server/payments/mock-payment-provider";

const ROOT = join(import.meta.dir, "../../../src/components/organisms");
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const MIN = 60_000;
const EVIL = '<img src=x onerror="alert(1)">';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ---------------------------------------------------------------------------
// Real service fixtures
// ---------------------------------------------------------------------------

let db: Database;
let carts: CartServiceV2;
let orders: OrderServiceV2;
let catalog: { id: string; price: number }[] = [];
const OWNER = crypto.randomUUID();
const OTHER_OWNER = crypto.randomUUID();
const idemKeys: string[] = [];

async function place(
  owner: string,
  lines: { index: number; qty: number }[],
  opts: { coupon?: string; method?: string; note?: string; fullName?: string } = {},
): Promise<OrderView> {
  for (const l of lines) {
    const p = catalog[l.index];
    if (p === undefined) throw new Error("catalog");
    const r = carts.addItem(owner, p.id, l.qty);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  }
  if (opts.coupon) {
    const r = carts.applyCoupon(owner, opts.coupon, NOW);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  }
  if (opts.method) carts.selectShippingMethod(owner, opts.method);
  const idem = `qa-${crypto.randomUUID()}`;
  idemKeys.push(idem);
  const placed = await orders.placeOrderV2(
    {
      sessionId: owner,
      address: {
        fullName: opts.fullName ?? "Ada Lovelace",
        email: "ada.private@example.com",
        line1: "1 Analytical Way",
        city: "London",
        region: "LDN",
        postalCode: "N1 9GU",
        country: "GB",
      },
      card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" },
      idempotencyKey: idem,
      ...(opts.note !== undefined ? { deliveryNote: opts.note } : {}),
    },
    NOW,
  );
  if (!placed.ok) throw new Error(JSON.stringify(placed.error));
  const view = orders.getOrderView(placed.value.id, owner, NOW);
  if (view === null) throw new Error("view");
  return view;
}

let plain: OrderView;
let withCoupon: OrderView;
let freeShip: OrderView;
let hostile: OrderView;
let cancelled: OrderView;
let foreign: OrderView;

beforeAll(async () => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  const pay = createMockPaymentProvider({ latencyMs: 0, now: () => new Date(NOW) });
  orders = createOrderService(db, { now: () => NOW, payments: pay, inFlight: new Map() });
  carts = createCartService(db, { now: () => NOW });
  catalog = db
    .query("SELECT id, price_cents AS price FROM products WHERE stock >= 20 AND published_at <> '' AND published_at <= ? ORDER BY price_cents, id")
    .all("2026-11-07T11:00:00.000Z") as { id: string; price: number }[];
  plain = await place(OWNER, [{ index: 0, qty: 1 }]);
  withCoupon = await place(OWNER, [{ index: 2, qty: 2 }, { index: 3, qty: 1 }], { coupon: "WELCOME10", method: "express", note: `${EVIL} side door` });
  freeShip = await place(OWNER, [{ index: catalog.length - 1, qty: 3 }], { method: "standard" });
  hostile = await place(OWNER, [{ index: 1, qty: 1 }, { index: 0, qty: 2 }], { fullName: `${EVIL} Mallory` });
  const toCancel = await place(OWNER, [{ index: 4, qty: 1 }, { index: 0, qty: 1 }]);
  const c = orders.cancelOrder(toCancel.id, OWNER, NOW + 5 * MIN);
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  cancelled = c.value;
  foreign = await place(OTHER_OWNER, [{ index: 5, qty: 1 }], { fullName: "Other Owner" });
});
afterAll(() => db.close());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse(markup: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${markup}</body>`, "text/html");
}

type FormFn = (formData: FormData) => void | Promise<unknown>;
const noopForm: FormFn = async () => undefined;

function serverLikeForm(name: string): FormFn {
  const formFields = () => ({ name: `$ACTION_REF_${name}`, action: "", encType: "multipart/form-data", method: "POST", data: null });
  return Object.assign(async (): Promise<void> => undefined, { $$FORM_ACTION: formFields });
}
function serverLikeOrderAction(name: string): OrderActionFn {
  const formFields = () => ({ name: `$ACTION_REF_${name}`, action: "", encType: "multipart/form-data", method: "POST", data: null });
  return Object.assign(async (): Promise<OrderActionState> => null, {
    $$FORM_ACTION: formFields,
    bind(): unknown {
      return Object.assign(async () => null, { $$FORM_ACTION: formFields });
    },
  });
}
const noopCancel: OrderActionFn = async () => null;

function listProps(over: Partial<OrdersListProps> = {}): OrdersListProps {
  return {
    orders: orders.listOrders(OWNER, {}, NOW).items,
    tab: "orders",
    range: "3m",
    query: "",
    page: 1,
    pageCount: 1,
    buyAgainProducts: [],
    actions: { buyAgain: noopForm, addToCart: noopForm },
    ...over,
  };
}
function listHtml(over: Partial<OrdersListProps> = {}): Document {
  return parse(renderToStaticMarkup(<OrdersList {...listProps(over)} />));
}

function detailProps(order: OrderDetailOrder, over: Partial<OrderDetailProps> = {}): OrderDetailProps {
  return { order, variant: "detail", buyAgainAction: noopForm, cancelAction: noopCancel, now: NOW, paymentBrand: "Visa", ...over };
}
function detailHtml(order: OrderDetailOrder, over: Partial<OrderDetailProps> = {}): Document {
  return parse(renderToStaticMarkup(<OrderDetail {...detailProps(order, over)} />));
}

function buyAgainProducts(): BuyAgainProduct[] {
  return orders.getBuyAgainLines(OWNER).map((l) => ({
    productId: l.productId,
    slug: l.productSlug ?? "",
    name: l.name,
    imageUrl: l.imageUrl,
    priceCents: l.product?.priceCents ?? 0,
    currency: "USD",
    inStock: l.available,
  }));
}

function placedAtMs(o: OrderView) {
  return Date.parse(o.createdAt);
}

// ===========================================================================
// T94 OrdersList
// ===========================================================================

describe("T94 OrderView fits as is", () => {
  test("type-level + runtime: OrderView is assignable to OrdersListOrder and renders a card per order", () => {
    const fits: OrdersListOrder = plain;
    expect(fits.id).toBe(plain.id);
    const doc = listHtml();
    const page = orders.listOrders(OWNER, {}, NOW);
    expect(page.items.length).toBeGreaterThanOrEqual(5);
    expect(doc.querySelectorAll("article").length).toBe(page.items.length);
    expect(doc.body.textContent).not.toContain("Other Owner");
  });
});

describe("T94.1 tabs + GET filter", () => {
  for (const tab of ["orders", "buy-again", "not-shipped", "cancelled"]) {
    test(`tab=${tab}: 4 tab links in nav "Order views", exactly one aria-current="page"`, () => {
      const doc = listHtml({ tab, buyAgainProducts: buyAgainProducts() });
      const nav = doc.querySelector('nav[aria-label="Order views"]');
      const links = [...(nav?.querySelectorAll("a") ?? [])];
      expect(links.map((a) => a.textContent)).toEqual(["Orders", "Buy Again", "Not Yet Shipped", "Cancelled"]);
      const current = links.filter((a) => a.getAttribute("aria-current") === "page");
      expect(current).toHaveLength(1);
      expect(current[0]?.getAttribute("href")).toBe(buildOrdersHref("/orders", { tab }));
      expect(doc.querySelectorAll('[aria-current="page"]').length).toBe(1);
    });
  }

  test("garbage tab -> 'Orders' is current; tab links keep range but drop q/page", () => {
    const doc = listHtml({ tab: "<script>", range: "1y", query: "mug", page: 3, pageCount: 5 });
    const links = [...doc.querySelectorAll('nav[aria-label="Order views"] a')];
    expect(links.find((a) => a.getAttribute("aria-current") === "page")?.textContent).toBe("Orders");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/orders?range=1y",
      "/orders?tab=buy-again&range=1y",
      "/orders?tab=not-shipped&range=1y",
      "/orders?tab=cancelled&range=1y",
    ]);
  });

  test("search form: GET role=search, select range (5 options, current selected), q maxLength 100, hidden tab", () => {
    const doc = listHtml({ tab: "cancelled", range: "6m", query: "  trail   mug " });
    const form = doc.querySelector('form[role="search"]');
    expect(form).not.toBeNull();
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.getAttribute("action")).toBe("/orders");
    const select = form?.querySelector('select[name="range"]');
    expect([...(select?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"))).toEqual(["30d", "3m", "6m", "1y", "all"]);
    expect(select?.querySelector("option[selected]")?.getAttribute("value")).toBe("6m");
    const q = form?.querySelector('input[name="q"]');
    expect(q?.getAttribute("maxlength")?.toLowerCase() ?? q?.getAttribute("maxLength")).toBe("100");
    expect(q?.getAttribute("value")).toBe("trail mug");
    expect(form?.querySelector('input[type="hidden"][name="tab"]')?.getAttribute("value")).toBe("cancelled");
    // labels associated
    for (const control of form?.querySelectorAll("select, input:not([type=hidden])") ?? []) {
      expect(doc.querySelector(`label[for="${control.id}"]`)).not.toBeNull();
    }
  });

  test("invalid range -> select falls back to 3m", () => {
    const doc = listHtml({ range: "forever" });
    expect(doc.querySelector('select[name="range"] option[selected]')?.getAttribute("value")).toBe("3m");
  });

  test("no search form on Buy Again", () => {
    const doc = listHtml({ tab: "buy-again", buyAgainProducts: buyAgainProducts() });
    expect(doc.querySelector('form[role="search"]')).toBeNull();
    expect(doc.querySelector('input[name="q"]')).toBeNull();
  });
});

describe("T94.4 parse + href tables", () => {
  test("parseOrderTab", () => {
    const rows: [unknown, string][] = [
      ["orders", "orders"], ["buy-again", "buy-again"], ["not-shipped", "not-shipped"], ["cancelled", "cancelled"],
      [undefined, "orders"], [null, "orders"], ["", "orders"], ["CANCELLED", "orders"], ["not_shipped", "orders"],
      [["cancelled", "orders"], "cancelled"], [42, "orders"], [{}, "orders"], ["cancelled ", "orders"],
    ];
    for (const [input, out] of rows) expect(parseOrderTab(input)).toBe(out as ReturnType<typeof parseOrderTab>);
  });

  test("parseOrderRange: invalid -> 3m", () => {
    const rows: [unknown, string][] = [
      ["30d", "30d"], ["3m", "3m"], ["6m", "6m"], ["1y", "1y"], ["all", "all"],
      ["2y", "3m"], ["", "3m"], [undefined, "3m"], ["ALL", "3m"], [3, "3m"], [["1y"], "1y"], ["<x>", "3m"],
    ];
    for (const [input, out] of rows) expect(parseOrderRange(input)).toBe(out as ReturnType<typeof parseOrderRange>);
  });

  test("parseOrderQuery: trimmed, collapsed, control chars dropped, max 100", () => {
    expect(parseOrderQuery("  mug  ")).toBe("mug");
    expect(parseOrderQuery("a\u0000b\tc\n d")).toBe("a b c d");
    expect(parseOrderQuery(undefined)).toBe("");
    expect(parseOrderQuery(123)).toBe("");
    expect(parseOrderQuery("x".repeat(150))).toHaveLength(100);
    expect(parseOrderQuery(` ${"y".repeat(99)} z`).length).toBeLessThanOrEqual(100);
    expect(Array.from(parseOrderQuery("😀".repeat(120)))).toHaveLength(100);
    expect(parseOrderQuery(["first", "second"])).toBe("first");
  });

  test("parseOrderPage: >= 1 integer", () => {
    const rows: [unknown, number][] = [
      ["1", 1], ["2", 2], [3, 3], ["0", 1], ["-1", 1], ["1.5", 1], [1.5, 1], ["abc", 1], ["", 1], [undefined, 1],
      [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], ["1e3", 1], ["9999999999", 1], [["4"], 4], [" 5 ", 5],
    ];
    for (const [input, out] of rows) expect(parseOrderPage(input)).toBe(out);
  });

  test("buildOrdersHref: drops defaults, encodes, strips query/fragment from basePath, disallowed -> /orders", () => {
    expect(buildOrdersHref("/orders")).toBe("/orders");
    expect(buildOrdersHref("/orders", { tab: "orders", range: "3m", q: "", page: 1 })).toBe("/orders");
    expect(buildOrdersHref("/orders", { tab: "cancelled", range: "1y", q: "trail & mug", page: 2 })).toBe(
      "/orders?tab=cancelled&range=1y&q=trail+%26+mug&page=2",
    );
    expect(buildOrdersHref("/orders?tab=x#frag", { page: 2 })).toBe("/orders?page=2");
    expect(buildOrdersHref("https://evil.example/orders", { page: 2 })).toBe("/orders?page=2");
    expect(buildOrdersHref("//evil.example", {})).toBe("/orders");
    expect(buildOrdersHref("javascript:alert(1)", {})).toBe("/orders");
    expect(buildOrdersHref("/orders", { tab: "bogus", range: "bogus", page: "x" })).toBe("/orders");
    const q = buildOrdersHref("/orders", { q: "#?/<>" });
    expect(new URL(q, "http://x").searchParams.get("q")).toBe("#?/<>");
    expect(isAllowedInternalHref(q)).toBe(true);
  });
});

describe("T94 pagination", () => {
  test("pagination nav 'Order pages' preserves tab/range/q", () => {
    const doc = listHtml({ tab: "not-shipped", range: "all", query: "trail mug", page: 2, pageCount: 3 });
    const nav = doc.querySelector('nav[aria-label="Order pages"]');
    expect(nav).not.toBeNull();
    const hrefs = [...(nav?.querySelectorAll("a[href]") ?? [])].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const url = new URL(href, "http://x");
      expect(url.pathname).toBe("/orders");
      expect(url.searchParams.get("tab")).toBe("not-shipped");
      expect(url.searchParams.get("range")).toBe("all");
      expect(url.searchParams.get("q")).toBe("trail mug");
    }
    expect(hrefs.some((h) => h.includes("page=3"))).toBe(true);
  });
});

describe("T94.2 empty states per tab", () => {
  const cases: [string, Partial<OrdersListProps>, string, string[]][] = [
    ["orders", {}, "No orders yet", ["/products"]],
    ["orders filtered", { query: "zzz" }, "No orders found", ["/orders", "/products"]],
    ["not-shipped", { tab: "not-shipped" }, "No orders waiting to ship", ["/orders"]],
    ["cancelled", { tab: "cancelled" }, "No cancelled orders", ["/help/ordering"]],
    ["cancelled filtered", { tab: "cancelled", range: "1y" }, "No cancelled orders", ["/orders?tab=cancelled", "/help/ordering"]],
    ["buy-again", { tab: "buy-again", buyAgainProducts: [] }, "Nothing to buy again yet", ["/products"]],
  ];
  for (const [name, over, title, hrefs] of cases) {
    test(`${name}: '${title}' with next-step links`, () => {
      const doc = listHtml({ orders: [], ...over });
      expect(doc.body.textContent).toContain(title);
      const links = [...doc.querySelectorAll("section a[href]")]
        .filter((a) => a.closest("nav") === null)
        .map((a) => a.getAttribute("href"));
      expect(links).toEqual(hrefs);
      expect(doc.querySelectorAll("article")).toHaveLength(0);
      expect(doc.querySelector('nav[aria-label="Order pages"]')).toBeNull();
    });
  }
});

describe("T94.3 Buy Again grid", () => {
  test("each product once (dedupe by productId), form posts productId + quantity=1 only", async () => {
    const products = buyAgainProducts();
    const dupes = [...products, ...products.map((p) => ({ ...p, name: `${p.name} (dup)` }))];
    expect(dedupeBuyAgainProducts(dupes)).toHaveLength(products.length);
    const posts: [string, string][][] = [];
    const addToCart: FormFn = async (fd) => {
      posts.push([...fd.entries()].map(([k, v]) => [k, String(v)]));
    };
    render(<OrdersList {...listProps({ tab: "buy-again", buyAgainProducts: dupes, actions: { buyAgain: noopForm, addToCart } })} />);
    const grid = screen.getByRole("list", { name: "Products to buy again" });
    const cards = within(grid).getAllByRole("listitem");
    expect(cards).toHaveLength(products.length);
    expect(grid.textContent).not.toContain("(dup)");
    const first = within(cards[0] as HTMLElement).getByRole("button", { name: /Add to cart/ });
    const form = first.closest("form");
    if (form === null) throw new Error("no form");
    fireEvent.submit(form);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.filter(([k]) => !k.startsWith("$"))).toEqual([
      ["productId", products[0]?.productId ?? ""],
      ["quantity", "1"],
    ]);
  });

  test("add-to-cart buttons have unique accessible names (product name)", () => {
    render(<OrdersList {...listProps({ tab: "buy-again", buyAgainProducts: buyAgainProducts() })} />);
    const names = screen.getAllByRole("button", { name: /Add to cart/ }).map((b) => b.textContent);
    expect(new Set(names).size).toBe(names.length);
  });

  test("out of stock -> 'Out of stock' text and no form; static markup POST multipart for server action", () => {
    const products = buyAgainProducts();
    const oos = products.map((p, i) => (i === 0 ? { ...p, inStock: false } : p));
    const doc = parse(
      renderToStaticMarkup(<OrdersList {...listProps({ tab: "buy-again", buyAgainProducts: oos, actions: { buyAgain: noopForm, addToCart: serverLikeForm("add") } })} />),
    );
    const items = [...doc.querySelectorAll('ul[aria-label="Products to buy again"] > li')];
    expect(items[0]?.querySelector("form")).toBeNull();
    expect(items[0]?.textContent).toContain("Out of stock");
    const forms = [...doc.querySelectorAll("form")];
    expect(forms).toHaveLength(products.length - 1);
    for (const f of forms) {
      expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(f.getAttribute("enctype")).toBe("multipart/form-data");
      expect(f.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
    }
  });

  test("hostile buy-again name / slug render as text, link only for allowed slugs", () => {
    const p: BuyAgainProduct = { productId: "p-1", slug: "../../admin", name: EVIL, imageUrl: null, priceCents: 999, currency: "USD", inStock: true };
    const markup = renderToStaticMarkup(<OrdersList {...listProps({ tab: "buy-again", buyAgainProducts: [p] })} />);
    const doc = parse(markup);
    expect(doc.querySelector("img[src=x]")).toBeNull();
    expect(doc.body.textContent).toContain(EVIL);
    for (const a of doc.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });
});

describe("T94 order cards, hostile text, hrefs, landmarks", () => {
  test("hostile ship-to name renders as text; no email/owner key/idempotency key in markup", () => {
    const markup = renderToStaticMarkup(<OrdersList {...listProps()} />);
    const doc = parse(markup);
    expect(doc.querySelector("img[src=x]")).toBeNull();
    expect(doc.body.textContent).toContain(`${EVIL} Mallory`);
    expect(markup).not.toContain("ada.private@example.com");
    expect(markup).not.toContain(OWNER);
    for (const k of idemKeys) expect(markup).not.toContain(k);
    const allowed = new Set<string>();
    for (const o of orders.listOrders(OWNER, {}, NOW).items) {
      allowed.add(o.id);
      for (const i of o.items) allowed.add(i.productId);
    }
    for (const u of (markup.match(UUID) ?? []).map((x) => x.toLowerCase())) expect(allowed.has(u)).toBe(true);
  });

  test("every href passes isAllowedInternalHref (orders tab, buy-again tab, empty states)", () => {
    for (const over of [{}, { tab: "buy-again", buyAgainProducts: buyAgainProducts() }, { orders: [], query: "x" }, { page: 2, pageCount: 4 }] as Partial<OrdersListProps>[]) {
      const doc = listHtml(over);
      for (const a of doc.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
  });

  test("OrderCard buy-again forms post orderId (POST multipart with server action)", () => {
    const doc = parse(renderToStaticMarkup(<OrdersList {...listProps({ actions: { buyAgain: serverLikeForm("ba"), addToCart: noopForm } })} />));
    const forms = [...doc.querySelectorAll("article form")];
    expect(forms.length).toBeGreaterThan(0);
    for (const f of forms) {
      expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(f.getAttribute("enctype")).toBe("multipart/form-data");
      expect(f.querySelector('input[name="orderId"]')).not.toBeNull();
    }
  });

  test("landmarks: one labelled section, nav 'Order views', nav 'Order pages', one search; h1 then h2 cards", () => {
    render(<OrdersList {...listProps({ page: 1, pageCount: 2 })} />);
    expect(screen.getByRole("region", { name: "Your orders" })).toBeTruthy();
    expect(screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"))).toEqual(["Order views", "Order pages"]);
    expect(screen.getAllByRole("search")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 }).length).toBeGreaterThan(0);
  });

  test("headingLevel=2 shifts cards to h3", () => {
    render(<OrdersList {...listProps({ headingLevel: 2 })} />);
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 2, name: "Your orders" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(0);
  });

  test("keyboard: tabs, filters and card actions are natively focusable; touch-target classes on tab links", () => {
    const doc = listHtml();
    for (const a of doc.querySelectorAll('nav[aria-label="Order views"] a')) expect(a.className).toContain("min-h-touch");
    for (const el of doc.querySelectorAll("a, button, input, select")) expect(el.getAttribute("tabindex")).not.toBe("-1");
  });

  test("money via shared formatter with the order currency (EUR card total)", () => {
    const eur = { ...plain, currency: "EUR" };
    const doc = listHtml({ orders: [eur] });
    expect(doc.body.textContent).toMatch(/€/);
  });
});

// ===========================================================================
// T95 OrderDetail
// ===========================================================================

describe("T95.1 confirmation vs detail", () => {
  test("confirmation: 'Order placed' heading + estimated delivery", () => {
    render(<OrderDetail {...detailProps(plain, { variant: "confirmation" })} />);
    expect(screen.getByRole("heading", { level: 1, name: /Order placed/ })).toBeTruthy();
    expect(plain.estimatedDelivery).not.toBeNull();
    expect(document.body.textContent).toMatch(/Estimated delivery: \w+/);
    expect(document.body.textContent).toContain(plain.id);
  });

  test("detail: no celebration copy (no 'Order placed' heading, no thank-you), 'Order # id' heading", () => {
    render(<OrderDetail {...detailProps(plain)} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(`Order # ${plain.id}`);
    expect(screen.queryByRole("heading", { name: /Order placed/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Thank you/i);
  });
});

describe("T95.2 cancel form", () => {
  test("cancellable + minutes left: form with hidden orderId, required confirm=yes checkbox, submit; window text", () => {
    const now = placedAtMs(plain) + 5 * MIN;
    const doc = detailHtml(plain, { now, cancelAction: serverLikeOrderAction("cancel") });
    const form = [...doc.querySelectorAll("form")].find((f) => f.querySelector('input[name="confirm"]'));
    expect(form).toBeDefined();
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(form?.querySelector('input[type="hidden"][name="orderId"]')?.getAttribute("value")).toBe(plain.id);
    const box = form?.querySelector('input[type="checkbox"][name="confirm"]');
    expect(box?.getAttribute("value")).toBe("yes");
    expect(box?.hasAttribute("required")).toBe(true);
    expect(doc.querySelector(`label[for="${box?.id}"]`) ?? box?.closest("label")).not.toBeNull();
    expect(form?.querySelector('button[type="submit"]')?.textContent).toContain("Cancel order");
    expect(doc.body.textContent).toContain("You can cancel for 25 more minutes.");
  });

  const hidden: [string, () => Partial<OrderDetailProps> & { order?: OrderView }][] = [
    ["less than a minute left", () => ({ now: placedAtMs(plain) + 29 * MIN + 30_000 })],
    ["window over", () => ({ now: placedAtMs(plain) + 31 * MIN })],
    ["cancellable=false", () => ({ order: { ...plain, cancellable: false, cancellableUntil: null } })],
    ["now NaN", () => ({ now: Number.NaN })],
    ["now Infinity", () => ({ now: Number.POSITIVE_INFINITY })],
    ["now -Infinity", () => ({ now: Number.NEGATIVE_INFINITY })],
    ["already cancelled", () => ({ order: cancelled })],
    ["no cancelAction", () => ({ cancelAction: undefined })],
  ];
  for (const [name, make] of hidden) {
    test(`no cancel form: ${name}`, () => {
      const { order, ...rest } = make();
      const doc = detailHtml(order ?? plain, { now: placedAtMs(plain) + 5 * MIN, ...rest });
      expect(doc.querySelector('input[name="confirm"]')).toBeNull();
      expect(doc.body.textContent).not.toMatch(/You can cancel for/);
    });
  }

  test("cancelMinutesLeft: placedAt + 30 min floored, clamped by cancellableUntil, 0..30", () => {
    const placed = "2026-11-07T10:00:00.000Z";
    const p = Date.parse(placed);
    expect(cancelMinutesLeft(placed, p)).toBe(30);
    expect(cancelMinutesLeft(placed, p + 59_999)).toBe(29);
    expect(cancelMinutesLeft(placed, p + 29 * MIN)).toBe(1);
    expect(cancelMinutesLeft(placed, p + 29 * MIN + 1)).toBe(0);
    expect(cancelMinutesLeft(placed, p - 60 * MIN)).toBe(30);
    expect(cancelMinutesLeft(placed, p + 2 * MIN, "2026-11-07T10:10:00.000Z")).toBe(8);
    expect(cancelMinutesLeft(placed, p + 2 * MIN, "2026-11-07T11:00:00.000Z")).toBe(28);
    expect(cancelMinutesLeft(placed, p, "garbage")).toBe(30);
    expect(cancelMinutesLeft("garbage", p)).toBe(0);
    expect(cancelMinutesLeft(placed, Number.NaN)).toBe(0);
  });

  test("window text singular", () => {
    const doc = detailHtml(plain, { now: placedAtMs(plain) + 29 * MIN });
    expect(doc.body.textContent).toContain("You can cancel for 1 more minute.");
  });

  test("cancelState success -> role=status message, no form", () => {
    render(<OrderDetail {...detailProps(plain, { now: placedAtMs(plain) + 5 * MIN, cancelState: { ok: true, kind: "cancelled", message: "Order cancelled." } })} />);
    expect(screen.getAllByRole("status").some((s) => s.textContent?.includes("Order cancelled."))).toBe(true);
    expect(screen.queryByRole("checkbox", { name: /cancel this order/ })).toBeNull();
  });

  test("cancelState error -> role=alert message (form still offered while in window)", () => {
    const state: OrderActionState = {
      ok: false,
      error: { code: "ORDER_NOT_CANCELLABLE", message: "This order can no longer be cancelled." },
      message: "This order can no longer be cancelled.",
    };
    render(<OrderDetail {...detailProps(plain, { now: placedAtMs(plain) + 5 * MIN, cancelState: state })} />);
    expect(screen.getByRole("alert").textContent).toContain("This order can no longer be cancelled.");
    expect(screen.getByRole("checkbox", { name: /cancel this order/ })).toBeTruthy();
  });

  test("cancel form posts orderId + confirm=yes when ticked (JS path)", async () => {
    const posts: [string, string][][] = [];
    const cancelAction: OrderActionFn = async (_prev, fd) => {
      posts.push([...fd.entries()].map(([k, v]) => [k, String(v)]));
      return { ok: true, kind: "cancelled", message: "Order cancelled." };
    };
    render(<OrderDetail {...detailProps(plain, { now: placedAtMs(plain) + 5 * MIN, cancelAction })} />);
    const box = screen.getByRole("checkbox", { name: /cancel this order/ });
    fireEvent.click(box);
    const form = box.closest("form");
    if (form === null) throw new Error("no form");
    fireEvent.submit(form);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.filter(([k]) => !k.startsWith("$"))).toEqual([["orderId", plain.id], ["confirm", "yes"]]);
    await waitFor(() => expect(screen.getAllByRole("status").some((s) => s.textContent?.includes("Order cancelled."))).toBe(true));
  });
});

describe("T95.3 print invoice link", () => {
  test("plain <a href=/orders/<id>/invoice>, no form/button", () => {
    const doc = detailHtml(plain);
    const links = [...doc.querySelectorAll("a")].filter((a) => a.textContent?.includes("Print invoice"));
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(`/orders/${plain.id}/invoice`);
    expect(links[0]?.closest("form")).toBeNull();
    expect(links[0]?.hasAttribute("target")).toBe(false);
  });

  test("hostile order id never yields a disallowed href", () => {
    for (const id of ["../../admin", "x/../../y", "//evil", "a?b#c", EVIL]) {
      const doc = detailHtml({ ...plain, id });
      for (const a of doc.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
  });

  test("DEFECT D-T95-1: declined (payment_failed) order shows no invoice link", () => {
    const doc = detailHtml({ ...plain, status: "payment_failed" });
    expect([...doc.querySelectorAll("a")].some((a) => a.textContent?.includes("Print invoice"))).toBe(false);
  });
});

describe("T95.4 payment: last4 only", () => {
  test("'Visa ending in 4242' with brand; 'Card ending in 4242' without; unknown brand -> Card", () => {
    expect(detailHtml(plain).body.textContent).toContain("Visa ending in 4242");
    expect(detailHtml(plain, { paymentBrand: null }).body.textContent).toContain("Card ending in 4242");
    expect(paymentLabel("4242", "<b>Evil</b>")).toBe("Card ending in 4242");
    expect(paymentLabel("4242", "Mastercard")).toBe("Mastercard ending in 4242");
  });

  test("normaliseLast4: exactly 4 ASCII digits", () => {
    const rows: [unknown, string | null][] = [
      ["4242", "4242"], ["0000", "0000"], ["4242424242424242", null], ["abcd", null], ["４２４２", null],
      [" 4242", null], ["4242 ", null], ["424", null], ["42424", null], [4242, null], [null, null], ["٤٢٤٢", null], ["4242\n", null],
    ];
    for (const [input, out] of rows) expect(normaliseLast4(input)).toBe(out);
  });

  test("a PAN in cardLast4 is never rendered", () => {
    const doc = detailHtml({ ...plain, cardLast4: MOCK_CARDS.success });
    expect(doc.body.textContent).not.toContain(MOCK_CARDS.success);
    expect(doc.body.textContent).toContain("Card details unavailable");
  });

  test("type-level: no card number / cvc / expiry key on the props; smuggled keys never render", () => {
    type Forbidden = "cardNumber" | "number" | "cvc" | "cvv" | "expiry" | "expMonth" | "expYear" | "email" | "sessionId" | "ownerKey";
    const none: Extract<keyof OrderDetailOrder | keyof OrderDetailProps, Forbidden> extends never ? true : false = true;
    expect(none).toBe(true);
    const smuggled = { ...plain, cardNumber: "4111111111111111", cvc: "737", expMonth: 12, expYear: 2031, expiry: "12/31", sessionId: OWNER };
    const markup = renderToStaticMarkup(<OrderDetail {...detailProps(smuggled)} />);
    for (const s of ["4111111111111111", "737", "12/31", "2031", OWNER, MOCK_CARDS.success, "987"]) expect(markup).not.toContain(s);
  });
});

describe("T95.5 refund notice", () => {
  test("real cancelled order: refund of $X to the card ending in 4242 is pending, simulated", () => {
    const doc = detailHtml(cancelled);
    const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cancelled.totalCents / 100);
    const text = doc.body.textContent ?? "";
    expect(text).toContain(`A refund of ${amount} to the card ending in 4242 is pending.`);
    expect(text).toMatch(/simulated/);
    expect(text).toContain("This order was cancelled on");
    expect(text).not.toMatch(/Estimated delivery:/);
  });

  test("total 0 -> nothing to refund; not cancelled -> no refund section", () => {
    expect(refundNoticeText(0, "USD", "4242")).toMatch(/nothing to refund/);
    expect(detailHtml({ ...cancelled, totalCents: 0 }).body.textContent).toMatch(/nothing to refund/);
    expect(detailHtml(plain).body.textContent).not.toMatch(/refund/i);
  });

  test("invalid amount / last4 never render NaN or a PAN", () => {
    expect(refundNoticeText(Number.NaN, "USD", "4242")).toBe("A refund to the card ending in 4242 is pending. Payments in this store are simulated, so no money is moved.");
    expect(refundNoticeText(500, "USD", "4111111111111111")).not.toContain("4111");
    expect(refundNoticeText(500, "XXX-bad", "4242")).not.toContain("NaN");
  });
});

describe("T95 items, summary, privacy, hostile text", () => {
  test("items: name link /products/<slug>, per-item Buy it again form (orderId + productId), review + help links", () => {
    const doc = detailHtml(withCoupon, { buyAgainAction: serverLikeForm("ba") });
    const section = [...doc.querySelectorAll("section")].find((s) => s.querySelector("h2")?.textContent === "Items");
    const items = [...(section?.querySelectorAll(":scope > ul > li") ?? [])];
    expect(items).toHaveLength(withCoupon.items.length);
    items.forEach((li, i) => {
      const item = withCoupon.items[i]!;
      expect(li.querySelector("p a")?.getAttribute("href")).toBe(`/products/${item.productSlug}`);
      const form = li.querySelector("form");
      expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
      expect(form?.querySelector('input[name="orderId"]')?.getAttribute("value")).toBe(withCoupon.id);
      expect(form?.querySelector('input[name="productId"]')?.getAttribute("value")).toBe(item.productId);
      const hrefs = [...li.querySelectorAll("a")].map((a) => a.getAttribute("href"));
      expect(hrefs).toContain(`/products/${item.productSlug}#write-review`);
      expect(hrefs).toContain(`/contact?topic=ordering&order=${withCoupon.id}`);
    });
  });

  test("per-item Buy it again posts orderId + productId (JS path), buttons uniquely named", async () => {
    const posts: [string, string][][] = [];
    const buyAgainAction: FormFn = async (fd) => {
      posts.push([...fd.entries()].map(([k, v]) => [k, String(v)]));
    };
    render(<OrderDetail {...detailProps(withCoupon, { buyAgainAction })} />);
    const buttons = screen.getAllByRole("button", { name: /Buy it again/ });
    expect(new Set(buttons.map((b) => b.textContent)).size).toBe(buttons.length);
    const form = buttons[1]?.closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.filter(([k]) => !k.startsWith("$"))).toEqual([["orderId", withCoupon.id], ["productId", withCoupon.items[1]!.productId]]);
  });

  test("item without slug: name as text, no review link", () => {
    const o = { ...plain, items: plain.items.map((i) => ({ ...i, productSlug: null })) };
    const doc = detailHtml(o);
    expect([...doc.querySelectorAll("a")].some((a) => a.textContent?.includes("Write a review"))).toBe(false);
    expect(doc.body.textContent).toContain(plain.items[0]!.name);
  });

  for (const [name, get] of [["plain", () => plain], ["coupon + express + note", () => withCoupon], ["free standard shipping", () => freeShip], ["cancelled", () => cancelled]] as [string, () => OrderView][]) {
    test(`OrderSummary invoice gets server totals -> data-total-check=match (${name})`, () => {
      const doc = detailHtml(get());
      const summary = doc.querySelector('section[data-total-check]');
      expect(summary?.getAttribute("data-total-check")).toBe("match");
      expect(summary?.getAttribute("data-variant")).toBe("invoice");
      expect(doc.body.textContent).not.toContain("NaN");
    });
  }

  test("free-shipping order shows 'Free' in the summary; coupon order shows discount row", () => {
    expect(freeShip.shippingCents).toBe(0);
    expect(detailHtml(freeShip).body.textContent).toMatch(/Free/);
    expect(withCoupon.discountCents).toBeGreaterThan(0);
    expect(detailHtml(withCoupon).body.textContent).toContain("Discount (WELCOME10)");
  });

  test("money via shared formatter + currency (EUR)", () => {
    expect(detailHtml({ ...plain, currency: "EUR" }).body.textContent).toMatch(/€/);
  });

  test("no owner key / session id / email / idempotency key / card data in markup; UUIDs only order + product ids", () => {
    for (const o of [plain, withCoupon, hostile, cancelled]) {
      const markup = renderToStaticMarkup(<OrderDetail {...detailProps(o, { variant: "confirmation", now: placedAtMs(o) + 5 * MIN })} />);
      expect(markup).not.toContain(OWNER);
      expect(markup).not.toContain("ada.private@example.com");
      expect(markup).not.toContain(MOCK_CARDS.success);
      for (const k of idemKeys) expect(markup).not.toContain(k);
      const allowed = new Set([o.id, ...o.items.map((i) => i.productId)].map((x) => x.toLowerCase()));
      for (const u of (markup.match(UUID) ?? []).map((x) => x.toLowerCase())) expect(allowed.has(u)).toBe(true);
    }
  });

  test("OrderView no longer exposes idempotencyKey (consistency ag, FIX-orders-pages) — and no key ever renders", () => {
    expect("idempotencyKey" in plain).toBe(false);
    const markup = renderToStaticMarkup(<OrderDetail {...detailProps(plain)} />);
    for (const k of idemKeys) expect(markup).not.toContain(k);
  });

  test("hostile text (ship-to, item name, delivery note, coupon, method) renders as text", () => {
    const o: OrderView = {
      ...hostile,
      items: hostile.items.map((i) => ({ ...i, name: `${EVIL} ${i.name}` })),
      deliveryNote: EVIL,
      couponCode: EVIL,
      shippingMethodName: EVIL,
      address: { ...hostile.address, line1: EVIL, city: EVIL },
    };
    const markup = renderToStaticMarkup(<OrderDetail {...detailProps(o)} />);
    const doc = parse(markup);
    expect(doc.querySelector("img[src=x]")).toBeNull();
    expect(markup).not.toContain("<img src=x");
    expect(doc.querySelector("address")?.textContent).toContain(`${EVIL} Mallory`);
    expect(doc.querySelector("address")?.textContent).not.toContain("ada.private@example.com");
  });

  test("no nested forms; every href allowed; unique ids; heading levels h1 -> h2", () => {
    const doc = detailHtml(withCoupon, { now: placedAtMs(withCoupon) + 5 * MIN });
    const forms = [...doc.querySelectorAll("form")];
    expect(forms.length).toBe(withCoupon.items.length + 1);
    for (const f of forms) expect(f.parentElement?.closest("form") ?? null).toBeNull();
    for (const a of doc.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    const ids = [...doc.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.querySelectorAll("h2").length).toBeGreaterThan(2);
  });

  test("touch targets: action links and buttons carry min-h-touch", () => {
    const doc = detailHtml(withCoupon, { now: placedAtMs(withCoupon) + 5 * MIN });
    for (const b of doc.querySelectorAll("button")) expect(b.className).toContain("min-h-touch");
    for (const a of [...doc.querySelectorAll("a")].filter((x) => /Write a review|Get help|Print invoice/.test(x.textContent ?? ""))) {
      expect(a.className).toContain("min-h-touch");
    }
  });

  test("another owner's order is not reachable through the service (getOrderView null) — UI never sees it", () => {
    expect(orders.getOrderView(foreign.id, OWNER, NOW)).toBeNull();
    expect(orders.listOrders(OWNER, { range: "all" }, NOW).items.some((o) => o.id === foreign.id)).toBe(false);
  });
});

// ===========================================================================
// Cross-cutting
// ===========================================================================

describe("cross-cutting: CartSummary + OrdersList + OrderDetail on one page", () => {
  test("unique landmarks and ids", () => {
    const cartNoop: CartActionFnV2 = async () => ok({ itemCount: 0, subtotalCents: 0, message: "" });
    const sid = crypto.randomUUID();
    carts.addItem(sid, catalog[0]!.id, 1);
    const view = carts.getCartView(sid, NOW);
    if (!view.ok) throw new Error("view");
    render(
      <main>
        <CartSummary cart={view.value} actions={{ applyCoupon: cartNoop, removeCoupon: cartNoop, setShippingMethod: cartNoop }} now={NOW} />
        <OrdersList {...listProps({ page: 1, pageCount: 2 })} />
        <OrderDetail {...detailProps(withCoupon, { headingLevel: 2, now: placedAtMs(withCoupon) + 5 * MIN })} />
      </main>,
    );
    const navs = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(new Set(navs).size).toBe(navs.length);
    expect(screen.getAllByRole("search")).toHaveLength(1);
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const regionNames = screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"));
    expect(new Set(regionNames).size).toBe(regionNames.length);
  });
});

describe("source hygiene (T94/T95)", () => {
  const files = [
    "OrdersList/OrdersList.tsx", "OrdersList/orders-list-model.ts", "OrdersList/index.ts",
    "OrderDetail/OrderDetail.tsx", "OrderDetail/CancelOrderForm.tsx", "OrderDetail/order-detail-model.ts", "OrderDetail/index.ts",
  ];
  test("no any / ts-ignore / ts-expect-error / eslint-disable / dangerouslySetInnerHTML / style= / wall clock / runtime server imports", () => {
    for (const file of files) {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src).not.toMatch(/@ts-ignore|@ts-expect-error|eslint-disable/);
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/style=\{/);
      expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")).not.toMatch(/Date\.now\(|new Date\(\)/);
      for (const line of src.split("\n").filter((l) => /from "@\/server\//.test(l))) expect(line).toMatch(/^import type /);
    }
  });
});
