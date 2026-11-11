import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// QA adversarial tests for T52 (view-tracking + history server actions).
//
// Part 1: wiring tests of `@/app/actions/views` with `next/headers` and
// `next/cache` mocked (process-wide; registered before any import that can
// reach them), real session module, real limiter, real service over an
// in-memory seeded DB.
// Part 2: `createViewActions` with spies to pin the limiter key, the order of
// operations, and the PII-free log line.
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
  delete(name: string): void {
    this.jar.delete(name);
  }
}

let fakeStore = new FakeCookieStore();
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/cache", () => ({ revalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

type ViewActionState = import("@/components/molecules/_contracts/view-actions").ViewActionState;
type ViewActionDeps = import("@/app/actions/views-core").ViewActionDeps;
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { createRateLimiter } = await import("@/server/security/rate-limiter");
const core = await import("@/app/actions/views-core");
const wired = await import("@/app/actions/views");
const { recordProductView, recordProductViewForm, removeFromHistory, clearHistory } = wired;

const IGNORED = { ok: true, kind: "ignored" } as const;
const TOTE_SLUG = "canvas-tote-bag";
const POUR_SLUG = "ceramic-pour-over";
const MINE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FOREIGN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const appGlobals = globalThis as typeof globalThis & { __storefrontRateLimiter?: { db: unknown; limiter: unknown } };
// Pinned mid-window clock so the 121-call test never straddles a window boundary.
const FIXED_NOW = Date.parse("2026-11-07T12:00:30.000Z");

function form(entries: readonly (readonly [string, string])[]): FormData {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

function idOf(slug: string): string {
  const row = getDatabase().query("SELECT id FROM products WHERE slug = ?").get(slug) as { id: string } | null;
  if (row === null) throw new Error(`seed changed: ${slug}`);
  return row.id;
}

function viewRows(): { session_id: string; product_id: string }[] {
  return getDatabase()
    .query("SELECT session_id, product_id FROM product_views ORDER BY session_id, product_id")
    .all() as { session_id: string; product_id: string }[];
}

function sessionCount(): number {
  return fakeStore.setCalls.filter((c) => c.name === SESSION_COOKIE_NAME).length;
}

function insertForeign(productId: string): void {
  getDatabase()
    .query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)")
    .run(FOREIGN, productId, "2026-11-01T00:00:00.000Z");
}

beforeEach(() => {
  closeDatabase();
  appGlobals.__storefrontRateLimiter = undefined;
  seedDatabase(getDatabase());
  appGlobals.__storefrontRateLimiter = {
    db: getDatabase(),
    limiter: createRateLimiter(getDatabase(), { now: () => FIXED_NOW }),
  };
  fakeStore = new FakeCookieStore();
  revalidatePath.mockClear();
});

