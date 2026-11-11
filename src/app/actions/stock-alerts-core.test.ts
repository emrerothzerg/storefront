import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { StockAlertActionState } from "@/components/molecules/_contracts/stock-alert-actions";
import { STOCK_ALERT_FIELD } from "@/components/molecules/_contracts/stock-alert-actions";
import { createStockAlertService, type StockAlertService } from "@/server/alerts/stock-alert-service";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createRateLimiter, type RateLimiter, type RateLimitRule } from "@/server/security/rate-limiter";
import {
  ACCOUNT_ALERTS_PATH,
  ACCOUNT_HUB_PATH,
  STOCK_ALERT_ACTION_FAILED,
  STOCK_ALERT_MESSAGES,
  createStockAlertActions,
  parseIdField,
  parseProductSlug,
  rateLimitedMessage,
  toErrorState,
  type StockAlertActionDeps,
} from "./stock-alerts-core";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");

interface Harness {
  readonly db: Database;
  readonly service: StockAlertService;
  readonly limiter: RateLimiter;
  readonly deps: StockAlertActionDeps;
  readonly actions: ReturnType<typeof createStockAlertActions>;
  readonly getOrCreate: ReturnType<typeof mock<() => Promise<string>>>;
  readonly read: ReturnType<typeof mock<() => Promise<string | null>>>;
  readonly revalidatePath: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  /** Cookie jar of the fake session: null = no cookie yet. */
  session: { current: string | null; next: string };
  clock: { ms: number };
  pourOver: { id: string; slug: string };
  tote: { id: string; slug: string };
}

function setup(overrides: Partial<StockAlertActionDeps> = {}): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const products = new SqliteProductRepository(db);
  const pourOver = products.getBySlug("ceramic-pour-over");
  const tote = products.getBySlug("canvas-tote-bag");
  if (pourOver === null || tote === null) throw new Error("seed changed");
  expect(pourOver.stock).toBe(0);
  expect(tote.stock).toBeGreaterThan(0);

  const session: { current: string | null; next: string } = { current: null, next: S1 };
  const clock = { ms: T0 };
  const getOrCreate = mock(async (): Promise<string> => {
    if (session.current === null) session.current = session.next;
    return session.current;
  });
  const read = mock(async (): Promise<string | null> => session.current);
  const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const service = createStockAlertService({ db });
  const limiter = createRateLimiter(db, { now: () => clock.ms });
  const deps: StockAlertActionDeps = {
    service,
    limiter,
    getOrCreateSessionId: getOrCreate,
    readSessionId: read,
    revalidatePath,
    now: () => clock.ms,
    ...overrides,
  };
  return {
    db,
    service,
    limiter,
    deps,
    actions: createStockAlertActions(deps),
    getOrCreate,
    read,
    revalidatePath,
    session,
    clock,
    pourOver: { id: pourOver.id, slug: pourOver.slug },
    tote: { id: tote.id, slug: tote.slug },
  };
}

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
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
    insert.run(`oos-${i}`, `oos-${i}-slug`, `Fixture ${i}`);
    ids.push(`oos-${i}`);
  }
  return ids;
}

