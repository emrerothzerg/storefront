/**
 * T104a — QA wave 5, page-level: Home `/` (T96). QA-owned.
 * Criteria: T104 1, 4, 7 (+ T96 1–4). Page function called directly with
 * mocked next/* (see _harness.ts), `:memory:` DB seeded through real services.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createSignedInUser,
  duplicateFormNames,
  duplicateIds,
  harness,
  headingViolations,
  hrefViolations,
  installNextMocks,
  parseHtml,
  placePaidOrder,
  resetCookies,
  smallSubmitButtons,
  totalChanges,
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
const currentUser = await import("@/server/session/current-user");
const { isAllowedInternalHref } = await import("@/content/routes");
const { getListingService } = await import("@/server/catalog/listing-service");
const { SqliteBrandRepository } = await import("@/server/catalog/brand-repository");
const { getRecommendationService, createRecommendationService } = await import(
  "@/server/recommendations/recommendation-service"
);
const { getOrderService } = await import("@/server/orders/order-service");
const { HomeDataUnavailableError, RAIL_TITLES } = await import("@/app/_lib/home");
const { default: HomePage } = await import("@/app/page");

const spies = {
  readSessionId: spyOn(session, "readSessionId"),
  getOrCreateSessionId: spyOn(session, "getOrCreateSessionId"),
  rotateGuestSession: spyOn(session, "rotateGuestSession"),
  setAuthCookie: spyOn(session, "setAuthCookie"),
  clearAuthCookie: spyOn(session, "clearAuthCookie"),
  readCurrentUser: spyOn(currentUser, "readCurrentUser"),
};
const restorers: Array<() => void> = [];

const OWNER_A = "a1a1a1a1-0000-4000-8000-00000000000a";
const OWNER_B = "b2b2b2b2-0000-4000-8000-00000000000b";

let products: { id: string; slug: string }[] = [];
let user: SignedInUser;
const idemKeys: string[] = [];

function slugHref(slug: string): string {
  return `/products/${encodeURIComponent(slug)}`;
}

async function renderHome(): Promise<{ html: string; doc: Document }> {
  const html = renderToStaticMarkup(await HomePage());
  return { html, doc: parseHtml(html) };
}

function railHrefs(doc: Document, railId: string): string[] | null {
  const section = doc.getElementById(`home-${railId}`);
  if (section === null) return null;
  return [...section.querySelectorAll("a[href^='/products/']")].map((a) => a.getAttribute("href") ?? "");
}

/** T172 pin move (T166): the v3 home has one tabbed `#top-picks` rail instead of one section per rail. */
function topPicksHrefs(doc: Document): string[] {
  return [...(doc.getElementById("top-picks")?.querySelectorAll("a[href^='/products/']") ?? [])].map((a) => a.getAttribute("href") ?? "");
}

/** Label of the `aria-current="page"` tab link inside `#top-picks` (null when none). */
function currentTab(doc: Document): string | null {
  return doc.getElementById("top-picks")?.querySelector('a[aria-current="page"][href^="/?rail="]')?.textContent?.trim() ?? null;
}

function h2Texts(doc: Document): string[] {
  return [...doc.querySelectorAll("h2")].map((h) => (h.textContent ?? "").trim());
}

function expectNoMint(): void {
  expect(spies.getOrCreateSessionId).not.toHaveBeenCalled();
  expect(spies.rotateGuestSession).not.toHaveBeenCalled();
  expect(spies.setAuthCookie).not.toHaveBeenCalled();
  expect(spies.clearAuthCookie).not.toHaveBeenCalled();
  expect(harness.store.writes).toEqual([]);
}

function expectA11yBasics(doc: Document): void {
  expect(headingViolations(doc)).toEqual([]);
  expect(duplicateIds(doc)).toEqual([]);
  expect(duplicateFormNames(doc)).toEqual([]);
  expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
  expect(smallSubmitButtons(doc)).toEqual([]);
}

beforeEach(async () => {
  closeDatabase();
  const db = getDatabase();
  seedDatabase(db);
  products = db
    .query<{ id: string; slug: string }, []>(
      "SELECT id, slug FROM products WHERE stock > 5 AND published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY id LIMIT 8",
    )
    .all();
  expect(products.length).toBe(8);
  user = await createSignedInUser(db, "Quinta Signedin", "quinta.signedin");
  resetCookies();
  for (const spy of Object.values(spies)) spy.mockClear();
});

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

