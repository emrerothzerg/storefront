import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// QA-W2-T50: adversarial tests for the stock alert server actions.
//
// Part 1 drives `createStockAlertActions` (stock-alerts-core) with a real
// StockAlertService + real T31 limiter over in-memory SQLite and recording
// fakes for the session helpers, so call ORDER can be asserted.
// Part 2 drives the `'use server'` wrappers with `next/headers` and
// `next/cache` mocked (mock.module is process-wide, so the mocks are
// registered before anything that reaches `next/headers` is imported).
// No test touches ./data: DATABASE_PATH=":memory:" or createDatabase(":memory:").
// ---------------------------------------------------------------------------

interface SetCall {
  readonly name: string;
  readonly value: string;
  readonly options: unknown;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string, options?: unknown): void {
    this.setCalls.push({ name, value, options });
    this.jar.set(name, value);
  }
}

let fakeStore = new FakeCookieStore();
const wiredRevalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/cache", () => ({ revalidatePath: wiredRevalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
type StockAlertActionState = import("@/components/molecules/_contracts/stock-alert-actions").StockAlertActionState;
const { STOCK_ALERT_FIELD } = await import("@/components/molecules/_contracts/stock-alert-actions");
const core = await import("@/app/actions/stock-alerts-core");
const { createStockAlertActions, STOCK_ALERT_MESSAGES } = core;
type StockAlertActionDeps = import("@/app/actions/stock-alerts-core").StockAlertActionDeps;
const { createStockAlertService } = await import("@/server/alerts/stock-alert-service");
type StockAlertService = import("@/server/alerts/stock-alert-service").StockAlertService;
const { createRateLimiter } = await import("@/server/security/rate-limiter");
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;
const { createDatabase, closeDatabase, getDatabase } = await import("@/server/db/client");
const { runMigrations } = await import("@/server/db/schema");
const { seedDatabase } = await import("@/server/db/seed");
const { fail } = await import("@/lib/result");
type ErrorCode = Parameters<typeof import("@/lib/result").appError>[0];
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");

const ROOT = join(import.meta.dir, "..", "..", "..");

const wired = await import("@/app/actions/stock-alerts");

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const HOUR_MS = 3_600_000;
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const POUR_OVER_SLUG = "ceramic-pour-over";
const TOTE = "prod_canvas-tote-bag"; // in stock

type Entry = readonly [string, string | Blob];

function fd(entries: readonly Entry[]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

/** FormData Proxy that records every property access and method call (with args). */
function spyFormData(entries: readonly Entry[]): { form: FormData; reads: string[] } {
  const target = fd(entries);
  const reads: string[] = [];
  const form = new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") {
        reads.push(`prop:${String(prop)}`);
        return value;
      }
      return (...args: unknown[]) => {
        reads.push(`${String(prop)}:${args.map(String).join(",")}`);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { form, reads };
}

async function browserMultipart(fields: readonly (readonly [string, string])[], boundary: string): Promise<FormData> {
  const body =
    fields
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") + `--${boundary}--\r\n`;
  const request = new Request("http://localhost:3000/products/ceramic-pour-over", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      origin: "http://localhost:3000",
    },
    body,
  });
  return request.formData();
}

function alertRows(db: Database): { id: string; product_id: string; session_id: string; acknowledged_at: string | null }[] {
  return db
    .query("SELECT id, product_id, session_id, acknowledged_at FROM stock_alerts ORDER BY created_at, id")
    .all() as { id: string; product_id: string; session_id: string; acknowledged_at: string | null }[];
}

function addOutOfStock(db: Database, n: number): string[] {
  const insert = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, 1000, 'USD', '/x.svg', 0)",
  );
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    insert.run(`qa-oos-${i}`, `qa-oos-${i}`, `QA fixture ${i}`);
    ids.push(`qa-oos-${i}`);
  }
  return ids;
}

function errorOf(state: StockAlertActionState): Extract<NonNullable<StockAlertActionState>, { ok: false }> {
  if (state === null || state.ok) throw new Error(`expected error state, got ${JSON.stringify(state)}`);
  expect(state.message).toBe(state.error.message);
  return state;
}

interface Harness {
  db: Database;
  service: StockAlertService;
  limiter: RateLimiter;
  calls: string[];
  session: { current: string | null; next: string };
  clock: { ms: number };
  revalidate: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  actions: ReturnType<typeof createStockAlertActions>;
}

