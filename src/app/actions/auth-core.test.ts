import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { AuthActionState } from "@/components/molecules/_contracts/auth-actions";
import { fail } from "@/lib/result";
import { createAuthService, isRawToken, type AuthService } from "@/server/auth/auth-service";
import { createMergeService, type MergeService } from "@/server/auth/merge-service";
import type { PasswordHasher } from "@/server/auth/password-policy";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { isSessionId } from "@/server/session/session-id";
import {
  AUTH_MESSAGES,
  createAuthActions,
  tooManyAttemptsMessage,
  USER_AGENT_MAX_LENGTH,
  type AuthActionDeps,
  type AuthActions,
} from "./auth-core";

// ---------------------------------------------------------------------------
// Fixtures: real auth + merge services over :memory:, fast hasher, and a fake
// cookie jar that mirrors src/server/session semantics (R-1, K-4).
// ---------------------------------------------------------------------------

const T0 = 1_800_000_000_000;
const PASSWORD = "Tr0ub4dor&3-qa";
const F = "f0f0f0f0-f0f0-4f0f-8f0f-f0f0f0f0f0f0"; // attacker-chosen guest id
const FORGED = "44444444-4444-4444-8444-444444444444";

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

interface CountingHasher extends PasswordHasher {
  readonly calls: { hash: number; verify: number };
}

function fastHasher(): CountingHasher {
  const calls = { hash: 0, verify: 0 };
  let salt = 0;
  const digest = (s: string, pw: string): string => createHash("sha256").update(`${s}:${pw}`).digest("hex");
  return {
    calls,
    async hash(password) {
      calls.hash++;
      salt++;
      await Promise.resolve();
      return `$qa-fast$${salt}$${digest(String(salt), password)}`;
    },
    async verify(password, hash) {
      calls.verify++;
      await Promise.resolve();
      const [, , s, d] = hash.split("$");
      return s !== undefined && d === digest(s, password);
    },
  };
}

interface SetCall {
  readonly name: string;
  readonly value: string;
}

interface Env {
  readonly db: Database;
  readonly auth: AuthService;
  readonly merge: MergeService;
  readonly hasher: CountingHasher;
  readonly clock: { now: number };
  readonly jar: Map<string, string>;
  readonly setCalls: SetCall[];
  readonly revalidations: [string, string | undefined][];
  readonly logs: string[];
  userAgent: string | null;
  actions: AuthActions;
  build(overrides?: Partial<AuthActionDeps>): AuthActions;
}

function makeEnv(): Env {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(T0) });
  const hasher = fastHasher();
  const clock = { now: T0 };
  const auth = createAuthService({ db, hasher, now: () => clock.now, logger: { error: () => undefined, warn: () => undefined } });
  const merge = createMergeService({ db, logger: { error: () => undefined } });
  const jar = new Map<string, string>();
  const setCalls: SetCall[] = [];
  const revalidations: [string, string | undefined][] = [];
  const logs: string[] = [];

  const set = (name: string, value: string): void => {
    setCalls.push({ name, value });
    jar.set(name, value);
  };
  const isOwnerKey = (value: string): boolean =>
    db.query("SELECT 1 FROM users WHERE owner_key = ?").get(value) !== null;
  const readGuestSessionId = async (): Promise<string | null> => {
    const value = jar.get("sf_session");
    return value !== undefined && isSessionId(value) && !isOwnerKey(value) ? value : null;
  };
  const rotateGuestSession = async (): Promise<string> => {
    const previous = jar.get("sf_session");
    let id = crypto.randomUUID();
    while (id === previous) id = crypto.randomUUID();
    set("sf_session", id);
    return id;
  };
  const readAuthToken = async (): Promise<string | null> => {
    const value = jar.get("sf_auth");
    return isRawToken(value) ? value : null;
  };

  const env: Env = {
    db,
    auth,
    merge,
    hasher,
    clock,
    jar,
    setCalls,
    revalidations,
    logs,
    userAgent: "Mozilla/5.0 (test)",
    actions: undefined as unknown as AuthActions,
    build(overrides = {}) {
      return createAuthActions({
        auth,
        merge,
        getOrCreateGuestSessionId: async () => (await readGuestSessionId()) ?? (await rotateGuestSession()),
        readGuestSessionId,
        readAuthToken,
        setAuthCookie: async (token) => set("sf_auth", token),
        clearAuthCookie: async () => set("sf_auth", ""),
        rotateGuestSession,
        userAgent: async () => env.userAgent,
        revalidatePath: (path, type) => {
          revalidations.push([path, type]);
        },
        redirect: (path) => {
          throw new RedirectSentinel(path);
        },
        now: () => clock.now,
        logger: { error: (...args: unknown[]) => void logs.push(args.map(String).join(" ")) },
        ...overrides,
      });
    },
  };
  env.actions = env.build();
  return env;
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** Round-trips through a real multipart body, the way a no-JS browser posts it. */
async function multipart(fields: Record<string, string>): Promise<FormData> {
  const fd = form({ $ACTION_ID_0123456789abcdef: "", ...fields });
  fd.append("avatar", new File(["x"], "x.txt", { type: "text/plain" }));
  return new Request("http://localhost/signin", { method: "POST", body: fd }).formData();
}

