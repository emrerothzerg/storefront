import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Fake cookie store + next/headers mock.
// mock.module is process-wide in bun test, so it is registered here (before the
// module under test is imported) and the mock delegates to per-test state.
// ---------------------------------------------------------------------------

interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: boolean | "lax" | "strict" | "none";
  path?: string;
  maxAge?: number;
  secure?: boolean;
}

interface SetCall {
  name: string;
  value: string;
  options: CookieOptions | undefined;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options?: CookieOptions): void {
    this.setCalls.push({ name, value, options });
    this.jar.set(name, value);
  }
}

let fakeStore = new FakeCookieStore();
let cookiesThrows = false;
/** When set, the mocked cookies() rejects with this value instead of a plain Error. */
let cookiesError: unknown = undefined;

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => {
    if (cookiesError !== undefined) {
      throw cookiesError;
    }
    if (cookiesThrows) {
      throw new Error("`cookies` was called outside a request scope.");
    }
    return fakeStore;
  },
}));

// T119: readSessionId now does one users.owner_key lookup for a valid guest
// cookie (ruling R-1) and resolves sf_auth through the auth service, so the
// shared DB singleton must be in-memory for this file (never ./data).
const testEnv = process.env as Record<string, string | undefined>;
const originalDatabasePath = testEnv.DATABASE_PATH;
testEnv.DATABASE_PATH = ":memory:";

const { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, getOrCreateSessionId, isSessionId, readSessionId } =
  await import("./session");

// process.env.NODE_ENV is typed readonly by Next; mutate via an untyped view.
const env = process.env as Record<string, string | undefined>;
const originalNodeEnv = env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

const VALID_ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const GARBAGE: ReadonlyArray<[string, string]> = [
  ["empty string", ""],
  ["uppercase UUID", VALID_ID.toUpperCase()],
  ["UUID with trailing chars", `${VALID_ID}x`],
  ["UUID with leading space", ` ${VALID_ID}`],
  ["UUID with trailing newline", `${VALID_ID}\n`],
  ["UUID v1 (wrong version nibble)", "3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b"],
  ["UUID with bad variant", "3f2b8c1e-9a4d-4e6f-cb2a-1c3d5e7f9a0b"],
  ["UUID without hyphens", VALID_ID.replaceAll("-", "")],
  ["SQL injection", "' OR 1=1 --"],
  ["SQL appended to UUID", `${VALID_ID}'; DROP TABLE carts; --`],
  ["path traversal", "../../etc/passwd"],
  ["4096-char string", "a".repeat(4096)],
];

beforeEach(() => {
  fakeStore = new FakeCookieStore();
  cookiesThrows = false;
  cookiesError = undefined;
});

afterEach(() => {
  setNodeEnv(originalNodeEnv);
});

afterAll(() => {
  setNodeEnv(originalNodeEnv);
  // Note: bun's mock.restore() does not undo mock.module(); the next/headers
  // mock stays registered for the rest of this test process. It only affects
  // modules that import next/headers, and only this file mocks it.
  mock.restore();
});

describe("constants", () => {
  test("cookie name and 30-day max age", () => {
    expect(SESSION_COOKIE_NAME).toBe("sf_session");
    expect(SESSION_MAX_AGE_SECONDS).toBe(2_592_000);
  });
});

