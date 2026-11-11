/**
 * T182 — QA of UI wave 1 part 2 at page level (UI-REVIEW-2026-11-09 findings
 * U06, U07, U09, U10, U13, U17, U18). QA-owned. Component-level checks are in
 * `tests/components/ui-wave1-part2.qa.test.tsx`.
 *
 * Page functions are called directly with the T111b harness (`next/*` mocks,
 * AsyncLocalStorage cookie jars, `$$FORM_ACTION` server-reference fixture so
 * forms render as real no-JS POST forms, multipart browser submit). `:memory:`
 * SQLite seeded through the real seed. Markup checks on renderToStaticMarkup
 * output = the no-JS view. Layout (columns, sticky, one-row toolbar) is only
 * verifiable here as classes and DOM order; real widths need a browser.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { expectNotNull } from "@/test/dom-assertions";

import {
  browserSubmit,
  createSignedInUser,
  installNextMocks,
  isRealPostForm,
  outcomeOf,
  parseHtml,
  redirectOrState,
  resetCookies,
  serverLike,
  stockOf,
  TYPED_NEW_ADDRESS,
  unlabelledControls,
} from "../phase2-wave6/_t111b-harness";
import { precedes, spokenText } from "./_phase3";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { createCartService } = await import("@/server/cart/cart-service");
const { createAddressService } = await import("@/server/addresses/address-service");
const { getCategoryTileArt, FALLBACK_TILE_ART } = await import("@/content/home-art");
const { formatMoney } = await import("@/lib/money");
const cartActions = await import("@/app/actions/cart");
const listActions = await import("@/app/actions/lists");
const alertActions = await import("@/app/actions/stock-alerts");
const reviewActions = await import("@/app/actions/reviews");
const qaActions = await import("@/app/actions/questions");
const { placeOrderV2 } = await import("@/app/actions/checkout-v2");
const { default: HomePage } = await import("@/app/page");
const { default: CategoryPage } = await import("@/app/category/[slug]/page");
const { default: ProductPage } = await import("@/app/products/[slug]/page");
const { default: CartPage } = await import("@/app/cart/page");
const { default: CheckoutPage } = await import("@/app/checkout/page");
const { default: OrderPage } = await import("@/app/orders/[id]/page");
const { default: InvoicePage } = await import("@/app/orders/[id]/invoice/page");

const TOTE = "prod_canvas-tote-bag";
const GUEST = "e8e8e8e8-1820-4182-8182-0000000000e8";
const db = () => getDatabase();
const usd = (cents: number): string => formatMoney(cents, "USD");

const CART_ACTIONS = [
  cartActions.addToCart,
  cartActions.updateCartQuantity,
  cartActions.removeFromCart,
  cartActions.saveForLater,
  cartActions.moveToCart,
  cartActions.applyCoupon,
  cartActions.removeCoupon,
  cartActions.selectShippingMethod,
  cartActions.buyNow,
  cartActions.addManyToCart,
  listActions.addToList,
  listActions.removeFromList,
];
const PDP_ACTIONS = [
  ...CART_ACTIONS,
  alertActions.subscribeStockAlert,
  alertActions.unsubscribeStockAlert,
  reviewActions.submitReview,
  reviewActions.voteReviewHelpful,
  qaActions.askQuestion,
  qaActions.answerQuestion,
  qaActions.voteQuestion,
  qaActions.voteAnswer,
];

type AnyFns = Parameters<typeof serverLike>[0];

async function renderWith(actions: readonly unknown[], run: () => Promise<React.ReactNode>): Promise<{ html: string; doc: Document }> {
  const restore = serverLike(actions as AnyFns);
  try {
    const out = await outcomeOf(run);
    if (out.kind !== "ok") throw new Error(`page outcome ${out.kind}`);
    const html = renderToStaticMarkup(<>{out.value}</>);
    return { html, doc: parseHtml(html) };
  } finally {
    restore();
  }
}

const cls = (el: Element | null | undefined): string[] => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** Visible text: textContent minus `.sr-only` subtrees, whitespace collapsed. */
function visibleText(el: Element | null | undefined): string {
  if (el === null || el === undefined) return "";
  const clone = el.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll(".sr-only")) hidden.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Arbitrary-value utility classes (`foo-[...]`, `[&...]`) under `root`. */