afterAll(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
  while (restorers.length > 0) restorers.pop()?.();
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
});

/** Owner A views p0,p1 and bought p2; owner B views p3,p4 and bought p5 (all via real services). */
async function seedTwoOwners(): Promise<void> {
  const db = getDatabase();
  const reco = createRecommendationService({ db });
  const t = Date.now() - 120_000;
  const [p0, p1, p2, p3, p4, p5] = products;
  if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined || p4 === undefined || p5 === undefined) {
    throw new Error("fixture products missing");
  }
  for (const [owner, id, offset] of [
    [OWNER_A, p0.id, 0],
    [OWNER_A, p1.id, 1],
    [OWNER_B, p3.id, 2],
    [OWNER_B, p4.id, 3],
  ] as const) {
    const r = reco.recordView(owner, id, t + offset * 1000);
    expect(r.ok).toBe(true);
  }
  idemKeys.push((await placePaidOrder(db, OWNER_A, [p2.id])).idempotencyKey);
  idemKeys.push(
    (
      await placePaidOrder(db, OWNER_B, [p5.id], {
        fullName: "Bertha Otherowner",
        email: "bertha.otherowner@example.test",
        line1: "99 Foreign Lane QA",
        city: "Elsewhereqa",
        region: "WA",
        postalCode: "98001",
        country: "US",
      })
    ).idempotencyKey,
  );
}

describe("home / — no cookie (T104-1, T96-1)", () => {
  test("200 shape: one h1, catalog rails, no personal rails, Best Sellers hidden on a fresh seed; nothing minted", async () => {
    const recentlyViewed = spyOn(getRecommendationService(), "recentlyViewed");
    const buyAgain = spyOn(getOrderService(), "getBuyAgainLines");
    restorers.push(() => recentlyViewed.mockRestore(), () => buyAgain.mockRestore());
    const before = totalChanges(getDatabase());

    const { doc } = await renderHome();

    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    for (const id of ["recently-viewed", "buy-again", "inspired", "best-sellers"]) expect(railHrefs(doc, id)).toBeNull();
    // T172 pin move (T166): the deals products now sit in `#top-picks`, whose Deals tab is current on a
    // fresh seed (no paid orders, so Best sellers is empty and the default falls to the first non-empty tab).
    expect(currentTab(doc)).toBe("Deals");
    expect(topPicksHrefs(doc).length).toBeGreaterThan(0);
    expect(h2Texts(doc)).not.toContain(RAIL_TITLES["best-sellers"]);
    expect(recentlyViewed).not.toHaveBeenCalled();
    expect(buyAgain).not.toHaveBeenCalled();
    expect(totalChanges(getDatabase())).toBe(before);
    expect(spies.readSessionId).toHaveBeenCalledTimes(1);
    expectNoMint();
    expectA11yBasics(doc);
  });

  test("garbage cookies (guest + auth) behave exactly like no cookie and are never rewritten", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: "not-a-uuid'; DROP TABLE products;--", [session.AUTH_COOKIE_NAME]: "garbage" });
    const { doc } = await renderHome();
    for (const id of ["recently-viewed", "buy-again", "inspired"]) expect(railHrefs(doc, id)).toBeNull();
    expect(getDatabase().query<{ n: number }, []>("SELECT count(*) AS n FROM products").get()?.n ?? 0).toBeGreaterThan(0);
    expectNoMint();
  });

  test("every product link resolves to an existing published slug", async () => {
    const { doc } = await renderHome();
    const slugs = new Set(getDatabase().query<{ slug: string }, []>("SELECT slug FROM products").all().map((r) => r.slug));
    const links = [...doc.querySelectorAll("a[href^='/products/']")];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) expect(slugs.has(decodeURIComponent((a.getAttribute("href") ?? "").slice(10)))).toBe(true);
  });
});

