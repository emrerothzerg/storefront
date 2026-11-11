/**
 * QA adversarial tests for T08 (guest session cookie), src/server/session/session.ts.
 *
 * `mock.module` is process-wide in bun test, so the next/headers mock is
 * registered here, before the module under test is imported, and delegates to
 * per-test state (`currentCookies`). Each test installs exactly the store it needs.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface SetCall {
  readonly name: string;
  readonly value: string;
  readonly options: Readonly<Record<string, unknown>> | undefined;
}

class QaCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];
  getCalls = 0;

  get(name: string): { name: string; value: string } | undefined {
    this.getCalls += 1;
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options?: Readonly<Record<string, unknown>>): void {
    this.setCalls.push({ name, value, options });
    this.jar.set(name, value);
  }
}

/** What `cookies()` resolves to in the current test. `unknown` so tests can install broken stores. */
let currentCookies: () => unknown = () => store;
let store = new QaCookieStore();

mock.module("next/headers", () => ({
  cookies: async (): Promise<unknown> => currentCookies(),
}));

const { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, getOrCreateSessionId, isSessionId, readSessionId } =
  await import("@/server/session/session");

const env = process.env as Record<string, string | undefined>;
const originalNodeEnv = env.NODE_ENV;

const VALID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

beforeEach(() => {
  store = new QaCookieStore();
  currentCookies = () => store;
});

