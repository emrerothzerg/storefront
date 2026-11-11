/**
 * T111b QA wave 6 part B: `/checkout` page v2 (T109, ruling D-T109-1) and its
 * no-JS POST through the real `placeOrderV2` (T71 + FIX-checkout-placed +
 * FIX-checkout-v2). QA-owned. Page functions are called with mocked
 * `next/*`; the database is `:memory:` seeded through the real services.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  browserSubmit,
  cardLeaks,
  createSignedInUser,
  duplicateIds,
  headingViolations,
  hrefViolations,
  installNextMocks,
  isRealPostForm,
  parseHtml,
  qa,
  redirectOrState,
  resetCookies,
  serverLike,
  stockOf,
  totalChanges,
  TYPED_NEW_ADDRESS,
  unlabelledControls,
  uuidsIn,
  type SignedInUser,
} from "./_t111b-harness";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const cartModule = await import("@/server/cart/cart-service");
const addressModule = await import("@/server/addresses/address-service");
const { estimateDelivery } = await import("@/server/pricing/shipping-service");
const { getRateLimiter, limitAction } = await import("@/server/security/rate-limiter");
const { isAllowedInternalHref } = await import("@/content/routes");
const { CHECKOUT_FIELD_V2, CHECKOUT_NOTICE_MESSAGES } = await import(
  "@/components/organisms/_contracts/checkout-actions"
);
const { placeOrderV2 } = await import("@/app/actions/checkout-v2");
const { loadCheckoutPageV2 } = await import("@/app/checkout/_lib/load-checkout-page");
const pageModule = await import("@/app/checkout/page");
const Page = pageModule.default;

const { createCartService, SHIPPING_METHOD_DROPPED_NOTICE } = cartModule;
const { createAddressService, MAX_ADDRESSES_PER_SESSION } = addressModule;

const TOTE = "prod_canvas-tote-bag"; // 1999 cents
const GUEST = "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1";
const OTHER = "d2d2d2d2-d2d2-4d2d-9d2d-d2d2d2d2d2d2";
const HOSTILE = `<img src=x onerror="alert(1)">`;
const HOSTILE_LABEL = `"><script>alert(2)</script>`;

let userA: SignedInUser;
let userB: SignedInUser;

const db = () => getDatabase();

function setupDb(): void {
  closeDatabase();
  seedDatabase(db());
  db().run("UPDATE products SET stock = 500 WHERE id = ?", [TOTE]);
}

function addToCart(owner: string, productId = TOTE, qty = 1): void {
  const r = createCartService().addItem(owner, productId, qty);
  if (!r.ok) throw new Error(`addItem: ${r.error.code}`);
}

function saveAddress(owner: string, overrides: Record<string, string> = {}): string {
  const r = createAddressService({ db: db() }).create(owner, {
    fullName: "Grace Hopper",
    line1: "7 Compiler Road",
    line2: "",
    city: "Arlington",
    region: "VA",
    postalCode: "22201",
    country: "US",
    email: undefined,
    label: "Work",
    ...overrides,
  });
  if (!r.ok) throw new Error(`address create failed: ${r.error.code}`);
  return r.value.id;
}

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(await Page());
}

function form(doc: Document): Element {
  const forms = doc.body.querySelectorAll("form");
  expect(forms).toHaveLength(1);
  const f = forms[0];
  if (f === undefined) throw new Error("no form");
  return f;
}

function idempotencyKeyOf(doc: Document): string {
  const v = doc.body.querySelector('input[name="idempotencyKey"]')?.getAttribute("value");
  if (typeof v !== "string") throw new Error("no idempotency key");
  return v;
}

const V2_NAMES: readonly string[] = [...new Set(Object.values(CHECKOUT_FIELD_V2))];

function ordersCount(): number {
  return db().query<{ n: number }, []>("SELECT count(*) AS n FROM orders").get()?.n ?? -1;
}

function paidOrder(id: string): { session_id: string; total_cents: number; status: string } | null {
  return db()
    .query<{ session_id: string; total_cents: number; status: string }, [string]>(
      "SELECT session_id, total_cents, status FROM orders WHERE id = ?",
    )
    .get(id);
}

/** Server total of the owner's cart as the page shows it. */
function cartTotal(owner: string): number {
  const v = createCartService().getCartView(owner);
  if (!v.ok) throw new Error("view");
  return v.value.totals.totalCents;
}