async function expectRedirect(promise: Promise<AuthActionState>): Promise<string> {
  try {
    const state = await promise;
    throw new Error(`expected a redirect, got ${JSON.stringify(state)}`);
  } catch (error) {
    if (error instanceof RedirectSentinel) return error.url;
    throw error;
  }
}

async function expectState(promise: Promise<AuthActionState>): Promise<Exclude<AuthActionState, null>> {
  const state = await promise;
  if (state === null) throw new Error("expected a failure state, got null");
  return state;
}

function firstProduct(db: Database, offset = 0): string {
  const row = db.query("SELECT id FROM products WHERE stock >= 5 ORDER BY id LIMIT 1 OFFSET ?").get(offset) as { id: string } | null;
  if (row === null) throw new Error("no product");
  return row.id;
}

/** Gives `owner` one cart line and one product view. */
function giveData(db: Database, owner: string, productOffset = 0): string {
  const product = firstProduct(db, productOffset);
  db.query("INSERT OR IGNORE INTO carts (session_id) VALUES (?)").run(owner);
  db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, 1)").run(owner, product);
  db.query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)").run(owner, product, new Date(T0).toISOString());
  return product;
}

function counts(db: Database, owner: string): { carts: number; cartItems: number; views: number } {
  const n = (sql: string): number => (db.query(sql).get(owner) as { n: number }).n;
  return {
    carts: n("SELECT COUNT(*) AS n FROM carts WHERE session_id = ?"),
    cartItems: n("SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ?"),
    views: n("SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?"),
  };
}

function cartProducts(db: Database, owner: string): string[] {
  return (db.query("SELECT product_id FROM cart_items WHERE cart_session_id = ? ORDER BY product_id").all(owner) as { product_id: string }[]).map(
    (r) => r.product_id,
  );
}

function userByEmail(db: Database, email: string): { id: string; owner_key: string } {
  const row = db.query("SELECT id, owner_key FROM users WHERE email = ?").get(email) as { id: string; owner_key: string } | null;
  if (row === null) throw new Error(`no user ${email}`);
  return row;
}

function liveSessions(db: Database, userId: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL").get(userId) as { n: number }).n;
}

function authSets(env: Env): SetCall[] {
  return env.setCalls.filter((c) => c.name === "sf_auth");
}

function sessionSets(env: Env): SetCall[] {
  return env.setCalls.filter((c) => c.name === "sf_session");
}

/** Creates a user directly through the service (not through the action). */
async function createUser(env: Env, email: string, displayName = "Ada"): Promise<{ id: string; ownerKey: string; token: string }> {
  const issued = await env.auth.signUp({ email, password: PASSWORD, displayName }, { sessionKey: crypto.randomUUID(), now: env.clock.now });
  if (!issued.ok) throw new Error(`fixture signUp failed: ${issued.error.code}`);
  return { id: issued.value.user.id, ownerKey: issued.value.user.ownerKey, token: issued.value.token };
}

function signInForm(email: string, password = PASSWORD, extra: Record<string, string> = {}): FormData {
  return form({ email, password, ...extra });
}

// ---------------------------------------------------------------------------
// signUp
// ---------------------------------------------------------------------------

