import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createRecommendationService } from "@/server/recommendations/recommendation-service";

import {
  EMPTY_HUB_COUNTS,
  loadAddresses,
  loadAlerts,
  loadContributions,
  loadHistory,
  loadHub,
  loadMessages,
} from "./loaders";
import { createAccountServices, type AccountServices } from "./services";
import { OWNER_A, OWNER_B, SPEC_A, SPEC_B, UNKNOWN_OWNER, seedOwner, type SeededOwner } from "./test-fixtures";

let db: Database;
let services: AccountServices;
let a: SeededOwner;
let b: SeededOwner;
const source = () => services;

beforeAll(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  services = createAccountServices(db);
  a = seedOwner(db, OWNER_A, SPEC_A);
  b = seedOwner(db, OWNER_B, SPEC_B);
});

function rowCounts(): Record<string, number> {
  const tables = ["addresses", "reviews", "questions", "stock_alerts", "contact_messages", "product_views", "lists", "carts", "rate_limits"];
  return Object.fromEntries(
    tables.map((t) => [t, db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${t}`).get()?.n ?? -1]),
  );
}

describe("account loaders: no owner key", () => {
  test.each([null, "", "not-a-uuid", OWNER_A.toUpperCase()])("owner %p: empty shapes, services never built", (owner) => {
    let built = 0;
    const counting = () => {
      built += 1;
      return services;
    };
    const opts = { services: counting };
    expect(loadHub(owner, opts)).toEqual({ counts: EMPTY_HUB_COUNTS, backInStock: [] });
    expect(loadHistory(owner, opts)).toEqual([]);
    expect(loadContributions(owner, opts)).toEqual({ reviews: [], questions: [] });
    expect(loadAlerts(owner, opts)).toEqual([]);
    expect(loadMessages(owner, opts)).toEqual([]);
    expect(loadAddresses(owner, opts)).toEqual([]);
    expect(built).toBe(0);
  });

  test("unknown owner: empty data, no writes", () => {
    const before = rowCounts();
    const opts = { services: source };
    expect(loadHub(UNKNOWN_OWNER, opts)).toEqual({ counts: EMPTY_HUB_COUNTS, backInStock: [] });
    expect(loadHistory(UNKNOWN_OWNER, opts)).toEqual([]);
    expect(loadAlerts(UNKNOWN_OWNER, opts)).toEqual([]);
    expect(rowCounts()).toEqual(before);
  });
});

describe("account loaders: two owners (criterion 2)", () => {
  test("hub counts and back-in-stock are per owner; reading writes nothing", () => {
    const before = rowCounts();
    const hubA = loadHub(OWNER_A, { services: source });
    expect(hubA.counts).toEqual({
      orders: 0,
      lists: 0,
      addresses: 1,
      history: 1,
      reviews: 1,
      questions: 1,
      alerts: 2,
      messages: 1,
    });
    expect(hubA.backInStock).toEqual([{ alertId: a.restockedAlertId, productSlug: "walnut-desk", productName: "Walnut Standing Desk" }]);
    const hubB = loadHub(OWNER_B, { services: source });
    expect(hubB.backInStock.map((x) => x.alertId)).toEqual([b.restockedAlertId]);
    expect(JSON.stringify(hubA)).not.toContain(OWNER_A);
    expect(rowCounts()).toEqual(before);
  });

  test("history: own views only, newest first, with viewedAt", () => {
    const history = loadHistory(OWNER_A, { services: source });
    expect(history.map((h) => h.product.id)).toEqual([SPEC_A.productId]);
    expect(typeof history[0]?.viewedAt).toBe("string");
    expect(loadHistory(OWNER_B, { services: source }).map((h) => h.product.id)).toEqual([SPEC_B.productId]);
  });

  test("history: capped at 50 and newest first", () => {
    const owner = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const ids = db
      .query<{ id: string }, [string]>("SELECT id FROM products WHERE stock > 0 AND published_at <= ? ORDER BY id")
      .all(new Date().toISOString())
      .map((r) => r.id);
    const recos = createRecommendationService({ db });
    const base = Date.now() - 1_000_000;
    ids.forEach((id, i) => {
      const r = recos.recordView(owner, id, base + i * 1000);
      if (!r.ok) throw new Error(r.error.code);
    });
    const history = loadHistory(owner, { services: source });
    expect(history.length).toBe(Math.min(50, ids.length));
    expect(history[0]?.product.id).toBe(ids.at(-1));
  });

  test("contributions: own reviews and questions with product names", () => {
    const c = loadContributions(OWNER_A, { services: source });
    expect(c.reviews.map((r) => r.review.id)).toEqual([a.reviewId]);
    expect(c.reviews[0]?.product).toEqual({ slug: "canvas-tote-bag", name: "Canvas Tote Bag" });
    expect(c.questions.map((q) => q.id)).toEqual([a.questionId]);
    expect(c.questions[0]?.published).toBe(true);
    // CONS-B4 (an): the full QuestionView from listMineWithAnswers (isOwn, answers nested).
    expect(c.questions[0]?.question.id).toBe(a.questionId);
    expect(c.questions[0]?.question.isOwn).toBe(true);
    expect(c.questions[0]?.question.answers).toEqual([]);
    expect(JSON.stringify(c)).not.toContain(b.reviewId);
  });

  test("alerts, messages, addresses: own rows only", () => {
    expect(loadAlerts(OWNER_A, { services: source }).map((x) => x.id).sort()).toEqual([a.waitingAlertId, a.restockedAlertId].sort());
    expect(loadMessages(OWNER_A, { services: source }).map((m) => m.reference)).toEqual([a.reference]);
    expect(loadMessages(OWNER_B, { services: source }).map((m) => m.reference)).toEqual([b.reference]);
    expect(loadAddresses(OWNER_A, { services: source }).map((x) => x.id)).toEqual([a.addressId]);
    expect(loadAddresses(OWNER_B, { services: source }).map((x) => x.id)).toEqual([b.addressId]);
  });
});

describe("account loaders: alert publication at the request `now` (D-T98-4)", () => {
  const publishedAt = (): number => {
    const row = db.query<{ published_at: string }, []>("SELECT published_at FROM products WHERE id = 'prod_walnut-desk'").get();
    return Date.parse(row?.published_at ?? "");
  };

  test("loadAlerts and loadHub judge publication at options.now (one clock for the page)", () => {
    const at = publishedAt();
    expect(Number.isFinite(at)).toBe(true);
    const before = at - 1;
    const alerts = loadAlerts(OWNER_A, { services: source, now: before });
    const desk = alerts.find((x) => x.id === a.restockedAlertId);
    expect(desk?.available).toBe(false);
    expect(desk?.product?.slug).toBe("");
    const hub = loadHub(OWNER_A, { services: source, now: before });
    expect(hub.backInStock).toEqual([
      { alertId: a.restockedAlertId, productSlug: "", productName: "Walnut Standing Desk", available: false },
    ]);
    // At the publication instant the product is live again.
    expect(loadAlerts(OWNER_A, { services: source, now: at }).find((x) => x.id === a.restockedAlertId)?.product?.slug).toBe("walnut-desk");
    expect(loadHub(OWNER_A, { services: source, now: at }).backInStock[0]?.productSlug).toBe("walnut-desk");
  });

  test("without options.now the service clock is used (published products stay linked)", () => {
    const desk = loadAlerts(OWNER_A, { services: source }).find((x) => x.id === a.restockedAlertId);
    expect(desk?.available).toBe(true);
    expect(desk?.product?.slug).toBe("walnut-desk");
  });
});

describe("account loaders: failure paths", () => {
  test("a throwing service degrades only its own section; failures are logged without data", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const boom = (): never => {
      throw new Error(`db down ${OWNER_A}`);
    };
    const broken: AccountServices = {
      ...services,
      addresses: { list: boom, countFor: boom },
      contact: { listForSession: boom },
    };
    const hub = loadHub(OWNER_A, { services: () => broken });
    expect(hub.counts.addresses).toBe(0);
    expect(hub.counts.messages).toBe(0);
    expect(hub.counts.reviews).toBe(1);
    expect(loadAddresses(OWNER_A, { services: () => broken })).toEqual([]);
    expect(loadMessages(OWNER_A, { services: () => broken })).toEqual([]);
    for (const call of errorSpy.mock.calls) expect(String(call[0])).not.toContain(OWNER_A);
    errorSpy.mockRestore();
  });

  test("services that cannot be built (DB open failure) -> empty", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    const failing = (): AccountServices => {
      throw new Error("cannot open");
    };
    expect(loadHub(OWNER_A, { services: failing })).toEqual({ counts: EMPTY_HUB_COUNTS, backInStock: [] });
    expect(loadAlerts(OWNER_A, { services: failing })).toEqual([]);
    errorSpy.mockRestore();
  });
});