const PLACED_RE = /^\/orders\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\?placed=1(&notice=[a-z_]+)?$/;

let addressListSpy: ReturnType<typeof spyOn<typeof addressModule, "getAddressService">>;
let cartServiceSpy: ReturnType<typeof spyOn<typeof cartModule, "getCartService">>;

beforeEach(async () => {
  setupDb();
  userA = await createSignedInUser(db(), "Ada Buyer", "ada.buyer");
  userB = await createSignedInUser(db(), "Bob Other", "bob.other");
  resetCookies();
  addressListSpy = spyOn(addressModule, "getAddressService");
  cartServiceSpy = spyOn(cartModule, "getCartService");
});

afterEach(() => {
  addressListSpy.mockRestore();
  cartServiceSpy.mockRestore();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

// ---------------------------------------------------------------------------
// Criterion 1: page states
// ---------------------------------------------------------------------------

describe("C1 /checkout states (D-T109-1)", () => {
  test("metadata is noindex; page source has no clock read in JSX", () => {
    expect(pageModule.metadata.robots).toEqual({ index: false, follow: false });
    const src = readFileSync(join(import.meta.dir, "../../../src/app/checkout/page.tsx"), "utf8");
    expect(src.includes("Date.now(")).toBe(false);
    expect(/new Date\(\s*\)/.test(src)).toBe(false);
  });

  async function expectCartState(title: RegExp, expectFormless = true): Promise<Document> {
    const before = totalChanges(db());
    const html = await renderPage();
    const doc = parseHtml(html);
    expect(headingViolations(doc)).toEqual([]);
    expect(doc.body.querySelectorAll("h1")).toHaveLength(1);
    expect(doc.body.textContent ?? "").toMatch(title);
    if (expectFormless) expect(doc.body.querySelectorAll("form")).toHaveLength(0);
    expect(doc.body.querySelector('a[href="/cart"]')).not.toBeNull();
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
    expect(uuidsIn(html)).toEqual([]);
    expect(qa.store.writes).toEqual([]);
    expect(totalChanges(db()) - before).toBe(0);
    return doc;
  }

  test("no cookie -> empty state, no service touched, no address read", async () => {
    await expectCartState(/Your cart is empty/);
    expect(cartServiceSpy).toHaveBeenCalledTimes(0);
    expect(addressListSpy).toHaveBeenCalledTimes(0);
  });

  test("garbage cookies -> empty state, no service touched", async () => {
    resetCookies({ sf_session: "not-a-uuid'--", sf_auth: "short" });
    await expectCartState(/Your cart is empty/);
    expect(cartServiceSpy).toHaveBeenCalledTimes(0);
    expect(addressListSpy).toHaveBeenCalledTimes(0);
  });

  test("valid cookie with an empty cart -> empty state, no address read (even with saved addresses)", async () => {
    saveAddress(GUEST, { fullName: "Hidden Saved Person" });
    resetCookies({ sf_session: GUEST });
    const doc = await expectCartState(/Your cart is empty/);
    expect(doc.body.textContent).not.toContain("Hidden Saved Person");
    expect(addressListSpy).toHaveBeenCalledTimes(0);
  });

  test("blocked: unavailable line -> state text, no form, /cart link, no address read", async () => {
    addToCart(GUEST);
    saveAddress(GUEST, { fullName: "Hidden Saved Person" });
    db().run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    resetCookies({ sf_session: GUEST });
    const doc = await expectCartState(/Some items are unavailable/);
    expect(doc.body.textContent).toMatch(/out of stock/i);
    expect(doc.body.textContent).not.toContain("Hidden Saved Person");
    expect(addressListSpy).toHaveBeenCalledTimes(0);
  });

  test("blocked: reduced line -> state text, no form, /cart link, no address read", async () => {
    addToCart(GUEST, TOTE, 5);
    db().run("UPDATE products SET stock = 2 WHERE id = ?", [TOTE]);
    resetCookies({ sf_session: GUEST });
    await expectCartState(/Some items are unavailable/);
    expect(addressListSpy).toHaveBeenCalledTimes(0);
  });

  test("blocked: unpublished product in the cart -> blocked, not a form", async () => {
    addToCart(GUEST);
    db().run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    resetCookies({ sf_session: GUEST });
    const html = await renderPage();
    const doc = parseHtml(html);
    expect(doc.body.querySelectorAll("form")).toHaveLength(0);
    expect(doc.body.querySelector('a[href="/cart"]')).not.toBeNull();
    expect(addressListSpy).toHaveBeenCalledTimes(0);
  });

  test("ready (signed-in A, two owners seeded): one form, every v2 field, only A's addresses, email prefilled, no leaks", async () => {
    addToCart(userA.ownerKey, TOTE, 1);
    const ownHome = saveAddress(userA.ownerKey, { fullName: HOSTILE, label: HOSTILE_LABEL });
    const ownWork = saveAddress(userA.ownerKey, { fullName: "Ada Second", line1: "2 Second St", label: "Work" });
    const foreign = saveAddress(userB.ownerKey, { fullName: "Mallory Foreign", line1: "1 Foreign Way" });
    const guestForeign = saveAddress(OTHER, { fullName: "Guest Foreign", line1: "9 Guest Rd" });
    resetCookies({ sf_auth: userA.token });

    const before = totalChanges(db());
    // Real server actions carry `$$FORM_ACTION`; without the fixture React
    // renders its `javascript:` placeholder, which is a test artefact.
    const restoreAction = serverLike([placeOrderV2]);
    let html = "";
    try {
      html = await renderPage();
    } finally {
      restoreAction();
    }
    const delta = totalChanges(db()) - before;
    const doc = parseHtml(html);
    const f = form(doc);

    // every CHECKOUT_FIELD_V2 name posted by the one form
    for (const name of V2_NAMES) {
      expect({ name, present: f.querySelector(`[name="${name}"]`) !== null }).toEqual({ name, present: true });
    }
    // only the owner's book
    const ids = [...f.querySelectorAll('input[type="radio"][name="addressId"]')].map((r) => r.getAttribute("value"));
    expect(ids.sort()).toEqual([ownHome, ownWork].sort());
    expect(html).not.toContain(foreign);
    expect(html).not.toContain(guestForeign);
    expect(html).not.toContain("Mallory");
    expect(html).not.toContain("Guest Foreign");
    expect(html).not.toContain(userB.email);
    // hostile name and label rendered as text
    expect(doc.body.querySelector("img[src=x]")).toBeNull();
    expect([...doc.body.querySelectorAll("script")].some((el) => (el.textContent ?? "").includes("alert(2)"))).toBe(false);
    expect(doc.body.textContent).toContain(HOSTILE);
    expect(doc.body.textContent).toContain(`<script>alert(2)</script>`);
    // signed-in email prefilled
    expect(f.querySelector('input[name="email"]')?.getAttribute("value")).toBe(userA.email);
    // UUIDs: idempotency key + owner's address ids only (no owner key, no user id)
    expect(uuidsIn(html)).toEqual([idempotencyKeyOf(doc), ownHome, ownWork].sort());
    expect(html).not.toContain(userA.ownerKey);
    expect(html).not.toContain(userA.token);
    // totals check, links, headings, a11y basics
    const checks = [...doc.body.querySelectorAll("[data-total-check]")].map((e) => e.getAttribute("data-total-check"));
    expect(checks.length).toBeGreaterThan(0);
    expect(new Set(checks)).toEqual(new Set(["match"]));
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
    expect(headingViolations(doc)).toEqual([]);
    expect(duplicateIds(doc)).toEqual([]);
    expect(unlabelledControls(doc)).toEqual([]);
    expect(doc.body.querySelector("main")).toBeNull();
    // read-only render
    expect(qa.store.writes).toEqual([]);
    expect(delta).toBe(0);
    expect(addressListSpy).toHaveBeenCalledTimes(1);
  });

  test("guest with a cookie: email input empty; isSignedIn false", async () => {
    addToCart(GUEST);
    resetCookies({ sf_session: GUEST });
    const doc = parseHtml(await renderPage());
    expect(form(doc).querySelector('input[name="email"]')?.getAttribute("value") ?? "").toBe("");
  });

  test("R-1: guest cookie equal to A's owner key reads as no cookie (empty state, no A data)", async () => {
    addToCart(userA.ownerKey);
    saveAddress(userA.ownerKey, { fullName: "Ada Private" });
    resetCookies({ sf_session: userA.ownerKey });
    const html = await renderPage();
    const doc = parseHtml(html);
    expect(doc.body.querySelectorAll("form")).toHaveLength(0);
    expect(doc.body.textContent).toMatch(/Your cart is empty/);
    expect(html).not.toContain("Ada Private");
    expect(html).not.toContain(userA.ownerKey);
    expect(qa.store.writes).toEqual([]);
  });

  test("shipping arrivals come from ONE now (loader with injected now)", () => {
    addToCart(GUEST);
    const now = Date.UTC(2026, 10, 7, 15, 30, 0);
    const data = loadCheckoutPageV2({ ownerKey: GUEST, user: null }, { now });
    if (data.kind !== "ready") throw new Error(`expected ready, got ${data.kind}`);
    expect(data.now).toBe(now);
    expect(data.form.shipping.now).toBe(now);
    const options = data.form.shipping.options;
    expect(options.length).toBeGreaterThanOrEqual(2);
    for (const option of options) {
      const expected = estimateDelivery(option.method, now, now);
      expect(data.form.shipping.arrivals?.[option.method.id]).toEqual({ start: expected.start, end: expected.end });
    }
  });

  test("one-time coupon notice: shown once above the form, gone on the next render", async () => {
    addToCart(GUEST, TOTE, 2);
    expect(createCartService().applyCoupon(GUEST, "SAVE5").ok).toBe(true);
    createCartService().setQuantity(GUEST, TOTE, 1);
    resetCookies({ sf_session: GUEST });
    const first = parseHtml(await renderPage());
    expect(first.body.textContent).toContain("SAVE5");
    expect(first.body.querySelectorAll("form")).toHaveLength(1);
    const second = parseHtml(await renderPage());
    expect(second.body.textContent).not.toContain("SAVE5");
  });

  test("one-time shipping notice (D-T55-2): shown once, then the cheapest method is selected", async () => {
    addToCart(GUEST);
    expect(createCartService().selectShippingMethod(GUEST, "express").ok).toBe(true);
    db().run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    resetCookies({ sf_session: GUEST });
    const first = parseHtml(await renderPage());
    expect(first.body.textContent).toContain(SHIPPING_METHOD_DROPPED_NOTICE);
    expect(first.body.querySelector('input[name="shippingMethodId"][checked]')?.getAttribute("value")).toBe("standard");
    const second = parseHtml(await renderPage());
    expect(second.body.textContent).not.toContain(SHIPPING_METHOD_DROPPED_NOTICE);
  });

  test("fresh idempotency key per render; never equals the owner key", async () => {
    addToCart(GUEST);
    resetCookies({ sf_session: GUEST });
    const a = idempotencyKeyOf(parseHtml(await renderPage()));
    const b = idempotencyKeyOf(parseHtml(await renderPage()));
    expect(a).not.toBe(b);
    expect(a).not.toBe(GUEST);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: no-JS shape and real POST through placeOrderV2
// ---------------------------------------------------------------------------

describe("C2 /checkout no-JS POST through the real placeOrderV2", () => {
  let restore: () => void = () => undefined;
  beforeEach(() => {
    restore = serverLike([placeOrderV2]);
  });
  afterEach(() => restore());

  async function renderForm(cookies: Record<string, string>): Promise<{ doc: Document; form: Element; html: string }> {
    resetCookies(cookies);
    const html = await renderPage();
    const doc = parseHtml(html);
    return { doc, form: form(doc), html };
  }

  test("the form is a real POST/multipart form with no javascript: action and React's $ACTION_ field", async () => {
    addToCart(GUEST);
    const { form: f, html } = await renderForm({ sf_session: GUEST });
    expect(isRealPostForm(f)).toBe(true);
    expect(html.toLowerCase()).not.toContain("javascript:");
    expect(f.querySelector('input[type="hidden"][name^="$ACTION_"]')).not.toBeNull();
  });

  test("browser-shaped multipart post places the order and redirects to /orders/<id>?placed=1", async () => {
    addToCart(GUEST, TOTE, 2);
    const shownTotal = cartTotal(GUEST);
    const stockBefore = stockOf(db(), TOTE);
    const { form: f } = await renderForm({ sf_session: GUEST });
    const body = await browserSubmit(f, { ...TYPED_NEW_ADDRESS, total: "1", sessionId: OTHER, price: "0" });
    expect([...body.keys()].some((k) => k.startsWith("$ACTION_"))).toBe(true);
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("url" in out)) throw new Error(`no redirect: ${JSON.stringify(out.state)}`);
    const m = PLACED_RE.exec(out.url);
    expect(m).not.toBeNull();
    expect(m?.[2]).toBeUndefined();
    const order = paidOrder(m?.[1] ?? "");
    expect(order).toEqual({ session_id: GUEST, total_cents: shownTotal, status: "paid" });
    expect(stockOf(db(), TOTE)).toBe(stockBefore - 2);
    expect(qa.store.writes).toEqual([]);
  });

  test("saveAddress with a full address book -> redirect carries &notice=address_full", async () => {
    addToCart(GUEST);
    for (let i = 0; i < MAX_ADDRESSES_PER_SESSION; i += 1) saveAddress(GUEST, { line1: `${i} Full Street` });
    const { form: f } = await renderForm({ sf_session: GUEST });
    const body = await browserSubmit(f, { ...TYPED_NEW_ADDRESS, saveAddress: "on", addressLabel: "Cabin" });
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("url" in out)) throw new Error(`no redirect: ${JSON.stringify(out.state)}`);
    expect(out.url).toMatch(PLACED_RE);
    expect(out.url.endsWith("&notice=address_full")).toBe(true);
    expect(CHECKOUT_NOTICE_MESSAGES.address_full).toMatch(/order was placed/);
  });

  test("saveAddress refused by the address.write limiter -> &notice=address_not_saved", async () => {
    addToCart(GUEST);
    const limiter = getRateLimiter();
    for (let i = 0; i < 25; i += 1) limitAction(limiter, "address.write", GUEST);
    const { form: f } = await renderForm({ sf_session: GUEST });
    const body = await browserSubmit(f, { ...TYPED_NEW_ADDRESS, saveAddress: "on" });
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("url" in out)) throw new Error(`no redirect: ${JSON.stringify(out.state)}`);
    expect(out.url).toMatch(PLACED_RE);
    expect(out.url.endsWith("&notice=address_not_saved")).toBe(true);
  });

  test("saved-address mode with the owner's address id places the order (signed-in user)", async () => {
    addToCart(userA.ownerKey);
    const own = saveAddress(userA.ownerKey);
    const { form: f } = await renderForm({ sf_auth: userA.token });
    const body = await browserSubmit(f, {
      addressMode: "saved",
      addressId: own,
      nameOnCard: "Ada Buyer",
      number: "4242424242424242",
      expMonth: "12",
      expYear: "31",
      cvc: "123",
    });
    expect(body.get("email")).toBe(userA.email);
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("url" in out)) throw new Error(`no redirect: ${JSON.stringify(out.state)}`);
    const id = PLACED_RE.exec(out.url)?.[1] ?? "";
    expect(paidOrder(id)?.session_id).toBe(userA.ownerKey);
  });

  test("saved-address mode with ANOTHER owner's address id -> field error, no order, no redirect", async () => {
    addToCart(userA.ownerKey);
    const foreign = saveAddress(userB.ownerKey);
    const { form: f } = await renderForm({ sf_auth: userA.token });
    const before = ordersCount();
    const body = await browserSubmit(f, { ...TYPED_NEW_ADDRESS, addressMode: "saved", addressId: foreign });
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("state" in out)) throw new Error(`unexpected redirect ${out.url}`);
    expect(out.state?.ok).toBe(false);
    expect(Object.keys(out.state?.fieldErrors ?? {})).toContain("addressId");
    expect(ordersCount()).toBe(before);
    // Only the shopper's own posted id is echoed back; nothing of B's address.
    expect(JSON.stringify(out.state)).not.toContain("7 Compiler Road");
    expect(JSON.stringify(out.state)).not.toContain("Grace Hopper");
  });

  test("declined card -> PAYMENT_FAILED state, never redirects, card data not echoed", async () => {
    addToCart(GUEST);
    const stockBefore = stockOf(db(), TOTE);
    const { form: f } = await renderForm({ sf_session: GUEST });
    const body = await browserSubmit(f, { ...TYPED_NEW_ADDRESS, number: "4000000000000002" });
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("state" in out)) throw new Error(`unexpected redirect ${out.url}`);
    expect(out.state?.error.code).toBe("PAYMENT_FAILED");
    expect(cardLeaks(JSON.stringify(out.state))).toEqual([]);
    expect(stockOf(db(), TOTE)).toBe(stockBefore);
  });

  test("validation failure -> VALIDATION_FAILED with field errors, retained values without card data", async () => {
    addToCart(GUEST);
    const { form: f } = await renderForm({ sf_session: GUEST });
    const body = await browserSubmit(f, { ...TYPED_NEW_ADDRESS, fullName: "", postalCode: "" });
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("state" in out)) throw new Error(`unexpected redirect ${out.url}`);
    expect(out.state?.error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(out.state?.fieldErrors ?? {})).toEqual(expect.arrayContaining(["fullName", "postalCode"]));
    expect(cardLeaks(JSON.stringify(out.state))).toEqual([]);
    expect(ordersCount()).toBe(0);
  });

  test("coupon invalid at submit (T109 AC4) -> coupon error, nothing charged or reserved", async () => {
    addToCart(GUEST, TOTE, 2);
    expect(createCartService().applyCoupon(GUEST, "WELCOME10").ok).toBe(true);
    const { form: f } = await renderForm({ sf_session: GUEST });
    db().run("UPDATE coupons SET is_active = 0 WHERE code = 'WELCOME10'");
    const stockBefore = stockOf(db(), TOTE);
    const body = await browserSubmit(f, TYPED_NEW_ADDRESS);
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("state" in out)) throw new Error(`unexpected redirect ${out.url}`);
    expect(out.state?.error.code).toMatch(/^COUPON_/);
    expect(ordersCount()).toBe(0);
    expect(stockOf(db(), TOTE)).toBe(stockBefore);
  });

  test("stock dropped after render -> STOCK_CHANGED, no redirect, no order", async () => {
    addToCart(GUEST, TOTE, 3);
    const { form: f } = await renderForm({ sf_session: GUEST });
    db().run("UPDATE products SET stock = 1 WHERE id = ?", [TOTE]);
    const body = await browserSubmit(f, TYPED_NEW_ADDRESS);
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("state" in out)) throw new Error(`unexpected redirect ${out.url}`);
    expect(out.state?.error.code).toBe("STOCK_CHANGED");
    expect(ordersCount()).toBe(0);
  });

  test("post without any cookie -> EMPTY_CART state, no cookie minted, no order", async () => {
    addToCart(GUEST);
    const { form: f } = await renderForm({ sf_session: GUEST });
    const body = await browserSubmit(f, TYPED_NEW_ADDRESS);
    resetCookies();
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("state" in out)) throw new Error(`unexpected redirect ${out.url}`);
    expect(out.state?.error.code).toBe("EMPTY_CART");
    expect(qa.store.writes).toEqual([]);
    expect(ordersCount()).toBe(0);
  });

  test("same form posted twice (double submit, same key) -> same order id, charged once", async () => {
    addToCart(GUEST, TOTE, 1);
    const stockBefore = stockOf(db(), TOTE);
    const { form: f } = await renderForm({ sf_session: GUEST });
    const body1 = await browserSubmit(f, TYPED_NEW_ADDRESS);
    const body2 = await browserSubmit(f, TYPED_NEW_ADDRESS);
    const [a, b] = await Promise.all([
      redirectOrState(() => placeOrderV2(null, body1)),
      redirectOrState(() => placeOrderV2(null, body2)),
    ]);
    if (!("url" in a) || !("url" in b)) throw new Error("expected two redirects");
    expect(a.url).toBe(b.url);
    expect(ordersCount()).toBe(1);
    expect(stockOf(db(), TOTE)).toBe(stockBefore - 1);
  });
});