afterEach(() => {
  if (originalNodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = originalNodeEnv;
});

describe("QA T08: mock sanity", () => {
  test("the QA next/headers mock is the one in effect", async () => {
    store.jar.set(SESSION_COOKIE_NAME, VALID);
    expect(await readSessionId()).toBe(VALID);
    expect(store.getCalls).toBeGreaterThan(0);
  });
});

describe("QA T08 AC1/AC4: adversarial cookie values", () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["valid UUID + NUL byte", `${VALID}\u0000`],
    ["NUL byte + valid UUID", `\u0000${VALID}`],
    ["valid UUID with NUL replacing last char", `${VALID.slice(0, 35)}\u0000`],
    ["mixed-case UUID", "3F2b8C1e-9A4d-4E6f-8B2a-1C3d5E7f9A0b"],
    ["all-uppercase UUID", VALID.toUpperCase()],
    ["36 chars, version nibble 0", "3f2b8c1e-9a4d-0e6f-8b2a-1c3d5e7f9a0b"],
    ["36 chars, version nibble 7", "3f2b8c1e-9a4d-7e6f-8b2a-1c3d5e7f9a0b"],
    ["36 chars, version nibble f", "3f2b8c1e-9a4d-fe6f-8b2a-1c3d5e7f9a0b"],
    ["36 chars, variant nibble 0", "3f2b8c1e-9a4d-4e6f-0b2a-1c3d5e7f9a0b"],
    ["36 chars, variant nibble 7", "3f2b8c1e-9a4d-4e6f-7b2a-1c3d5e7f9a0b"],
    ["36 chars, variant nibble c (Microsoft)", "3f2b8c1e-9a4d-4e6f-cb2a-1c3d5e7f9a0b"],
    ["36 chars, variant nibble f", "3f2b8c1e-9a4d-4e6f-fb2a-1c3d5e7f9a0b"],
    ["nil UUID", "00000000-0000-0000-0000-000000000000"],
    ["max UUID", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ["36 chars, hyphens moved", "3f2b8c1e9-a4d-4e6f-8b2a-1c3d5e7f9a0b"],
    ["36 chars, non-hex g", "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0g"],
    ["36 chars, fullwidth digit", `${VALID.slice(0, 35)}０`],
    ["36 chars, SQL", "' OR '1'='1' --  aaaaaaaaaaaaaaaaaaa"],
    ["36 chars, traversal", "../../../../../../../../etc/passwd.."],
    ["UUID with trailing CRLF", `${VALID}\r\n`],
    ["UUID wrapped in quotes", `"${VALID}"`],
    ["URL-encoded UUID", encodeURIComponent(`${VALID};`)],
    ["UUID; second cookie", `${VALID}; sf_session=${VALID}`],
    ["empty", ""],
    ["single space", " "],
    ["1 MB string", "a".repeat(1_000_000)],
    ["1 MB of valid UUIDs", VALID.repeat(30_000)],
  ];

  for (const [label, value] of cases) {
    test(`readSessionId -> null, no set, no throw: ${label}`, async () => {
      store.jar.set(SESSION_COOKIE_NAME, value);
      await expect(readSessionId()).resolves.toBeNull();
      expect(store.setCalls).toHaveLength(0);
    });

    test(`getOrCreateSessionId replaces with a fresh v4 id: ${label}`, async () => {
      store.jar.set(SESSION_COOKIE_NAME, value);
      const id = await getOrCreateSessionId();
      expect(id).not.toBe(value);
      expect(isSessionId(id)).toBe(true);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(store.setCalls).toHaveLength(1);
      expect(store.setCalls[0]?.value).toBe(id);
      // The attacker string is never what gets returned to callers (repositories).
      expect(id.includes("\u0000")).toBe(false);
    });
  }

  test("1 MB cookie is rejected quickly (length check before regex)", async () => {
    store.jar.set(SESSION_COOKIE_NAME, "f".repeat(5_000_000));
    const start = performance.now();
    for (let i = 0; i < 1000; i++) await readSessionId();
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("mixed-case UUID is rejected (documented: canonical lowercase only)", () => {
    expect(isSessionId(VALID.toUpperCase())).toBe(false);
    expect(isSessionId(VALID)).toBe(true);
  });
});

describe("QA T08 AC1: broken cookie stores never make readSessionId throw", () => {
  const broken: ReadonlyArray<readonly [string, () => unknown]> = [
    ["cookies() resolves undefined", () => undefined],
    ["cookies() resolves null", () => null],
    ["store.get is undefined", () => ({ set: () => {} })],
    ["store.get returns undefined", () => ({ get: () => undefined, set: () => {} })],
    ["store.get returns null", () => ({ get: () => null, set: () => {} })],
    ["store.get returns {value: undefined}", () => ({ get: () => ({ name: SESSION_COOKIE_NAME }), set: () => {} })],
    ["store.get returns {value: number}", () => ({ get: () => ({ value: 42 }), set: () => {} })],
    ["store.get returns {value: String object}", () => ({ get: () => ({ value: new String(VALID) }), set: () => {} })],
    ["store.get returns {value: [uuid]}", () => ({ get: () => ({ value: [VALID] }), set: () => {} })],
    [
      "store.get throws",
      () => ({
        get: () => {
          throw new Error("boom");
        },
      }),
    ],
    [
      "cookies() throws synchronously",
      () => {
        throw new Error("outside request scope");
      },
    ],
    ["cookies() rejects", () => Promise.reject(new Error("rejected"))],
    [
      "value getter throws",
      () => ({
        get: () => ({
          get value(): string {
            throw new Error("getter");
          },
        }),
      }),
    ],
  ];

  for (const [label, factory] of broken) {
    test(`readSessionId -> null: ${label}`, async () => {
      currentCookies = factory;
      await expect(readSessionId()).resolves.toBeNull();
    });
  }
});

describe("QA T08: getOrCreateSessionId with broken stores (allowed to throw; documented behaviour)", () => {
  test("store.get undefined but set works: creates and sets a fresh id", async () => {
    const calls: SetCall[] = [];
    currentCookies = () => ({
      set: (name: string, value: string, options?: Record<string, unknown>) => calls.push({ name, value, options }),
    });
    const id = await getOrCreateSessionId();
    expect(isSessionId(id)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.value).toBe(id);
  });

  test("set throws (e.g. called from render): the promise rejects with the store's error", async () => {
    const renderError = new Error("Cookies can only be modified in a Server Action or Route Handler.");
    currentCookies = () => ({
      get: () => undefined,
      set: () => {
        throw renderError;
      },
    });
    await expect(getOrCreateSessionId()).rejects.toBe(renderError);
  });

  test("set throws but a valid cookie exists: returns it without calling set", async () => {
    let setCalled = false;
    currentCookies = () => ({
      get: () => ({ name: SESSION_COOKIE_NAME, value: VALID }),
      set: () => {
        setCalled = true;
        throw new Error("no");
      },
    });
    await expect(getOrCreateSessionId()).resolves.toBe(VALID);
    expect(setCalled).toBe(false);
  });

  test("cookies() resolves undefined: rejects with a TypeError (no id leaks out)", async () => {
    currentCookies = () => undefined;
    await expect(getOrCreateSessionId()).rejects.toBeInstanceOf(TypeError);
  });
});

describe("QA T08 AC2: creation and reuse", () => {
  test("uses crypto.randomUUID exactly once and returns its value", async () => {
    const fixed = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3" as const;
    const original = crypto.randomUUID.bind(crypto);
    const spy = mock(() => fixed);
    crypto.randomUUID = spy;
    try {
      expect(await getOrCreateSessionId()).toBe(fixed);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await getOrCreateSessionId()).toBe(fixed);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      crypto.randomUUID = original;
    }
    expect(store.setCalls).toHaveLength(1);
  });

  test("1000 sequential calls on one store: one id, one set", async () => {
    const first = await getOrCreateSessionId();
    for (let i = 0; i < 1000; i++) expect(await getOrCreateSessionId()).toBe(first);
    expect(store.setCalls).toHaveLength(1);
  });

  test("concurrent calls on a cookie-less request (observed behaviour)", async () => {
    const ids = await Promise.all([getOrCreateSessionId(), getOrCreateSessionId(), getOrCreateSessionId()]);
    for (const id of ids) expect(isSessionId(id)).toBe(true);
    // Observed: parallel calls in one cookie-less request each mint their own id
    // (3 distinct ids, 3 set() calls; last set wins). AC2 only covers a *second*
    // call carrying the cookie, so this is logged as questionable, not a defect.
    expect(store.setCalls).toHaveLength(new Set(ids).size);
    expect(ids).toContain(store.jar.get(SESSION_COOKIE_NAME) ?? "");
  });

  test("readSessionId never calls set across all paths", async () => {
    for (const v of [undefined, "", VALID, "garbage"]) {
      store = new QaCookieStore();
      if (v !== undefined) store.jar.set(SESSION_COOKIE_NAME, v);
      await readSessionId();
      expect(store.setCalls).toHaveLength(0);
    }
  });
});

describe("QA T08 AC3: cookie options object", () => {
  const expectedBase = {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  } as const;

  for (const [nodeEnv, secure] of [
    ["production", true],
    ["development", false],
    ["test", false],
    [undefined, false],
    ["PRODUCTION", false],
  ] as const) {
    test(`NODE_ENV=${String(nodeEnv)} -> secure ${secure}`, async () => {
      if (nodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = nodeEnv;
      await getOrCreateSessionId();
      const call = store.setCalls[0];
      expect(call?.name).toBe("sf_session");
      expect(call?.options).toEqual({ ...expectedBase, secure });
      expect(SESSION_MAX_AGE_SECONDS).toBe(2_592_000);
    });
  }

  test("no domain or expires attribute is set (host-only, max-age based)", async () => {
    await getOrCreateSessionId();
    const options = store.setCalls[0]?.options ?? {};
    expect("domain" in options).toBe(false);
    expect("expires" in options).toBe(false);
  });
});

describe("QA T08 AC5/AC6: static checks on the source", () => {
  const source = readFileSync(join(import.meta.dir, "../../src/server/session/session.ts"), "utf8");

  test("doc comment states getOrCreateSessionId must not be called from render", () => {
    const docBlock = source.slice(0, source.indexOf("export async function getOrCreateSessionId"));
    const lastDoc = docBlock.slice(docBlock.lastIndexOf("/**"));
    expect(lastDoc).toMatch(/MUST NOT be called from Server Component render/);
  });

  test("session module does not touch SQL, fs or paths", () => {
    expect(source).not.toMatch(/bun:sqlite|node:fs|node:path|from "fs"|from "path"|\.query\(|\.prepare\(/);
  });

  test("both exported entry points only return values that pass isSessionId", async () => {
    store.jar.set(SESSION_COOKIE_NAME, VALID);
    const read = await readSessionId();
    expect(read === null || isSessionId(read)).toBe(true);
    store = new QaCookieStore();
    expect(isSessionId(await getOrCreateSessionId())).toBe(true);
  });
});