describe("signUp", () => {
  test("W-01: no cookies -> user + session, sf_auth set, sf_session minted then rotated, redirect /account", async () => {
    const env = makeEnv();
    env.userAgent = "U".repeat(8192);
    const url = await expectRedirect(env.actions.signUp(null, form({ email: " Ada@Example.com ", password: PASSWORD, displayName: "Ada" })));
    expect(url).toBe("/account");
    const user = userByEmail(env.db, "ada@example.com");
    expect(liveSessions(env.db, user.id)).toBe(1);
    const auth = authSets(env);
    expect(auth).toHaveLength(1);
    expect(auth[0]?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.auth.resolveToken(auth[0]?.value, env.clock.now)?.user.id).toBe(user.id);
    // minted for the limiter (R-3), then rotated after sign-up (fixation defence)
    const sessions = sessionSets(env);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.value).not.toBe(sessions[1]?.value);
    expect(env.revalidations).toEqual([["/", "layout"]]);
    const ua = env.db.query("SELECT user_agent FROM auth_sessions WHERE user_id = ?").get(user.id) as { user_agent: string };
    expect(ua.user_agent.length).toBe(USER_AGENT_MAX_LENGTH);
  });

  test("W-02: guest data moves to the new owner key; rotated sf_session != G", async () => {
    const env = makeEnv();
    const G = crypto.randomUUID();
    env.jar.set("sf_session", G);
    const product = giveData(env.db, G);
    await expectRedirect(env.actions.signUp(null, form({ email: "ada@example.com", password: PASSWORD, displayName: "Ada" })));
    const user = userByEmail(env.db, "ada@example.com");
    expect(counts(env.db, G)).toEqual({ carts: 0, cartItems: 0, views: 0 });
    expect(cartProducts(env.db, user.owner_key)).toEqual([product]);
    const sessions = sessionSets(env);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.value).not.toBe(G);
    expect(sessions[0]?.value).not.toBe(user.owner_key);
  });

  test("criterion 1 / W-03: per-field errors, values echoed without the password, nothing created", async () => {
    const env = makeEnv();
    const G = crypto.randomUUID();
    env.jar.set("sf_session", G);
    giveData(env.db, G);
    const cases: { fields: Record<string, string>; field: "email" | "password" | "displayName" }[] = [
      { fields: { password: PASSWORD, displayName: "Ada" }, field: "email" },
      { fields: { email: "not-an-email", password: PASSWORD, displayName: "Ada" }, field: "email" },
      { fields: { email: "ada@example.com", password: "Sh0rt!x", displayName: "Ada" }, field: "password" },
      { fields: { email: "ada@example.com", password: `A1${"x".repeat(127)}`, displayName: "Ada" }, field: "password" },
      { fields: { email: "ada@example.com", password: "password123", displayName: "Ada" }, field: "password" },
      { fields: { email: "ada@example.com", password: PASSWORD, displayName: "   " }, field: "displayName" },
    ];
    for (const { fields, field } of cases) {
      const state = await expectState(env.actions.signUp(null, form(fields)));
      expect(state.code).toBe("VALIDATION_FAILED");
      expect(state.error.code).toBe("VALIDATION_FAILED");
      expect(typeof state.fieldErrors[field]).toBe("string");
      expect(state.values).toEqual({
        ...(fields.email === undefined ? {} : { email: fields.email }),
        displayName: fields.displayName,
      });
      expect(JSON.stringify(state)).not.toContain(fields.password ?? "\u0000none");
      expect("password" in state.values).toBe(false);
    }
    expect(env.db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 0 });
    expect(authSets(env)).toEqual([]);
    expect(sessionSets(env)).toEqual([]);
    expect(counts(env.db, G)).toEqual({ carts: 1, cartItems: 1, views: 1 });
    expect(env.revalidations).toEqual([]);
  });

  test("EMAIL_TAKEN (any case) uses the friendly message", async () => {
    const env = makeEnv();
    await createUser(env, "ada@example.com");
    const state = await expectState(env.actions.signUp(null, form({ email: "ADA@example.com", password: PASSWORD, displayName: "Other" })));
    expect(state).toEqual({
      ok: false,
      code: "EMAIL_TAKEN",
      error: { code: "EMAIL_TAKEN", message: AUTH_MESSAGES.emailTaken },
      message: "An account with this email already exists. Sign in instead.",
      fieldErrors: {},
      values: { email: "ADA@example.com", displayName: "Other" },
    });
    expect(authSets(env)).toEqual([]);
  });

  test("A-98 / criterion 3: forged userId/ownerKey/sessionId/role/verified are ignored", async () => {
    const env = makeEnv();
    const G = crypto.randomUUID();
    env.jar.set("sf_session", G);
    giveData(env.db, G);
    giveData(env.db, FORGED, 1);
    await expectRedirect(
      env.actions.signUp(
        null,
        form({
          email: "ada@example.com",
          password: PASSWORD,
          displayName: "Ada",
          userId: "u-forged",
          ownerKey: FORGED,
          sessionId: FORGED,
          role: "admin",
          verified: "1",
        }),
      ),
    );
    const user = userByEmail(env.db, "ada@example.com");
    expect(user.owner_key).not.toBe(FORGED);
    expect(user.owner_key).not.toBe(G);
    expect(user.id).not.toBe("u-forged");
    expect(counts(env.db, FORGED)).toEqual({ carts: 1, cartItems: 1, views: 1 });
    expect(counts(env.db, G)).toEqual({ carts: 0, cartItems: 0, views: 0 });
  });

  test("sign-up rate limit (5/hour per session) -> TOO_MANY_ATTEMPTS without hashing", async () => {
    const env = makeEnv();
    const S = crypto.randomUUID();
    for (let i = 0; i < 5; i++) {
      // sign-up rotates sf_session; replay the same guest cookie for the limiter
      env.jar.clear();
      env.jar.set("sf_session", S);
      await expectRedirect(env.actions.signUp(null, form({ email: `u${i}@example.com`, password: PASSWORD, displayName: "U" })));
    }
    env.jar.clear();
    env.jar.set("sf_session", S);
    const hashes = env.hasher.calls.hash;
    const state = await expectState(env.actions.signUp(null, form({ email: "u6@example.com", password: PASSWORD, displayName: "U" })));
    expect(state.code).toBe("TOO_MANY_ATTEMPTS");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(env.hasher.calls.hash).toBe(hashes);
  });

  test("W-07: signed in as A, sign up as C -> A's session revoked first, only GA merged", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    giveData(env.db, a.ownerKey);
    const GA = crypto.randomUUID();
    const guestProduct = giveData(env.db, GA, 1);
    env.jar.set("sf_auth", a.token);
    env.jar.set("sf_session", GA);
    await expectRedirect(env.actions.signUp(null, form({ email: "c@example.com", password: PASSWORD, displayName: "C" })));
    expect(env.auth.resolveToken(a.token, env.clock.now)).toBeNull();
    const c = userByEmail(env.db, "c@example.com");
    expect(cartProducts(env.db, c.owner_key)).toEqual([guestProduct]);
    expect(counts(env.db, a.ownerKey)).toEqual({ carts: 1, cartItems: 1, views: 1 });
  });
});