describe("home / — personal rails use only the session's own data (T104-4)", () => {
  test("guest owner A sees only A's views and purchases; owner B's never appear; no PII/keys in markup", async () => {
    await seedTwoOwners();
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const before = totalChanges(getDatabase());
    const { html, doc } = await renderHome();
    const [p0, p1, p2, p3, p4, p5] = products;

    const recent = railHrefs(doc, "recently-viewed") ?? [];
    expect(recent).toContain(slugHref(p0?.slug ?? ""));
    expect(recent).toContain(slugHref(p1?.slug ?? ""));
    // T172 pin move (T166): the v3 home has no buy-again rail; A's purchase (p2) is not shown anywhere personal.
    expect(doc.getElementById("home-buy-again")).toBeNull();
    expect(recent).not.toContain(slugHref(p2?.slug ?? ""));
    for (const foreign of [p3, p4, p5]) {
      expect(recent).not.toContain(slugHref(foreign?.slug ?? ""));
    }
    expect(totalChanges(getDatabase())).toBe(before);
    for (const secret of [OWNER_A, OWNER_B, user.ownerKey, user.token, user.tokenHash, ...idemKeys, "Bertha", "Zelda", "Foreign Lane", "Evergreen"]) {
      expect(html).not.toContain(secret);
    }
    expect(html.match(UUID_RE)).toBeNull();
    expectNoMint();
    expectA11yBasics(doc);
  });

  test("owner B sees only B's items (symmetry)", async () => {
    await seedTwoOwners();
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_B });
    const { doc } = await renderHome();
    const [p0, p1, p2, p3, p4, p5] = products;
    const recent = railHrefs(doc, "recently-viewed") ?? [];
    expect(recent).toEqual(expect.arrayContaining([slugHref(p3?.slug ?? ""), slugHref(p4?.slug ?? "")]));
    // T172 pin move (T166): no buy-again rail on the v3 home; B's purchase (p5) is not shown anywhere personal.
    expect(doc.getElementById("home-buy-again")).toBeNull();
    expect(recent).not.toContain(slugHref(p5?.slug ?? ""));
    for (const foreign of [p0, p1, p2]) {
      expect(recent).not.toContain(slugHref(foreign?.slug ?? ""));
    }
  });

  test("signed-in user: rails read through the owner key; no owner key, token, hash, email or name in markup", async () => {
    const db = getDatabase();
    const p6 = products[6];
    if (p6 === undefined) throw new Error("fixture");
    expect(createRecommendationService({ db }).recordView(user.ownerKey, p6.id, Date.now() - 1000).ok).toBe(true);
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
    const { html, doc } = await renderHome();
    expect(railHrefs(doc, "recently-viewed")).toContain(slugHref(p6.slug));
    for (const secret of [user.ownerKey, user.token, user.tokenHash, user.email, user.passwordHash, user.userId]) {
      expect(html).not.toContain(secret);
    }
    expect(html.match(UUID_RE)).toBeNull();
    expectNoMint();
  });

  test("foreign id: a guest cookie equal to a user's owner key (R-1) gets no personal rails", async () => {
    const db = getDatabase();
    const p6 = products[6];
    if (p6 === undefined) throw new Error("fixture");
    createRecommendationService({ db }).recordView(user.ownerKey, p6.id, Date.now() - 1000);
    resetCookies({ [session.SESSION_COOKIE_NAME]: user.ownerKey });
    const { doc } = await renderHome();
    expect(railHrefs(doc, "recently-viewed")).toBeNull();
    expect(railHrefs(doc, "buy-again")).toBeNull();
    expectNoMint();
  });

  test("valid-shape cookie with no history: no personal rails, no write", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: "c3c3c3c3-0000-4000-8000-00000000000c" });
    const before = totalChanges(getDatabase());
    const { doc } = await renderHome();
    for (const id of ["recently-viewed", "buy-again", "inspired"]) expect(railHrefs(doc, id)).toBeNull();
    expect(totalChanges(getDatabase())).toBe(before);
    expectNoMint();
  });
});