function arbitraryClasses(root: Element): string[] {
  const out = new Set<string>();
  for (const el of [root, ...root.querySelectorAll("[class]")]) for (const c of cls(el)) if (c.includes("[")) out.add(c);
  return [...out];
}

/** Same rule as tests/redesign/audit.test.tsx fixedWidthIssues (unprefixed w-/min-w- >= 40 units, no override, not in a scroller). */
function fixedWidthIssues(root: Element): string[] {
  const out: string[] = [];
  const isScroller = (el: Element) => cls(el).some((c) => /^overflow(-x)?-(auto|scroll)$/.test(c));
  for (const el of root.querySelectorAll("[class]")) {
    const c = cls(el);
    for (const k of c) {
      const m = /^(w|min-w)-(\d+)$/.exec(k);
      if (m === null || Number(m[2]) < 40) continue;
      let inScroller = false;
      for (let cur = el.parentElement; cur !== null; cur = cur.parentElement) if (isScroller(cur)) inScroller = true;
      const override = c.some((o) => /^(max-(xs|sm|md):)?(min-w-0|max-w-full|w-full)$/.test(o) && o !== k);
      if (!inScroller && !override) out.push(`${k} on ${el.tagName.toLowerCase()}`);
    }
  }
  return out;
}

function tileArt(root: Element | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of root?.querySelectorAll('a[href^="/category/"]') ?? []) {
    const slug = decodeURIComponent((a.getAttribute("href") ?? "").slice("/category/".length));
    out.set(slug, a.querySelector("img")?.getAttribute("src") ?? "");
  }
  return out;
}

function departmentWithLeaves(): { dept: string; leaves: string[] } {
  const rows = db()
    .query<{ dept: string; leaf: string }, []>(
      "SELECT d.slug AS dept, c.slug AS leaf FROM categories c JOIN categories d ON c.parent_id = d.id ORDER BY d.slug, c.slug",
    )
    .all();
  const by = new Map<string, string[]>();
  for (const r of rows) by.set(r.dept, [...(by.get(r.dept) ?? []), r.leaf]);
  const best = [...by].sort((a, b) => b[1].length - a[1].length)[0];
  if (best === undefined) throw new Error("no department with leaves in the seed");
  return { dept: best[0], leaves: best[1] };
}

function parentOf(slug: string): string | null {
  return (
    db()
      .query<{ p: string }, [string]>("SELECT d.slug AS p FROM categories c JOIN categories d ON c.parent_id = d.id WHERE c.slug = ?")
      .get(slug)?.p ?? null
  );
}

function add(owner: string, productId = TOTE, qty = 1): void {
  const r = createCartService().addItem(owner, productId, qty);
  if (!r.ok) throw new Error(`addItem: ${r.error.code}`);
}

function ordersCount(): number {
  return db().query<{ n: number }, []>("SELECT count(*) AS n FROM orders").get()?.n ?? -1;
}

function cartTotal(owner: string): number {
  const v = createCartService().getCartView(owner);
  if (!v.ok) throw new Error("view");
  return v.value.totals.totalCents;
}

