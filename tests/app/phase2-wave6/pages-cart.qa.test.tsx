/**
 * T111a — QA wave 6, part A: page-level QA of `/cart` (T108) as composed with
 * CartTable + SavedForLaterSection (T82), CartSummary incl. `shippingNotice`
 * (T92 / FIX-org-F), the recommendation rails (T36) and the cart v2 actions
 * (through the page's forms only). QA-owned.
 *
 * The page function is called directly with mocked next/* (see _harness.ts);
 * a `:memory:` DB is seeded through the real services. Structural assertions
 * use `renderToStaticMarkup` + DOMParser.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buttonName,
  countClockReads,
  createSignedInUser,
  placePaidOrder,
  duplicateIds,
  formDataOf,
  harness,
  headingViolations,
  hrefViolations,
  installNextMocks,
  isRealPostForm,
  maxFormDepth,
  parseHtml,
  postedFieldNames,
  resetCookies,
  serverLike,
  smallSubmitButtons,
  totalChanges,
  TOUCH_RE,
  UUID_RE,
  type SignedInUser,
} from "./_harness";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const previousDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const dbClient = await import("@/server/db/client");
const { closeDatabase, getDatabase } = dbClient;
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const { isAllowedInternalHref } = await import("@/content/routes");
const { createCartService, getCartService, SHIPPING_METHOD_DROPPED_NOTICE } = await import("@/server/cart/cart-service");
const { createRecommendationService, getRecommendationService } = await import(
  "@/server/recommendations/recommendation-service"
);
const { formatMoney } = await import("@/lib/money");
const { CHECKOUT_BLOCKED_TEXT } = await import("@/components/organisms/CartSummary");
const cartActions = await import("@/app/actions/cart");
const listActions = await import("@/app/actions/lists");
const pageModule = await import("@/app/cart/page");
const CartPage = pageModule.default;

const spies = {
  getOrCreateSessionId: spyOn(session, "getOrCreateSessionId"),
  rotateGuestSession: spyOn(session, "rotateGuestSession"),
  setAuthCookie: spyOn(session, "setAuthCookie"),
  clearAuthCookie: spyOn(session, "clearAuthCookie"),
};

// Owner keys (v4-shaped guest ids). Never expected in markup.
const OWNER = {
  A: "a1a1a1a1-6666-4666-8666-00000000000a",
  B: "b2b2b2b2-6666-4666-8666-00000000000b",
  EMPTY: "e0e0e0e0-6666-4666-8666-0000000000e0",
  RED: "c3c3c3c3-6666-4666-8666-0000000000c3",
  REDONLY: "c4c4c4c4-6666-4666-8666-0000000000c4",
  UNP: "d5d5d5d5-6666-4666-8666-0000000000d5",
  SHIP: "f6f6f6f6-6666-4666-8666-0000000000f6",
  E2: "e7e7e7e7-6666-4666-8666-0000000000e7",
  CPN: "c8c8c8c8-6666-4666-8666-0000000000c8",
  HC: "b9b9b9b9-6666-4666-8666-0000000000b9",
  FS: "fafafafa-6666-4666-8666-0000000000fa",
  HOST: "abababab-6666-4666-8666-0000000000ab",
  RT: "acacacac-6666-4666-8666-0000000000ac",
  V: "adadadad-6666-4666-8666-0000000000ad",
  SALES: "aeaeaeae-6666-4666-8666-0000000000ae",
} as const;

const HOSTILE_NAME = '<img src=x onerror="alert(1)">Hostile Mug';
const HOSTILE_CODE = "<SCRIPT>ALERT(1)</SCRIPT>";
const QA_METHOD = "qa_courier";
const QA_COUPON = "QADROP15";

interface Prod {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly price: number;
  readonly stock: number;
}

let pool: Prod[] = [];
const used = new Set<string>();
let user: SignedInUser;
let user2: SignedInUser;
const fx: Record<string, Prod> = {};
const savedListId: Record<string, string> = {};

function db() {
  return getDatabase();
}

function svc() {
  return createCartService(db());
}

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }, what: string): T {
  if (!r.ok) throw new Error(`${what}: expected ok, got ${r.error.code}`);
  return r.value;
}

/** Next unused published product matching `pred`. */
function take(key: string, pred: (p: Prod) => boolean = () => true): Prod {
  const p = pool.find((x) => !used.has(x.id) && pred(x));
  if (p === undefined) throw new Error(`fixture: no product for ${key}`);
  used.add(p.id);
  fx[key] = p;
  return p;
}

function P(key: string): Prod {
  const p = fx[key];
  if (p === undefined) throw new Error(`fixture ${key} missing`);
  return p;
}

const usd = (cents: number): string => formatMoney(cents, "USD");

/**
 * Renders the page with every cart/list action marked server-like (production
 * shape: real POST forms). Without it React SSR emits `javascript:` actions
 * plus its form-replay bootstrap script for the client-function actions.
 */
async function renderCart() {
  const restore = serverLike(ALL_ACTIONS);
  try {
    const element = await CartPage();
    const html = renderToStaticMarkup(element);
    return { html, doc: parseHtml(html) };
  } finally {
    restore();
  }
}

function expectNoMint(): void {
  expect(spies.getOrCreateSessionId).not.toHaveBeenCalled();
  expect(spies.rotateGuestSession).not.toHaveBeenCalled();
  expect(spies.setAuthCookie).not.toHaveBeenCalled();
  expect(spies.clearAuthCookie).not.toHaveBeenCalled();
  expect(harness.store.writes).toEqual([]);
}

function summaryAside(doc: Document): Element | null {
  return doc.querySelector('aside[data-testid="cart-summary"]');
}

/** Names shown in the cart line list (the `ul` labelled "Cart items"). */
function lineNames(doc: Document): string[] {
  const heading = [...doc.querySelectorAll("h2")].find((h) => h.textContent === "Cart items");
  if (heading === undefined) return [];
  const ul = doc.querySelector(`ul[aria-labelledby="${heading.id}"]`);
  if (ul === null) return [];
  return [...ul.querySelectorAll(":scope > li")].map((li) => {
    const name = li.querySelector("a, span.font-semibold");
    return (name?.textContent ?? "").trim();
  });
}

function lineItem(doc: Document, name: string): Element {
  const li = [...doc.querySelectorAll("li")].find((l) => (l.querySelector("a, span.font-semibold")?.textContent ?? "") === name);
  if (li === undefined) throw new Error(`no line for ${name}`);
  return li;
}

function savedSection(doc: Document): Element | null {
  const h = [...doc.querySelectorAll("h2")].find((x) => (x.textContent ?? "").startsWith("Saved for later ("));
  return h === undefined ? null : h.closest("section");
}

