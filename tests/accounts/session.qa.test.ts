import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// T122 QA: owner-key session resolution (T119). PLAN.md section 2a (C-01..C-19)
// + A-24, A-33..A-35, A-37, A-39, A-40, A-75, A-82, A-84, tombstone.
// next/headers and next/navigation are mocked process-wide (bun), so the mocks
// delegate to per-test state here and are registered before any app import.
// `redirect` throws a hand-built NEXT_REDIRECT digest so the real
// `unstable_rethrow` recognises it.
// ---------------------------------------------------------------------------

import { QaCookieStore, RedirectSentinel, captureRedirect } from "./_fixtures";

let currentCookies: () => unknown = () => store;
let store = new QaCookieStore();
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({
  cookies: async (): Promise<unknown> => currentCookies(),
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
const originalNodeEnv = env.NODE_ENV;
env.DATABASE_PATH = ":memory:";

const dbGlobal = globalThis as typeof globalThis & { __storefrontDb?: unknown };
const { closeDatabase, getDatabase } = await import("@/server/db/client");
closeDatabase();

const session = await import("@/server/session/session");
const currentUser = await import("@/server/session/current-user");
const { safeNext } = await import("@/server/session/safe-next");
const dbOpenedAtImport = dbGlobal.__storefrontDb !== undefined;

const { AUTH_COOKIE_NAME, SESSION_COOKIE_NAME, readSessionId, getOrCreateSessionId, readGuestSessionId, setAuthCookie, clearAuthCookie, rotateGuestSession } = session;
const { readCurrentUser, requireUser, readResolvedAuth } = currentUser;

const { ok } = await import("@/lib/result");
const { createAuthService } = await import("@/server/auth/auth-service");
const { createAuthRepository } = await import("@/server/auth/auth-repository");
const { createAccountService } = await import("@/server/auth/account-service");
const { validatePassword } = await import("@/server/auth/password-policy");
const { seedDatabase } = await import("@/server/db/seed");
const { getOrderService } = await import("@/server/orders/order-service");
const fx = await import("./_fixtures");
const { PASSWORD, TOMBSTONE, fastHasher, uuid, seedIdentity, SecretRegistry } = fx;

const secrets = new SecretRegistry();
secrets.add(PASSWORD);

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

afterEach(() => {
  if (originalNodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = originalNodeEnv;
});

function jar(cookies: Readonly<Record<string, string | undefined>> = {}): QaCookieStore {
  store = new QaCookieStore(cookies);
  currentCookies = () => store;
  return store;
}

interface Users {
  A: { id: string; key: string; token: string };
  B: { id: string; key: string; token: string };
}

const hasher = fastHasher();

/** Fresh :memory: app DB + two users signed up through the real auth service. */
async function freshUsers(): Promise<Users> {
  closeDatabase();
  const db = getDatabase();
  seedDatabase(db);
  const auth = createAuthService({ db, hasher, limiter: { check: () => ok({ remaining: 99 }) } });
  const a = await auth.signUp({ email: "a@ses.test", password: PASSWORD, displayName: "Alice" }, { sessionKey: uuid() });
  const b = await auth.signUp({ email: "b@ses.test", password: PASSWORD, displayName: "Bob" }, { sessionKey: uuid() });
  if (!a.ok || !b.ok) throw new Error("signup");
  secrets.add(a.value.token, b.value.token);
  secrets.addOwnerKey(a.value.user.ownerKey, b.value.user.ownerKey);
  return {
    A: { id: a.value.user.id, key: a.value.user.ownerKey, token: a.value.token },
    B: { id: b.value.user.id, key: b.value.user.ownerKey, token: b.value.token },
  };
}

async function newToken(email: string): Promise<string> {
  const auth = createAuthService({ db: getDatabase(), hasher, limiter: { check: () => ok({ remaining: 99 }) } });
  const r = await auth.signIn({ email, password: PASSWORD }, { sessionKey: uuid() });
  if (!r.ok) throw new Error("signin");
  secrets.add(r.value.token);
  return r.value.token;
}

const G = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

describe("T119 AC8 / C-01..C-03, C-14: guest paths do not need auth; import opens no DB", () => {
  test("importing session/current-user with no request scope did not open the DB", () => {
    expect(dbOpenedAtImport).toBe(false);
  });

  test("C-01 no cookies: read null, create mints exactly one sf_session, user null, requireUser redirects; DB not opened", async () => {
    closeDatabase();
    const s = jar();
    expect(await readSessionId()).toBeNull();
    expect(await readCurrentUser()).toBeNull();
    expect(s.setCalls.length).toBe(0);
    expect(dbGlobal.__storefrontDb).toBeUndefined();
    const url = await captureRedirect(requireUser("/account/settings"));
    expect(url).toBe("/signin?next=%2Faccount%2Fsettings");
    const id = await getOrCreateSessionId();
    expect(session.isSessionId(id)).toBe(true);
    expect(s.setsOf(SESSION_COOKIE_NAME).map((c) => c.value)).toEqual([id]);
    expect(dbGlobal.__storefrontDb).toBeUndefined();
  });

  test("C-03 garbage sf_session values: read null, create replaces; DB not opened", async () => {
    for (const bad of ["abc", G.toUpperCase(), "3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b", `${G}x`, "x".repeat(4096)]) {
      closeDatabase();
      const s = jar({ sf_session: bad });
      expect(await readSessionId()).toBeNull();
      expect(dbGlobal.__storefrontDb).toBeUndefined();
      const id = await getOrCreateSessionId();
      expect(id).not.toBe(bad);
      expect(s.setsOf(SESSION_COOKIE_NAME).length).toBe(1);
    }
  });
});

describe("C-02..C-19 resolution matrix (real auth service over :memory:)", () => {
  let u: Users;
  beforeEach(async () => {
    u = await freshUsers();
  });

  async function readAll(): Promise<{ read: string | null; user: unknown; sets: number }> {
    const read = await readSessionId();
    const user = await readCurrentUser();
    return { read, user, sets: store.setCalls.length };
  }

  test("C-02/C-14 guest or attacker-chosen sf_session: returned as-is, no writes", async () => {
    jar({ sf_session: G });
    expect(await readAll()).toEqual({ read: G, user: null, sets: 0 });
    expect(await getOrCreateSessionId()).toBe(G);
    expect(store.setCalls.length).toBe(0);
  });

  test("C-04/C-05 valid sf_auth (alone / with guest): owner key, user has exactly {id,email,displayName}, no guest cookie minted", async () => {
    for (const cookies of [{ sf_auth: u.A.token }, { sf_auth: u.A.token, sf_session: G }]) {
      jar(cookies);
      const r = await readAll();
      expect(r.read).toBe(u.A.key);
      expect(Object.keys(r.user as object).sort()).toEqual(["displayName", "email", "id"]);
      expect(r.user).toEqual({ id: u.A.id, email: "a@ses.test", displayName: "Alice" });
      expect(await getOrCreateSessionId()).toBe(u.A.key);
      expect(await requireUser()).toEqual({ id: u.A.id, email: "a@ses.test", displayName: "Alice" });
      expect(store.setCalls.length).toBe(0);
    }
  });

  test("C-06/C-07/C-16: expired / revoked sf_auth fall back to guest (or mint), never cleared on read (R-8)", async () => {
    const db = getDatabase();
    db.query("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(u.A.id);
    jar({ sf_auth: u.A.token, sf_session: G });
    expect(await readAll()).toEqual({ read: G, user: null, sets: 0 });
    expect(await getOrCreateSessionId()).toBe(G);
    expect(store.setCalls.length).toBe(0);
    jar({ sf_auth: u.A.token });
    const minted = await getOrCreateSessionId();
    expect(minted).not.toBe(u.A.key);
    expect(store.setsOf(AUTH_COOKIE_NAME)).toEqual([]);
    expect(store.setsOf(SESSION_COOKIE_NAME).length).toBe(1);

    createAuthService({ db, hasher }).signOut(u.B.token);
    jar({ sf_auth: u.B.token, sf_session: G });
    expect(await readAll()).toEqual({ read: G, user: null, sets: 0 });
    expect(await captureRedirect(requireUser("/orders"))).toBe("/signin?next=%2Forders");
  });

  test("C-08/C-09/C-10: garbage, oversized and unicode sf_auth never throw, fall back to G, fast, no writes", async () => {
    const values = [
      "a".repeat(42),
      "a".repeat(44),
      `${"a".repeat(40)}+/=`,
      "",
      ` ${"a".repeat(43)} `,
      "null",
      "x".repeat(4096),
      "y".repeat(1024 * 1024),
      "é".repeat(43),
      `${"a".repeat(41)}\u{1F600}`,
      `${"a".repeat(42)}\uD800`,
      `${"a".repeat(42)}‮`,
      `${"a".repeat(21)}\u0000${"a".repeat(21)}`,
    ];
    for (const v of values) {
      jar({ sf_auth: v, sf_session: G });
      const t = performance.now();
      const r = await readAll();
      expect(performance.now() - t).toBeLessThan(2000); // generous; structural: falls back to G with no writes
      expect(r).toEqual({ read: G, user: null, sets: 0 });
      expect(await getOrCreateSessionId()).toBe(G);
      expect(await readResolvedAuth()).toBeNull();
      expect(store.setCalls.length).toBe(0);
    }
  }, 30_000);

  test("C-11 well-formed but unknown token -> G", async () => {
    jar({ sf_auth: "Q".repeat(43), sf_session: G });
    expect(await readAll()).toEqual({ read: G, user: null, sets: 0 });
  });

  test("C-12/A-37/A-75 token of a deleted user -> guest, null user, readResolvedAuth null", async () => {
    getDatabase().query("DELETE FROM users WHERE id = ?").run(u.A.id);
    jar({ sf_auth: u.A.token, sf_session: G });
    expect(await readAll()).toEqual({ read: G, user: null, sets: 0 });
    expect(await readResolvedAuth()).toBeNull();
  });

  test("C-13/A-24 locked user's existing token still resolves to KA", async () => {
    getDatabase().query("UPDATE users SET locked_until = '2999-01-01T00:00:00.000Z', failed_login_count = 10 WHERE id = ?").run(u.A.id);
    jar({ sf_auth: u.A.token });
    expect((await readAll()).read).toBe(u.A.key);
  });

  test("C-15/A-40 (R-1): sf_session equal to a user's owner key is treated as NO cookie and never merged", async () => {
    jar({ sf_session: u.A.key });
    expect(await readAll()).toEqual({ read: null, user: null, sets: 0 });
    expect(await readGuestSessionId()).toBeNull();
    const minted = await getOrCreateSessionId();
    expect(minted).not.toBe(u.A.key);
    expect(store.setsOf(SESSION_COOKIE_NAME).map((c) => c.value)).toEqual([minted]);
    // A's rows are not reachable through it
    seedIdentity(getDatabase(), u.A.key, { tag: "c15", slot: 1 });
    jar({ sf_session: u.A.key });
    expect(await readSessionId()).toBeNull();
  });

  test("C-17: sf_auth=TA + sf_session=KB -> KA (B's key never used)", async () => {
    jar({ sf_auth: u.A.token, sf_session: u.B.key });
    expect((await readAll()).read).toBe(u.A.key);
    expect(await readGuestSessionId()).toBeNull();
  });

  test("tombstone in sf_session resolves to no user and reaches no anonymised order", async () => {
    const db = getDatabase();
    seedIdentity(db, TOMBSTONE, { tag: "tomb", slot: 1 });
    jar({ sf_session: TOMBSTONE });
    expect(await readCurrentUser()).toBeNull();
    const key = await readSessionId();
    expect(key === null || key === TOMBSTONE).toBe(true);
    if (key !== null) expect(getOrderService().listOrders(key).items).toEqual([]);
  });

  test("A-33/A-34 token theft then sign-out-everywhere: attacker jar falls back to its own guest id, never KA", async () => {
    const attackerGuest = uuid();
    jar({ sf_auth: u.A.token, sf_session: attackerGuest });
    expect(await readCurrentUser()).toEqual({ id: u.A.id, email: "a@ses.test", displayName: "Alice" });
    const other = await newToken("a@ses.test");
    createAuthService({ db: getDatabase(), hasher }).signOutEverywhere(u.A.id);
    jar({ sf_auth: u.A.token, sf_session: attackerGuest });
    expect(await readAll()).toEqual({ read: attackerGuest, user: null, sets: 0 });
    jar({ sf_auth: other });
    expect(await readCurrentUser()).toBeNull();
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL").get(u.A.id)).toEqual({ n: 0 });
  });

  test("A-35 password change from jar 1 keeps TA1, revokes TA2", async () => {
    const t2 = await newToken("a@ses.test");
    const db = getDatabase();
    const auth = createAuthService({ db, hasher, limiter: { check: () => ok({ remaining: 99 }) } });
    const repo = createAuthRepository(db);
    const account = createAccountService({
      db,
      verifyPassword: (id, pw, now) => auth.verifyPassword(id, pw, now),
      hashPassword: (pw) => hasher.hash(pw),
      validatePassword,
      revokeOthers: (id, keep, now) => repo.revokeOthers(id, keep, now),
    });
    jar({ sf_auth: u.A.token });
    const resolved = await readResolvedAuth();
    if (resolved === null) throw new Error("not signed in");
    expect((await account.changePassword(u.A.id, PASSWORD, "N3w-Passw0rd-qa", resolved.authSessionId)).ok).toBe(true);
    jar({ sf_auth: u.A.token });
    expect((await readCurrentUser())?.id).toBe(u.A.id);
    jar({ sf_auth: t2, sf_session: G });
    expect(await readAll()).toEqual({ read: G, user: null, sets: 0 });
  });

  test("A-39: getOrCreateSessionId while signed in returns KA and writes nothing carrying KA", async () => {
    jar({ sf_auth: u.A.token });
    expect(await getOrCreateSessionId()).toBe(u.A.key);
    expect(store.setCalls.filter((c) => c.value === u.A.key)).toEqual([]);
    expect(store.setCalls.length).toBe(0);
  });

  test("C-18: cookies() throws an app error -> read null, create throws, user null, requireUser redirects", async () => {
    currentCookies = () => {
      throw new Error("no request scope");
    };
    expect(await readSessionId()).toBeNull();
    await expect(getOrCreateSessionId()).rejects.toThrow();
    expect(await readCurrentUser()).toBeNull();
    expect(await captureRedirect(requireUser("/account"))).toBe("/signin?next=%2Faccount");
  });

  test("C-19: Next control-flow error from cookies() is rethrown by identity everywhere", async () => {
    const control = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/x;307;" });
    currentCookies = () => {
      throw control;
    };
    await expect(readSessionId()).rejects.toBe(control);
    await expect(getOrCreateSessionId()).rejects.toBe(control);
    await expect(readCurrentUser()).rejects.toBe(control);
    await expect(requireUser("/account")).rejects.toBe(control);
  });

  test("no read function ever writes a cookie or carries an owner key in a write", async () => {
    for (const cookies of [{}, { sf_session: G }, { sf_auth: u.A.token }, { sf_auth: u.A.token, sf_session: u.B.key }, { sf_session: u.A.key }, { sf_auth: "bad" }]) {
      const s = jar(cookies);
      await readSessionId();
      await readCurrentUser();
      await readGuestSessionId();
      await readResolvedAuth();
      try {
        await requireUser("/account");
      } catch (e) {
        if (!(e instanceof RedirectSentinel)) throw e;
      }
      expect(s.setCalls).toEqual([]);
      expect(s.deleteCalls).toEqual([]);
    }
  });
});

describe("2b cookie helpers (T119 AC5)", () => {
  test("setAuthCookie: httpOnly, lax, path /, maxAge <= 30 days, secure only in production; errors carry no token", async () => {
    const token = "T".repeat(43);
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    for (const nodeEnv of ["test", "production"]) {
      env.NODE_ENV = nodeEnv;
      const s = jar();
      await setAuthCookie(token, expires);
      const call = s.setsOf(AUTH_COOKIE_NAME)[0];
      expect(call?.value).toBe(token);
      expect(call?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: nodeEnv === "production" });
      expect(call?.options?.maxAge as number).toBeGreaterThan(30 * 24 * 3600 - 5);
      expect(call?.options?.maxAge as number).toBeLessThanOrEqual(30 * 24 * 3600);
    }
    for (const bad of ["short", `${"T".repeat(42)}+`]) {
      try {
        await setAuthCookie(bad, expires);
        throw new Error("expected throw");
      } catch (e) {
        expect(String(e)).not.toContain(bad);
      }
    }
    await expect(setAuthCookie(token, "2000-01-01T00:00:00.000Z")).rejects.toThrow(RangeError);
  });

  test("clearAuthCookie expires sf_auth; rotateGuestSession writes a new v4 != previous", async () => {
    const s = jar({ sf_auth: "T".repeat(43), sf_session: G });
    await clearAuthCookie();
    expect(s.isCleared(AUTH_COOKIE_NAME)).toBe(true);
    const id = await rotateGuestSession();
    expect(id).not.toBe(G);
    expect(session.isSessionId(id)).toBe(true);
    expect(s.setsOf(SESSION_COOKIE_NAME).at(-1)?.value).toBe(id);
  });
});

describe("A-82/A-84 safe-next (amended: /%2F/evil.com -> /account)", () => {
  const hostile = [
    "//evil.com",
    "https://evil.com",
    "http:/evil.com",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    " //evil.com",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,x",
    "%2F%2Fevil.com",
    "/%2F/evil.com",
    "/%2f%2fevil.com",
    "/%5Cevil.com",
    "evil.com",
    "",
    `/${"a".repeat(4096)}`,
  ];
  const safe = ["/orders", "/orders?page=2", "/account/settings", "/products/canvas-tote-bag#reviews"];

  test("hostile set -> /account; safe set unchanged; output never starts with // or /\\", () => {
    for (const h of hostile) expect([h, safeNext(h)]).toEqual([h, "/account"]);
    for (const s of safe) expect(safeNext(s)).toBe(s);
    for (const v of [...hostile, ...safe, null, undefined, 42, {}]) {
      const out = safeNext(v);
      expect(out).not.toMatch(/^\/[/\\]/);
      expect(out).not.toMatch(/[\u0000-\u001f]/);
      expect(out).not.toMatch(/^[a-z]+:/i);
    }
  });

  test("A-84: requireUser with a hostile current path redirects to /signin?next=%2Faccount", async () => {
    closeDatabase();
    jar();
    for (const h of ["//evil.com", "https://evil.com", "/\\evil", "/%2F/evil.com"]) {
      const url = await captureRedirect(requireUser(h));
      expect(url).toBe("/signin?next=%2Faccount");
      const next = decodeURIComponent(url.split("next=")[1] as string);
      expect(safeNext(next)).toBe(next);
    }
  });
});