function expectError(state: StockAlertActionState, code: string): Extract<StockAlertActionState, { ok: false }> {
  expect(state).not.toBeNull();
  if (state === null || state.ok) throw new Error(`expected error ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code as typeof state.error.code);
  expect(state.message).toBe(state.error.message);
  return state;
}

/** Builds FormData the way a browser serialises a multipart form post. */
async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW";
  const body =
    fields
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") + `--${boundary}--\r\n`;
  const request = new Request("http://localhost/products/ceramic-pour-over", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return request.formData();
}

let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
beforeEach(() => {
  errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe("parsing helpers", () => {
  test("parseIdField trims, rejects missing, File, empty and overlong values", () => {
    expect(parseIdField(form({ productId: "  abc  " }), "productId")).toEqual({ ok: true, value: "abc" });
    for (const fd of [
      form({}),
      form({ productId: new Blob(["x"]) }),
      form({ productId: "   " }),
      form({ productId: "x".repeat(201) }),
      form({ productId: "x".repeat(10_000) }),
    ]) {
      expect(parseIdField(fd, "productId")).toEqual({
        ok: false,
        error: { code: "INVALID_INPUT", message: STOCK_ALERT_MESSAGES.invalidRequest, details: { field: "productId" } },
      });
    }
    expect(parseIdField(form({ productId: "x".repeat(200) }), "productId").ok).toBe(true);
  });

  test("parseProductSlug accepts only ^[a-z0-9-]{1,100}$", () => {
    expect(parseProductSlug(form({ productSlug: "ceramic-pour-over" }))).toBe("ceramic-pour-over");
    for (const bad of ["", "Ceramic", "../admin", "a/b", "a b", "a".repeat(101), "café", "x\n"]) {
      expect(parseProductSlug(form({ productSlug: bad }))).toBeNull();
    }
    expect(parseProductSlug(form({}))).toBeNull();
    expect(parseProductSlug(form({ productSlug: new Blob(["abc"]) }))).toBeNull();
  });

  test("rateLimitedMessage rounds up to whole minutes", () => {
    expect(rateLimitedMessage(undefined)).toBe(STOCK_ALERT_MESSAGES.rateLimitedFallback);
    expect(rateLimitedMessage(1)).toBe("Too many requests. Please try again in 1 minute.");
    expect(rateLimitedMessage(61)).toBe("Too many requests. Please try again in 2 minutes.");
    expect(rateLimitedMessage(3600)).toBe("Too many requests. Please try again in 60 minutes.");
  });

  test("toErrorState whitelists details and drops raw input", () => {
    const state = toErrorState({ code: "PRODUCT_NOT_FOUND", message: "Unknown <b>x</b>", details: { productId: "<b>x</b>" } });
    expect(state).toEqual({
      ok: false,
      error: { code: "PRODUCT_NOT_FOUND", message: STOCK_ALERT_MESSAGES.productNotFound },
      message: STOCK_ALERT_MESSAGES.productNotFound,
    });
    expect(toErrorState({ code: "INVALID_INPUT", message: "internal", details: { field: "sql" } })).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: STOCK_ALERT_MESSAGES.invalidRequest },
      message: STOCK_ALERT_MESSAGES.invalidRequest,
    });
    expect(toErrorState({ code: "RATE_LIMITED", message: "x", details: { retryAfterSeconds: Number.NaN } })).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: STOCK_ALERT_MESSAGES.rateLimitedFallback },
      message: STOCK_ALERT_MESSAGES.rateLimitedFallback,
    });
    expect(toErrorState({ code: "MONEY_OVERFLOW", message: "stack trace here" })).toEqual({
      ok: false,
      error: { code: "MONEY_OVERFLOW", message: STOCK_ALERT_MESSAGES.invalidRequest },
      message: STOCK_ALERT_MESSAGES.invalidRequest,
    });
  });
});

describe("subscribeStockAlert", () => {
  test("out-of-stock product: subscribed, row under the server session, both paths revalidated", async () => {
    const h = setup();
    const state = await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id, productSlug: h.pourOver.slug }));
    expect(state).toEqual({ ok: true, kind: "subscribed", message: STOCK_ALERT_MESSAGES.subscribed });
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.read).not.toHaveBeenCalled();
    const rows = alertRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product_id: h.pourOver.id, session_id: S1, acknowledged_at: null });
    expect(h.revalidatePath.mock.calls).toEqual([[`/products/${h.pourOver.slug}`], [ACCOUNT_ALERTS_PATH], [ACCOUNT_HUB_PATH]]);
  });

  test("criterion 5: session is created lazily on first subscribe, and only after input parses", async () => {
    const h = setup();
    expect(h.session.current).toBeNull();
    const bad = await h.actions.subscribeStockAlert(null, form({ productSlug: h.pourOver.slug }));
    expectError(bad, "INVALID_INPUT");
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.session.current).toBeNull();
    expect(h.revalidatePath).not.toHaveBeenCalled();

    await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.session.current).toBe(S1);
  });

  test("criterion 2: duplicate subscribe is idempotent and reports already registered", async () => {
    const h = setup();
    await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
    const again = await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
    expect(again).toEqual({ ok: true, kind: "already_registered", message: STOCK_ALERT_MESSAGES.alreadyRegistered });
    expect(alertRows(h.db)).toHaveLength(1);
    expect(h.revalidatePath.mock.calls).toEqual([[ACCOUNT_ALERTS_PATH], [ACCOUNT_HUB_PATH], [ACCOUNT_ALERTS_PATH], [ACCOUNT_HUB_PATH]]);
  });

  test("criterion 1: in-stock product returns typed error and writes no row", async () => {
    const h = setup();
    const state = await h.actions.subscribeStockAlert(null, form({ productId: h.tote.id, productSlug: h.tote.slug }));
    expect(state).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: STOCK_ALERT_MESSAGES.alreadyAvailable, details: { reason: "already_available" } },
      message: STOCK_ALERT_MESSAGES.alreadyAvailable,
    });
    expect(alertRows(h.db)).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("criterion 1: unknown product returns PRODUCT_NOT_FOUND, no row, input never echoed", async () => {
    const h = setup();
    const raw = '<img src=x onerror="alert(1)">';
    const state = await h.actions.subscribeStockAlert(null, form({ productId: raw }));
    const e = expectError(state, "PRODUCT_NOT_FOUND");
    expect(e.message).toBe(STOCK_ALERT_MESSAGES.productNotFound);
    expect(e.error.details).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("onerror");
    expect(alertRows(h.db)).toEqual([]);
  });

  test("LIMIT_REACHED at 20 alerts maps to a user-safe message with details.limit", async () => {
    const h = setup();
    const ids = addOutOfStock(h.db, 21);
    // Pre-fill 20 alerts through the service (the action limiter allows 10/hour).
    for (const id of ids.slice(0, 20)) expect(h.service.subscribe(S1, id).ok).toBe(true);
    h.session.current = S1;
    const state = await h.actions.subscribeStockAlert(null, form({ productId: ids[20] ?? "" }));
    const e = expectError(state, "LIMIT_REACHED");
    expect(e.error.details).toEqual({ limit: 20 });
    expect(e.message).toBe(STOCK_ALERT_MESSAGES.limitReached);
    expect(alertRows(h.db)).toHaveLength(20);
  });

  test("criterion 4: email/sessionId/status fields are never read, forged values ignored", async () => {
    const h = setup();
    h.session.next = S2;
    const read: string[] = [];
    class RecordingFormData extends FormData {
      override get(name: string): FormDataEntryValue | null {
        read.push(name);
        return super.get(name);
      }
      override getAll(name: string): FormDataEntryValue[] {
        read.push(`getAll:${name}`);
        return super.getAll(name);
      }
    }
    const fd = new RecordingFormData();
    fd.append("productId", h.pourOver.id);
    fd.append("email", "victim@example.com");
    fd.append("sessionId", S1);
    fd.append("status", "back_in_stock");
    fd.append("acknowledgedAt", "2020-01-01T00:00:00.000Z");
    const state = await h.actions.subscribeStockAlert(null, fd);
    expect(state?.ok).toBe(true);
    expect(read.every((name) => name === STOCK_ALERT_FIELD.productId || name === STOCK_ALERT_FIELD.productSlug)).toBe(true);
    expect(read).not.toContain("email");
    const rows = alertRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: S2, acknowledged_at: null });
    expect(JSON.stringify(h.db.query("SELECT * FROM stock_alerts").all())).not.toContain("victim");
  });

  test("criterion 3: 10 per hour per session, then RATE_LIMITED with retryAfterSeconds, service not called", async () => {
    const h = setup();
    const subscribe = spyOn(h.service, "subscribe");
    for (let i = 0; i < 10; i++) {
      const state = await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
      expect(state?.ok).toBe(true);
    }
    expect(subscribe).toHaveBeenCalledTimes(10);
    const limited = await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
    const e = expectError(limited, "RATE_LIMITED");
    expect(subscribe).toHaveBeenCalledTimes(10);
    expect(typeof e.retryAfterSeconds).toBe("number");
    expect(e.retryAfterSeconds).toBeGreaterThan(0);
    expect(e.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(e.error.details).toEqual({ retryAfterSeconds: e.retryAfterSeconds });
    expect(e.message).toBe(rateLimitedMessage(e.retryAfterSeconds));

    // A different session is not affected by S1's bucket.
    h.session.current = S2;
    expect((await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id })))?.ok).toBe(true);

    // The window resets after an hour.
    h.session.current = S1;
    h.clock.ms += 3600 * 1000;
    expect((await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id })))?.ok).toBe(true);
  });

  test("criterion 3: global backstop (500/hour) applies even to fresh sessions", async () => {
    const h = setup();
    for (let s = 0; s < 50; s++) {
      h.session.current = `${String(s).padStart(8, "0")}-0000-4000-8000-000000000000`;
      for (let i = 0; i < 10; i++) {
        const state = await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
        expect(state?.ok).toBe(true);
      }
    }
    h.session.current = S2;
    const limited = await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
    expect(expectError(limited, "RATE_LIMITED").retryAfterSeconds).toBeGreaterThan(0);
    expect(h.service.countFor(S2)).toBe(0);
  });

  test("limiter keys are the per-session and global keys for stock_alert.subscribe", async () => {
    const keys: string[] = [];
    const fakeLimiter: RateLimiter = {
      check(key: string, rule: RateLimitRule) {
        expect(rule.limit).toBeGreaterThan(0);
        keys.push(key);
        return { ok: true, value: { remaining: 1 } };
      },
    };
    const h = setup({ limiter: fakeLimiter });
    await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
    expect(keys).toEqual([`stock_alert.subscribe:${S1}`, "stock_alert.subscribe:*"]);
  });

  test("invalid slug: only /account/alerts and /account are revalidated", async () => {
    const h = setup();
    await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id, productSlug: "../../admin" }));
    expect(h.revalidatePath.mock.calls).toEqual([[ACCOUNT_ALERTS_PATH], [ACCOUNT_HUB_PATH]]);
  });
});

describe("unsubscribeStockAlert / acknowledgeStockAlert", () => {
  async function subscribed(h: Harness): Promise<string> {
    await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
    const id = alertRows(h.db)[0]?.id;
    if (id === undefined) throw new Error("no alert");
    h.revalidatePath.mockClear();
    h.getOrCreate.mockClear();
    return id;
  }

  test("no cookie: NOT_FOUND, no session created, service not touched", async () => {
    const h = setup();
    const unsub = spyOn(h.service, "unsubscribe");
    const ack = spyOn(h.service, "acknowledge");
    for (const action of [h.actions.unsubscribeStockAlert, h.actions.acknowledgeStockAlert]) {
      const state = await action(null, form({ alertId: "00000000-0000-4000-8000-000000000001" }));
      expect(expectError(state, "NOT_FOUND").message).toBe(STOCK_ALERT_MESSAGES.alertNotFound);
    }
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.session.current).toBeNull();
    expect(unsub).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("missing or non-string alertId: INVALID_INPUT field error, nothing read", async () => {
    const h = setup();
    for (const action of [h.actions.unsubscribeStockAlert, h.actions.acknowledgeStockAlert]) {
      for (const fd of [form({}), form({ alertId: new Blob(["x"]) }), form({ alertId: "" })]) {
        const e = expectError(await action(null, fd), "INVALID_INPUT");
        expect(e.error.details).toEqual({ field: "alertId" });
      }
    }
    expect(h.read).not.toHaveBeenCalled();
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("another session's alert id: NOT_FOUND and the row survives", async () => {
    const h = setup();
    const id = await subscribed(h);
    h.session.current = S2;
    expectError(await h.actions.acknowledgeStockAlert(null, form({ alertId: id })), "NOT_FOUND");
    expectError(await h.actions.unsubscribeStockAlert(null, form({ alertId: id })), "NOT_FOUND");
    expect(alertRows(h.db)).toHaveLength(1);
    expect(alertRows(h.db)[0]?.acknowledged_at).toBeNull();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("acknowledge own alert: acknowledged, timestamp from injected clock, revalidates PDP, alerts and hub", async () => {
    const h = setup();
    const id = await subscribed(h);
    const state = await h.actions.acknowledgeStockAlert(null, form({ alertId: id, productSlug: h.pourOver.slug, sessionId: S2 }));
    expect(state).toEqual({ ok: true, kind: "acknowledged", message: STOCK_ALERT_MESSAGES.acknowledged });
    expect(alertRows(h.db)[0]?.acknowledged_at).toBe(new Date(T0).toISOString());
    expect(h.revalidatePath.mock.calls).toEqual([[`/products/${h.pourOver.slug}`], [ACCOUNT_ALERTS_PATH], [ACCOUNT_HUB_PATH]]);
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("unsubscribe own alert: unsubscribed, row deleted, alerts + hub revalidated; repeat is NOT_FOUND", async () => {
    const h = setup();
    const id = await subscribed(h);
    const state = await h.actions.unsubscribeStockAlert(null, form({ alertId: id }));
    expect(state).toEqual({ ok: true, kind: "unsubscribed", message: STOCK_ALERT_MESSAGES.unsubscribed });
    expect(alertRows(h.db)).toEqual([]);
    expect(h.revalidatePath.mock.calls).toEqual([[ACCOUNT_ALERTS_PATH], [ACCOUNT_HUB_PATH]]);
    expectError(await h.actions.unsubscribeStockAlert(null, form({ alertId: id })), "NOT_FOUND");
  });
});

describe("always settles", () => {
  test("service throws: generic error state, logs the error code only", async () => {
    const h = setup();
    spyOn(h.service, "subscribe").mockImplementation(() => {
      throw new Error(`SQLITE_BUSY for ${S1} victim@example.com`);
    });
    const state = await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
    expect(state).toEqual({
      ok: false,
      error: { code: "VALIDATION_FAILED", message: STOCK_ALERT_MESSAGES.unexpected, details: { reason: "unexpected" } },
      message: STOCK_ALERT_MESSAGES.unexpected,
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain(STOCK_ALERT_ACTION_FAILED);
    expect(logged).not.toContain(S1);
    expect(logged).not.toContain("victim");
    expect(logged).not.toContain("SQLITE");
  });

  test("session helpers reject: every action still settles", async () => {
    const h = setup({
      getOrCreateSessionId: async () => {
        throw new Error("cookies unavailable");
      },
      readSessionId: async () => {
        throw new Error("cookies unavailable");
      },
    });
    const sub = await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id }));
    const unsub = await h.actions.unsubscribeStockAlert(null, form({ alertId: "a" }));
    const ack = await h.actions.acknowledgeStockAlert(null, form({ alertId: "a" }));
    for (const s of [sub, unsub, ack]) expectError(s, "VALIDATION_FAILED");
  });

  test("limiter throws: settles, service not called", async () => {
    const h = setup({
      limiter: {
        check() {
          throw new Error("db closed");
        },
      },
    });
    const subscribe = spyOn(h.service, "subscribe");
    expectError(await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id })), "VALIDATION_FAILED");
    expect(subscribe).not.toHaveBeenCalled();
  });

  test("states are plain JSON (survive serialization unchanged)", async () => {
    const h = setup();
    const states = [
      await h.actions.subscribeStockAlert(null, form({ productId: h.pourOver.id })),
      await h.actions.subscribeStockAlert(null, form({ productId: h.tote.id })),
      await h.actions.unsubscribeStockAlert(null, form({ alertId: "nope" })),
    ];
    for (const s of states) expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("plain multipart form post (no JavaScript)", () => {
  test("works with a browser-built multipart body without $ACTION_* fields", async () => {
    const h = setup();
    const fd = await browserMultipart([
      ["productId", h.pourOver.id],
      ["productSlug", h.pourOver.slug],
    ]);
    const state = await h.actions.subscribeStockAlert(null, fd);
    expect(state).toEqual({ ok: true, kind: "subscribed", message: STOCK_ALERT_MESSAGES.subscribed });
    expect(alertRows(h.db)).toHaveLength(1);
  });

  test("works with React's $ACTION_* fields and forged extras present", async () => {
    const h = setup();
    const fd = await browserMultipart([
      ["$ACTION_REF_1", ""],
      ["$ACTION_1:0", '{"id":"abc","bound":"$@1"}'],
      ["$ACTION_KEY", "k0"],
      ["productId", h.pourOver.id],
      ["email", "someone@example.com"],
      ["sessionId", S2],
      ["status", "back_in_stock"],
    ]);
    const state = await h.actions.subscribeStockAlert(null, fd);
    expect(state?.ok).toBe(true);
    expect(alertRows(h.db)[0]?.session_id).toBe(S1);
  });
});
