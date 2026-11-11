/**
 * T104a — QA wave 5, page-level: Product detail `/products/[slug]` (T97). QA-owned.
 * Criteria: T104 1, 3, 7 (+ T97 1, 3, 5, 6). Page function called directly with
 * mocked next/* (see _harness.ts), `:memory:` DB seeded through real services.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  createSignedInUser,
  duplicateFormNames,
  duplicateIds,
  harness,
  headingViolations,
  hrefViolations,
  installNextMocks,
  isRealPostForm,
  outcomeOf,
  parseHtml,
  resetCookies,
  serverLike,
  smallSubmitButtons,
  totalChanges,
  UUID_RE,
  type SignedInUser,
} from "./_harness";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const previousDatabasePath = env.DATABASE_PATH;
const previousSiteUrl = env.NEXT_PUBLIC_SITE_URL;
env.DATABASE_PATH = ":memory:";
env.NEXT_PUBLIC_SITE_URL = "https://qa-shop.example.com";
const SITE = "https://qa-shop.example.com";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const currentUser = await import("@/server/session/current-user");
const { isAllowedInternalHref } = await import("@/content/routes");
const { SqliteProductRepository } = await import("@/server/catalog/product-repository");
const { getRecommendationService } = await import("@/server/recommendations/recommendation-service");
const { createReviewService } = await import("@/server/reviews/review-service");
const { createQaService } = await import("@/server/qa/qa-service");
const { createListService } = await import("@/server/lists/list-service");
const { createStockAlertService } = await import("@/server/alerts/stock-alert-service");
const reviewActions = await import("@/app/actions/reviews");
const qaActions = await import("@/app/actions/questions");
const cartActions = await import("@/app/actions/cart");
const listActions = await import("@/app/actions/lists");
const alertActions = await import("@/app/actions/stock-alerts");
const { default: ProductPage } = await import("@/app/products/[slug]/page");

const spies = {
  readSessionId: spyOn(session, "readSessionId"),
  getOrCreateSessionId: spyOn(session, "getOrCreateSessionId"),
  rotateGuestSession: spyOn(session, "rotateGuestSession"),
  setAuthCookie: spyOn(session, "setAuthCookie"),
  clearAuthCookie: spyOn(session, "clearAuthCookie"),
  readCurrentUser: spyOn(currentUser, "readCurrentUser"),
};
const getDetailBySlug = spyOn(SqliteProductRepository.prototype, "getDetailBySlug");
let recordView: ReturnType<typeof spyOn<ReturnType<typeof getRecommendationService>, "recordView">>;

const OWNER_A = "a1a1a1a1-1111-4111-8111-00000000000a";
const OWNER_B = "b2b2b2b2-1111-4111-8111-00000000000b";
const HOSTILE_REVIEW = '</script><script>alert("rv")</script><img src=x onerror="alert(1)"> & <!-- end';
const HOSTILE_QUESTION = 'Does it <script>alert("q")</script> fit <img src=y onerror=alert(2)> inside?';

let slug = "";
let productId = "";
let user: SignedInUser;
let restoreForms: () => void = () => {};

function views(owner: string): number {
  return (
    getDatabase()
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM product_views WHERE session_id = ?")
      .get(owner)?.n ?? -1
  );
}

async function render(s: string = slug, searchParams: Record<string, string | string[]> = {}) {
  const outcome = await outcomeOf(() => ProductPage({ params: Promise.resolve({ slug: s }), searchParams: Promise.resolve(searchParams) }));
  if (outcome.kind !== "ok") return { outcome, html: "", doc: parseHtml("") };
  const html = renderToStaticMarkup(outcome.value);
  return { outcome, html, doc: parseHtml(html) };
}

/**
 * PDP hrefs: allow-listed internal routes / resolvable `#id`s, plus the BuyBox
 * share `mailto:` (no recipient; body = canonical product URL only).
 */
function pdpHrefViolations(doc: Document): string[] {
  return hrefViolations(doc, (href) => {
    if (isAllowedInternalHref(href)) return true;
    if (!href.startsWith("mailto:?")) return false;
    const body = new URLSearchParams(href.slice("mailto:?".length)).get("body") ?? "";
    return body.endsWith(`${SITE}/products/${slug}`) && body.match(UUID_RE) === null;
  });
}