function savedNames(doc: Document): string[] {
  const section = savedSection(doc);
  if (section === null) return [];
  return [...section.querySelectorAll("ul > li")].map((li) =>
    (li.querySelector("a, span.font-semibold")?.textContent ?? "").trim(),
  );
}

/**
 * Page markup minus the catalogue-wide recommendation rails (best sellers / also bought).
 * Those list public catalogue products, so any seed product may legitimately appear there.
 */
function htmlOutsidePublicRails(doc: Document): string {
  const copy = doc.cloneNode(true) as Document;
  for (const s of copy.querySelectorAll('section[id="cart-also-bought"], section[id="cart-best-sellers"]')) s.remove();
  return copy.documentElement.outerHTML;
}

function railSlugs(doc: Document, id: string): string[] | null {
  const section = doc.querySelector(`section[id="${id}"]`);
  if (section === null) return null;
  return [...section.querySelectorAll("a[href^='/products/']")].map((a) =>
    decodeURIComponent((a.getAttribute("href") ?? "").slice("/products/".length)),
  );
}

/**
 * T173: the text a screen reader speaks for a node — `textContent` with every
 * `[aria-hidden="true"]` subtree removed. Since T161 totals render as a
 * superscript Price (visual `$27<sup>99</sup>` is aria-hidden; the full amount
 * sits in `.sr-only`), so raw `textContent` holds both. Null when absent.
 */
function spokenText(el: Element | null | undefined): string | null {
  if (el === null || el === undefined) return null;
  const clone = el.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** `<dd>` text of the SummaryRow whose `<dt>` starts with `label`. */
function rowValue(root: Element, label: string): string | null {
  const dt = [...root.querySelectorAll("dt")].find((d) => (d.textContent ?? "").startsWith(label));
  return dt?.nextElementSibling?.textContent?.replace(/\s+/g, " ").trim() ?? null;
}

function checkoutLinks(doc: Document): Element[] {
  return [...doc.querySelectorAll("a[href]")].filter((a) => (a.getAttribute("href") ?? "").startsWith("/checkout"));
}

function storedSettings(owner: string): { coupon_code: string | null; shipping_method_id: string | null } | null {
  return db()
    .query<{ coupon_code: string | null; shipping_method_id: string | null }, [string]>(
      "SELECT coupon_code, shipping_method_id FROM carts WHERE session_id = ?",
    )
    .get(owner);
}

function unpublishedSlugs(): string[] {
  return db()
    .query<{ slug: string }, [string]>("SELECT slug FROM products WHERE published_at IS NULL OR published_at > ?")
    .all(new Date().toISOString())
    .map((r) => r.slug);
}

function expectA11y(doc: Document): void {
  expect(headingViolations(doc)).toEqual([]);
  expect(duplicateIds(doc)).toEqual([]);
  expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
}

/** Every owner key / secret that must never reach markup. */
function secrets(): string[] {
  return [...Object.values(OWNER), user.ownerKey, user.token, user.tokenHash, user.email, user2.ownerKey, user2.token, user2.email];
}

const ALL_ACTIONS = [
  cartActions.updateCartQuantity,
  cartActions.removeFromCart,
  cartActions.saveForLater,
  cartActions.moveToCart,
  cartActions.applyCoupon,
  cartActions.removeCoupon,
  cartActions.selectShippingMethod,
  listActions.removeFromList,
  listActions.addToList,
] as const;

beforeAll(async () => {
  closeDatabase();
  const d = getDatabase();
  seedDatabase(d);
  const nowIso = new Date().toISOString();
  pool = d
    .query<{ id: string; slug: string; name: string; price_cents: number; stock: number }, [string]>(
      "SELECT id, slug, name, price_cents, stock FROM products WHERE stock >= 10 AND price_cents >= 1000 AND published_at <= ? ORDER BY id",
    )
    .all(nowIso)
    .map((r) => ({ id: r.id, slug: r.slug, name: r.name, price: r.price_cents, stock: r.stock }));

  const s = svc();
  const recos = createRecommendationService({ db: d });
  const add = (owner: string, p: Prod, qty: number) => must(s.addItem(owner, p.id, qty), `addItem ${owner}`);
  const save = (owner: string, p: Prod) => {
    add(owner, p, 1);
    must(s.saveForLater(owner, p.id), `saveForLater ${owner}`);
  };

  // Owner A: two lines, one saved, WELCOME10, one viewed product.
  add(OWNER.A, take("a0"), 2);
  add(OWNER.A, take("a1"), 1);
  save(OWNER.A, take("a2"));
  must(s.applyCoupon(OWNER.A, "WELCOME10"), "coupon A");
  must(recos.recordView(OWNER.A, take("a3").id, Date.now() - 5_000), "view A");

  // Owner B: lines, saved, SAVE5, viewed.
  add(OWNER.B, take("b0"), 3);
  save(OWNER.B, take("b1"));
  must(s.applyCoupon(OWNER.B, "SAVE5"), "coupon B");
  must(recos.recordView(OWNER.B, take("b2").id, Date.now() - 5_000), "view B");

  // Signed-in users (R-1 + owner-key cart).
  user = await createSignedInUser(d, "Cart Qa Person", "cart.qa.private");
  user2 = await createSignedInUser(d, "Second Qa Person", "cart.qa.second");
  add(user.ownerKey, take("u0"), 1);
  add(user2.ownerKey, take("u2"), 1);

  // Reduced + unavailable (+ ok) lines; reduced-only cart.
  add(OWNER.RED, take("red"), 3);
  add(OWNER.REDONLY, P("red"), 3);
  add(OWNER.RED, take("gone"), 1);
  add(OWNER.RED, take("okline"), 1);
  d.query("UPDATE products SET stock = 2 WHERE id = ?").run(P("red").id);
  d.query("UPDATE products SET stock = 0 WHERE id = ?").run(P("gone").id);

  // R-CART-1: unpublished after it was added (line + saved item).
  add(OWNER.UNP, take("unp"), 2);
  save(OWNER.UNP, take("unpsaved"));
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  d.query("UPDATE products SET published_at = ? WHERE id IN (?, ?)").run(future, P("unp").id, P("unpsaved").id);

  // D-T55-2: stored shipping method later deactivated (with lines / line-less with a saved item).
  d.query(
    "INSERT INTO shipping_methods (id, name, description, price_cents, free_over_cents, min_days, max_days, sort_order, is_active) VALUES (?, 'QA Courier', '', 777, NULL, 3, 4, 9, 1)",
  ).run(QA_METHOD);
  add(OWNER.SHIP, take("ship"), 1);
  must(s.selectShippingMethod(OWNER.SHIP, QA_METHOD), "select SHIP");
  save(OWNER.E2, take("e2saved"));
  must(s.selectShippingMethod(OWNER.E2, QA_METHOD), "select E2");
  d.query("UPDATE shipping_methods SET is_active = 0 WHERE id = ?").run(QA_METHOD);

  // Coupon dropped on read (expired after it was applied).
  d.query("INSERT INTO coupons (code, kind, value, min_subtotal_cents, is_active) VALUES (?, 'percent', 15, 0, 1)").run(QA_COUPON);
  add(OWNER.CPN, take("cpn"), 2);
  must(s.applyCoupon(OWNER.CPN, QA_COUPON), "coupon CPN");
  d.query("UPDATE coupons SET expires_at = ? WHERE code = ?").run(new Date(Date.now() - 60_000).toISOString(), QA_COUPON);

  // Hostile stored coupon code (only reachable by data corruption; renders as text).
  add(OWNER.HC, take("hc"), 1);
  d.query("UPDATE carts SET coupon_code = ? WHERE session_id = ?").run(HOSTILE_CODE, OWNER.HC);

  // Free-shipping progress: subtotal below the standard threshold (3500).
  add(OWNER.FS, take("fs", (p) => p.price >= 1000 && p.price < 3000), 1);

  // Hostile product name.
  add(OWNER.HOST, take("host"), 1);
  d.query("UPDATE products SET name = ? WHERE id = ?").run(HOSTILE_NAME, P("host").id);

  // Sales so best sellers exist (the seed has no orders): one real paid order.
  await placePaidOrder(d, OWNER.SALES, [take("sold").id]);

  // Round-trip owner.
  add(OWNER.RT, take("rt0"), 2);
  add(OWNER.RT, take("rt1"), 1);

  // Recently viewed with one product unpublished afterwards; an empty cart.
  must(recos.recordView(OWNER.V, take("v0").id, Date.now() - 9_000), "view V0");
  must(recos.recordView(OWNER.V, take("v1").id, Date.now() - 8_000), "view V1");
  d.query("UPDATE products SET published_at = ? WHERE id = ?").run(future, P("v1").id);

  const lists = (await import("@/server/lists/list-service")).createListService({ db: d });
  for (const owner of [OWNER.A, OWNER.B, OWNER.UNP, OWNER.E2]) {
    savedListId[owner] = lists.listLists(owner).find((l) => l.kind === "save_for_later")?.id ?? "";
  }
});

beforeEach(() => {
  resetCookies();
  for (const spy of Object.values(spies)) spy.mockClear();
});

afterAll(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
});

