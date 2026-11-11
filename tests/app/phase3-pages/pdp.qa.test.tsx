/**
 * T173 — QA wave C2, PDP v3 (T169 composition; T159 BuyBox v3, T144 gallery,
 * T160 content organisms, T153 rails, FIX-card-now). QA-owned.
 *
 * Contracts: tests/redesign/CONTRACTS.md P-1…P-14 and G-1…G-20 (page level),
 * BACKLOG-phase3 T169 AC1–AC5 and T173 AC1. Page function called directly
 * with the wave-5 harness mocks (`next/*`), `:memory:` DB seeded through the
 * real seed; data scenarios are made by updating seeded rows and restored.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { expectNotNull, expectNull, expectSameNode } from "@/test/dom-assertions";

import {
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
  UUID_RE,
} from "../phase2-wave5/_harness";
import {
  brandAndThemeViolations,
  countClockReads,
  darkClassTokens,
  landmarkViolations,
  precedes,
  smallTargets,
  spokenText,
  themeToggles,
  withChrome,
} from "./_phase3";

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
const { isAllowedInternalHref } = await import("@/content/routes");
const { getRecommendationService } = await import("@/server/recommendations/recommendation-service");
const { CARD_BADGE_NEW_DAYS, PRODUCT_CARD_BADGES } = await import("@/components/molecules/ProductCard");
const cartActions = await import("@/app/actions/cart");
const listActions = await import("@/app/actions/lists");
const alertActions = await import("@/app/actions/stock-alerts");
const reviewActions = await import("@/app/actions/reviews");
const qaActions = await import("@/app/actions/questions");
const { SITE_NAME } = await import("@/lib/seo/site");
const { FOOTER_COLUMNS } = await import("@/content/navigation");
const { SiteFooter } = await import("@/components/organisms/SiteFooter");
const { HeaderShell } = await import("@/app/_layout/HeaderShell");
const pdp = await import("@/app/products/[slug]/page");
const ProductPage = pdp.default;

const OWNER_A = "a1a1a1a1-3333-4333-8333-00000000000a";
const DAY = 86_400_000;
const BADGE_LABELS = new Set(["Sale", "New", "Top pick"]);
const BADGE_ORDER = ["Sale", "New", "Top pick"];

interface Row {
  id: string;
  slug: string;
  name: string;
  price_cents: number;
  list_price_cents: number | null;
  stock: number;
  images: string;
  published_at: string;
  rating_count: number;
  rating_sum: number;
}

/** Every server action the PDP binds into a form (so React SSR renders real POST forms, not `javascript:` + its replay script). */
const ALL_ACTIONS = [
  cartActions.addToCart,
  cartActions.buyNow,
  cartActions.addManyToCart,
  listActions.addToList,
  listActions.removeFromList,
  alertActions.subscribeStockAlert,
  alertActions.unsubscribeStockAlert,
  reviewActions.submitReview,
  reviewActions.voteReviewHelpful,
  qaActions.askQuestion,
  qaActions.answerQuestion,
  qaActions.voteQuestion,
  qaActions.voteAnswer,
];

/** Hidden inputs React adds for a server-reference form (fixture artefact), excluded from field lists. */
const isReactRef = (name: string | null): boolean => (name ?? "").startsWith("$ACTION");

let recordView: ReturnType<typeof spyOn<ReturnType<typeof getRecommendationService>, "recordView">>;
const db = () => getDatabase();

/** Rows snapshot for restore after each mutating test. */
const snapshots = new Map<string, Row>();

function row(where: string): Row {
  const r = db()
    .query<Row, []>(
      `SELECT id, slug, name, price_cents, list_price_cents, stock, images, published_at, rating_count, rating_sum
         FROM products p WHERE published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${where} ORDER BY slug LIMIT 1`,
    )
    .get();
  if (r === null) throw new Error(`no product for ${where}`);
  return r;
}

function patch(id: string, set: Partial<Omit<Row, "id" | "slug">> & { description?: string; bullets?: string; specs?: string }): void {
  if (!snapshots.has(id)) {
    const snap = db().query<Row & { description: string; bullets: string; specs: string }, [string]>("SELECT * FROM products WHERE id = ?").get(id);
    if (snap !== null) snapshots.set(id, snap);
  }
  for (const [k, v] of Object.entries(set)) db().query(`UPDATE products SET ${k} = ? WHERE id = ?`).run(v as string | number | null, id);
}

function restoreAll(): void {
  for (const [id, snap] of snapshots) {
    for (const [k, v] of Object.entries(snap)) {
      if (k === "id") continue;
      db().query(`UPDATE products SET ${k} = ? WHERE id = ?`).run(v as string | number | null, id);
    }
  }
  snapshots.clear();
}

