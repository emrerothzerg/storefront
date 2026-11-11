import { describe, expect, test } from "bun:test";
import { fail, ok } from "@/lib/result";
import type { Suggestion } from "@/server/catalog/search-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { createRateLimiter, limitAction, type RateLimiter } from "@/server/security/rate-limiter";

import {
  BASE_HEADERS,
  DEFAULT_RETRY_AFTER_SECONDS,
  createSuggestHandler,
  isInternalHref,
  jsonResponse,
  methodNotAllowedResponse,
  parseQuery,
  sanitizeSuggestions,
  type SuggestDeps,
} from "./suggest";

const BASE = "http://localhost:3000/api/search/suggest";
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function url(q: string): string {
  return `${BASE}?q=${encodeURIComponent(q)}`;
}

function expectBaseHeaders(res: Response): void {
  for (const [k, v] of Object.entries(BASE_HEADERS)) expect(res.headers.get(k)).toBe(v);
}

const okLimiter: RateLimiter = { check: () => ok({ remaining: 1 }) };

function deps(overrides: Partial<SuggestDeps> = {}): SuggestDeps & { logs: string[]; suggestCalls: string[] } {
  const logs: string[] = [];
  const suggestCalls: string[] = [];
  return {
    logs,
    suggestCalls,
    suggest: (q) => {
      suggestCalls.push(q);
      return [{ type: "product", label: "Canvas Tote Bag", href: "/products/canvas-tote-bag" }];
    },
    getLimiter: () => okLimiter,
    limit: (limiter, sessionId) => limitAction(limiter, "search.suggest", sessionId),
    readSessionId: async () => SESSION,
    logger: { error: (m: string) => void logs.push(m) },
    ...overrides,
  };
}

describe("parseQuery", () => {
  test("missing, empty, whitespace and 1-char are empty", () => {
    expect(parseQuery(BASE)).toEqual({ kind: "empty" });
    expect(parseQuery(`${BASE}?q=`)).toEqual({ kind: "empty" });
    expect(parseQuery(url("   \t "))).toEqual({ kind: "empty" });
    expect(parseQuery(url("a"))).toEqual({ kind: "empty" });
    expect(parseQuery(url(" a "))).toEqual({ kind: "empty" });
    expect(parseQuery(url("😀"))).toEqual({ kind: "empty" }); // 1 code point, 2 code units
  });

  test("2+ chars is a trimmed query; first q wins", () => {
    expect(parseQuery(url("  ca "))).toEqual({ kind: "query", q: "ca" });
    expect(parseQuery(`${BASE}?q=ab&q=zz`)).toEqual({ kind: "query", q: "ab" });
  });

  test("100 code points ok, 101 too long, 10k too long", () => {
    expect(parseQuery(url("a".repeat(100))).kind).toBe("query");
    expect(parseQuery(url("😀".repeat(100))).kind).toBe("query");
    expect(parseQuery(url("a".repeat(101)))).toEqual({ kind: "too_long" });
    expect(parseQuery(url("😀".repeat(101)))).toEqual({ kind: "too_long" });
    expect(parseQuery(url("x".repeat(10_000)))).toEqual({ kind: "too_long" });
  });

  test("malformed percent-encoding does not throw", () => {
    expect(() => parseQuery(`${BASE}?q=%E0%A4%A`)).not.toThrow();
    expect(parseQuery(`${BASE}?q=%00%00`).kind).toBe("query");
  });
});

describe("isInternalHref / sanitizeSuggestions", () => {
  test("allowlist", () => {
    expect(isInternalHref("/products/x")).toBe(true);
    for (const bad of [
      "//evil.com",
      "/\\evil.com",
      "https://evil.com",
      "javascript:alert(1)",
      "products/x",
      "",
      "/a\u0000b",
      "/a\nb",
      42,
      null,
    ]) {
      expect(isInternalHref(bad)).toBe(false);
    }
  });

  test("C0, DEL and C1 control characters are rejected", () => {
    for (const cp of [0x00, 0x09, 0x1f, 0x7f, 0x80, 0x85, 0x9b, 0x9f]) {
      expect(isInternalHref(`/products/a${String.fromCharCode(cp)}b`)).toBe(false);
    }
    expect(isInternalHref("/products/a\u00a0b")).toBe(true); // U+00A0 is not a control
    expect(isInternalHref("/products/caf%C3%A9")).toBe(true);
  });

  test("filters bad entries, strips extra fields, caps at 8", () => {
    const good = (i: number) => ({ type: "product", label: `P${i}`, href: `/products/p${i}`, extra: "x" });
    const input: unknown[] = [
      { type: "product", label: "Evil", href: "//evil.com" },
      { type: "product", label: "Evil2", href: "https://evil.com" },
      { type: "weird", label: "W", href: "/w" },
      { type: "brand", label: 5, href: "/brand/x" },
      { type: "brand", label: "", href: "/brand/x" },
      null,
      "str",
      ...Array.from({ length: 12 }, (_, i) => good(i)),
    ];
    const out = sanitizeSuggestions(input);
    expect(out).toHaveLength(8);
    expect(out[0]).toEqual({ type: "product", label: "P0", href: "/products/p0" });
    expect(sanitizeSuggestions("nope")).toEqual([]);
  });
});

describe("response builders", () => {
  test("jsonResponse sets base headers and JSON body", async () => {
    const res = jsonResponse(200, { suggestions: [] });
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    expect(await res.json()).toEqual({ suggestions: [] });
  });

  test("405 with Allow: GET", async () => {
    const res = methodNotAllowedResponse();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
    expectBaseHeaders(res);
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });
});