// ===========================================================================
// Criterion 1 — cookie scenarios
// ===========================================================================

describe("criterion 1: cookie scenarios (200, right state, no mint, no writes, one clock read)", () => {
  test("no cookie: empty state, no summary, one catalogue DB access (best sellers, D-T108-1), no cookie written", async () => {
    const getDb = spyOn(dbClient, "getDatabase");
    let dbCalls = -1;
    let doc: Document;
    try {
      ({ doc } = await renderCart());
      dbCalls = getDb.mock.calls.length;
    } finally {
      getDb.mockRestore();
    }
    expect(dbCalls).toBe(1); // D-T108-1 (authorised): the one best-seller read; no cart/session read
    expect(doc.querySelector("h1")?.textContent).toBe("Shopping Cart");
    expect(doc.body.textContent).toContain("Your cart is empty");
    expect(summaryAside(doc)).toBeNull();
    expect(checkoutLinks(doc)).toEqual([]);
    expectA11y(doc);
    expectNoMint();
  });

  test("garbage sf_session / sf_auth: same empty state, never rewritten, one catalogue DB access (best sellers, D-T108-1)", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: "../../etc/passwd", [session.AUTH_COOKIE_NAME]: "not-a-token" });
    const getDb = spyOn(dbClient, "getDatabase");
    let dbCalls = -1;
    let doc: Document;
    try {
      ({ doc } = await renderCart());
      dbCalls = getDb.mock.calls.length;
    } finally {
      getDb.mockRestore();
    }
    expect(dbCalls).toBe(1); // D-T108-1 (authorised): the one best-seller read; no cart/session read
    expect(doc.body.textContent).toContain("Your cart is empty");
    expect(summaryAside(doc)).toBeNull();
    expectNoMint();
  });

  test("garbage sf_auth with a valid guest cookie: the guest cart (auth ignored), nothing rewritten", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.A, [session.AUTH_COOKIE_NAME]: "x".repeat(43) });
    const before = totalChanges(db());
    const { doc } = await renderCart();
    expect(lineNames(doc)).toEqual(expect.arrayContaining([P("a0").name, P("a1").name]));
    expect(totalChanges(db())).toBe(before);
    expectNoMint();
  });

  test("valid guest: lines + saved + coupon; no DB write; no mint", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.A });
    const before = totalChanges(db());
    const { doc } = await renderCart();
    expect(totalChanges(db())).toBe(before);
    expect(lineNames(doc).sort()).toEqual([P("a0").name, P("a1").name].sort());
    expect(savedNames(doc)).toEqual([P("a2").name]);
    expect(summaryAside(doc)?.textContent).toContain("WELCOME10");
    expectA11y(doc);
    expectNoMint();
  });

  test("valid guest id with no cart row: empty state (with suggestions), no write, no mint", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.EMPTY });
    const before = totalChanges(db());
    const { doc } = await renderCart();
    expect(totalChanges(db())).toBe(before);
    expect(doc.body.textContent).toContain("Your cart is empty");
    expect(summaryAside(doc)).toBeNull();
    expect(railSlugs(doc, "cart-best-sellers")?.length ?? 0).toBeGreaterThan(0);
    expectNoMint();
  });

  test("signed-in user: the cart held under the owner key; no write, no mint, no secrets", async () => {
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
    const before = totalChanges(db());
    const { html, doc } = await renderCart();
    expect(totalChanges(db())).toBe(before);
    expect(lineNames(doc)).toEqual([P("u0").name]);
    for (const secret of secrets()) expect(html).not.toContain(secret);
    expect(html).not.toContain(user.displayName);
    expectNoMint();
  });

  test("signed-in user with a guest cookie too: the user's cart wins (guest A's lines absent)", async () => {
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token, [session.SESSION_COOKIE_NAME]: OWNER.A });
    const { doc } = await renderCart();
    expect(lineNames(doc)).toEqual([P("u0").name]);
    expect(savedNames(doc)).toEqual([]);
    expectNoMint();
  });

  test("R-1: guest cookie equal to a user's owner key reads as no cookie (empty), no rotation during render", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: user.ownerKey });
    const before = totalChanges(db());
    const { html, doc } = await renderCart();
    expect(totalChanges(db())).toBe(before);
    expect(doc.body.textContent).toContain("Your cart is empty");
    expect(lineNames(doc)).toEqual([]);
    expect(html).not.toContain(P("u0").name);
    expect(html).not.toContain(user.ownerKey);
    expectNoMint();
  });

  test("status 200 shape: the page function resolves to an element for every cookie state (never throws)", async () => {
    const states: Record<string, string>[] = [
      {},
      { [session.SESSION_COOKIE_NAME]: "" },
      { [session.SESSION_COOKIE_NAME]: "A1A1A1A1-6666-4666-8666-00000000000A" },
      { [session.SESSION_COOKIE_NAME]: "x".repeat(5000) },
      { [session.AUTH_COOKIE_NAME]: user.token.slice(0, -2) },
      { [session.AUTH_COOKIE_NAME]: user2.token },
    ];
    for (const cookies of states) {
      resetCookies(cookies);
      const { doc } = await renderCart();
      expect(doc.querySelector("h1")?.textContent).toBe("Shopping Cart");
    }
    expectNoMint();
  });

  test("`now` is read once per render (guest with lines, coupon, saved item and rails)", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.A });
    const { reads, stacks } = await countClockReads(async () => renderToStaticMarkup(await CartPage()));
    if (reads !== 1) console.info(`[T111a] clock reads during /cart render: ${reads}\n  ${stacks.join("\n  ")}`);
    expect(reads).toBe(1);
  });

  // PIN: D-T108-3 (fixed in FIX-cart-page) — the cart service judges publication with its OWN clock (a second read of Date.now,
  // captured by reference so the Date swap above cannot see it); rails/coupon/arrivals use the loader's `now`.
  test("D-T108-3: the cart service is not consulted for a second clock during render", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.A });
    const service = getCartService() as unknown as { now: () => number };
    const clock = spyOn(service, "now");
    try {
      await renderCart();
      expect(clock.mock.calls.length).toBe(0);
    } finally {
      clock.mockRestore();
    }
  });
});

