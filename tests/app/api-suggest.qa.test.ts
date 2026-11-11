import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// QA adversarial tests for T53 (GET /api/search/suggest).
// Part 1 calls the exported route `GET` with `new Request(...)`; `next/headers`
// is mocked process-wide (before any import that can reach it) and the fake
// store records every set()/delete(). Real search service + limiter over a
// seeded in-memory DB.
// Part 2 drives `createSuggestHandler` with spies (limiter untouched for
// empty q, href allowlist, unstable_rethrow of hand-built Next digests).
// ---------------------------------------------------------------------------

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  writes = 0;
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(): void {
    this.writes += 1;
  }
  delete(): void {
    this.writes += 1;
  }
}

let fakeStore = new FakeCookieStore();
mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

type Suggestion = import("@/server/catalog/search-service").Suggestion;
type SuggestDeps = import("@/app/api/search/suggest/_lib/suggest").SuggestDeps;
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;

const route = await import("@/app/api/search/suggest/route");
const { GET } = route;
const lib = await import("@/app/api/search/suggest/_lib/suggest");
const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { createRateLimiter } = await import("@/server/security/rate-limiter");

const appGlobals = globalThis as typeof globalThis & {
  __storefrontSearchService?: unknown;
  __storefrontRateLimiter?: { db: unknown; limiter: unknown };
};
// Fixed limiter clock (mid-window) so 3000+ real calls never straddle a
// fixed-window boundary. Installed through getRateLimiter()'s own cache.
const FIXED_NOW = Date.parse("2026-11-07T12:00:30.000Z");
function pinLimiterClock(): void {
  const db = getDatabase();
  appGlobals.__storefrontRateLimiter = { db, limiter: createRateLimiter(db, { now: () => FIXED_NOW }) };
}
function resetSingletons(): void {
  appGlobals.__storefrontSearchService = undefined;
  appGlobals.__storefrontRateLimiter = undefined;
}

beforeAll(() => {
  closeDatabase();
  resetSingletons();
  seedDatabase(getDatabase());
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
  pinLimiterClock();
});

const BASE = "http://localhost:3000/api/search/suggest";
const enc = (q: string): Request => {
  // URLSearchParams turns lone surrogates into U+FFFD instead of throwing.
  const url = new URL(BASE);
  url.searchParams.set("q", q);
  return new Request(url);
};
const raw = (qs: string): Request => new Request(`${BASE}?${qs}`);

function expectBaseHeaders(res: Response): void {
  expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  expect(res.headers.get("Vary")).toBe("Cookie");
}

function expectSafeSuggestions(body: unknown): readonly { type: string; label: string; href: string }[] {
  const list = (body as { suggestions?: unknown }).suggestions;
  expect(Array.isArray(list)).toBe(true);
  const items = list as { type: string; label: string; href: string }[];
  expect(items.length).toBeLessThanOrEqual(8);
  for (const s of items) {
    expect(Object.keys(s).sort()).toEqual(["href", "label", "type"]);
    expect(typeof s.label).toBe("string");
    expect(s.href).toMatch(/^\/(products|category|brand)\/[a-z0-9-]+$/);
  }
  return items;
}

function rateLimitRows(): number {
  return (getDatabase().query("SELECT COUNT(*) AS n FROM rate_limits").get() as { n: number }).n;
}

function withSession(id: string = crypto.randomUUID()): string {
  fakeStore.jar.set(SESSION_COOKIE_NAME, id);
  return id;
}

// ---------------------------------------------------------------------------
// Part 1: route
// ---------------------------------------------------------------------------

describe("T53 route module", () => {
  test("exports only GET (an async function)", () => {
    expect(Object.keys(route)).toEqual(["GET"]);
    expect(GET.constructor.name).toBe("AsyncFunction");
  });
});