describe("isSessionId", () => {
  test("session.ts re-exports the guard from the next-free session-id.ts", async () => {
    const pure = await import("./session-id");
    expect(isSessionId).toBe(pure.isSessionId);
    const source = await Bun.file(new URL("./session-id.ts", import.meta.url)).text();
    expect(source).not.toMatch(/from\s+["']next/);
    expect(source).not.toMatch(/import\s*\(\s*["']next/);
  });

  test("accepts a canonical lowercase UUID v4", () => {
    expect(isSessionId(VALID_ID)).toBe(true);
    expect(isSessionId(crypto.randomUUID())).toBe(true);
  });

  test.each(GARBAGE)("rejects %s", (_label, value) => {
    expect(isSessionId(value)).toBe(false);
  });

  test("rejects a 10k-char string", () => {
    expect(isSessionId("f".repeat(10_000))).toBe(false);
    expect(isSessionId(VALID_ID + "0".repeat(10_000))).toBe(false);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["number", 42],
    ["boolean", true],
    ["object", { value: VALID_ID }],
    ["array", [VALID_ID]],
    ["String object", new String(VALID_ID)],
  ])("rejects non-string: %s", (_label, value: unknown) => {
    expect(isSessionId(value)).toBe(false);
  });
});

describe("readSessionId", () => {
  test("returns null when the cookie is absent", async () => {
    expect(await readSessionId()).toBeNull();
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("returns the id for a valid cookie", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, VALID_ID);
    expect(await readSessionId()).toBe(VALID_ID);
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test.each(GARBAGE)("returns null for %s and sets nothing", async (_label, value) => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, value);
    expect(await readSessionId()).toBeNull();
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("ignores a valid UUID stored under a different cookie name", async () => {
    fakeStore.jar.set("other", VALID_ID);
    expect(await readSessionId()).toBeNull();
  });

  test("returns null (does not throw) when cookies() throws", async () => {
    cookiesThrows = true;
    await expect(readSessionId()).resolves.toBeNull();
  });

  test("returns null for a plain Error carrying a non-Next digest", async () => {
    cookiesError = Object.assign(new Error("boom"), { digest: "SOMETHING_ELSE" });
    await expect(readSessionId()).resolves.toBeNull();
  });

  test("rethrows a Next redirect error (NEXT_REDIRECT digest)", async () => {
    // Built by hand rather than via redirect(): other test files mock
    // next/navigation's redirect process-wide. Format matches
    // next/dist/client/components/redirect.js: `NEXT_REDIRECT;<type>;<url>;<status>;`.
    const redirectError = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/elsewhere;307;",
    });
    cookiesError = redirectError;
    await expect(readSessionId()).rejects.toBe(redirectError);
  });

  test("rethrows a Next notFound error (NEXT_HTTP_ERROR_FALLBACK;404 digest)", async () => {
    const notFoundError = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    cookiesError = notFoundError;
    await expect(readSessionId()).rejects.toBe(notFoundError);
  });

  test("returns null for a malformed NEXT_REDIRECT digest (not a real redirect)", async () => {
    cookiesError = Object.assign(new Error("fake"), { digest: "NEXT_REDIRECT;bogus" });
    await expect(readSessionId()).resolves.toBeNull();
  });

  test("rethrows a prerender hanging-promise rejection (cacheComponents abort)", async () => {
    const hanging = Object.assign(new Error("During prerendering, `cookies()` rejects..."), {
      digest: "HANGING_PROMISE_REJECTION",
    });
    cookiesError = hanging;
    await expect(readSessionId()).rejects.toBe(hanging);
  });

  test("rethrows a prerender-interrupted error", async () => {
    const interrupted = Object.assign(new Error("prerender interrupted"), {
      digest: "NEXT_PRERENDER_INTERRUPTED",
    });
    cookiesError = interrupted;
    await expect(readSessionId()).rejects.toBe(interrupted);
  });

  test("rethrows a dynamic-usage bailout", async () => {
    const dynamic = Object.assign(new Error("Dynamic server usage: cookies"), {
      digest: "DYNAMIC_SERVER_USAGE",
    });
    cookiesError = dynamic;
    await expect(readSessionId()).rejects.toBe(dynamic);
  });

  test("getOrCreateSessionId propagates a Next-internal error without setting a cookie", async () => {
    const hanging = Object.assign(new Error("hanging"), { digest: "HANGING_PROMISE_REJECTION" });
    cookiesError = hanging;
    await expect(getOrCreateSessionId()).rejects.toBe(hanging);
    expect(fakeStore.setCalls).toHaveLength(0);
  });
});

describe("getOrCreateSessionId", () => {
  test("creates, sets and returns a crypto.randomUUID() id when no cookie exists", async () => {
    const fixed = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";
    const spy = mock(() => fixed as `${string}-${string}-${string}-${string}-${string}`);
    const original = crypto.randomUUID.bind(crypto);
    crypto.randomUUID = spy;
    try {
      const id = await getOrCreateSessionId();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(id).toBe(fixed);
      expect(fakeStore.setCalls).toHaveLength(1);
      expect(fakeStore.setCalls[0]?.name).toBe(SESSION_COOKIE_NAME);
      expect(fakeStore.setCalls[0]?.value).toBe(fixed);
    } finally {
      crypto.randomUUID = original;
    }
  });

  test("a second call with the issued cookie returns the same id without re-setting", async () => {
    const first = await getOrCreateSessionId();
    const second = await getOrCreateSessionId();
    expect(isSessionId(first)).toBe(true);
    expect(second).toBe(first);
    expect(fakeStore.setCalls).toHaveLength(1);
    expect(await readSessionId()).toBe(first);
  });

  test("returns an existing valid cookie unchanged", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, VALID_ID);
    expect(await getOrCreateSessionId()).toBe(VALID_ID);
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test.each(GARBAGE)("replaces %s with a fresh UUID", async (_label, value) => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, value);
    const id = await getOrCreateSessionId();
    expect(id).not.toBe(value);
    expect(isSessionId(id)).toBe(true);
    expect(fakeStore.setCalls).toHaveLength(1);
    expect(fakeStore.setCalls[0]?.value).toBe(id);
    expect(fakeStore.jar.get(SESSION_COOKIE_NAME)).toBe(id);
  });

  test("generates distinct ids for distinct visitors", async () => {
    const a = await getOrCreateSessionId();
    fakeStore = new FakeCookieStore();
    const b = await getOrCreateSessionId();
    expect(a).not.toBe(b);
  });

  test("cookie attributes (non-production): httpOnly, sameSite lax, path /, 30-day maxAge, not secure", async () => {
    setNodeEnv("development");
    await getOrCreateSessionId();
    const call = fakeStore.setCalls[0];
    if (call === undefined) throw new Error("expected a set() call");
    expect(call.options).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
      secure: false,
    });
  });

  test("cookie attributes (test env): not Secure", async () => {
    setNodeEnv("test");
    await getOrCreateSessionId();
    expect(fakeStore.setCalls[0]?.options?.secure).toBe(false);
  });

  test("cookie attributes (production): Secure", async () => {
    setNodeEnv("production");
    await getOrCreateSessionId();
    const call = fakeStore.setCalls[0];
    if (call === undefined) throw new Error("expected a set() call");
    expect(call.options).toEqual({
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
      secure: true,
    });
  });
});

// ===========================================================================
// T119: owner-key resolution, guest/auth cookie helpers.
// PLAN.md section 2a rows C-01..C-19 (readSessionId / getOrCreateSessionId /
// "DB opened?") and the helper side of section 2b (cookie attributes).
// readCurrentUser / requireUser columns live in current-user.test.ts.
// ===========================================================================

const {
  AUTH_COOKIE_MAX_AGE_SECONDS,
  AUTH_COOKIE_NAME,
  clearAuthCookie,
  readAuthToken,
  readGuestSessionId,
  rotateGuestSession,
  setAuthCookie,
} = await import("./session");
const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { createAuthRepository } = await import("@/server/auth/auth-repository");

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete testEnv.DATABASE_PATH;
  else testEnv.DATABASE_PATH = originalDatabasePath;
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TOMBSTONE = "00000000-0000-4000-8000-000000000000";

function sha256hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

interface Fixture {
  readonly userId: string;
  readonly ownerKey: string;
  readonly email: string;
  readonly displayName: string;
  readonly token: string;
  readonly authSessionId: string;
}

let fixtureCounter = 0;

/** Creates a user plus one auth session (token hashed exactly as T116 stores it). */
function createSignedInUser(options: { expiresAt?: number; issuedAt?: number } = {}): Fixture {
  const repo = createAuthRepository(getDatabase());
  fixtureCounter += 1;
  const email = `t119-${fixtureCounter}-${crypto.randomUUID()}@example.test`;
  const displayName = `User ${fixtureCounter}`;
  const created = repo.createUser({ email, passwordHash: "$argon2id$v=19$fixture", displayName });
  if (!created.ok) throw new Error(`fixture createUser failed: ${created.error.code}`);
  const token = newToken();
  const issuedAt = options.issuedAt ?? Date.now();
  const session = repo.createAuthSession(
    {
      userId: created.value.id,
      tokenHash: sha256hex(token),
      expiresAt: new Date(options.expiresAt ?? issuedAt + 30 * DAY_MS).toISOString(),
    },
    issuedAt,
  );
  if (!session.ok) throw new Error(`fixture createAuthSession failed: ${session.error.code}`);
  return {
    userId: created.value.id,
    ownerKey: created.value.ownerKey,
    email,
    displayName,
    token,
    authSessionId: session.value.id,
  };
}

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** Records every statement prepared on the shared DB and the params it is executed with. */
function spyQueries(): { readonly calls: QueryCall[]; restore: () => void } {
  const db = getDatabase();
  const calls: QueryCall[] = [];
  const originalQuery = db.query.bind(db);
  const originalPrepare = db.prepare.bind(db);
  const wrap = <S extends object>(sql: string, statement: S): S =>
    new Proxy(statement, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        if (property === "get" || property === "all" || property === "run" || property === "values" || property === "iterate") {
          return (...params: unknown[]) => {
            calls.push({ sql, params });
            return (value as (...args: unknown[]) => unknown).apply(target, params);
          };
        }
        return (value as (...args: unknown[]) => unknown).bind(target);
      },
    });
  const patched = db as unknown as Record<"query" | "prepare", (sql: string) => object>;
  patched.query = (sql: string) => wrap(sql, originalQuery(sql));
  patched.prepare = (sql: string) => wrap(sql, originalPrepare(sql));
  return {
    calls,
    restore: () => {
      delete (db as unknown as Record<string, unknown>).query;
      delete (db as unknown as Record<string, unknown>).prepare;
    },
  };
}

