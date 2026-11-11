import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// The page calls connection() first and reads cookies via next/headers;
// outside a Next request both would throw. Registered before the page module
// is imported (dynamic import below). Real modules are spread so other
// exports keep working for files sharing the process.
const realServer = { ...(await import("next/server")) };
mock.module("next/server", () => ({ ...realServer, connection: async () => {} }));

const jar = new Map<string, string>();
const cookieSet = mock<(name: string, value: string) => void>(() => {});
const fakeStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) ?? "" } : undefined),
  has: (name: string) => jar.has(name),
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  set: cookieSet,
  delete: cookieSet,
};
mock.module("next/headers", () => ({ cookies: async () => fakeStore, headers: async () => new Headers() }));

const env = process.env as Record<string, string | undefined>;
const previousDatabasePath = env.DATABASE_PATH;
const previousSiteUrl = env.NEXT_PUBLIC_SITE_URL;
env.DATABASE_PATH = ":memory:";
env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { getListingService } = await import("@/server/catalog/listing-service");
const { SqliteBrandRepository } = await import("@/server/catalog/brand-repository");
const { getShippingService } = await import("@/server/pricing/shipping-service");
const { getRecommendationService } = await import("@/server/recommendations/recommendation-service");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { HOME_CONTENT } = await import("@/content/home");
const { HOME_TITLE } = await import("./_lib/home");
const { DEAL_HEADING } = await import("@/components/organisms/HomeHero");
const pageModule = await import("./page");
const { default: Page, metadata } = pageModule;

const SESSION = "3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const restorers: Array<() => void> = [];

/** Contract H-order (T166 hand-off order: hero first so the h1 is the first heading; make-room after explore; brands before services). */
const HOME_ORDER = [
  "home-hero",
  "home-categories",
  "home-shipping-promo",
  "home-discovery",
  "home-lifestyle-banner",
  "top-picks",
  "home-lifestyle-cards",
  "home-lifestyle-make-room",
  "home-popular-searches",
  "home-promo-pair",
  "home-recently-viewed",
  "home-brands",
  "home-services",
] as const;

const TAB_LINKS = [
  ["Best sellers", "/?rail=best-sellers#top-picks"],
  ["Deals", "/?rail=deals#top-picks"],
  ["New arrivals", "/?rail=new-arrivals#top-picks"],
  ["Top rated", "/?rail=top-rated#top-picks"],
] as const;

beforeAll(() => {
  // Start from a fresh in-memory DB even if another test file opened one.
  closeDatabase();
});

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  jar.clear();
  cookieSet.mockClear();
});

afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});

afterAll(() => {
  closeDatabase();
  if (previousDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = previousDatabasePath;
  if (previousSiteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = previousSiteUrl;
});

function track<T extends { mockRestore: () => void }>(spy: T): T {
  restorers.push(() => spy.mockRestore());
  return spy;
}

function pageProps(params: Record<string, string | string[] | undefined> = {}) {
  return { searchParams: Promise.resolve(params) };
}

async function renderPage(params?: Record<string, string | string[] | undefined>) {
  const ui = await Page(params === undefined ? undefined : pageProps(params));
  return render(ui);
}

function totalChanges(): number {
  return getDatabase().query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}

function ids(limit: number): string[] {
  return getDatabase()
    .query<{ id: string }, [number]>("SELECT id FROM products WHERE stock > 0 ORDER BY id LIMIT ?")
    .all(limit)
    .map((r) => r.id);
}

function slugOf(id: string): string {
  return getDatabase().query<{ slug: string }, [string]>("SELECT slug FROM products WHERE id = ?").get(id)?.slug ?? "";
}

function paidOrder(session: string, productIds: readonly string[]): void {
  const db = getDatabase();
  const id = `order_page_${productIds.join("_")}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
       region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
     VALUES (?, ?, 'paid', 100, 100, 'USD', 'Test', 't@example.com', '1 St', 'City', 'RG', '00000', 'US', '4242', ?, ?, 'processing')`,
  ).run(id, session, `idem_${id}`, new Date(Date.now() - 86_400_000).toISOString());
  const ins = db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'x', 100, 1)");
  for (const pid of productIds) ins.run(id, pid);
}