async function render(slug: string, searchParams: Record<string, string> = {}) {
  const outcome = await outcomeOf(() => ProductPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(searchParams) }));
  if (outcome.kind !== "ok") return { outcome, html: "", doc: parseHtml("") };
  const html = renderToStaticMarkup(outcome.value);
  return { outcome, html, doc: parseHtml(html) };
}

function pdpAllowed(slug: string) {
  return (href: string): boolean => {
    if (isAllowedInternalHref(href)) return true;
    if (!href.startsWith("mailto:?")) return false;
    const body = new URLSearchParams(href.slice("mailto:?".length)).get("body") ?? "";
    return body.endsWith(`${SITE}/products/${slug}`) && body.match(UUID_RE) === null;
  };
}

function badgeTexts(doc: Document): string[] {
  return [...doc.querySelectorAll('[data-testid="pdp-badges"] > *')].map((b) => (b.textContent ?? "").trim());
}

function buyBox(doc: Document): Element | null {
  return doc.querySelector("article section[aria-labelledby$='-heading'][data-sticky]") ?? doc.querySelector("article section");
}

function railSections(doc: Document): Element[] {
  return [...doc.querySelectorAll('section[id^="rail-"]')];
}

let SALE: Row;
let OOS: Row;
let LOW: Row;
let PLAIN: Row;

beforeAll(() => {
  closeDatabase();
  seedDatabase(db());
  recordView = spyOn(getRecommendationService(), "recordView");
  SALE = row("stock > 5 AND list_price_cents > price_cents AND json_array_length(images) >= 2");
  OOS = row("stock = 0");
  LOW = row("stock BETWEEN 1 AND 5");
  PLAIN = row(`stock > 5 AND (list_price_cents IS NULL OR list_price_cents <= price_cents) AND slug <> '${SALE.slug}'`);
});

beforeEach(() => {
  resetCookies();
  recordView.mockClear();
});

// Each PDP render builds a large tree (rails, reviews, Q&A); collect between tests to keep the shard well under the watchdog.
afterEach(() => {
  Bun.gc(true);
});

afterAll(() => {
  restoreAll();
  recordView.mockRestore();
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
  if (previousSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
});

// ---------------------------------------------------------------------------
// Structure (T169, P-1…P-3, P-11, P-12)
// ---------------------------------------------------------------------------

describe("PDP v3 — section order, ids and the single h1 (P-1, P-2, P-3, P-11, T169 AC4/AC5)", () => {
  test("breadcrumb first, then article (gallery -> title block -> buy box), content cards, FBT, reviews, questions, rails", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const { doc } = await render(SALE.slug);
    const firstNav = doc.body.querySelector("nav");
    expect(firstNav?.getAttribute("aria-label")).toBe("Breadcrumb");
    const article = doc.querySelector("article");
    expectNotNull(article ?? null);
    expectSameNode(doc.querySelectorAll("article")[0], article);
    const gallery = doc.getElementById("gallery");
    const title = doc.querySelector('[data-testid="pdp-title-block"]');
    const box = buyBox(doc);
    expect(article?.contains(gallery)).toBe(true);
    expect(article?.contains(title)).toBe(true);
    expect(article?.contains(box)).toBe(true);
    // DOM order = the single-column order below lg (P-3, T169 AC5).
    expect(precedes(firstNav, article)).toBe(true);
    expect(precedes(gallery, title)).toBe(true);
    expect(precedes(title, box)).toBe(true);
    const about = doc.getElementById("about-heading")?.closest("section") ?? null;
    const specs = doc.getElementById("specs-heading")?.closest("section") ?? null;
    const reviews = doc.querySelector("section#reviews");
    const questions = doc.querySelector("section#questions");
    expectNotNull(about ?? null);
    expectNotNull(specs ?? null);
    expectNotNull(reviews ?? null);
    expectNotNull(questions ?? null);
    expect(precedes(article, about)).toBe(true);
    expect(precedes(about, specs)).toBe(true);
    const fbt = doc.querySelector('section[aria-labelledby^="fbt-"]');
    if (fbt !== null) {
      expect(precedes(specs, fbt)).toBe(true);
      expect(precedes(fbt, reviews)).toBe(true);
    }
    expect(precedes(specs, reviews)).toBe(true);
    expect(precedes(reviews, questions)).toBe(true);
    // Rails come after reviews and Q&A, in the documented order.
    const rails = railSections(doc).map((s) => s.id);
    expect(rails.length).toBeGreaterThan(0);
    const expectedOrder = ["rail-related", "rail-also-bought", "rail-also-viewed", "rail-recently-viewed"];
    expect(rails).toEqual(expectedOrder.filter((id) => rails.includes(id)));
    for (const s of railSections(doc)) expect(precedes(questions, s)).toBe(true);
    // Anchors the page links to exist.
    expectNotNull(doc.getElementById("reviews") ?? null);
    expectNotNull(doc.getElementById("questions") ?? null);
    expectNotNull(doc.getElementById("write-review") ?? null);
  });

  test("exactly one h1, inside the title block, equal to the product name; every content section has an h2", async () => {
    const { doc } = await render(SALE.slug);
    const h1s = doc.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expectNotNull(h1s[0]?.closest('[data-testid="pdp-title-block"]') ?? null);
    expect(h1s[0]?.textContent).toBe(SALE.name);
    for (const id of ["about-heading", "specs-heading", "reviews-heading", "questions-heading"]) {
      expect(doc.getElementById(id)?.tagName).toBe("H2");
    }
    for (const s of railSections(doc)) expectNotNull(s.querySelector("h2") ?? null);
    expect(headingViolations(doc)).toEqual([]);
    expect(duplicateIds(doc)).toEqual([]);
  });

  test("title block: brand link to /brand/<slug> and a rating link to #reviews whose name states avg and count (P-5)", async () => {
    const { doc } = await render(SALE.slug);
    const block = doc.querySelector('[data-testid="pdp-title-block"]') as Element;
    const brand = [...block.querySelectorAll("a")].find((a) => (a.getAttribute("href") ?? "").startsWith("/brand/"));
    expect(brand?.textContent).toMatch(/^Visit the .+ store$/);
    const rating = block.querySelector('a[href="#reviews"]');
    expect(rating?.getAttribute("aria-label")).toMatch(/^\d\.\d out of 5, [\d,]+ ratings?$/);
  });

  test("specs and information are tables with row header cells; About this item is a ul (P-11)", async () => {
    const { doc } = await render(SALE.slug);
    const about = doc.getElementById("about-heading")?.closest("section");
    expectNotNull(about?.querySelector("ul > li") ?? null);
    const specs = doc.getElementById("specs-heading")?.closest("section");
    expectNotNull(specs?.querySelector("table th[scope='row']") ?? null);
  });
});