function authQueries(calls: readonly QueryCall[]): QueryCall[] {
  return calls.filter((call) => call.sql.includes("auth_sessions"));
}

const dbCache = globalThis as typeof globalThis & { __storefrontDb?: { readonly path: string } };

/**
 * Runs `fn` with DATABASE_PATH pointing at a scratch file. If anything calls
 * getDatabase() meanwhile, the cached path switches and the file is created,
 * both of which are asserted absent afterwards. Restores ":memory:".
 */
async function expectNoDatabaseOpen(fn: () => Promise<void>): Promise<void> {
  const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "t119-trap-"));
  const trapPath = join(dir, "trap.sqlite");
  const cachedBefore = dbCache.__storefrontDb?.path;
  testEnv.DATABASE_PATH = trapPath;
  try {
    await fn();
  } finally {
    testEnv.DATABASE_PATH = ":memory:";
  }
  const opened = dbCache.__storefrontDb?.path === trapPath || existsSync(trapPath);
  if (opened) closeDatabase();
  rmSync(dir, { recursive: true, force: true });
  expect(opened).toBe(false);
  expect(dbCache.__storefrontDb?.path).toBe(cachedBefore);
}

function setCookies(cookies: { guest?: string; auth?: string }): void {
  if (cookies.guest !== undefined) fakeStore.jar.set(SESSION_COOKIE_NAME, cookies.guest);
  if (cookies.auth !== undefined) fakeStore.jar.set(AUTH_COOKIE_NAME, cookies.auth);
}

