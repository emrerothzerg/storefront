import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { RecordViewBeacon, ViewActionState } from "@/components/molecules/_contracts/view-actions";

// ---------------------------------------------------------------------------
// next/server + next/navigation + next/headers, the session module and the
// views action are mocked. mock.module is process-wide in bun test, so every
// mock lives in this file, is registered before `./page` is imported, spreads
// the real module and delegates to the real implementation unless a test
// switches it (other test files in the process keep working).
// ---------------------------------------------------------------------------

class NotFoundSentinel extends Error {
  constructor() {
    super("NEXT_NOT_FOUND (test sentinel)");
  }
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  writes = 0;

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string): void {
    this.writes += 1;
    this.jar.set(name, value);
  }

  delete(name: string): void {
    this.writes += 1;
    this.jar.delete(name);
  }
}

const connection = mock(async (): Promise<void> => undefined);

const realServer = { ...(await import("next/server")) };
const realNavigation = { ...(await import("next/navigation")) };
const realHeaders = { ...(await import("next/headers")) };

let fakeStore: FakeCookieStore | null = new FakeCookieStore();

mock.module("next/server", () => ({ ...realServer, connection }));
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    throw new NotFoundSentinel();
  },
}));
mock.module("next/headers", () => ({
  ...realHeaders,
  cookies: async () => fakeStore ?? realHeaders.cookies(),
}));

const realSession = { ...(await import("@/server/session/session")) };
const sessionCalls = {
  readSessionId: 0,
  getOrCreateSessionId: 0,
  rotateGuestSession: 0,
  setAuthCookie: 0,
  clearAuthCookie: 0,
};
mock.module("@/server/session/session", () => ({
  ...realSession,
  readSessionId: async () => {
    sessionCalls.readSessionId += 1;
    return realSession.readSessionId();
  },
  getOrCreateSessionId: async () => {
    sessionCalls.getOrCreateSessionId += 1;
    return realSession.getOrCreateSessionId();
  },
  rotateGuestSession: async () => {
    sessionCalls.rotateGuestSession += 1;
    return realSession.rotateGuestSession();
  },
  setAuthCookie: async (...args: Parameters<typeof realSession.setAuthCookie>) => {
    sessionCalls.setAuthCookie += 1;
    return realSession.setAuthCookie(...args);
  },
  clearAuthCookie: async () => {
    sessionCalls.clearAuthCookie += 1;
    return realSession.clearAuthCookie();
  },
}));

