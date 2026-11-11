import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  ACCOUNT_FIELD,
  type AccountActionFn,
  type AccountActionState,
} from "@/components/molecules/_contracts/account-actions";
import { appError, type AppError, type Result } from "@/lib/result";
import type { User } from "@/lib/types";
import { createAccountRepository } from "@/server/auth/account-repository";
import { createAccountService, type AccountService } from "@/server/auth/account-service";
import { createAuthRepository } from "@/server/auth/auth-repository";
import { createAuthService, type AuthService } from "@/server/auth/auth-service";
import { validatePassword, type PasswordHasher } from "@/server/auth/password-policy";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createRateLimiter, type RateLimiter, type RateLimitOk, type RateLimitRule } from "@/server/security/rate-limiter";
import {
  ACCOUNT_ACTION_FAILED,
  ACCOUNT_CLEANUP_FAILED,
  ACCOUNT_MESSAGES,
  createAccountActions,
  precheckDelete,
  precheckPasswordChange,
  readField,
  tooManyAttemptsMessage,
  tooManyAttemptsState,
  type AccountActionDeps,
  type AccountActions,
} from "./account-core";

// ---------------------------------------------------------------------------
// Fixture: real :memory: DB, real T116 auth service (fast salted hasher), real
// T118 account service, real T31 limiter. The cookie jar is simulated: the
// "browser" holds an auth token; readResolvedAuth resolves it via the auth
// service, exactly like current-user.ts does.
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const PASSWORD = "correct horse 7391";
const NEW_PASSWORD = "battery staple 8842";
const B_PASSWORD = "user b secret 5520";
const TOTE = "prod_canvas-tote-bag";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const fastHasher: PasswordHasher = {
  async hash(password) {
    const salt = crypto.randomUUID();
    return `fast$${salt}$${sha256(salt + password)}`;
  },
  async verify(password, hash) {
    const [, salt, digest] = hash.split("$");
    return salt !== undefined && digest === sha256(salt + password);
  },
};

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

interface Jar {
  auth: string | null;
  guest: string;
}

interface Calls {
  readonly service: string[];
  readonly limiter: string[];
  readonly cookies: string[];
  readonly revalidate: [string, string | undefined][];
  readonly redirect: string[];
  readonly logs: string[];
}

interface Harness {
  readonly db: Database;
  readonly authService: AuthService;
  readonly actions: AccountActions;
  readonly jar: Jar;
  readonly calls: Calls;
  readonly a: User;
  readonly b: User;
  readonly aOtherToken: string;
  readonly bToken: string;
  readonly clock: { now: number };
  /** Every state returned, for the secrets sweep. */
  readonly states: AccountActionState[];
  run(fn: keyof AccountActions, fields: Record<string, string | Blob> | FormData): Promise<AccountActionState>;
  failedCount(userId: string): number;
}

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** Builds FormData the way a browser serialises a multipart form post (incl. Next's $ACTION_ID field). */
async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryA1b2C3d4E5f6G7h8";
  const all: readonly (readonly [string, string])[] = [["$ACTION_ID_0123abcd", ""], ...fields];
  const body =
    all.map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("") +
    `--${boundary}--\r\n`;
  return new Request("http://localhost/account/settings", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  }).formData();
}

function countingLimiter(inner: RateLimiter, calls: string[]): RateLimiter {
  return {
    check(key: string, rule: RateLimitRule): Result<RateLimitOk, AppError> {
      calls.push(key);
      return inner.check(key, rule);
    },
  };
}

function countingAccount(inner: AccountService, calls: string[]): AccountService {
  return {
    updateDisplayName: (...args) => {
      calls.push("updateDisplayName");
      return inner.updateDisplayName(...args);
    },
    changePassword: (...args) => {
      calls.push("changePassword");
      return inner.changePassword(...args);
    },
    deleteAccount: (...args) => {
      calls.push("deleteAccount");
      return inner.deleteAccount(...args);
    },
  };
}

