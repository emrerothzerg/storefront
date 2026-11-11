import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createListService } from "@/server/lists/list-service";
import { createStockAlertService } from "@/server/alerts/stock-alert-service";
import type { Product } from "@/lib/types";
import { createPdpDeps, loadPdp, loadPublishedProduct, withoutProduct, type PdpDeps } from "./pdp-data";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let db: Database;
let deps: PdpDeps;
const now = Date.now();

function changes(): number {
  return db.query<{ n: number }, []>("SELECT total_changes() AS n").get()?.n ?? -1;
}

function viewCount(sessionId: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?").get(sessionId)?.n ?? -1;
}

beforeEach(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(now) });
  deps = createPdpDeps(db);
});

afterEach(() => {
  db.close();
});

async function load(slug: unknown, sessionId: string | null = null, searchParams = {}) {
  return loadPdp({ slug, sessionId, searchParams, now }, deps);
}

describe("loadPdp: not found (criterion 1)", () => {
  test.each(["../etc/passwd", "../../etc", "' OR 1=1 --", "", "A", "a".repeat(200), "x'; DROP TABLE products; --"])(
    "hostile slug %p -> not found, no DB call",
    async (slug) => {
      // A fresh fake (not a spy on the shared prototype) so other files' spies cannot leak calls in.
      const getDetail = mock<PdpDeps["products"]["getPublishedDetailBySlug"]>(() => null);
      deps = { ...deps, products: { getPublishedDetailBySlug: getDetail } };
      expect(await load(slug)).toEqual({ found: false });
      expect(getDetail).not.toHaveBeenCalled();
    },
  );

  test.each<[unknown]>([[undefined], [null], [42], [["canvas-tote-bag"]]])("non-string slug %p -> not found", async (slug) => {
    expect(await load(slug)).toEqual({ found: false });
  });

  test("unknown valid slug -> not found", async () => {
    expect(await load("no-such-product")).toEqual({ found: false });
  });

  test("unpublished product -> not found, and nothing recorded even with a cookie", async () => {
    db.run("UPDATE products SET published_at = ? WHERE slug = 'canvas-tote-bag'", [new Date(now + 86_400_000).toISOString()]);
    expect(await load("canvas-tote-bag", SESSION)).toEqual({ found: false });
    expect(viewCount(SESSION)).toBe(0);
    expect(loadPublishedProduct("canvas-tote-bag", now, deps.products)).toBeNull();
  });

  test("publication rule via the shared getter: inclusive now; future, empty and garbage dates are unpublished", () => {
    const at = (publishedAt: string) => {
      db.run("UPDATE products SET published_at = ? WHERE slug = 'canvas-tote-bag'", [publishedAt]);
      return loadPublishedProduct("canvas-tote-bag", now, deps.products)?.slug ?? null;
    };
    expect(at("2020-01-01T00:00:00.000Z")).toBe("canvas-tote-bag");
    expect(at(new Date(now).toISOString())).toBe("canvas-tote-bag");
    expect(at(new Date(now + 1000).toISOString())).toBeNull();
    expect(at("")).toBeNull();
    expect(at("garbage")).toBeNull();
    db.run("UPDATE products SET published_at = '2020-01-01T00:00:00.000Z' WHERE slug = 'canvas-tote-bag'");
    expect(loadPublishedProduct("canvas-tote-bag", Number.NaN, deps.products)).toBeNull();
  });
});