describe("home / — reader isolation and failure (T96-3/4)", () => {
  // T172 pin move (T166): each breaker names the markers its reader feeds on the v3 home. A rail reader
  // feeds its `#top-picks` tab link (deals also the hero deal panel and the deals ItemList); categories
  // feed the department rail and category discovery. The coupons breaker was removed: the v3 home no
  // longer reads coupons (the promoted coupon lives in the header benefits strip).
  type Breaker = { name: string; targets: readonly string[]; install: () => void };
  const boom = () => {
    throw new Error("qa reader failure");
  };
  const breakers: Breaker[] = [
    {
      name: "deals",
      targets: ["tab:deals", "hero-deal", "deals-itemlist"],
      install: () => restorers.push(spyRestore(spyOn(getListingService(), "deals").mockImplementation(boom))),
    },
    { name: "bestSellers", targets: ["tab:best-sellers"], install: () => restorers.push(spyRestore(spyOn(getListingService(), "bestSellers").mockImplementation(boom))) },
    { name: "newArrivals", targets: ["tab:new-arrivals"], install: () => restorers.push(spyRestore(spyOn(getListingService(), "newArrivals").mockImplementation(boom))) },
    { name: "topRated", targets: ["tab:top-rated"], install: () => restorers.push(spyRestore(spyOn(getListingService(), "topRated").mockImplementation(boom))) },
    {
      name: "categories",
      targets: ["home-categories", "home-discovery"],
      install: () => restorers.push(spyRestore(spyOn(getListingService(), "categoryTree").mockImplementation(boom))),
    },
    { name: "brands", targets: ["home-brands"], install: () => restorers.push(spyRestore(spyOn(SqliteBrandRepository.prototype, "listWithCounts").mockImplementation(boom))) },
  ];

  function spyRestore(spy: { mockRestore: () => void }): () => void {
    return () => spy.mockRestore();
  }

  const TAB_IDS = ["best-sellers", "deals", "new-arrivals", "top-rated"] as const;
  const SECTION_IDS = ["home-categories", "home-discovery", "home-brands", "home-promo"] as const;

  /** Markers present on the page, in a fixed order (sections by id or id prefix, tabs by href, deal panel, ItemList). */
  function sectionIds(doc: Document): string[] {
    const out: string[] = [];
    for (const id of TAB_IDS) if (doc.querySelector(`#top-picks a[href="/?rail=${id}#top-picks"]`) !== null) out.push(`tab:${id}`);
    if (doc.getElementById("home-hero-deal-heading") !== null) out.push("hero-deal");
    const itemList = [...doc.querySelectorAll('script[type="application/ld+json"]')].some((el) => (el.textContent ?? "").includes('"ItemList"'));
    if (itemList) out.push("deals-itemlist");
    for (const id of SECTION_IDS) if (doc.getElementById(id) !== null || doc.querySelector(`[id^="${id}"]`) !== null) out.push(id);
    return out;
  }

  test.each(breakers.map((b) => [b.name, b] as const))("a failing %s reader drops only its own section", async (_n, breaker) => {
    await placePaidOrder(getDatabase(), OWNER_B, [products[7]?.id ?? ""]);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    restorers.push(() => errors.mockRestore());
    const baseline = sectionIds((await renderHome()).doc);
    for (const target of breaker.targets) expect(baseline).toContain(target);
    // `[id^="home-promo"]` matches the promo pair (`home-promo-pair`), which no reader feeds: it must survive.
    expect(baseline).toContain("home-promo");

    breaker.install();
    const { doc } = await renderHome();
    const after = sectionIds(doc);
    for (const target of breaker.targets) expect(after).not.toContain(target);
    expect(after).toEqual(baseline.filter((id) => !breaker.targets.includes(id)));
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(errors.mock.calls.map((c) => String(c[0]))).toEqual([`[home] home.read_failed.${breaker.name}`]);
  });

  test("every catalog reader failing -> HomeDataUnavailableError (route renders error.tsx / 500)", async () => {
    for (const b of breakers) b.install();
    const errors = spyOn(console, "error").mockImplementation(() => {});
    restorers.push(() => errors.mockRestore());
    const err: unknown = await HomePage().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HomeDataUnavailableError);
    expectNoMint();
  });

  // T172 pin move (T166): Best sellers is a `#top-picks` tab; it becomes the current (default) tab with
  // products once one real paid order exists, and is not current before that.
  test("Best Sellers rail hidden without paid orders, shown after one real paid order", async () => {
    const fresh = (await renderHome()).doc;
    expect(currentTab(fresh)).not.toBe("Best sellers");
    await placePaidOrder(getDatabase(), OWNER_B, [products[7]?.id ?? ""]);
    const after = (await renderHome()).doc;
    expect(currentTab(after)).toBe("Best sellers");
    expect(topPicksHrefs(after)).toContain(slugHref(products[7]?.slug ?? ""));
  });
});