async function createHarness(overrides: Partial<AccountActionDeps> = {}): Promise<Harness> {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const clock = { now: T0 };
  const now = (): number => clock.now;
  const authService = createAuthService({ db, hasher: fastHasher, now });
  const repo = createAuthRepository(db);
  const accountService = createAccountService({
    db,
    verifyPassword: (id, pw, at) => authService.verifyPassword(id, pw, at),
    hashPassword: (pw) => fastHasher.hash(pw),
    validatePassword,
    revokeOthers: (id, keep, at) => repo.revokeOthers(id, keep, at),
    now,
    logger: { error: () => undefined, warn: () => undefined },
  });

  async function makeUser(email: string, password: string, displayName: string): Promise<User> {
    const created = repo.createUser({ email, passwordHash: await fastHasher.hash(password), displayName }, T0);
    if (!created.ok) throw new Error("fixture createUser");
    return created.value;
  }
  function issue(userId: string): string {
    const issued = authService.issueSessionFor(userId, { sessionKey: null, now: clock.now });
    if (!issued.ok) throw new Error("fixture session");
    return issued.value.token;
  }

  const a = await makeUser("ada@example.com", PASSWORD, "Ada");
  const b = await makeUser("bob@example.com", B_PASSWORD, "Bob");
  const aToken = issue(a.id);
  const aOtherToken = issue(a.id);
  const bToken = issue(b.id);

  const jar: Jar = { auth: aToken, guest: crypto.randomUUID() };
  const calls: Calls = { service: [], limiter: [], cookies: [], revalidate: [], redirect: [], logs: [] };
  const states: AccountActionState[] = [];

  const actions = createAccountActions({
    account: countingAccount(accountService, calls.service),
    auth: {
      signOutEverywhere: (userId, at) => {
        calls.service.push("signOutEverywhere");
        return authService.signOutEverywhere(userId, at);
      },
    },
    limiter: countingLimiter(createRateLimiter(db, { now }), calls.limiter),
    readResolvedAuth: async () => {
      const resolved = jar.auth === null ? null : authService.resolveToken(jar.auth, clock.now);
      return resolved === null ? null : { user: resolved.user, authSessionId: resolved.authSessionId };
    },
    clearAuthCookie: async () => {
      calls.cookies.push("clearAuthCookie");
      jar.auth = null;
    },
    rotateGuestSession: async () => {
      calls.cookies.push("rotateGuestSession");
      jar.guest = crypto.randomUUID();
      return jar.guest;
    },
    revalidatePath: (path, type) => {
      calls.revalidate.push([path, type]);
    },
    redirect: (path) => {
      calls.redirect.push(path);
      throw new RedirectSentinel(path);
    },
    now,
    logger: { error: (...args: unknown[]) => void calls.logs.push(args.map(String).join(" ")) },
    ...overrides,
  });

  return {
    db,
    authService,
    actions,
    jar,
    calls,
    a,
    b,
    aOtherToken,
    bToken,
    clock,
    states,
    async run(fn, fields) {
      const fd = fields instanceof FormData ? fields : form(fields);
      const state = await actions[fn](null, fd);
      states.push(state);
      return state;
    },
    failedCount(userId) {
      return db.query<{ n: number }, [string]>("SELECT failed_login_count AS n FROM users WHERE id = ?").get(userId)?.n ?? -1;
    },
  };
}

function expectError(state: AccountActionState): Extract<NonNullable<AccountActionState>, { ok: false }> {
  if (state === null || state.ok) throw new Error(`expected error state, got ${JSON.stringify(state)}`);
  return state;
}

function userRow(db: Database, id: string): { display_name: string; password_hash: string } | null {
  return db
    .query<{ display_name: string; password_hash: string }, [string]>("SELECT display_name, password_hash FROM users WHERE id = ?")
    .get(id);
}

function nothingSideEffecting(h: Harness): void {
  expect(h.calls.service).toEqual([]);
  expect(h.calls.limiter).toEqual([]);
  expect(h.calls.cookies).toEqual([]);
  expect(h.calls.revalidate).toEqual([]);
  expect(h.calls.redirect).toEqual([]);
}

const ALL_ACTIONS: readonly (keyof AccountActions)[] = ["updateProfile", "changePassword", "deleteAccount", "signOutEverywhere"];

const VALID_FIELDS: Readonly<Record<keyof AccountActions, Record<string, string>>> = {
  updateProfile: { displayName: "New Name" },
  changePassword: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD },
  deleteAccount: { password: PASSWORD, confirm: "DELETE" },
  signOutEverywhere: {},
};

// ---------------------------------------------------------------------------
// Unauthenticated (criterion 1, W-16)
// ---------------------------------------------------------------------------

describe("unauthenticated callers (T121 AC1, W-16)", () => {
  for (const scenario of ["no cookie", "garbage token", "revoked token", "expired token"] as const) {
    test(`${scenario}: every action returns UNAUTHENTICATED and changes nothing`, async () => {
      const h = await createHarness();
      if (scenario === "no cookie") h.jar.auth = null;
      if (scenario === "garbage token") h.jar.auth = "not-a-token";
      if (scenario === "revoked token") h.authService.signOutEverywhere(h.a.id, T0);
      if (scenario === "expired token") h.clock.now = T0 + 31 * 24 * 3_600_000;
      const before = JSON.stringify(h.db.query("SELECT * FROM users ORDER BY id").all());
      for (const fn of ALL_ACTIONS) {
        const state = expectError(await h.run(fn, { ...VALID_FIELDS[fn] }));
        expect(state).toEqual({
          ok: false,
          error: { code: "UNAUTHENTICATED", message: "Please sign in." },
          message: "Please sign in.",
          fieldErrors: {},
          values: {},
        });
      }
      nothingSideEffecting(h);
      expect(JSON.stringify(h.db.query("SELECT * FROM users ORDER BY id").all())).toBe(before);
    });
  }
});

// ---------------------------------------------------------------------------
// updateProfile (criterion 2)
// ---------------------------------------------------------------------------