describe("loadPdp: data", () => {
  test("loads every section for a seeded product", async () => {
    const result = await load("canvas-tote-bag");
    if (!result.found) throw new Error("expected found");
    const d = result.data;
    expect(d.product.slug).toBe("canvas-tote-bag");
    expect(d.path).toBe("/products/canvas-tote-bag");
    expect(d.breadcrumb[0]).toEqual({ label: "Home", href: "/" });
    expect(d.breadcrumb.at(-1)).toEqual({ label: "Canvas Tote Bag" });
    for (const crumb of d.breadcrumb.slice(1, -1)) expect(crumb.href).toMatch(/^\/category\/[a-z0-9-]+$/);
    if (d.product.brand) expect(d.brandHref).toBe(`/brand/${d.product.brand.slug}`);
    expect(d.reviews.summary.count).toBeGreaterThanOrEqual(0);
    expect(d.qa.page).toBe(1);
    expect(d.rails.related.every((p) => p.id !== d.product.id)).toBe(true);
    expect(d.rails.recentlyViewed).toEqual([]);
    expect(d.delivery.estimate).not.toBeNull();
    expect(d.qaExtraParams).toEqual({});
  });

  test("garbage params reach the services as defaults", async () => {
    const listSpy = spyOn(deps.reviews, "list");
    const qaSpy = spyOn(deps.qa, "list");
    const result = await load("canvas-tote-bag", null, { stars: "7", rpage: "-1", sort: "x", qpage: "abc", img: "abc" });
    if (!result.found) throw new Error("expected found");
    expect(result.data.params.img).toBe(0);
    expect(listSpy.mock.calls[0]?.[1]).toEqual({ sort: "helpful", verifiedOnly: false, page: 1 });
    expect(qaSpy.mock.calls[0]?.[1]).toEqual({ page: 1 });
  });

  test("valid params are passed through and kept for Q&A links", async () => {
    const listSpy = spyOn(deps.reviews, "list");
    const result = await load("canvas-tote-bag", null, { stars: "5", sort: "recent", verified: "1", rpage: "2", qpage: "3" });
    if (!result.found) throw new Error("expected found");
    expect(listSpy.mock.calls[0]?.[1]).toEqual({ sort: "recent", stars: 5, verifiedOnly: true, page: 2 });
    expect(result.data.qaExtraParams).toEqual({ sort: "recent", stars: "5", verified: "1", rpage: "2" });
  });

  test("an optional section that throws degrades and logs a code only", async () => {
    const logError = mock<(code: string) => void>(() => undefined);
    deps = {
      ...deps,
      logError,
      recommendations: {
        ...deps.recommendations,
        related: () => {
          throw new Error(`boom ${SESSION}`);
        },
        alsoBought: deps.recommendations.alsoBought.bind(deps.recommendations),
        alsoViewed: deps.recommendations.alsoViewed.bind(deps.recommendations),
        recentlyViewed: deps.recommendations.recentlyViewed.bind(deps.recommendations),
        frequentlyBoughtTogether: deps.recommendations.frequentlyBoughtTogether.bind(deps.recommendations),
        boughtLastMonth: deps.recommendations.boughtLastMonth.bind(deps.recommendations),
        recordView: deps.recommendations.recordView.bind(deps.recommendations),
      },
    };
    const result = await load("canvas-tote-bag");
    if (!result.found) throw new Error("expected found");
    expect(result.data.rails.related).toEqual([]);
    expect(logError).toHaveBeenCalledWith("PDP_RELATED_FAILED");
    expect(JSON.stringify(logError.mock.calls)).not.toContain(SESSION);
  });

  test("out-of-stock product: no FBT bundle", async () => {
    const result = await load("ceramic-pour-over");
    if (!result.found) throw new Error("expected found");
    expect(result.data.product.stock).toBe(0);
    expect(result.data.bundle).toBeNull();
  });
});

describe("loadPdp: view recording and viewer (criterion 5, R-1)", () => {
  test("with a cookie: exactly one recordView call, one row, rail excludes the current product", async () => {
    const recordSpy = spyOn(deps.recommendations, "recordView");
    deps.recommendations.recordView(SESSION, "prod_walnut-desk", now - 1000);
    recordSpy.mockClear();

    const result = await load("canvas-tote-bag", SESSION);
    if (!result.found) throw new Error("expected found");
    expect(recordSpy).toHaveBeenCalledTimes(1);
    expect(recordSpy).toHaveBeenCalledWith(SESSION, result.data.product.id, now);
    expect(result.data.viewRecorded).toBe(true);
    expect(viewCount(SESSION)).toBe(2);
    expect(result.data.rails.recentlyViewed.map((p) => p.slug)).toEqual(["walnut-desk"]);
    expect(result.data.viewer.hasSession).toBe(true);
  });

  test("a duplicated render leaves one history row (idempotent upsert)", async () => {
    await load("canvas-tote-bag", SESSION);
    await load("canvas-tote-bag", SESSION);
    expect(viewCount(SESSION)).toBe(1);
  });

  test("without a cookie: no DB writes at all", async () => {
    const recordSpy = spyOn(deps.recommendations, "recordView");
    const before = changes();
    const result = await load("canvas-tote-bag", null);
    if (!result.found) throw new Error("expected found");
    expect(changes()).toBe(before);
    expect(recordSpy).not.toHaveBeenCalled();
    expect(result.data.viewRecorded).toBe(false);
    expect(result.data.viewer).toMatchObject({ hasSession: false, inWishlist: false, alertRegistered: false });
  });

  test("a malformed session id is treated as no cookie", async () => {
    const before = changes();
    const result = await load("canvas-tote-bag", "not-a-uuid");
    if (!result.found) throw new Error("expected found");
    expect(changes()).toBe(before);
    expect(result.data.viewer.hasSession).toBe(false);
  });

  test("viewer state: wishlist and restock alert are server truth, owner key never returned", async () => {
    const lists = createListService({ db });
    const added = lists.addItem(SESSION, null, "prod_canvas-tote-bag");
    if (!added.ok) throw new Error("seed wishlist failed");
    const tote = await load("canvas-tote-bag", SESSION);
    if (!tote.found) throw new Error("expected found");
    expect(tote.data.viewer.inWishlist).toBe(true);
    expect(tote.data.viewer.wishlistId).toBe(added.value.listId);
    expect(tote.data.viewer.lists.map((l) => l.id)).toContain(added.value.listId);
    expect(JSON.stringify(tote.data)).not.toContain(SESSION);

    const alerts = createStockAlertService({ db });
    const sub = alerts.subscribe(SESSION, "prod_ceramic-pour-over");
    if (!sub.ok) throw new Error("seed alert failed");
    const pour = await load("ceramic-pour-over", SESSION);
    if (!pour.found) throw new Error("expected found");
    expect(pour.data.viewer.alertRegistered).toBe(true);
    expect(pour.data.viewer.alertId).toBe(sub.value.alert.id);

    const other = await load("ceramic-pour-over", OTHER);
    if (!other.found) throw new Error("expected found");
    expect(other.data.viewer.alertRegistered).toBe(false);
    expect(other.data.viewer.inWishlist).toBe(false);
  });
});