describe("createSuggestHandler", () => {
  test("non-GET request -> 405", async () => {
    const res = await createSuggestHandler(deps())(new Request(url("ca"), { method: "POST" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET");
  });

  test("empty / too long never hit limiter or service", async () => {
    let limiterCalls = 0;
    const d = deps({
      getLimiter: () => {
        limiterCalls += 1;
        return okLimiter;
      },
    });
    const h = createSuggestHandler(d);
    const empty = await h(new Request(url("a")));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ suggestions: [] });
    const long = await h(new Request(url("a".repeat(101))));
    expect(long.status).toBe(400);
    expectBaseHeaders(long);
    expect(await long.json()).toEqual({ error: "query_too_long" });
    expect(limiterCalls).toBe(0);
    expect(d.suggestCalls).toEqual([]);
  });

  test("success returns sanitised suggestions", async () => {
    const d = deps({
      suggest: (): readonly Suggestion[] => [
        { type: "product", label: "<b>x</b>", href: "/products/x" },
        { type: "brand", label: "Evil", href: "//evil.com" },
      ],
    });
    const res = await createSuggestHandler(d)(new Request(url("ca")));
    expect(res.status).toBe(200);
    expectBaseHeaders(res);
    expect(await res.json()).toEqual({ suggestions: [{ type: "product", label: "<b>x</b>", href: "/products/x" }] });
  });

  test("rate limited -> 429 with Retry-After, service not called", async () => {
    const d = deps({
      getLimiter: () => ({ check: () => fail("RATE_LIMITED", "slow down", { retryAfterSeconds: 17 }) }),
    });
    const res = await createSuggestHandler(d)(new Request(url("ca")));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
    expectBaseHeaders(res);
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfterSeconds: 17 });
    expect(d.suggestCalls).toEqual([]);
  });

  test("rate limited without usable retryAfter falls back to default", async () => {
    const d = deps({ getLimiter: () => ({ check: () => fail("RATE_LIMITED", "x", { retryAfterSeconds: "soon" }) }) });
    const res = await createSuggestHandler(d)(new Request(url("ca")));
    expect(res.headers.get("Retry-After")).toBe(String(DEFAULT_RETRY_AFTER_SECONDS));
  });

  test("thrown error -> 500 internal, log has no query", async () => {
    const secret = "secretquery123";
    const d = deps({
      suggest: () => {
        throw new Error(`boom ${secret}`);
      },
    });
    const res = await createSuggestHandler(d)(new Request(url(secret)));
    expect(res.status).toBe(500);
    expectBaseHeaders(res);
    expect(await res.json()).toEqual({ error: "internal" });
    expect(d.logs).toHaveLength(1);
    expect(d.logs[0]).not.toContain(secret);
  });

  test("session read failure and limiter throw -> 500; throwing logger still 500", async () => {
    const h1 = createSuggestHandler(deps({ readSessionId: () => Promise.reject(new TypeError("x")) }));
    expect((await h1(new Request(url("ca")))).status).toBe(500);
    const h2 = createSuggestHandler(
      deps({
        getLimiter: () => {
          throw new Error("db");
        },
        logger: {
          error: () => {
            throw new Error("log down");
          },
        },
      }),
    );
    expect((await h2(new Request(url("ca")))).status).toBe(500);
  });

  test("non-RATE_LIMITED limiter failure -> 500", async () => {
    const d = deps({ getLimiter: () => ({ check: () => fail("INVALID_INPUT", "x") }) });
    expect((await createSuggestHandler(d)(new Request(url("ca")))).status).toBe(500);
  });

  test("Next control-flow errors are rethrown (unstable_rethrow)", async () => {
    // Built by hand (same digest shape as next/navigation's redirect()/notFound())
    // because other test files mock `redirect` process-wide.
    const controlFlow = [
      Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/elsewhere;307;" }),
      Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }),
    ];
    for (const thrown of controlFlow) {
      const d = deps({ readSessionId: () => Promise.reject(thrown) });
      let caught: unknown;
      try {
        await createSuggestHandler(d)(new Request(url("ca")));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(thrown);
      expect(d.logs).toEqual([]);
    }
  });

  test("real limiter rules on :memory:: per-session 120/min then 429", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const limiter = createRateLimiter(db, { now: () => 1_700_000_010_000 });
    const h = createSuggestHandler(deps({ getLimiter: () => limiter, suggest: () => [] }));
    for (let i = 0; i < 120; i++) expect((await h(new Request(url("ca")))).status).toBe(200);
    const res = await h(new Request(url("ca")));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
    db.close();
  });

  test("real limiter rules on :memory:: global backstop trips after 3000 calls across sessions", async () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const limiter = createRateLimiter(db, { now: () => 1_700_000_010_000 });
    let current: string | null = null;
    const h = createSuggestHandler(
      deps({ getLimiter: () => limiter, suggest: () => [], readSessionId: async () => current }),
    );
    // 30 sessions x 100 calls = 3000 admitted calls, each session under its 120 limit.
    for (let s = 0; s < 30; s++) {
      current = crypto.randomUUID();
      for (let i = 0; i < 100; i++) {
        const res = await h(new Request(url("ca")));
        if (res.status !== 200) throw new Error(`unexpected ${res.status} at session ${s} call ${i}`);
      }
    }
    current = crypto.randomUUID(); // fresh session, own budget untouched
    const tripped = await h(new Request(url("ca")));
    expect(tripped.status).toBe(429);
    expect(tripped.headers.get("Retry-After")).not.toBeNull();
    current = null; // anon is also blocked by the global key
    expect((await h(new Request(url("ca")))).status).toBe(429);
    db.close();
  });
});