afterAll(() => {
  closeDatabase();
  appGlobals.__storefrontRateLimiter = undefined;
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

// ---------------------------------------------------------------------------
// Part 1: wired
// ---------------------------------------------------------------------------

describe("T52 'use server' module shape", () => {
  test("every export is an AsyncFunction", () => {
    for (const [name, value] of Object.entries(wired)) {
      expect(typeof value, name).toBe("function");
      expect((value as () => unknown).constructor.name, name).toBe("AsyncFunction");
    }
  });
});

describe("T52 c1: invalid / unknown input -> ignored, no session, no write", () => {
  function throwingGetterInput(): unknown {
    const o: Record<string, unknown> = {};
    Object.defineProperty(o, "productSlug", {
      enumerable: true,
      get() {
        throw new Error(`boom ${TOTE_SLUG}`);
      },
    });
    return o;
  }
  function throwingProxy(): unknown {
    return new Proxy(
      {},
      {
        get() {
          throw new Error("proxy get");
        },
        getOwnPropertyDescriptor() {
          throw new Error("proxy gopd");
        },
        has() {
          throw new Error("proxy has");
        },
        ownKeys() {
          throw new Error("proxy keys");
        },
        getPrototypeOf() {
          throw new Error("proxy proto");
        },
      },
    );
  }

  const cases: readonly (readonly [string, () => unknown])[] = [
    ["null", () => null],
    ["undefined", () => undefined],
    ["number", () => 42],
    ["string slug", () => TOTE_SLUG],
    ["array", () => [TOTE_SLUG]],
    ["array of objects", () => [{ productSlug: TOTE_SLUG }]],
    ["empty object", () => ({})],
    ["unknown slug", () => ({ productSlug: "no-such-product" })],
    ["unknown id", () => ({ productId: "prod_no-such" })],
    ["uppercase slug", () => ({ productSlug: TOTE_SLUG.toUpperCase() })],
    ["slug with space", () => ({ productSlug: ` ${TOTE_SLUG}` })],
    ["slug sql", () => ({ productSlug: "' OR 1=1 --" })],
    ["slug path", () => ({ productSlug: "../canvas-tote-bag" })],
    ["10k slug", () => ({ productSlug: "a".repeat(10_000) })],
    ["10k id", () => ({ productId: "a".repeat(10_000) })],
    ["10k padded real id", () => ({ productId: `${" ".repeat(10_000)}prod_canvas-tote-bag` })],
    ["slug array", () => ({ productSlug: [TOTE_SLUG] })],
    ["id array", () => ({ productId: ["prod_canvas-tote-bag"] })],
    ["slug object", () => ({ productSlug: { toString: () => TOTE_SLUG } })],
    ["slug number", () => ({ productSlug: 1 })],
    ["id null", () => ({ productId: null, productSlug: null })],
    ["NUL id", () => ({ productId: "prod_canvas-tote-bag\u0000" })],
    ["inherited slug", () => Object.create({ productSlug: TOTE_SLUG }) as unknown],
    ["__proto__ slug", () => JSON.parse(`{"__proto__":{"productSlug":"${TOTE_SLUG}"}}`) as unknown],
    ["throwing getter", throwingGetterInput],
    ["throwing proxy", throwingProxy],
    ["FormData", () => form([["productSlug", TOTE_SLUG]])],
    ["Date", () => new Date()],
    ["function", () => () => TOTE_SLUG],
  ];

  for (const [name, make] of cases) {
    test(`beacon: ${name}`, async () => {
      const beacon = recordProductView as (input: unknown) => Promise<unknown>;
      let result: unknown;
      let threw: unknown = null;
      try {
        result = await beacon(make());
      } catch (error) {
        threw = error;
      }
      expect(threw).toBeNull();
      expect(result).toEqual(IGNORED);
      expect(fakeStore.setCalls).toEqual([]);
      expect(viewRows()).toEqual([]);
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }

  test("form variant: non-FormData and junk fields are ignored, no session", async () => {
    const fn = recordProductViewForm as (prev: unknown, fd: unknown) => Promise<unknown>;
    for (const fd of [
      null,
      undefined,
      {},
      { productSlug: TOTE_SLUG },
      form([]),
      form([["productSlug", "no-such"]]),
      form([["productId", "prod_nope"]]),
      form([["productSlug", "x".repeat(10_000)]]),
      form([["slug", TOTE_SLUG]]),
      form([["sessionId", MINE]]),
    ]) {
      expect(await fn(null, fd)).toEqual(IGNORED);
    }
    const withFile = new FormData();
    withFile.append("productSlug", new Blob([TOTE_SLUG]), "x.txt");
    expect(await fn(null, withFile)).toEqual(IGNORED);
    expect(fakeStore.setCalls).toEqual([]);
    expect(viewRows()).toEqual([]);
  });

  test("ignored input does not touch the rate limiter", async () => {
    await recordProductView({ productSlug: "no-such-product" });
    const n = getDatabase().query("SELECT COUNT(*) AS n FROM rate_limits").get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("T52 c2: lazy session + upsert", () => {
  test("valid id creates one cookie and one row; repeats by slug or id do not duplicate", async () => {
    const tote = idOf(TOTE_SLUG);
    expect(await recordProductView({ productId: tote })).toEqual({ ok: true, kind: "recorded" });
    for (let i = 0; i < 5; i += 1) {
      expect(await recordProductView({ productSlug: TOTE_SLUG })).toMatchObject({ kind: "recorded" });
    }
    expect(sessionCount()).toBe(1);
    const sid = fakeStore.setCalls[0]?.value ?? "";
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);
    expect(viewRows()).toEqual([{ session_id: sid, product_id: tote }]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("existing valid cookie is reused: no set() call", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, MINE);
    await recordProductView({ productSlug: TOTE_SLUG });
    await recordProductView({ productSlug: POUR_SLUG });
    expect(fakeStore.setCalls).toEqual([]);
    expect(viewRows().map((r) => r.session_id)).toEqual([MINE, MINE]);
  });

  test("garbage cookie + valid product: replaced by a fresh UUID, garbage never stored", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, "'; DROP TABLE product_views; --");
    expect(await recordProductView({ productSlug: TOTE_SLUG })).toMatchObject({ kind: "recorded" });
    expect(sessionCount()).toBe(1);
    const rows = viewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.session_id).toBe(fakeStore.setCalls[0]?.value ?? "missing");
  });

  test("forged sessionId in beacon and form is ignored", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, MINE);
    const beacon = recordProductView as (input: unknown) => Promise<unknown>;
    await beacon({ productSlug: TOTE_SLUG, sessionId: FOREIGN, session_id: FOREIGN });
    await recordProductViewForm(
      null,
      form([
        ["productSlug", POUR_SLUG],
        ["sessionId", FOREIGN],
      ]),
    );
    expect(viewRows().every((r) => r.session_id === MINE)).toBe(true);
    expect(viewRows()).toHaveLength(2);
  });

  test("concurrent first views (no cookie yet) settle and never duplicate a (session, product) row", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => recordProductView({ productSlug: TOTE_SLUG })));
    for (const r of results) expect(r).toMatchObject({ ok: true, kind: "recorded" });
    const rows = viewRows();
    const keys = new Set(rows.map((r) => `${r.session_id}|${r.product_id}`));
    expect(keys.size).toBe(rows.length);
  });
});

