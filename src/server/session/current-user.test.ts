import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/navigation mocks. mock.module is process-wide in bun
// test, so both are registered here before the modules under test are
// imported and delegate to per-test state. next/navigation spreads the real
// exports (unstable_rethrow stays real) and replaces only `redirect`.
// ---------------------------------------------------------------------------

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

interface SetCall {
  readonly name: string;
  readonly value: string;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];
  deleteCalls = 0;

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string): void {
    this.setCalls.push({ name, value });
    this.jar.set(name, value);
  }

  delete(name: string): void {
    this.deleteCalls += 1;
    this.jar.delete(name);
  }
}

let fakeStore = new FakeCookieStore();
let cookiesError: unknown = undefined;
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => {
    if (cookiesError !== undefined) throw cookiesError;
    return fakeStore;
  },
}));
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { createAuthRepository } = await import("@/server/auth/auth-repository");
const { AUTH_COOKIE_NAME, SESSION_COOKIE_NAME, readSessionId } = await import("./session");
const { SIGN_IN_PATH, readCurrentUser, readOwnerAndUser, readResolvedAuth, requireUser } = await import("./current-user");
const { getAuthService } = await import("@/server/auth/auth-service");

beforeEach(() => {
  fakeStore = new FakeCookieStore();
  cookiesError = undefined;
  redirect.mockClear();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const GUEST = "6a1f0c2e-3b4d-4c5e-9f60-718293a4b5c6";

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

let counter = 0;

function createSignedInUser(options: { issuedAt?: number; expiresAt?: number } = {}): Fixture {
  const repo = createAuthRepository(getDatabase());
  counter += 1;
  const email = `cu-${counter}-${crypto.randomUUID()}@example.test`;
  const displayName = `Current ${counter}`;
  const created = repo.createUser({ email, passwordHash: "$argon2id$v=19$fixture-hash", displayName });
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
  return { userId: created.value.id, ownerKey: created.value.ownerKey, email, displayName, token, authSessionId: session.value.id };
}

function setCookies(cookies: { guest?: string; auth?: string }): void {
  if (cookies.guest !== undefined) fakeStore.jar.set(SESSION_COOKIE_NAME, cookies.guest);
  if (cookies.auth !== undefined) fakeStore.jar.set(AUTH_COOKIE_NAME, cookies.auth);
}

/** Runs requireUser and returns the redirect URL it threw (fails if it resolved). */
async function redirectUrlOf(nextPath?: string): Promise<string> {
  try {
    await requireUser(nextPath);
  } catch (error) {
    if (error instanceof RedirectSentinel) return error.url;
    throw error;
  }
  throw new Error("requireUser resolved instead of redirecting");
}

function expectNoCookieWrites(): void {
  expect(fakeStore.setCalls).toHaveLength(0);
  expect(fakeStore.deleteCalls).toBe(0);
}

/** Every string inside `value` (deep), for leak assertions. */
function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(allStrings);
}

describe("readCurrentUser / requireUser: signed in (C-04, C-05, C-13, C-17)", () => {
  test("C-04 auth only: exactly { id, email, displayName }; requireUser returns the same; nothing written", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token });
    const user = await readCurrentUser();
    expect(user).toEqual({ id: a.userId, email: a.email, displayName: a.displayName });
    expect(Object.keys(user ?? {}).sort()).toEqual(["displayName", "email", "id"]);
    expect(await requireUser("/account/settings")).toEqual({ id: a.userId, email: a.email, displayName: a.displayName });
    expect(redirect).not.toHaveBeenCalled();
    expectNoCookieWrites();
  });

  test("AC6: the returned object never carries the owner key, token, token hash or password hash", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token, guest: GUEST });
    const user = await readCurrentUser();
    const strings = allStrings(user);
    for (const secret of [a.ownerKey, a.token, sha256hex(a.token), "$argon2id$v=19$fixture-hash", a.authSessionId]) {
      expect(strings).not.toContain(secret);
      expect(JSON.stringify(user)).not.toContain(secret);
    }
  });

  test("C-05 auth + guest -> A", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token, guest: GUEST });
    expect((await readCurrentUser())?.id).toBe(a.userId);
    expect((await requireUser()).id).toBe(a.userId);
    expectNoCookieWrites();
  });

  test("C-13 locked user still resolves", async () => {
    const a = createSignedInUser();
    const repo = createAuthRepository(getDatabase());
    for (let i = 0; i < 10; i++) repo.recordLoginFailure(a.userId);
    setCookies({ auth: a.token, guest: GUEST });
    expect((await readCurrentUser())?.id).toBe(a.userId);
    expect((await requireUser()).id).toBe(a.userId);
  });

  test("C-17 A's token + B's owner key as guest cookie -> A", async () => {
    const a = createSignedInUser();
    const b = createSignedInUser();
    setCookies({ auth: a.token, guest: b.ownerKey });
    expect((await readCurrentUser())?.id).toBe(a.userId);
    expect((await requireUser()).id).toBe(a.userId);
    expectNoCookieWrites();
  });
});