function ldScripts(doc: Document): HTMLScriptElement[] {
  return [...doc.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')];
}

function expectNoMint(): void {
  expect(spies.getOrCreateSessionId).not.toHaveBeenCalled();
  expect(spies.rotateGuestSession).not.toHaveBeenCalled();
  expect(spies.setAuthCookie).not.toHaveBeenCalled();
  expect(spies.clearAuthCookie).not.toHaveBeenCalled();
  expect(harness.store.writes).toEqual([]);
}

function storedSessionIds(): string[] {
  const db = getDatabase();
  return db
    .query<{ s: string }, []>("SELECT session_id AS s FROM reviews UNION SELECT session_id FROM questions UNION SELECT session_id FROM answers")
    .all()
    .map((r) => r.s);
}

beforeAll(async () => {
  closeDatabase();
  const db = getDatabase();
  seedDatabase(db);
  // The published, in-stock product with the most questions (so answer/vote forms render) and reviews.
  const row = db
    .query<{ id: string; slug: string }, []>(
      `SELECT p.id, p.slug FROM products p
         WHERE p.stock > 0 AND p.published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
         ORDER BY (SELECT count(*) FROM questions q WHERE q.product_id = p.id) DESC,
                  (SELECT count(*) FROM reviews r WHERE r.product_id = p.id) DESC
         LIMIT 1`,
    )
    .get();
  if (row === null) throw new Error("no product");
  slug = row.slug;
  productId = row.id;
  const reviews = createReviewService({ db });
  const created = reviews.create(OWNER_B, { productId, rating: 2, title: "Hostile <b>title</b>", body: HOSTILE_REVIEW, displayName: "Bee <i>Name</i>" });
  if (!created.ok) throw new Error(`review: ${created.error.code}`);
  const asked = createQaService({ db }).ask(OWNER_B, { productId, body: HOSTILE_QUESTION, displayName: "Asker" });
  if (!asked.ok) throw new Error(`ask: ${asked.error.code}`);
  // Owner B private state on this product: a named wish list and a stock alert.
  const lists = createListService({ db });
  // Two lists so WishlistButton renders its "Save to" picker for owner B (positive control).
  if (!lists.createList(OWNER_B, "Secret list of owner B").ok) throw new Error("list");
  if (!lists.createList(OWNER_B, "Second list of owner B").ok) throw new Error("list");
  user = await createSignedInUser(db, "Pdp Signedin Person", "pdp.signedin");
  recordView = spyOn(getRecommendationService(), "recordView");
});

beforeEach(() => {
  resetCookies();
  for (const spy of Object.values(spies)) spy.mockClear();
  getDetailBySlug.mockClear();
  recordView.mockClear();
});

afterAll(() => {
  restoreForms();
  for (const spy of Object.values(spies)) spy.mockRestore();
  getDetailBySlug.mockRestore();
  recordView.mockRestore();
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
  if (previousSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
});

describe("PDP — 404 paths (T97-1)", () => {
  const hostile: Array<[string, string]> = [
    ["path traversal", "../../etc/passwd"],
    ["encoded traversal", "..%2F..%2Fetc"],
    ["upper case", slug.toUpperCase() || "ABC"],
    ["script", "<script>alert(1)</script>"],
    ["10k chars", "a".repeat(10_000)],
    ["sql", "x' OR '1'='1"],
    ["control chars", "abc\u0000\u0007def"],
    ["empty", ""],
  ];

  test.each(hostile)("hostile slug (%s) -> notFound() without a catalog query", async (_n, s) => {
    const { outcome } = await render(s);
    expect(outcome.kind).toBe("notFound");
    expect(getDetailBySlug).not.toHaveBeenCalled();
    expect(recordView).not.toHaveBeenCalled();
  });

  test("unknown well-formed slug -> notFound()", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const { outcome } = await render("qa-no-such-product-slug");
    expect(outcome.kind).toBe("notFound");
    expect(getDetailBySlug).toHaveBeenCalled(); // positive control for the hostile-slug cases
    expect(recordView).not.toHaveBeenCalled();
    expectNoMint();
  });

  test("unpublished (future published_at) -> notFound() and no view recorded, even with a cookie", async () => {
    const db = getDatabase();
    const other = db
      .query<{ id: string; slug: string; published_at: string }, [string]>("SELECT id, slug, published_at FROM products WHERE id != ? LIMIT 1")
      .get(productId);
    if (other === null) throw new Error("fixture");
    db.query("UPDATE products SET published_at = ? WHERE id = ?").run(new Date(Date.now() + 86_400_000).toISOString(), other.id);
    try {
      resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
      const before = views(OWNER_A);
      const { outcome } = await render(other.slug);
      expect(outcome.kind).toBe("notFound");
      expect(views(OWNER_A)).toBe(before);
      expect(recordView).not.toHaveBeenCalled();
    } finally {
      db.query("UPDATE products SET published_at = ? WHERE id = ?").run(other.published_at, other.id);
    }
  });
});

describe("PDP — JSON-LD (T104-3, T97-3)", () => {
  test("exactly one ld+json script; JSON.parse -> [Product, BreadcrumbList]; absolute URLs; no owner data", async () => {
    const { doc, html } = await render();
    const scripts = ldScripts(doc);
    expect(scripts).toHaveLength(1);
    const raw = scripts[0]?.textContent ?? "";
    expect(raw).not.toContain("<");
    const parsed: unknown = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    const graphs = parsed as Array<Record<string, unknown>>;
    expect(graphs.map((g) => g["@type"])).toEqual(["Product", "BreadcrumbList"]);
    const [productLd, crumbs] = graphs as [Record<string, unknown>, Record<string, unknown>];

    expect(productLd["@context"]).toBe("https://schema.org");
    expect(typeof productLd.name).toBe("string");
    expect(productLd.url).toBe(`${SITE}/products/${slug}`);
    const images = productLd.image as unknown[];
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) expect(String(img).startsWith(`${SITE}/`)).toBe(true);
    const offers = productLd.offers as Record<string, unknown>;
    expect(typeof offers.price).toBe("string");
    expect(String(offers.price)).toMatch(/^\d+\.\d{2}$/);
    expect(offers.priceCurrency).toMatch(/^[A-Z]{3}$/);
    expect(offers.availability).toBe("https://schema.org/InStock");
    expect(offers.url).toBe(`${SITE}/products/${slug}`);
    const agg = productLd.aggregateRating as Record<string, unknown> | undefined;
    expect(agg?.["@type"]).toBe("AggregateRating");
    expect(Number(agg?.ratingCount)).toBeGreaterThan(0);
    const reviews = (productLd.review as Array<Record<string, unknown>> | undefined) ?? [];
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.length).toBeLessThanOrEqual(5);
    expect(reviews.some((r) => r.reviewBody === HOSTILE_REVIEW)).toBe(true);

    const items = crumbs.itemListElement as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    items.forEach((item, i) => {
      expect(item.position).toBe(i + 1);
      expect(String(item.item).startsWith(`${SITE}/`)).toBe(true);
    });
    expect(items[0]?.item).toBe(`${SITE}/`);
    expect(items[items.length - 1]?.item).toBe(`${SITE}/products/${slug}`);

    // No owner data anywhere in the JSON-LD or markup.
    for (const secret of [OWNER_A, OWNER_B, ...storedSessionIds()]) {
      expect(raw).not.toContain(secret);
      expect(html).not.toContain(secret);
    }
    expect(raw.match(UUID_RE)).toBeNull();
  });

  test("out-of-stock product: availability OutOfStock (T97-2)", async () => {
    const db = getDatabase();
    const oos = db.query<{ id: string; slug: string; stock: number }, [string]>("SELECT id, slug, stock FROM products WHERE id != ? AND stock > 0 LIMIT 1").get(productId);
    if (oos === null) throw new Error("fixture");
    db.query("UPDATE products SET stock = 0 WHERE id = ?").run(oos.id);
    try {
      const { doc } = await render(oos.slug);
      const graphs = JSON.parse(ldScripts(doc)[0]?.textContent ?? "[]") as Array<{ offers?: { availability?: string } }>;
      expect(graphs[0]?.offers?.availability).toBe("https://schema.org/OutOfStock");
    } finally {
      db.query("UPDATE products SET stock = ? WHERE id = ?").run(oos.stock, oos.id);
    }
  });
});

