import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ViewActionState } from "@/components/molecules/_contracts/view-actions";
import { VIEW_FIELD } from "@/components/molecules/_contracts/view-actions";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createRecommendationService } from "@/server/recommendations/recommendation-service";
import { createRateLimiter, type RateLimiter } from "@/server/security/rate-limiter";
import {
  ACCOUNT_HISTORY_PATH,
  ACCOUNT_HUB_PATH,
  VIEW_ACTION_FAILED,
  VIEW_MESSAGES,
  createViewActions,
  parseBeaconInput,
  parseIdValue,
  parseSlugValue,
  rateLimitedMessage,
  toErrorState,
  type ViewActionDeps,
} from "./views-core";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");

function setup(overrides: Partial<ViewActionDeps> = {}) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const products = new SqliteProductRepository(db);
  const tote = products.getBySlug("canvas-tote-bag");
  const pourOver = products.getBySlug("ceramic-pour-over");
  if (tote === null || pourOver === null) throw new Error("seed changed");

  const session: { current: string | null; next: string } = { current: null, next: S1 };
  const clock = { ms: T0 };
  const getOrCreate = mock(async (): Promise<string> => {
    if (session.current === null) session.current = session.next;
    return session.current;
  });
  const read = mock(async (): Promise<string | null> => session.current);
  const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const service = createRecommendationService({ db, now: () => clock.ms });
  const limiter: RateLimiter = createRateLimiter(db, { now: () => clock.ms });
  const deps: ViewActionDeps = {
    service,
    findProductIdBySlug: (slug) => products.getBySlug(slug)?.id ?? null,
    productExists: (id) => products.getById(id) !== null,
    limiter,
    getOrCreateSessionId: getOrCreate,
    readSessionId: read,
    revalidatePath,
    now: () => clock.ms,
    logger,
    ...overrides,
  };
  return {
    db,
    deps,
    actions: createViewActions(deps),
    getOrCreate,
    read,
    revalidatePath,
    logger,
    session,
    clock,
    tote: { id: tote.id, slug: tote.slug },
    pourOver: { id: pourOver.id, slug: pourOver.slug },
  };
}

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function viewRows(db: Database): { session_id: string; product_id: string; viewed_at: string }[] {
  return db
    .query("SELECT session_id, product_id, viewed_at FROM product_views ORDER BY session_id, product_id")
    .all() as { session_id: string; product_id: string; viewed_at: string }[];
}

function insertView(db: Database, sessionId: string, productId: string): void {
  db.query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)").run(
    sessionId,
    productId,
    "2026-11-01T00:00:00.000Z",
  );
}

function expectError(state: ViewActionState, code: string): Extract<ViewActionState, { ok: false }> {
  if (state === null || state.ok) throw new Error(`expected error ${code}, got ${JSON.stringify(state)}`);
  expect(state.error.code).toBe(code as typeof state.error.code);
  expect(state.message).toBe(state.error.message);
  return state;
}

const IGNORED: ViewActionState = { ok: true, kind: "ignored" };