describe("T53 hostile q values: 200/400, never 500", () => {
  const encoded: readonly string[] = [
    '"',
    '""',
    '"unterminated',
    "*",
    "**",
    "ca*",
    "*ca",
    "^ca",
    "ca^2",
    "NEAR(ca to)",
    "ca NEAR to",
    "ca AND",
    "OR ca",
    "NOT ca",
    "ca NOT",
    "AND OR NOT",
    "(ca",
    "ca)",
    "((()))",
    "name:ca",
    "{name brand}:ca",
    "- ca",
    "-ca",
    "+ca",
    "ca OR 1=1",
    "'; DROP TABLE products; --",
    "products_fts MATCH 'x'",
    "\u0000\u0000",
    "ca\u0000ba",
    "\u0001\u0002\u0003\u001f",
    "\u007f\u007f",
    "​​",
    "‮ca",
    "﻿ca",
    "ca ba",
    "😀😀",
    "👨‍👩‍👧‍👦",
    "\ud800\ud800",
    "\udfff\ud800",
    "çå",
    "ＣＡＮ",
    "ﬁ",
    "ß",
    "Ⅻ",
    "日本",
    "مرحبا",
    "<script>alert(1)</script>",
    "javascript:alert(1)",
    "//evil.com",
    "\\\\evil",
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "%00",
    "%2525",
    "../../etc/passwd",
    "\r\n\r\nSet-Cookie: x=1",
    "a".repeat(100),
    "ab ".repeat(33),
    "a b c d e f g h i j k l m n o p",
    "a".repeat(101),
    "😀".repeat(100),
    "😀".repeat(101),
    "x".repeat(10_000),
    " ".repeat(500),
  ];
  const rawQs: readonly string[] = [
    "q=%00",
    "q=%00%00",
    "q=ca%00",
    "q=%",
    "q=%%",
    "q=%zz",
    "q=%E0%A4%A",
    "q=%C0%AF%C0%AF",
    "q=%ED%A0%80%ED%A0%80",
    "q=%FF%FE",
    "q=ca&q=",
    "q=&q=ca",
    "q[]=ca",
    "q=ca%26q%3D",
    "q=+++",
    "q=c+a",
    "Q=ca",
    "q",
    "q=%25",
    "__proto__=ca&q=ca",
    "q=__proto__",
    "q=%5F%5Fproto%5F%5F",
  ];

  test(`${encoded.length + rawQs.length} hostile values`, async () => {
    expect(encoded.length + rawQs.length).toBeGreaterThanOrEqual(60);
    withSession();
    const requests = [...encoded.map(enc), ...rawQs.map(raw)];
    for (const [i, r] of requests.entries()) {
      getDatabase().run("DELETE FROM rate_limits");
      const res = await GET(r);
      const label = `case ${i}: ${r.url.slice(0, 120)}`;
      expect([200, 400], label).toContain(res.status);
      expectBaseHeaders(res);
      const body: unknown = await res.json();
      if (res.status === 400) expect(body, label).toEqual({ error: "query_too_long" });
      else expectSafeSuggestions(body);
    }
    expect(fakeStore.writes).toBe(0);
  });

  test("length boundary is code points: 100 emoji ok, 101 emoji 400", async () => {
    expect((await GET(enc("😀".repeat(100)))).status).toBe(200);
    expect((await GET(enc("😀".repeat(101)))).status).toBe(400);
    expect((await GET(enc(`${"a".repeat(99)}😀`))).status).toBe(200);
  });

  test("labels are plain JSON strings: response body is parseable JSON with no raw HTML injection path", async () => {
    withSession();
    const res = await GET(enc("ca"));
    const text = await res.text();
    expect(() => JSON.parse(text) as unknown).not.toThrow();
    expectSafeSuggestions(JSON.parse(text) as unknown);
  });
});

