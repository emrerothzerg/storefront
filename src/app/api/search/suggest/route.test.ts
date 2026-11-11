import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Route-level tests for GET /api/search/suggest (T53). `next/headers` is
// mocked process-wide (bun's mock.module), before any import that could
// reach it; the fake store records set() calls so we can prove no cookie is
// ever written. The real search service, limiter and session module run
// over DATABASE_PATH=":memory:" with the full seed.

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  setCalls = 0;
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(): void {
    this.setCalls += 1;
  }
}

let fakeStore = new FakeCookieStore();

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { GET } = await import("./route");
const route = await import("./route");
const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { createRateLimiter } = await import("@/server/security/rate-limiter");

/** Mid-window (epoch second 1_700_000_010 is 30s into its minute) so a real minute boundary cannot split the 120-call runs. */
const FIXED_NOW = 1_700_000_010_000;

const appGlobals = globalThis as typeof globalThis & {
  __storefrontSearchService?: unknown;
  __storefrontRateLimiter?: { db: unknown; limiter: unknown };
};

function resetSingletons(): void {
  // Other test files may have cached these over a since-closed database.
  appGlobals.__storefrontSearchService = undefined;
  appGlobals.__storefrontRateLimiter = undefined;
}

beforeAll(() => {
  closeDatabase();
  resetSingletons();
  const db = getDatabase();
  seedDatabase(db);
  // getRateLimiter() reuses this cache while the shared db handle is unchanged.
  appGlobals.__storefrontRateLimiter = { db, limiter: createRateLimiter(db, { now: () => FIXED_NOW }) };
});