describe("parsing helpers", () => {
  test("parseSlugValue accepts only ^[a-z0-9-]{1,100}$ strings", () => {
    expect(parseSlugValue("canvas-tote-bag")).toBe("canvas-tote-bag");
    for (const bad of ["", "Canvas", "../x", "a b", "a".repeat(101), "café", "x\n", 5, null, undefined, {}, ["a"]]) {
      expect(parseSlugValue(bad)).toBeNull();
    }
    expect(parseSlugValue("a".repeat(100))).toBe("a".repeat(100));
  });

  test("parseIdValue trims and bounds 1..200", () => {
    expect(parseIdValue("  p1  ")).toBe("p1");
    expect(parseIdValue("x".repeat(200))).toBe("x".repeat(200));
    for (const bad of ["", "   ", "x".repeat(201), "x".repeat(10_000), 1, null, {}, []]) {
      expect(parseIdValue(bad)).toBeNull();
    }
  });

  test("parseBeaconInput ignores non-objects, arrays and inherited keys", () => {
    const none = { productId: null, productSlug: null };
    for (const bad of [null, undefined, "x", 42, true, [], ["canvas-tote-bag"], Object.create({ productSlug: "a" })]) {
      expect(parseBeaconInput(bad)).toEqual(none);
    }
    expect(parseBeaconInput({ productSlug: "abc", productId: " id " })).toEqual({ productId: "id", productSlug: "abc" });
    expect(parseBeaconInput({ productSlug: { toString: () => "abc" }, productId: ["id"] })).toEqual(none);
  });

  test("rateLimitedMessage rounds up to whole minutes", () => {
    expect(rateLimitedMessage(undefined)).toBe(VIEW_MESSAGES.rateLimitedFallback);
    expect(rateLimitedMessage(1)).toBe("Too many requests. Please try again in 1 minute.");
    expect(rateLimitedMessage(61)).toBe("Too many requests. Please try again in 2 minutes.");
  });

  test("toErrorState whitelists details", () => {
    expect(toErrorState({ code: "NOT_FOUND", message: "<b>raw</b>", details: { productId: "<b>" } })).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: VIEW_MESSAGES.invalidRequest },
      message: VIEW_MESSAGES.invalidRequest,
    });
    expect(toErrorState({ code: "INVALID_INPUT", message: "x", details: { field: "sql" } })).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: VIEW_MESSAGES.invalidRequest },
      message: VIEW_MESSAGES.invalidRequest,
    });
    expect(toErrorState({ code: "RATE_LIMITED", message: "x", details: { retryAfterSeconds: 30 } })).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: rateLimitedMessage(30), details: { retryAfterSeconds: 30 } },
      message: rateLimitedMessage(30),
      retryAfterSeconds: 30,
    });
  });
});