describe("T52 c3: 120/min per session", () => {
  test("121st call -> RATE_LIMITED quietly (settles, no throw, retryAfterSeconds); other session unaffected", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, MINE);
    for (let i = 0; i < 120; i += 1) {
      const r = await recordProductView({ productSlug: TOTE_SLUG });
      expect(r).toMatchObject({ ok: true, kind: "recorded" });
    }
    const over = await recordProductView({ productSlug: TOTE_SLUG });
    expect(over).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    const state = over as Exclude<ViewActionState, null>;
    if (state.ok) throw new Error("expected failure");
    expect(typeof state.retryAfterSeconds).toBe("number");
    expect(state.message).not.toContain(MINE);
    expect(state.message).not.toContain(TOTE_SLUG);

    fakeStore.jar.set(SESSION_COOKIE_NAME, FOREIGN);
    expect(await recordProductView({ productSlug: TOTE_SLUG })).toMatchObject({ ok: true, kind: "recorded" });
  });

  test("limiter key is views.record:<sid> with 120/60s", async () => {
    const row = () =>
      getDatabase().query("SELECT key, count FROM rate_limits WHERE key LIKE '%views.record%'").all() as {
        key: string;
        count: number;
      }[];
    fakeStore.jar.set(SESSION_COOKIE_NAME, MINE);
    await recordProductView({ productSlug: TOTE_SLUG });
    expect(row()).toEqual([{ key: `60:views.record:${MINE}`, count: 1 }]);
  });
});