/** Real service + limiter; every dep call is appended to `calls` in order. */
function setup(overrides: Partial<StockAlertActionDeps> = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const calls: string[] = [];
  const session: { current: string | null; next: string } = { current: null, next: S1 };
  const clock = { ms: T0 };
  const realService = createStockAlertService({ db });
  const service: StockAlertService = {
    ...realService,
    subscribe: (s, p, n) => {
      calls.push("service.subscribe");
      return realService.subscribe(s, p, n);
    },
    unsubscribe: (s, a) => {
      calls.push("service.unsubscribe");
      return realService.unsubscribe(s, a);
    },
    acknowledge: (s, a, n) => {
      calls.push("service.acknowledge");
      return realService.acknowledge(s, a, n);
    },
  };
  const realLimiter = createRateLimiter(db, { now: () => clock.ms });
  const limiter: RateLimiter = {
    check: (key, rule) => {
      calls.push(`limiter.check:${key}`);
      return realLimiter.check(key, rule);
    },
  };
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>((path) => {
    calls.push(`revalidate:${path}`);
  });
  const deps: StockAlertActionDeps = {
    service,
    limiter,
    getOrCreateSessionId: async () => {
      calls.push("getOrCreateSessionId");
      if (session.current === null) session.current = session.next;
      return session.current;
    },
    readSessionId: async () => {
      calls.push("readSessionId");
      return session.current;
    },
    revalidatePath: revalidate,
    now: () => clock.ms,
    ...overrides,
  };
  return { db, service, limiter, calls, session, clock, revalidate, actions: createStockAlertActions(deps) };
}

let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Part 1: core
// ---------------------------------------------------------------------------

describe("QA T50 subscribe: order of operations", () => {
  test("valid input: parse -> getOrCreateSessionId -> per-session limiter -> global limiter -> service -> revalidate", async () => {
    const h = setup();
    const state = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER], ["productSlug", POUR_OVER_SLUG]]));
    expect(state).toEqual({ ok: true, kind: "subscribed", message: STOCK_ALERT_MESSAGES.subscribed });
    expect(h.calls).toEqual([
      "getOrCreateSessionId",
      `limiter.check:stock_alert.subscribe:${S1}`,
      "limiter.check:stock_alert.subscribe:*",
      "service.subscribe",
      `revalidate:/products/${POUR_OVER_SLUG}`,
      "revalidate:/account/alerts",
      "revalidate:/account",
    ]);
    expect(alertRows(h.db)).toEqual([expect.objectContaining({ product_id: POUR_OVER, session_id: S1 })]);
  });

  const invalidInputs: readonly [string, readonly Entry[]][] = [
    ["missing productId", []],
    ["empty productId", [["productId", ""]]],
    ["whitespace productId", [["productId", "   \t\n "]]],
    ["201-char productId", [["productId", "a".repeat(201)]]],
    ["huge productId (1 MB)", [["productId", "a".repeat(1_000_000)]]],
    ["File as productId", [["productId", new File(["x"], "x.txt")]]],
    ["only email posted", [["email", "a@example.com"]]],
  ];
  for (const [name, entries] of invalidInputs) {
    test(`invalid input (${name}): INVALID_INPUT field productId, no session, no limiter, no service, no revalidate`, async () => {
      const h = setup();
      const state = await h.actions.subscribeStockAlert(null, fd(entries));
      const err = errorOf(state);
      expect(err.error).toEqual({ code: "INVALID_INPUT", message: STOCK_ALERT_MESSAGES.invalidRequest, details: { field: "productId" } });
      expect(h.calls).toEqual([]);
      expect(h.session.current).toBeNull();
      expect(alertRows(h.db)).toEqual([]);
    });
  }

  test("productId padded with whitespace is trimmed and accepted", async () => {
    const h = setup();
    const state = await h.actions.subscribeStockAlert(null, fd([["productId", `  ${POUR_OVER}\n`]]));
    expect(state).toMatchObject({ ok: true, kind: "subscribed" });
    expect(alertRows(h.db)[0]?.product_id).toBe(POUR_OVER);
  });
});

describe("QA T50 subscribe: field whitelist (criterion 4)", () => {
  test("recording FormData: only productId and productSlug are read; email/sessionId/status never touched", async () => {
    const h = setup();
    const { form, reads } = spyFormData([
      ["$ACTION_REF_1", ""],
      ["$ACTION_1:0", '{"id":"x","bound":"$@1"}'],
      ["productId", POUR_OVER],
      ["productSlug", POUR_OVER_SLUG],
      ["email", "victim@example.com"],
      ["sessionId", S2],
      ["status", "back_in_stock"],
      ["acknowledgedAt", "2020-01-01"],
    ]);
    const state = await h.actions.subscribeStockAlert(null, form);
    expect(state).toMatchObject({ ok: true, kind: "subscribed" });
    expect(reads.sort()).toEqual(["get:productId", "get:productSlug"]);
    const [row] = alertRows(h.db);
    expect(row?.session_id).toBe(S1);
    expect(row?.acknowledged_at).toBeNull();
    expect(JSON.stringify(state)).not.toContain("victim");
  });

  test("recording FormData for unsubscribe/acknowledge: only alertId and productSlug are read", async () => {
    const h = setup();
    h.session.current = S1;
    const sub = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    expect(sub?.ok).toBe(true);
    const id = alertRows(h.db)[0]?.id ?? "";
    for (const action of [h.actions.acknowledgeStockAlert, h.actions.unsubscribeStockAlert]) {
      const { form, reads } = spyFormData([
        ["alertId", id],
        ["productSlug", POUR_OVER_SLUG],
        ["email", "victim@example.com"],
        ["sessionId", S2],
        ["status", "waiting"],
        ["productId", "prod_other"],
      ]);
      const state = await action(null, form);
      expect(state?.ok).toBe(true);
      expect(reads.sort()).toEqual(["get:alertId", "get:productSlug"]);
    }
  });

  test("invalid input stops reading after productId (slug not read before validation passes)", async () => {
    const h = setup();
    const { form, reads } = spyFormData([["email", "x@example.com"], ["sessionId", S2]]);
    await h.actions.subscribeStockAlert(null, form);
    expect(reads).toEqual(["get:productId"]);
  });

  test("Field names in the contract are exactly productId, productSlug, alertId", () => {
    expect(Object.values(STOCK_ALERT_FIELD).sort()).toEqual(["alertId", "productId", "productSlug"]);
  });
});

