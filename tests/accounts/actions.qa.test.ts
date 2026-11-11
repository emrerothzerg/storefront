import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// T122 QA: auth actions (T120) and account settings actions (T121).
// PLAN.md section 2b (W-01..W-18) and 3.x `act` rows, as amended by the
// orchestrator rulings (R-10 boundary: lock and limit both surface
// error.code "RATE_LIMITED" with identical shape; old sf_auth revoked only
// after new credentials succeed; signOutEverywhere lives only in account.ts).
//
// Part A drives the real `'use server'` wrappers (auth.ts / account.ts) over a
// :memory: app DB, with the app-wide auth/account services swapped for ones
// using a fast hasher (globalThis caches, same DB handle).
// Part B drives `createAuthActions` (auth-core) with the REAL session helpers
// and real services but an injected clock, so lockout windows are exact.
// ---------------------------------------------------------------------------

import { QaCookieStore, RedirectSentinel } from "./_fixtures";

let store = new QaCookieStore();
let reqHeaders = new Headers({ "user-agent": "qa-agent/1.0" });
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({
  cookies: async (): Promise<QaCookieStore> => store,
  headers: async (): Promise<Headers> => reqHeaders,
}));
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));
mock.module("next/cache", () => ({ revalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
closeDatabase();
const authActions = await import("@/app/actions/auth");
const accountActions = await import("@/app/actions/account");
const { createAuthActions } = await import("@/app/actions/auth-core");
const session = await import("@/server/session/session");
const { seedDatabase } = await import("@/server/db/seed");
const { createAuthService, getAuthService } = await import("@/server/auth/auth-service");
const { createAuthRepository } = await import("@/server/auth/auth-repository");
const { createAccountService } = await import("@/server/auth/account-service");
const { createMergeService } = await import("@/server/auth/merge-service");
const { validatePassword } = await import("@/server/auth/password-policy");
const { getRateLimiter } = await import("@/server/security/rate-limiter");
const fx = await import("./_fixtures");
const { PASSWORD, PASSWORD_B, INVALID_MSG, SecretRegistry, consoleCapture, counts, fastHasher, form, injectFailure, seedIdentity, snapshot, spyFormData, uuid, zeroCounts, IN_STOCK_A } = fx;
type AuthActionState = import("@/components/molecules/_contracts/auth-actions").AuthActionState;
type AccountActionState = import("@/components/molecules/_contracts/account-actions").AccountActionState;

const { signIn, signUp, signOut } = authActions;
const { updateProfile, changePassword, deleteAccount, signOutEverywhere } = accountActions;

const secrets = new SecretRegistry();
secrets.add(PASSWORD, PASSWORD_B, "wrong-pass-123", "N3w-Passw0rd-qa", "Wr0ng-pass-qa!");
const capture = consoleCapture();
const states: unknown[] = [];
const redirects: string[] = [];
const allSetCalls: { name: string; value: string }[] = [];

afterAll(() => {
  capture.restore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const hasher = fastHasher();
const g = globalThis as typeof globalThis & {
  __storefrontAuthService?: { db: unknown; service: unknown };
  __storefrontAccountService?: { db: unknown; service: unknown };
};

/** Fresh :memory: app DB and app-wide services that use the fast hasher. */
function resetApp(): void {
  closeDatabase();
  const db = getDatabase();
  seedDatabase(db);
  const auth = createAuthService({ db, hasher, limiter: getRateLimiter() });
  g.__storefrontAuthService = { db, service: auth };
  const repo = createAuthRepository(db);
  g.__storefrontAccountService = {
    db,
    service: createAccountService({
      db,
      verifyPassword: (id, pw, now) => getAuthService().verifyPassword(id, pw, now),
      hashPassword: (pw) => hasher.hash(pw),
      validatePassword,
      revokeOthers: (id, keep, now) => repo.revokeOthers(id, keep, now),
    }),
  };
}

function browser(cookies: Readonly<Record<string, string | undefined>> = {}): QaCookieStore {
  store = new QaCookieStore(cookies);
  revalidatePath.mockClear();
  redirect.mockClear();
  return store;
}

/** Same browser, next request. */
function nextRequest(): QaCookieStore {
  for (const c of store.setCalls) allSetCalls.push({ name: c.name, value: c.value });
  store = store.next();
  revalidatePath.mockClear();
  redirect.mockClear();
  return store;
}

async function run<S>(p: Promise<S>): Promise<S | { redirect: string }> {
  try {
    const s = await p;
    states.push(s);
    return s;
  } catch (e) {
    if (e instanceof RedirectSentinel) {
      redirects.push(e.url);
      return { redirect: e.url };
    }
    throw e;
  }
}

function errCode(s: unknown): string | undefined {
  return (s as { error?: { code?: string } } | null)?.error?.code;
}

async function signUpAs(email: string, password = PASSWORD, displayName = "QA"): Promise<{ token: string; key: string; id: string }> {
  const s = browser();
  const r = await run(signUp(null, form({ email, password, displayName })));
  expect(r).toEqual({ redirect: "/account" });
  const token = s.setsOf("sf_auth")[0]?.value as string;
  secrets.add(token);
  const user = getDatabase().query("SELECT id, owner_key FROM users WHERE email = ?").get(email.trim().toLowerCase()) as { id: string; owner_key: string };
  secrets.addOwnerKey(user.owner_key);
  nextRequest();
  return { token, key: user.owner_key, id: user.id };
}

function activeSessions(userId: string): number {
  return (getDatabase().query("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL").get(userId) as { n: number }).n;
}

function resolves(token: string): string | null {
  return getAuthService().resolveToken(token)?.user.ownerKey ?? null;
}

function guestCart(guest: string, product = IN_STOCK_A): void {
  const db = getDatabase();
  db.query("INSERT OR IGNORE INTO carts (session_id) VALUES (?)").run(guest);
  db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, 1)").run(guest, product);
}

beforeEach(() => {
  resetApp();
  hasher.reset();
});

// ===========================================================================
// Part A: wired actions
// ===========================================================================

describe("W-01..W-05, A-30: sign-up / sign-in cookie transitions and fixation", () => {
  test("W-01: no cookies, sign-up -> sf_auth (43) + new sf_session, 1 user, 1 session, revalidate once, redirect /account", async () => {
    const s = browser();
    const r = await run(signUp(null, form({ email: "w01@act.test", password: PASSWORD, displayName: "W" })));
    expect(r).toEqual({ redirect: "/account" });
    const auth = s.setsOf("sf_auth");
    expect(auth.length).toBe(1);
    expect(auth[0]?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    secrets.add(auth[0]?.value);
    expect(auth[0]?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const sessions = s.setsOf("sf_session");
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(session.isSessionId(sessions.at(-1)?.value)).toBe(true);
    expect(revalidatePath.mock.calls).toEqual([["/", "layout"]]);
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 1 });
  });

  test("W-02/W-04/A-30: attacker-chosen sf_session F with a cart -> after sign-in sf_session != F, F has no rows, KA has the line", async () => {
    const A = await signUpAs("a30@act.test");
    const F = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    guestCart(F);
    seedIdentity(getDatabase(), F, { tag: "fix", slot: 3 });
    const s = browser({ sf_session: F });
    const r = await run(signIn(null, form({ email: "a30@act.test", password: PASSWORD })));
    expect(r).toEqual({ redirect: "/account" });
    const newSession = s.setsOf("sf_session").at(-1)?.value;
    expect(newSession).toBeDefined();
    expect(newSession).not.toBe(F);
    expect(newSession).not.toBe(A.key);
    expect(s.setsOf("sf_auth").length).toBe(1);
    secrets.add(s.setsOf("sf_auth")[0]?.value);
    expect(zeroCounts(counts(getDatabase(), F))).toBe(true);
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ? AND product_id = ?").get(A.key, IN_STOCK_A)).toEqual({ n: 1 });
    const row = getDatabase().query("SELECT failed_login_count, last_login_at FROM users WHERE id = ?").get(A.id) as { failed_login_count: number; last_login_at: string | null };
    expect(row.failed_login_count).toBe(0);
    expect(row.last_login_at).not.toBeNull();
    // The attacker's jar (still F) sees nothing of A (A-31).
    browser({ sf_session: F });
    expect(await session.readSessionId()).toBe(F);
  });

  test("W-03: sign-up failures (validation, EMAIL_TAKEN) set no sf_auth, no sf_session (when present), no rows, no revalidate", async () => {
    await signUpAs("taken@act.test");
    const G = uuid();
    guestCart(G);
    const snap = snapshot(getDatabase(), G);
    const users = (getDatabase().query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    for (const fields of [
      { email: "bad", password: PASSWORD, displayName: "x" },
      { email: "ok@act.test", password: "short", displayName: "x" },
      { email: "ok@act.test", password: PASSWORD, displayName: "" },
      { email: "TAKEN@act.test", password: PASSWORD, displayName: "x" },
    ]) {
      const s = browser({ sf_session: G });
      const r = (await run(signUp(null, form(fields)))) as AuthActionState;
      expect(r?.ok).toBe(false);
      expect(s.setCalls).toEqual([]);
      expect(revalidatePath).not.toHaveBeenCalled();
    }
    expect(snapshot(getDatabase(), G)).toEqual(snap);
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: users });
  });

  test("W-05: sign-in failure with no sf_session -> at most one fresh sf_session (R-3), no sf_auth, no merge", async () => {
    await signUpAs("w05@act.test");
    const s = browser();
    const r = (await run(signIn(null, form({ email: "w05@act.test", password: "wrong-pass-123" })))) as AuthActionState;
    expect(r?.code).toBe("INVALID_CREDENTIALS");
    expect(s.setsOf("sf_auth")).toEqual([]);
    expect(s.setsOf("sf_session").length).toBeLessThanOrEqual(1);
  });
});

describe("W-06..W-09, W-17, A-38, A-68: switching users and signing out", () => {
  test("W-06/A-38/A-68: signed in as A with guest GA -> sign in as B: TA revoked, only GA merged into KB, KA untouched", async () => {
    const A = await signUpAs("a06@act.test");
    const B = await signUpAs("b06@act.test", PASSWORD_B);
    seedIdentity(getDatabase(), A.key, { tag: "a06", slot: 1 });
    const GA = uuid();
    guestCart(GA, "prod_brass-desk-lamp");
    const ka = snapshot(getDatabase(), A.key);
    const s = browser({ sf_auth: A.token, sf_session: GA });
    const r = await run(signIn(null, form({ email: "b06@act.test", password: PASSWORD_B })));
    expect(r).toEqual({ redirect: "/account" });
    expect(resolves(A.token)).toBeNull();
    const tb = s.setsOf("sf_auth").at(-1)?.value as string;
    secrets.add(tb);
    expect(resolves(tb)).toBe(B.key);
    expect(snapshot(getDatabase(), A.key)).toEqual(ka);
    expect(zeroCounts(counts(getDatabase(), GA))).toBe(true);
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ? AND product_id = 'prod_brass-desk-lamp'").get(B.key)).toEqual({ n: 1 });
  });

  test("RULING (2026-11-07): a FAILED sign-in while signed in as A must not sign A out (TA revoked only after success)", async () => {
    const A = await signUpAs("keep@act.test");
    await signUpAs("other@act.test", PASSWORD_B);
    browser({ sf_auth: A.token, sf_session: uuid() });
    const r = (await run(signIn(null, form({ email: "other@act.test", password: "wrong-pass-123" })))) as AuthActionState;
    expect(r?.code).toBe("INVALID_CREDENTIALS");
    expect(resolves(A.token)).toBe(A.key);
    browser({ sf_auth: A.token });
    const r2 = (await run(signUp(null, form({ email: "bad-email", password: PASSWORD, displayName: "x" })))) as AuthActionState;
    expect(r2?.code).toBe("VALIDATION_FAILED");
    expect(resolves(A.token)).toBe(A.key);
  });

  test("W-07: signed in as A -> sign-up as C: TA revoked, GA merged into KC, KA unchanged", async () => {
    const A = await signUpAs("a07@act.test");
    seedIdentity(getDatabase(), A.key, { tag: "a07", slot: 1 });
    const GA = uuid();
    guestCart(GA);
    const ka = snapshot(getDatabase(), A.key);
    browser({ sf_auth: A.token, sf_session: GA });
    expect(await run(signUp(null, form({ email: "c07@act.test", password: PASSWORD, displayName: "C" })))).toEqual({ redirect: "/account" });
    expect(resolves(A.token)).toBeNull();
    const kc = (getDatabase().query("SELECT owner_key FROM users WHERE email = 'c07@act.test'").get() as { owner_key: string }).owner_key;
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ?").get(kc)).toEqual({ n: 1 });
    expect(snapshot(getDatabase(), A.key)).toEqual(ka);
  });

  test("W-08: sign-out clears sf_auth, rotates sf_session, revokes only this session, redirects /", async () => {
    const A = await signUpAs("w08@act.test");
    browser();
    const r2 = await run(signIn(null, form({ email: "w08@act.test", password: PASSWORD })));
    expect(r2).toEqual({ redirect: "/account" });
    const other = store.setsOf("sf_auth")[0]?.value as string;
    secrets.add(other);
    const GA = uuid();
    const s = browser({ sf_auth: A.token, sf_session: GA });
    expect(await run(signOut(null, form({})))).toEqual({ redirect: "/" });
    expect(s.isCleared("sf_auth")).toBe(true);
    const rotated = s.setsOf("sf_session").at(-1)?.value;
    expect(rotated).not.toBe(GA);
    expect(session.isSessionId(rotated)).toBe(true);
    expect(resolves(A.token)).toBeNull();
    expect(resolves(other)).toBe(A.key);
    expect(revalidatePath.mock.calls).toEqual([["/", "layout"]]);
    // A-36: replaying the signed-out token -> guest; signOutEverywhere -> UNAUTHENTICATED
    browser({ sf_auth: A.token, sf_session: GA });
    expect(await session.readSessionId()).toBe(GA);
    expect(errCode(await run(signOutEverywhere(null, form({}))))).toBe("UNAUTHENTICATED");
  });

  test("W-09 (R-3): sign-out without sf_auth still rotates sf_session and redirects /; nothing revoked", async () => {
    const A = await signUpAs("w09@act.test");
    for (const cookies of [{ sf_session: uuid() }, {}, { sf_session: uuid(), sf_auth: "garbage" }, { sf_auth: "x".repeat(1024 * 64) }]) {
      const s = browser(cookies);
      expect(await run(signOut(null, form({})))).toEqual({ redirect: "/" });
      const rotated = s.setsOf("sf_session").at(-1)?.value;
      expect(session.isSessionId(rotated)).toBe(true);
      expect(rotated).not.toBe((cookies as { sf_session?: string }).sf_session);
    }
    expect(activeSessions(A.id)).toBe(1);
  });

  test("W-17: auth only (no sf_session) sign-out -> cleared + guest cookie created by the rotation", async () => {
    const A = await signUpAs("w17@act.test");
    const s = browser({ sf_auth: A.token });
    expect(await run(signOut(null, form({})))).toEqual({ redirect: "/" });
    expect(s.isCleared("sf_auth")).toBe(true);
    expect(session.isSessionId(s.setsOf("sf_session").at(-1)?.value)).toBe(true);
    expect(resolves(A.token)).toBeNull();
  });

  test("auth.ts exports only signUp/signIn/signOut (signOutEverywhere lives only in account.ts)", () => {
    expect(Object.keys(authActions).sort()).toEqual(["signIn", "signOut", "signUp"]);
    expect(Object.keys(accountActions).sort()).toEqual(["changePassword", "deleteAccount", "signOutEverywhere", "updateProfile"]);
  });
});

describe("W-10..W-16: account settings actions", () => {
  test("W-10 (R-2): sign-out-everywhere revokes every A session incl. current, clears sf_auth, rotates sf_session, redirects /", async () => {
    const A = await signUpAs("w10@act.test");
    browser();
    await run(signIn(null, form({ email: "w10@act.test", password: PASSWORD })));
    const t2 = store.setsOf("sf_auth")[0]?.value as string;
    secrets.add(t2);
    const B = await signUpAs("w10b@act.test");
    const GA = uuid();
    const s = browser({ sf_auth: A.token, sf_session: GA });
    expect(await run(signOutEverywhere(null, form({})))).toEqual({ redirect: "/" });
    expect(activeSessions(A.id)).toBe(0);
    expect(activeSessions(B.id)).toBe(1);
    expect(s.isCleared("sf_auth")).toBe(true);
    expect(s.setsOf("sf_session").at(-1)?.value).not.toBe(GA);
    expect(resolves(t2)).toBeNull();
  });

  test("W-11/W-16: unauthenticated (none / expired / revoked / garbage / unknown / deleted user) -> UNAUTHENTICATED, no cookie writes, nothing changes", async () => {
    const A = await signUpAs("w16@act.test");
    const D = await signUpAs("w16d@act.test");
    const R = await signUpAs("w16r@act.test");
    const E = await signUpAs("w16e@act.test");
    getAuthService().signOut(R.token);
    getDatabase().query("UPDATE auth_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").run(E.id);
    getDatabase().query("DELETE FROM users WHERE id = ?").run(D.id);
    const before = JSON.stringify(getDatabase().query("SELECT * FROM users ORDER BY id").all());
    const jars = [{}, { sf_session: uuid() }, { sf_auth: R.token }, { sf_auth: E.token }, { sf_auth: D.token }, { sf_auth: "Z".repeat(43) }, { sf_auth: "x".repeat(10_000) }, { sf_session: A.key }];
    const calls: [string, () => Promise<AccountActionState>][] = [
      ["updateProfile", () => updateProfile(null, form({ displayName: "Hacked" }))],
      ["changePassword", () => changePassword(null, form({ currentPassword: PASSWORD, newPassword: "N3w-Passw0rd-qa", confirmPassword: "N3w-Passw0rd-qa" }))],
      ["deleteAccount", () => deleteAccount(null, form({ password: PASSWORD, confirm: "DELETE" }))],
      ["signOutEverywhere", () => signOutEverywhere(null, form({}))],
    ];
    for (const cookies of jars) {
      for (const [name, call] of calls) {
        const s = browser(cookies);
        const r = await run(call());
        expect([name, errCode(r)]).toEqual([name, "UNAUTHENTICATED"]);
        expect([name, s.setCalls]).toEqual([name, []]);
      }
    }
    expect(JSON.stringify(getDatabase().query("SELECT * FROM users ORDER BY id").all())).toBe(before);
  }, 30_000);

  test("W-12/A-35/A-78: change password success keeps current cookie (no writes), revokes other sessions; W-13 failure counts", async () => {
    const A = await signUpAs("w12@act.test");
    browser();
    await run(signIn(null, form({ email: "w12@act.test", password: PASSWORD })));
    const t2 = store.setsOf("sf_auth")[0]?.value as string;
    secrets.add(t2);
    let s = browser({ sf_auth: A.token });
    const wrong = (await run(changePassword(null, form({ currentPassword: "Wr0ng-pass-qa!", newPassword: "N3w-Passw0rd-qa", confirmPassword: "N3w-Passw0rd-qa" })))) as Exclude<AccountActionState, null>;
    expect(errCode(wrong)).toBe("INVALID_CREDENTIALS");
    expect(Object.keys((wrong as { fieldErrors: object }).fieldErrors)).toEqual(["currentPassword"]);
    expect(s.setCalls).toEqual([]);
    expect((getDatabase().query("SELECT failed_login_count AS n FROM users WHERE id = ?").get(A.id) as { n: number }).n).toBe(1);
    s = browser({ sf_auth: A.token });
    const r = (await run(changePassword(null, form({ currentPassword: PASSWORD, newPassword: "N3w-Passw0rd-qa", confirmPassword: "N3w-Passw0rd-qa" })))) as AccountActionState;
    expect(r).toMatchObject({ ok: true, kind: "password_changed" });
    expect(s.setCalls).toEqual([]);
    expect(resolves(A.token)).toBe(A.key);
    expect(resolves(t2)).toBeNull();
    // Replaying TA2 in any action -> UNAUTHENTICATED (A-35)
    browser({ sf_auth: t2 });
    expect(errCode(await run(updateProfile(null, form({ displayName: "x" }))))).toBe("UNAUTHENTICATED");
  });

  test("A-77 via action: same / weak / short / mismatch -> field errors on newPassword / confirmPassword; passwords never echoed", async () => {
    const A = await signUpAs("a77@act.test");
    const cases: [Record<string, string>, string][] = [
      [{ currentPassword: PASSWORD, newPassword: PASSWORD, confirmPassword: PASSWORD }, "newPassword"],
      [{ currentPassword: PASSWORD, newPassword: "password", confirmPassword: "password" }, "newPassword"],
      [{ currentPassword: PASSWORD, newPassword: "Sh0rt!7", confirmPassword: "Sh0rt!7" }, "newPassword"],
      [{ currentPassword: PASSWORD, newPassword: "N3w-Passw0rd-qa", confirmPassword: "N3w-Passw0rd-qX" }, "confirmPassword"],
      [{ newPassword: "N3w-Passw0rd-qa", confirmPassword: "N3w-Passw0rd-qa" }, "currentPassword"],
    ];
    for (const [fields, field] of cases) {
      browser({ sf_auth: A.token });
      const r = (await run(changePassword(null, form(fields)))) as { fieldErrors: Record<string, string> };
      expect([field, Object.keys(r.fieldErrors)]).toEqual([field, [field]]);
      const json = JSON.stringify(r);
      for (const v of Object.values(fields)) if (v !== "password") expect(json).not.toContain(v);
    }
  });

  test("W-14/A-76/A-81: delete success clears sf_auth, rotates, redirects /; data gone; second submit UNAUTHENTICATED; re-sign-up gets nothing", async () => {
    const A = await signUpAs("w14@act.test");
    seedIdentity(getDatabase(), A.key, { tag: "w14", slot: 2 });
    const GA = uuid();
    const s = browser({ sf_auth: A.token, sf_session: GA });
    const fd = form({ password: PASSWORD, confirm: "DELETE" });
    expect(await run(deleteAccount(null, fd))).toEqual({ redirect: "/" });
    expect(s.isCleared("sf_auth")).toBe(true);
    expect(s.setsOf("sf_session").at(-1)?.value).not.toBe(GA);
    expect(revalidatePath.mock.calls).toEqual([["/", "layout"]]);
    expect(zeroCounts(counts(getDatabase(), A.key))).toBe(true);
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(A.id)).toEqual({ n: 0 });
    browser({ sf_auth: A.token, sf_session: GA });
    expect(errCode(await run(deleteAccount(null, fd)))).toBe("UNAUTHENTICATED");
    const again = await signUpAs("W14@Act.test");
    expect(again.key).not.toBe(A.key);
    expect(again.id).not.toBe(A.id);
    expect(zeroCounts(counts(getDatabase(), again.key))).toBe(true);
  });

  test("W-15/A-80: delete failures (wrong password, 'delete', ' DELETE', missing confirm, missing password) change nothing", async () => {
    const A = await signUpAs("w15@act.test");
    seedIdentity(getDatabase(), A.key, { tag: "w15", slot: 2 });
    const before = counts(getDatabase(), A.key);
    const cases: [Record<string, string>, string][] = [
      [{ password: "Wr0ng-pass-qa!", confirm: "DELETE" }, "password"],
      [{ password: PASSWORD, confirm: "delete" }, "confirm"],
      [{ password: PASSWORD, confirm: " DELETE" }, "confirm"],
      [{ password: PASSWORD }, "confirm"],
      [{ confirm: "DELETE" }, "password"],
    ];
    for (const [fields, field] of cases) {
      const s = browser({ sf_auth: A.token });
      const r = (await run(deleteAccount(null, form(fields)))) as { fieldErrors: Record<string, string> };
      expect([fields, Object.keys(r.fieldErrors)]).toEqual([fields, [field]]);
      expect(s.setCalls).toEqual([]);
    }
    expect(counts(getDatabase(), A.key)).toEqual(before);
    expect(resolves(A.token)).toBe(A.key);
  });

  test("A-13/A-14: 6th changePassword (wrong current) and 6th delete and 21st updateProfile -> RATE_LIMITED; service not called", async () => {
    const A = await signUpAs("a13@act.test");
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      browser({ sf_auth: A.token });
      codes.push(errCode(await run(changePassword(null, form({ currentPassword: "Wr0ng-pass-qa!", newPassword: "N3w-Passw0rd-qa", confirmPassword: "N3w-Passw0rd-qa" })))));
    }
    expect(codes).toEqual(["INVALID_CREDENTIALS", "INVALID_CREDENTIALS", "INVALID_CREDENTIALS", "INVALID_CREDENTIALS", "INVALID_CREDENTIALS", "RATE_LIMITED"]);
    expect((getDatabase().query("SELECT failed_login_count AS n FROM users WHERE id = ?").get(A.id) as { n: number }).n).toBe(5);

    const B = await signUpAs("a14@act.test");
    const del: (string | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      browser({ sf_auth: B.token });
      del.push(errCode(await run(deleteAccount(null, form({ password: "Wr0ng-pass-qa!", confirm: "DELETE" })))));
    }
    expect(del.at(-1)).toBe("RATE_LIMITED");
    const prof: unknown[] = [];
    for (let i = 0; i < 21; i++) {
      browser({ sf_auth: B.token });
      prof.push(await run(updateProfile(null, form({ displayName: `Name ${i}` }))));
    }
    expect(errCode(prof[20])).toBe("RATE_LIMITED");
    expect((prof[20] as { retryAfterSeconds?: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect((getDatabase().query("SELECT display_name AS n FROM users WHERE id = ?").get(B.id) as { n: string }).n).toBe("Name 19");
  }, 30_000);

  test("R-10 (account boundary): a LOCKED account's changePassword/deleteAccount surface RATE_LIMITED with the limiter's exact shape", async () => {
    const A = await signUpAs("lock@act.test");
    getDatabase().query("UPDATE users SET failed_login_count = 10, locked_until = ? WHERE id = ?").run(new Date(Date.now() + 10 * 60_000).toISOString(), A.id);
    browser({ sf_auth: A.token });
    const locked = (await run(changePassword(null, form({ currentPassword: PASSWORD, newPassword: "N3w-Passw0rd-qa", confirmPassword: "N3w-Passw0rd-qa" })))) as Record<string, unknown>;
    expect(errCode(locked)).toBe("RATE_LIMITED");
    browser({ sf_auth: A.token });
    const lockedDel = (await run(deleteAccount(null, form({ password: PASSWORD, confirm: "DELETE" })))) as Record<string, unknown>;
    expect(errCode(lockedDel)).toBe("RATE_LIMITED");
    // limiter-produced state for comparison
    const B = await signUpAs("limit@act.test");
    let limited: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) {
      browser({ sf_auth: B.token });
      limited = (await run(deleteAccount(null, form({ password: "Wr0ng-pass-qa!", confirm: "DELETE" })))) as Record<string, unknown>;
    }
    expect(errCode(limited)).toBe("RATE_LIMITED");
    const shape = (s: Record<string, unknown>): unknown => ({
      keys: Object.keys(s).sort(),
      errorKeys: Object.keys(s.error as object).sort(),
      detailKeys: Object.keys(((s.error as { details?: object }).details ?? {}) as object).sort(),
      message: String(s.message).replace(/\d+ minutes?/, "N minutes"),
      fieldErrors: s.fieldErrors,
    });
    expect(shape(locked)).toEqual(shape(limited));
    expect(shape(lockedDel)).toEqual(shape(limited));
  }, 30_000);
});

describe("Next control-flow errors are never swallowed (T119 unstable_rethrow contract)", () => {
  const control = (): Error => Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/elsewhere;307;" });
  test("auth actions rethrow a control-flow error raised by cookies()", async () => {
    for (const fn of [() => signIn(null, form({ email: "x@y.test", password: PASSWORD })), () => signOut(null, form({}))]) {
      const err = control();
      browser();
      store.get = () => {
        throw err;
      };
      await expect(fn()).rejects.toBe(err);
    }
  });

  test("D-T121-1 (fixed): account actions rethrow a control-flow error raised by cookies()", async () => {
    const err = control();
    browser();
    store.get = () => {
      throw err;
    };
    await expect(updateProfile(null, form({ displayName: "x" }))).rejects.toBe(err);
  });
});

describe("W-18/A-67/A-69: merge failure and concurrency", () => {
  test("W-18/A-67: merge throws during sign-in -> INTERNAL_ERROR, no sf_auth, sf_session unchanged, no live session, guest intact", async () => {
    const A = await signUpAs("w18@act.test");
    const GA = uuid();
    seedIdentity(getDatabase(), GA, { tag: "w18", slot: 4 });
    const snap = snapshot(getDatabase(), GA);
    const drop = injectFailure(getDatabase(), "orders", "UPDATE");
    const s = browser({ sf_session: GA });
    const r = (await run(signIn(null, form({ email: "w18@act.test", password: PASSWORD })))) as AuthActionState;
    drop();
    expect(r?.code).toBe("INTERNAL_ERROR");
    expect(errCode(r)).toBe("INTERNAL_ERROR");
    expect(s.setsOf("sf_auth")).toEqual([]);
    expect(s.setsOf("sf_session")).toEqual([]);
    expect(activeSessions(A.id)).toBe(1); // only the sign-up session; the attempt's session is revoked
    expect(snapshot(getDatabase(), GA)).toEqual(snap);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("A-69: two concurrent sign-ins from the same guest jar -> both settle; KA equals a single merge", async () => {
    const A = await signUpAs("a69@act.test");
    const GA = uuid();
    seedIdentity(getDatabase(), GA, { tag: "a69", slot: 4 });
    browser({ sf_session: GA });
    const results = await Promise.allSettled([signIn(null, form({ email: "a69@act.test", password: PASSWORD })), signIn(null, form({ email: "a69@act.test", password: PASSWORD }))]);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toBeInstanceOf(RedirectSentinel);
    }
    for (const c of store.setsOf("sf_auth")) secrets.add(c.value);
    expect(zeroCounts(counts(getDatabase(), GA))).toBe(true);
    const c = counts(getDatabase(), A.key);
    expect(c).toMatchObject({ carts: 1, cart_items: 1, orders: 1, reviews: 1, addresses: 1, coupon_redemptions: 1 });
  }, 30_000);

  test("A-45: 8 KiB user-agent is stored truncated (<= 512) without error", async () => {
    reqHeaders = new Headers({ "user-agent": "U".repeat(8192) });
    try {
      await signUpAs("a45@act.test");
      const ua = (getDatabase().query("SELECT user_agent FROM auth_sessions").get() as { user_agent: string }).user_agent;
      expect(ua.length).toBeLessThanOrEqual(512);
    } finally {
      reqHeaders = new Headers({ "user-agent": "qa-agent/1.0" });
    }
  });
});

describe("A-83 open redirect via next; A-97..A-101, A-110..A-112 forged and hostile input", () => {
  test("A-83: signIn/signUp next matrix -> /account for hostile values, /orders kept", async () => {
    await signUpAs("next@act.test");
    const hostile = ["//evil.com", "https://evil.com", "/\\evil", "javascript:alert(1)", "%2F%2Fevil", "/%2F/evil.com", "/%2f%2fevil.com", " //evil.com", "http:/evil.com"];
    for (const next of hostile) {
      browser();
      expect([next, await run(signIn(null, form({ email: "next@act.test", password: PASSWORD, next })))]).toEqual([next, { redirect: "/account" }]);
      for (const c of store.setsOf("sf_auth")) secrets.add(c.value);
    }
    browser();
    expect(await run(signIn(null, form({ email: "next@act.test", password: PASSWORD, next: "/orders" })))).toEqual({ redirect: "/orders" });
    for (const c of store.setsOf("sf_auth")) secrets.add(c.value);
    let i = 0;
    for (const next of [...hostile, "/orders"]) {
      browser();
      const r = await run(signUp(null, form({ email: `n${i++}@next.test`, password: PASSWORD, displayName: "N", next })));
      for (const c of store.setsOf("sf_auth")) secrets.add(c.value);
      expect([next, r]).toEqual([next, { redirect: next === "/orders" ? "/orders" : "/account" }]);
      if (i % 5 === 0) getDatabase().run("DELETE FROM rate_limits WHERE key LIKE '%auth.signup%'");
    }
  }, 30_000);

  test("A-98: signUp with forged userId/ownerKey/sessionId/role/verified -> fresh owner key, forged values ignored", async () => {
    const B = await signUpAs("b98@act.test");
    const G = uuid();
    browser({ sf_session: G });
    const r = await run(signUp(null, form({ email: "a98@act.test", password: PASSWORD, displayName: "A", userId: B.id, ownerKey: B.key, sessionId: B.key, role: "admin", verified: "1" })));
    expect(r).toEqual({ redirect: "/account" });
    for (const c of store.setsOf("sf_auth")) secrets.add(c.value);
    const row = getDatabase().query("SELECT id, owner_key FROM users WHERE email = 'a98@act.test'").get() as { id: string; owner_key: string };
    expect(row.owner_key).not.toBe(B.key);
    expect(row.owner_key).not.toBe(G);
    expect(row.id).not.toBe(B.id);
    const cols = (getDatabase().query("SELECT name FROM pragma_table_info('users')").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("role");
    expect(cols).not.toContain("verified");
  });

  test("A-97/A-99: forged fields on account actions affect only the caller", async () => {
    const A = await signUpAs("a97@act.test");
    const B = await signUpAs("b97@act.test", PASSWORD_B);
    const bRow = JSON.stringify(getDatabase().query("SELECT * FROM users WHERE id = ?").get(B.id));
    const forged = { userId: B.id, ownerKey: B.key, sessionId: B.key, role: "admin", verified: "1", email: "b97@act.test" };
    browser({ sf_auth: A.token });
    const plain = await run(updateProfile(null, form({ displayName: "Alice X" })));
    browser({ sf_auth: A.token });
    const withForged = await run(updateProfile(null, form({ displayName: "Alice X", ...forged })));
    expect(withForged).toEqual(plain);
    const aRow = getDatabase().query("SELECT email, display_name FROM users WHERE id = ?").get(A.id);
    expect(aRow).toEqual({ email: "a97@act.test", display_name: "Alice X" });
    browser({ sf_auth: A.token });
    await run(changePassword(null, form({ currentPassword: PASSWORD, newPassword: "N3w-Passw0rd-qa", confirmPassword: "N3w-Passw0rd-qa", ...forged })));
    browser({ sf_auth: A.token });
    await run(signOutEverywhere(null, form(forged)));
    expect(JSON.stringify(getDatabase().query("SELECT * FROM users WHERE id = ?").get(B.id))).toBe(bRow);
    expect(resolves(B.token)).toBe(B.key);
    const A2 = await signUpAs("a97b@act.test");
    browser({ sf_auth: A2.token });
    await run(deleteAccount(null, form({ password: PASSWORD, confirm: "DELETE", ...forged })));
    expect(resolves(B.token)).toBe(B.key);
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(B.id)).toEqual({ n: 1 });
  }, 30_000);

  test("A-100: only contract field names are read from FormData", async () => {
    const A = await signUpAs("a100@act.test");
    const allowed = new Set(["email", "password", "displayName", "next", "currentPassword", "newPassword", "confirmPassword", "confirm"]);
    const cases: [(fd: FormData) => Promise<unknown>, Record<string, string>, Record<string, string>][] = [
      [(fd) => signIn(null, fd), { email: "a100@act.test", password: "wrong-pass-123" }, {}],
      [(fd) => signUp(null, fd), { email: "bad", password: "x", displayName: "x" }, {}],
      [(fd) => updateProfile(null, fd), { displayName: "x" }, { sf_auth: A.token }],
      [(fd) => changePassword(null, fd), { currentPassword: "a", newPassword: "b", confirmPassword: "c" }, { sf_auth: A.token }],
      [(fd) => deleteAccount(null, fd), { password: "a", confirm: "no" }, { sf_auth: A.token }],
    ];
    for (const [fn, fields, cookies] of cases) {
      const spy = spyFormData({ ...fields, userId: "x", ownerKey: "x", sessionId: "x", role: "x" });
      browser(cookies);
      await run(fn(spy.form) as Promise<unknown>);
      for (const read of spy.reads) {
        const [method, name] = read.split(":");
        expect([read, method === "get" && allowed.has(name as string)]).toEqual([read, true]);
      }
    }
  }, 30_000);

  test("A-101/A-106/A-110/A-111/A-112: hostile inputs through signUp/signIn: fast field errors, no hashing, password never echoed", async () => {
    const cases: Record<string, string | Blob>[] = [
      { email: "q".repeat(1024 * 1024), password: PASSWORD, displayName: "x" },
      { email: "ok1@act.test", password: "\u{1F600}".repeat(3) + "z", displayName: "x" },
      { email: "ok2@act.test", password: "z".repeat(129), displayName: "x" },
      { email: "ok3@act.test", password: PASSWORD, displayName: "n".repeat(51) },
      { email: new Blob(["a@b.c"]), password: PASSWORD, displayName: "x" },
      { email: "ok4@act.test", password: new Blob([PASSWORD]), displayName: "x" },
    ];
    for (const c of cases) {
      hasher.reset();
      browser();
      const t = performance.now();
      const r = (await run(signUp(null, form(Object.entries(c))))) as Exclude<AuthActionState, null>;
      expect(performance.now() - t).toBeLessThan(2000); // generous; the structural check is 0 hasher calls
      expect(r.ok).toBe(false);
      expect(r.code).toBe("VALIDATION_FAILED");
      expect(hasher.calls.hash).toBe(0);
      expect(JSON.stringify(r)).not.toContain(PASSWORD);
      expect(Object.keys(r.values)).not.toContain("password");
    }
    // duplicated keys: first value wins
    browser();
    const dup = new FormData();
    dup.append("email", "first@dup.test");
    dup.append("email", "second@dup.test");
    dup.append("password", PASSWORD);
    dup.append("displayName", "D");
    expect(await run(signUp(null, dup))).toEqual({ redirect: "/account" });
    for (const c of store.setsOf("sf_auth")) secrets.add(c.value);
    expect(getDatabase().query("SELECT email FROM users WHERE email LIKE '%dup.test'").all()).toEqual([{ email: "first@dup.test" }]);
    // Echo: email and display name come back, never the password
    browser();
    const echo = (await run(signUp(null, form({ email: "echo@act.test", password: "short", displayName: "Echo Name" })))) as Exclude<AuthActionState, null>;
    expect(echo.values).toEqual({ email: "echo@act.test", displayName: "Echo Name" });
    browser();
    const echo2 = (await run(signIn(null, form({ email: "echo@act.test", password: "wrong-pass-123" })))) as Exclude<AuthActionState, null>;
    expect(JSON.stringify(echo2)).not.toContain("wrong-pass-123");
  }, 30_000);
});

// ===========================================================================
// Part B: auth-core with real session helpers, real services, injected clock
// ===========================================================================

const HOUR = 3_600_000;
const BASE = Math.floor(Date.now() / HOUR) * HOUR + 24 * HOUR; // aligned to 900 s / 3600 s, in the future

function coreActions(clock: { now(): number }): ReturnType<typeof createAuthActions> {
  const db = getDatabase();
  return createAuthActions({
    auth: createAuthService({ db, hasher, now: clock.now }),
    merge: createMergeService({ db }),
    getOrCreateGuestSessionId: async () => (await session.readGuestSessionId()) ?? (await session.rotateGuestSession()),
    readGuestSessionId: session.readGuestSessionId,
    readAuthToken: session.readAuthToken,
    setAuthCookie: session.setAuthCookie,
    clearAuthCookie: session.clearAuthCookie,
    rotateGuestSession: session.rotateGuestSession,
    userAgent: async () => "qa",
    revalidatePath,
    redirect,
    now: clock.now,
  });
}

async function addCoreUser(email: string): Promise<void> {
  const repo = createAuthRepository(getDatabase());
  const r = repo.createUser({ email, passwordHash: await hasher.hash(PASSWORD), displayName: "Q" });
  if (!r.ok) throw new Error("user");
  hasher.reset();
}

describe("T122-1/2 at the action boundary (R-10: lock and limit -> identical RATE_LIMITED state)", () => {
  test("A-01 (act): one browser, 200 sign-ins across 20 emails -> 10 INVALID_CREDENTIALS then TOO_MANY_ATTEMPTS/RATE_LIMITED", async () => {
    const clock = { t: BASE, now: () => clock.t };
    const a = coreActions(clock);
    for (let i = 0; i < 20; i++) await addCoreUser(`s${i}@core.test`);
    browser();
    const codes: string[] = [];
    for (let i = 0; i < 200; i++) {
      const r = (await run(a.signIn(null, form({ email: `s${i % 20}@core.test`, password: "wrong-pass-123" })))) as Exclude<AuthActionState, null>;
      codes.push(`${r.code}/${r.error.code}`);
      if (i >= 10) {
        expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(r.message).toMatch(/^Too many attempts\. Try again in \d+ minutes?\.$/);
      }
      nextRequest();
    }
    expect(codes.slice(0, 10)).toEqual(Array(10).fill("INVALID_CREDENTIALS/INVALID_CREDENTIALS"));
    expect(codes.slice(10)).toEqual(Array(190).fill("TOO_MANY_ATTEMPTS/RATE_LIMITED"));
    expect(hasher.calls.verify).toBe(10);
  }, 30_000);

  test("A-02 (act) + criterion 2: 20 fresh browsers on one email; known vs unknown byte-identical at 1-9, 10, 11; lock state == limit state", async () => {
    const runOne = async (withUser: boolean): Promise<{ states: string[]; verifies: number; afterLock: string; unlocked: unknown }> => {
      resetApp();
      hasher.reset();
      if (withUser) await addCoreUser("kate@x.com");
      const clock = { t: BASE, now: () => clock.t };
      const a = coreActions(clock);
      const out: string[] = [];
      for (let i = 0; i < 20; i++) {
        browser({ sf_session: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}` });
        const r = await run(a.signIn(null, form({ email: "kate@x.com", password: "wrong-pass-123" })));
        expect(store.setsOf("sf_auth")).toEqual([]);
        out.push(JSON.stringify(r));
      }
      const verifies = hasher.calls.verify;
      // correct password during the lock -> rejected with the same state family, no cookie
      clock.t = BASE + 5 * 60_000;
      browser({ sf_session: uuid() });
      const during = await run(a.signIn(null, form({ email: "kate@x.com", password: PASSWORD })));
      expect(store.setsOf("sf_auth")).toEqual([]);
      // lock expires by clock advance
      clock.t = BASE + 16 * 60_000;
      browser({ sf_session: uuid() });
      const unlocked = await run(a.signIn(null, form({ email: "kate@x.com", password: PASSWORD })));
      for (const c of store.setsOf("sf_auth")) secrets.add(c.value);
      return { states: out, verifies, afterLock: JSON.stringify(during), unlocked };
    };
    const known = await runOne(true);
    const unknown = await runOne(false);
    for (let i = 0; i < 11; i++) expect([i + 1, known.states[i]]).toEqual([i + 1, unknown.states[i]]);
    expect(known.verifies).toBe(unknown.verifies);
    expect(known.verifies).toBe(10);
    const parsed = known.states.map((s) => JSON.parse(s) as Exclude<AuthActionState, null>);
    for (let i = 0; i < 9; i++) {
      expect(parsed[i]).toMatchObject({ code: "INVALID_CREDENTIALS", message: INVALID_MSG, error: { code: "INVALID_CREDENTIALS", message: INVALID_MSG } });
    }
    for (let i = 9; i < 20; i++) expect([i + 1, parsed[i]?.code, parsed[i]?.error.code]).toEqual([i + 1, "TOO_MANY_ATTEMPTS", "RATE_LIMITED"]);
    // 10th (lock reached) and 11th (limiter) have the identical shape
    const shape = (s: Exclude<AuthActionState, null>): unknown => ({ ...s, message: s.message.replace(/\d+/, "N"), error: { ...s.error, message: s.error.message.replace(/\d+/, "N"), details: Object.keys(s.error.details ?? {}) }, retryAfterSeconds: typeof s.retryAfterSeconds });
    expect(shape(parsed[9] as Exclude<AuthActionState, null>)).toEqual(shape(parsed[10] as Exclude<AuthActionState, null>));
    expect(JSON.parse(known.afterLock)).toMatchObject({ code: "TOO_MANY_ATTEMPTS", error: { code: "RATE_LIMITED" } });
    expect(known.unlocked).toEqual({ redirect: "/account" });
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
  }, 30_000);

  test("A-08 (act): per-browser limit reached -> correct password RATE_LIMITED, no sf_auth, no verify", async () => {
    const clock = { t: BASE, now: () => clock.t };
    const a = coreActions(clock);
    await addCoreUser("valid@core.test");
    browser();
    for (let i = 0; i < 10; i++) {
      await run(a.signIn(null, form({ email: `z${i}@core.test`, password: "wrong-pass-123" })));
      nextRequest();
    }
    const v = hasher.calls.verify;
    const r = (await run(a.signIn(null, form({ email: "valid@core.test", password: PASSWORD })))) as Exclude<AuthActionState, null>;
    expect(r.error.code).toBe("RATE_LIMITED");
    expect(store.setsOf("sf_auth")).toEqual([]);
    expect(hasher.calls.verify).toBe(v);
  });
});

// ===========================================================================
// Criterion 7: leakage (actions) - last
// ===========================================================================

describe("T122-7 secret leakage (actions)", () => {
  test("A-88/A-89/A-91/A-92: console, states, cookies and redirect URLs carry no password, hash, token hash or owner key", () => {
    try {
      secrets.harvest(getDatabase());
    } catch {
      /* closed */
    }
    for (const c of store.setCalls) allSetCalls.push({ name: c.name, value: c.value });
    expect(secrets.find(capture.lines.join("\n"), true)).toEqual([]);
    for (const s of states) expect(secrets.find(JSON.stringify(s), true)).toEqual([]);
    for (const url of redirects) expect(secrets.find(url, true)).toEqual([]);
    for (const url of redirects) expect(url).not.toMatch(/@|password|token/i);
    for (const c of allSetCalls) {
      if (c.name === "sf_auth") {
        expect(c.value === "" || /^[A-Za-z0-9_-]{43}$/.test(c.value)).toBe(true);
        continue;
      }
      expect(secrets.find(c.value, true)).toEqual([]);
    }
  });
});