// ===========================================================================
// Criterion 2 — isolation
// ===========================================================================

describe("criterion 2: isolation between owners", () => {
  test("owner A never sees B's lines, saved items, coupon or recently viewed", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.A });
    const { html, doc } = await renderCart();
    expect(lineNames(doc)).not.toContain(P("b0").name);
    expect(savedNames(doc)).not.toContain(P("b1").name);
    expect(html).not.toContain("SAVE5");
    expect(railSlugs(doc, "cart-recently-viewed")).toEqual([P("a3").slug]);
    for (const id of html.match(UUID_RE) ?? []) expect([savedListId[OWNER.A]]).toContain(id);
    expect(html).not.toContain(savedListId[OWNER.B] ?? "missing");
  });

  test("owner B never sees A's lines, saved items, coupon or recently viewed", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.B });
    const { html, doc } = await renderCart();
    expect(lineNames(doc)).toEqual([P("b0").name]);
    expect(savedNames(doc)).toEqual([P("b1").name]);
    expect(html).toContain("SAVE5");
    expect(html).not.toContain("WELCOME10");
    expect(railSlugs(doc, "cart-recently-viewed")).toEqual([P("b2").slug]);
    for (const id of html.match(UUID_RE) ?? []) expect([savedListId[OWNER.B]]).toContain(id);
  });

  test("two signed-in users each see only their own owner-key cart", async () => {
    resetCookies({ [session.AUTH_COOKIE_NAME]: user2.token });
    const second = await renderCart();
    expect(lineNames(second.doc)).toEqual([P("u2").name]);
    expect(htmlOutsidePublicRails(second.doc)).not.toContain(P("u0").name);
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
    const first = await renderCart();
    expect(lineNames(first.doc)).toEqual([P("u0").name]);
  });
});

// ===========================================================================
// Criterion 3 — states
// ===========================================================================