describe("updateProfile", () => {
  test("success stores the cleaned name, echoes it and revalidates the layout and /account", async () => {
    const h = await createHarness();
    const state = await h.run("updateProfile", { displayName: "  Ada   L.  " });
    expect(state).toEqual({ ok: true, kind: "profile_updated", message: ACCOUNT_MESSAGES.profileUpdated, displayName: "Ada L." });
    expect(userRow(h.db, h.a.id)?.display_name).toBe("Ada L.");
    expect(h.calls.revalidate).toEqual([
      ["/", "layout"],
      ["/account", undefined],
    ]);
    expect(h.calls.limiter).toEqual([`account.updateProfile:${h.a.ownerKey}`]);
    expect(h.calls.cookies).toEqual([]);
  });

  test("forged userId / ownerKey / sessionId / email fields are ignored: only the caller changes", async () => {
    const h = await createHarness();
    const state = await h.run("updateProfile", {
      displayName: "Changed",
      userId: h.b.id,
      ownerKey: h.b.ownerKey,
      sessionId: h.b.ownerKey,
      email: h.b.email,
    });
    expect(state).toMatchObject({ ok: true });
    expect(userRow(h.db, h.a.id)?.display_name).toBe("Changed");
    expect(userRow(h.db, h.b.id)?.display_name).toBe("Bob");
    expect(h.calls.limiter).toEqual([`account.updateProfile:${h.a.ownerKey}`]);
  });

  test("empty, whitespace-only, 51 chars, missing and File entries are rejected on displayName with no limiter cost", async () => {
    const h = await createHarness();
    const cases: [Record<string, string | Blob>, string, string | undefined][] = [
      [{ displayName: "" }, "REQUIRED", ""],
      [{ displayName: "   " }, "REQUIRED", "   "],
      [{ displayName: "x".repeat(51) }, "TOO_LONG", "x".repeat(50)],
      [{}, "REQUIRED", undefined],
      [{ displayName: new Blob(["Evil"]) }, "REQUIRED", undefined],
    ];
    for (const [fields, code, echoed] of cases) {
      const state = expectError(await h.run("updateProfile", fields));
      expect(state.error.code).toBe("VALIDATION_FAILED");
      expect(state.error.details).toEqual({ fields: { displayName: code } });
      expect(Object.keys(state.fieldErrors)).toEqual(["displayName"]);
      expect(state.values).toEqual(echoed === undefined ? {} : { displayName: echoed });
    }
    expect(h.calls.limiter).toEqual([]);
    expect(h.calls.service).toEqual([]);
    expect(userRow(h.db, h.a.id)?.display_name).toBe("Ada");
  });

  test("hostile markup is stored and echoed as plain text; 50 chars accepted", async () => {
    const h = await createHarness();
    const hostile = "<img src=x onerror=alert(1)>";
    expect(await h.run("updateProfile", { displayName: hostile })).toMatchObject({ ok: true, displayName: hostile });
    expect(userRow(h.db, h.a.id)?.display_name).toBe(hostile);
    expect(await h.run("updateProfile", { displayName: "y".repeat(50) })).toMatchObject({ ok: true, displayName: "y".repeat(50) });
  });

  test("21st update in an hour is RATE_LIMITED with retryAfterSeconds and the service is not called (AC5)", async () => {
    const h = await createHarness();
    for (let i = 0; i < 20; i++) expect(await h.run("updateProfile", { displayName: `Name ${i}` })).toMatchObject({ ok: true });
    h.calls.service.length = 0;
    const state = expectError(await h.run("updateProfile", { displayName: "Name 21" }));
    expect(state.error.code).toBe("RATE_LIMITED");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.message).toMatch(/^Too many attempts\. Try again in \d+ minutes?\.$/);
    expect(state.values).toEqual({ displayName: "Name 21" });
    expect(h.calls.service).toEqual([]);
    expect(userRow(h.db, h.a.id)?.display_name).toBe("Name 19");
  });

  test("user B's budget is separate from user A's (keyed per owner key)", async () => {
    const h = await createHarness();
    for (let i = 0; i < 20; i++) await h.run("updateProfile", { displayName: `A ${i}` });
    h.jar.auth = h.bToken;
    expect(await h.run("updateProfile", { displayName: "B ok" })).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// changePassword (criterion 3, W-12, W-13, A-77, A-78)
// ---------------------------------------------------------------------------

describe("changePassword", () => {
  test("success keeps the current session, revokes others, returns password_changed, writes no cookie", async () => {
    const h = await createHarness();
    const currentToken = h.jar.auth;
    const state = await h.run("changePassword", { ...VALID_FIELDS.changePassword });
    expect(state).toEqual({ ok: true, kind: "password_changed", message: ACCOUNT_MESSAGES.passwordChanged });
    expect(h.calls.cookies).toEqual([]);
    expect(h.calls.redirect).toEqual([]);
    expect(h.calls.revalidate).toEqual([["/", "layout"]]);
    expect(h.authService.resolveToken(currentToken, T0)?.user.id).toBe(h.a.id);
    expect(h.authService.resolveToken(h.aOtherToken, T0)).toBeNull();
    expect(h.authService.resolveToken(h.bToken, T0)?.user.id).toBe(h.b.id);
    expect((await h.authService.verifyPassword(h.a.id, NEW_PASSWORD, T0)).ok).toBe(true);
    expect((await h.authService.verifyPassword(h.a.id, PASSWORD, T0)).ok).toBe(false);
  });

  test("confirm mismatch -> confirmPassword error before the service: no limiter, no lockout count (W-15 analogue)", async () => {
    const h = await createHarness();
    const state = expectError(
      await h.run("changePassword", { currentPassword: "WRONG wrong 1", newPassword: NEW_PASSWORD, confirmPassword: `${NEW_PASSWORD}x` }),
    );
    expect(state.error.code).toBe("VALIDATION_FAILED");
    expect(state.fieldErrors).toEqual({ confirmPassword: ACCOUNT_MESSAGES.confirmPasswordMismatch });
    expect(state.values).toEqual({});
    expect(h.calls.limiter).toEqual([]);
    expect(h.calls.service).toEqual([]);
    expect(h.failedCount(h.a.id)).toBe(0);
  });

  test("wrong current password -> INVALID_CREDENTIALS on currentPassword, counts toward lockout (W-13, A-77)", async () => {
    const h = await createHarness();
    const state = expectError(
      await h.run("changePassword", { currentPassword: "not my password", newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }),
    );
    expect(state.error.code).toBe("INVALID_CREDENTIALS");
    expect(state.fieldErrors).toEqual({ currentPassword: ACCOUNT_MESSAGES.currentPasswordIncorrect });
    expect(state.message).toBe(ACCOUNT_MESSAGES.currentPasswordIncorrect);
    expect(h.failedCount(h.a.id)).toBe(1);
    expect(h.calls.cookies).toEqual([]);
    expect(h.calls.revalidate).toEqual([]);
    expect(h.authService.resolveToken(h.aOtherToken, T0)).not.toBeNull();
  });

  test("policy failures land on newPassword: too short, too long, weak, email local part, same as current (A-77)", async () => {
    const h = await createHarness();
    const cases: [string, string][] = [
      ["short12", "TOO_SHORT"],
      ["x".repeat(129), "TOO_LONG"],
      ["password", "WEAK"],
      ["Password", "WEAK"],
      ["ada", "TOO_SHORT"],
      ["ada@example.com", "WEAK"],
      ["", "REQUIRED"],
      [PASSWORD, "SAME_AS_CURRENT"],
    ];
    for (const [pw, code] of cases) {
      const state = expectError(await h.run("changePassword", { currentPassword: PASSWORD, newPassword: pw, confirmPassword: pw }));
      expect(state.error.code).toBe("VALIDATION_FAILED");
      expect(state.error.details).toEqual({ fields: { newPassword: code } });
      expect(Object.keys(state.fieldErrors)).toEqual(["newPassword"]);
    }
    // Only SAME_AS_CURRENT needed the service (one limiter token, no lockout count: current was correct).
    expect(h.calls.service).toEqual(["changePassword"]);
    expect(h.failedCount(h.a.id)).toBe(0);
  });

  test("missing current password -> currentPassword REQUIRED, all field errors reported together", async () => {
    const h = await createHarness();
    const state = expectError(await h.run("changePassword", { newPassword: "short", confirmPassword: "other" }));
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["confirmPassword", "currentPassword", "newPassword"]);
    expect(h.calls.service).toEqual([]);
  });

  test("locked account -> state byte-identical to RATE_LIMITED, error.code included (R-10)", async () => {
    const h = await createHarness();
    const repo = createAuthRepository(h.db);
    for (let i = 0; i < 10; i++) repo.recordLoginFailure(h.a.id, T0);
    const locked = expectError(await h.run("changePassword", { ...VALID_FIELDS.changePassword }));
    expect(locked).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many attempts. Try again in 15 minutes.", details: { retryAfterSeconds: 900 } },
      message: "Too many attempts. Try again in 15 minutes.",
      fieldErrors: {},
      values: {},
      retryAfterSeconds: 900,
    });
    expect(h.calls.service).toEqual(["changePassword"]);
    expect(locked.message).toBe("Too many attempts. Try again in 15 minutes.");
    expect(locked.fieldErrors).toEqual({});

    for (let i = 0; i < 4; i++) await h.run("changePassword", { ...VALID_FIELDS.changePassword });
    h.calls.service.length = 0;
    const limited = expectError(await h.run("changePassword", { ...VALID_FIELDS.changePassword }));
    expect(limited.error.code).toBe("RATE_LIMITED");
    expect(limited.message).toBe("Too many attempts. Try again in 15 minutes.");
    expect(h.calls.service).toEqual([]);
    // Byte-identical: the locked state (from the service) equals the limiter state.
    expect(limited).toEqual(locked);
    expect(JSON.stringify(limited)).toBe(JSON.stringify(locked));
  });

  test("6th attempt in 15 minutes is RATE_LIMITED; the password is not verified (AC5)", async () => {
    const h = await createHarness();
    for (let i = 0; i < 5; i++) {
      await h.run("changePassword", { currentPassword: `wrong ${i} xyz`, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    }
    expect(h.failedCount(h.a.id)).toBe(5);
    const state = expectError(await h.run("changePassword", { ...VALID_FIELDS.changePassword }));
    expect(state.error.code).toBe("RATE_LIMITED");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.failedCount(h.a.id)).toBe(5);
    expect((await h.authService.verifyPassword(h.a.id, PASSWORD, T0)).ok).toBe(true);
  });

  test("forged userId cannot change user B's password", async () => {
    const h = await createHarness();
    const bHash = userRow(h.db, h.b.id)?.password_hash;
    await h.run("changePassword", { ...VALID_FIELDS.changePassword, userId: h.b.id, ownerKey: h.b.ownerKey });
    expect(userRow(h.db, h.b.id)?.password_hash).toBe(bHash);
    expect(h.authService.resolveToken(h.bToken, T0)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteAccount (criterion 4, W-14, W-15, A-80, A-81)
// ---------------------------------------------------------------------------

function seedOwnedRows(db: Database, ownerKey: string): void {
  db.query("INSERT INTO product_views (session_id, product_id) VALUES (?, ?)").run(ownerKey, TOTE);
}

function ownedTotal(db: Database, ownerKey: string): number {
  return Object.values(createAccountRepository(db).countOwnedRows(ownerKey)).reduce((s, n) => s + n, 0);
}

describe("deleteAccount", () => {
  test("invalid confirm / missing password -> error on the right field; nothing deleted, no limiter (A-80, W-15)", async () => {
    const h = await createHarness();
    seedOwnedRows(h.db, h.a.ownerKey);
    const cases: [Record<string, string>, string[]][] = [
      [{ password: PASSWORD, confirm: "delete" }, ["confirm"]],
      [{ password: PASSWORD, confirm: " DELETE" }, ["confirm"]],
      [{ password: PASSWORD, confirm: "DELETE " }, ["confirm"]],
      [{ password: PASSWORD }, ["confirm"]],
      [{ confirm: "DELETE" }, ["password"]],
      [{ password: "", confirm: "DELETE" }, ["password"]],
      [{}, ["confirm", "password"]],
    ];
    for (const [fields, keys] of cases) {
      const state = expectError(await h.run("deleteAccount", fields));
      expect(state.error.code).toBe("VALIDATION_FAILED");
      expect(Object.keys(state.fieldErrors).sort()).toEqual(keys);
    }
    expect(h.calls.limiter).toEqual([]);
    nothingSideEffecting(h);
    expect(userRow(h.db, h.a.id)).not.toBeNull();
    expect(ownedTotal(h.db, h.a.ownerKey)).toBe(1);
  });

  test("wrong password -> INVALID_CREDENTIALS on password; nothing deleted; cookies untouched", async () => {
    const h = await createHarness();
    seedOwnedRows(h.db, h.a.ownerKey);
    const state = expectError(await h.run("deleteAccount", { password: "wrong password 1", confirm: "DELETE" }));
    expect(state.error.code).toBe("INVALID_CREDENTIALS");
    expect(state.fieldErrors).toEqual({ password: ACCOUNT_MESSAGES.passwordIncorrect });
    expect(userRow(h.db, h.a.id)).not.toBeNull();
    expect(ownedTotal(h.db, h.a.ownerKey)).toBe(1);
    expect(h.calls.cookies).toEqual([]);
    expect(h.calls.redirect).toEqual([]);
  });

  test("success: data gone, sf_auth cleared, sf_session rotated, layout revalidated, redirect to / (W-14)", async () => {
    const h = await createHarness();
    seedOwnedRows(h.db, h.a.ownerKey);
    const oldGuest = h.jar.guest;
    const oldToken = h.jar.auth;
    const error = await h.run("deleteAccount", { ...VALID_FIELDS.deleteAccount }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedirectSentinel);
    expect((error as RedirectSentinel).url).toBe("/");
    expect(h.calls.redirect).toEqual(["/"]);
    expect(h.calls.cookies).toEqual(["clearAuthCookie", "rotateGuestSession"]);
    expect(h.calls.revalidate).toEqual([["/", "layout"]]);
    expect(h.jar.auth).toBeNull();
    expect(h.jar.guest).not.toBe(oldGuest);
    expect(userRow(h.db, h.a.id)).toBeNull();
    expect(ownedTotal(h.db, h.a.ownerKey)).toBe(0);
    expect(h.authService.resolveToken(oldToken, T0)).toBeNull();
    expect(h.authService.resolveToken(h.aOtherToken, T0)).toBeNull();
    expect(userRow(h.db, h.b.id)).not.toBeNull();
    expect(h.authService.resolveToken(h.bToken, T0)?.user.id).toBe(h.b.id);
  });

  test("a second submit of the same form after success returns UNAUTHENTICATED, no exception (A-81)", async () => {
    const h = await createHarness();
    const fd = await browserMultipart([
      ["password", PASSWORD],
      ["confirm", "DELETE"],
    ]);
    const oldToken = h.jar.auth;
    await expect(h.actions.deleteAccount(null, fd)).rejects.toBeInstanceOf(RedirectSentinel);
    // Replay with the old cookie value (e.g. a stale tab that never received Set-Cookie).
    h.jar.auth = oldToken;
    const again = expectError(await h.run("deleteAccount", fd));
    expect(again.error.code).toBe("UNAUTHENTICATED");
    expect(h.calls.service).toEqual(["deleteAccount"]);
  });

  test("forged userId deletes the caller only", async () => {
    const h = await createHarness();
    await h.run("deleteAccount", { ...VALID_FIELDS.deleteAccount, userId: h.b.id, ownerKey: h.b.ownerKey }).catch(() => undefined);
    expect(userRow(h.db, h.a.id)).toBeNull();
    expect(userRow(h.db, h.b.id)).not.toBeNull();
  });

  test("locked account -> deleteAccount returns the RATE_LIMITED state (R-10); nothing deleted", async () => {
    const h = await createHarness();
    const repo = createAuthRepository(h.db);
    for (let i = 0; i < 10; i++) repo.recordLoginFailure(h.a.id, T0);
    const state = expectError(await h.run("deleteAccount", { ...VALID_FIELDS.deleteAccount }));
    expect(state).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many attempts. Try again in 15 minutes.", details: { retryAfterSeconds: 900 } },
      message: "Too many attempts. Try again in 15 minutes.",
      fieldErrors: {},
      values: {},
      retryAfterSeconds: 900,
    });
    expect(h.calls.service).toEqual(["deleteAccount"]);
    expect(userRow(h.db, h.a.id)).not.toBeNull();
    expect(h.calls.cookies).toEqual([]);
  });

  test("6th attempt in an hour is RATE_LIMITED; service not called", async () => {
    const h = await createHarness();
    // 5 wrong attempts stay below the 10-failure lockout, so only the limiter can stop the 6th.
    for (let i = 0; i < 5; i++) await h.run("deleteAccount", { password: `wrong ${i} abc`, confirm: "DELETE" });
    h.calls.service.length = 0;
    const state = expectError(await h.run("deleteAccount", { ...VALID_FIELDS.deleteAccount }));
    expect(state.error.code).toBe("RATE_LIMITED");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.calls.service).toEqual([]);
    expect(userRow(h.db, h.a.id)).not.toBeNull();
  });

  test("cookie cleanup failures after a committed delete are logged (code only) and still redirect", async () => {
    const logs: string[] = [];
    const h = await createHarness({
      clearAuthCookie: async () => {
        throw new Error(`cookie store failed ${PASSWORD}`);
      },
      revalidatePath: () => {
        throw new Error("outside request scope");
      },
      logger: { error: (...args: unknown[]) => void logs.push(args.map(String).join(" ")) },
    });
    const error = await h.run("deleteAccount", { ...VALID_FIELDS.deleteAccount }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedirectSentinel);
    expect(userRow(h.db, h.a.id)).toBeNull();
    expect(logs).toEqual([
      `[account] ${ACCOUNT_CLEANUP_FAILED} action=deleteAccount step=clearAuthCookie`,
      `[account] ${ACCOUNT_CLEANUP_FAILED} action=deleteAccount step=revalidateLayout`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// signOutEverywhere (R-2, W-10, W-11)
// ---------------------------------------------------------------------------

describe("signOutEverywhere", () => {
  test("revokes every session of the caller incl. the current one, clears/rotates cookies, redirects /", async () => {
    const h = await createHarness();
    const currentToken = h.jar.auth;
    await expect(h.run("signOutEverywhere", { userId: h.b.id })).rejects.toBeInstanceOf(RedirectSentinel);
    expect(h.authService.resolveToken(currentToken, T0)).toBeNull();
    expect(h.authService.resolveToken(h.aOtherToken, T0)).toBeNull();
    expect(h.authService.resolveToken(h.bToken, T0)?.user.id).toBe(h.b.id);
    expect(h.calls.cookies).toEqual(["clearAuthCookie", "rotateGuestSession"]);
    expect(h.calls.revalidate).toEqual([["/", "layout"]]);
    expect(h.calls.redirect).toEqual(["/"]);
    expect(h.calls.limiter).toEqual([]);
  });

  test("revocation failure -> INTERNAL_ERROR; cookies untouched", async () => {
    const h = await createHarness({
      auth: {
        signOutEverywhere: () => {
          throw new Error("SQLITE_BUSY");
        },
      },
    });
    const state = expectError(await h.run("signOutEverywhere", {}));
    expect(state.error.code).toBe("INTERNAL_ERROR");
    expect(h.calls.cookies).toEqual([]);
    expect(h.calls.redirect).toEqual([]);
    expect(h.calls.logs).toEqual([`[account] ${ACCOUNT_ACTION_FAILED} action=signOutEverywhere`]);
  });
});

// ---------------------------------------------------------------------------
// Always settles; secrets never leak (AC6, A-88, A-89, A-92, A-112)
// ---------------------------------------------------------------------------

describe("settling and secrets", () => {
  const throwingAccount: AccountService = {
    updateDisplayName: async () => {
      throw new Error(`db exploded ${PASSWORD}`);
    },
    changePassword: async () => {
      throw new Error(`db exploded ${NEW_PASSWORD}`);
    },
    deleteAccount: async () => {
      throw Object.assign(new Error(`SQLITE_FULL ${PASSWORD}`), { code: "SQLITE_FULL" });
    },
  };

  test("service exceptions (DB errors rethrown by T118) settle as generic INTERNAL_ERROR, log an error code only", async () => {
    const h = await createHarness({ account: throwingAccount });
    for (const fn of ["updateProfile", "changePassword", "deleteAccount"] as const) {
      const state = expectError(await h.run(fn, { ...VALID_FIELDS[fn] }));
      expect(state).toEqual({
        ok: false,
        error: { code: "INTERNAL_ERROR", message: ACCOUNT_MESSAGES.internal },
        message: ACCOUNT_MESSAGES.internal,
        fieldErrors: {},
        values: {},
      });
    }
    expect(h.calls.logs).toEqual([
      `[account] ${ACCOUNT_ACTION_FAILED} action=updateProfile`,
      `[account] ${ACCOUNT_ACTION_FAILED} action=changePassword`,
      `[account] ${ACCOUNT_ACTION_FAILED} action=deleteAccount`,
    ]);
    expect(h.calls.cookies).toEqual([]);
    expect(h.calls.redirect).toEqual([]);
  });

  test("readResolvedAuth throwing (auth lookup DB error) settles as INTERNAL_ERROR", async () => {
    const h = await createHarness({
      readResolvedAuth: async () => {
        throw new Error("SQLITE_CANTOPEN");
      },
    });
    for (const fn of ALL_ACTIONS) expect(expectError(await h.run(fn, { ...VALID_FIELDS[fn] })).error.code).toBe("INTERNAL_ERROR");
    expect(h.calls.cookies).toEqual([]);
  });

  test("unexpected service codes map to INTERNAL_ERROR; NOT_FOUND (concurrent delete) maps to UNAUTHENTICATED", async () => {
    const odd = (error: AppError): AccountService => ({
      updateDisplayName: async () => ({ ok: false, error }),
      changePassword: async () => ({ ok: false, error }),
      deleteAccount: async () => ({ ok: false, error }),
    });
    const h1 = await createHarness({ account: odd(appError("PAYMENT_FAILED", "internal detail")) });
    for (const fn of ["updateProfile", "changePassword", "deleteAccount"] as const) {
      const state = expectError(await h1.run(fn, { ...VALID_FIELDS[fn] }));
      expect(state.error).toEqual({ code: "INTERNAL_ERROR", message: ACCOUNT_MESSAGES.internal });
    }
    const h2 = await createHarness({ account: odd(appError("NOT_FOUND", "Account not found.")) });
    for (const fn of ["updateProfile", "changePassword", "deleteAccount"] as const) {
      expect(expectError(await h2.run(fn, { ...VALID_FIELDS[fn] })).error.code).toBe("UNAUTHENTICATED");
    }
  });

  test("D-T121-1: Next control-flow errors (NEXT_REDIRECT / NEXT_NOT_FOUND digests) propagate out of every action, unlogged", async () => {
    for (const digest of ["NEXT_REDIRECT;replace;/sign-in;307;", "NEXT_HTTP_ERROR_FALLBACK;404"]) {
      const control = Object.assign(new Error(digest.split(";")[0]), { digest });
      const fromCookies = await createHarness({
        readResolvedAuth: async () => {
          throw control;
        },
      });
      for (const fn of ALL_ACTIONS) {
        await expect(fromCookies.actions[fn](null, form({ ...VALID_FIELDS[fn] }))).rejects.toBe(control);
      }
      expect(fromCookies.calls.logs).toEqual([]);

      const fromService = await createHarness({
        account: {
          updateDisplayName: async () => {
            throw control;
          },
          changePassword: async () => {
            throw control;
          },
          deleteAccount: async () => {
            throw control;
          },
        },
      });
      for (const fn of ["updateProfile", "changePassword", "deleteAccount"] as const) {
        await expect(fromService.actions[fn](null, form({ ...VALID_FIELDS[fn] }))).rejects.toBe(control);
      }
      expect(fromService.calls.logs).toEqual([]);
    }
  });

  test("D-T121-1: a control-flow error from a best-effort cleanup step (clearAuthCookie) propagates instead of being logged", async () => {
    const control = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/;307;" });
    const h = await createHarness({
      clearAuthCookie: async () => {
        throw control;
      },
    });
    await expect(h.actions.signOutEverywhere(null, form({}))).rejects.toBe(control);
    expect(h.calls.logs).toEqual([]);
  });

  test("D-T121-1: an ordinary error whose message mentions NEXT_REDIRECT (no digest) still settles as INTERNAL_ERROR", async () => {
    const h = await createHarness({
      readResolvedAuth: async () => {
        throw new Error("NEXT_REDIRECT");
      },
    });
    expect(expectError(await h.run("updateProfile", { ...VALID_FIELDS.updateProfile })).error.code).toBe("INTERNAL_ERROR");
    expect(h.calls.logs).toEqual([`[account] ${ACCOUNT_ACTION_FAILED} action=updateProfile`]);
  });

  test("a non-FormData argument reads as an empty form (no throw)", async () => {
    const h = await createHarness();
    const bogus = { get: () => PASSWORD } as unknown as FormData;
    const state = expectError(await h.actions.deleteAccount(null, bogus));
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["confirm", "password"]);
  });

  test("no password, hash, token or owner key in any state, log, redirect URL or cookie write", async () => {
    const h = await createHarness();
    const run = (fn: keyof AccountActions, fields: Record<string, string>) => h.run(fn, fields).catch(() => null);
    await run("changePassword", { currentPassword: "wrong current 99", newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD });
    await run("changePassword", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: "mismatch zzz 1" });
    await run("changePassword", { currentPassword: PASSWORD, newPassword: "password", confirmPassword: "password" });
    await run("changePassword", { ...VALID_FIELDS.changePassword });
    await run("deleteAccount", { password: PASSWORD, confirm: "nope" });
    await run("deleteAccount", { password: "wrong delete 77", confirm: "DELETE" });
    await run("updateProfile", { displayName: "" });
    await run("deleteAccount", { password: NEW_PASSWORD, confirm: "DELETE" });

    const hashes = [userRow(h.db, h.b.id)?.password_hash ?? "missing"];
    const secrets = [PASSWORD, NEW_PASSWORD, "wrong current 99", "mismatch zzz 1", "wrong delete 77", h.aOtherToken, h.bToken, h.a.ownerKey, h.a.id, ...hashes];
    const haystack = [JSON.stringify(h.states), ...h.calls.logs, ...h.calls.redirect, ...h.calls.cookies].join("\n");
    for (const secret of secrets) expect(haystack.includes(secret)).toBe(false);
    expect(h.calls.redirect).toEqual(["/"]);
  });
});

// ---------------------------------------------------------------------------
// Browser-shaped multipart (SR2, AC6) and pure helpers
// ---------------------------------------------------------------------------

describe("plain form posts", () => {
  test("browser multipart FormData works for every action", async () => {
    const h = await createHarness();
    const profile = await h.actions.updateProfile(null, await browserMultipart([["displayName", "Multipart Ada"]]));
    expect(profile).toMatchObject({ ok: true, displayName: "Multipart Ada" });
    const pw = await h.actions.changePassword(
      null,
      await browserMultipart([
        ["currentPassword", PASSWORD],
        ["newPassword", NEW_PASSWORD],
        ["confirmPassword", NEW_PASSWORD],
      ]),
    );
    expect(pw).toMatchObject({ ok: true, kind: "password_changed" });
    await expect(h.actions.signOutEverywhere(null, await browserMultipart([]))).rejects.toBeInstanceOf(RedirectSentinel);
    expect(expectError(await h.actions.updateProfile(null, await browserMultipart([["displayName", "x"]]))).error.code).toBe(
      "UNAUTHENTICATED",
    );
  });

  test("duplicated keys: the first value is used", async () => {
    const h = await createHarness();
    const fd = new FormData();
    fd.append("displayName", "First");
    fd.append("displayName", "Second");
    expect(await h.actions.updateProfile(null, fd)).toMatchObject({ ok: true, displayName: "First" });
  });
});

describe("helpers", () => {
  test("tooManyAttemptsMessage rounds up to whole minutes", () => {
    expect(tooManyAttemptsMessage(1)).toBe("Too many attempts. Try again in 1 minute.");
    expect(tooManyAttemptsMessage(61)).toBe("Too many attempts. Try again in 2 minutes.");
    expect(tooManyAttemptsMessage(3600)).toBe("Too many attempts. Try again in 60 minutes.");
    expect(tooManyAttemptsMessage(undefined)).toBe(ACCOUNT_MESSAGES.tooManyAttemptsFallback);
  });

  test("tooManyAttemptsState ignores a bogus retryAfterSeconds", () => {
    const state = expectError(tooManyAttemptsState(appError("RATE_LIMITED", "x", { retryAfterSeconds: "soon" }), {}));
    expect(state).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", message: ACCOUNT_MESSAGES.tooManyAttemptsFallback },
      message: ACCOUNT_MESSAGES.tooManyAttemptsFallback,
      fieldErrors: {},
      values: {},
    });
  });

  test("readField: strings only, first value, non-FormData -> undefined", () => {
    const fd = form({ a: "1", f: new Blob(["x"]) });
    expect(readField(fd, "a")).toBe("1");
    expect(readField(fd, "f")).toBeUndefined();
    expect(readField(fd, "missing")).toBeUndefined();
    expect(readField(null, "a")).toBeUndefined();
  });

  test("precheckDelete and precheckPasswordChange", () => {
    expect(precheckDelete({ password: "x", confirm: "DELETE" })).toEqual({});
    expect(Object.keys(precheckDelete({ password: undefined, confirm: "Delete" })).sort()).toEqual(["confirm", "password"]);
    expect(precheckPasswordChange({ currentPassword: "a", newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }, "a@b.c")).toEqual({});
    expect(precheckPasswordChange({ currentPassword: "a", newPassword: "", confirmPassword: "" }, "a@b.c").newPassword?.code).toBe("REQUIRED");
  });

  test("ACCOUNT_FIELD names are the wire names", () => {
    for (const [key, value] of Object.entries(ACCOUNT_FIELD)) expect(key).toBe(value);
  });

  test("the action type is AccountActionFn", () => {
    const fn: AccountActionFn = async () => null;
    expect(typeof fn).toBe("function");
  });
});
