import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/navigation + next/cache mocks. mock.module is
// process-wide in bun test, so the mocks are registered before `./auth` is
// imported and delegate to per-test state in this file. `redirect` throws an
// error carrying a hand-built NEXT_REDIRECT digest, so the real
// `unstable_rethrow` (kept from next/navigation) recognises it.
// ---------------------------------------------------------------------------

class RedirectSentinel extends Error {
  readonly digest: string;
  constructor(readonly url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

interface SetCall {
  readonly name: string;
  readonly value: string;
  readonly options: unknown;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string, options?: unknown): void {
    this.setCalls.push({ name, value, options });
    this.jar.set(name, value);
  }

  delete(name: string): void {
    this.jar.delete(name);
  }
}

let fakeStore = new FakeCookieStore();
let fakeHeaders = new Headers();
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => fakeHeaders,
}));
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));
mock.module("next/cache", () => ({ revalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { AUTH_COOKIE_NAME, SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { getAuthService } = await import("@/server/auth/auth-service");

closeDatabase();
const dbGlobal = globalThis as typeof globalThis & { __storefrontDb?: unknown };
const wired = await import("./auth");
const dbOpenedAtImport = dbGlobal.__storefrontDb !== undefined;
const { signIn, signOut, signUp } = wired;

const PASSWORD = "Tr0ub4dor&3-qa";
const FORGED = "44444444-4444-4444-8444-444444444444";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function expectRedirect(promise: Promise<unknown>): Promise<string> {
  try {
    const state = await promise;
    throw new Error(`expected a redirect, got ${JSON.stringify(state)}`);
  } catch (error) {
    if (error instanceof RedirectSentinel) return error.url;
    throw error;
  }
}

function cookieSets(name: string): SetCall[] {
  return fakeStore.setCalls.filter((c) => c.name === name);
}

function seedGuestCart(guestId: string): string {
  const db = getDatabase();
  const row = db.query("SELECT id FROM products WHERE stock >= 5 ORDER BY id LIMIT 1").get() as { id: string };
  db.query("INSERT INTO carts (session_id) VALUES (?)").run(guestId);
  db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, 1)").run(guestId, row.id);
  return row.id;
}

function cartOf(owner: string): string[] {
  return (getDatabase().query("SELECT product_id FROM cart_items WHERE cart_session_id = ?").all(owner) as { product_id: string }[]).map(
    (r) => r.product_id,
  );
}

/** Starts a fresh request with the cookies of the previous one (browser behaviour). */
function nextRequest(): void {
  const previous = fakeStore;
  fakeStore = new FakeCookieStore();
  for (const [k, v] of previous.jar) if (v !== "") fakeStore.jar.set(k, v);
  revalidatePath.mockClear();
  redirect.mockClear();
}

beforeEach(() => {
  closeDatabase(); // fresh in-memory DB per test
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
  fakeHeaders = new Headers({ "user-agent": "Mozilla/5.0 (wired test)" });
  revalidatePath.mockClear();
  redirect.mockClear();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("'use server' module shape", () => {
  test("exports only the three async actions and opens no DB at import", () => {
    expect(Object.keys(wired).sort()).toEqual(["signIn", "signOut", "signUp"]);
    for (const value of Object.values(wired) as unknown[]) {
      expect(typeof value).toBe("function");
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
    expect(dbOpenedAtImport).toBe(false);
  });
});

describe("auth server actions (wired, real argon2id)", () => {
  test("sign-up -> wrong / right sign-in -> sign-out -> replay, end to end", async () => {
    // --- sign-up as a guest with a cart, forged fields, hostile next -------
    const G = crypto.randomUUID();
    fakeStore.jar.set(SESSION_COOKIE_NAME, G);
    const product = seedGuestCart(G);
    const signUpUrl = await expectRedirect(
      signUp(
        null,
        form({ email: "Ada@Example.com", password: PASSWORD, displayName: "Ada", next: "//evil.com", ownerKey: FORGED, sessionId: FORGED }),
      ),
    );
    expect(signUpUrl).toBe("/account");
    expect(redirect).toHaveBeenCalledTimes(1);
    expect(revalidatePath.mock.calls).toEqual([["/", "layout"]]);

    const user = getDatabase().query("SELECT id, owner_key FROM users WHERE email = 'ada@example.com'").get() as { id: string; owner_key: string };
    expect(user.owner_key).not.toBe(FORGED);
    expect(cartOf(user.owner_key)).toEqual([product]);
    expect(cartOf(G)).toEqual([]);

    const authSet = cookieSets(AUTH_COOKIE_NAME);
    expect(authSet).toHaveLength(1);
    expect(authSet[0]?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authSet[0]?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const rotated = cookieSets(SESSION_COOKIE_NAME);
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.value).not.toBe(G);
    const firstToken = authSet[0]?.value ?? "";
    const ua = getDatabase().query("SELECT user_agent FROM auth_sessions WHERE user_id = ?").get(user.id) as { user_agent: string };
    expect(ua.user_agent).toBe("Mozilla/5.0 (wired test)");

    // --- wrong password while signed in ------------------------------------
    nextRequest();
    const wrong = await signIn(null, form({ email: "ada@example.com", password: "Wrong-password-1" }));
    expect(wrong).toMatchObject({ ok: false, code: "INVALID_CREDENTIALS", message: "Email or password is incorrect", values: { email: "ada@example.com" } });
    expect(cookieSets(AUTH_COOKIE_NAME)).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(getAuthService().resolveToken(firstToken)?.user.id).toBe(user.id); // failed attempt keeps the session

    // --- correct sign-in replaces the old session (criterion 8) ------------
    nextRequest();
    fakeStore.jar.set(AUTH_COOKIE_NAME, firstToken);
    const signInUrl = await expectRedirect(signIn(null, form({ email: "ada@example.com", password: PASSWORD, next: "/orders?page=2" })));
    expect(signInUrl).toBe("/orders?page=2");
    const secondToken = cookieSets(AUTH_COOKIE_NAME)[0]?.value ?? "";
    expect(secondToken).not.toBe(firstToken);
    expect(getAuthService().resolveToken(firstToken)).toBeNull();
    expect(getAuthService().resolveToken(secondToken)?.user.id).toBe(user.id);

    // --- sign-out revokes server-side; replay resolves as guest ------------
    nextRequest();
    const beforeSignOut = fakeStore.jar.get(SESSION_COOKIE_NAME);
    expect(await expectRedirect(signOut(null, form({})))).toBe("/");
    expect(getAuthService().resolveToken(secondToken)).toBeNull();
    expect(cookieSets(AUTH_COOKIE_NAME)).toMatchObject([{ value: "", options: { maxAge: 0 } }]);
    expect(fakeStore.jar.get(SESSION_COOKIE_NAME)).not.toBe(beforeSignOut);
    expect(revalidatePath.mock.calls).toEqual([["/", "layout"]]);

    // --- replayed (revoked) cookie: a later sign-in from that jar revokes nothing else and works
    nextRequest();
    fakeStore.jar.set(AUTH_COOKIE_NAME, secondToken);
    expect(await expectRedirect(signIn(null, form({ email: "ada@example.com", password: PASSWORD })))).toBe("/account");
    const live = getDatabase().query("SELECT COUNT(*) AS n FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL").get(user.id) as { n: number };
    expect(live.n).toBe(1);

    // Secrets never in a non-auth cookie or a redirect URL.
    for (const url of [signUpUrl, signInUrl]) {
      expect(url).not.toContain(PASSWORD);
      expect(url).not.toContain(user.owner_key);
    }
  });

  test("sign-out without any cookie is a harmless redirect that rotates and opens no DB", async () => {
    closeDatabase();
    expect(await expectRedirect(signOut(null, form({})))).toBe("/");
    expect(dbGlobal.__storefrontDb).toBeUndefined();
    expect(cookieSets(SESSION_COOKIE_NAME)).toHaveLength(1);
  });

  test("validation failure sets no auth cookie and echoes no password", async () => {
    const state = await signUp(null, form({ email: "ada@example.com", password: "short", displayName: "Ada" }));
    expect(state).toMatchObject({ ok: false, code: "VALIDATION_FAILED", values: { email: "ada@example.com", displayName: "Ada" } });
    expect(JSON.stringify(state)).not.toContain('"short"');
    expect(cookieSets(AUTH_COOKIE_NAME)).toEqual([]);
  });
});