describe("criterion 3: states", () => {
  test("empty cart: empty state + continue link + best sellers, no summary, no checkout link", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.EMPTY });
    const { doc } = await renderCart();
    const empty = [...doc.querySelectorAll("h2")].find((h) => h.textContent === "Your cart is empty");
    expect(empty).toBeDefined();
    const links = [...doc.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toContainEqual(["Continue shopping", "/"]);
    expect(summaryAside(doc)).toBeNull();
    expect(checkoutLinks(doc)).toEqual([]);
    expect(railSlugs(doc, "cart-best-sellers")?.length ?? 0).toBeGreaterThan(0);
    expectA11y(doc);
  });

  // PIN: D-T108-1 (fixed in FIX-cart-page) — a first-time visitor (no cookie) gets no best-seller suggestions on the empty cart (T108 AC6).
  test("D-T108-1: empty cart with no cookie shows suggestions (best sellers) like any other empty cart", async () => {
    const { doc } = await renderCart();
    expect(railSlugs(doc, "cart-best-sellers")?.length ?? 0).toBeGreaterThan(0);
  });

  test("line-less cart with a saved item + deactivated stored method: page-level shipping notice once, link to saved items", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.E2 });
    const first = await renderCart();
    const notices = [...first.doc.querySelectorAll('[role="status"]')].filter((n) =>
      (n.textContent ?? "").includes(SHIPPING_METHOD_DROPPED_NOTICE),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.closest("aside")).toBeNull();
    expect(first.html.split(SHIPPING_METHOD_DROPPED_NOTICE).length - 1).toBe(1);
    expect(summaryAside(first.doc)).toBeNull();
    expect(savedNames(first.doc)).toEqual([P("e2saved").name]);
    const saved = [...first.doc.querySelectorAll("a")].find((a) => (a.textContent ?? "").startsWith("View your saved items"));
    expect(saved?.textContent).toBe("View your saved items (1)");
    expect(saved?.getAttribute("href")).toBe(`/lists/${savedListId[OWNER.E2]}`);
    expect(storedSettings(OWNER.E2)?.shipping_method_id).toBeNull();
    const second = await renderCart();
    expect(second.html).not.toContain(SHIPPING_METHOD_DROPPED_NOTICE);
    expectA11y(first.doc);
  });

  test("lines + saved items render together; saved row offers Move to cart / Delete", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.A });
    const { doc } = await renderCart();
    const section = savedSection(doc);
    expect(section?.querySelector("h2")?.textContent).toBe("Saved for later (1 item)");
    const names = [...(section?.querySelectorAll("button") ?? [])].map(buttonName);
    expect(names).toEqual(expect.arrayContaining([`Move to cart: ${P("a2").name}`, `Delete: ${P("a2").name}`]));
  });

  test("reduced + unavailable lines: reason text, line notices, checkout blocked, no checkout link", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.RED });
    const { doc } = await renderCart();
    const aside = summaryAside(doc);
    expect(aside?.getAttribute("data-can-checkout")).toBe("false");
    expect(aside?.querySelector('[data-testid="cart-summary-blocked"]')?.textContent).toBe(
      CHECKOUT_BLOCKED_TEXT.someUnavailable,
    );
    expect(checkoutLinks(doc)).toEqual([]);
    expect(lineItem(doc, P("red").name).textContent).toContain("Only 2 left. Lower the quantity to continue.");
    expect(lineItem(doc, P("gone").name).textContent).toContain("No longer available");
    expectA11y(doc);
  });

  test("reduced-only cart: 'reduced' reason, no checkout link", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.REDONLY });
    const { doc } = await renderCart();
    expect(summaryAside(doc)?.querySelector('[data-testid="cart-summary-blocked"]')?.textContent).toBe(
      CHECKOUT_BLOCKED_TEXT.reduced,
    );
    expect(checkoutLinks(doc)).toEqual([]);
  });

  test("R-CART-1: product unpublished after adding renders unavailable, no product link, zero line total, no checkout", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.UNP });
    const { doc } = await renderCart();
    const li = lineItem(doc, P("unp").name);
    expect(li.querySelector("a")).toBeNull();
    expect(li.textContent).toContain("No longer available");
    expect(li.querySelector('[data-testid="line-total"]')?.textContent).toBe(usd(0));
    const aside = summaryAside(doc);
    expect(rowValue(aside as Element, "Subtotal")).toBe(usd(0));
    expect(aside?.querySelector('[data-testid="cart-summary-blocked"]')?.textContent).toBe(
      CHECKOUT_BLOCKED_TEXT.allUnavailable,
    );
    expect(checkoutLinks(doc)).toEqual([]);
    expect(doc.querySelector(`a[href="/products/${P("unp").slug}"]`)).toBeNull();
  });

  // PIN: D-T45-1 (fixed in FIX-cart-page) — an all-unavailable cart still quotes shipping, so "zero totals" fails: Total shows the shipping price.
  test("D-T45-1: R-CART-1 cart with only an unavailable line shows a zero Shipping and Total", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.UNP });
    const { doc } = await renderCart();
    const aside = summaryAside(doc) as Element;
    // T173: spoken text (superscript Price since T161); visual-only digits are aria-hidden.
    expect(spokenText(aside.querySelector('[data-testid="cart-summary-total"]'))).toBe(usd(0));
  });

  // PIN: D-T82-4 (fixed in FIX-cart-page) — a saved item whose product was unpublished still links to its (404) product page.
  test("D-T82-4: saved item for an unpublished product has no product link (R-CART-1 parity)", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.UNP });
    const { doc } = await renderCart();
    const section = savedSection(doc) as Element;
    // Boolean assertion: printing a happy-dom Element in a failure message takes seconds.
    expect(section.querySelector(`a[href="/products/${P("unpsaved").slug}"]`) === null).toBe(true);
  });

  test("D-T55-2: deactivated stored method -> notice once inside CartSummary (role=status), id cleared, gone next render", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.SHIP });
    expect(storedSettings(OWNER.SHIP)?.shipping_method_id).toBe(QA_METHOD);
    const first = await renderCart();
    const aside = summaryAside(first.doc) as Element;
    const notice = aside.querySelector('[data-testid="cart-summary-shipping-notice"]');
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain(SHIPPING_METHOD_DROPPED_NOTICE);
    expect(first.html.split(SHIPPING_METHOD_DROPPED_NOTICE).length - 1).toBe(1);
    expect(storedSettings(OWNER.SHIP)?.shipping_method_id).toBeNull();
    // Falls back to the cheapest active method; the dead method is not offered.
    expect(first.html).not.toContain("QA Courier");
    const second = await renderCart();
    expect(second.html).not.toContain(SHIPPING_METHOD_DROPPED_NOTICE);
    expect(summaryAside(second.doc)?.getAttribute("data-total-check")).toBe("match");
  });

  test("dropped coupon: one-time warning Notice (role=alert) rendered once, stored code cleared, gone next render", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.CPN });
    const first = await renderCart();
    const expected = `Promo code ${QA_COUPON} has expired and was removed from your cart.`;
    const alerts = [...first.doc.querySelectorAll('[role="alert"]')].filter((n) => (n.textContent ?? "").includes(expected));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.getAttribute("data-tone")).toBe("warning");
    expect(first.html.split(expected).length - 1).toBe(1);
    expect(storedSettings(OWNER.CPN)?.coupon_code).toBeNull();
    expect(rowValue(summaryAside(first.doc) as Element, "Discount")).toBeNull();
    const second = await renderCart();
    expect(second.html).not.toContain(expected);
  });
});

// ===========================================================================
// Criterion 4 — forms (no-JS shape)
// ===========================================================================

const ALLOWED_FIELDS = new Set(["productId", "quantity", "couponCode", "shippingMethodId", "listId", "productSlug"]);

async function renderWithServerActions(owner: string) {
  const restore = serverLike(ALL_ACTIONS);
  try {
    resetCookies({ [session.SESSION_COOKIE_NAME]: owner });
    return await renderCart();
  } finally {
    restore();
  }
}

