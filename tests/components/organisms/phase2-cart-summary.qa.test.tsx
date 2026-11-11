// QA (QA-W4-organisms-F): T92 CartSummary.
// Fixtures come from the REAL cart service (`getCartView`) on a seeded
// `:memory:` DB, so totals are exactly what the page will pass.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Database } from "bun:sqlite";
import { isAllowedInternalHref } from "@/content/routes";
import { ok } from "@/lib/result";
import type { CartActionFnV2, CartActionStateV2 } from "@/components/molecules/_contracts/cart-actions";
import { OrderSummary } from "@/components/organisms/OrderSummary";
import {
  CHECKOUT_BLOCKED_TEXT,
  CartSummary,
  checkoutState,
  itemCountLabel,
  toOrderSummaryItems,
  type CartSummaryActions,
  type CartSummaryCart,
} from "@/components/organisms/CartSummary";
import { createCartService, type CartServiceV2, type CartViewV2 } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { expectFocused } from "@/test/dom-assertions";

const DIR = join(import.meta.dir, "../../../src/components/organisms/CartSummary");
const NOW = Date.parse("2026-11-07T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Real-service fixtures
// ---------------------------------------------------------------------------

let db: Database;
let carts: CartServiceV2;
let catalog: { id: string; price: number; stock: number }[] = [];

beforeAll(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  carts = createCartService(db, { now: () => NOW });
  catalog = db
    .query(
      "SELECT id, price_cents AS price, stock FROM products WHERE stock >= 12 AND published_at <> '' AND published_at <= ? ORDER BY price_cents, id",
    )
    .all("2026-11-07T11:00:00.000Z") as { id: string; price: number; stock: number }[];
});
afterAll(() => db.close());

function product(i: number) {
  const p = catalog[i];
  if (p === undefined) throw new Error(`catalog too small: ${catalog.length}`);
  return p;
}
function priciest() {
  return product(catalog.length - 1);
}

interface Spec {
  lines: { index: number | "max"; qty: number; stock?: number }[];
  coupon?: string;
  method?: string;
  save?: number;
}

function setStock(id: string, stock: number) {
  db.query("UPDATE products SET stock = ? WHERE id = ?").run(stock, id);
}

/** Builds a cart through the real service, applies stock edits, returns `getCartView`. Restores stock. */
function buildView(spec: Spec): CartViewV2 {
  const sid = crypto.randomUUID();
  const edits: { id: string; stock: number }[] = [];
  for (const line of spec.lines) {
    const p = line.index === "max" ? priciest() : product(line.index);
    const added = carts.addItem(sid, p.id, line.qty);
    if (!added.ok) throw new Error(`addItem ${p.id}: ${JSON.stringify(added.error)}`);
    if (line.stock !== undefined) edits.push({ id: p.id, stock: line.stock });
  }
  if (spec.save !== undefined) {
    const p = product(spec.save);
    if (!carts.addItem(sid, p.id, 1).ok) throw new Error("save add");
    if (!carts.saveForLater(sid, p.id).ok) throw new Error("save");
  }
  if (spec.coupon !== undefined) {
    const r = carts.applyCoupon(sid, spec.coupon, NOW);
    if (!r.ok) throw new Error(`coupon ${spec.coupon}: ${JSON.stringify(r.error)}`);
  }
  if (spec.method !== undefined) {
    const r = carts.selectShippingMethod(sid, spec.method);
    if (!r.ok) throw new Error(`method ${spec.method}`);
  }
  const original = edits.map((e) => ({ id: e.id, stock: catalog.find((c) => c.id === e.id)?.stock ?? 0 }));
  for (const e of edits) setStock(e.id, e.stock);
  try {
    const view = carts.getCartView(sid, NOW);
    if (!view.ok) throw new Error(JSON.stringify(view.error));
    return view.value;
  } finally {
    for (const e of original) setStock(e.id, e.stock);
  }
}