// ---------------------------------------------------------------------------
// signIn
// ---------------------------------------------------------------------------

describe("signIn", () => {
  test("W-04 / A-30: attacker-set sf_session -> data merged, DIFFERENT sf_session, new sf_auth", async () => {
    const env = makeEnv();
    const a = await createUser(env, "ada@example.com");
    env.jar.set("sf_session", F);
    const product = giveData(env.db, F);
    const url = await expectRedirect(env.actions.signIn(null, signInForm("ada@example.com")));
    expect(url).toBe("/account");
    expect(counts(env.db, F)).toEqual({ carts: 0, cartItems: 0, views: 0 });
    expect(cartProducts(env.db, a.ownerKey)).toEqual([product]);
    const newSession = env.jar.get("sf_session");
    expect(newSession).toBeDefined();
    expect(newSession).not.toBe(F);
    expect(newSession).not.toBe(a.ownerKey);
    const token = env.jar.get("sf_auth");
    expect(token).not.toBe(a.token);
    expect(env.auth.resolveToken(token, env.clock.now)?.user.id).toBe(a.id);
    expect(env.revalidations).toEqual([["/", "layout"]]);
    const row = env.db.query("SELECT failed_login_count, last_login_at FROM users WHERE id = ?").get(a.id) as {
      failed_login_count: number;
      last_login_at: string | null;
    };
    expect(row.failed_login_count).toBe(0);
    expect(row.last_login_at).not.toBeNull();
  });

  test("AR2: unknown email and wrong password give identical states (except echoed email)", async () => {
    const env = makeEnv();
    await createUser(env, "ada@example.com");
    env.jar.set("sf_session", crypto.randomUUID());
    const wrong = await expectState(env.actions.signIn(null, signInForm("ada@example.com", "Wrong-password-1")));
    const unknown = await expectState(env.actions.signIn(null, signInForm("nobody@example.com", "Wrong-password-1")));
    expect(wrong).toEqual({
      ok: false,
      code: "INVALID_CREDENTIALS",
      error: { code: "INVALID_CREDENTIALS", message: "Email or password is incorrect" },
      message: "Email or password is incorrect",
      fieldErrors: {},
      values: { email: "ada@example.com" },
    });
    expect({ ...unknown, values: {} }).toEqual({ ...wrong, values: {} });
    expect(Object.keys(unknown)).toEqual(Object.keys(wrong));
    expect(authSets(env)).toEqual([]);
  });

  test("R-10: the 10th failure is byte-identical for a real (locked) and an unknown email", async () => {
    async function tenth(withUser: boolean): Promise<Exclude<AuthActionState, null>> {
      const env = makeEnv();
      if (withUser) await createUser(env, "ada@example.com");
      env.jar.set("sf_session", F);
      let last: AuthActionState = null;
      for (let i = 0; i < 10; i++) last = await env.actions.signIn(null, signInForm("ada@example.com", "Wrong-password-1"));
      if (last === null) throw new Error("no state");
      return last;
    }
    const known = await tenth(true);
    const unknown = await tenth(false);
    expect(known.code).toBe("TOO_MANY_ATTEMPTS");
    expect(known).toEqual(unknown);
    expect(known.message).toBe(tooManyAttemptsMessage(known.retryAfterSeconds));
    expect(known.message).toMatch(/^Too many attempts\. Try again in \d+ minutes?\.$/);
    expect(known.error.code).toBe("RATE_LIMITED");
  });

  test("R-10 addendum: locked known email vs rate-limited unknown email -> byte-identical JSON", async () => {
    // DB 1: ada exists and is locked until T0 + 15 min; the correct password is sent.
    const locked = makeEnv();
    const a = await createUser(locked, "ada@example.com");
    locked.db.query("UPDATE users SET failed_login_count = 10, locked_until = ? WHERE id = ?").run(new Date(T0 + 15 * 60_000).toISOString(), a.id);
    locked.jar.set("sf_session", crypto.randomUUID());
    const lockedState = await expectState(locked.actions.signIn(null, signInForm("ada@example.com")));

    // DB 2: ada does not exist; the per-email budget (10 / 15 min) is spent from 10 different sessions.
    const limited = makeEnv();
    for (let i = 0; i < 10; i++) {
      limited.jar.clear();
      limited.jar.set("sf_session", crypto.randomUUID());
      await limited.actions.signIn(null, signInForm("ada@example.com", "Wrong-password-1"));
    }
    limited.jar.clear();
    limited.jar.set("sf_session", crypto.randomUUID());
    const verifies = limited.hasher.calls.verify;
    const limitedState = await expectState(limited.actions.signIn(null, signInForm("ada@example.com")));
    expect(limited.hasher.calls.verify).toBe(verifies); // RATE_LIMITED before any hashing

    expect(JSON.stringify(lockedState)).toBe(JSON.stringify(limitedState));
    expect(lockedState).toEqual({
      ok: false,
      code: "TOO_MANY_ATTEMPTS",
      error: { code: "RATE_LIMITED", message: "Too many attempts. Try again in 15 minutes.", details: { retryAfterSeconds: 900 } },
      message: "Too many attempts. Try again in 15 minutes.",
      fieldErrors: {},
      values: { email: "ada@example.com" },
      retryAfterSeconds: 900,
    });
  });

  test("locked account with the CORRECT password -> TOO_MANY_ATTEMPTS, no cookie", async () => {
    const env = makeEnv();
    const a = await createUser(env, "ada@example.com");
    env.db.query("UPDATE users SET failed_login_count = 10, locked_until = ? WHERE id = ?").run(new Date(T0 + 15 * 60_000).toISOString(), a.id);
    env.jar.set("sf_session", crypto.randomUUID());
    const state = await expectState(env.actions.signIn(null, signInForm("ada@example.com")));
    expect(state.code).toBe("TOO_MANY_ATTEMPTS");
    expect(state.error.code).toBe("RATE_LIMITED");
    expect(state.retryAfterSeconds).toBe(900);
    expect(state.message).toBe("Too many attempts. Try again in 15 minutes.");
    expect(state.fieldErrors).toEqual({});
    expect(authSets(env)).toEqual([]);
  });

  test("RATE_LIMITED (11th attempt per session) -> TOO_MANY_ATTEMPTS with retryAfterSeconds, no hashing", async () => {
    const env = makeEnv();
    env.jar.set("sf_session", crypto.randomUUID());
    for (let i = 0; i < 10; i++) await env.actions.signIn(null, signInForm(`u${i}@example.com`, "Wrong-password-1"));
    const verifies = env.hasher.calls.verify;
    const state = await expectState(env.actions.signIn(null, signInForm("ada@example.com")));
    expect(state.code).toBe("TOO_MANY_ATTEMPTS");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(env.hasher.calls.verify).toBe(verifies);
    expect(env.revalidations).toEqual([]);
  });

  test("W-05 / R-3: failure with no sf_session mints at most one guest cookie, no sf_auth", async () => {
    const env = makeEnv();
    await createUser(env, "ada@example.com");
    await expectState(env.actions.signIn(null, signInForm("ada@example.com", "Wrong-password-1")));
    expect(sessionSets(env)).toHaveLength(1);
    expect(authSets(env)).toEqual([]);
  });

  test("per-field errors for missing email / password; password never echoed", async () => {
    const env = makeEnv();
    const state = await expectState(env.actions.signIn(null, form({ email: "", password: "" })));
    expect(state.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["email", "password"]);
    expect(state.values).toEqual({ email: "" });
    const withPw = await expectState(env.actions.signIn(null, form({ email: "bad", password: "SecretPw-77" })));
    expect(JSON.stringify(withPw)).not.toContain("SecretPw-77");
  });

  test("W-06 / A-38 / A-68: signed in as A, sign in as B -> rev(TA) first, only GA merged, KA untouched", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    const b = await createUser(env, "b@example.com");
    giveData(env.db, a.ownerKey, 0);
    const GA = crypto.randomUUID();
    const guestProduct = giveData(env.db, GA, 1);
    env.jar.set("sf_auth", a.token);
    env.jar.set("sf_session", GA);
    await expectRedirect(env.actions.signIn(null, signInForm("b@example.com")));
    expect(env.auth.resolveToken(a.token, env.clock.now)).toBeNull();
    expect(counts(env.db, a.ownerKey)).toEqual({ carts: 1, cartItems: 1, views: 1 });
    expect(cartProducts(env.db, b.ownerKey)).toEqual([guestProduct]);
    expect(counts(env.db, GA)).toEqual({ carts: 0, cartItems: 0, views: 0 });
    expect(env.auth.resolveToken(env.jar.get("sf_auth"), env.clock.now)?.user.id).toBe(b.id);
    expect(env.jar.get("sf_session")).not.toBe(GA);
  });

  test("ruling: a FAILED sign-in/sign-up while signed in keeps the current session", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    await createUser(env, "b@example.com");
    const GA = crypto.randomUUID();
    giveData(env.db, GA);
    env.jar.set("sf_auth", a.token);
    env.jar.set("sf_session", GA);
    const attempts: Promise<AuthActionState>[] = [
      env.actions.signIn(null, signInForm("b@example.com", "Wrong-password-1")), // INVALID_CREDENTIALS
      env.actions.signIn(null, form({ email: "", password: "" })), // VALIDATION_FAILED
      env.actions.signUp(null, form({ email: "b@example.com", password: PASSWORD, displayName: "B" })), // EMAIL_TAKEN
      env.build({ merge: { mergeGuestIntoUser: () => fail("VALIDATION_FAILED", "x") } }).signIn(null, signInForm("b@example.com")), // merge failure
    ];
    const codes: string[] = [];
    for (const attempt of attempts) codes.push((await expectState(attempt)).code);
    expect(codes).toEqual(["INVALID_CREDENTIALS", "VALIDATION_FAILED", "EMAIL_TAKEN", "INTERNAL_ERROR"]);
    expect(env.auth.resolveToken(a.token, env.clock.now)?.user.id).toBe(a.id);
    expect(env.jar.get("sf_auth")).toBe(a.token);
    expect(authSets(env)).toEqual([]);
    expect(counts(env.db, GA)).toEqual({ carts: 1, cartItems: 1, views: 1 });
  });

  test("ruling: the old session is revoked after credentials succeed and before the new cookie is set", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    await createUser(env, "b@example.com");
    env.jar.set("sf_auth", a.token);
    const order: string[] = [];
    const actions = env.build({
      auth: {
        ...env.auth,
        signIn: async (input, ctx) => {
          order.push("signIn");
          return env.auth.signIn(input, ctx);
        },
        signOut: (token, now) => {
          order.push("revokeOld");
          env.auth.signOut(token, now);
        },
      },
      merge: {
        mergeGuestIntoUser: (g, o, n) => {
          order.push("merge");
          return env.merge.mergeGuestIntoUser(g, o, n);
        },
      },
      setAuthCookie: async (token) => {
        order.push("setAuthCookie");
        env.jar.set("sf_auth", token);
      },
    });
    await expectRedirect(actions.signIn(null, signInForm("b@example.com")));
    expect(order).toEqual(["signIn", "merge", "revokeOld", "setAuthCookie"]);
    expect(env.auth.resolveToken(a.token, env.clock.now)).toBeNull();
  });

  test("criterion 8: signing in again as the same user leaves exactly one live session", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    env.jar.set("sf_auth", a.token);
    await expectRedirect(env.actions.signIn(null, signInForm("a@example.com")));
    expect(liveSessions(env.db, a.id)).toBe(1);
  });

  test("auth-only jar (C-04): no sf_session -> a guest id is minted for the limiter, then rotated", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    const b = await createUser(env, "b@example.com");
    giveData(env.db, a.ownerKey);
    env.jar.set("sf_auth", a.token);
    await expectRedirect(env.actions.signIn(null, signInForm("b@example.com")));
    expect(counts(env.db, a.ownerKey)).toEqual({ carts: 1, cartItems: 1, views: 1 });
    expect(counts(env.db, b.ownerKey)).toEqual({ carts: 0, cartItems: 0, views: 0 });
    for (const call of env.setCalls) expect(call.value).not.toBe(a.ownerKey);
  });

  test("an owner key used as sf_session (R-1) is never merged", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    const b = await createUser(env, "b@example.com");
    giveData(env.db, a.ownerKey);
    env.jar.set("sf_session", a.ownerKey);
    await expectRedirect(env.actions.signIn(null, signInForm("b@example.com")));
    expect(counts(env.db, a.ownerKey)).toEqual({ carts: 1, cartItems: 1, views: 1 });
    expect(counts(env.db, b.ownerKey)).toEqual({ carts: 0, cartItems: 0, views: 0 });
    expect(env.jar.get("sf_session")).not.toBe(a.ownerKey);
  });
});