describe("criterion 4: mutation forms are real POST forms with contract fields only", () => {
  for (const [label, owner] of [
    ["lines + saved + applied coupon (owner A)", OWNER.A],
    ["no coupon, apply form (owner FS)", OWNER.FS],
    ["reduced/unavailable lines (owner RED)", OWNER.RED],
    ["line-less with saved item (owner E2)", OWNER.E2],
  ] as const) {
    test(`shape: ${label}`, async () => {
      const { html, doc } = await renderWithServerActions(owner);
      const forms = [...doc.querySelectorAll("form")];
      expect(forms.length).toBeGreaterThan(0);
      expect(maxFormDepth(html)).toBe(1);
      expect(forms.filter((f) => !isRealPostForm(f)).map((f) => f.outerHTML.slice(0, 120))).toEqual([]);
      for (const form of forms) {
        for (const name of postedFieldNames(form)) expect(ALLOWED_FIELDS.has(name)).toBe(true);
        for (const input of form.querySelectorAll("input")) {
          const value = input.getAttribute("value") ?? "";
          for (const secret of secrets()) expect(value).not.toBe(secret);
          expect(["sessionId", "ownerKey", "session_id", "owner_key"]).not.toContain(input.getAttribute("name") ?? "");
        }
      }
      // Every submit button has a unique accessible name (per product context).
      const names = [...doc.querySelectorAll('button[type="submit"]')].map(buttonName);
      expect(names.every((n) => n !== "")).toBe(true);
      expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    });
  }

  test("owner A: every expected mutation is present (update, remove, save, move, delete saved, coupon remove, shipping)", async () => {
    const { doc } = await renderWithServerActions(OWNER.A);
    const names = [...doc.querySelectorAll('button[type="submit"]')].map(buttonName);
    for (const p of [P("a0"), P("a1")]) {
      expect(names).toContain(`Update quantity for ${p.name}`);
      expect(names).toContain(`Remove ${p.name}`);
      expect(names).toContain(`Save for later: ${p.name}`);
    }
    expect(names).toContain(`Move to cart: ${P("a2").name}`);
    expect(names).toContain(`Delete: ${P("a2").name}`);
    expect(names).toContain("Remove promo code WELCOME10");
    expect(names).toContain("Update shipping method");
    const fsDoc = (await renderWithServerActions(OWNER.FS)).doc;
    expect([...fsDoc.querySelectorAll('button[type="submit"]')].map(buttonName)).toContain("Apply");
    const coupon = fsDoc.querySelector('input[name="couponCode"]');
    expect(coupon?.getAttribute("maxlength")).toBe("32");
    expect(coupon?.getAttribute("id")).toBeTruthy();
    expect(fsDoc.querySelector(`label[for="${coupon?.getAttribute("id") ?? ""}"]`)?.textContent).toContain("Promo code");
  });

  test("quantity inputs have programmatic labels naming the product", async () => {
    const { doc } = await renderWithServerActions(OWNER.A);
    for (const input of doc.querySelectorAll('input[name="quantity"]')) {
      const id = input.getAttribute("id") ?? "";
      const label = doc.querySelector(`label[for="${id}"]`)?.textContent ?? input.getAttribute("aria-label") ?? "";
      expect(label).toMatch(/^Quantity for /);
    }
  });

  test("round trip via the page's own forms: save for later -> saved section; move to cart -> back in the cart", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.RT });
    const restore = serverLike(ALL_ACTIONS);
    try {
      const page1 = await renderCart();
      const saveBtn = [...page1.doc.querySelectorAll("button")].find((b) => buttonName(b) === `Save for later: ${P("rt1").name}`);
      const saveForm = saveBtn?.closest("form");
      if (saveForm === null || saveForm === undefined) throw new Error("save form missing");
      const saved = await cartActions.saveForLater(null, formDataOf(saveForm));
      expect(saved?.ok).toBe(true);
      const page2 = await renderCart();
      expect(lineNames(page2.doc)).toEqual([P("rt0").name]);
      expect(savedNames(page2.doc)).toEqual([P("rt1").name]);
      const moveBtn = [...page2.doc.querySelectorAll("button")].find((b) => buttonName(b) === `Move to cart: ${P("rt1").name}`);
      const moveForm = moveBtn?.closest("form");
      if (moveForm === null || moveForm === undefined) throw new Error("move form missing");
      const moved = await cartActions.moveToCart(null, formDataOf(moveForm));
      expect(moved?.ok).toBe(true);
      const page3 = await renderCart();
      expect(lineNames(page3.doc).sort()).toEqual([P("rt0").name, P("rt1").name].sort());
      expect(savedNames(page3.doc)).toEqual([]);
      expect(harness.store.writes).toEqual([]);
    } finally {
      restore();
    }
  });

  test("coupon via the page's form: invalid code -> one generic error, previous coupon kept; valid code updates totals", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.RT });
    const restore = serverLike(ALL_ACTIONS);
    try {
      const page1 = await renderCart();
      const input = page1.doc.querySelector('input[name="couponCode"]');
      const form = input?.closest("form");
      if (form === null || form === undefined || input === null) throw new Error("coupon form missing");
      input.setAttribute("value", "WELCOME10");
      expect((await cartActions.applyCoupon(null, formDataOf(form)))?.ok).toBe(true);
      const page2 = await renderCart();
      const view = must(svc().getCartView(OWNER.RT, Date.now()), "view RT");
      expect(view.totals.discountCents).toBeGreaterThan(0);
      // T173: spoken text (superscript Price since T161).
      expect(spokenText(summaryAside(page2.doc)?.querySelector('[data-testid="cart-summary-total"]'))).toBe(
        usd(view.totals.totalCents),
      );
      // Invalid code posted through the same field name.
      const fd = new FormData();
      fd.append("couponCode", "NOPE-NOT-REAL");
      const bad = await cartActions.applyCoupon(null, fd);
      expect(bad?.ok).toBe(false);
      if (bad?.ok === false) expect(bad.error.message).toBe("That promo code is not valid.");
      const page3 = await renderCart();
      expect(summaryAside(page3.doc)?.textContent).toContain("WELCOME10");
      // Remove via the page's remove form.
      const removeBtn = [...page3.doc.querySelectorAll("button")].find((b) => buttonName(b) === "Remove promo code WELCOME10");
      const removeForm = removeBtn?.closest("form");
      if (removeForm === null || removeForm === undefined) throw new Error("remove coupon form missing");
      expect((await cartActions.removeCoupon(null, formDataOf(removeForm)))?.ok).toBe(true);
      expect(summaryAside((await renderCart()).doc)?.textContent).not.toContain("WELCOME10");
    } finally {
      restore();
    }
  });
});

// ===========================================================================
// Criterion 5 — totals
// ===========================================================================