function emptyView(over: Partial<CartViewV2> = {}): CartViewV2 {
  const view = carts.getCartView(crypto.randomUUID(), NOW);
  if (!view.ok) throw new Error("empty view");
  return { ...view.value, ...over };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const success: CartActionStateV2 = ok({ itemCount: 1, subtotalCents: 0, message: "Updated" });

function recorder() {
  const posts: { action: string; fields: [string, string][] }[] = [];
  const make =
    (action: string): CartActionFnV2 =>
    async (_prev, formData) => {
      posts.push({ action, fields: [...formData.entries()].map(([k, v]) => [k, String(v)]) });
      return success;
    };
  const actions: CartSummaryActions = {
    applyCoupon: make("applyCoupon"),
    removeCoupon: make("removeCoupon"),
    setShippingMethod: make("setShippingMethod"),
  };
  return { posts, actions };
}

const noop: CartActionFnV2 = async () => success;
const ACTIONS: CartSummaryActions = { applyCoupon: noop, removeCoupon: noop, setShippingMethod: noop };

/** What a Next server reference exposes to React SSR (`$$FORM_ACTION`), kept across `.bind`. */
function serverLike(name: string): CartActionFnV2 {
  const formFields = () => ({ name: `$ACTION_REF_${name}`, action: "", encType: "multipart/form-data", method: "POST", data: null });
  return Object.assign(async (): Promise<CartActionStateV2> => null, {
    $$FORM_ACTION: formFields,
    bind(): unknown {
      return Object.assign(async () => null, { $$FORM_ACTION: formFields });
    },
  });
}
const SERVER_ACTIONS: CartSummaryActions = {
  applyCoupon: serverLike("apply"),
  removeCoupon: serverLike("remove"),
  setShippingMethod: serverLike("ship"),
};

function html(cart: CartSummaryCart, props: Partial<Parameters<typeof CartSummary>[0]> = {}): string {
  return renderToStaticMarkup(<CartSummary cart={cart} actions={ACTIONS} now={NOW} {...props} />);
}
function parse(markup: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${markup}</body>`, "text/html");
}
function checkoutLinks(doc: Document | HTMLElement): HTMLAnchorElement[] {
  return [...doc.querySelectorAll("a")].filter((a) => /Proceed to checkout/.test(a.textContent ?? ""));
}

// ---------------------------------------------------------------------------

describe("T92 fixture sanity", () => {
  test("seeded catalogue has enough products and the shipping methods the tests rely on", () => {
    expect(catalog.length).toBeGreaterThanOrEqual(6);
    const v = buildView({ lines: [{ index: 0, qty: 1 }] });
    expect(v.shippingOptions.map((o) => o.method.id)).toEqual(["standard", "express", "next_day"]);
    expect(v.canCheckout).toBe(true);
  });
});

describe("T92.1 empty / blocked / allowed", () => {
  test("no lines AND nothing saved -> renders nothing (static + DOM)", () => {
    expect(html(emptyView())).toBe("");
    const { container } = render(<CartSummary cart={emptyView()} actions={ACTIONS} now={NOW} />);
    expect(container.innerHTML).toBe("");
  });

  test("saved-only cart renders the panel, 'Subtotal (0 items)', reason text, no forms, no checkout link", () => {
    const view = buildView({ lines: [], save: 1 });
    expect(view.items).toHaveLength(0);
    expect(view.saved).toHaveLength(1);
    const doc = parse(html(view));
    const aside = doc.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside?.textContent).toContain("Subtotal (0 items)");
    expect(doc.querySelectorAll("form")).toHaveLength(0);
    expect(checkoutLinks(doc)).toHaveLength(0);
    expect(doc.querySelector('[data-testid="cart-summary-blocked"]')?.textContent).toBe(CHECKOUT_BLOCKED_TEXT.empty);
  });

  const blockedCases: [string, () => CartViewV2, string][] = [
    ["some out of stock", () => buildView({ lines: [{ index: 0, qty: 1 }, { index: 1, qty: 1, stock: 0 }] }), CHECKOUT_BLOCKED_TEXT.someUnavailable],
    ["all out of stock", () => buildView({ lines: [{ index: 0, qty: 2, stock: 0 }, { index: 1, qty: 1, stock: 0 }] }), CHECKOUT_BLOCKED_TEXT.allUnavailable],
    ["reduced quantity (stock < qty)", () => buildView({ lines: [{ index: 0, qty: 5, stock: 2 }] }), CHECKOUT_BLOCKED_TEXT.reduced],
    ["canCheckout=false with ok lines", () => ({ ...buildView({ lines: [{ index: 0, qty: 1 }] }), canCheckout: false }), CHECKOUT_BLOCKED_TEXT.unknown],
  ];
  for (const [name, make, reason] of blockedCases) {
    test(`blocked: ${name} -> no checkout link/button, reason as text`, () => {
      const view = make();
      const doc = parse(html(view));
      expect(checkoutLinks(doc)).toHaveLength(0);
      expect([...doc.querySelectorAll("button")].some((b) => /checkout/i.test(b.textContent ?? ""))).toBe(false);
      expect(doc.querySelector('[data-testid="cart-summary-blocked"]')?.textContent).toBe(reason);
      expect(doc.querySelector("aside")?.getAttribute("data-can-checkout")).toBe("false");
      expect(checkoutState(view).canCheckout).toBe(false);
    });
  }

  test("reduced line is visible as 'reduced' in the real view (rule source check)", () => {
    const view = buildView({ lines: [{ index: 0, qty: 5, stock: 2 }] });
    expect(view.items[0]?.status).not.toBe("ok");
  });

  test("allowed -> exactly one 'Proceed to checkout' link to /checkout and no blocked text", () => {
    const doc = parse(html(buildView({ lines: [{ index: 0, qty: 1 }, { index: 1, qty: 2 }] })));
    const links = checkoutLinks(doc);
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/checkout");
    expect(doc.querySelector('[data-testid="cart-summary-blocked"]')).toBeNull();
    expect(doc.querySelector("aside")?.getAttribute("data-can-checkout")).toBe("true");
  });

  test("valid custom checkoutHref is used", () => {
    const doc = parse(html(buildView({ lines: [{ index: 0, qty: 1 }] }), { checkoutHref: "/checkout?step=address" }));
    expect(checkoutLinks(doc)[0]?.getAttribute("href")).toBe("/checkout?step=address");
  });

  const hostile = ["javascript:alert(1)", "//evil.example", "https://evil.example/checkout", "/\\evil.example", "", " /checkout", "data:text/html,x", "JaVaScRiPt:alert(1)"];
  for (const href of hostile) {
    test(`hostile checkoutHref ${JSON.stringify(href)} -> /checkout`, () => {
      const doc = parse(html(buildView({ lines: [{ index: 0, qty: 1 }] }), { checkoutHref: href }));
      expect(checkoutLinks(doc)[0]?.getAttribute("href")).toBe("/checkout");
    });
  }
});

describe("T92.2 forms round-trip without JS (separate, not nested)", () => {
  function assertForms(markup: string, count: number) {
    const doc = parse(markup);
    const forms = [...doc.querySelectorAll("form")];
    expect(forms).toHaveLength(count);
    for (const f of forms) expect(f.parentElement?.closest("form") ?? null).toBeNull();
    expect(doc.querySelector("aside")?.closest("form") ?? null).toBeNull();
    return { doc, forms };
  }

  test("no coupon + shipping options -> 2 forms (apply + shipping), POST multipart with server actions", () => {
    const { forms } = assertForms(html(buildView({ lines: [{ index: 0, qty: 1 }] }), { actions: SERVER_ACTIONS }), 2);
    expect(forms[0]?.querySelector('input[name="couponCode"]')).not.toBeNull();
    expect(forms[1]?.querySelectorAll('input[type="radio"][name="shippingMethodId"]').length).toBe(3);
    for (const f of forms) {
      expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(f.getAttribute("enctype")).toBe("multipart/form-data");
      expect(f.getAttribute("action") ?? "").not.toContain("javascript:");
    }
  });

  test("coupon applied -> 2 forms (remove + shipping), no code input", () => {
    const { forms } = assertForms(html(buildView({ lines: [{ index: 3, qty: 2 }], coupon: "welcome10" }), { actions: SERVER_ACTIONS }), 2);
    expect(forms.some((f) => f.querySelector('input[name="couponCode"]') !== null)).toBe(false);
    expect(forms[0]?.textContent).toContain("Remove");
  });

  test("no shipping options -> 1 form (coupon only)", () => {
    const view = buildView({ lines: [{ index: 0, qty: 1 }] });
    assertForms(html({ ...view, shippingOptions: [], shipping: null }), 1);
  });

  test("coupon input mirrors the 32-char limit; no-JS Update button for shipping is present", () => {
    const doc = parse(html(buildView({ lines: [{ index: 0, qty: 1 }] })));
    expect(doc.querySelector('input[name="couponCode"]')?.getAttribute("maxlength")).toBe("32");
    expect([...doc.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("Update"))).toBe(true);
  });

  test("selected method radio is checked in static markup", () => {
    const doc = parse(html(buildView({ lines: [{ index: 0, qty: 1 }], method: "express" })));
    expect(doc.querySelector<HTMLInputElement>('input[name="shippingMethodId"][checked]')?.value).toBe("express");
  });

  test("coupon form posts couponCode upper-cased (and nothing price-like)", async () => {
    const { posts, actions } = recorder();
    render(<CartSummary cart={buildView({ lines: [{ index: 0, qty: 1 }] })} actions={actions} now={NOW} />);
    const input = screen.getByRole("textbox", { name: "Promo code" });
    fireEvent.change(input, { target: { value: "  save5 " } });
    const form = input.closest("form");
    if (form === null) throw new Error("no coupon form");
    fireEvent.submit(form);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.action).toBe("applyCoupon");
    expect(posts[0]?.fields.filter(([k]) => !k.startsWith("$"))).toEqual([["couponCode", "SAVE5"]]);
  });

  test("shipping form posts shippingMethodId only, to setShippingMethod", async () => {
    const { posts, actions } = recorder();
    render(<CartSummary cart={buildView({ lines: [{ index: 0, qty: 1 }] })} actions={actions} now={NOW} />);
    const express = screen.getByRole("radio", { name: /Express/ });
    const form = express.closest("form");
    if (form === null) throw new Error("no shipping form");
    form.requestSubmit = () => {
      fireEvent.submit(form);
    };
    fireEvent.click(express);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.action).toBe("setShippingMethod");
    expect(posts[0]?.fields.filter(([k]) => !k.startsWith("$"))).toEqual([["shippingMethodId", "express"]]);
  });

  test("remove form posts no fields to removeCoupon", async () => {
    const { posts, actions } = recorder();
    render(<CartSummary cart={buildView({ lines: [{ index: 3, qty: 2 }], coupon: "WELCOME10" })} actions={actions} now={NOW} />);
    const remove = screen.getByRole("button", { name: /Remove/ });
    const form = remove.closest("form");
    if (form === null) throw new Error("no remove form");
    fireEvent.submit(form);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]?.action).toBe("removeCoupon");
    expect(posts[0]?.fields.filter(([k]) => !k.startsWith("$"))).toEqual([]);
  });

  test("keyboard-only: every control is natively focusable (no tabindex=-1) and in DOM order coupon -> shipping -> checkout", () => {
    render(<CartSummary cart={buildView({ lines: [{ index: 0, qty: 1 }] })} actions={ACTIONS} now={NOW} />);
    const aside = screen.getByTestId("cart-summary");
    const focusables = [...aside.querySelectorAll<HTMLElement>("a[href], button, input:not([type=hidden]), select")];
    expect(focusables.every((el) => el.getAttribute("tabindex") !== "-1" && !el.hasAttribute("disabled"))).toBe(true);
    const names = focusables.map((el) => el.getAttribute("name") ?? el.textContent ?? "");
    const coupon = names.indexOf("couponCode");
    const ship = names.indexOf("shippingMethodId");
    const checkout = names.findIndex((n) => n.includes("Proceed to checkout"));
    expect(coupon).toBeGreaterThanOrEqual(0);
    expect(ship).toBeGreaterThan(coupon);
    expect(checkout).toBeGreaterThan(ship);
    for (const el of focusables) {
      el.focus();
      expectFocused(el);
    }
  });
});

describe("T92.3 totals parity with OrderSummary (real getCartView fixtures)", () => {
  const specs: [string, Spec][] = [
    ["1 line, default (cheapest) shipping", { lines: [{ index: 0, qty: 1 }] }],
    ["2 lines + WELCOME10 percent", { lines: [{ index: 0, qty: 2 }, { index: 2, qty: 1 }], coupon: "WELCOME10" }],
    ["SAVE5 fixed", { lines: [{ index: "max", qty: 1 }], coupon: "SAVE5" }],
    ["FREESHIP coupon", { lines: [{ index: "max", qty: 1 }], coupon: "FREESHIP", method: "standard" }],
    ["express selected", { lines: [{ index: 1, qty: 3 }], method: "express" }],
    ["next_day + WELCOME10", { lines: [{ index: 2, qty: 1 }, { index: 3, qty: 1 }], method: "next_day", coupon: "WELCOME10" }],
    ["over standard free threshold", { lines: [{ index: "max", qty: 3 }], method: "standard" }],
    ["reduced line (billable = stock)", { lines: [{ index: 1, qty: 6, stock: 2 }, { index: 0, qty: 1 }] }],
    ["one unavailable + one ok", { lines: [{ index: 0, qty: 2 }, { index: 4, qty: 1, stock: 0 }], method: "express" }],
    ["all unavailable", { lines: [{ index: 0, qty: 1, stock: 0 }] }],
    ["reduced + coupon + express", { lines: [{ index: 3, qty: 9, stock: 4 }], coupon: "WELCOME10", method: "express" }],
    ["10 units of one + saved item", { lines: [{ index: 2, qty: 10 }], save: 5 }],
  ];

  for (const [name, spec] of specs) {
    test(`parity: ${name}`, () => {
      const view = buildView(spec);
      const cs = parse(html(view));
      const aside = cs.querySelector("aside");
      expect(aside?.getAttribute("data-total-check")).toBe("match");
      const items = view.items.map((line, i) => ({ ...toOrderSummaryItems(view)[i]!, name: line.name }));
      const os = parse(
        renderToStaticMarkup(
          <OrderSummary
            items={items}
            subtotalCents={view.totals.subtotalCents}
            discountCents={view.totals.discountCents}
            couponCode={view.coupon?.code ?? null}
            shippingCents={view.totals.shippingCents}
            totalCents={view.totals.totalCents}
            currency={view.currency}
          />,
        ),
      );
      expect(os.querySelector("section")?.getAttribute("data-total-check")).toBe("match");
      const osTotal = [...os.querySelectorAll("dt")].find((d) => d.textContent === "Total")?.nextElementSibling?.textContent;
      expect(cs.querySelector('[data-testid="cart-summary-total"]')?.textContent).toBe(osTotal ?? "missing");
      expect(aside?.textContent).not.toContain("NaN");
    });
  }

  test("billable quantities: an unavailable line contributes 0 and a reduced line min(qty, stock)", () => {
    const view = buildView({ lines: [{ index: 1, qty: 6, stock: 2 }, { index: 4, qty: 3, stock: 0 }] });
    const items = toOrderSummaryItems(view);
    expect(items.map((i) => i.quantity)).toEqual([2, 0]);
  });

  test("tampered total -> still displayed as given, flagged mismatch", () => {
    const view = buildView({ lines: [{ index: 0, qty: 1 }] });
    const tampered = { ...view, totals: { ...view.totals, totalCents: view.totals.totalCents + 1 } };
    const doc = parse(html(tampered));
    expect(doc.querySelector("aside")?.getAttribute("data-total-check")).toBe("mismatch");
    const expected = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(tampered.totals.totalCents / 100);
    // T180/U18: the summary total is a plain Money ("$0.00", same format as the other rows),
    // so its text content is the full amount, visible and spoken.
    const total = doc.querySelector('[data-testid="cart-summary-total"]');
    expect(total?.querySelector('[data-slot="price-superscript"]') ?? null).toBeNull();
    expect(total?.textContent).toBe(expected);
  });

  test("DEFECT D-T92-1: toOrderSummaryItems(view) keeps the line name so it can be passed to OrderSummary as is (STATE 'after T92' note)", () => {
    const view = buildView({ lines: [{ index: 0, qty: 1 }] });
    const first = toOrderSummaryItems(view)[0] as Record<string, unknown> | undefined;
    expect(first?.name).toBe(view.items[0]?.name);
  });
});

describe("T92.4 item count + robust amounts", () => {
  test("'1 item' / 'N items' / '0 items' from itemCount (not line count)", () => {
    expect(parse(html(buildView({ lines: [{ index: 0, qty: 1 }] }))).body.textContent).toContain("Subtotal (1 item)");
    expect(parse(html(buildView({ lines: [{ index: 0, qty: 3 }] }))).body.textContent).toContain("Subtotal (3 items)");
    const two = buildView({ lines: [{ index: 0, qty: 1 }, { index: 1, qty: 1 }] });
    expect(parse(html(two)).body.textContent).toContain("Subtotal (2 items)");
    expect(parse(html({ ...two, itemCount: 1 })).body.textContent).toContain("Subtotal (1 item)");
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) expect(itemCountLabel(bad)).toBe("0 items");
  });

  test("NaN / negative / float / Infinity amounts never render 'NaN' or 'Infinity'", () => {
    const view = buildView({ lines: [{ index: 0, qty: 1 }] });
    for (const bad of [Number.NaN, -500, 12.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const text = parse(
        html({ ...view, totals: { subtotalCents: bad, discountCents: bad, shippingCents: bad, totalCents: bad, amountToFreeShippingCents: bad } }),
      ).body.textContent ?? "";
      expect(text).not.toContain("NaN");
      expect(text).not.toContain("Infinity");
      expect(text).not.toMatch(/-\$/);
    }
  });
});

describe("T92 notices, free-shipping progress, hostile text, arrivals", () => {
  test("couponNotice renders as a Notice (role=alert, warning)", () => {
    render(<CartSummary cart={{ ...buildView({ lines: [{ index: 0, qty: 1 }] }), couponNotice: "Your code SAVE5 no longer applies." }} actions={ACTIONS} now={NOW} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Your code SAVE5 no longer applies.");
    expect(alert.getAttribute("data-tone")).toBe("warning");
  });

  test("free-shipping progress shown for the selected method with a threshold (standard, under)", () => {
    const view = buildView({ lines: [{ index: 0, qty: 1 }], method: "standard" });
    expect(view.totals.subtotalCents).toBeLessThan(3500);
    render(<CartSummary cart={view} actions={ACTIONS} now={NOW} />);
    const aside = screen.getByTestId("cart-summary");
    expect(aside.textContent).toMatch(/Add \$[\d.,]+ more for free shipping/);
    expect(within(aside).getByRole("progressbar")).toBeTruthy();
  });

  test("selected method without a threshold (express) -> no free-shipping progress at all", () => {
    const view = buildView({ lines: [{ index: 0, qty: 1 }], method: "express" });
    render(<CartSummary cart={view} actions={ACTIONS} now={NOW} />);
    const aside = screen.getByTestId("cart-summary");
    expect(aside.textContent).not.toMatch(/more for free shipping|got free shipping/);
    expect(within(aside).queryByRole("progressbar")).toBeNull();
  });

  test("standard over threshold -> 'free shipping' success + Shipping row 'Free'", () => {
    const view = buildView({ lines: [{ index: "max", qty: 3 }], method: "standard" });
    expect(view.totals.shippingCents).toBe(0);
    const text = parse(html(view)).body.textContent ?? "";
    expect(text).toContain("got free shipping");
    expect(text).toMatch(/Shipping.*Free/);
  });

  test("hostile coupon description and method names render as text", () => {
    const view = buildView({ lines: [{ index: 3, qty: 2 }], coupon: "WELCOME10" });
    const evil = '<img src=x onerror="alert(1)">';
    const cart: CartSummaryCart = {
      ...view,
      coupon: view.coupon === null ? null : { ...view.coupon, description: evil },
      shipping: view.shipping === null ? null : { ...view.shipping, method: { ...view.shipping.method, name: `${evil} Std` } },
      shippingOptions: view.shippingOptions.map((o) => ({ ...o, method: { ...o.method, name: `${evil} ${o.method.id}` } })),
    };
    const markup = html(cart);
    const doc = parse(markup);
    expect(doc.querySelector("img[src=x]")).toBeNull();
    expect(markup).not.toContain("<img src=x");
    expect(doc.body.textContent).toContain(evil);
  });

  test("arrivals pass through to the picker ('Arrives …' for the method given)", () => {
    const view = buildView({ lines: [{ index: 0, qty: 1 }] });
    const text = parse(
      html(view, { arrivals: { express: { start: "2026-11-10T00:00:00.000Z", end: "2026-11-11T00:00:00.000Z" } } }),
    ).body.textContent ?? "";
    expect(text).toMatch(/Express.*Arrives/);
    expect((text.match(/Arrives/g) ?? []).length).toBe(1);
  });

  test("shippingNotice: not pinned (consistency z, not implemented yet) — view field exists", () => {
    const view = buildView({ lines: [{ index: 0, qty: 1 }] });
    expect("shippingNotice" in view).toBe(true);
  });
});

describe("T92 a11y + layout", () => {
  test("aside is a labelled complementary landmark; heading level follows the prop", () => {
    render(<CartSummary cart={buildView({ lines: [{ index: 0, qty: 1 }] })} actions={ACTIONS} now={NOW} headingLevel={3} />);
    const aside = screen.getByRole("complementary", { name: "Order summary" });
    expect(within(aside).getByRole("heading", { level: 3, name: "Order summary" })).toBeTruthy();
  });

  test("320px: aside min-w-0 and rows wrap; checkout link is a 44px target", () => {
    const doc = parse(html(buildView({ lines: [{ index: 0, qty: 1 }], coupon: "WELCOME10" })));
    expect(doc.querySelector("aside")?.className).toContain("min-w-0");
    expect(doc.querySelectorAll(".flex-wrap").length).toBeGreaterThan(2);
    expect(checkoutLinks(doc)[0]?.className).toContain("min-h-touch");
    for (const b of doc.querySelectorAll("button")) expect(b.className).toContain("min-h-touch");
  });

  test("every href passes isAllowedInternalHref; unique ids", () => {
    const doc = parse(html(buildView({ lines: [{ index: 0, qty: 1 }] })));
    for (const a of doc.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    const ids = [...doc.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("two CartSummaries on one page -> distinct ids (useId)", () => {
    const view = buildView({ lines: [{ index: 0, qty: 1 }] });
    const doc = parse(renderToStaticMarkup(<><CartSummary cart={view} actions={ACTIONS} /><CartSummary cart={view} actions={ACTIONS} /></>));
    const ids = [...doc.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no session id in markup", () => {
    const view = buildView({ lines: [{ index: 0, qty: 1 }] });
    expect(html(view)).not.toContain(view.sessionId);
  });
});

describe("T92 source hygiene", () => {
  test("no any / ts-ignore / eslint-disable / dangerouslySetInnerHTML / style= / runtime server imports", () => {
    for (const file of ["CartSummary.tsx", "cart-summary-helpers.ts", "index.ts"]) {
      const src = readFileSync(join(DIR, file), "utf8");
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src).not.toMatch(/@ts-ignore|@ts-expect-error|eslint-disable/);
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/style=\{/);
      expect(src).not.toMatch(/Date\.now\(|new Date\(\)/);
      for (const line of src.split("\n").filter((l) => /from "@\/server\//.test(l))) expect(line).toMatch(/^import type /);
    }
  });
});