describe("T52 c4/c5: removeFromHistory / clearHistory", () => {
  test("no cookie: ignored, no session, no revalidate, no delete of anyone", async () => {
    insertForeign(idOf(TOTE_SLUG));
    expect(await removeFromHistory(null, form([["productId", idOf(TOTE_SLUG)]]))).toEqual(IGNORED);
    expect(await clearHistory(null, form([["confirm", "yes"]]))).toEqual(IGNORED);
    expect(fakeStore.setCalls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(viewRows()).toHaveLength(1);
  });

  test("garbage cookie: ignored (readSessionId -> null), nothing created", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, "not-a-uuid");
    expect(await clearHistory(null, form([["confirm", "yes"]]))).toEqual(IGNORED);
    expect(fakeStore.setCalls).toEqual([]);
  });

  const badConfirms: readonly (readonly [string, FormData | null])[] = [
    ["missing", form([])],
    ["YES", form([["confirm", "YES"]])],
    ["yes with space", form([["confirm", " yes"]])],
    ["true", form([["confirm", "true"]])],
    ["1", form([["confirm", "1"]])],
    ["on", form([["confirm", "on"]])],
    ["empty", form([["confirm", ""]])],
    ["second value yes", form([["confirm", "no"], ["confirm", "yes"]])],
    ["null formdata", null],
  ];
  for (const [name, fd] of badConfirms) {
    test(`clearHistory confirm=${name} -> INVALID_INPUT field confirm, nothing deleted`, async () => {
      fakeStore.jar.set(SESSION_COOKIE_NAME, MINE);
      await recordProductView({ productSlug: TOTE_SLUG });
      revalidatePath.mockClear();
      const r = await (clearHistory as (p: unknown, f: unknown) => Promise<unknown>)(null, fd);
      expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { field: "confirm" } } });
      expect(viewRows()).toHaveLength(1);
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  }

  test("clearHistory confirm=yes deletes only my rows (foreign untouched), revalidates /account/history", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, MINE);
    await recordProductView({ productSlug: TOTE_SLUG });
    await recordProductView({ productSlug: POUR_SLUG });
    insertForeign(idOf(TOTE_SLUG));
    insertForeign(idOf(POUR_SLUG));
    revalidatePath.mockClear();
    expect(
      await clearHistory(
        null,
        form([
          ["confirm", "yes"],
          ["sessionId", FOREIGN],
        ]),
      ),
    ).toMatchObject({ ok: true, kind: "cleared" });
    expect(viewRows().map((r) => r.session_id)).toEqual([FOREIGN, FOREIGN]);
    expect(revalidatePath.mock.calls).toEqual([["/account/history"], ["/account"]]);
  });

  test("removeFromHistory of a product only in a foreign history is a no-op success; foreign row untouched", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, MINE);
    await recordProductView({ productSlug: POUR_SLUG });
    insertForeign(idOf(TOTE_SLUG));
    const before = viewRows();
    const r = await removeFromHistory(
      null,
      form([
        ["productId", idOf(TOTE_SLUG)],
        ["sessionId", FOREIGN],
      ]),
    );
    expect(r).toMatchObject({ ok: true });
    expect(viewRows()).toEqual(before);
  });

  test("removeFromHistory removes my row only, revalidates once", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, MINE);
    await recordProductView({ productSlug: TOTE_SLUG });
    insertForeign(idOf(TOTE_SLUG));
    revalidatePath.mockClear();
    expect(await removeFromHistory(null, form([["productId", idOf(TOTE_SLUG)]]))).toMatchObject({
      ok: true,
      kind: "removed",
    });
    expect(viewRows()).toEqual([{ session_id: FOREIGN, product_id: idOf(TOTE_SLUG) }]);
    expect(revalidatePath.mock.calls).toEqual([["/account/history"], ["/account"]]);
  });

  test("removeFromHistory invalid productId -> INVALID_INPUT field productId; message never echoes input", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, MINE);
    const fn = removeFromHistory as (p: unknown, f: unknown) => Promise<unknown>;
    for (const fd of [null, {}, form([]), form([["productId", ""]]), form([["productId", "   "]]), form([["productId", "<x>".repeat(5000)]])]) {
      const r = await fn(null, fd);
      expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { field: "productId" } } });
      expect(JSON.stringify(r)).not.toContain("<x>");
    }
  });
});