describe("T53 status / header table", () => {
  test("200 empty, 400 query_too_long, 429 rate_limited + Retry-After all carry base headers", async () => {
    const empty = await GET(new Request(BASE));
    expect(empty.status).toBe(200);
    expectBaseHeaders(empty);
    expect(empty.headers.get("Set-Cookie")).toBeNull();

    const long = await GET(enc("q".repeat(101)));
    expect(long.status).toBe(400);
    expectBaseHeaders(long);
    expect(await long.json()).toEqual({ error: "query_too_long" });

    withSession();
    for (let i = 0; i < 120; i += 1) expect((await GET(enc("ca"))).status).toBe(200);
    const limited = await GET(enc("ca"));
    expect(limited.status).toBe(429);
    expectBaseHeaders(limited);
    const retry = limited.headers.get("Retry-After");
    expect(retry).toMatch(/^[1-9][0-9]*$/);
    expect(Number(retry)).toBe(30); // pinned clock: 30 s left in the window
    const body = (await limited.json()) as { error: string; retryAfterSeconds: number };
    expect(body).toEqual({ error: "rate_limited", retryAfterSeconds: Number(retry) });
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    test(`${method} through GET handler -> 405 + Allow: GET, base headers, no limiter use`, async () => {
      const init: RequestInit = method === "POST" || method === "PUT" || method === "PATCH" ? { method, body: "q=ca" } : { method };
      const res = await GET(new Request(`${BASE}?q=ca`, init));
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
      expectBaseHeaders(res);
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
      expect(rateLimitRows()).toBe(0);
    });
  }
});

describe("T53 rate limiting", () => {
  test("121st call per session -> 429; anon bucket and other sessions separate", async () => {
    const a = withSession();
    for (let i = 0; i < 120; i += 1) expect((await GET(enc("ca"))).status).toBe(200);
    expect((await GET(enc("ca"))).status).toBe(429);
    expect((await GET(enc("de"))).status).toBe(429); // different q, same session
    expect(a).toBeTruthy();

    fakeStore = new FakeCookieStore(); // anon
    expect((await GET(enc("ca"))).status).toBe(200);
    withSession();
    expect((await GET(enc("ca"))).status).toBe(200);
  });

  test("anon: 120 ok then 429; forged cookie values share the anon bucket", async () => {
    for (let i = 0; i < 120; i += 1) expect((await GET(enc("ca"))).status).toBe(200);
    expect((await GET(enc("ca"))).status).toBe(429);
    for (const forged of ["*", "anon", "x".repeat(4000), "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"]) {
      fakeStore = new FakeCookieStore();
      fakeStore.jar.set(SESSION_COOKIE_NAME, forged);
      expect((await GET(enc("ca"))).status).toBe(429);
    }
    expect(fakeStore.writes).toBe(0);
  });

  test("global 3000/min trips across sessions (26 sessions x <=120)", async () => {
    let ok = 0;
    for (let s = 0; s < 25; s += 1) {
      withSession();
      for (let i = 0; i < 120; i += 1) {
        const res = await GET(enc("ca"));
        if (res.status === 200) ok += 1;
      }
    }
    expect(ok).toBe(3000);
    withSession(); // fresh session with an empty per-session bucket
    const res = await GET(enc("ca"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^[1-9][0-9]*$/);
    fakeStore = new FakeCookieStore();
    expect((await GET(enc("ca"))).status).toBe(429); // anon also blocked by the backstop
  }, 60_000);

  test("empty / whitespace / 1-char / too-long never touch the limiter (rate_limits stays empty)", async () => {
    withSession();
    for (const r of [new Request(BASE), enc(""), enc(" "), enc("a"), enc(" a "), enc("😀"), enc("x".repeat(500)), raw("q=%00")]) {
      await GET(r);
    }
    expect(rateLimitRows()).toBe(0);
  });

  test("an exhausted bucket still answers empty/1-char with 200 []", async () => {
    withSession();
    for (let i = 0; i < 121; i += 1) await GET(enc("ca"));
    const res = await GET(enc("a"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
  });
});

describe("T53 cookies and data/", () => {
  test("no cookie writes on any path (no cookie, valid, garbage, 429)", async () => {
    for (const cookie of [null, crypto.randomUUID(), "garbage", ""]) {
      fakeStore = new FakeCookieStore();
      if (cookie !== null) fakeStore.jar.set(SESSION_COOKIE_NAME, cookie);
      for (const r of [enc("ca"), enc("a"), enc("x".repeat(200)), new Request(`${BASE}?q=ca`, { method: "DELETE" })]) {
        const res = await GET(r);
        expect(res.headers.get("Set-Cookie")).toBeNull();
      }
      expect(fakeStore.writes).toBe(0);
    }
  });

  test("DATABASE_PATH is :memory: (data/ untouched by this file)", () => {
    expect(env.DATABASE_PATH).toBe(":memory:");
  });
});

// ---------------------------------------------------------------------------
// Part 2: handler with spies
// ---------------------------------------------------------------------------

function deps(overrides: Partial<SuggestDeps> = {}) {
  const spy = { getLimiter: 0, limit: 0, read: 0, suggest: 0, logs: [] as string[] };
  const d: SuggestDeps = {
    suggest: () => {
      spy.suggest += 1;
      return [];
    },
    getLimiter: () => {
      spy.getLimiter += 1;
      return { check: () => ({ ok: true, value: { remaining: 1 } }) } as RateLimiter;
    },
    limit: () => {
      spy.limit += 1;
      return { ok: true, value: { remaining: 1 } };
    },
    readSessionId: async () => {
      spy.read += 1;
      return null;
    },
    logger: { error: (...args: unknown[]) => void spy.logs.push(args.map(String).join(" ")) },
    ...overrides,
  };
  return { d, spy };
}

describe("T53 handler: limiter untouched for empty input", () => {
  test("missing/empty/1-char/too-long -> no getLimiter, no limit, no readSessionId, no suggest", async () => {
    const { d, spy } = deps();
    const h = lib.createSuggestHandler(d);
    for (const r of [new Request(BASE), enc(""), enc("  "), enc("z"), enc("é"), enc("x".repeat(101))]) await h(r);
    expect(spy).toEqual({ getLimiter: 0, limit: 0, read: 0, suggest: 0, logs: [] });
  });
});

describe("T53 handler: href allowlist and cap", () => {
  const bad: readonly string[] = [
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "\\/evil.com",
    "https://evil.com",
    "http:/evil.com",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>",
    "vbscript:x",
    "mailto:a@b",
    " /products/x",
    "products/x",
    "",
    "/\t/evil.com",
    "/\n/evil.com",
    "/\r/evil.com",
    "/products/x\u0000",
    "/\u007f",
    "/" + "a".repeat(3000),
  ];
  test("every hostile href is dropped", async () => {
    const items: Suggestion[] = bad.map((href) => ({ type: "product", label: "x", href }));
    const { d } = deps({ suggest: () => items });
    const res = await lib.createSuggestHandler(d)(enc("ca"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
  });

  test("C1 control characters (U+0080..U+009F) in href are rejected", () => {
    expect(lib.isInternalHref("/products/x\u0085")).toBe(false);
    expect(lib.isInternalHref("/\u009b/x")).toBe(false);
  });

  test("non-string / malformed entries dropped; extra fields stripped; capped at 8 even if service returns 50", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ type: "product", label: `p${i}`, href: `/products/p${i}`, evil: "<x>" }));
    const junk: unknown[] = [null, 1, "x", [], { type: "user", label: "a", href: "/a" }, { type: "brand", label: "", href: "/a" }, { type: "brand", label: 5, href: "/a" }, { type: "brand", label: "a", href: { toString: () => "/a" } }];
    const { d } = deps({ suggest: () => [...junk, ...many] as unknown as Suggestion[] });
    const res = await lib.createSuggestHandler(d)(enc("ca"));
    const body = (await res.json()) as { suggestions: Record<string, unknown>[] };
    expect(body.suggestions).toHaveLength(8);
    for (const s of body.suggestions) expect(Object.keys(s).sort()).toEqual(["href", "label", "type"]);
  });

  test("service returning a non-array -> 200 []", async () => {
    const { d } = deps({ suggest: () => ({ length: 3 }) as unknown as Suggestion[] });
    const res = await lib.createSuggestHandler(d)(enc("ca"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [] });
  });
});

describe("T53 handler: unstable_rethrow first in the catch", () => {
  const digests: readonly string[] = [
    "NEXT_REDIRECT;replace;/elsewhere;307;",
    "NEXT_REDIRECT;push;/x;303;",
    "NEXT_HTTP_ERROR_FALLBACK;404",
    "NEXT_HTTP_ERROR_FALLBACK;403",
    "DYNAMIC_SERVER_USAGE",
    "BAILOUT_TO_CLIENT_SIDE_RENDERING",
  ];
  for (const digest of digests) {
    for (const where of ["readSessionId", "limit", "suggest"] as const) {
      test(`${digest} thrown from ${where} propagates and is not logged`, async () => {
        const err = Object.assign(new Error(digest), { digest });
        const overrides: Partial<SuggestDeps> =
          where === "readSessionId"
            ? { readSessionId: async () => Promise.reject(err) }
            : where === "limit"
              ? {
                  limit: () => {
                    throw err;
                  },
                }
              : {
                  suggest: () => {
                    throw err;
                  },
                };
        const { d, spy } = deps(overrides);
        let caught: unknown = null;
        try {
          await lib.createSuggestHandler(d)(enc("ca"));
        } catch (e) {
          caught = e;
        }
        expect(caught).toBe(err);
        expect(spy.logs).toEqual([]);
      });
    }
  }

  test("a non-Next error with a look-alike digest -> 500 internal, log has no query", async () => {
    const q = "secretquery";
    const err = Object.assign(new Error(`boom ${q}`), { digest: "NEXT_REDIRECT;bogus" });
    const { d, spy } = deps({
      suggest: () => {
        throw err;
      },
    });
    const res = await lib.createSuggestHandler(d)(enc(q));
    expect(res.status).toBe(500);
    expectBaseHeaders(res);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(spy.logs).toHaveLength(1);
    expect(spy.logs[0]).not.toContain(q);
  });
});