/** No set call ever carries a user's owner key (PLAN 2a invariant). */
function expectNoOwnerKeyWritten(...ownerKeys: string[]): void {
  for (const call of fakeStore.setCalls) {
    for (const key of ownerKeys) expect(call.value).not.toBe(key);
  }
}

const GUEST = "6a1f0c2e-3b4d-4c5e-9f60-718293a4b5c6";
const FIXATION = "f1f2f3f4-a5a6-4b7b-8c8c-9d9d0e0e1f1f";

describe("T119 constants and exports", () => {
  test("auth cookie name and 30-day cap; session constants unchanged", () => {
    expect(AUTH_COOKIE_NAME).toBe("sf_auth");
    expect(AUTH_COOKIE_MAX_AGE_SECONDS).toBe(2_592_000);
    expect(SESSION_COOKIE_NAME).toBe("sf_session");
  });

  test("isSessionId is still the session-id.ts guard (AC9)", async () => {
    const pure = await import("./session-id");
    expect(isSessionId).toBe(pure.isSessionId);
  });
});

describe("T119 C-01..C-19: readSessionId / getOrCreateSessionId", () => {
  test("C-01 no cookies: read null; create mints exactly one sf_session; DB never opened", async () => {
    await expectNoDatabaseOpen(async () => {
      expect(await readSessionId()).toBeNull();
      expect(fakeStore.setCalls).toHaveLength(0);
      const id = await getOrCreateSessionId();
      expect(isSessionId(id)).toBe(true);
      expect(fakeStore.setCalls).toEqual([
        { name: SESSION_COOKIE_NAME, value: id, options: expect.objectContaining({ maxAge: SESSION_MAX_AGE_SECONDS }) },
      ]);
    });
  });

  test("C-02 valid guest cookie: returns G, create returns G with no set (one owner-key lookup, R-1)", async () => {
    setCookies({ guest: GUEST });
    const spy = spyQueries();
    try {
      expect(await readSessionId()).toBe(GUEST);
      expect(await getOrCreateSessionId()).toBe(GUEST);
    } finally {
      spy.restore();
    }
    expect(fakeStore.setCalls).toHaveLength(0);
    expect(authQueries(spy.calls)).toHaveLength(0);
    const ownerKeyLookups = spy.calls.filter((c) => c.sql.includes("owner_key = ?"));
    expect(ownerKeyLookups).toHaveLength(2); // one per call
    expect(ownerKeyLookups[0]?.params).toEqual([GUEST]);
  });

  test.each([
    ["abc", "abc"],
    ["upper-case UUID", GUEST.toUpperCase()],
    ["UUID v1", "6a1f0c2e-3b4d-1c5e-9f60-718293a4b5c6"],
    ["37 chars", `${GUEST}0`],
    ["4 KB", "a".repeat(4096)],
  ])("C-03 garbage guest cookie (%s): read null, create replaces it, DB never opened", async (_label, value) => {
    await expectNoDatabaseOpen(async () => {
      setCookies({ guest: value });
      expect(await readSessionId()).toBeNull();
      expect(fakeStore.setCalls).toHaveLength(0);
      const id = await getOrCreateSessionId();
      expect(id).not.toBe(value);
      expect(isSessionId(id)).toBe(true);
      expect(fakeStore.setCalls).toHaveLength(1);
      expect(fakeStore.jar.get(SESSION_COOKIE_NAME)).toBe(id);
    });
  });

  test("C-04 auth only: owner key; create writes no guest cookie (AC4)", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token });
    expect(await readSessionId()).toBe(a.ownerKey);
    expect(await getOrCreateSessionId()).toBe(a.ownerKey);
    expect(fakeStore.setCalls).toHaveLength(0);
    expect(fakeStore.jar.has(SESSION_COOKIE_NAME)).toBe(false);
  });

  test("C-05 auth + guest: owner key, never the guest id (AC2); nothing written", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token, guest: GUEST });
    expect(await readSessionId()).toBe(a.ownerKey);
    expect(await getOrCreateSessionId()).toBe(a.ownerKey);
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("C-06 expired sf_auth + guest: guest id; the expired cookie is not cleared (R-8)", async () => {
    const issuedAt = Date.now() - 2 * HOUR_MS;
    const a = createSignedInUser({ issuedAt, expiresAt: issuedAt + HOUR_MS });
    setCookies({ auth: a.token, guest: GUEST });
    expect(await readSessionId()).toBe(GUEST);
    expect(await getOrCreateSessionId()).toBe(GUEST);
    expect(fakeStore.setCalls).toHaveLength(0);
    expect(fakeStore.jar.get(AUTH_COOKIE_NAME)).toBe(a.token);
  });

  test("C-07 revoked sf_auth + guest: guest id, nothing written", async () => {
    const a = createSignedInUser();
    createAuthRepository(getDatabase()).revokeAuthSession(a.authSessionId);
    setCookies({ auth: a.token, guest: GUEST });
    expect(await readSessionId()).toBe(GUEST);
    expect(await getOrCreateSessionId()).toBe(GUEST);
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  const valid43 = newToken();
  const MALFORMED_AUTH: ReadonlyArray<[string, string]> = [
    ["42 chars", valid43.slice(0, 42)],
    ["44 chars", `${valid43}A`],
    ["'+' char", `${valid43.slice(0, 42)}+`],
    ["'/' char", `${valid43.slice(0, 42)}/`],
    ["'=' padding", `${valid43.slice(0, 42)}=`],
    ["empty string", ""],
    ["whitespace-padded 43", ` ${valid43.slice(0, 41)} `],
    ["'null' text", "null"],
    ["4096 chars (C-09)", "A".repeat(4096)],
    ["1 MiB (C-09)", "A".repeat(1024 * 1024)],
    ["43 x 'é' (C-10)", "é".repeat(43)],
    ["surrogate pair inside 43 units (C-10)", `${valid43.slice(0, 41)}\u{1F600}`],
    ["lone surrogate (C-10)", `${valid43.slice(0, 42)}\uD800`],
    ["RTL override (C-10)", `${valid43.slice(0, 42)}‮`],
    ["NUL inside 43 chars (C-10)", `${valid43.slice(0, 20)}\u0000${valid43.slice(21)}`],
  ];

  test.each(MALFORMED_AUTH)(
    "C-08/C-09/C-10 malformed sf_auth (%s) + guest: guest id, no auth query, raw value never bound",
    async (_label, value) => {
      setCookies({ auth: value, guest: GUEST });
      const spy = spyQueries();
      const start = performance.now();
      try {
        expect(await readSessionId()).toBe(GUEST);
        expect(await getOrCreateSessionId()).toBe(GUEST);
        expect(await readAuthToken()).toBeNull();
      } finally {
        spy.restore();
      }
      expect(performance.now() - start).toBeLessThan(50);
      expect(fakeStore.setCalls).toHaveLength(0);
      expect(authQueries(spy.calls)).toHaveLength(0);
      for (const call of spy.calls) expect(call.params).not.toContain(value);
    },
  );

  test.each(MALFORMED_AUTH)("C-08/C-09/C-10 malformed sf_auth (%s) alone: null and the DB is never opened", async (_label, value) => {
    await expectNoDatabaseOpen(async () => {
      setCookies({ auth: value });
      expect(await readSessionId()).toBeNull();
      expect(await readAuthToken()).toBeNull();
      expect(fakeStore.setCalls).toHaveLength(0);
    });
  });

  test("C-11 well-formed unknown sf_auth + guest: guest id; the lookup binds hash(T) only", async () => {
    const unknown = newToken();
    setCookies({ auth: unknown, guest: GUEST });
    const spy = spyQueries();
    try {
      expect(await readSessionId()).toBe(GUEST);
      expect(await getOrCreateSessionId()).toBe(GUEST);
    } finally {
      spy.restore();
    }
    expect(fakeStore.setCalls).toHaveLength(0);
    const lookups = authQueries(spy.calls);
    expect(lookups.length).toBeGreaterThanOrEqual(1);
    for (const call of spy.calls) {
      expect(call.params).not.toContain(unknown);
      for (const param of call.params) {
        if (typeof param === "string") expect(param.includes(unknown)).toBe(false);
      }
    }
    for (const call of lookups) expect(call.params).toContain(sha256hex(unknown));
  });

  test("C-12 sf_auth of a deleted user + guest: guest id (AC3)", async () => {
    const a = createSignedInUser();
    const deleted = createAuthRepository(getDatabase()).deleteUser(a.userId);
    expect(deleted.ok).toBe(true);
    setCookies({ auth: a.token, guest: GUEST });
    expect(await readSessionId()).toBe(GUEST);
    expect(await getOrCreateSessionId()).toBe(GUEST);
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("C-12b orphaned auth session row (user row gone, FK bypassed) + guest: guest id", async () => {
    const a = createSignedInUser();
    const db = getDatabase();
    db.run("PRAGMA foreign_keys = OFF");
    try {
      db.run("DELETE FROM users WHERE id = ?", [a.userId]);
    } finally {
      db.run("PRAGMA foreign_keys = ON");
    }
    setCookies({ auth: a.token, guest: GUEST });
    expect(await readSessionId()).toBe(GUEST);
    db.run("DELETE FROM auth_sessions WHERE id = ?", [a.authSessionId]);
  });

  test("C-13 sf_auth of a locked user: still the owner key (lock only blocks new sign-ins)", async () => {
    const a = createSignedInUser();
    const repo = createAuthRepository(getDatabase());
    let state = repo.recordLoginFailure(a.userId);
    for (let i = 1; i < 10; i++) state = repo.recordLoginFailure(a.userId);
    expect(state.lockedUntil).not.toBeNull();
    setCookies({ auth: a.token, guest: GUEST });
    expect(await readSessionId()).toBe(a.ownerKey);
    expect(await getOrCreateSessionId()).toBe(a.ownerKey);
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("C-14 fixation: attacker-chosen v4 guest id is returned as-is (rotation happens at sign-in)", async () => {
    setCookies({ guest: FIXATION });
    expect(await readSessionId()).toBe(FIXATION);
    expect(await getOrCreateSessionId()).toBe(FIXATION);
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("C-15 sf_session = a user's owner key: read null; create replaces it with a fresh id (R-1)", async () => {
    const a = createSignedInUser();
    setCookies({ guest: a.ownerKey });
    expect(await readSessionId()).toBeNull();
    expect(await readGuestSessionId()).toBeNull();
    expect(fakeStore.setCalls).toHaveLength(0);
    const id = await getOrCreateSessionId();
    expect(id).not.toBe(a.ownerKey);
    expect(isSessionId(id)).toBe(true);
    expect(fakeStore.setCalls).toHaveLength(1);
    expect(fakeStore.jar.get(SESSION_COOKIE_NAME)).toBe(id);
    expectNoOwnerKeyWritten(a.ownerKey);
  });

  test("C-15 also applies after sign-out-everywhere: a revoked user's owner key as guest cookie is still rejected", async () => {
    const a = createSignedInUser();
    createAuthRepository(getDatabase()).revokeAllForUser(a.userId);
    setCookies({ guest: a.ownerKey, auth: a.token });
    expect(await readSessionId()).toBeNull();
  });

  test("C-15 tombstone owner key in sf_session is treated like any guest id (resolves to no user)", async () => {
    setCookies({ guest: TOMBSTONE });
    expect(isSessionId(TOMBSTONE)).toBe(true);
    expect(await readSessionId()).toBe(TOMBSTONE);
    expect(await readGuestSessionId()).toBe(TOMBSTONE);
    expect(await getOrCreateSessionId()).toBe(TOMBSTONE);
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("C-16 expired sf_auth, no guest: read null; create mints a guest cookie and leaves sf_auth alone", async () => {
    const issuedAt = Date.now() - 2 * HOUR_MS;
    const a = createSignedInUser({ issuedAt, expiresAt: issuedAt + HOUR_MS });
    setCookies({ auth: a.token });
    expect(await readSessionId()).toBeNull();
    const id = await getOrCreateSessionId();
    expect(isSessionId(id)).toBe(true);
    expect(fakeStore.setCalls.map((c) => c.name)).toEqual([SESSION_COOKIE_NAME]);
    expect(fakeStore.jar.get(AUTH_COOKIE_NAME)).toBe(a.token);
    expectNoOwnerKeyWritten(a.ownerKey);
  });

  test("C-17 sf_auth of A + sf_session = B's owner key: A's owner key; nothing written", async () => {
    const a = createSignedInUser();
    const b = createSignedInUser();
    setCookies({ auth: a.token, guest: b.ownerKey });
    expect(await readSessionId()).toBe(a.ownerKey);
    expect(await getOrCreateSessionId()).toBe(a.ownerKey);
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("mixed jars: A's token with B's token-free guest cookie and vice versa never cross over", async () => {
    const a = createSignedInUser();
    const b = createSignedInUser();
    setCookies({ auth: a.token, guest: GUEST });
    expect(await readSessionId()).toBe(a.ownerKey);
    fakeStore = new FakeCookieStore();
    setCookies({ auth: b.token, guest: GUEST });
    expect(await readSessionId()).toBe(b.ownerKey);
    fakeStore = new FakeCookieStore();
    setCookies({ guest: GUEST });
    expect(await readSessionId()).toBe(GUEST);
  });

  test("C-18 cookies() throws an app error: read null, create throws, DB never opened", async () => {
    await expectNoDatabaseOpen(async () => {
      cookiesThrows = true;
      expect(await readSessionId()).toBeNull();
      expect(await readGuestSessionId()).toBeNull();
      expect(await readAuthToken()).toBeNull();
      await expect(getOrCreateSessionId()).rejects.toThrow("outside a request scope");
    });
  });

  test("C-19 cookies() throws Next control flow: every entry point rethrows the same error, DB never opened", async () => {
    await expectNoDatabaseOpen(async () => {
      for (const digest of ["NEXT_REDIRECT;replace;/x;307;", "HANGING_PROMISE_REJECTION", "DYNAMIC_SERVER_USAGE"]) {
        const control = Object.assign(new Error(digest), { digest });
        cookiesError = control;
        await expect(readSessionId()).rejects.toBe(control);
        await expect(getOrCreateSessionId()).rejects.toBe(control);
        await expect(readGuestSessionId()).rejects.toBe(control);
        await expect(readAuthToken()).rejects.toBe(control);
        await expect(rotateGuestSession()).rejects.toBe(control);
        await expect(clearAuthCookie()).rejects.toBe(control);
      }
      expect(fakeStore.setCalls).toHaveLength(0);
    });
  });

  test("SR10: no read entry point ever calls set, across every cookie combination", async () => {
    const a = createSignedInUser();
    const issuedAt = Date.now() - 2 * HOUR_MS;
    const expired = createSignedInUser({ issuedAt, expiresAt: issuedAt + HOUR_MS });
    const guests = [undefined, GUEST, "garbage", a.ownerKey, TOMBSTONE];
    const auths = [undefined, a.token, expired.token, newToken(), "x".repeat(43), ""];
    for (const guest of guests) {
      for (const auth of auths) {
        fakeStore = new FakeCookieStore();
        setCookies({ ...(guest === undefined ? {} : { guest }), ...(auth === undefined ? {} : { auth }) });
        const owner = await readSessionId();
        await readGuestSessionId();
        await readAuthToken();
        expect(fakeStore.setCalls).toHaveLength(0);
        if (owner !== null) expect(isSessionId(owner)).toBe(true);
      }
    }
  });
});

describe("T119 readSessionId: failing lookups never throw on read paths", () => {
  test("a broken database reads as null (guest) and as an exception from getOrCreateSessionId", async () => {
    const db = getDatabase();
    const patched = db as unknown as Record<"query" | "prepare", (sql: string) => never>;
    const boom = (): never => {
      throw new Error("SQLITE_IOERR: disk I/O error");
    };
    const token = newToken();
    setCookies({ guest: GUEST, auth: token });
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    patched.query = boom;
    patched.prepare = boom;
    try {
      await expect(readSessionId()).resolves.toBeNull();
      expect(fakeStore.setCalls).toHaveLength(0);
      await expect(getOrCreateSessionId()).rejects.toThrow("SQLITE_IOERR");
      await expect(readGuestSessionId()).rejects.toThrow("SQLITE_IOERR");
      expect(fakeStore.setCalls).toHaveLength(0);
    } finally {
      delete (db as unknown as Record<string, unknown>).query;
      delete (db as unknown as Record<string, unknown>).prepare;
      console.error = originalError;
    }
    // AR1: whatever the auth service logs about the failure never carries the token.
    for (const line of logged) expect(line.includes(token)).toBe(false);
  });
});

describe("T119 readGuestSessionId (K-4)", () => {
  test("returns the raw guest id even when a valid sf_auth is present", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token, guest: GUEST });
    expect(await readGuestSessionId()).toBe(GUEST);
    expect(await readSessionId()).toBe(a.ownerKey);
  });

  test("null for no cookie, garbage, or another user's owner key; never sets", async () => {
    expect(await readGuestSessionId()).toBeNull();
    setCookies({ guest: "nope" });
    expect(await readGuestSessionId()).toBeNull();
    const b = createSignedInUser();
    fakeStore = new FakeCookieStore();
    setCookies({ guest: b.ownerKey });
    expect(await readGuestSessionId()).toBeNull();
    expect(fakeStore.setCalls).toHaveLength(0);
  });
});

describe("T119 readAuthToken", () => {
  test("returns the raw well-formed token without touching the DB", async () => {
    const token = newToken();
    await expectNoDatabaseOpen(async () => {
      setCookies({ auth: token, guest: GUEST });
      expect(await readAuthToken()).toBe(token);
    });
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("absent -> null", async () => {
    expect(await readAuthToken()).toBeNull();
  });
});

describe("T119 setAuthCookie / clearAuthCookie (W-01/W-04/W-08/W-10/W-14 helper side)", () => {
  const authBase = { httpOnly: true, sameSite: "lax", path: "/" } as const;

  test("30-day expiry -> maxAge 2592000, flags exact, not Secure outside production", async () => {
    setNodeEnv("test");
    const token = newToken();
    await setAuthCookie(token, new Date(Date.now() + 30 * DAY_MS).toISOString());
    expect(fakeStore.setCalls).toEqual([
      { name: AUTH_COOKIE_NAME, value: token, options: { ...authBase, maxAge: 2_592_000, secure: false } },
    ]);
  });

  test("production -> Secure", async () => {
    setNodeEnv("production");
    await setAuthCookie(newToken(), new Date(Date.now() + 30 * DAY_MS).toISOString());
    expect(fakeStore.setCalls[0]?.options).toEqual({ ...authBase, maxAge: 2_592_000, secure: true });
  });

  test("development -> not Secure", async () => {
    setNodeEnv("development");
    await setAuthCookie(newToken(), new Date(Date.now() + DAY_MS).toISOString());
    expect(fakeStore.setCalls[0]?.options?.secure).toBe(false);
  });

  test("maxAge follows expiresAt and is capped at 30 days", async () => {
    await setAuthCookie(newToken(), new Date(Date.now() + 2 * HOUR_MS).toISOString());
    const twoHours = fakeStore.setCalls[0]?.options?.maxAge ?? -1;
    expect(twoHours).toBeGreaterThanOrEqual(7199);
    expect(twoHours).toBeLessThanOrEqual(7200);
    await setAuthCookie(newToken(), new Date(Date.now() + 400 * DAY_MS).toISOString());
    expect(fakeStore.setCalls[1]?.options?.maxAge).toBe(AUTH_COOKIE_MAX_AGE_SECONDS);
  });

  test.each([
    ["42-char token", "a".repeat(42)],
    ["44-char token", "a".repeat(44)],
    ["non-base64url token", `${"a".repeat(42)}+`],
    ["empty token", ""],
  ])("rejects a %s with a TypeError that does not echo the value; nothing set", async (_label, token) => {
    const failure = setAuthCookie(token, new Date(Date.now() + DAY_MS).toISOString());
    await expect(failure).rejects.toBeInstanceOf(TypeError);
    await failure.catch((error: unknown) => {
      if (token !== "") expect(String(error)).not.toContain(token);
    });
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("rejects an unparseable or past expiresAt; nothing set; message never contains the token", async () => {
    const token = newToken();
    await expect(setAuthCookie(token, "not a date")).rejects.toBeInstanceOf(TypeError);
    const past = setAuthCookie(token, new Date(Date.now() - 1000).toISOString());
    await expect(past).rejects.toBeInstanceOf(RangeError);
    await past.catch((error: unknown) => expect(String(error)).not.toContain(token));
    expect(fakeStore.setCalls).toHaveLength(0);
  });

  test("clearAuthCookie expires sf_auth with the same path and flags (maxAge 0, empty value)", async () => {
    setNodeEnv("production");
    fakeStore.jar.set(AUTH_COOKIE_NAME, newToken());
    await clearAuthCookie();
    expect(fakeStore.setCalls).toEqual([
      { name: AUTH_COOKIE_NAME, value: "", options: { ...authBase, maxAge: 0, secure: true } },
    ]);
    expect(await readAuthToken()).toBeNull();
  });

  test("after setAuthCookie the same jar resolves to the user's owner key", async () => {
    const a = createSignedInUser();
    setCookies({ guest: GUEST });
    await setAuthCookie(a.token, new Date(Date.now() + 30 * DAY_MS).toISOString());
    expect(await readSessionId()).toBe(a.ownerKey);
    await clearAuthCookie();
    expect(await readSessionId()).toBe(GUEST);
  });
});

describe("T119 rotateGuestSession", () => {
  test("writes a new v4 id different from the old one, with the sf_session flags", async () => {
    setNodeEnv("production");
    setCookies({ guest: GUEST });
    const id = await rotateGuestSession();
    expect(isSessionId(id)).toBe(true);
    expect(id).not.toBe(GUEST);
    expect(fakeStore.setCalls).toEqual([
      {
        name: SESSION_COOKIE_NAME,
        value: id,
        options: { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS, secure: true },
      },
    ]);
    expect(await readSessionId()).toBe(id);
  });

  test("works with no previous cookie and with a garbage one", async () => {
    const first = await rotateGuestSession();
    expect(isSessionId(first)).toBe(true);
    fakeStore = new FakeCookieStore();
    setCookies({ guest: "garbage" });
    const second = await rotateGuestSession();
    expect(isSessionId(second)).toBe(true);
    expect(fakeStore.jar.get(SESSION_COOKIE_NAME)).toBe(second);
  });

  test("regenerates when the RNG returns the current value", async () => {
    setCookies({ guest: GUEST });
    const next = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";
    const sequence = [GUEST, GUEST, next];
    const original = crypto.randomUUID.bind(crypto);
    crypto.randomUUID = mock(() => (sequence.shift() ?? next) as `${string}-${string}-${string}-${string}-${string}`);
    try {
      expect(await rotateGuestSession()).toBe(next);
    } finally {
      crypto.randomUUID = original;
    }
    expect(fakeStore.setCalls).toHaveLength(1);
  });

  test("never writes an owner key, even when sf_auth is valid (A-39)", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token, guest: GUEST });
    const id = await rotateGuestSession();
    expect(id).not.toBe(a.ownerKey);
    expectNoOwnerKeyWritten(a.ownerKey);
    expect(await readSessionId()).toBe(a.ownerKey);
  });

  test("an app error from cookies() propagates (actions only)", async () => {
    cookiesThrows = true;
    await expect(rotateGuestSession()).rejects.toThrow("outside a request scope");
  });
});

describe("T119 AC8: importing the module with no request scope does not open the DB", () => {
  test("fresh process, real next/headers: import + read entry points leave the DB unopened", async () => {
    const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "t119-ac8-"));
    const dbPath = join(dir, "never.sqlite");
    const script = [
      'const s = await import("@/server/session/session");',
      'const u = await import("@/server/session/current-user");',
      "const results = [await s.readSessionId(), await s.readGuestSessionId(), await s.readAuthToken(), await u.readCurrentUser()];",
      "const g = globalThis;",
      'console.log(JSON.stringify({ results, opened: g.__storefrontDb !== undefined }));',
    ].join("\n");
    const run = Bun.spawnSync(["bun", "-e", script], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, DATABASE_PATH: dbPath },
    });
    const out = run.stdout.toString().trim();
    const created = existsSync(dbPath);
    rmSync(dir, { recursive: true, force: true });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(out.split("\n").at(-1) ?? "{}")).toEqual({ results: [null, null, null, null], opened: false });
    expect(created).toBe(false);
  }, 30_000);
});