// ---------------------------------------------------------------------------
// Badges (P-5 = L-12 rules)
// ---------------------------------------------------------------------------

describe("PDP v3 — badge row (P-5: Sale > New > Top pick, max 2, text labels)", () => {
  test("sale + new + top-pick data -> exactly [Sale, New] (cap 2, priority order)", async () => {
    patch(PLAIN.id, {
      list_price_cents: PLAIN.price_cents + 500,
      published_at: new Date(Date.now() - DAY).toISOString(),
      rating_count: 20,
      rating_sum: 100,
    });
    try {
      const { doc } = await render(PLAIN.slug);
      expect(badgeTexts(doc)).toEqual(["Sale", "New"]);
    } finally {
      restoreAll();
    }
  });

  test("top-pick only (old, no list price, 4.8 from 10) -> [Top pick]", async () => {
    patch(PLAIN.id, {
      list_price_cents: null,
      published_at: new Date(Date.now() - (CARD_BADGE_NEW_DAYS + 30) * DAY).toISOString(),
      rating_count: 10,
      rating_sum: 48,
    });
    try {
      const { doc } = await render(PLAIN.slug);
      expect(badgeTexts(doc)).toEqual(["Top pick"]);
    } finally {
      restoreAll();
    }
  });

  test("no qualifying data -> no badge row at all (not an empty container)", async () => {
    patch(PLAIN.id, {
      list_price_cents: null,
      published_at: new Date(Date.now() - (CARD_BADGE_NEW_DAYS + 30) * DAY).toISOString(),
      rating_count: 0,
      rating_sum: 0,
    });
    try {
      const { doc } = await render(PLAIN.slug);
      expectNull(doc.querySelector('[data-testid="pdp-badges"]'));
    } finally {
      restoreAll();
    }
  });

  test("list price equal to price is not a sale; New boundary day is inclusive of CARD_BADGE_NEW_DAYS - 1", async () => {
    patch(PLAIN.id, {
      list_price_cents: PLAIN.price_cents,
      published_at: new Date(Date.now() - (CARD_BADGE_NEW_DAYS - 1) * DAY).toISOString(),
      rating_count: 0,
      rating_sum: 0,
    });
    try {
      const { doc } = await render(PLAIN.slug);
      expect(badgeTexts(doc)).toEqual(["New"]);
    } finally {
      restoreAll();
    }
  });

  test("first 12 seeded published products: <= 2 badges, labels from the card set, in priority order, pill shape", async () => {
    const slugs = db()
      .query<{ slug: string }, []>("SELECT slug FROM products WHERE published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY slug LIMIT 12")
      .all()
      .map((r) => r.slug);
    for (const slug of slugs) {
      const { doc } = await render(slug);
      const labels = badgeTexts(doc);
      expect([slug, labels.length <= 2]).toEqual([slug, true]);
      for (const l of labels) expect([slug, BADGE_LABELS.has(l)]).toEqual([slug, true]);
      const order = labels.map((l) => BADGE_ORDER.indexOf(l));
      expect([slug, order]).toEqual([slug, [...order].sort((a, b) => a - b)]);
      for (const el of doc.querySelectorAll('[data-testid="pdp-badges"] > *')) {
        expect(el.getAttribute("class") ?? "").toContain("rounded-full");
      }
    }
    expect(PRODUCT_CARD_BADGES.sale.label).toBe("Sale");
  });
});