describe("readCurrentUser null / requireUser redirect (guest and invalid rows)", () => {
  const cases: ReadonlyArray<[string, () => { guest?: string; auth?: string }]> = [
    ["C-01 no cookies", () => ({})],
    ["C-02 valid guest", () => ({ guest: GUEST })],
    ["C-03 garbage guest", () => ({ guest: "abc" })],
    [
      "C-06 expired sf_auth + guest",
      () => {
        const issuedAt = Date.now() - 2 * HOUR_MS;
        return { auth: createSignedInUser({ issuedAt, expiresAt: issuedAt + HOUR_MS }).token, guest: GUEST };
      },
    ],
    [
      "C-07 revoked sf_auth + guest",
      () => {
        const a = createSignedInUser();
        createAuthRepository(getDatabase()).revokeAuthSession(a.authSessionId);
        return { auth: a.token, guest: GUEST };
      },
    ],
    ["C-08 42-char sf_auth", () => ({ auth: newToken().slice(0, 42), guest: GUEST })],
    ["C-08 '+/=' sf_auth", () => ({ auth: `${newToken().slice(0, 40)}+/=`, guest: GUEST })],
    ["C-08 empty sf_auth", () => ({ auth: "", guest: GUEST })],
    ["C-09 1 MiB sf_auth", () => ({ auth: "A".repeat(1024 * 1024), guest: GUEST })],
    ["C-10 unicode sf_auth", () => ({ auth: "é".repeat(43), guest: GUEST })],
    ["C-10 NUL in sf_auth", () => ({ auth: `${newToken().slice(0, 42)}\u0000`, guest: GUEST })],
    ["C-11 unknown well-formed sf_auth", () => ({ auth: newToken(), guest: GUEST })],
    [
      "C-12 deleted user's sf_auth",
      () => {
        const a = createSignedInUser();
        createAuthRepository(getDatabase()).deleteUser(a.userId);
        return { auth: a.token, guest: GUEST };
      },
    ],
    ["C-14 fixation guest id", () => ({ guest: "f1f2f3f4-a5a6-4b7b-8c8c-9d9d0e0e1f1f" })],
    ["C-15 owner key as guest cookie", () => ({ guest: createSignedInUser().ownerKey })],
    ["C-15 tombstone as guest cookie", () => ({ guest: "00000000-0000-4000-8000-000000000000" })],
    [
      "C-16 expired sf_auth, no guest",
      () => {
        const issuedAt = Date.now() - 2 * HOUR_MS;
        return { auth: createSignedInUser({ issuedAt, expiresAt: issuedAt + HOUR_MS }).token };
      },
    ],
  ];

  test.each(cases)("%s: readCurrentUser null; requireUser redirects to /signin?next=; no cookie writes", async (_label, make) => {
    setCookies(make());
    expect(await readCurrentUser()).toBeNull();
    expect(await readResolvedAuth()).toBeNull();
    expect(await redirectUrlOf("/orders")).toBe(`${SIGN_IN_PATH}?next=${encodeURIComponent("/orders")}`);
    expect(redirect).toHaveBeenCalledTimes(1);
    expectNoCookieWrites();
  });

  test("C-18 cookies() throws an app error: null and redirect", async () => {
    cookiesError = new Error("`cookies` was called outside a request scope.");
    expect(await readCurrentUser()).toBeNull();
    expect(await readResolvedAuth()).toBeNull();
    expect(await redirectUrlOf()).toBe("/signin?next=%2Faccount");
  });

  test.each([
    ["NEXT_REDIRECT", "NEXT_REDIRECT;replace;/elsewhere;307;"],
    ["prerender hanging promise", "HANGING_PROMISE_REJECTION"],
    ["dynamic usage", "DYNAMIC_SERVER_USAGE"],
    ["notFound", "NEXT_HTTP_ERROR_FALLBACK;404"],
  ])("C-19 cookies() throws Next control flow (%s): rethrown by identity from every entry point", async (_label, digest) => {
    const control = Object.assign(new Error(digest), { digest });
    cookiesError = control;
    await expect(readCurrentUser()).rejects.toBe(control);
    await expect(requireUser("/orders")).rejects.toBe(control);
    await expect(readResolvedAuth()).rejects.toBe(control);
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("requireUser next handling (AC7, PLAN A-84)", () => {
  test("no nextPath -> next=/account", async () => {
    expect(await redirectUrlOf()).toBe("/signin?next=%2Faccount");
  });

  test.each(["//evil.com", "https://x", "/\\evil", "javascript:alert(1)", "/%2F/evil.com", " //evil.com", ""])(
    "hostile %p falls back to /account",
    async (hostile) => {
      expect(await redirectUrlOf(hostile)).toBe("/signin?next=%2Faccount");
    },
  );

  test.each(["/orders?page=2", "/account/settings", "/products/canvas-tote-bag#reviews"])(
    "safe %p is kept and URL-encoded",
    async (path) => {
      const url = await redirectUrlOf(path);
      expect(url).toBe(`/signin?next=${encodeURIComponent(path)}`);
      const next = new URL(url, "http://localhost").searchParams.get("next");
      expect(next).toBe(path);
    },
  );

  test("the decoded next of every redirect is a single-slash same-origin path", async () => {
    for (const raw of ["//evil.com", "/orders", "\\\\evil.com", "/%5Cevil", "/ok?x=1&y=2"]) {
      redirect.mockClear();
      const url = await redirectUrlOf(raw);
      expect(url.startsWith("/signin?next=")).toBe(true);
      const next = new URL(url, "http://localhost").searchParams.get("next") ?? "";
      expect(next).toMatch(/^\/(?![/\\])/);
      expect(next.includes("evil")).toBe(false);
    }
  });
});

describe("readResolvedAuth (server actions)", () => {
  test("returns the full user (incl. owner key) and the auth session id for a valid token", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token, guest: GUEST });
    const resolved = await readResolvedAuth();
    expect(resolved?.authSessionId).toBe(a.authSessionId);
    expect(resolved?.user.id).toBe(a.userId);
    expect(resolved?.user.ownerKey).toBe(a.ownerKey);
    expect(Object.keys(resolved ?? {}).sort()).toEqual(["authSessionId", "user"]);
    expectNoCookieWrites();
  });

  test("null after the session is revoked (sign-out-everywhere replay, A-34/A-36)", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token });
    expect(await readResolvedAuth()).not.toBeNull();
    createAuthRepository(getDatabase()).revokeAllForUser(a.userId);
    expect(await readResolvedAuth()).toBeNull();
    expect(await readCurrentUser()).toBeNull();
  });
});