/** The session views two in-stock products, so the recently viewed rail renders. */
function withViews(): [string, string] {
  const [a, b] = ids(2) as [string, string];
  const t = Date.now() - 60_000;
  const view = getDatabase().query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)");
  view.run(SESSION, a, new Date(t).toISOString());
  view.run(SESSION, b, new Date(t + 1).toISOString());
  jar.set(SESSION_COOKIE_NAME, SESSION);
  return [a, b];
}

function ldScripts(container: HTMLElement): HTMLScriptElement[] {
  return [...container.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')];
}

/** Home section ids present, in document order (contract H-order). */
function sectionOrder(container: HTMLElement): string[] {
  const known = new Set<string>(HOME_ORDER);
  return [...container.querySelectorAll("[id]")].map((el) => el.id).filter((id) => known.has(id));
}

function section(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`#${id}`);
  if (el === null) throw new Error(`#${id} missing`);
  return el;
}

/** Product hrefs in a section, in order, de-duplicated. */
function productHrefs(root: HTMLElement): string[] {
  const out: string[] = [];
  for (const a of root.querySelectorAll("a[href^='/products/']")) {
    const href = a.getAttribute("href") ?? "";
    if (!out.includes(href)) out.push(href);
  }
  return out;
}

describe("home page / — metadata", () => {
  test("home title + site description, canonical root, indexable", () => {
    expect(metadata.title).toEqual({ absolute: `${HOME_TITLE} | Northwind Goods` }); // D-T175-1: root segment gets the brand explicitly
    expect(typeof metadata.description).toBe("string");
    expect(String(metadata.alternates?.canonical)).toMatch(/^https?:\/\/[^/]+\/$/);
    expect(metadata.openGraph).toMatchObject({ title: HOME_TITLE, siteName: "Northwind Goods" });
    expect(metadata.robots).toBeUndefined();
  });

  test("canonical stays / for ?rail= tabs: metadata is static (no generateMetadata reading searchParams) (H-22)", () => {
    expect(Object.hasOwn(pageModule, "generateMetadata")).toBe(false);
    expect(new URL(String(metadata.alternates?.canonical)).pathname).toBe("/");
    expect(String(metadata.alternates?.canonical)).not.toContain("rail");
  });
});