describe("criterion 5: totals equal the service view", () => {
  for (const [label, owner] of [
    ["owner A (percent coupon)", OWNER.A],
    ["owner B (fixed coupon)", OWNER.B],
    ["owner RED (reduced + unavailable)", OWNER.RED],
    ["owner FS (below free-shipping threshold)", OWNER.FS],
    ["signed-in user", "user"],
  ] as const) {
    test(`${label}: data-total-check=match and every row equals getCartView`, async () => {
      const key = owner === "user" ? user.ownerKey : owner;
      resetCookies(owner === "user" ? { [session.AUTH_COOKIE_NAME]: user.token } : { [session.SESSION_COOKIE_NAME]: owner });
      const { doc } = await renderCart();
      const view = must(svc().getCartView(key, Date.now()), "view");
      const aside = summaryAside(doc) as Element;
      expect(doc.querySelectorAll("[data-total-check]")).toHaveLength(1);
      expect(aside.getAttribute("data-total-check")).toBe("match");
      expect(rowValue(aside, "Subtotal")).toBe(usd(view.totals.subtotalCents));
      if (view.totals.discountCents > 0) {
        expect(aside.querySelector('[data-testid="cart-summary-discount"]')?.textContent).toBe(`−minus ${usd(view.totals.discountCents)}`);
      } else {
        expect(aside.querySelector('[data-testid="cart-summary-discount"]')).toBeNull();
      }
      const shipping = rowValue(aside, "Shipping") ?? "";
      expect(shipping.endsWith(view.totals.shippingCents === 0 ? "Free" : usd(view.totals.shippingCents))).toBe(true);
      // T173: spoken text (superscript Price since T161).
      expect(spokenText(aside.querySelector('[data-testid="cart-summary-total"]'))).toBe(usd(view.totals.totalCents));
      expect(view.totals.totalCents).toBe(view.totals.subtotalCents - view.totals.discountCents + view.totals.shippingCents);
      // Line totals use billable quantities.
      for (const line of view.items) {
        const li = lineItem(doc, line.name);
        expect(li.querySelector('[data-testid="line-total"]')?.textContent).toBe(usd(line.lineTotalCents));
      }
    });
  }

  test("reduced line is billed at available stock (2), not the stored quantity (3)", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.REDONLY });
    const { doc } = await renderCart();
    const li = lineItem(doc, P("red").name);
    expect(li.querySelector('[data-testid="line-total"]')?.textContent).toBe(usd(P("red").price * 2));
    expect(rowValue(summaryAside(doc) as Element, "Subtotal")).toBe(usd(P("red").price * 2));
  });

  test("free-shipping progress follows the selected method: standard shows the remaining amount; express hides it", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.FS });
    const restore = serverLike(ALL_ACTIONS);
    try {
      const page1 = await renderCart();
      const aside1 = summaryAside(page1.doc) as Element;
      const price = P("fs").price;
      expect(aside1.textContent).toContain(`Add ${usd(3500 - price)} more for free shipping`);
      expect(rowValue(aside1, "Shipping")).toContain(usd(499));
      const checked = aside1.querySelector('input[name="shippingMethodId"][checked]');
      expect(checked?.getAttribute("value")).toBe("standard");
      // Choose express through the page's shipping form.
      const form = aside1.querySelector('input[name="shippingMethodId"]')?.closest("form");
      if (form === null || form === undefined) throw new Error("shipping form missing");
      for (const radio of form.querySelectorAll('input[name="shippingMethodId"]')) {
        if (radio.getAttribute("value") === "express") radio.setAttribute("checked", "");
        else radio.removeAttribute("checked");
      }
      expect((await cartActions.selectShippingMethod(null, formDataOf(form)))?.ok).toBe(true);
      const page2 = await renderCart();
      const aside2 = summaryAside(page2.doc) as Element;
      expect(aside2.textContent).not.toContain("more for free shipping");
      expect(rowValue(aside2, "Shipping")).toContain(usd(999));
      // T173: spoken text (superscript Price since T161).
      expect(spokenText(aside2.querySelector('[data-testid="cart-summary-total"]'))).toBe(usd(price + 999));
      expect(aside2.getAttribute("data-total-check")).toBe("match");
      // Back to standard.
      const fd = new FormData();
      fd.append("shippingMethodId", "standard");
      expect((await cartActions.selectShippingMethod(null, fd))?.ok).toBe(true);
      const page3 = await renderCart();
      expect(summaryAside(page3.doc)?.textContent).toContain(`Add ${usd(3500 - price)} more for free shipping`);
    } finally {
      restore();
    }
  });

  test("above the threshold the standard method reads Free and the progress says qualified", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.A });
    const { doc } = await renderCart();
    const view = must(svc().getCartView(OWNER.A, Date.now()), "view A");
    const aside = summaryAside(doc) as Element;
    if (view.shipping?.method.id === "standard" && view.totals.subtotalCents >= 3500) {
      expect(aside.textContent).toContain("You've got free shipping!");
      expect(rowValue(aside, "Shipping")?.endsWith("Free")).toBe(true);
    } else {
      expect(view.totals.amountToFreeShippingCents === null || view.totals.amountToFreeShippingCents > 0).toBe(true);
    }
  });
});

// ===========================================================================
// Criterion 6 — recommendations rail
// ===========================================================================

describe("criterion 6: recommendation rails", () => {
  test("also-bought rail excludes the cart's own products and never shows unpublished products", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.A });
    const { doc } = await renderCart();
    const slugs = railSlugs(doc, "cart-also-bought") ?? [];
    expect(slugs.length).toBeGreaterThan(0);
    expect(slugs).not.toContain(P("a0").slug);
    expect(slugs).not.toContain(P("a1").slug);
    const hidden = new Set(unpublishedSlugs());
    for (const s of slugs) expect(hidden.has(s)).toBe(false);
  });

  test("recently viewed: only the owner's own history; an unpublished viewed product is dropped", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.V });
    const { doc } = await renderCart();
    expect(railSlugs(doc, "cart-recently-viewed")).toEqual([P("v0").slug]);
    const hidden = new Set(unpublishedSlugs());
    for (const a of doc.querySelectorAll("a[href^='/products/']")) {
      expect(hidden.has(decodeURIComponent((a.getAttribute("href") ?? "").slice("/products/".length)))).toBe(false);
    }
  });

  test("no unpublished product appears in any rail for any owner", async () => {
    const hidden = new Set(unpublishedSlugs());
    for (const owner of [OWNER.A, OWNER.B, OWNER.UNP, OWNER.RED, OWNER.EMPTY, OWNER.V]) {
      resetCookies({ [session.SESSION_COOKIE_NAME]: owner });
      const { doc } = await renderCart();
      for (const id of ["cart-also-bought", "cart-recently-viewed", "cart-best-sellers"]) {
        for (const s of railSlugs(doc, id) ?? []) expect(hidden.has(s)).toBe(false);
      }
    }
  });

  test("rails absent when the service returns nothing; a throwing recommender empties only its rail", async () => {
    const service = getRecommendationService();
    const forCart = spyOn(service, "forCart").mockReturnValue([]);
    const recent = spyOn(service, "recentlyViewed").mockImplementation(() => {
      throw new Error("qa recommender failure");
    });
    try {
      resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.A });
      const { doc } = await renderCart();
      expect(railSlugs(doc, "cart-also-bought")).toBeNull();
      expect(railSlugs(doc, "cart-recently-viewed")).toBeNull();
      expect(lineNames(doc).length).toBe(2);
      expect(summaryAside(doc)).not.toBeNull();
      // Called only with the owner's own key.
      for (const call of [...forCart.mock.calls, ...recent.mock.calls]) expect(call[0]).toBe(OWNER.A);
    } finally {
      forCart.mockRestore();
      recent.mockRestore();
    }
  });

  test("no cookie: recommender never consulted", async () => {
    const service = getRecommendationService();
    const forCart = spyOn(service, "forCart");
    const recent = spyOn(service, "recentlyViewed");
    try {
      const { doc } = await renderCart();
      expect(railSlugs(doc, "cart-also-bought")).toBeNull();
      expect(forCart).not.toHaveBeenCalled();
      expect(recent).not.toHaveBeenCalled();
    } finally {
      forCart.mockRestore();
      recent.mockRestore();
    }
  });
});