// ---------------------------------------------------------------------------
// Buy box (P-6…P-8, P-14, T173 AC1)
// ---------------------------------------------------------------------------

describe("PDP v3 — sticky BuyBox, price, stock (P-6, P-7, P-8, P-14, T173 AC1)", () => {
  test("BuyBox is sticky from lg only and keeps scroll-margin for focused controls", async () => {
    const { doc } = await render(SALE.slug);
    const box = doc.querySelector("section[data-sticky]");
    expectNotNull(box ?? null);
    const tokens = (box?.getAttribute("class") ?? "").split(/\s+/);
    expect(tokens).toContain("lg:sticky");
    expect(tokens).toContain("lg:self-start");
    expect(tokens.some((t) => /^lg:top-/.test(t))).toBe(true);
    // No unprefixed (phone/tablet) sticky or fixed positioning.
    expect(tokens.filter((t) => t === "sticky" || t === "fixed" || /^(sm|md):(sticky|fixed)$/.test(t))).toEqual([]);
    expect(tokens.some((t) => /scroll-mt-/.test(t))).toBe(true);
    // The column holding it is a block column (stretches) and only one sticky element on the page.
    expect(doc.querySelectorAll("[data-sticky]").length).toBe(1);
    const column = box?.parentElement;
    expect((column?.getAttribute("class") ?? "").split(/\s+/)).not.toContain("flex");
  });

  test("sale product: price spoken as one amount, struck 'Was …' list price, 'Save $X (Y%)' with Y rounded down", async () => {
    const { doc } = await render(SALE.slug);
    const box = doc.querySelector("section[data-sticky]") as Element;
    const s = box.querySelector("s");
    expect(spokenText(s)).toMatch(/^Was \$[\d,]+\.\d{2}$/);
    const save = SALE.list_price_cents! - SALE.price_cents;
    const pct = Math.floor((save * 100) / SALE.list_price_cents!);
    const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    expect(spokenText(box)).toContain(`Save ${dollars(save)} (${pct}%)`);
    expect(spokenText(box)).toContain(dollars(SALE.price_cents));
  });

  test("1999 vs 2499 -> 'Save $5.00 (20%)' (P-6 example)", async () => {
    patch(PLAIN.id, { price_cents: 1999, list_price_cents: 2499 });
    try {
      const { doc } = await render(PLAIN.slug);
      const box = doc.querySelector("section[data-sticky]") as Element;
      expect(spokenText(box)).toContain("Save $5.00 (20%)");
      expect(spokenText(box?.querySelector("s"))).toBe("Was $24.99");
    } finally {
      restoreAll();
    }
  });

  test("no list price -> no saving text and no struck price", async () => {
    patch(PLAIN.id, { list_price_cents: null });
    try {
      const { doc } = await render(PLAIN.slug);
      const box = doc.querySelector("section[data-sticky]") as Element;
      expectNull(box.querySelector("s"));
      expect(spokenText(box)).not.toMatch(/Save \$/);
    } finally {
      restoreAll();
    }
  });

  test("low stock: 'Only N left' text (never colour only); add-to-cart quantity max <= stock", async () => {
    const { doc } = await render(LOW.slug);
    const box = doc.querySelector("section[data-sticky]") as Element;
    expect(box.textContent).toContain(`Only ${LOW.stock} left`);
    const qty = box.querySelector('select[name="quantity"], input[name="quantity"]');
    expectNotNull(qty ?? null);
    const options = [...(qty?.querySelectorAll("option") ?? [])].map((o) => Number(o.getAttribute("value")));
    const max = options.length > 0 ? Math.max(...options) : Number(qty?.getAttribute("max"));
    expect(max).toBeLessThanOrEqual(LOW.stock);
  });

  test("out of stock: add-to-cart and buy-now replaced by the stock-alert form; JSON-LD OutOfStock", async () => {
    const { doc } = await render(OOS.slug);
    const box = doc.querySelector("section[data-sticky]") as Element;
    expect(box.textContent).toMatch(/out of stock/i);
    const buttons = [...box.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    expect(buttons.some((t) => /^add to cart$/i.test(t))).toBe(false);
    expect(buttons.some((t) => /^buy now$/i.test(t))).toBe(false);
    expectNotNull(box.querySelector('input[type="email"], input[name="email"]') ?? box.querySelector("form button") ?? null);
    const ld = JSON.parse(doc.querySelector('script[type="application/ld+json"]')?.textContent ?? "[]") as Record<string, unknown>[];
    const offers = ld[0]?.offers as Record<string, unknown> | undefined;
    expect(offers?.availability).toBe("https://schema.org/OutOfStock");
  });

  test("buy box add-to-cart / buy-now are real POST forms carrying productId + quantity and no price field (no-JS)", async () => {
    const restore = serverLike(ALL_ACTIONS);
    try {
      const { doc } = await render(SALE.slug);
      const box = doc.querySelector("section[data-sticky]") as Element;
      const forms = [...box.querySelectorAll("form")].filter((f) => f.querySelector('input[name="productId"]') !== null);
      expect(forms.length).toBeGreaterThan(0);
      for (const f of forms) {
        expect(isRealPostForm(f)).toBe(true);
        expect(f.querySelector('input[name="productId"]')?.getAttribute("value")).toBe(SALE.id);
        expectNull(f.querySelector('[name*="price" i], [name*="total" i]'));
      }
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Gallery (P-4)
// ---------------------------------------------------------------------------

describe("PDP v3 — gallery basePath no-JS links (P-4)", () => {
  test("thumbnails are links to /products/<slug>[?img=N]#gallery named 'Image N of M'; the selected one has aria-current", async () => {
    const { doc } = await render(SALE.slug);
    const links = [...doc.querySelectorAll("#gallery ul a[href]")];
    const count = (JSON.parse(SALE.images) as unknown[]).length;
    expect(links.length).toBe(count);
    links.forEach((a, i) => {
      const expected = i === 0 ? `/products/${SALE.slug}#gallery` : `/products/${SALE.slug}?img=${i}#gallery`;
      expect(a.getAttribute("href")).toBe(expected);
      expect(spokenText(a)).toBe(`Image ${i + 1} of ${count}`);
    });
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual(links.map((_, i) => (i === 0 ? "page" : null)));
  });

  test("?img=1 selects the second image (main image src, aria-current) without changing the canonical", async () => {
    const { doc } = await render(SALE.slug, { img: "1" });
    const links = [...doc.querySelectorAll("#gallery ul a[href]")];
    expect(links[1]?.getAttribute("aria-current")).toBe("page");
    expect(links[0]?.getAttribute("aria-current")).toBeNull();
    const second = links[1]?.querySelector("img")?.getAttribute("src");
    expect(doc.querySelector("#gallery [data-gallery-main] img")?.getAttribute("src")).toBe(second ?? "missing");
    const meta = await pdp.generateMetadata({ params: Promise.resolve({ slug: SALE.slug }), searchParams: Promise.resolve({ img: "1" }) });
    expect(meta.alternates?.canonical).toBe(`${SITE}/products/${SALE.slug}`);
  });

  test.each([["-1"], ["999"], ["1e3"], ["<b>"], [""]])("garbage ?img=%p renders the first image selected (no throw)", async (img) => {
    const { outcome, doc } = await render(SALE.slug, { img });
    expect(outcome.kind).toBe("ok");
    expect(doc.querySelector("#gallery ul a[aria-current='page']")?.getAttribute("href")).toBe(`/products/${SALE.slug}#gallery`);
  });

  test("one image -> no thumbnail strip; zero images -> placeholder alt = product name", async () => {
    patch(PLAIN.id, { images: JSON.stringify([(JSON.parse(SALE.images) as unknown[])[0]]) });
    try {
      const one = await render(PLAIN.slug);
      expect(one.doc.querySelectorAll("#gallery ul a").length).toBe(0);
      patch(PLAIN.id, { images: "[]" });
      const none = await render(PLAIN.slug);
      const img = none.doc.querySelector("#gallery img");
      expect(img?.getAttribute("alt")).toBe(PLAIN.name);
    } finally {
      restoreAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Rails (P-12, T169 AC3)
// ---------------------------------------------------------------------------

describe("PDP v3 — rails exclude the current product and carry quick-add forms (P-12, L-12)", () => {
  test("no rail links to the current product, including recently viewed after the product was viewed", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    // Build a history that includes the current product and two others.
    await render(PLAIN.slug);
    await render(LOW.slug);
    await render(SALE.slug);
    const { doc } = await render(SALE.slug);
    const rv = doc.querySelector("section#rail-recently-viewed");
    expectNotNull(rv ?? null);
    for (const s of railSections(doc)) {
      const hrefs = [...s.querySelectorAll("a[href^='/products/']")].map((a) => a.getAttribute("href"));
      expect([s.id, hrefs.includes(`/products/${SALE.slug}`)]).toEqual([s.id, false]);
      const ids = [...s.querySelectorAll('input[name="productId"]')].map((i) => i.getAttribute("value"));
      expect([s.id, ids.includes(SALE.id)]).toEqual([s.id, false]);
    }
  });

  test("each in-stock rail card has one quick-add form: hidden productId + quantity=1, no price/total, real POST, sibling of the card link", async () => {
    const restore = serverLike(ALL_ACTIONS);
    try {
      const { doc } = await render(SALE.slug);
      const rails = railSections(doc);
      expect(rails.length).toBeGreaterThan(0);
      for (const s of rails) {
        for (const li of s.querySelectorAll("ul > li")) {
          const link = li.querySelector("a[href^='/products/']");
          expectNotNull(link ?? null);
          const forms = li.querySelectorAll("form");
          if (/out of stock/i.test(li.textContent ?? "")) {
            expect(forms.length).toBe(0);
            continue;
          }
          expect(forms.length).toBe(1);
          const form = forms[0] as Element;
          expect(isRealPostForm(form)).toBe(true);
          expect(link?.contains(form)).toBe(false);
          expect(form.contains(link)).toBe(false);
          const named = [...form.querySelectorAll("input[name]")]
            .filter((i) => !isReactRef(i.getAttribute("name")))
            .map((i) => `${i.getAttribute("name")}=${i.getAttribute("type")}`);
          expect(named.sort()).toEqual(["productId=hidden", "quantity=hidden"]);
          expect(form.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
          const pid = form.querySelector('input[name="productId"]')?.getAttribute("value") ?? "";
          const slug = decodeURIComponent((link?.getAttribute("href") ?? "").slice("/products/".length));
          const expectedId = db().query<{ id: string }, [string]>("SELECT id FROM products WHERE slug = ?").get(slug)?.id;
          expect(pid).toBe(expectedId ?? "missing");
          // No nested interactive element inside the card link.
          expectNull(link?.querySelector("a, button, input, select, textarea"));
        }
      }
    } finally {
      restore();
    }
  });

  test("no cookie -> no recently-viewed rail; rails never duplicate a product inside one rail", async () => {
    const { doc } = await render(SALE.slug);
    expectNull(doc.querySelector("section#rail-recently-viewed"));
    for (const s of railSections(doc)) {
      const hrefs = [...s.querySelectorAll("li > a[href^='/products/'], li a[href^='/products/']")].map((a) => a.getAttribute("href"));
      const unique = new Set(hrefs);
      expect([s.id, unique.size]).toEqual([s.id, new Set(hrefs).size]);
      const ids = [...s.querySelectorAll('input[name="productId"]')].map((i) => i.getAttribute("value"));
      expect([s.id, ids.length]).toEqual([s.id, new Set(ids).size]);
    }
  });
});

// ---------------------------------------------------------------------------
// Clock, views, cookies (FIX-card-now, T97)
// ---------------------------------------------------------------------------

describe("PDP v3 — one clock, one view, no mint", () => {
  test("rendering the returned tree reads the clock 0 times (cards, badges, rails use the loader's `now`)", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    await render(PLAIN.slug); // history -> recently viewed rail exists
    const element = await ProductPage({ params: Promise.resolve({ slug: SALE.slug }), searchParams: Promise.resolve({}) });
    const markup = await countClockReads(async () => renderToStaticMarkup(element));
    if (markup.reads !== 0) console.info(`[T173] PDP render clock reads: ${markup.reads}\n  ${markup.stacks.join("\n  ")}`);
    expect(markup.reads).toBe(0);
    expectNotNull(parseHtml(markup.value).querySelector("section#rail-recently-viewed") ?? null);
    expect(parseHtml(markup.value).querySelectorAll('section[id^="rail-"] form').length).toBeGreaterThan(0);
  });

  test("guest (no cookie): the page function reads the clock exactly once (loader)", async () => {
    const page = await countClockReads(() =>
      ProductPage({ params: Promise.resolve({ slug: SALE.slug }), searchParams: Promise.resolve({}) }),
    );
    expect(page.reads).toBe(1);
  });

  // PIN: D-T169-1 — with a session cookie the loader's `loadViewer` calls `alerts.list(sessionId)` without the
  // loader's `now`, so StockAlertService reads its own clock (stock-alert-service.ts:214): 2 reads per render,
  // against the README "clock read once inside the loader" and FIX-card-now "one clock".
  test("D-T169-1: with a session cookie the page function still reads the clock exactly once", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const page = await countClockReads(() =>
      ProductPage({ params: Promise.resolve({ slug: SALE.slug }), searchParams: Promise.resolve({}) }),
    );
    if (page.reads !== 1) console.info(`[T173] D-T169-1 clock reads: ${page.reads}\n  ${page.stacks.join("\n  ")}`);
    expect(page.reads).toBe(1);
  });

  test("valid cookie: exactly one view recorded per render; no cookie: none; nothing minted or written", async () => {
    const mint = spyOn(session, "getOrCreateSessionId");
    try {
      resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
      await render(SALE.slug);
      expect(recordView).toHaveBeenCalledTimes(1);
      expect(recordView.mock.calls[0]?.[1]).toBe(SALE.id);
      recordView.mockClear();
      resetCookies();
      await render(SALE.slug);
      expect(recordView).not.toHaveBeenCalled();
      expect(mint).not.toHaveBeenCalled();
      expect(harness.store.writes).toEqual([]);
    } finally {
      mint.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// SEO (P-13, T169 AC1/AC2)
// ---------------------------------------------------------------------------

describe("PDP v3 — JSON-LD, metadata, 404s (P-13)", () => {
  test("one ld+json script: [Product, BreadcrumbList]; Product name/url/offers match the page; no other scripts", async () => {
    const restore = serverLike(ALL_ACTIONS);
    const { doc } = await render(SALE.slug).finally(restore);
    const scripts = [...doc.querySelectorAll("script")];
    expect(scripts.map((s) => s.getAttribute("type"))).toEqual(["application/ld+json"]);
    const ld = JSON.parse(scripts[0]?.textContent ?? "[]") as Record<string, unknown>[];
    expect(ld.map((g) => g["@type"])).toEqual(["Product", "BreadcrumbList"]);
    const product = ld[0] as Record<string, unknown>;
    expect(product.name).toBe(SALE.name);
    const offers = product.offers as Record<string, unknown>;
    expect(offers.availability).toBe("https://schema.org/InStock");
    expect(String(offers.url ?? product.url)).toBe(`${SITE}/products/${SALE.slug}`);
    expect(Number(offers.price)).toBeCloseTo(SALE.price_cents / 100, 2);
    const crumbs = (ld[1]?.itemListElement as { name: string }[]).map((c) => c.name);
    const visible = [...doc.querySelectorAll('nav[aria-label="Breadcrumb"] li')].map((li) => spokenText(li)?.replace(/^[^\w$]+/, ""));
    expect(crumbs.at(-1)).toBe(SALE.name);
    expect(crumbs).toHaveLength(visible.length);
  });

  test("metadata: product title, canonical, OG url/image, indexable; query params change nothing", async () => {
    const a = await pdp.generateMetadata({ params: Promise.resolve({ slug: SALE.slug }), searchParams: Promise.resolve({}) });
    const b = await pdp.generateMetadata({
      params: Promise.resolve({ slug: SALE.slug }),
      searchParams: Promise.resolve({ img: "1", sort: "recent", qpage: "2" }),
    });
    expect(String(a.title)).toContain(SALE.name.slice(0, 20));
    expect(a.alternates?.canonical).toBe(`${SITE}/products/${SALE.slug}`);
    const og = a.openGraph as { url?: unknown; images?: unknown } | undefined;
    expect(String(og?.url)).toBe(`${SITE}/products/${SALE.slug}`);
    expect(JSON.stringify(og?.images ?? [])).toContain("/images/");
    expect(a.robots).toBeUndefined();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  test.each([
    ["unknown well-formed slug", "no-such-product-qa"],
    ["path traversal", "../../etc/passwd"],
    ["upper-case variant", "UPPER-Case"],
    ["script", "<script>alert(1)</script>"],
    ["very long", "a".repeat(5000)],
  ])("%s -> notFound(), no view recorded, metadata noindex", async (_name, slug) => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    const { outcome } = await render(slug);
    expect(outcome.kind).toBe("notFound");
    expect(recordView).not.toHaveBeenCalled();
    const m = await pdp.generateMetadata({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) });
    expect(JSON.stringify(m.robots)).toContain('"index":false');
  });

  test("unpublished (future published_at) -> notFound(), even with a cookie; restored -> 200", async () => {
    patch(PLAIN.id, { published_at: new Date(Date.now() + DAY).toISOString() });
    try {
      resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
      expect((await render(PLAIN.slug)).outcome.kind).toBe("notFound");
      expect(recordView).not.toHaveBeenCalled();
    } finally {
      restoreAll();
    }
    expect((await render(PLAIN.slug)).outcome.kind).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Hostile text
// ---------------------------------------------------------------------------

describe("PDP v3 — hostile catalogue text renders as text", () => {
  const NAME = 'QA </script><script>alert("n")</script><img src=x onerror=alert(1)> & "quotes"';
  const BULLET = '<a href="javascript:alert(2)">bullet</a>';
  const DESC = "First <b>para</b>\n\n<iframe src=//evil.example></iframe>";

  test("name, bullets, description and specs with markup: no injected elements; h1 and JSON-LD carry the raw text", async () => {
    patch(PLAIN.id, {
      name: NAME,
      bullets: JSON.stringify([BULLET]),
      description: DESC,
      specs: JSON.stringify([{ label: "<svg onload=alert(3)>", value: "</td></tr></table><script>x</script>" }]),
    });
    const restore = serverLike(ALL_ACTIONS);
    try {
      const { html, doc } = await render(PLAIN.slug);
      expect(doc.querySelector("h1")?.textContent).toBe(NAME);
      expect(doc.querySelectorAll("script").length).toBe(1);
      expectNull(doc.querySelector("img[onerror], svg[onload], iframe, a[href^='javascript:'], b"));
      const ld = doc.querySelector('script[type="application/ld+json"]')?.textContent ?? "";
      expect(ld.toLowerCase()).not.toContain("</script");
      expect((JSON.parse(ld) as { name?: string }[])[0]?.name).toBe(NAME);
      expect(html).not.toContain("<script>alert");
      const about = doc.getElementById("about-heading")?.closest("section");
      expect(about?.querySelector("li")?.textContent).toBe(BULLET);
    } finally {
      restore();
      restoreAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting (G rows): chrome landmarks, hrefs, targets, brand-free, light-only
// ---------------------------------------------------------------------------

describe("PDP v3 — cross-cutting with the layout chrome (G-1…G-6, G-14, G-17, G-20, R-5)", () => {
  async function chromeDoc(slug: string) {
    const outcome = await outcomeOf(() => ProductPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) }));
    if (outcome.kind !== "ok") throw new Error(outcome.kind);
    const html = await withChrome(outcome.value, { HeaderShell, SiteFooter, storeName: SITE_NAME, columns: FOOTER_COLUMNS });
    return { html, doc: parseHtml(html) };
  }

  test("page alone holds no banner/main/contentinfo; with the chrome there is exactly one of each and nav names are unique", async () => {
    const alone = await render(SALE.slug);
    expect(landmarkViolations(alone.doc, { chrome: false })).toEqual([]);
    for (const cookies of [{}, { [session.SESSION_COOKIE_NAME]: OWNER_A }] as Record<string, string>[]) {
      resetCookies(cookies);
      const { doc } = await chromeDoc(SALE.slug);
      expect(landmarkViolations(doc, { chrome: true })).toEqual([]);
      expect(doc.querySelectorAll("h1").length).toBe(1);
      expect(duplicateIds(doc)).toEqual([]);
    }
  });

  test("every href (page + chrome) is allow-listed or a resolvable #id (share mailto carries only the canonical URL)", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: OWNER_A });
    for (const r of [SALE, OOS, LOW]) {
      const { doc } = await chromeDoc(r.slug);
      expect([r.slug, hrefViolations(doc, pdpAllowed(r.slug))]).toEqual([r.slug, []]);
    }
  });

  test("44px submit buttons on the page (SR6)", async () => {
    for (const r of [SALE, OOS, LOW]) {
      const { doc } = await render(r.slug);
      expect([r.slug, smallSubmitButtons(doc)]).toEqual([r.slug, []]);
    }
  });

  /** SR6 exempts links inside running text (e.g. the "Best Sellers Rank: #3 in <category>" sentence). */
  const inlineInText = (el: Element): boolean => el.tagName === "A" && el.parentElement?.tagName === "P";
  const isBrandLink = (t: string): boolean => /^a:Visit the .+ store$/.test(t);

  test("44px targets for every link, button, select and summary on the page (SR6), except D-T169-2", async () => {
    for (const r of [SALE, OOS, LOW]) {
      const { doc } = await render(r.slug);
      expect([r.slug, smallTargets(doc, inlineInText).filter((t) => !isBrandLink(t))]).toEqual([r.slug, []]);
    }
  });

  // PIN: D-T169-2 — the standalone "Visit the <brand> store" link in the title block (page.tsx, `Link variant="inline"`)
  // has no `min-h-touch`; it is not inside running text, so SR6 / R3 44px targets apply.
  test("D-T169-2: the brand store link in the title block is a 44px target", async () => {
    const { doc } = await render(SALE.slug);
    expect(smallTargets(doc, inlineInText).filter(isBrandLink)).toEqual([]);
  });

  test("brand-free and light-only HTML: no retailer words, no theme strings, no dark: class tokens, no theme toggle", async () => {
    for (const r of [SALE, OOS, LOW]) {
      const { html, doc } = await chromeDoc(r.slug);
      expect([r.slug, brandAndThemeViolations(html)]).toEqual([r.slug, []]);
      expect([r.slug, darkClassTokens(doc)]).toEqual([r.slug, []]);
      expect([r.slug, themeToggles(doc)]).toEqual([r.slug, []]);
      expect(doc.body.textContent).toContain(SITE_NAME);
    }
  });
});