describe("PDP — hostile UGC renders escaped (T104-3)", () => {
  test("review and question text appear as text; no injected elements or scripts", async () => {
    const { doc, html } = await render();
    expect(doc.querySelector("img[src='x']")).toBeNull();
    expect(doc.querySelector("img[src='y']")).toBeNull();
    // React's own form-replay bootstrap (emitted for function actions) is the only allowed non-JSON-LD script.
    const foreignScripts = [...doc.querySelectorAll("script:not([type='application/ld+json'])")].filter(
      (sc) => !(sc.textContent ?? "").startsWith('addEventListener("submit"'),
    );
    expect(foreignScripts).toHaveLength(0);
    for (const sc of doc.querySelectorAll("script:not([type='application/ld+json'])")) {
      expect(sc.textContent ?? "").not.toContain("alert(");
    }
    expect(doc.querySelector("b")).toBeNull();
    expect(doc.body.textContent).toContain(HOSTILE_REVIEW);
    expect(doc.body.textContent).toContain(HOSTILE_QUESTION);
    expect(html).not.toContain('<img src="x"');
    expect(html).not.toContain("<script>alert");
  });
});

describe("PDP — cookie scenarios and view recording (T104-1/3, T97-5)", () => {
  test("no cookie: no view recorded, no DB writes, nothing minted, recently-viewed rail absent", async () => {
    const before = totalChanges(getDatabase());
    const { doc } = await render();
    expect(recordView).not.toHaveBeenCalled();
    expect(totalChanges(getDatabase())).toBe(before);
    expect(doc.getElementById("rail-recently-viewed")).toBeNull();
    expect(spies.readSessionId).toHaveBeenCalledTimes(1);
    expectNoMint();
  });

  test("garbage cookies: treated as none, nothing rewritten", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: "garbage", [session.AUTH_COOKIE_NAME]: "x".repeat(43) });
    const before = totalChanges(getDatabase());
    await render();
    expect(recordView).not.toHaveBeenCalled();
    expect(totalChanges(getDatabase())).toBe(before);
    expectNoMint();
  });

  test("valid guest cookie: exactly one view recorded per render; repeat render keeps one history row", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    await render();
    expect(recordView).toHaveBeenCalledTimes(1);
    expect(recordView.mock.calls[0]?.[0]).toBe(OWNER_A);
    expect(recordView.mock.calls[0]?.[1]).toBe(productId);
    await render();
    expect(recordView).toHaveBeenCalledTimes(2);
    expect(
      getDatabase()
        .query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM product_views WHERE session_id = ? AND product_id = ?")
        .get(OWNER_A, productId)?.n,
    ).toBe(1);
    expectNoMint();
  });

  test("signed-in: view recorded under the owner key; no owner key/token/hash/email in markup", async () => {
    resetCookies({ [session.AUTH_COOKIE_NAME]: user.token });
    const { html } = await render();
    expect(recordView).toHaveBeenCalledTimes(1);
    expect(recordView.mock.calls[0]?.[0]).toBe(user.ownerKey);
    for (const secret of [user.ownerKey, user.token, user.tokenHash, user.email, user.passwordHash, user.userId]) {
      expect(html).not.toContain(secret);
    }
    expectNoMint();
  });

  test("foreign data: owner A never sees owner B's list names or wish-list state", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const { html } = await render();
    expect(html).not.toContain("Secret list of owner B");
    expect(html).not.toContain(OWNER_B);
    // Positive control: owner B does see its own list in the buy box.
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_B });
    const own = await render();
    expect(own.html).toContain("Secret list of owner B");
  });

  test("owner B's stock alert is not reflected on owner A's page", async () => {
    const db = getDatabase();
    const oos = db.query<{ id: string; slug: string; stock: number }, [string]>("SELECT id, slug, stock FROM products WHERE id != ? AND stock > 0 LIMIT 1 OFFSET 3").get(productId);
    if (oos === null) throw new Error("fixture");
    db.query("UPDATE products SET stock = 0 WHERE id = ?").run(oos.id);
    try {
      const sub = createStockAlertService({ db }).subscribe(OWNER_B, oos.id);
      expect(sub.ok).toBe(true);
      resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_B });
      const mine = await render(oos.slug);
      resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
      const theirs = await render(oos.slug);
      const alertIdRows = db.query<{ id: string }, [string]>("SELECT id FROM stock_alerts WHERE session_id = ?").all(OWNER_B);
      expect(alertIdRows.length).toBe(1);
      // Positive control: B's own page carries its alert (unsubscribe form); A's never does.
      expect(mine.html).toContain(alertIdRows[0]?.id ?? "missing");
      for (const r of alertIdRows) expect(theirs.html).not.toContain(r.id);
    } finally {
      db.query("UPDATE products SET stock = ? WHERE id = ?").run(oos.stock, oos.id);
    }
  });
});