beforeEach(() => {
  closeDatabase();
  seedDatabase(db());
  db().run("UPDATE products SET stock = 500 WHERE id = ?", [TOTE]);
  resetCookies();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

// ---------------------------------------------------------------------------
// U07 listing toolbar (department page)
// ---------------------------------------------------------------------------

describe("U07 listing toolbar on /category/<department>", () => {
  async function renderDept() {
    const { dept } = departmentWithLeaves();
    return renderWith([cartActions.addToCart], () =>
      CategoryPage({ params: Promise.resolve({ slug: dept }), searchParams: Promise.resolve({}) }),
    );
  }

  test("Filter pill and Sort form share one toolbar row container; the view toggle is hidden below md, flex from md", async () => {
    const { doc } = await renderDept();
    const details = doc.querySelector("details[data-filter-panel]");
    const sortForm = doc.querySelector('select[name="sort"]')?.closest("form") ?? null;
    expectNotNull(details);
    expectNotNull(sortForm);
    const row = details?.parentElement ?? null;
    expect(row !== null && sortForm !== null && row.contains(sortForm)).toBe(true);
    expect(cls(row)).toEqual(expect.arrayContaining(["flex", "items-center", "min-w-0"]));
    const toggle = doc.querySelector('[data-slot="view-toggle"]');
    expect(cls(toggle)).toEqual(expect.arrayContaining(["hidden", "md:flex"]));
    expect(cls(toggle)).not.toContain("flex");
    expect(toggle?.getAttribute("role")).toBe("group");
    expect(toggle?.getAttribute("aria-label")).toBe("View");
    expect([...(toggle?.querySelectorAll("a") ?? [])].map((a) => visibleText(a))).toEqual(["Grid", "List"]);
  });

  test("the sort select's accessible name is 'Sort by'; no unlabelled controls", async () => {
    const { doc } = await renderDept();
    const select = doc.querySelector('select[name="sort"]');
    const label = select !== null ? doc.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;
    expect(spokenText(label)).toBe("Sort by");
    expect(unlabelledControls(doc)).toEqual([]);
  });

  test("no-JS: exactly two GET forms (sort + filters), each with its Apply submit, never nested", async () => {
    const { doc } = await renderDept();
    const gets = [...doc.querySelectorAll("form")].filter((f) => (f.getAttribute("method") ?? "").toLowerCase() === "get");
    expect(gets.length).toBe(2);
    for (const f of gets) {
      expect(f.getAttribute("action")?.startsWith("/category/")).toBe(true);
      expect(f.querySelector("form")).toBeFalsy();
    }
    const submits = gets.map((f) => [...f.querySelectorAll('button[type="submit"]')].map((b) => visibleText(b)).join("|")).sort();
    expect(submits).toEqual(["Apply", "Apply filters"]);
  });

  test("320px audit rule: no unprefixed fixed width >= 160px in the listing results/toolbar", async () => {
    const { doc } = await renderDept();
    const results = doc.querySelector("[data-listing-results]");
    expectNotNull(results);
    expect(fixedWidthIssues(results as Element)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// U13 category art: home discovery vs department page
// ---------------------------------------------------------------------------

describe("U13 category art across pages", () => {
  test("department page subcategory rail: per-slug art, never the fallback, alt=\"\"", async () => {
    const { dept, leaves } = departmentWithLeaves();
    const { doc } = await renderWith([cartActions.addToCart], () =>
      CategoryPage({ params: Promise.resolve({ slug: dept }), searchParams: Promise.resolve({}) }),
    );
    const rail = doc.querySelector("section#category-subcategories");
    expectNotNull(rail);
    const art = tileArt(rail);
    expect(art.size).toBeGreaterThan(1);
    for (const [slug, src] of art) {
      expect([slug, leaves.includes(slug), src.includes(getCategoryTileArt(slug).path), src.includes(FALLBACK_TILE_ART.path)]).toEqual([slug, true, true, false]);
    }
    expect(new Set(art.values()).size).toBeGreaterThan(1);
    expect([...(rail?.querySelectorAll("img") ?? [])].every((i) => i.getAttribute("alt") === "")).toBe(true);
  });

  test("a leaf shown in home 'Explore popular categories' has identical art on its department page", async () => {
    const home = await renderWith([cartActions.addToCart], () => HomePage({ searchParams: Promise.resolve({}) }));
    const disc = tileArt(home.doc.querySelector("section#home-discovery"));
    expect(disc.size).toBeGreaterThan(0);
    let compared = 0;
    for (const [slug, src] of disc) {
      const dept = parentOf(slug);
      if (dept === null) continue;
      const page = await renderWith([cartActions.addToCart], () =>
        CategoryPage({ params: Promise.resolve({ slug: dept }), searchParams: Promise.resolve({}) }),
      );
      const deptSrc = tileArt(page.doc.querySelector("section#category-subcategories")).get(slug);
      expect([slug, deptSrc === src, src.includes(FALLBACK_TILE_ART.path)]).toEqual([slug, true, false]);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(0);
  });

  test("home department rail keeps department art", async () => {
    const home = await renderWith([cartActions.addToCart], () => HomePage({ searchParams: Promise.resolve({}) }));
    const art = tileArt(home.doc.querySelector("section#home-categories"));
    expect(art.size).toBeGreaterThan(0);
    for (const [slug, src] of art) expect([slug, src.includes(getCategoryTileArt(slug).path), src.includes("tile-discovery")]).toEqual([slug, true, false]);
  });
});

// ---------------------------------------------------------------------------
// U09 / U10 / U17 product page
// ---------------------------------------------------------------------------

describe("U09/U10/U17 product page", () => {
  async function renderPdp(slug = "canvas-tote-bag") {
    return renderWith(PDP_ACTIONS, () => ProductPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }));
  }

  test("U09: exactly one h1 (the product name), h2 size below md and h1 size from md, balanced, no hyphenation or break-all", async () => {
    const { doc, html } = await renderPdp();
    const h1s = [...doc.querySelectorAll("h1")];
    expect(h1s.length).toBe(1);
    const h1 = h1s[0];
    expect(cls(h1)).toEqual(expect.arrayContaining(["text-h2", "md:text-h1", "text-balance", "break-words"]));
    expect(cls(h1).filter((c) => /h1-lg|hyphens|break-all/.test(c))).toEqual([]);
    expect(html).not.toMatch(/\bhyphens-auto\b/);
    expect(html).not.toMatch(/\bbreak-all\b/);
    expect(html).not.toContain("&shy;");
  });

  test("U10: coupon line is ONE flex row (items-start): icon (shrink-0) and text (flex-1 min-w-0) are siblings", async () => {
    const { doc } = await renderPdp();
    const p = doc.querySelector('[data-slot="buy-box-coupon"]');
    expectNotNull(p);
    expect(cls(p)).toEqual(expect.arrayContaining(["flex", "items-start", "min-w-0"]));
    expect(cls(p).filter((c) => c === "inline-flex" || c === "flex-wrap")).toEqual([]);
    const kids = [...(p?.children ?? [])];
    expect(kids.map((k) => k.tagName.toLowerCase())).toEqual(["svg", "span"]);
    expect(cls(kids[0])).toContain("shrink-0");
    expect(kids[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(cls(kids[1])).toEqual(expect.arrayContaining(["flex-1", "min-w-0"]));
    expect(spokenText(p)).toMatch(/^Save with code \S+: .+/);
  });

  test("U17: wish list button visible 'Add to Wish List' (single spaces), accessible name carries the product name", async () => {
    const { doc } = await renderPdp();
    const name = (doc.querySelector("h1")?.textContent ?? "").trim();
    const btn = [...doc.querySelectorAll("button")].find((b) => /Wish List$/.test(spokenText(b) ?? ""));
    expectNotNull(btn ?? null);
    expect(visibleText(btn)).toBe("Add to Wish List");
    expect((btn?.textContent ?? "").replace(/\s+/g, " ").trim()).toBe(`Add ${name} to Wish List`);
    expect(spokenText(btn)).toBe(`Add ${name} to Wish List`);
  });

  test("U17: signed-in shopper with the product in the wish list sees 'Remove from Wish List' (name in accessible name)", async () => {
    const user = await createSignedInUser(db(), "Wanda Wish", "wanda.wish");
    resetCookies({ sf_auth: user.token });
    const fd = new FormData();
    fd.set("productId", TOTE);
    fd.set("productSlug", "canvas-tote-bag");
    fd.set("listId", "");
    const added = await listActions.addToList(null, fd);
    expect(added !== null && "kind" in added ? added.kind : JSON.stringify(added)).toBe("added");
    const { doc } = await renderPdp();
    const name = (doc.querySelector("h1")?.textContent ?? "").trim();
    const btn = [...doc.querySelectorAll("button")].find((b) => /Wish List$/.test(spokenText(b) ?? ""));
    expect(visibleText(btn)).toBe("Remove from Wish List");
    expect(spokenText(btn)).toBe(`Remove ${name} from Wish List`);
    expect(btn?.getAttribute("aria-pressed")).toBe("true");
  });

  test("BuyBox price keeps the superscript style (only the summaries changed)", async () => {
    const { doc } = await renderPdp();
    expectNotNull(doc.querySelector('[data-slot="price-superscript"]'));
  });
});

// ---------------------------------------------------------------------------
// U06 checkout
// ---------------------------------------------------------------------------

describe("U06 checkout layout inside ONE form", () => {
  async function renderCheckout(cookies: Record<string, string> = { sf_session: GUEST }) {
    resetCookies(cookies);
    return renderWith([placeOrderV2], () => CheckoutPage());
  }

  function theForm(doc: Document): Element {
    const forms = doc.querySelectorAll("form");
    if (forms.length !== 1) throw new Error(`expected 1 form, got ${forms.length}`);
    return forms[0] as Element;
  }

  test("one real POST form holds every control, the review summary, the terms and the only submit 'Place order'", async () => {
    add(GUEST);
    const { doc } = await renderCheckout();
    const f = theForm(doc);
    expect(isRealPostForm(f)).toBe(true);
    const outside = [...doc.querySelectorAll("input, select, textarea, button")].filter((el) => !f.contains(el));
    expect(outside.map((el) => el.getAttribute("name") ?? el.tagName)).toEqual([]);
    expect(f.contains(doc.querySelector("#checkout-step-review"))).toBe(true);
    const submits = [...f.querySelectorAll('button[type="submit"], input[type="submit"]')];
    expect(submits.map((b) => visibleText(b))).toEqual(["Place order"]);
    expect(f.querySelector('a[href="/terms"]')).toBeTruthy();
  });

  test("layout classes: one column below lg, two from lg; steps flex-1 max-w-3xl; review column sticky top-20 basis-80/96; no arbitrary values", async () => {
    add(GUEST);
    const { doc } = await renderCheckout();
    const layout = doc.querySelector('[data-testid="checkout-layout"]');
    const steps = doc.querySelector('[data-testid="checkout-steps"]');
    const review = doc.querySelector('[data-testid="checkout-review-column"]');
    expect(cls(layout)).toEqual(expect.arrayContaining(["flex", "flex-col", "lg:flex-row", "min-w-0"]));
    expect(cls(layout).filter((c) => /^(sm|md):flex-row$/.test(c))).toEqual([]);
    expect(cls(steps)).toEqual(expect.arrayContaining(["lg:flex-1", "lg:max-w-3xl", "min-w-0"]));
    expect(cls(review)).toEqual(expect.arrayContaining(["lg:sticky", "lg:top-20", "lg:shrink-0", "lg:basis-80", "xl:basis-96", "min-w-0"]));
    expect(cls(review).filter((c) => c === "sticky" || /^top-/.test(c))).toEqual([]);
    expect(arbitraryClasses(theForm(doc))).toEqual([]);
    expect(fixedWidthIssues(theForm(doc))).toEqual([]);
  });

  test("DOM (= reading/tab) order: every step -> Review your order -> terms -> Place order", async () => {
    add(GUEST);
    const { doc } = await renderCheckout();
    const ids = ["checkout-step-address", "checkout-step-shipping", "checkout-step-note", "checkout-step-promo", "checkout-step-payment", "checkout-step-review"];
    const heads = ids.map((id) => doc.getElementById(id));
    for (let i = 1; i < heads.length; i += 1) expect([ids[i], precedes(heads[i - 1] ?? null, heads[i] ?? null)]).toEqual([ids[i], true]);
    const terms = doc.querySelector('a[href="/terms"]');
    const submit = doc.querySelector('form button[type="submit"]');
    expect(precedes(doc.getElementById("checkout-step-review"), terms)).toBe(true);
    expect(precedes(terms, submit)).toBe(true);
    // The last focusable element of the form is the submit (nothing after it).
    const focusables = [...theForm(doc).querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea")];
    expect(focusables.at(-1) === submit).toBe(true);
  });

  test("guest: repeated legends are sr-only but present (fieldsets keep their names)", async () => {
    add(GUEST);
    const { doc } = await renderCheckout();
    const legends = [...doc.querySelectorAll("fieldset > legend")].map((l) => [l.textContent, cls(l).includes("sr-only")]);
    expect(legends).toEqual(expect.arrayContaining([["Shipping address", true], ["Payment", true]]));
    // Card headings stay visible.
    for (const id of ["checkout-step-address", "checkout-step-payment"]) expect(cls(doc.getElementById(id))).not.toContain("sr-only");
  });

  test("saved-address mode: 'New shipping address' legend is visible (it does not repeat the card heading)", async () => {
    const user = await createSignedInUser(db(), "Sam Saved", "sam.saved");
    add(user.ownerKey);
    const r = createAddressService({ db: db() }).create(user.ownerKey, {
      fullName: "Sam Saved", line1: "1 Saved St", line2: "", city: "Salem", region: "OR", postalCode: "97301", country: "US", email: undefined, label: "Home",
    });
    if (!r.ok) throw new Error(r.error.code);
    const { doc } = await renderCheckout({ sf_auth: user.token });
    const legend = [...doc.querySelectorAll("fieldset > legend")].find((l) => l.textContent === "New shipping address");
    expectNotNull(legend ?? null);
    expect(cls(legend)).not.toContain("sr-only");
    expect(cls(doc.querySelector('fieldset > legend:not(.sr-only)'))).not.toContain("sr-only");
    const payment = [...doc.querySelectorAll("fieldset > legend")].find((l) => l.textContent === "Payment");
    expect(cls(payment)).toContain("sr-only");
  });

  test("no-JS POST of the rendered form places the order (redirect /orders/<id>?placed=1), stock decremented once", async () => {
    add(GUEST);
    const before = stockOf(db(), TOTE);
    const { doc } = await renderCheckout();
    const body = await browserSubmit(theForm(doc), TYPED_NEW_ADDRESS);
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("url" in out)) throw new Error(`no redirect: ${JSON.stringify(out.state)}`);
    expect(out.url).toMatch(/^\/orders\/[0-9a-f-]{36}\?placed=1/);
    expect(stockOf(db(), TOTE)).toBe(before - 1);
  });

  test("validation errors unchanged: blank name/city -> VALIDATION_FAILED, no order", async () => {
    add(GUEST);
    const { doc } = await renderCheckout();
    const body = await browserSubmit(theForm(doc), { ...TYPED_NEW_ADDRESS, fullName: "", city: "" });
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("state" in out)) throw new Error("unexpected redirect");
    expect(out.state?.error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(out.state?.fieldErrors ?? {})).toEqual(expect.arrayContaining(["fullName", "city"]));
    expect(ordersCount()).toBe(0);
  });

  test("idempotency key: one hidden UUID inside the form, fresh per render; double submit -> one order", async () => {
    add(GUEST);
    const a = await renderCheckout();
    const b = await renderCheckout();
    const key = (d: Document) => theForm(d).querySelectorAll('input[type="hidden"][name="idempotencyKey"]');
    expect(key(a.doc).length).toBe(1);
    const ka = key(a.doc)[0]?.getAttribute("value") ?? "";
    const kb = key(b.doc)[0]?.getAttribute("value") ?? "";
    expect(ka).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ka === kb).toBe(false);
    const before = stockOf(db(), TOTE);
    const body1 = await browserSubmit(theForm(a.doc), TYPED_NEW_ADDRESS);
    const body2 = await browserSubmit(theForm(a.doc), TYPED_NEW_ADDRESS);
    const [r1, r2] = await Promise.all([redirectOrState(() => placeOrderV2(null, body1)), redirectOrState(() => placeOrderV2(null, body2))]);
    if (!("url" in r1) || !("url" in r2)) throw new Error("expected two redirects");
    expect(r1.url).toBe(r2.url);
    expect(ordersCount()).toBe(1);
    expect(stockOf(db(), TOTE)).toBe(before - 1);
  });
});

// ---------------------------------------------------------------------------
// U18 summaries: plain totals on cart, checkout, confirmation, detail, invoice
// ---------------------------------------------------------------------------

describe("U18 summaries: plain '$79.00' totals everywhere, visible = spoken", () => {
  function summaryTotals(doc: Document): Array<{ spoken: string | null; visible: string; superscript: boolean }> {
    return [...doc.querySelectorAll("dt")]
      .filter((d) => /^(Total|Order total|Subtotal.*)$/.test((spokenText(d) ?? "").trim()))
      .map((d) => d.nextElementSibling)
      .map((dd) => ({ spoken: spokenText(dd), visible: visibleText(dd), superscript: dd?.querySelector('[data-slot="price-superscript"]') !== null && dd?.querySelector('[data-slot="price-superscript"]') !== undefined }));
  }

  test("/cart and /checkout: summary totals plain; cards on the page keep superscript", async () => {
    add(GUEST, TOTE, 2);
    const total = usd(cartTotal(GUEST));
    resetCookies({ sf_session: GUEST });
    const cart = await renderWith(CART_ACTIONS, () => CartPage());
    const aside = cart.doc.querySelector('aside[data-testid="cart-summary"]');
    expect(aside?.querySelectorAll('[data-slot="price-superscript"]').length).toBe(0);
    const t = aside?.querySelector('[data-testid="cart-summary-total"]');
    expect([spokenText(t), visibleText(t)]).toEqual([total, total]);
    expectNotNull(cart.doc.querySelector('section[id^="cart-"] [data-slot="price-superscript"]'));

    const checkout = await renderWith([placeOrderV2], () => CheckoutPage());
    const rows = summaryTotals(checkout.doc);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect([r.superscript, r.spoken === r.visible, /\.\d{2}$/.test(r.visible)]).toEqual([false, true, true]);
    expect(rows.some((r) => r.visible === total)).toBe(true);
  });

  test("order confirmation (?placed=1), order detail and invoice: totals plain, visible = spoken", async () => {
    add(GUEST, TOTE, 2);
    const expected = usd(cartTotal(GUEST));
    resetCookies({ sf_session: GUEST });
    const ck = await renderWith([placeOrderV2], () => CheckoutPage());
    const body = await browserSubmit(ck.doc.querySelector("form") as Element, TYPED_NEW_ADDRESS);
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("url" in out)) throw new Error("no redirect");
    const id = /\/orders\/([0-9a-f-]{36})/.exec(out.url)?.[1] ?? "";
    resetCookies({ sf_session: GUEST });
    for (const [name, run] of [
      ["confirmation", () => OrderPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ placed: "1" }) })],
      ["detail", () => OrderPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) })],
      ["invoice", () => InvoicePage({ params: Promise.resolve({ id }) } as never)],
    ] as const) {
      const { doc } = await renderWith([], run as () => Promise<React.ReactNode>);
      const rows = summaryTotals(doc);
      expect([name, rows.length > 0]).toEqual([name, true]);
      for (const r of rows) expect([name, r.superscript, r.spoken, /\.\d{2}$/.test(r.visible)]).toEqual([name, false, r.visible, true]);
      expect([name, rows.some((r) => r.visible === expected)]).toEqual([name, true]);
    }
  });
});