describe("QA T50 subscribe: service outcomes (criteria 1, 2)", () => {
  test("in-stock product: INVALID_INPUT reason already_available, no row, no revalidate, productId not echoed", async () => {
    const h = setup();
    const state = await h.actions.subscribeStockAlert(null, fd([["productId", TOTE], ["productSlug", "canvas-tote-bag"]]));
    const err = errorOf(state);
    expect(err.error).toEqual({
      code: "INVALID_INPUT",
      message: STOCK_ALERT_MESSAGES.alreadyAvailable,
      details: { reason: "already_available" },
    });
    expect(JSON.stringify(state)).not.toContain(TOTE);
    expect(alertRows(h.db)).toEqual([]);
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("unknown product: PRODUCT_NOT_FOUND without details, hostile id never echoed", async () => {
    const h = setup();
    const hostile = `<img src=x onerror=alert(1)>${"z".repeat(50)}`;
    const state = await h.actions.subscribeStockAlert(null, fd([["productId", hostile], ["productSlug", "nope"]]));
    const err = errorOf(state);
    expect(err.error).toEqual({ code: "PRODUCT_NOT_FOUND", message: STOCK_ALERT_MESSAGES.productNotFound });
    expect(JSON.stringify(state)).not.toContain("onerror");
    expect(alertRows(h.db)).toEqual([]);
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("duplicate subscribe: ok already_registered, single row, revalidates again", async () => {
    const h = setup();
    const first = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    const second = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    expect(first).toEqual({ ok: true, kind: "subscribed", message: STOCK_ALERT_MESSAGES.subscribed });
    expect(second).toEqual({ ok: true, kind: "already_registered", message: STOCK_ALERT_MESSAGES.alreadyRegistered });
    expect(alertRows(h.db)).toHaveLength(1);
  });

  test("duplicate after restock is still already_registered (service ordering survives the action)", async () => {
    const h = setup();
    await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    h.db.run("UPDATE products SET stock = 5 WHERE id = ?", [POUR_OVER]);
    const again = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    expect(again).toMatchObject({ ok: true, kind: "already_registered" });
  });

  test("concurrent duplicate submits (10 in parallel): one row, all ok", async () => {
    const h = setup();
    h.session.current = S1;
    const states = await Promise.all(
      Array.from({ length: 10 }, () => h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]))),
    );
    expect(states.every((s) => s?.ok === true)).toBe(true);
    expect(states.filter((s) => s !== null && s.ok && s.kind === "subscribed")).toHaveLength(1);
    expect(alertRows(h.db)).toHaveLength(1);
  });

  test("21st alert: LIMIT_REACHED with details.limit 20 only, no 21st row", async () => {
    const h = setup();
    const ids = addOutOfStock(h.db, 21);
    for (let i = 0; i < 20; i++) {
      if (i > 0 && i % 10 === 0) h.clock.ms += HOUR_MS; // stay under 10/hour
      const s = await h.actions.subscribeStockAlert(null, fd([["productId", ids[i] ?? ""]]));
      expect(s).toMatchObject({ ok: true, kind: "subscribed" });
    }
    h.clock.ms += HOUR_MS;
    h.revalidate.mockClear();
    const state = await h.actions.subscribeStockAlert(null, fd([["productId", ids[20] ?? ""], ["productSlug", "qa-oos-20"]]));
    const err = errorOf(state);
    expect(err.error).toEqual({ code: "LIMIT_REACHED", message: STOCK_ALERT_MESSAGES.limitReached, details: { limit: 20 } });
    expect(JSON.stringify(state)).not.toContain("qa-oos-20");
    expect(alertRows(h.db)).toHaveLength(20);
    expect(h.revalidate).not.toHaveBeenCalled();
  });
});

describe("QA T50 subscribe: rate limits (criterion 3)", () => {
  test("11th subscribe in an hour: RATE_LIMITED with retryAfterSeconds, service not called, no revalidate", async () => {
    const h = setup();
    for (let i = 0; i < 10; i++) {
      const s = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
      expect(s?.ok).toBe(true);
    }
    h.calls.length = 0;
    const state = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER], ["productSlug", POUR_OVER_SLUG]]));
    const err = errorOf(state);
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(typeof err.retryAfterSeconds).toBe("number");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(Number.isInteger(err.retryAfterSeconds)).toBe(true);
    expect(err.error.details).toEqual({ retryAfterSeconds: err.retryAfterSeconds });
    expect(h.calls).not.toContain("service.subscribe");
    expect(h.calls.some((c) => c.startsWith("revalidate:"))).toBe(false);
    // Another session is unaffected; after the window the first session works again.
    h.session.current = S2;
    expect((await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]])))?.ok).toBe(true);
    h.session.current = S1;
    h.clock.ms += HOUR_MS;
    expect((await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]])))?.ok).toBe(true);
  });

  test("invalid submits do not consume the per-session budget (limiter only after parse)", async () => {
    const h = setup();
    h.session.current = S1;
    for (let i = 0; i < 30; i++) await h.actions.subscribeStockAlert(null, fd([["productId", ""]]));
    for (let i = 0; i < 10; i++) {
      expect((await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]])))?.ok).toBe(true);
    }
  });

  test("global 500/hour backstop trips across 50 sessions; 51st session is RATE_LIMITED and service not called", async () => {
    const h = setup();
    for (let s = 0; s < 50; s++) {
      h.session.current = `${s.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
      for (let i = 0; i < 10; i++) {
        const state = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
        expect(state?.ok).toBe(true);
      }
    }
    h.session.current = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    h.calls.length = 0;
    const state = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    const err = errorOf(state);
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.calls).toEqual([
      "getOrCreateSessionId",
      "limiter.check:stock_alert.subscribe:ffffffff-ffff-4fff-8fff-ffffffffffff",
      "limiter.check:stock_alert.subscribe:*",
    ]);
    expect(alertRows(h.db)).toHaveLength(50);
  });

  test("RATE_LIMITED from a limiter with bad retryAfterSeconds yields no retryAfterSeconds and the fallback message", async () => {
    const h = setup({
      limiter: { check: () => fail("RATE_LIMITED", "x", { retryAfterSeconds: Number.NaN, key: S1 }) },
    });
    const state = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    const err = errorOf(state);
    expect(err).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: STOCK_ALERT_MESSAGES.rateLimitedFallback },
      message: STOCK_ALERT_MESSAGES.rateLimitedFallback,
    });
  });
});

describe("QA T50 details whitelist", () => {
  test("service errors carrying productId/sessionId/arbitrary details are rebuilt from the whitelist", async () => {
    const leaky = (code: ErrorCode, details: Record<string, unknown>) => {
      const h = setup({
        service: {
          ...createStockAlertService({ db: createDatabase(":memory:") }),
          subscribe: () => fail(code, `leak ${POUR_OVER} ${S1}`, details as never),
        },
      });
      return h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    };
    const cases: [ErrorCode, Record<string, unknown>][] = [
      ["PRODUCT_NOT_FOUND", { productId: POUR_OVER }],
      ["INVALID_INPUT", { reason: "already_available", productId: POUR_OVER }],
      ["INVALID_INPUT", { field: "productId<script>", productId: POUR_OVER }],
      ["INVALID_INPUT", { field: "sessionId", value: S1 }],
      ["LIMIT_REACHED", { limit: 999, productId: POUR_OVER }],
      ["NOT_FOUND", { productId: POUR_OVER }],
      ["DUPLICATE", { productId: POUR_OVER }],
      ["VALIDATION_FAILED", { productId: POUR_OVER }],
    ];
    for (const [code, details] of cases) {
      const state = await leaky(code, details);
      const json = JSON.stringify(state);
      expect(json).not.toContain(POUR_OVER);
      expect(json).not.toContain(S1);
      expect(json).not.toContain("<script>");
      expect(json).not.toContain("leak");
      const err = errorOf(state);
      expect(err.error.code).toBe(code);
      for (const key of Object.keys(err.error.details ?? {})) {
        expect(["field", "reason", "limit", "retryAfterSeconds"]).toContain(key);
      }
    }
  });
});

describe("QA T50 revalidatePath", () => {
  const badSlugs = ["", "A", "Ceramic", "../admin", "a/b", "a b", "slug\n", "\nslug", "s".repeat(101), "é", "slug?x=1", "%2e%2e"];
  for (const slug of badSlugs) {
    test(`invalid slug ${JSON.stringify(slug.slice(0, 20))}: only /account/alerts revalidated`, async () => {
      const h = setup();
      await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER], ["productSlug", slug]]));
      expect(h.revalidate.mock.calls).toEqual([["/account/alerts"], ["/account"]]);
    });
  }

  test("100-char slug is valid and revalidated", async () => {
    const h = setup();
    const slug = "a".repeat(100);
    await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER], ["productSlug", slug]]));
    expect(h.revalidate.mock.calls).toEqual([[`/products/${slug}`], ["/account/alerts"], ["/account"]]);
  });

  test("File as productSlug: ignored, only /account/alerts", async () => {
    const h = setup();
    await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER], ["productSlug", new File(["a"], "a")]]));
    expect(h.revalidate.mock.calls).toEqual([["/account/alerts"], ["/account"]]);
  });

  test("no revalidation on any failure path (unsubscribe/acknowledge foreign + no cookie)", async () => {
    const h = setup();
    await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    const id = alertRows(h.db)[0]?.id ?? "";
    h.revalidate.mockClear();
    h.session.current = S2;
    await h.actions.unsubscribeStockAlert(null, fd([["alertId", id], ["productSlug", POUR_OVER_SLUG]]));
    await h.actions.acknowledgeStockAlert(null, fd([["alertId", id], ["productSlug", POUR_OVER_SLUG]]));
    h.session.current = null;
    await h.actions.unsubscribeStockAlert(null, fd([["alertId", id], ["productSlug", POUR_OVER_SLUG]]));
    await h.actions.unsubscribeStockAlert(null, fd([["productSlug", POUR_OVER_SLUG]]));
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("successful unsubscribe/acknowledge revalidate slug + /account/alerts", async () => {
    const h = setup();
    await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    const id = alertRows(h.db)[0]?.id ?? "";
    h.revalidate.mockClear();
    await h.actions.acknowledgeStockAlert(null, fd([["alertId", id], ["productSlug", POUR_OVER_SLUG]]));
    await h.actions.unsubscribeStockAlert(null, fd([["alertId", id]]));
    expect(h.revalidate.mock.calls).toEqual([[`/products/${POUR_OVER_SLUG}`], ["/account/alerts"], ["/account"], ["/account/alerts"], ["/account"]]);
  });
});

describe("QA T50 unsubscribe / acknowledge", () => {
  test("no cookie: NOT_FOUND, readSessionId only, no getOrCreate, no service call", async () => {
    for (const name of ["unsubscribeStockAlert", "acknowledgeStockAlert"] as const) {
      const h = setup();
      const state = await h.actions[name](null, fd([["alertId", "00000000-0000-4000-8000-000000000001"]]));
      expect(errorOf(state).error).toEqual({ code: "NOT_FOUND", message: STOCK_ALERT_MESSAGES.alertNotFound });
      expect(h.calls).toEqual(["readSessionId"]);
      expect(h.session.current).toBeNull();
    }
  });

  test("never calls the limiter or getOrCreateSessionId even on success", async () => {
    const h = setup();
    await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    const id = alertRows(h.db)[0]?.id ?? "";
    h.calls.length = 0;
    await h.actions.acknowledgeStockAlert(null, fd([["alertId", id]]));
    await h.actions.unsubscribeStockAlert(null, fd([["alertId", id]]));
    expect(h.calls.filter((c) => !c.startsWith("revalidate:"))).toEqual([
      "readSessionId",
      "service.acknowledge",
      "readSessionId",
      "service.unsubscribe",
    ]);
  });

  test("foreign alert id: NOT_FOUND identical to an unknown id; row and acknowledged_at untouched", async () => {
    const h = setup();
    await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    const id = alertRows(h.db)[0]?.id ?? "";
    h.session.current = S2;
    const foreignAck = await h.actions.acknowledgeStockAlert(null, fd([["alertId", id]]));
    const foreignUnsub = await h.actions.unsubscribeStockAlert(null, fd([["alertId", id]]));
    const unknown = await h.actions.unsubscribeStockAlert(null, fd([["alertId", "33333333-3333-4333-8333-333333333333"]]));
    expect(foreignAck).toEqual(unknown);
    expect(foreignUnsub).toEqual(unknown);
    expect(JSON.stringify(foreignAck)).not.toContain(id);
    expect(alertRows(h.db)).toEqual([expect.objectContaining({ id, session_id: S1, acknowledged_at: null })]);
  });

  test("invalid alertId (missing, empty, File, 201 chars): INVALID_INPUT field alertId, session not read", async () => {
    for (const entries of [[], [["alertId", ""]], [["alertId", new File(["a"], "a")]], [["alertId", "x".repeat(201)]]] as Entry[][]) {
      const h = setup();
      h.session.current = S1;
      const state = await h.actions.unsubscribeStockAlert(null, fd(entries));
      expect(errorOf(state).error).toEqual({ code: "INVALID_INPUT", message: STOCK_ALERT_MESSAGES.invalidRequest, details: { field: "alertId" } });
      expect(h.calls).toEqual([]);
    }
  });
});

describe("QA T50 always settles + PII-free logging", () => {
  const SECRET = "victim@example.com";
  const throwing = (what: string): (() => never) => () => {
    throw new Error(`${what} failed for ${S1} ${POUR_OVER} ${SECRET}`);
  };

  function assertLogClean(): void {
    expect(errorSpy).toHaveBeenCalled();
    for (const call of errorSpy.mock.calls) {
      expect(call).toHaveLength(1);
      const line = String(call[0]);
      expect(line).toMatch(/^\[stock-alerts\] STOCK_ALERT_ACTION_FAILED action=(subscribe|unsubscribe|acknowledge|init)$/);
    }
  }

  const unexpected = {
    ok: false,
    error: { code: "VALIDATION_FAILED", message: STOCK_ALERT_MESSAGES.unexpected, details: { reason: "unexpected" } },
    message: STOCK_ALERT_MESSAGES.unexpected,
  };

  test("getOrCreateSessionId rejects", async () => {
    const h = setup({ getOrCreateSessionId: async () => throwing("session")() });
    expect(await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]))).toEqual(unexpected as never);
    assertLogClean();
  });

  test("readSessionId rejects (unsubscribe + acknowledge)", async () => {
    const h = setup({ readSessionId: async () => throwing("read")() });
    expect(await h.actions.unsubscribeStockAlert(null, fd([["alertId", "a"]]))).toEqual(unexpected as never);
    expect(await h.actions.acknowledgeStockAlert(null, fd([["alertId", "a"]]))).toEqual(unexpected as never);
    assertLogClean();
  });

  test("limiter throws: settles, service not called", async () => {
    const h = setup();
    const h2 = setup({ limiter: { check: throwing("limiter") }, service: h.service });
    h.calls.length = 0;
    expect(await h2.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]))).toEqual(unexpected as never);
    expect(h.calls).not.toContain("service.subscribe");
    assertLogClean();
  });

  test("service throws on every method", async () => {
    const base = createStockAlertService({ db: createDatabase(":memory:") });
    const h = setup({
      service: { ...base, subscribe: throwing("sub"), unsubscribe: throwing("unsub"), acknowledge: throwing("ack") },
      readSessionId: async () => S1,
    });
    expect(await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]))).toEqual(unexpected as never);
    expect(await h.actions.unsubscribeStockAlert(null, fd([["alertId", "a"]]))).toEqual(unexpected as never);
    expect(await h.actions.acknowledgeStockAlert(null, fd([["alertId", "a"]]))).toEqual(unexpected as never);
    assertLogClean();
  });

  test("non-Error throw values (string with PII, undefined, object) still settle with a clean log", async () => {
    for (const value of [SECRET, undefined, { email: SECRET }, null]) {
      const h = setup({
        getOrCreateSessionId: async () => {
          throw value;
        },
      });
      expect(await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]))).toEqual(unexpected as never);
    }
    assertLogClean();
  });

  test("revalidatePath throws after a successful write: action still settles", async () => {
    const h = setup({ revalidatePath: throwing("revalidate") });
    const state = await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    expect(state).not.toBeNull();
    expect(typeof state).toBe("object");
    assertLogClean();
  });

  test("now() throwing (bad clock) settles", async () => {
    const h = setup({ now: throwing("clock") });
    expect(await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]]))).toEqual(unexpected as never);
    assertLogClean();
  });
});

describe("QA T50 JSON round trip", () => {
  test("every reachable state survives JSON round trip unchanged", async () => {
    const h = setup();
    const ids = addOutOfStock(h.db, 21);
    const states: StockAlertActionState[] = [];
    states.push(await h.actions.subscribeStockAlert(null, fd([])));
    states.push(await h.actions.subscribeStockAlert(null, fd([["productId", "nope"]])));
    states.push(await h.actions.subscribeStockAlert(null, fd([["productId", TOTE]])));
    states.push(await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]])));
    states.push(await h.actions.subscribeStockAlert(null, fd([["productId", POUR_OVER]])));
    // 4 limiter hits so far; 7 more fill the hour, the 8th is RATE_LIMITED.
    for (let i = 0; i < 7; i++) states.push(await h.actions.subscribeStockAlert(null, fd([["productId", ids[i] ?? ""]])));
    states.push(await h.actions.subscribeStockAlert(null, fd([["productId", ids[7] ?? ""]])));
    // 8 alerts held; two more hours of budget reach 20, then LIMIT_REACHED.
    for (let i = 7; i < 20; i++) {
      if ((i - 7) % 10 === 0) h.clock.ms += HOUR_MS;
      states.push(await h.actions.subscribeStockAlert(null, fd([["productId", ids[i] ?? ""]])));
    }
    states.push(await h.actions.subscribeStockAlert(null, fd([["productId", ids[20] ?? ""]])));
    expect(alertRows(h.db)).toHaveLength(20);
    const id = alertRows(h.db)[0]?.id ?? "";
    states.push(await h.actions.acknowledgeStockAlert(null, fd([["alertId", id]])));
    states.push(await h.actions.unsubscribeStockAlert(null, fd([["alertId", id]])));
    states.push(await h.actions.unsubscribeStockAlert(null, fd([["alertId", id]])));
    const codes = new Set<string>(states.map((s): string => (s === null ? "null" : s.ok ? s.kind : s.error.code)));
    for (const c of ["INVALID_INPUT", "PRODUCT_NOT_FOUND", "subscribed", "already_registered", "RATE_LIMITED", "LIMIT_REACHED", "acknowledged", "unsubscribed", "NOT_FOUND"]) {
      expect([...codes]).toContain(c);
    }
    for (const s of states) expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("QA T50 browser multipart bodies (SR2)", () => {
  test("no-JS multipart without $ACTION_* fields parses and subscribes", async () => {
    const h = setup();
    const form = await browserMultipart(
      [["productId", POUR_OVER], ["productSlug", POUR_OVER_SLUG]],
      "----WebKitFormBoundaryQaT50noAction",
    );
    expect(await h.actions.subscribeStockAlert(null, form)).toMatchObject({ ok: true, kind: "subscribed" });
    expect(h.revalidate.mock.calls).toEqual([[`/products/${POUR_OVER_SLUG}`], ["/account/alerts"], ["/account"]]);
  });

  test("multipart with React $ACTION_REF/$ACTION_1:0/$ACTION_1:1/$ACTION_KEY and forged fields", async () => {
    const h = setup();
    const form = await browserMultipart(
      [
        ["$ACTION_REF_1", ""],
        ["$ACTION_1:0", '{"id":"7f00abc","bound":"$@1"}'],
        ["$ACTION_1:1", '[null]'],
        ["$ACTION_KEY", "k1234567890"],
        ["productId", POUR_OVER],
        ["productSlug", POUR_OVER_SLUG],
        ["email", "victim@example.com"],
        ["sessionId", S2],
        ["status", "back_in_stock"],
      ],
      "----geckoformboundaryQaT50",
    );
    const state = await h.actions.subscribeStockAlert(null, form);
    expect(state).toMatchObject({ ok: true, kind: "subscribed" });
    expect(alertRows(h.db)[0]?.session_id).toBe(S1);
    const id = alertRows(h.db)[0]?.id ?? "";
    const ack = await browserMultipart(
      [["$ACTION_REF_1", ""], ["$ACTION_1:0", '{"id":"x","bound":"$@1"}'], ["$ACTION_KEY", "k"], ["alertId", id], ["status", "waiting"]],
      "----WebKitFormBoundaryAck",
    );
    expect(await h.actions.acknowledgeStockAlert(null, ack)).toMatchObject({ ok: true, kind: "acknowledged" });
    const unsub = await browserMultipart([["alertId", id]], "----WebKitFormBoundaryUnsub");
    expect(await h.actions.unsubscribeStockAlert(null, unsub)).toMatchObject({ ok: true, kind: "unsubscribed" });
  });
});

// ---------------------------------------------------------------------------
// Part 2: 'use server' wrappers (wired)
// ---------------------------------------------------------------------------

function wiredRows(): { id: string; session_id: string; product_id: string }[] {
  return getDatabase().query("SELECT id, session_id, product_id FROM stock_alerts").all() as {
    id: string;
    session_id: string;
    product_id: string;
  }[];
}

describe("QA T50 'use server' module", () => {
  test("source starts with 'use server' and exports exactly three async functions", () => {
    const src = readFileSync(join(ROOT, "src/app/actions/stock-alerts.ts"), "utf8");
    expect(src.trimStart().startsWith('"use server";') || src.trimStart().startsWith("'use server';")).toBe(true);
    const exportLines = src.split("\n").filter((l) => /^export\b/.test(l));
    expect(exportLines).toHaveLength(3);
    for (const l of exportLines) expect(l).toMatch(/^export async function (subscribe|unsubscribe|acknowledge)StockAlert\(/);
    expect(Object.keys(wired).sort()).toEqual(["acknowledgeStockAlert", "subscribeStockAlert", "unsubscribeStockAlert"]);
    for (const v of Object.values(wired)) expect((v as () => unknown).constructor.name).toBe("AsyncFunction");
  });

  test("importing the module in a fresh process opens no database", async () => {
    const probeDb = join(import.meta.dir, `.qa-t50-probe-${process.pid}.sqlite`);
    const script = [
      `const before = globalThis.__storefrontDb;`,
      `await import(${JSON.stringify(join(ROOT, "src/app/actions/stock-alerts.ts"))});`,
      `const after = globalThis.__storefrontDb;`,
      `console.log(JSON.stringify({ before: before === undefined, after: after === undefined }));`,
    ].join("\n");
    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: probeDb },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString().trim().split("\n").pop() ?? "";
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(out)).toEqual({ before: true, after: true });
    expect(await Bun.file(probeDb).exists()).toBe(false);
  });
});

describe("QA T50 wired actions", () => {
  beforeEach(() => {
    env.DATABASE_PATH = ":memory:";
    closeDatabase();
    seedDatabase(getDatabase());
    fakeStore = new FakeCookieStore();
    wiredRevalidatePath.mockClear();
  });

  test("invalid input sets no cookie and opens nothing beyond parse", async () => {
    const state = await wired.subscribeStockAlert(null, fd([["productId", ""], ["email", "a@example.com"]]));
    expect(errorOf(state).error.code).toBe("INVALID_INPUT");
    expect(fakeStore.setCalls).toEqual([]);
    expect(wiredRevalidatePath).not.toHaveBeenCalled();
  });

  test("first valid subscribe sets exactly one sf_session cookie, the row uses it, revalidates slug + account", async () => {
    const state = await wired.subscribeStockAlert(null, fd([["productId", POUR_OVER], ["productSlug", POUR_OVER_SLUG], ["sessionId", S2]]));
    expect(state).toMatchObject({ ok: true, kind: "subscribed" });
    expect(fakeStore.setCalls).toHaveLength(1);
    expect(fakeStore.setCalls[0]?.name).toBe(SESSION_COOKIE_NAME);
    expect(wiredRows()).toEqual([expect.objectContaining({ session_id: fakeStore.setCalls[0]?.value, product_id: POUR_OVER })]);
    expect(wiredRevalidatePath.mock.calls).toEqual([[`/products/${POUR_OVER_SLUG}`], ["/account/alerts"], ["/account"]]);
  });

  test("in-stock / unknown product via wrapper: typed error, cookie may be minted but no row", async () => {
    const a = await wired.subscribeStockAlert(null, fd([["productId", TOTE]]));
    const b = await wired.subscribeStockAlert(null, fd([["productId", "prod_does-not-exist"]]));
    expect(errorOf(a).error.details).toEqual({ reason: "already_available" });
    expect(errorOf(b).error.code).toBe("PRODUCT_NOT_FOUND");
    expect(wiredRows()).toEqual([]);
    expect(fakeStore.setCalls.length).toBeLessThanOrEqual(1);
  });

  test("unsubscribe/acknowledge without any cookie: NOT_FOUND, no cookie set", async () => {
    for (const action of [wired.unsubscribeStockAlert, wired.acknowledgeStockAlert]) {
      const state = await action(null, fd([["alertId", "00000000-0000-4000-8000-000000000001"]]));
      expect(errorOf(state).error.code).toBe("NOT_FOUND");
    }
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("garbage sf_session on unsubscribe: NOT_FOUND, cookie not rewritten", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, "not-a-uuid");
    const state = await wired.unsubscribeStockAlert(null, fd([["alertId", "x"]]));
    expect(errorOf(state).error.code).toBe("NOT_FOUND");
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("11th wired subscribe in an hour is RATE_LIMITED with retryAfterSeconds", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
    for (let i = 0; i < 10; i++) expect((await wired.subscribeStockAlert(null, fd([["productId", POUR_OVER]])))?.ok).toBe(true);
    const state = await wired.subscribeStockAlert(null, fd([["productId", POUR_OVER]]));
    const err = errorOf(state);
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("multipart replay through the wrapper (browser body with $ACTION_* fields)", async () => {
    const form = await browserMultipart(
      [["$ACTION_REF_1", ""], ["$ACTION_1:0", '{"id":"abc","bound":"$@1"}'], ["$ACTION_KEY", "k"], ["productId", POUR_OVER], ["email", "x@example.com"]],
      "----WebKitFormBoundaryWired",
    );
    expect(await wired.subscribeStockAlert(null, form)).toMatchObject({ ok: true, kind: "subscribed" });
  });

  test("database cannot open: every wrapper settles with the generic state and logs a clean line", async () => {
    closeDatabase();
    env.DATABASE_PATH = "/dev/null/qa-t50/cannot.sqlite";
    try {
      fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
      for (const action of [wired.subscribeStockAlert, wired.unsubscribeStockAlert, wired.acknowledgeStockAlert]) {
        const state = await action(null, fd([["productId", POUR_OVER], ["alertId", "a"]]));
        expect(errorOf(state).error).toEqual({
          code: "VALIDATION_FAILED",
          message: STOCK_ALERT_MESSAGES.unexpected,
          details: { reason: "unexpected" },
        });
      }
      for (const call of errorSpy.mock.calls) {
        expect(String(call[0])).toMatch(/^\[stock-alerts\] STOCK_ALERT_ACTION_FAILED action=\w+$/);
      }
    } finally {
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});