describe("home page / — composition (contract H-order)", () => {
  test("every section renders in contract order with its contract id (session with views)", async () => {
    withViews();
    const { container } = await renderPage();
    expect(sectionOrder(container)).toEqual([...HOME_ORDER]);
    expect(container.querySelector("main")).toBeNull();
  });

  test("no cookie: same order without the recently viewed rail", async () => {
    const { container } = await renderPage();
    expect(sectionOrder(container)).toEqual(HOME_ORDER.filter((id) => id !== "home-recently-viewed"));
  });

  test("exactly one h1: the first slide headline, inside #home-hero, and the first heading of the page", async () => {
    const { container } = await renderPage();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(HOME_CONTENT.hero.slides[0]?.headline ?? "missing");
    expect(section(container, "home-hero").contains(h1s[0] ?? null)).toBe(true);
    expect(container.querySelector("h1,h2,h3,h4,h5,h6")?.tagName).toBe("H1");
  });

  test("sections 2..13 each have an h2 as their first heading", async () => {
    withViews();
    const { container } = await renderPage();
    for (const id of HOME_ORDER.slice(1)) {
      const first = section(container, id).querySelector("h1,h2,h3,h4,h5,h6");
      expect({ id, tag: first?.tagName }).toEqual({ id, tag: "H2" });
    }
  });

  test("hero: deal panel heading, carousel slides", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { name: DEAL_HEADING, level: 2 })).toBeDefined();
    expect(screen.getByRole("region", { name: HOME_CONTENT.hero.label })).toHaveAttribute("id", "home-hero");
  });

  test("shipping promo names the free-shipping threshold and links /shipping (H-12)", async () => {
    const { container } = await renderPage();
    const promo = section(container, "home-shipping-promo");
    expect(promo.textContent ?? "").toContain("$35");
    expect([...promo.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/shipping"]);
  });

  test("popular searches: a named nav of /search?q= chips under an h2 (H-18)", async () => {
    const { container } = await renderPage();
    const popular = section(container, "home-popular-searches");
    const nav = within(popular).getByRole("navigation", { name: HOME_CONTENT.popularSearches.label });
    const hrefs = within(nav).getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.length).toBeLessThanOrEqual(12);
    expect(hrefs).toEqual(HOME_CONTENT.popularSearches.terms.map((t) => `/search?q=${encodeURIComponent(t)}`));
  });

  test("promo pair: New arrivals and Top rated (H-19); lifestyle sets: 4 then 3 category cards", async () => {
    const { container } = await renderPage();
    const pairHrefs = [...section(container, "home-promo-pair").querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(pairHrefs).toEqual(["/new-arrivals", "/top-rated"]);
    const cards = (id: string) => [...section(container, id).querySelectorAll("a[href^='/category/']")].map((a) => a.getAttribute("href"));
    expect(new Set(cards("home-lifestyle-cards")).size).toBe(4);
    expect(new Set(cards("home-lifestyle-make-room")).size).toBe(3);
  });

  test("services band: tiles and the returns notice before the tiles (H-21)", async () => {
    const { container } = await renderPage();
    const services = section(container, "home-services");
    expect(within(services).getByRole("heading", { level: 2, name: "Customer services" })).toBeDefined();
    const hrefs = [...services.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const href of ["/orders", "/returns", "/shipping", "/help", "/faq", "/contact"]) expect(hrefs).toContain(href);
    expect(hrefs[0]).toBe("/returns");
  });

  test("omitted reference items (H-24): no email field, no app-store or assistant copy", async () => {
    const { container } = await renderPage();
    expect(container.querySelector("input[type='email']")).toBeNull();
    expect(container.textContent ?? "").not.toMatch(/app store|google play|I'm Joy|catalogue strip/i);
  });
});

describe("home page / — top picks (#top-picks)", () => {
  test("link tabs in order with /?rail=…#top-picks; default tab Deals on a fresh seed (best sellers empty)", async () => {
    const { container } = await renderPage();
    const picks = section(container, "top-picks");
    const nav = within(picks).getByRole("navigation", { name: HOME_CONTENT.topPicks.tabsLabel });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => [a.textContent?.trim(), a.getAttribute("href")])).toEqual(TAB_LINKS.map(([l, h]) => [l, h]));
    expect(links.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent?.trim())).toEqual(["Deals"]);
    expect(nav.querySelector("[role='tab']")).toBeNull();
    expect(productHrefs(picks).length).toBeGreaterThan(0);
  });

  test("?rail=deals renders only the deals products; ?rail=new-arrivals switches the list", async () => {
    const deals = getListingService().deals(12).map((p) => `/products/${encodeURIComponent(p.slug)}`);
    const first = await renderPage({ rail: "deals" });
    const dealHrefs = productHrefs(section(first.container, "top-picks"));
    expect(dealHrefs.length).toBeGreaterThan(0);
    for (const href of dealHrefs) expect(deals).toContain(href);
    first.unmount();

    const second = await renderPage({ rail: "new-arrivals" });
    const picks = section(second.container, "top-picks");
    const current = [...picks.querySelectorAll("a[aria-current='page']")].map((a) => a.textContent?.trim());
    expect(current).toEqual(["New arrivals"]);
    expect(productHrefs(picks)).not.toEqual(dealHrefs);
  });

  test.each([
    ["unknown", "x"],
    ["empty", ""],
    ["repeated", ["deals", "top-rated"]],
    ["prototype", "__proto__"],
    ["500 chars", "d".repeat(500)],
  ] as const)("invalid ?rail= (%s) renders the default tab without throwing", async (_name, rail) => {
    const { container } = await renderPage({ rail: typeof rail === "string" ? rail : [...rail] });
    const current = [...section(container, "top-picks").querySelectorAll("a[aria-current='page']")].map((a) => a.textContent?.trim());
    expect(current).toEqual(["Deals"]);
  });

  test("an empty selected tab keeps the heading and tabs with a status line, no cards", async () => {
    const { container } = await renderPage({ rail: "best-sellers" });
    const picks = section(container, "top-picks");
    expect(productHrefs(picks)).toEqual([]);
    expect(within(picks).getByRole("status")).toBeDefined();
    expect(within(picks).getAllByRole("link").length).toBeGreaterThanOrEqual(4);
  });

  test("with a paid order Best sellers has products and becomes the default tab", async () => {
    paidOrder("9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", ids(2));
    const { container } = await renderPage();
    const picks = section(container, "top-picks");
    const current = [...picks.querySelectorAll("a[aria-current='page']")].map((a) => a.textContent?.trim());
    expect(current).toEqual(["Best sellers"]);
    expect(productHrefs(picks)).toHaveLength(2);
  });

  test("cards: ≤ 12, unique, each with a one-unit quick-add form (productId + quantity=1, no price)", async () => {
    const { container } = await renderPage({ rail: "deals" });
    const picks = section(container, "top-picks");
    const hrefs = productHrefs(picks);
    expect(hrefs.length).toBeLessThanOrEqual(12);
    const forms = [...picks.querySelectorAll("form")];
    expect(forms.length).toBeGreaterThan(0);
    expect(forms.length).toBeLessThanOrEqual(hrefs.length);
    for (const form of forms) {
      const fields = [...form.querySelectorAll("input")].map((i) => [i.getAttribute("name"), i.getAttribute("type")]);
      expect(fields).toEqual([
        ["productId", "hidden"],
        ["quantity", "hidden"],
      ]);
      expect(form.querySelector("input[name='quantity']")?.getAttribute("value")).toBe("1");
      expect(within(form).getByRole("button", { name: /^\+?\s*Add to cart: / })).toHaveAttribute("type", "submit");
    }
    const inStock = getListingService()
      .deals(12)
      .filter((p) => p.stock > 0).length;
    expect(forms.length).toBe(inStock);
  });
});