describe("PDP — no-JS forms and a11y basics (T97-4/6, T104-7)", () => {
  // D-T97-1 (fixed in CONS-B2): ReviewForm (write-review) now hands useActionState the raw server
  // action until mounted, so SSR emits a real POST form (method, multipart enctype, no javascript:).
  test("reviews and Q&A sections render their mutation forms as real POST forms", async () => {
    restoreForms = serverLike([
      reviewActions.submitReview,
      reviewActions.voteReviewHelpful,
      qaActions.askQuestion,
      qaActions.answerQuestion,
      qaActions.voteQuestion,
      qaActions.voteAnswer,
    ]);
    try {
      const { doc } = await render();
      for (const sectionId of ["reviews", "questions"]) {
        const section = doc.getElementById(sectionId);
        expect(section).not.toBeNull();
        const mutationForms = [...(section?.querySelectorAll("form") ?? [])].filter(
          (f) => (f.getAttribute("method") ?? "").toLowerCase() !== "get",
        );
        expect(mutationForms.length).toBeGreaterThan(0);
        const broken = mutationForms.filter((f) => !isRealPostForm(f)).map((f) => `${sectionId}:${f.getAttribute("action") ?? ""}`.slice(0, 80));
        expect(broken).toEqual([]);
      }
    } finally {
      restoreForms();
      restoreForms = () => {};
    }
  });

  test("review vote forms (ReviewCard) and the write-review form are real POST forms (D-T97-1 fixed)", async () => {
    const restore = serverLike([reviewActions.submitReview, reviewActions.voteReviewHelpful]);
    try {
      const { doc } = await render();
      const forms = [...(doc.getElementById("reviews")?.querySelectorAll("form") ?? [])].filter(
        (f) => (f.getAttribute("method") ?? "").toLowerCase() !== "get",
      );
      expect(forms.some((f) => f.id === "write-review")).toBe(true);
      expect(forms.filter((f) => !isRealPostForm(f)).map((f) => f.id)).toEqual([]);
    } finally {
      restore();
    }
  });

  test("Q&A section (alone) renders real POST forms", async () => {
    const restore = serverLike([qaActions.askQuestion, qaActions.answerQuestion, qaActions.voteQuestion, qaActions.voteAnswer]);
    try {
      const { doc } = await render();
      const forms = [...(doc.getElementById("questions")?.querySelectorAll("form") ?? [])].filter(
        (f) => (f.getAttribute("method") ?? "").toLowerCase() !== "get",
      );
      expect(forms.length).toBeGreaterThan(1);
      expect(forms.filter((f) => !isRealPostForm(f))).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("buy box forms (add to cart / buy now / lists) are real POST forms", async () => {
    const restore = serverLike([
      cartActions.addToCart,
      cartActions.buyNow,
      cartActions.addManyToCart,
      listActions.addToList,
      listActions.removeFromList,
      alertActions.subscribeStockAlert,
      alertActions.unsubscribeStockAlert,
    ]);
    try {
      resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
      const { doc } = await render();
      const article = doc.querySelector("article");
      const forms = [...(article?.querySelectorAll("form") ?? [])].filter((f) => (f.getAttribute("method") ?? "").toLowerCase() !== "get");
      expect(forms.length).toBeGreaterThan(0);
      expect(forms.filter((f) => !isRealPostForm(f)).map((f) => f.getAttribute("action"))).toEqual([]);
    } finally {
      restore();
    }
  });

  test("one h1, no skipped heading levels, unique ids, allow-listed hrefs, # links resolve", async () => {
    const { doc } = await render();
    expect(headingViolations(doc)).toEqual([]);
    expect(duplicateIds(doc)).toEqual([]);
    expect(pdpHrefViolations(doc)).toEqual([]);
  });

  test("unique form names and 44px submit buttons", async () => {
    const { doc } = await render();
    expect(duplicateFormNames(doc)).toEqual([]);
    expect(smallSubmitButtons(doc)).toEqual([]);
  });

  test("garbage review/Q&A params never throw and render the page", async () => {
    const garbage = {
      sort: "<script>",
      stars: ["9", "1"],
      verified: "yes'--",
      rpage: "-1e309",
      qpage: "NaN",
      img: "99999999999999999999",
    };
    const { outcome, doc } = await render(slug, garbage);
    expect(outcome.kind).toBe("ok");
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(pdpHrefViolations(doc)).toEqual([]);
  });
});