afterAll(() => {
  closeDatabase();
  resetSingletons();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

beforeEach(() => {
  fakeStore = new FakeCookieStore();
  getDatabase().run("DELETE FROM rate_limits");
});

const BASE = "http://localhost:3000/api/search/suggest";

function req(q: string): Request {
  return new Request(`${BASE}?q=${encodeURIComponent(q)}`);
}

function withSession(): string {
  const id = crypto.randomUUID();
  fakeStore.jar.set(SESSION_COOKIE_NAME, id);
  return id;
}

function expectHeaders(res: Response): void {
  expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  expect(res.headers.get("Vary")).toBe("Cookie");
}

interface SuggestionJson {
  type: unknown;
  label: unknown;
  href: unknown;
}

function assertSuggestions(body: unknown): SuggestionJson[] {
  expect(typeof body).toBe("object");
  const list = (body as { suggestions?: unknown }).suggestions;
  expect(Array.isArray(list)).toBe(true);
  const items = list as SuggestionJson[];
  expect(items.length).toBeLessThanOrEqual(8);
  for (const s of items) {
    expect(Object.keys(s).sort()).toEqual(["href", "label", "type"]);
    expect(["product", "category", "brand"]).toContain(s.type as string);
    expect(typeof s.label).toBe("string");
    expect(typeof s.href).toBe("string");
    const href = s.href as string;
    expect(href.startsWith("/")).toBe(true);
    expect(href.startsWith("//")).toBe(false);
    expect(href).not.toMatch(/^[a-z][a-z0-9+.-]*:/i);
  }
  return items;
}

describe("GET /api/search/suggest", () => {
  test("route exports only GET", () => {
    expect(Object.keys(route).sort()).toEqual(["GET"]);
  });

  test("missing, empty, whitespace and 1-char q -> 200 []", async () => {
    for (const r of [new Request(BASE), new Request(`${BASE}?q=`), req("   "), req("a"), req("é")]) {
      const res = await GET(r);
      expect(res.status).toBe(200);
      expectHeaders(res);
      expect(await res.json()).toEqual({ suggestions: [] });
    }
  });

  test("q over 100 chars -> 400 query_too_long", async () => {
    for (const q of ["a".repeat(101), "x".repeat(10_000)]) {
      const res = await GET(req(q));
      expect(res.status).toBe(400);
      expectHeaders(res);
      expect(await res.json()).toEqual({ error: "query_too_long" });
    }
  });

  test("real seeded suggestions: JSON, internal hrefs, at most 8", async () => {
    withSession();
    const res = await GET(req("ca"));
    expect(res.status).toBe(200);
    expectHeaders(res);
    const items = assertSuggestions(await res.json());
    expect(items.length).toBeGreaterThan(0);
    expect(fakeStore.setCalls).toBe(0);
  });

  test("50 hostile q values -> 200 or 400, never 500; no cookie writes", async () => {
    withSession();
    const hostile: string[] = [
      '"', '""', "'", "*", "**", "^", ":", "()", ")(", "a*", "\"ca\"*",
      "NEAR(a b)", "a NEAR b", "a AND b", "OR OR", "NOT x", "-ca", "--", "ca -",
      "name:ca", "products_fts:x", "{name}: x", "ca OR 1=1", "'; DROP TABLE products; --",
      "x".repeat(10_000), "ca".repeat(50), "ca".repeat(51), "\u0000", "ca\u0000ca", "%00",
      "%2522ca%2522", "%22ca%22", "%27", "__proto__", "constructor", "prototype",
      '{"__proto__":{"x":1}}', "toString", "\u{1F600}\u{1F600}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "\u202Eca", "c\u200Ba",
      "\uFF43\uFF41", "\u13DFa", "ça", "<script>alert(1)</script>", "javascript:alert(1)", "//evil.com",
      "\\\\", "\r\n\t ca", "\uFFFF\uFFFE", "a\u0001\u001Fb",
    ];
    expect(hostile.length).toBeGreaterThanOrEqual(50);
    for (const q of hostile) {
      const res = await GET(req(q));
      expect([200, 400]).toContain(res.status);
      expectHeaders(res);
      const body: unknown = await res.json();
      if (res.status === 200) assertSuggestions(body);
      else expect(body).toEqual({ error: "query_too_long" });
    }
    // Raw (unencoded) hostile query strings too.
    for (const raw of ["%00", "%E0%A4%A", "%%", "q", "%22%2A%22", "%5C", "%ED%A0%80ca", "%C0%AF"]) {
      const res = await GET(new Request(`${BASE}?q=${raw}`));
      expect([200, 400]).toContain(res.status);
    }
    expect(fakeStore.setCalls).toBe(0);
  });

  test("429 after 120 calls in a minute per session, with Retry-After; other session unaffected", async () => {
    withSession();
    for (let i = 0; i < 120; i++) {
      const res = await GET(req("ca"));
      if (res.status !== 200) throw new Error(`unexpected ${res.status} at call ${i + 1}`);
    }
    const res = await GET(req("ca"));
    expect(res.status).toBe(429);
    expectHeaders(res);
    const retry = Number(res.headers.get("Retry-After"));
    expect(Number.isInteger(retry)).toBe(true);
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(retry).toBe(30); // proves the pinned limiter (30s into the window) is in use
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfterSeconds: retry });

    withSession();
    expect((await GET(req("ca"))).status).toBe(200);
    expect(fakeStore.setCalls).toBe(0);
  });

  test("anon (no cookie) shares one bucket: 429 after 120", async () => {
    for (let i = 0; i < 120; i++) {
      const res = await GET(req("ca"));
      if (res.status !== 200) throw new Error(`unexpected ${res.status} at call ${i + 1}`);
    }
    expect((await GET(req("ca"))).status).toBe(429);
    expect(fakeStore.setCalls).toBe(0);
  });

  test("forged cookie values are bucketed as anon", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, "*");
    for (let i = 0; i < 120; i++) await GET(req("ca"));
    fakeStore.jar.set(SESSION_COOKIE_NAME, "not-a-uuid");
    expect((await GET(req("ca"))).status).toBe(429);
  });
});