// ===========================================================================
// Criterion 7 — hygiene
// ===========================================================================

describe("criterion 7: hygiene", () => {
  test("no owner key, token, email or other-owner ids in markup across states; only own list ids as UUIDs", async () => {
    const cases: Array<[Record<string, string>, readonly string[]]> = [
      [{}, []],
      [{ [session.SESSION_COOKIE_NAME]: OWNER.A }, [savedListId[OWNER.A] ?? ""]],
      [{ [session.SESSION_COOKIE_NAME]: OWNER.UNP }, [savedListId[OWNER.UNP] ?? ""]],
      [{ [session.SESSION_COOKIE_NAME]: OWNER.E2 }, [savedListId[OWNER.E2] ?? ""]],
      [{ [session.SESSION_COOKIE_NAME]: OWNER.RED }, []],
      [{ [session.AUTH_COOKIE_NAME]: user.token }, []],
      [{ [session.SESSION_COOKIE_NAME]: user.ownerKey }, []],
    ];
    for (const [cookies, allowed] of cases) {
      resetCookies(cookies);
      const { html } = await renderWithAllActions();
      for (const secret of secrets()) expect(html).not.toContain(secret);
      for (const id of html.match(UUID_RE) ?? []) expect(allowed).toContain(id.toLowerCase());
    }
  });

  test("hostile product name renders as text (line, thumbnail alt, button names)", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.HOST });
    const { html, doc } = await renderCart();
    expect(doc.querySelector("img[src='x']")).toBeNull();
    expect(doc.querySelector("[onerror]")).toBeNull();
    expect(html).not.toContain("<img src=x");
    expect(lineNames(doc)).toEqual([HOSTILE_NAME]);
  });

  test("hostile stored coupon code renders as text in the drop notice; no script element", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.HC });
    const { html, doc } = await renderCart();
    expect(doc.querySelector("script")).toBeNull();
    expect(html).not.toContain(HOSTILE_CODE);
    const alert = [...doc.querySelectorAll('[role="alert"]')].find((n) => (n.textContent ?? "").includes(HOSTILE_CODE));
    expect(alert?.textContent).toContain(`Promo code ${HOSTILE_CODE} is no longer valid`);
  });

  test("applied coupon description renders as plain text next to the code", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER.A });
    const view = must(svc().getCartView(OWNER.A, Date.now()), "view A");
    const { doc } = await renderCart();
    expect(summaryAside(doc)?.textContent).toContain(view.coupon?.description ?? "missing");
  });

  for (const [label, cookies] of [
    ["no cookie", {}],
    ["empty guest", { [session.SESSION_COOKIE_NAME]: OWNER.EMPTY }],
    ["lines + saved", { [session.SESSION_COOKIE_NAME]: OWNER.A }],
    ["blocked", { [session.SESSION_COOKIE_NAME]: OWNER.RED }],
    ["line-less saved", { [session.SESSION_COOKIE_NAME]: OWNER.E2 }],
  ] as const) {
    test(`structure (${label}): one h1, no skipped levels, unique ids/landmarks, allow-listed hrefs, 44px controls`, async () => {
      resetCookies(cookies);
      const { doc } = await renderWithAllActions();
      expectA11y(doc);
      // Landmark names unique: aside/section/nav with accessible names.
      const landmarkNames: string[] = [];
      for (const el of doc.querySelectorAll("aside, nav, section[aria-labelledby], section[aria-label], main")) {
        const by = el.getAttribute("aria-labelledby");
        const name = by !== null ? (doc.getElementById(by)?.textContent ?? "") : (el.getAttribute("aria-label") ?? "");
        landmarkNames.push(`${el.tagName.toLowerCase()}:${name.trim()}`);
      }
      expect(landmarkNames.filter((n, i) => landmarkNames.indexOf(n) !== i)).toEqual([]);
      expect(doc.querySelectorAll("main")).toHaveLength(0); // the root layout owns <main>
      expect(smallSubmitButtons(doc)).toEqual([]);
      const smallControls = [...doc.querySelectorAll('button[type="button"]')]
        .filter((b) => !TOUCH_RE.test(b.getAttribute("class") ?? ""))
        .map(buttonName);
      expect(smallControls).toEqual([]);
    });
  }

  // PIN: D-T108-2 (fixed in FIX-cart-page) — "View your saved items (N)" link on the empty cart has no 44px touch class.
  test("D-T108-2: in-cart text links (product names, saved-items link) carry a touch class", async () => {
    const offenders: string[] = [];
    for (const owner of [OWNER.A, OWNER.E2]) {
      resetCookies({ [session.SESSION_COOKIE_NAME]: owner });
      const { doc } = await renderCart();
      for (const a of doc.querySelectorAll("a[href]")) {
        if (a.closest('nav[aria-label="Breadcrumb"]') !== null) continue;
        if (a.closest("section[id^='cart-']") !== null) continue; // rail cards: card-sized targets
        if (!TOUCH_RE.test(a.getAttribute("class") ?? "")) offenders.push(`${a.textContent ?? ""} -> ${a.getAttribute("href") ?? ""}`);
      }
    }
    if (offenders.length > 0) console.info(`[T111a] links without a touch class: ${offenders.join(" | ")}`);
    expect(offenders).toEqual([]);
  });

  test("keyboard: no positive tabindex, no click-only pseudo buttons, every enabled control focusable", async () => {
    for (const owner of [OWNER.A, OWNER.RED, OWNER.E2]) {
      resetCookies({ [session.SESSION_COOKIE_NAME]: owner });
      const { doc } = await renderCart();
      const positive = [...doc.querySelectorAll("[tabindex]")].filter((el) => Number(el.getAttribute("tabindex")) > 0);
      expect(positive.length).toBe(0);
      expect(doc.querySelectorAll('div[role="button"], span[role="button"], a:not([href])').length).toBe(0);
      expect(doc.querySelectorAll('button[tabindex="-1"], input[tabindex="-1"]').length).toBe(0);
    }
  });

  test("metadata: noindex, canonical /cart", () => {
    const m = pageModule.metadata;
    expect(m.robots).toMatchObject({ index: false });
    const canonical = m.alternates?.canonical;
    expect(String(canonical ?? "")).toMatch(/\/cart$/);
  });
});

async function renderWithAllActions() {
  const restore = serverLike(ALL_ACTIONS);
  try {
    return await renderCart();
  } finally {
    restore();
  }
}