const realViews = { ...(await import("@/app/actions/views")) };
const beacon = mock<RecordViewBeacon>(async (): Promise<ViewActionState> => ({ ok: true, kind: "recorded" }));
let beaconImpl: RecordViewBeacon = beacon;
mock.module("@/app/actions/views", () => ({
  ...realViews,
  recordProductView: (input: { productId?: string; productSlug?: string }) => beaconImpl(input),
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { SqliteProductRepository } = await import("@/server/catalog/product-repository");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { getRecommendationService } = await import("@/server/recommendations/recommendation-service");
const { getListService } = await import("@/server/lists/list-service");
const { getStockAlertService } = await import("@/server/alerts/stock-alert-service");
const { getReviewService } = await import("@/server/reviews/review-service");
const { default: Page, generateMetadata } = await import("./page");
const { availabilityFor, centsToDecimalString } = await import("@/lib/seo/json-ld");

closeDatabase();
seedDatabase(getDatabase());

afterAll(() => {
  getDetailBySlug.mockRestore();
  closeDatabase();
  fakeStore = null;
  beaconImpl = realViews.recordProductView;
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const getDetailBySlug = spyOn(SqliteProductRepository.prototype, "getDetailBySlug");

const SESSION = "33333333-3333-4333-8333-333333333333";
const RATING_LINK = /^\d\.\d out of 5, [\d,]+ ratings?$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

beforeEach(() => {
  fakeStore = new FakeCookieStore();
  beaconImpl = beacon;
  for (const key of Object.keys(sessionCalls) as (keyof typeof sessionCalls)[]) sessionCalls[key] = 0;
});

afterEach(() => {
  getDetailBySlug.mockClear();
  connection.mockClear();
  beacon.mockClear();
});

function props(slug: string, searchParams: Record<string, string | string[]> = {}) {
  return { params: Promise.resolve({ slug }), searchParams: Promise.resolve(searchParams) };
}

async function renderPage(slug: string, searchParams: Record<string, string | string[]> = {}) {
  return render(await Page(props(slug, searchParams)));
}

function withCookie(id: string = SESSION): void {
  fakeStore?.jar.set(SESSION_COOKIE_NAME, id);
}

/** The page renders exactly ONE ld+json script holding [Product, BreadcrumbList]. */
function jsonLdScripts(container: HTMLElement): unknown[] {
  const scripts = container.querySelectorAll('script[type="application/ld+json"]');
  expect(scripts).toHaveLength(1);
  const parsed: unknown = JSON.parse(scripts[0]?.textContent ?? "null");
  return Array.isArray(parsed) ? parsed : [parsed];
}

function buyBox(): HTMLElement {
  return screen.getByRole("region", { name: "Buying options" });
}

function changes(): number {
  return getDatabase().query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}

describe("ProductPage (MVP)", () => {
  test("renders an in-stock product", async () => {
    const { container } = await renderPage("canvas-tote-bag");

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("Canvas Tote Bag");

    // T97: the gallery holds the main image (FBT/rails may show the product again).
    const gallery = container.querySelector("#gallery");
    if (!(gallery instanceof HTMLElement)) throw new Error("gallery missing");
    const img = within(gallery).getAllByRole("img")[0];
    expect(img?.getAttribute("src") ?? "").toContain("canvas-tote-bag");
    expect(within(buyBox()).getAllByText("$19.99").length).toBeGreaterThan(0);
    expect(within(buyBox()).getByText("In stock")).toBeInTheDocument();
    expect(screen.getByText(/Heavyweight natural cotton tote/)).toBeInTheDocument();

    const add = within(buyBox()).getByRole("button", { name: "Add to cart" });
    expect(add).toBeEnabled();
    expect(add).toHaveAttribute("type", "submit");
    expect(within(buyBox()).getByRole("group", { name: /quantity/i })).toBeInTheDocument();

    // The page renders inside the layout's <main>; it must not add its own.
    expect(container.querySelector("main")).toBeNull();
    expect(connection).toHaveBeenCalled();
    expect(getDetailBySlug).toHaveBeenCalledWith("canvas-tote-bag");
  });

  test("out-of-stock product: no add/buy buttons, no stepper, stock alert form (criterion 2)", async () => {
    const { container } = await renderPage("ceramic-pour-over");
    const box = buyBox();

    expect(within(box).getByText("Out of stock")).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "Add to cart" })).toBeNull();
    expect(within(box).queryByRole("button", { name: /buy now/i })).toBeNull();
    expect(within(box).queryByRole("group", { name: /quantity/i })).toBeNull();
    expect(within(box).getByRole("button", { name: "Notify me when available" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add to cart" })).toBeNull();
    expect(screen.queryByText("Frequently bought together")).toBeNull();

    const product = jsonLdScripts(container)[0];
    expect(product).toMatchObject({ offers: { availability: "https://schema.org/OutOfStock" } });
  });

  test("quantity is capped at the product's stock", async () => {
    await renderPage("walnut-desk");
    expect(within(buyBox()).getByText("Only 3 left in stock")).toBeInTheDocument();

    const group = within(buyBox()).getByRole("group", { name: /quantity/i });
    const increase = within(group).getByRole("button", { name: "Increase quantity" });
    const input = within(group).getByRole("textbox");
    for (let i = 0; i < 5; i += 1) fireEvent.click(increase);

    expect(input).toHaveValue("3");
    expect(increase).toBeDisabled();
    expect(input.closest("form")).not.toBeNull();
  });

  test("unknown valid slug queries once and calls notFound()", async () => {
    await expect(Page(props("nope"))).rejects.toBeInstanceOf(NotFoundSentinel);
    expect(getDetailBySlug).toHaveBeenCalledTimes(1);
  });

  test.each(["' OR 1=1 --", "a".repeat(200), "../../etc/passwd", "../etc", "Canvas-Tote-Bag", ""])(
    "invalid slug %p calls notFound() without a DB query",
    async (slug) => {
      await expect(Page(props(slug))).rejects.toBeInstanceOf(NotFoundSentinel);
      expect(getDetailBySlug).not.toHaveBeenCalled();
    },
  );

  test("the products table survives the injection attempt", async () => {
    await expect(Page(props("x'; DROP TABLE products; --"))).rejects.toBeInstanceOf(NotFoundSentinel);
    const row = getDatabase().query<{ n: number }, []>("SELECT COUNT(*) AS n FROM products").get();
    expect(row?.n).toBeGreaterThan(0);
  });
});

describe("generateMetadata", () => {
  const siteUrl = env.NEXT_PUBLIC_SITE_URL;
  beforeEach(() => {
    env.NEXT_PUBLIC_SITE_URL = "https://shop.example.com";
  });
  afterEach(() => {
    if (siteUrl === undefined) delete env.NEXT_PUBLIC_SITE_URL;
    else env.NEXT_PUBLIC_SITE_URL = siteUrl;
  });

  test("known slug: product title, description, canonical and OG image", async () => {
    const product = new SqliteProductRepository(getDatabase()).getBySlug("walnut-desk");
    if (!product) throw new Error("seed is missing walnut-desk");
    const metadata = await generateMetadata(props("walnut-desk"));

    expect(metadata.title).toBe("Walnut Standing Desk");
    // CONS-B4: walnut-desk's own copy is 64 chars, so the builder extends it (70-160) and keeps it as the prefix.
    expect(String(metadata.description).startsWith(product.description)).toBe(true);
    expect(String(metadata.description).length).toBeGreaterThanOrEqual(70);
    expect(String(metadata.description).length).toBeLessThanOrEqual(160);
    expect(metadata.description).toContain("Walnut Standing Desk");
    expect(metadata.alternates?.canonical).toBe("https://shop.example.com/products/walnut-desk");
    expect(metadata.openGraph).toMatchObject({
      url: "https://shop.example.com/products/walnut-desk",
      title: "Walnut Standing Desk",
      images: [{ url: `https://shop.example.com${product.imageUrl}`, alt: "Walnut Standing Desk" }],
    });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
    expect(metadata.robots).toBeUndefined();
    expect(connection).toHaveBeenCalled();
  });

  test("unknown and invalid slugs: generic noindex fallback without throwing", async () => {
    for (const slug of ["nope", "' OR 1=1 --", ""]) {
      const metadata = await generateMetadata(props(slug));
      expect(metadata.title).toBe("Product not found");
      expect(metadata.robots).toEqual({ index: false, follow: false });
      expect(metadata.alternates).toBeUndefined();
      expect(metadata.openGraph).not.toHaveProperty("images");
    }
  });

  test("canonical and title are constant across query strings (criterion 7)", async () => {
    const queries: Record<string, string | string[]>[] = [
      {},
      { img: "2" },
      { sort: "recent", stars: "4", verified: "1", rpage: "3" },
      { qpage: "2" },
      { utm_source: "x", img: "abc", stars: ["7", "1"] },
    ];
    const seen = new Set<string>();
    for (const query of queries) {
      const metadata = await generateMetadata(props("walnut-desk", query));
      seen.add(`${String(metadata.alternates?.canonical)}|${String(metadata.title)}`);
    }
    expect([...seen]).toEqual(["https://shop.example.com/products/walnut-desk|Walnut Standing Desk"]);
  });

  test("metadata never reads the session or writes", async () => {
    withCookie();
    const before = changes();
    await generateMetadata(props("walnut-desk"));
    expect(sessionCalls.readSessionId).toBe(0);
    expect(changes()).toBe(before);
  });
});

describe("structured data (criterion 3)", () => {
  test("renders Product and BreadcrumbList JSON-LD in one script outside the article", async () => {
    const row = new SqliteProductRepository(getDatabase()).getBySlug("ceramic-pour-over");
    if (!row) throw new Error("seed is missing ceramic-pour-over");
    const { container } = await renderPage("ceramic-pour-over");
    const scripts = jsonLdScripts(container);
    expect(scripts).toHaveLength(2); // two graphs in one script
    const [product, breadcrumbs] = scripts;

    // Seed-agnostic: sku/brand come from the seeded row (sku falls back to id).
    expect(product).toMatchObject({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Ceramic Pour-Over",
      sku: row.sku?.trim() || row.id,
      offers: {
        "@type": "Offer",
        price: centsToDecimalString(row.priceCents, row.currency),
        priceCurrency: row.currency,
        availability: availabilityFor(row.stock),
      },
    });
    if (row.brandName) {
      expect(product).toMatchObject({ brand: { "@type": "Brand", name: row.brandName } });
    } else {
      expect(product).not.toHaveProperty("brand");
    }
    if (!row.ratingCount) expect(product).not.toHaveProperty("aggregateRating");
    // T97: the breadcrumb now includes the category path between Home and the product.
    const crumbs = (breadcrumbs as { itemListElement: { position: number; name: string }[] }).itemListElement;
    expect(breadcrumbs).toMatchObject({ "@type": "BreadcrumbList" });
    expect(crumbs[0]).toMatchObject({ position: 1, name: "Home" });
    expect(crumbs.at(-1)).toMatchObject({ position: crumbs.length, name: "Ceramic Pour-Over" });
    if (row.categoryName) expect(crumbs.map((c) => c.name)).toContain(row.categoryName);
    expect(container.querySelector("article script")).toBeNull();
  });

  test("price is a 2-decimal string and aggregateRating matches the reviews", async () => {
    const { container } = await renderPage("canvas-tote-bag");
    const product = jsonLdScripts(container)[0] as {
      offers: { price: string; url: string };
      aggregateRating?: { ratingCount: number };
      review?: unknown[];
      url: string;
    };
    expect(product.offers.price).toBe("19.99");
    expect(product.offers.url).toMatch(/\/products\/canvas-tote-bag$/);
    expect(product.aggregateRating?.ratingCount).toBe(2);
    expect(product.review?.length).toBe(2);
  });

  test("hostile product text cannot break out of the JSON-LD script", async () => {
    const hostile = "</script><script>alert(1)</script>";
    const real = new SqliteProductRepository(getDatabase()).getDetailBySlug("canvas-tote-bag");
    if (!real) throw new Error("seed is missing canvas-tote-bag");
    // Both the page loader and the metadata read go through getDetailBySlug.
    getDetailBySlug.mockImplementationOnce(() => ({ ...real, name: hostile, description: hostile }));
    const { container } = await renderPage("canvas-tote-bag");
    const scripts = container.querySelectorAll("script");
    expect(scripts).toHaveLength(1);
    for (const script of scripts) expect(script.innerHTML).not.toContain("</script");
    expect(scripts[0]?.innerHTML).toContain("\\u003c/script\\u003e");
    expect(jsonLdScripts(container)[0]).toMatchObject({ name: hostile });
  });

  test("reviews: capped at 5 newest, </script> in review text escaped; 0 reviews -> no aggregateRating", async () => {
    const db = getDatabase();
    const productId = "prod_merino-beanie";
    db.run("DELETE FROM reviews WHERE product_id = ?", [productId]);
    const empty = await renderPage("merino-beanie");
    const emptyLd = jsonLdScripts(empty.container)[0];
    expect(emptyLd).not.toHaveProperty("aggregateRating");
    expect(emptyLd).not.toHaveProperty("review");
    expect(screen.queryByRole("link", { name: RATING_LINK })).toBeNull();
    empty.unmount();

    const service = getReviewService();
    const hostile = "Great </script><script>alert(1)</script> hat";
    const base = Date.now() - 60_000;
    for (let i = 0; i < 7; i += 1) {
      const owner = `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`;
      const created = service.create(
        owner,
        { productId, rating: 5, title: `Review ${i}`, body: i === 6 ? hostile : `Body number ${i}` },
        base + i * 1000,
      );
      if (!created.ok) throw new Error(`review ${i} failed: ${created.error.code}`);
    }
    const { container } = await renderPage("merino-beanie");
    const product = jsonLdScripts(container)[0] as {
      aggregateRating: { ratingCount: number };
      review: { name: string; reviewBody: string }[];
    };
    expect(product.aggregateRating.ratingCount).toBe(7);
    expect(product.review).toHaveLength(5);
    expect(product.review.map((r) => r.name)).toEqual(["Review 6", "Review 5", "Review 4", "Review 3", "Review 2"]);
    expect(product.review[0]?.reviewBody).toBe(hostile);
    const raw = container.querySelector('script[type="application/ld+json"]')?.innerHTML ?? "";
    expect(raw).not.toContain("</script");
    expect(container.querySelectorAll("script")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "5.0 out of 5, 7 ratings" })).toHaveAttribute("href", "#reviews");
  });
});

describe("structure (criteria 4 and 6)", () => {
  test("one h1, breadcrumb, brand link, sections, rails, reviews and Q&A", async () => {
    const detail = new SqliteProductRepository(getDatabase()).getDetailBySlug("canvas-tote-bag");
    if (!detail) throw new Error("seed is missing canvas-tote-bag");
    const { container } = await renderPage("canvas-tote-bag");

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    if (detail.brand) {
      expect(screen.getByRole("link", { name: `Visit the ${detail.brand.name} store` })).toHaveAttribute(
        "href",
        `/brand/${detail.brand.slug}`,
      );
    }
    expect(screen.getByRole("heading", { name: "About this item" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Product description" })).toBeInTheDocument();
    const specs = screen.getByRole("region", { name: "Specifications table" });
    expect(within(specs).getAllByRole("rowheader").length).toBe(detail.specs.length);
    expect(screen.getByRole("heading", { name: "Product information" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Customers who bought this also bought" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Customers also viewed" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Related products" })).toBeInTheDocument();
    // No cookie: no recently viewed rail.
    expect(screen.queryByRole("heading", { name: "Your recently viewed items" })).toBeNull();
    expect(container.querySelector("#reviews")).not.toBeNull();
    expect(container.querySelector("#write-review")).not.toBeNull();
    expect(container.querySelector("#questions")).not.toBeNull();
    // Every same-page anchor the page itself renders resolves.
    expect(screen.getByRole("link", { name: RATING_LINK })).toHaveAttribute("href", "#reviews");
  });

  test("sections without data are omitted", async () => {
    const db = getDatabase();
    db.run(
      "UPDATE products SET bullets = '[]', specs = '[]', description = '', brand_id = NULL, sku = NULL WHERE slug = 'linen-napkins'",
    );
    db.run("DELETE FROM reviews WHERE product_id = 'prod_linen-napkins'");
    await renderPage("linen-napkins");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "About this item" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Product description" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Specifications" })).toBeNull();
    expect(screen.queryByRole("link", { name: /store$/ })).toBeNull();
    expect(screen.queryByRole("link", { name: RATING_LINK })).toBeNull();
    expect(screen.queryByText(/bought in past month/)).toBeNull();
    expect(screen.queryByText(/Best Sellers Rank/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Your recently viewed items" })).toBeNull();
    // Category stays, so "Product information" remains with just that row.
    const info = screen.queryByRole("region", { name: "Product information table" });
    if (info) expect(within(info).queryByText("SKU")).toBeNull();
  });

  test("garbage query params render the defaults; valid ones reach the organisms", async () => {
    const garbage = await renderPage("canvas-tote-bag", { img: "abc", stars: "7", rpage: "-1", sort: "x", qpage: "zz" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /Remove filter/ })).toBeNull();
    garbage.unmount();

    await renderPage("canvas-tote-bag", { stars: "5" });
    expect(screen.getByRole("link", { name: /Remove filter: 5 stars/ })).toBeInTheDocument();
  });

  test("?img=N selects the gallery image without JS links", async () => {
    const detail = new SqliteProductRepository(getDatabase()).getDetailBySlug("canvas-tote-bag");
    if (!detail || detail.images.length < 2) throw new Error("seed gallery too small");
    const { container } = await renderPage("canvas-tote-bag", { img: "1" });
    const gallery = container.querySelector("#gallery");
    if (!(gallery instanceof HTMLElement)) throw new Error("gallery missing");
    const main = within(gallery).getAllByRole("img")[0];
    expect(main?.getAttribute("src") ?? "").toContain(detail.images[1]?.url.split("/").pop()?.replace(".svg", "") ?? "?");
  });
});

describe("view recording and session (criterion 5, R-1)", () => {
  test("with a cookie: exactly one record call, ViewTracker inert, no session minted", async () => {
    withCookie();
    const service = getRecommendationService();
    const record = spyOn(service, "recordView");
    try {
      await renderPage("canvas-tote-bag");
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]?.[0]).toBe(SESSION);
      expect(beacon).not.toHaveBeenCalled();
      expect(sessionCalls).toEqual({
        readSessionId: 1,
        getOrCreateSessionId: 0,
        rotateGuestSession: 0,
        setAuthCookie: 0,
        clearAuthCookie: 0,
      });
      expect(fakeStore?.writes).toBe(0);
    } finally {
      record.mockRestore();
    }
  });

  test("recently viewed rail appears with a cookie and other history", async () => {
    withCookie();
    await renderPage("walnut-desk");
    await renderPage("canvas-tote-bag");
    const rails = screen.getAllByRole("heading", { name: "Your recently viewed items" });
    expect(rails.length).toBeGreaterThan(0);
  });

  test("without a cookie: no DB writes, ViewTracker armed (one beacon after hydration), no session minted", async () => {
    const service = getRecommendationService();
    const record = spyOn(service, "recordView");
    try {
      const before = changes();
      const element = await Page(props("canvas-tote-bag"));
      // Nothing happened during render: no write, no beacon.
      expect(changes()).toBe(before);
      expect(beacon).not.toHaveBeenCalled();
      render(element);
      expect(changes()).toBe(before);
      expect(record).not.toHaveBeenCalled();
      expect(beacon).toHaveBeenCalledTimes(1);
      expect(beacon).toHaveBeenCalledWith({ productId: "prod_canvas-tote-bag", productSlug: "canvas-tote-bag" });
      expect(sessionCalls.readSessionId).toBe(1);
      expect(sessionCalls.getOrCreateSessionId).toBe(0);
      expect(fakeStore?.writes).toBe(0);
    } finally {
      record.mockRestore();
    }
  });

  test("cookie present but recordView fails (error result or throw): ViewTracker is armed (recorded=false) and the beacon fires", async () => {
    const { appError } = await import("@/lib/result");
    const service = getRecommendationService();
    const failures: Array<() => ReturnType<typeof service.recordView>> = [
      () => ({ ok: false, error: appError("INTERNAL_ERROR", "db down") }),
      () => {
        throw new Error("SQLITE_BUSY");
      },
    ];
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const fail of failures) {
        withCookie();
        beacon.mockClear();
        const record = spyOn(service, "recordView").mockImplementation(fail);
        try {
          const { unmount } = await renderPage("canvas-tote-bag");
          expect(record).toHaveBeenCalledTimes(1);
          expect(beacon).toHaveBeenCalledTimes(1);
          expect(beacon).toHaveBeenCalledWith({ productId: "prod_canvas-tote-bag", productSlug: "canvas-tote-bag" });
          expect(sessionCalls.getOrCreateSessionId).toBe(0);
          unmount();
        } finally {
          record.mockRestore();
        }
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("no owner key or other UUID-shaped secret in the markup or JSON-LD", async () => {
    withCookie();
    const lists = getListService().addItem(SESSION, null, "prod_glass-water-bottle");
    if (!lists.ok) throw new Error("wishlist seed failed");
    const review = getReviewService().create(SESSION, {
      productId: "prod_glass-water-bottle",
      rating: 4,
      title: "Nice bottle",
      body: "Keeps water cold all day.",
    });
    if (!review.ok) throw new Error("review seed failed");
    db_setStock("glass-water-bottle", 0);
    const alert = getStockAlertService().subscribe(SESSION, "prod_glass-water-bottle");
    if (!alert.ok) throw new Error("alert seed failed");

    const { container } = await renderPage("glass-water-bottle");
    const html = container.innerHTML;
    expect(html).not.toContain(SESSION);
    // Allowed: the viewer's own list/alert ids (form fields) and review ids.
    const allowed = new Set([lists.value.listId, alert.value.alert.id, review.value.id].map((id) => id.toLowerCase()));
    const found = (html.match(UUID_RE) ?? []).map((id) => id.toLowerCase());
    for (const id of found) expect(allowed.has(id)).toBe(true);
    for (const script of jsonLdScripts(container)) expect(JSON.stringify(script)).not.toMatch(UUID_RE);
  });

  test("unpublished product 404s and records nothing even with a cookie", async () => {
    withCookie("55555555-5555-4555-8555-555555555555");
    const db = getDatabase();
    db.run("UPDATE products SET published_at = ? WHERE slug = 'enamel-pin-set'", [
      new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ]);
    await expect(Page(props("enamel-pin-set"))).rejects.toBeInstanceOf(NotFoundSentinel);
    const views = db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?")
      .get("55555555-5555-4555-8555-555555555555");
    expect(views?.n).toBe(0);
    const metadata = await generateMetadata(props("enamel-pin-set"));
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe("consistency ad/ae: signed-in identity and server-passed gallery basePath", () => {
  test("guest: the review and question forms ask for a display name; no 'Posting as'", async () => {
    const { container } = await renderPage("canvas-tote-bag");
    expect(container.textContent).not.toContain("Posting as");
    expect(container.querySelector('#write-review input[name="displayName"]')).not.toBeNull();
  });

  test("signed in: forms show 'Posting as <displayName>' (read-only: no cookie writes, no email or token in markup)", async () => {
    const { getAuthService } = await import("@/server/auth/auth-service");
    const { AUTH_COOKIE_NAME } = await import("@/server/session/session");
    const issued = await getAuthService().signUp(
      { email: "pdp.identity@example.com", password: "correct horse battery staple", displayName: "Grace Hopper" },
      { sessionKey: "66666666-6666-4666-8666-666666666666" },
    );
    if (!issued.ok) throw new Error(`signUp failed: ${issued.error.code}`);
    fakeStore?.jar.set(AUTH_COOKIE_NAME, issued.value.token);
    const { container } = await renderPage("canvas-tote-bag");
    const reviewForm = container.querySelector("#write-review");
    expect(reviewForm?.textContent).toContain("Posting as Grace Hopper");
    expect(reviewForm?.querySelector('input[name="displayName"]')).toBeNull();
    expect(container.innerHTML).not.toContain("pdp.identity@example.com");
    expect(container.innerHTML).not.toContain(issued.value.token);
    expect(fakeStore?.writes).toBe(0);
    expect(sessionCalls.getOrCreateSessionId).toBe(0);
  });

  test("no-JS gallery links come from the basePath prop: /products/<slug>?img=N#gallery", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const detail = new SqliteProductRepository(getDatabase()).getDetailBySlug("canvas-tote-bag");
    if (!detail || detail.images.length < 2) throw new Error("seed gallery too small");
    const html = renderToStaticMarkup(await Page(props("canvas-tote-bag", { img: "1" })));
    expect(html).toContain('href="/products/canvas-tote-bag#gallery"');
    expect(html).toContain('href="/products/canvas-tote-bag?img=1#gallery"');
  });

  test("ImageGallery's link param matches the PDP parser's param", async () => {
    const { IMAGE_PARAM } = await import("./_lib/pdp-params");
    const { IMAGE_GALLERY_PARAM } = await import("@/components/molecules/ImageGallery");
    expect(IMAGE_GALLERY_PARAM).toBe(IMAGE_PARAM);
  });
});

describe("T169 v3 composition (reference pending)", () => {
  /** a precedes b in document order. */
  function before(a: Element | null, b: Element | null): boolean {
    if (a === null || b === null) throw new Error("element missing");
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  test("the page file header says 'reference pending' (AC6)", async () => {
    const source = await Bun.file(new URL("./page.tsx", import.meta.url)).text();
    expect(source).toMatch(/reference pending/i);
  });

  test("title stays the only h1 but uses the h2 scale (h1 from md), balanced wrapping, no display size (U09)", async () => {
    await renderPage("canvas-tote-bag");
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.tagName).toBe("H1");
    const classes = h1.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["text-h2", "md:text-h1", "text-balance", "break-words"]));
    expect(classes.some((c) => c.includes("text-h1-lg"))).toBe(false);
    expect(classes.some((c) => c.startsWith("hyphens-auto") || c === "break-all")).toBe(false);
  });

  test("DOM order: breadcrumb -> gallery -> title block (h1, brand, rating) -> buy box (P-1, P-3)", async () => {
    const { container } = await renderPage("canvas-tote-bag");
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    const gallery = container.querySelector("#gallery");
    const h1 = screen.getByRole("heading", { level: 1 });
    const box = buyBox();
    expect(before(breadcrumb, gallery)).toBe(true);
    expect(before(gallery, h1)).toBe(true);
    expect(before(h1, box)).toBe(true);

    // The first <article> on the page is the product (QA pages-pdp reads its forms).
    const article = container.querySelector("article");
    expect(article?.contains(gallery)).toBe(true);
    expect(article?.contains(box)).toBe(true);
    expect(article?.className).toContain("lg:grid-cols-12");

    const title = container.querySelector('[data-testid="pdp-title-block"]');
    if (!(title instanceof HTMLElement)) throw new Error("title block missing");
    expect(within(title).getByRole("heading", { level: 1 })).toHaveTextContent("Canvas Tote Bag");
    expect(within(title).getByRole("link", { name: RATING_LINK })).toHaveAttribute("href", "#reviews");
    const brand = within(title).queryByRole("link", { name: /^Visit the .+ store$/ });
    if (brand) {
      expect(brand.getAttribute("href") ?? "").toMatch(/^\/brand\/[a-z0-9-]+$/);
      expect(before(h1, brand)).toBe(true);
    }
  });

  test("D-T169-2: the standalone brand store link is a 44px target and keeps the inline look", async () => {
    const { container } = await renderPage("canvas-tote-bag");
    const title = container.querySelector('[data-testid="pdp-title-block"]');
    if (!(title instanceof HTMLElement)) throw new Error("title block missing");
    const brand = within(title).getByRole("link", { name: /^Visit the .+ store$/ });
    expect(brand.className.split(/\s+/)).toEqual(expect.arrayContaining(["inline-flex", "min-h-touch", "items-center", "underline"]));
  });

  test("the buy box is sticky only from lg (P-14) and sits in a block column", async () => {
    await renderPage("canvas-tote-bag");
    const box = buyBox();
    expect(box).toHaveAttribute("data-sticky");
    expect(box.className).toContain("lg:sticky");
    expect(box.className.split(/\s+/)).not.toContain("sticky");
    expect(box.parentElement?.className ?? "").not.toMatch(/\bflex\b/);
  });

  test("badge row: card rules (Sale for a list price above the price); none for a plain product (P-5)", async () => {
    const sale = await renderPage("gooseneck-kettle");
    const badges = sale.container.querySelector('[data-testid="pdp-badges"]');
    if (!(badges instanceof HTMLElement)) throw new Error("badge row missing");
    const labels = [...badges.children].map((b) => b.textContent);
    expect(labels[0]).toBe("Sale");
    expect(labels.length).toBeLessThanOrEqual(2);
    for (const label of labels) expect(["Sale", "New", "Top pick"]).toContain(label ?? "");
    sale.unmount();

    const plain = await renderPage("canvas-tote-bag");
    expect(plain.container.querySelector('[data-testid="pdp-badges"]')).toBeNull();
  });

  test("About this item, description, specifications and information are Card sections with h2s (P-11)", async () => {
    const { container } = await renderPage("canvas-tote-bag");
    for (const id of ["about-heading", "description-heading", "specs-heading", "info-heading"]) {
      const heading = container.querySelector(`#${id}`);
      expect(heading?.tagName).toBe("H2");
      const section = heading?.closest("section");
      expect(section?.getAttribute("aria-labelledby")).toBe(id);
      expect(section?.className ?? "").toContain("rounded-lg");
    }
    const about = container.querySelector("#about-heading")?.closest("section");
    expect(about?.querySelector("ul > li")).not.toBeNull();
    const specs = screen.getByRole("region", { name: "Specifications table" });
    expect(specs.querySelector("th[scope='row']")).not.toBeNull();
    // Content cards come after the product article.
    expect(before(container.querySelector("article"), about ?? null)).toBe(true);
  });

  test("section order: content cards -> reviews -> questions -> rails; anchors unchanged", async () => {
    const { container } = await renderPage("canvas-tote-bag");
    const about = container.querySelector("#about-heading");
    const reviews = container.querySelector("#reviews");
    const questions = container.querySelector("#questions");
    const related = container.querySelector("#rail-related");
    expect(container.querySelector("#write-review")).not.toBeNull();
    expect(before(about, reviews)).toBe(true);
    expect(before(reviews, questions)).toBe(true);
    expect(before(questions, related)).toBe(true);
  });

  test("rails: compact cards with a '+ Add' form (productId + quantity=1) and never the current product (P-12)", async () => {
    withCookie("77777777-7777-4777-8777-777777777777");
    await renderPage("walnut-desk");
    const { container } = await renderPage("canvas-tote-bag");
    const rails = [...container.querySelectorAll<HTMLElement>("section[id^='rail-']")];
    expect(rails.map((r) => r.id)).toContain("rail-recently-viewed");
    for (const rail of rails) {
      const cards = [...rail.querySelectorAll("article")];
      expect(cards.length).toBeGreaterThan(0);
      for (const card of cards) {
        expect(card.getAttribute("data-variant")).toBe("compact");
        expect(card.querySelector('a[href="/products/canvas-tote-bag"]')).toBeNull();
      }
      const forms = [...rail.querySelectorAll("form")];
      expect(forms.length).toBeGreaterThan(0);
      for (const form of forms) {
        const names = [...form.querySelectorAll("input")].map((i) => i.getAttribute("name")).sort();
        expect(names).toEqual(["productId", "quantity"]);
        expect(form.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
      }
    }
  });

  test("empty rails are omitted (no empty headings)", async () => {
    const reco = getRecommendationService();
    const spies = [
      spyOn(reco, "alsoBought").mockImplementation(() => []),
      spyOn(reco, "alsoViewed").mockImplementation(() => []),
      spyOn(reco, "related").mockImplementation(() => []),
    ];
    try {
      const { container } = await renderPage("canvas-tote-bag");
      expect(container.querySelector("section[id^='rail-']")).toBeNull();
      expect(screen.queryByRole("heading", { name: "Related products" })).toBeNull();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("one clock: rendering the page element reads no clock (cards and badges use the loader's now)", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const element = await Page(props("gooseneck-kettle"));
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
    try {
      renderToStaticMarkup(element);
    } finally {
      globalThis.Date = RealDate;
    }
    expect(reads).toBe(0);
  });

  test("hostile product text renders as text in the title, bullets and specs", async () => {
    const hostile = "<b>bold</b><img src=x onerror=alert(1)>";
    const real = new SqliteProductRepository(getDatabase()).getDetailBySlug("canvas-tote-bag");
    if (!real) throw new Error("seed is missing canvas-tote-bag");
    getDetailBySlug.mockImplementationOnce(() => ({
      ...real,
      name: hostile,
      bullets: [hostile],
      specs: [{ label: hostile, value: hostile }],
    }));
    const { container } = await renderPage("canvas-tote-bag");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(hostile);
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img[src='x']")).toBeNull();
  });
});

function db_setStock(slug: string, stock: number): void {
  getDatabase().run("UPDATE products SET stock = ? WHERE slug = ?", [stock, slug]);
}
