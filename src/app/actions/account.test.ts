import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/cache + next/navigation mocks. mock.module is
// process-wide in bun test, so the mocks are registered before `./account` is
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
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/cache", () => ({ revalidatePath }));
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { createAuthRepository } = await import("@/server/auth/auth-repository");
const { getAuthService } = await import("@/server/auth/auth-service");
const { argon2idHasher } = await import("@/server/auth/password-policy");
const { AUTH_COOKIE_NAME, SESSION_COOKIE_NAME } = await import("@/server/session/session");
const wired = await import("./account");
const { changePassword, deleteAccount, signOutEverywhere, updateProfile } = wired;

const PASSWORD = "wired correct 4417";
const NEW_PASSWORD = "wired renewed 9035";
const GUEST = "6a1f0c2e-3b4d-4c5e-9f60-718293a4b5c6";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One real argon2id hash for the whole file (keeps the run fast). */
const PASSWORD_HASH = await argon2idHasher.hash(PASSWORD);

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

interface Signed {
  readonly userId: string;
  readonly ownerKey: string;
  readonly token: string;
  readonly otherToken: string;
}

let counter = 0;

function signedInUser(): Signed {
  counter += 1;
  const repo = createAuthRepository(getDatabase());
  const created = repo.createUser({ email: `wired-${counter}@example.test`, passwordHash: PASSWORD_HASH, displayName: "Wired" });
  if (!created.ok) throw new Error("fixture createUser");
  const issue = (): string => {
    const issued = getAuthService().issueSessionFor(created.value.id, { sessionKey: null });
    if (!issued.ok) throw new Error("fixture session");
    return issued.value.token;
  };
  const token = issue();
  const otherToken = issue();
  fakeStore.jar.set(AUTH_COOKIE_NAME, token);
  fakeStore.jar.set(SESSION_COOKIE_NAME, GUEST);
  return { userId: created.value.id, ownerKey: created.value.ownerKey, token, otherToken };
}

function displayName(userId: string): string | undefined {
  return getDatabase().query<{ n: string }, [string]>("SELECT display_name AS n FROM users WHERE id = ?").get(userId)?.n;
}