describe("recordProductView (criteria 1-3)", () => {
  test("criterion 1: unknown slug / unknown id is ignored and creates no session", async () => {
    const h = setup();
    expect(await h.actions.recordProductView({ productSlug: "no-such-product" })).toEqual(IGNORED);
    expect(await h.actions.recordProductView({ productId: "prod_nope" })).toEqual(IGNORED);
    expect(await h.actions.recordProductView({ productSlug: "no-such", productId: "prod_nope" })).toEqual(IGNORED);
    expect(await h.actions.recordProductView({})).toEqual(IGNORED);
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.session.current).toBeNull();
    expect(viewRows(h.db)).toEqual([]);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("garbage input never throws, is ignored, creates no session", async () => {
    const h = setup();
    const garbage: unknown[] = [
      null,
      undefined,
      "canvas-tote-bag",
      42,
      [],
      [{ productSlug: "canvas-tote-bag" }],
      { productSlug: "x".repeat(10_000) },
      { productId: "x".repeat(10_000) },
      { productSlug: ["canvas-tote-bag"] },
      { productSlug: { slug: "canvas-tote-bag" } },
      { productId: 123 },
      { productSlug: "Canvas-Tote-Bag" },
      { productSlug: "../../etc/passwd" },
    ];
    const beacon = h.actions.recordProductView as (input: unknown) => Promise<ViewActionState>;
    for (const input of garbage) {
      expect(await beacon(input)).toEqual(IGNORED);
    }
    // A throwing getter is still settled, not thrown.
    const hostile = Object.defineProperty({}, "productSlug", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(await beacon(hostile)).toEqual(IGNORED);
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(viewRows(h.db)).toEqual([]);
  });

  test("criterion 2: valid slug creates the session lazily and upserts one row; repeats do not duplicate", async () => {
    const h = setup();
    expect(await h.actions.recordProductView({ productSlug: h.tote.slug })).toEqual({ ok: true, kind: "recorded" });
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.session.current).toBe(S1);
    h.clock.ms += 5_000;
    expect(await h.actions.recordProductView({ productSlug: h.tote.slug })).toEqual({ ok: true, kind: "recorded" });
    expect(await h.actions.recordProductView({ productId: h.tote.id })).toEqual({ ok: true, kind: "recorded" });
    const rows = viewRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: S1, product_id: h.tote.id, viewed_at: new Date(T0 + 5_000).toISOString() });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("valid productId is recorded; out-of-stock products are still recorded", async () => {
    const h = setup();
    expect(await h.actions.recordProductView({ productId: ` ${h.pourOver.id} ` })).toMatchObject({ kind: "recorded" });
    expect(viewRows(h.db)).toEqual([expect.objectContaining({ session_id: S1, product_id: h.pourOver.id })]);
  });

  test("valid slug wins; unknown slug falls back to a valid productId", async () => {
    const h = setup();
    await h.actions.recordProductView({ productSlug: h.tote.slug, productId: h.pourOver.id });
    expect(viewRows(h.db).map((r) => r.product_id)).toEqual([h.tote.id]);
    await h.actions.recordProductView({ productSlug: "nope-nope", productId: h.pourOver.id });
    expect(viewRows(h.db).map((r) => r.product_id).sort()).toEqual([h.tote.id, h.pourOver.id].sort());
  });

  test("forged session id in the input is ignored", async () => {
    const h = setup();
    const beacon = h.actions.recordProductView as (input: unknown) => Promise<ViewActionState>;
    await beacon({ productSlug: h.tote.slug, sessionId: S2 });
    expect(viewRows(h.db)).toEqual([expect.objectContaining({ session_id: S1 })]);
  });

  test("without productExists a bare id never mints a session; existing session records it", async () => {
    const h = setup();
    const { productExists: _omitted, ...withoutExists } = h.deps;
    expect(_omitted).toBeDefined();
    const actions = createViewActions(withoutExists);
    expect(await actions.recordProductView({ productId: h.tote.id })).toEqual(IGNORED);
    expect(h.getOrCreate).not.toHaveBeenCalled();
    h.session.current = S2;
    expect(await actions.recordProductView({ productId: "prod_unknown" })).toEqual(IGNORED);
    expect(await actions.recordProductView({ productId: h.tote.id })).toMatchObject({ kind: "recorded" });
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(viewRows(h.db)).toEqual([expect.objectContaining({ session_id: S2, product_id: h.tote.id })]);
  });

  test("criterion 3: 120 per minute per session, then RATE_LIMITED quietly; next window works again", async () => {
    const h = setup();
    for (let i = 0; i < 120; i++) {
      expect(await h.actions.recordProductView({ productSlug: h.tote.slug })).toMatchObject({ ok: true, kind: "recorded" });
    }
    const state = expectError(await h.actions.recordProductView({ productSlug: h.tote.slug }), "RATE_LIMITED");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.retryAfterSeconds).toBeLessThanOrEqual(60);
    // Another session is unaffected.
    h.session.current = S2;
    expect(await h.actions.recordProductView({ productSlug: h.tote.slug })).toMatchObject({ kind: "recorded" });
    // Next window.
    h.session.current = S1;
    h.clock.ms += 60_000;
    expect(await h.actions.recordProductView({ productSlug: h.tote.slug })).toMatchObject({ kind: "recorded" });
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  test("rate limiting happens before the service write", async () => {
    const h = setup();
    const recordView = mock(h.deps.service.recordView.bind(h.deps.service));
    const actions = createViewActions({
      ...h.deps,
      service: { ...h.deps.service, recordView, removeView: h.deps.service.removeView.bind(h.deps.service), clearViews: h.deps.service.clearViews.bind(h.deps.service) },
      limiter: { check: () => ({ ok: false, error: { code: "RATE_LIMITED", message: "x", details: { retryAfterSeconds: 10 } } }) },
    });
    expectError(await actions.recordProductView({ productSlug: h.tote.slug }), "RATE_LIMITED");
    expect(recordView).not.toHaveBeenCalled();
  });

  test("service NOT_FOUND (product deleted between lookup and write) is ignored", async () => {
    const h = setup();
    const actions = createViewActions({
      ...h.deps,
      service: {
        recordView: () => ({ ok: false, error: { code: "NOT_FOUND", message: "gone" } }),
        removeView: () => undefined,
        clearViews: () => undefined,
      },
    });
    expect(await actions.recordProductView({ productSlug: h.tote.slug })).toEqual(IGNORED);
  });

  test("unexpected exceptions settle as a generic error and log no input", async () => {
    const h = setup();
    const actions = createViewActions({
      ...h.deps,
      findProductIdBySlug: () => {
        throw new Error(`db down for ${h.tote.slug}`);
      },
    });
    const state = expectError(await actions.recordProductView({ productSlug: h.tote.slug }), "VALIDATION_FAILED");
    expect(state.error.details).toEqual({ reason: "unexpected" });
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const logged = String(h.logger.error.mock.calls[0]?.[0]);
    expect(logged).toBe(`[views] ${VIEW_ACTION_FAILED} action=record`);
    expect(logged).not.toContain(h.tote.slug);

    const failingSession = createViewActions({
      ...h.deps,
      getOrCreateSessionId: () => Promise.reject(new Error("cookies unavailable")),
    });
    expectError(await failingSession.recordProductView({ productSlug: h.tote.slug }), "VALIDATION_FAILED");
  });

  test("recordProductViewForm reads the same fields from FormData", async () => {
    const h = setup();
    expect(await h.actions.recordProductViewForm(null, form({ [VIEW_FIELD.productSlug]: "nope-x" }))).toEqual(IGNORED);
    expect(await h.actions.recordProductViewForm(null, form({ productSlug: new Blob(["canvas-tote-bag"]) }))).toEqual(IGNORED);
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(
      await h.actions.recordProductViewForm(null, form({ productSlug: h.tote.slug, sessionId: S2 })),
    ).toMatchObject({ kind: "recorded" });
    expect(viewRows(h.db)).toEqual([expect.objectContaining({ session_id: S1, product_id: h.tote.id })]);
    const garbage = h.actions.recordProductViewForm as (p: unknown, f: unknown) => Promise<ViewActionState>;
    expect(await garbage(null, { productSlug: h.tote.slug })).toEqual(IGNORED);
  });
});

describe("removeFromHistory (criterion 5)", () => {
  test("removes only this session's row and revalidates /account/history and /account", async () => {
    const h = setup();
    insertView(h.db, S1, h.tote.id);
    insertView(h.db, S2, h.tote.id);
    h.session.current = S1;
    expect(await h.actions.removeFromHistory(null, form({ productId: h.tote.id, sessionId: S2 }))).toEqual({
      ok: true,
      kind: "removed",
      message: VIEW_MESSAGES.removed,
    });
    expect(viewRows(h.db)).toEqual([expect.objectContaining({ session_id: S2, product_id: h.tote.id })]);
    expect(h.revalidatePath.mock.calls).toEqual([[ACCOUNT_HISTORY_PATH], [ACCOUNT_HUB_PATH]]);
  });

  test("another session's product row is a no-op for this session", async () => {
    const h = setup();
    insertView(h.db, S2, h.pourOver.id);
    h.session.current = S1;
    expect(await h.actions.removeFromHistory(null, form({ productId: h.pourOver.id }))).toMatchObject({ ok: true });
    expect(viewRows(h.db)).toEqual([expect.objectContaining({ session_id: S2, product_id: h.pourOver.id })]);
  });

  test("no cookie: ignored, nothing created, nothing revalidated", async () => {
    const h = setup();
    insertView(h.db, S2, h.tote.id);
    expect(await h.actions.removeFromHistory(null, form({ productId: h.tote.id }))).toEqual(IGNORED);
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(viewRows(h.db)).toHaveLength(1);
  });

  test("invalid productId -> INVALID_INPUT with field, before reading the session", async () => {
    const h = setup();
    h.session.current = S1;
    for (const fd of [form({}), form({ productId: "  " }), form({ productId: "x".repeat(10_000) }), form({ productId: new Blob(["x"]) })]) {
      const state = expectError(await h.actions.removeFromHistory(null, fd), "INVALID_INPUT");
      expect(state.error.details).toEqual({ field: "productId" });
    }
    expect(h.read).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("rate limited at 120/min per session", async () => {
    const h = setup();
    h.session.current = S1;
    for (let i = 0; i < 120; i++) await h.actions.removeFromHistory(null, form({ productId: h.tote.id }));
    expectError(await h.actions.removeFromHistory(null, form({ productId: h.tote.id })), "RATE_LIMITED");
  });

  test("service exception settles as generic error", async () => {
    const h = setup();
    h.session.current = S1;
    const actions = createViewActions({
      ...h.deps,
      service: {
        recordView: () => ({ ok: true, value: undefined }),
        removeView: () => {
          throw new Error("SQLITE_BUSY");
        },
        clearViews: () => undefined,
      },
    });
    expectError(await actions.removeFromHistory(null, form({ productId: h.tote.id })), "VALIDATION_FAILED");
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("clearHistory (criterion 4)", () => {
  test("without confirm=yes -> INVALID_INPUT and nothing deleted", async () => {
    const h = setup();
    insertView(h.db, S1, h.tote.id);
    h.session.current = S1;
    for (const fd of [form({}), form({ confirm: "no" }), form({ confirm: "YES" }), form({ confirm: " yes" }), form({ confirm: new Blob(["yes"]) })]) {
      const state = expectError(await h.actions.clearHistory(null, fd), "INVALID_INPUT");
      expect(state.error.details).toEqual({ field: "confirm" });
      expect(state.message).toBe(VIEW_MESSAGES.confirmRequired);
    }
    expect(viewRows(h.db)).toHaveLength(1);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("with confirm=yes deletes only this session's rows", async () => {
    const h = setup();
    insertView(h.db, S1, h.tote.id);
    insertView(h.db, S1, h.pourOver.id);
    insertView(h.db, S2, h.tote.id);
    h.session.current = S1;
    expect(await h.actions.clearHistory(null, form({ confirm: "yes", sessionId: S2 }))).toEqual({
      ok: true,
      kind: "cleared",
      message: VIEW_MESSAGES.cleared,
    });
    expect(viewRows(h.db)).toEqual([expect.objectContaining({ session_id: S2 })]);
    expect(h.revalidatePath.mock.calls).toEqual([[ACCOUNT_HISTORY_PATH], [ACCOUNT_HUB_PATH]]);
  });

  test("no cookie: ignored, no session created", async () => {
    const h = setup();
    expect(await h.actions.clearHistory(null, form({ confirm: "yes" }))).toEqual(IGNORED);
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("logger failures (QA D1)", () => {
  test("a throwing logger still settles every action with the generic state", async () => {
    const h = setup();
    const actions = createViewActions({
      ...h.deps,
      findProductIdBySlug: () => {
        throw new Error("db down");
      },
      readSessionId: () => Promise.reject(new Error("cookies down")),
      logger: {
        error: () => {
          throw new Error("logger down");
        },
      },
    });
    expectError(await actions.recordProductView({ productSlug: h.tote.slug }), "VALIDATION_FAILED");
    expectError(await actions.recordProductViewForm(null, form({ productSlug: h.tote.slug })), "VALIDATION_FAILED");
    expectError(await actions.removeFromHistory(null, form({ productId: h.tote.id })), "VALIDATION_FAILED");
    expectError(await actions.clearHistory(null, form({ confirm: "yes" })), "VALIDATION_FAILED");
  });
});

describe("concurrency", () => {
  test("parallel records of the same product leave one row", async () => {
    const h = setup();
    h.session.current = S1;
    const states = await Promise.all(
      Array.from({ length: 20 }, () => h.actions.recordProductView({ productSlug: h.tote.slug })),
    );
    expect(states.every((s) => s !== null && s.ok)).toBe(true);
    expect(viewRows(h.db)).toHaveLength(1);
  });
});