describe("readOwnerAndUser (consistency at: one token lookup per render)", () => {
  async function expectSameAsSeparateHelpers(): Promise<void> {
    const combined = await readOwnerAndUser();
    expect(combined).toEqual({ ownerKey: await readSessionId(), user: await readCurrentUser() });
  }

  test("signed in: the user's owner key and the UI user; one resolveToken call; no cookie writes", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token, guest: GUEST });
    const resolveSpy = spyOn(getAuthService(), "resolveToken");
    try {
      const result = await readOwnerAndUser();
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ownerKey: a.ownerKey, user: { id: a.userId, email: a.email, displayName: a.displayName } });
      expect(Object.keys(result.user ?? {}).sort()).toEqual(["displayName", "email", "id"]);
      expect(allStrings(result.user)).not.toContain(a.ownerKey);
      expect(allStrings(result)).not.toContain(a.token);
    } finally {
      resolveSpy.mockRestore();
    }
    await expectSameAsSeparateHelpers();
    expectNoCookieWrites();
  });

  test("no cookies: nulls without opening the database lookup", async () => {
    const resolveSpy = spyOn(getAuthService(), "resolveToken");
    try {
      expect(await readOwnerAndUser()).toEqual({ ownerKey: null, user: null });
      expect(resolveSpy).not.toHaveBeenCalled();
    } finally {
      resolveSpy.mockRestore();
    }
    expectNoCookieWrites();
  });

  const guestCases: ReadonlyArray<[string, () => { guest?: string; auth?: string }, "guest" | null]> = [
    ["valid guest", () => ({ guest: GUEST }), "guest"],
    ["garbage guest", () => ({ guest: "abc" }), null],
    [
      "expired sf_auth + guest",
      () => {
        const issuedAt = Date.now() - 2 * HOUR_MS;
        return { auth: createSignedInUser({ issuedAt, expiresAt: issuedAt + HOUR_MS }).token, guest: GUEST };
      },
      "guest",
    ],
    [
      "revoked sf_auth + guest",
      () => {
        const a = createSignedInUser();
        createAuthRepository(getDatabase()).revokeAuthSession(a.authSessionId);
        return { auth: a.token, guest: GUEST };
      },
      "guest",
    ],
    ["unknown well-formed sf_auth + guest", () => ({ auth: newToken(), guest: GUEST }), "guest"],
    ["malformed sf_auth + guest", () => ({ auth: "A".repeat(42), guest: GUEST }), "guest"],
    ["owner key as guest cookie (R-1)", () => ({ guest: createSignedInUser().ownerKey }), null],
  ];

  test.each(guestCases)("%s: same as readSessionId + readCurrentUser; user null; no cookie writes", async (_label, make, expected) => {
    setCookies(make());
    const result = await readOwnerAndUser();
    expect(result).toEqual({ ownerKey: expected === "guest" ? GUEST : null, user: null });
    await expectSameAsSeparateHelpers();
    expectNoCookieWrites();
  });

  test("a failing token lookup reads as signed out and falls back to the guest id (like readSessionId)", async () => {
    const a = createSignedInUser();
    setCookies({ auth: a.token, guest: GUEST });
    const resolveSpy = spyOn(getAuthService(), "resolveToken").mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      expect(await readOwnerAndUser()).toEqual({ ownerKey: GUEST, user: null });
      await expectSameAsSeparateHelpers();
    } finally {
      resolveSpy.mockRestore();
    }
    expectNoCookieWrites();
  });

  test("cookies() app error: nulls", async () => {
    cookiesError = new Error("`cookies` was called outside a request scope.");
    expect(await readOwnerAndUser()).toEqual({ ownerKey: null, user: null });
  });

  test("cookies() Next control flow: rethrown by identity", async () => {
    const control = Object.assign(new Error("DYNAMIC_SERVER_USAGE"), { digest: "DYNAMIC_SERVER_USAGE" });
    cookiesError = control;
    await expect(readOwnerAndUser()).rejects.toBe(control);
  });
});

describe("source guards", () => {
  test("current-user.ts imports the auth service lazily (no top-level import of it or the DB)", async () => {
    const source = await Bun.file(new URL("./current-user.ts", import.meta.url)).text();
    expect(source).not.toMatch(/^import[^;]*["']@\/server\/(auth\/auth-service|db\/client)["']/m);
    expect(source).toMatch(/await import\("@\/server\/auth\/auth-service"\)/);
  });

  test("session.ts imports the auth service and DB lazily", async () => {
    const source = await Bun.file(new URL("./session.ts", import.meta.url)).text();
    expect(source).not.toMatch(/^import[^;]*["']@\/server\/(auth\/[a-z-]+|db\/client)["']/m);
  });
});