describe("home page / — no cookie", () => {
  test("headings, landmark names and DOM ids are unique", async () => {
    withViews();
    await renderPage();
    const h2s = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
    expect(new Set(h2s).size).toBe(h2s.length);
    expect(h2s.length).toBeGreaterThan(8);

    const regionNames = screen.getAllByRole("region").map((r) => {
      const label = r.getAttribute("aria-label");
      if (label !== null) return label;
      const by = r.getAttribute("aria-labelledby");
      return by === null ? "" : (document.getElementById(by)?.textContent ?? "");
    });
    expect(regionNames.length).toBeGreaterThan(5);
    expect(regionNames.every((n) => n.trim() !== "")).toBe(true);
    expect(new Set(regionNames).size).toBe(regionNames.length);
    const navNames = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label") ?? n.getAttribute("aria-labelledby") ?? "");
    expect(navNames.every((n) => n.trim() !== "")).toBe(true);
    expect(new Set(navNames).size).toBe(navNames.length);
    const domIds = [...document.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(domIds).size).toBe(domIds.length);
  });

  test("every product link targets an existing slug; every img has an alt attribute (decorative tiles may be empty) (H-25)", async () => {
    withViews();
    const { container } = await renderPage();
    const slugs = new Set(getDatabase().query<{ slug: string }, []>("SELECT slug FROM products").all().map((r) => r.slug));
    const productLinks = [...container.querySelectorAll("a[href^='/products/']")];
    expect(productLinks.length).toBeGreaterThan(0);
    for (const link of productLinks) {
      const slug = decodeURIComponent((link.getAttribute("href") ?? "").slice("/products/".length));
      expect(slugs.has(slug)).toBe(true);
    }
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) expect({ src: img.getAttribute("src"), hasAlt: img.hasAttribute("alt") }).toEqual({ src: img.getAttribute("src"), hasAlt: true });
    // Decorative images (alt="") never leave a link nameless: every image link has text (card titles, tile captions).
    for (const img of container.querySelectorAll("a img[alt='']")) {
      expect((img.closest("a")?.textContent ?? "").trim()).not.toBe("");
    }
  });

  test("performs no session-dependent reads, no writes, sets no cookie", async () => {
    const recentlyViewed = track(spyOn(getRecommendationService(), "recentlyViewed"));
    const before = totalChanges();
    const { container } = await renderPage();
    expect(totalChanges()).toBe(before);
    expect(recentlyViewed).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(container.querySelector("#home-recently-viewed")).toBeNull();
  });

  test("exactly one JSON-LD script: the deals ItemList (no Organization/WebSite; the layout emits those) (H-23)", async () => {
    const { container } = await renderPage({ rail: "deals" });
    const scripts = ldScripts(container);
    expect(scripts).toHaveLength(1);
    const parsed = JSON.parse(scripts[0]?.textContent ?? "null") as {
      "@type": string;
      numberOfItems: number;
      itemListElement: { position: number; url: string; name?: string }[];
    };
    expect(parsed["@type"]).toBe("ItemList");
    const railLinks = productHrefs(section(container, "top-picks"));
    expect(parsed.numberOfItems).toBe(railLinks.length);
    parsed.itemListElement.forEach((item, i) => {
      expect(item.position).toBe(i + 1);
      expect(item.url).toBe(`https://shop.example.com${railLinks[i] ?? ""}`);
    });
    const raw = scripts.map((s) => s.textContent ?? "").join("");
    expect(raw).not.toMatch(/"@type":"(Organization|WebSite)"/);
  });

  test("the deals ItemList does not depend on the selected tab", async () => {
    const a = await renderPage({ rail: "top-rated" });
    const withTopRated = ldScripts(a.container).map((s) => s.textContent);
    a.unmount();
    const b = await renderPage();
    expect(ldScripts(b.container).map((s) => s.textContent)).toEqual(withTopRated);
  });

  test("hostile product names render as text and cannot break out of the JSON-LD script", async () => {
    const hostile = '</script><script>alert(1)</script><img src=x onerror="alert(2)">';
    const dealId = getListingService().deals(1)[0]?.id ?? "";
    expect(dealId).not.toBe("");
    getDatabase().query("UPDATE products SET name = ? WHERE id = ?").run(hostile, dealId);

    const { container } = await renderPage({ rail: "deals" });
    expect(container.querySelectorAll("img[src='x']")).toHaveLength(0);
    expect(container.querySelectorAll("script:not([type='application/ld+json'])")).toHaveLength(0);
    expect(screen.getAllByText(hostile).length).toBeGreaterThan(0);

    const scripts = ldScripts(container);
    expect(scripts).toHaveLength(1);
    const raw = scripts[0]?.innerHTML ?? "";
    expect(raw).not.toContain("</script");
    expect(raw).not.toContain("<");
    const parsed = JSON.parse(raw) as { itemListElement: { name?: string }[] };
    expect(parsed.itemListElement[0]?.name).toBe(hostile);
  });
});