describe("T169: one clock and rails without the current product", () => {
  test("the loader returns the clock it used (input `now`), so the page never reads it again", async () => {
    const result = await load("canvas-tote-bag");
    if (!result.found) throw new Error("expected found");
    expect(result.data.now).toBe(now);
  });

  test("without an input `now` the loader reads Date.now() exactly once and returns it", async () => {
    const clock = spyOn(Date, "now");
    try {
      const result = await loadPdp({ slug: "canvas-tote-bag", sessionId: null }, deps);
      if (!result.found) throw new Error("expected found");
      expect(clock).toHaveBeenCalledTimes(1);
      expect(result.data.now).toBe(clock.mock.results[0]?.value as number);
    } finally {
      clock.mockRestore();
    }
  });

  test("D-T169-1: with a session the loader still reads Date.now() once and passes that `now` to alerts.list", async () => {
    const alerts = createStockAlertService({ db });
    const sub = alerts.subscribe(SESSION, "prod_ceramic-pour-over");
    if (!sub.ok) throw new Error("seed alert failed");
    const list = spyOn(deps.alerts, "list");
    const clock = spyOn(Date, "now");
    try {
      const result = await loadPdp({ slug: "ceramic-pour-over", sessionId: SESSION }, deps);
      if (!result.found) throw new Error("expected found");
      expect(clock).toHaveBeenCalledTimes(1);
      expect(result.data.viewer.alertRegistered).toBe(true);
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]?.[1]).toBe(result.data.now);
    } finally {
      clock.mockRestore();
      list.mockRestore();
    }
  });

  test("a recommender that returns the current product never puts it in a rail (P-12)", async () => {
    const self = loadPublishedProduct("canvas-tote-bag", now, deps.products);
    const other = loadPublishedProduct("walnut-desk", now, deps.products);
    if (self === null || other === null) throw new Error("seed is missing products");
    const leaky = (): readonly Product[] => [self, other, self];
    deps = {
      ...deps,
      recommendations: { ...deps.recommendations, alsoBought: leaky, alsoViewed: leaky, related: leaky },
    };
    const result = await load("canvas-tote-bag");
    if (!result.found) throw new Error("expected found");
    const { alsoBought, alsoViewed, related } = result.data.rails;
    for (const rail of [alsoBought, alsoViewed, related]) expect(rail.map((p) => p.slug)).toEqual(["walnut-desk"]);
  });
});

describe("withoutProduct", () => {
  const p = (id: string) => ({ id }) as Product;
  test("drops every occurrence of the id and keeps order", () => {
    expect(withoutProduct([p("a"), p("b"), p("a"), p("c")], "a").map((x) => x.id)).toEqual(["b", "c"]);
  });
  test("returns the same array when the id is absent; empty stays empty", () => {
    const list = [p("a"), p("b")];
    expect(withoutProduct(list, "z")).toBe(list);
    expect(withoutProduct([], "a")).toEqual([]);
  });
});