// ---------------------------------------------------------------------------
// Merge / cookie failures (criterion 5, W-18, A-67)
// ---------------------------------------------------------------------------

describe("failure after credentials are verified", () => {
  async function setupFailure(overrides: (env: Env) => Partial<AuthActionDeps>): Promise<{
    env: Env;
    state: Exclude<AuthActionState, null>;
    userId: string;
    G: string;
  }> {
    const env = makeEnv();
    const a = await createUser(env, "ada@example.com");
    env.db.query("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ?").run(new Date(T0).toISOString(), a.id);
    const G = crypto.randomUUID();
    env.jar.set("sf_session", G);
    giveData(env.db, G);
    const actions = env.build(overrides(env));
    const state = await expectState(actions.signIn(null, signInForm("ada@example.com")));
    return { env, state, userId: a.id, G };
  }

  function expectGenericFailure(env: Env, state: Exclude<AuthActionState, null>, userId: string, G: string): void {
    expect(state).toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
      error: { code: "INTERNAL_ERROR", message: AUTH_MESSAGES.internal },
      message: AUTH_MESSAGES.internal,
      fieldErrors: {},
      values: { email: "ada@example.com" },
    });
    expect(liveSessions(env.db, userId)).toBe(0);
    expect(env.jar.get("sf_session")).toBe(G);
    expect(env.revalidations).toEqual([]);
    for (const line of env.logs) expect(line).toMatch(/^\[auth\] AUTH_(ACTION|CLEANUP)_FAILED action=signIn step=\w+$/);
  }

  test("merge returns an error -> generic error, no sf_auth, guest data intact, issued session revoked", async () => {
    const { env, state, userId, G } = await setupFailure(() => ({
      merge: { mergeGuestIntoUser: () => fail("VALIDATION_FAILED", "x", { reason: "merge_failed" }) },
    }));
    expectGenericFailure(env, state, userId, G);
    expect(authSets(env)).toEqual([]);
    expect(counts(env.db, G)).toEqual({ carts: 1, cartItems: 1, views: 1 });
    expect(env.logs).toEqual(["[auth] AUTH_ACTION_FAILED action=signIn step=merge"]);
  });

  test("real merge rolls back on a DB error (injected trigger) -> guest data intact", async () => {
    const { env, state, userId, G } = await setupFailure((e) => {
      e.db.run("CREATE TEMP TRIGGER boom BEFORE DELETE ON product_views BEGIN SELECT RAISE(ABORT, 'boom'); END");
      return {};
    });
    expectGenericFailure(env, state, userId, G);
    expect(authSets(env)).toEqual([]);
    expect(counts(env.db, G)).toEqual({ carts: 1, cartItems: 1, views: 1 });
  });

  test("merge throws -> same generic failure", async () => {
    const { env, state, userId, G } = await setupFailure(() => ({
      merge: {
        mergeGuestIntoUser: () => {
          throw new Error(`db exploded ${PASSWORD}`);
        },
      },
    }));
    expectGenericFailure(env, state, userId, G);
    expect(authSets(env)).toEqual([]);
    expect(env.logs.join("\n")).not.toContain(PASSWORD);
  });

  test("setAuthCookie throws -> session revoked, generic failure", async () => {
    const { env, state, userId, G } = await setupFailure(() => ({
      setAuthCookie: async () => {
        throw new TypeError("cookie store unavailable");
      },
    }));
    expectGenericFailure(env, state, userId, G);
  });

  test("rotateGuestSession throws after the cookie is set -> sf_auth cleared and revoked", async () => {
    const { env, state, userId } = await setupFailure((e) => ({
      rotateGuestSession: async () => {
        if (e.jar.has("sf_auth")) throw new Error("rotate failed");
        return "unused";
      },
    }));
    expect(state.code).toBe("INTERNAL_ERROR");
    expect(liveSessions(env.db, userId)).toBe(0);
    expect(env.jar.get("sf_auth")).toBe("");
  });

  test("revalidatePath failure is best-effort: still redirects", async () => {
    const env = makeEnv();
    await createUser(env, "ada@example.com");
    const actions = env.build({
      revalidatePath: () => {
        throw new Error("no static generation store");
      },
    });
    expect(await expectRedirect(actions.signIn(null, signInForm("ada@example.com")))).toBe("/account");
    expect(env.logs).toEqual(["[auth] AUTH_CLEANUP_FAILED action=signIn step=revalidateLayout"]);
  });

  test("unexpected dependency failure before the service -> INTERNAL_ERROR, nothing set", async () => {
    const env = makeEnv();
    const actions = env.build({
      getOrCreateGuestSessionId: async () => {
        throw new Error("sqlite busy");
      },
    });
    const state = await expectState(actions.signIn(null, signInForm("ada@example.com")));
    expect(state.code).toBe("INTERNAL_ERROR");
    expect(env.setCalls).toEqual([]);
    expect(env.logs).toEqual(["[auth] AUTH_ACTION_FAILED action=signIn step=guestSession"]);
  });

  test("Next control-flow errors from a dependency are rethrown, not swallowed", async () => {
    const env = makeEnv();
    const nextError = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/elsewhere;307;" });
    await createUser(env, "ada@example.com");
    const actions = env.build({
      readAuthToken: async () => {
        throw nextError; // reached after credentials succeed (revokePrevious step)
      },
    });
    let caught: unknown;
    try {
      await actions.signIn(null, signInForm("ada@example.com"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(nextError);
  });
});

// ---------------------------------------------------------------------------
// Open redirect (criterion 6, A-83)
// ---------------------------------------------------------------------------

describe("next (open redirect matrix)", () => {
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
    "evil.com",
    "",
    `/${"a".repeat(4096)}`,
  ];
  const safe = ["/orders", "/orders?page=2", "/account/settings", "/products/canvas-tote-bag#reviews"];

  test("signIn: hostile -> /account, safe -> unchanged", async () => {
    const env = makeEnv();
    await createUser(env, "ada@example.com");
    for (const next of [...hostile, ...safe]) {
      env.clock.now += 16 * 60_000; // fresh limiter windows
      env.jar.clear();
      const url = await expectRedirect(env.actions.signIn(null, signInForm("ada@example.com", PASSWORD, { next })));
      expect(url).toBe(safe.includes(next) ? next : "/account");
      expect(url).not.toMatch(/^\/[/\\]/);
    }
  });

  test("signUp: hostile -> /account, safe -> unchanged", async () => {
    const env = makeEnv();
    let i = 0;
    for (const next of ["//evil.com", "https://evil.com", "/\\evil", "javascript:alert(1)", "/orders?page=2"]) {
      env.jar.clear();
      const url = await expectRedirect(env.actions.signUp(null, form({ email: `u${i++}@example.com`, password: PASSWORD, displayName: "U", next })));
      expect(url).toBe(next === "/orders?page=2" ? next : "/account");
    }
  });
});