describe("home page / — one clock (FIX-card-now)", () => {
  function countClockReads(): { reads: () => number; restore: () => void } {
    const RealDate = globalThis.Date;
    let reads = 0;
    class CountingDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        super(...args);
        const argc: number = args.length;
        if (argc === 0) reads += 1;
      }
      static override now(): number {
        reads += 1;
        return RealDate.now();
      }
    }
    globalThis.Date = CountingDate as DateConstructor;
    return { reads: () => reads, restore: () => void (globalThis.Date = RealDate) };
  }

  test("the loader reads the clock once; rendering the page element reads none", async () => {
    withViews();
    const { renderToStaticMarkup } = await import("react-dom/server");
    const loading = countClockReads();
    let element: Awaited<ReturnType<typeof Page>>;
    try {
      element = await Page(pageProps({ rail: "new-arrivals" }));
    } finally {
      loading.restore();
    }
    expect(loading.reads()).toBe(1);

    const rendering = countClockReads();
    let html = "";
    try {
      html = renderToStaticMarkup(element);
    } finally {
      rendering.restore();
    }
    expect(rendering.reads()).toBe(0);
    // The rails rendered (so the zero is meaningful): top picks and recently viewed both have cards.
    expect(html).toContain('id="top-picks"');
    expect(html).toContain('id="home-recently-viewed"');
  });
});