describe("T52 settle-always (wired)", () => {
  test("DB closed underneath: every action settles to a state, never throws", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, MINE);
    getDatabase().close();
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const results = await Promise.all([
        recordProductView({ productSlug: TOTE_SLUG }),
        recordProductViewForm(null, form([["productSlug", TOTE_SLUG]])),
        removeFromHistory(null, form([["productId", "prod_x"]])),
        clearHistory(null, form([["confirm", "yes"]])),
      ]);
      for (const r of results) {
        expect(r === null || typeof r === "object").toBe(true);
        expect(r).not.toBeNull();
      }
      for (const line of errors.flat()) {
        expect(String(line)).not.toContain(MINE);
        expect(String(line)).not.toContain(TOTE_SLUG);
      }
    } finally {
      console.error = orig;
      closeDatabase();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2: core with spies
// ---------------------------------------------------------------------------

describe("T52 core: order of operations, limiter key, logs", () => {
  function spyDeps(overrides: Partial<ViewActionDeps> = {}) {
    const calls: string[] = [];
    const checkKeys: { key: string; limit: number; windowSeconds: number }[] = [];
    const limiter: RateLimiter = {
      check(key, rule) {
        calls.push("limit");
        checkKeys.push({ key, limit: rule.limit, windowSeconds: rule.windowSeconds });
        return { ok: true, value: { remaining: 1 } };
      },
    };
    const logged: string[] = [];
    const deps: ViewActionDeps = {
      service: {
        recordView: () => {
          calls.push("record");
          return { ok: true, value: undefined } as never;
        },
        removeView: () => {
          calls.push("remove");
        },
        clearViews: () => {
          calls.push("clear");
        },
      } as unknown as ViewActionDeps["service"],
      findProductIdBySlug: (slug) => (slug === TOTE_SLUG ? "prod_canvas-tote-bag" : null),
      productExists: (id) => id === "prod_canvas-tote-bag",
      limiter,
      getOrCreateSessionId: async () => {
        calls.push("getOrCreate");
        return MINE;
      },
      readSessionId: async () => {
        calls.push("read");
        return MINE;
      },
      revalidatePath: (p) => {
        calls.push(`revalidate:${p}`);
      },
      logger: {
        error: (...args: unknown[]) => {
          logged.push(args.map(String).join(" "));
        },
      },
      ...overrides,
    };
    return { deps, calls, checkKeys, logged };
  }

  test("record: getOrCreate -> limit(views.record:<sid>, 120/60) -> record; never revalidates", async () => {
    const { deps, calls, checkKeys } = spyDeps();
    const a = core.createViewActions(deps);
    expect(await a.recordProductView({ productSlug: TOTE_SLUG })).toMatchObject({ kind: "recorded" });
    expect(calls).toEqual(["getOrCreate", "limit", "record"]);
    expect(checkKeys).toEqual([{ key: `views.record:${MINE}`, limit: 120, windowSeconds: 60 }]);
  });

  test("record ignored: no getOrCreate, no read, no limit", async () => {
    const { deps, calls } = spyDeps();
    const a = core.createViewActions(deps);
    expect(await a.recordProductView({ productSlug: "nope", productId: "prod_nope" })).toEqual(IGNORED);
    expect(calls).toEqual([]);
  });

  test("record over limit: service not called", async () => {
    const { deps, calls } = spyDeps({
      limiter: {
        check: () => ({
          ok: false,
          error: { code: "RATE_LIMITED", message: "x", details: { retryAfterSeconds: 30 } },
        }),
      } as RateLimiter,
    });
    const a = core.createViewActions(deps);
    const r = await a.recordProductView({ productSlug: TOTE_SLUG });
    expect(r).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" }, retryAfterSeconds: 30 });
    expect(calls).not.toContain("record");
  });

  test("remove/clear: readSessionId (never getOrCreate) -> limit -> service -> revalidate", async () => {
    const { deps, calls } = spyDeps();
    const a = core.createViewActions(deps);
    await a.removeFromHistory(null, form([["productId", "prod_canvas-tote-bag"]]));
    await a.clearHistory(null, form([["confirm", "yes"]]));
    expect(calls).toEqual([
      "read",
      "limit",
      "remove",
      "revalidate:/account/history",
      "revalidate:/account",
      "read",
      "limit",
      "clear",
      "revalidate:/account/history",
      "revalidate:/account",
    ]);
  });

  test("throwing deps settle with a generic state; log line carries no sid, slug, id or error message", async () => {
    const secret = `${MINE} ${TOTE_SLUG} prod_canvas-tote-bag shopper@example.com`;
    const boom = () => {
      throw new Error(secret);
    };
    const { deps, logged } = spyDeps({
      getOrCreateSessionId: async () => boom(),
      readSessionId: async () => boom(),
    });
    const a = core.createViewActions(deps);
    const results = [
      await a.recordProductView({ productSlug: TOTE_SLUG }),
      await a.recordProductViewForm(null, form([["productSlug", TOTE_SLUG]])),
      await a.removeFromHistory(null, form([["productId", "prod_canvas-tote-bag"]])),
      await a.clearHistory(null, form([["confirm", "yes"]])),
    ];
    for (const r of results) {
      expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", details: { reason: "unexpected" } } });
      expect(JSON.stringify(r)).not.toContain(MINE);
    }
    expect(logged.length).toBe(4);
    for (const line of logged) {
      expect(line).not.toContain(MINE);
      expect(line).not.toContain(TOTE_SLUG);
      expect(line).not.toContain("prod_canvas");
      expect(line).not.toContain("@example.com");
    }
  });

  test("throwing logger still settles", async () => {
    const { deps } = spyDeps({
      readSessionId: async () => {
        throw new Error("x");
      },
      logger: {
        error: () => {
          throw new Error("logger down");
        },
      },
    });
    const a = core.createViewActions(deps);
    let threw = false;
    try {
      await a.clearHistory(null, form([["confirm", "yes"]]));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