// ---------------------------------------------------------------------------
// signOut
// ---------------------------------------------------------------------------

describe("signOut", () => {
  test("W-08: revokes only the current session, clears sf_auth, rotates sf_session, redirect /", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    const other = await env.auth.signIn({ email: "a@example.com", password: PASSWORD }, { sessionKey: null, now: env.clock.now });
    if (!other.ok) throw new Error("fixture");
    const GA = crypto.randomUUID();
    env.jar.set("sf_auth", a.token);
    env.jar.set("sf_session", GA);
    const url = await expectRedirect(env.actions.signOut(null, form({})));
    expect(url).toBe("/");
    expect(env.auth.resolveToken(a.token, env.clock.now)).toBeNull(); // replay resolves as guest
    expect(env.auth.resolveToken(other.value.token, env.clock.now)?.user.id).toBe(a.id);
    expect(env.jar.get("sf_auth")).toBe("");
    expect(env.jar.get("sf_session")).not.toBe(GA);
    expect(env.revalidations).toEqual([["/", "layout"]]);
  });

  test("W-09: no sf_auth -> harmless redirect that still rotates; nothing revoked", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    const G = crypto.randomUUID();
    env.jar.set("sf_session", G);
    expect(await expectRedirect(env.actions.signOut(null, form({})))).toBe("/");
    expect(env.jar.get("sf_session")).not.toBe(G);
    expect(liveSessions(env.db, a.id)).toBe(1);
  });

  test("revoke failure: browser still signed out, but the user sees an error", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    env.jar.set("sf_auth", a.token);
    const actions = env.build({
      auth: {
        ...env.auth,
        signOut: () => {
          throw new Error("db locked");
        },
      },
    });
    const state = await expectState(actions.signOut(null, form({})));
    expect(state.code).toBe("INTERNAL_ERROR");
    expect(env.jar.get("sf_auth")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Form shape and secret leakage (criterion 9, AR1)
// ---------------------------------------------------------------------------

describe("form handling and leakage", () => {
  test("browser-shaped multipart FormData (with $ACTION_ID and a File) works", async () => {
    const env = makeEnv();
    const url = await expectRedirect(
      env.actions.signUp(null, await multipart({ email: "ada@example.com", password: PASSWORD, displayName: "Ada", next: "/orders" })),
    );
    expect(url).toBe("/orders");
  });

  test("a File in a contract field counts as missing; a non-FormData argument reads as empty", async () => {
    const env = makeEnv();
    const fd = form({ password: PASSWORD });
    fd.append("email", new File(["ada@example.com"], "email.txt"));
    const state = await expectState(env.actions.signIn(null, fd));
    expect(state.fieldErrors.email).toBeDefined();
    const odd = await expectState(env.actions.signIn(null, { email: "ada@example.com" } as unknown as FormData));
    expect(odd.code).toBe("VALIDATION_FAILED");
  });

  test("only contract fields are read (Proxy-wrapped FormData)", async () => {
    const env = makeEnv();
    const read: string[] = [];
    const real = form({ email: "ada@example.com", password: PASSWORD, displayName: "Ada", userId: "x", role: "admin" });
    const proxy = new Proxy(real, {
      get(target, prop) {
        if (prop === "get" || prop === "getAll") {
          return (name: string) => {
            read.push(name);
            return prop === "get" ? target.get(name) : target.getAll(name);
          };
        }
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expectRedirect(env.actions.signUp(null, proxy));
    expect([...new Set(read)].sort()).toEqual(["displayName", "email", "next", "password"]);
  });

  test("no password, token, token hash or owner key in states, logs, non-auth cookies or redirect URLs", async () => {
    const env = makeEnv();
    const a = await createUser(env, "a@example.com");
    const outputs: string[] = [];
    const record = async (p: Promise<AuthActionState>): Promise<void> => {
      try {
        outputs.push(JSON.stringify(await p));
      } catch (error) {
        if (error instanceof RedirectSentinel) outputs.push(error.url);
        else throw error;
      }
    };
    env.jar.set("sf_auth", a.token);
    await record(env.actions.signIn(null, signInForm("a@example.com", "Wrong-password-1", { next: `/x?pw=${PASSWORD}` })));
    await record(env.actions.signIn(null, signInForm("a@example.com", PASSWORD, { next: "/orders" })));
    await record(env.actions.signUp(null, form({ email: "a@example.com", password: PASSWORD, displayName: "A" })));
    await record(env.actions.signOut(null, form({})));
    const failing = env.build({ merge: { mergeGuestIntoUser: () => fail("VALIDATION_FAILED", "x") } });
    await record(failing.signIn(null, signInForm("a@example.com")));

    const tokens = (env.db.query("SELECT token_hash FROM auth_sessions").all() as { token_hash: string }[]).map((r) => r.token_hash);
    const issuedTokens = authSets(env).map((c) => c.value).filter((v) => v !== "");
    const secrets = [PASSWORD, "Wrong-password-1", a.ownerKey, a.token, ...issuedTokens, ...tokens, "$qa-fast$"];
    const haystack = [
      ...outputs,
      ...env.logs,
      ...env.setCalls.filter((c) => c.name !== "sf_auth").map((c) => c.value),
    ].join("\n");
    for (const secret of secrets) expect(haystack).not.toContain(secret);
    expect(issuedTokens.length).toBeGreaterThan(0);
  });
});