describe("home page / — with a session cookie", () => {
  test("recently viewed: owner-scoped, in stock only, quick add, no owner key in the markup (H-20)", async () => {
    const [a, b] = withViews();
    getDatabase().query("UPDATE products SET stock = 0 WHERE id = ?").run(b);

    const before = totalChanges();
    const { container } = await renderPage();
    expect(totalChanges()).toBe(before);
    expect(cookieSet).not.toHaveBeenCalled();

    const recent = section(container, "home-recently-viewed");
    expect(within(recent).getByRole("heading", { level: 2, name: HOME_CONTENT.recentlyViewed.title })).toBeDefined();
    expect(productHrefs(recent)).toEqual([`/products/${encodeURIComponent(slugOf(a))}`]);
    expect(recent.querySelectorAll("form input[name='productId']")).toHaveLength(1);
    expect(container.querySelector("#home-buy-again, #home-inspired")).toBeNull();

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(container.innerHTML).not.toContain(SESSION);
    expect(container.innerHTML).not.toMatch(UUID_RE);
  });

  test("another owner's views never show", async () => {
    withViews();
    jar.set(SESSION_COOKIE_NAME, "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d");
    const { container } = await renderPage();
    expect(container.querySelector("#home-recently-viewed")).toBeNull();
  });
});

describe("home page / — each section is omitted when its data is empty (H-4)", () => {
  const without = (...gone: string[]) => HOME_ORDER.filter((id) => id !== "home-recently-viewed" && !gone.includes(id));
  const emptyTabs = () => {
    const listing = getListingService();
    for (const name of ["deals", "bestSellers", "newArrivals", "topRated"] as const) track(spyOn(listing, name).mockReturnValue([]));
  };
  const cases: Array<[string, () => void, readonly string[]]> = [
    ["departments", () => track(spyOn(getListingService(), "categoryTree").mockReturnValue([])), ["home-categories", "home-discovery"]],
    ["brands", () => track(spyOn(SqliteBrandRepository.prototype, "listWithCounts").mockReturnValue([])), ["home-brands"]],
    ["shipping methods", () => track(spyOn(getShippingService(), "listMethods").mockReturnValue([])), ["home-shipping-promo"]],
    ["every top-picks tab", emptyTabs, ["top-picks"]],
  ];

  test.each(cases)("%s", async (_name, empty, gone) => {
    empty();
    const { container } = await renderPage();
    expect(sectionOrder(container)).toEqual(without(...gone));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    for (const el of container.querySelectorAll("section")) expect(el.querySelector("h1,h2,h3,h4,h5,h6,a,form,ul,img")).not.toBeNull();
  });

  test("deals empty: the deal panel and the ItemList go; top picks keeps the other tabs", async () => {
    track(spyOn(getListingService(), "deals").mockReturnValue([]));
    const { container } = await renderPage();
    expect(screen.queryByRole("heading", { name: DEAL_HEADING })).toBeNull();
    expect(ldScripts(container)).toHaveLength(0);
    expect(sectionOrder(container)).toEqual(without());
  });

  test("a failing reader drops only its tab (logged by code)", async () => {
    const errors = track(spyOn(console, "error").mockImplementation(() => {}));
    track(
      spyOn(getListingService(), "topRated").mockImplementation(() => {
        throw new Error("boom");
      }),
    );
    const { container } = await renderPage();
    const tabs = within(section(container, "top-picks")).getByRole("navigation", { name: HOME_CONTENT.topPicks.tabsLabel });
    expect(within(tabs).getAllByRole("link").map((a) => a.textContent?.trim())).toEqual(["Best sellers", "Deals", "New arrivals"]);
    expect(sectionOrder(container)).toEqual(without());
    expect(errors.mock.calls).toEqual([["[home] home.read_failed.topRated"]]);
  });

  test("empty catalog: hero h1, no product links, no rails, no JSON-LD", async () => {
    getDatabase().run("DELETE FROM products");
    const { container } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(container.querySelector("#top-picks")).toBeNull();
    expect(container.querySelectorAll("a[href^='/products/']")).toHaveLength(0);
    expect(ldScripts(container)).toHaveLength(0);
  });
});

describe("home page / — database failure", () => {
  test("repository failure rejects instead of rendering partial content", async () => {
    track(spyOn(console, "error").mockImplementation(() => {}));
    // Close the cached handle without forgetting it, so the page's queries fail.
    getDatabase().close();
    await expect(Page()).rejects.toThrow();
    // Forget the closed handle; the next getDatabase() opens a fresh one.
    closeDatabase();
  });
});