beforeEach(() => {
  closeDatabase(); // fresh in-memory DB per test
  env.DATABASE_PATH = ":memory:";
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
  revalidatePath.mockClear();
  redirect.mockClear();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("'use server' module shape", () => {
  test("exports only the four async actions", () => {
    expect(Object.keys(wired).sort()).toEqual(["changePassword", "deleteAccount", "signOutEverywhere", "updateProfile"]);
    for (const value of Object.values(wired) as unknown[]) {
      expect(typeof value).toBe("function");
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
  });

  test("with no auth cookie no action opens the database (unopenable DB path still yields UNAUTHENTICATED)", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    closeDatabase();
    env.DATABASE_PATH = "/dev/null/account-action-test/db.sqlite";
    try {
      for (const action of [updateProfile, changePassword, deleteAccount, signOutEverywhere]) {
        expect(await action(null, form({ displayName: "x", password: PASSWORD, confirm: "DELETE" }))).toMatchObject({
          ok: false,
          error: { code: "UNAUTHENTICATED" },
        });
      }
      expect(errorSpy).not.toHaveBeenCalled();
      expect(fakeStore.setCalls).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      env.DATABASE_PATH = ":memory:";
    }
  });
});

describe("account actions (wired)", () => {
  test("garbage and revoked sf_auth: UNAUTHENTICATED, no cookie writes, no revalidation (W-16)", async () => {
    const user = signedInUser();
    getAuthService().signOutEverywhere(user.userId);
    for (const token of [user.token, "garbage", "x".repeat(43)]) {
      fakeStore.jar.set(AUTH_COOKIE_NAME, token);
      for (const action of [updateProfile, changePassword, deleteAccount, signOutEverywhere]) {
        expect(await action(null, form({ displayName: "Hacked", password: PASSWORD, confirm: "DELETE" }))).toMatchObject({
          error: { code: "UNAUTHENTICATED" },
        });
      }
    }
    expect(fakeStore.setCalls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
    expect(displayName(user.userId)).toBe("Wired");
  });

  test("updateProfile updates the caller and revalidates the layout and /account", async () => {
    const user = signedInUser();
    const state = await updateProfile(null, form({ displayName: "Renamed", userId: crypto.randomUUID() }));
    expect(state).toMatchObject({ ok: true, kind: "profile_updated", displayName: "Renamed" });
    expect(displayName(user.userId)).toBe("Renamed");
    expect(revalidatePath.mock.calls).toEqual([["/", "layout"], ["/account"]]);
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("changePassword (real argon2id) keeps the current cookie valid and revokes the other session (W-12)", async () => {
    const user = signedInUser();
    const state = await changePassword(
      null,
      form({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD, confirmPassword: NEW_PASSWORD }),
    );
    expect(state).toMatchObject({ ok: true, kind: "password_changed" });
    expect(fakeStore.setCalls).toEqual([]);
    expect(getAuthService().resolveToken(user.token)?.user.id).toBe(user.userId);
    expect(getAuthService().resolveToken(user.otherToken)).toBeNull();
    expect(JSON.stringify(state).includes(NEW_PASSWORD)).toBe(false);
  });

  test("deleteAccount: clears sf_auth, rotates sf_session, redirects /; a second submit is UNAUTHENTICATED (W-14, A-81)", async () => {
    const user = signedInUser();
    const fd = form({ password: PASSWORD, confirm: "DELETE" });
    const error = await deleteAccount(null, fd).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RedirectSentinel);
    expect(redirect.mock.calls).toEqual([["/"]]);
    expect(revalidatePath.mock.calls).toEqual([["/", "layout"]]);

    expect(fakeStore.setCalls.map((c) => c.name)).toEqual([AUTH_COOKIE_NAME, SESSION_COOKIE_NAME]);
    const [authSet, guestSet] = fakeStore.setCalls;
    expect(authSet?.value).toBe("");
    expect(authSet?.options).toMatchObject({ maxAge: 0, path: "/", httpOnly: true });
    expect(guestSet?.value).toMatch(UUID_V4);
    expect(guestSet?.value).not.toBe(GUEST);
    expect(guestSet?.value).not.toBe(user.ownerKey);
    for (const call of fakeStore.setCalls) expect(call.value.includes(PASSWORD)).toBe(false);

    expect(getDatabase().query("SELECT 1 FROM users WHERE id = ?").get(user.userId)).toBeNull();
    expect(getAuthService().resolveToken(user.token)).toBeNull();

    // Second submit: the jar no longer has sf_auth; a stale tab replaying the old token is also refused.
    expect(await deleteAccount(null, fd)).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    fakeStore.jar.set(AUTH_COOKIE_NAME, user.token);
    expect(await deleteAccount(null, fd)).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  test("deleteAccount failure (wrong confirm, wrong password) keeps the user and writes no cookie (W-15)", async () => {
    const user = signedInUser();
    expect(await deleteAccount(null, form({ password: PASSWORD, confirm: "delete" }))).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
      fieldErrors: { confirm: expect.any(String) },
    });
    expect(await deleteAccount(null, form({ password: "wrong password 3", confirm: "DELETE" }))).toMatchObject({
      error: { code: "INVALID_CREDENTIALS" },
      fieldErrors: { password: expect.any(String) },
    });
    expect(getDatabase().query("SELECT 1 FROM users WHERE id = ?").get(user.userId)).not.toBeNull();
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("signOutEverywhere revokes all sessions, clears sf_auth, rotates sf_session, redirects / (W-10)", async () => {
    const user = signedInUser();
    await expect(signOutEverywhere(null, new FormData())).rejects.toBeInstanceOf(RedirectSentinel);
    expect(getAuthService().resolveToken(user.token)).toBeNull();
    expect(getAuthService().resolveToken(user.otherToken)).toBeNull();
    expect(fakeStore.setCalls.map((c) => [c.name, c.value === ""])).toEqual([
      [AUTH_COOKIE_NAME, true],
      [SESSION_COOKIE_NAME, false],
    ]);
    expect(redirect.mock.calls).toEqual([["/"]]);
  });
});
