import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { getURLFromRedirectError, redirect as realRedirect } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { unstable_rethrow as realRethrow } from "next/dist/client/components/unstable-rethrow";

// ---------------------------------------------------------------------------
// next/* mocks (process-wide in bun test), registered before `./page` is
// imported. The cookie jar records every read and spies on `set`/`delete`
// (SR10: render never writes cookies). next/navigation is pinned to Next's
// REAL redirect/unstable_rethrow (imported from next/dist, so a sentinel mock
// from another test file cannot leak in): redirects are real NEXT_REDIRECT
// errors, and the sign-out adapter's rethrow recognises them.
// ---------------------------------------------------------------------------

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly reads: string[] = [];
  readonly set = mock((name: string, value?: string, options?: unknown) => void [name, value, options]);
  readonly delete = mock((name: string) => void name);
  get(name: string): { name: string; value: string } | undefined {
    this.reads.push(name);
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  has(name: string): boolean {
    this.reads.push(name);
    return this.jar.has(name);
  }
}

let fakeStore = new FakeCookieStore();
const navigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
mock.module("next/navigation", () => ({ ...navigation, redirect: realRedirect, unstable_rethrow: realRethrow }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { createAuthRepository } = await import("@/server/auth/auth-repository");
const { getAuthService } = await import("@/server/auth/auth-service");
const session = await import("@/server/session/session");
const { isAllowedInternalHref } = await import("@/content/routes");
const formActions = await import("./_lib/settings-form-actions");
const { default: Page, metadata } = await import("./page");

const { AUTH_COOKIE_NAME, SESSION_COOKIE_NAME } = session;
const SIGN_IN_REDIRECT = "/signin?next=%2Faccount%2Fsettings";
const GUEST = "6a1f0c2e-3b4d-4c5e-9f60-718293a4b5c6";
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const FIXTURE_HASH = "$argon2id$v=19$m=65536,t=2,p=1$fixturesaltfixturesalt$fixturehashfixturehashfixturehash";

const readSessionIdSpy = spyOn(session, "readSessionId");
const getOrCreateSpy = spyOn(session, "getOrCreateSessionId");
const rotateSpy = spyOn(session, "rotateGuestSession");

function sha256hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

interface Fixture {
  readonly id: string;
  readonly ownerKey: string;
  readonly email: string;
  readonly displayName: string;
  readonly token: string;
  readonly authSessionId: string;
}

/** Emails/names deliberately contain no hex-only runs, so the UUID scan is meaningful. */
function createFixture(tag: string, displayName: string): Fixture {
  const repo = createAuthRepository(getDatabase());
  const email = `settings-${tag}@example.test`;
  const user = repo.createUser({ email, passwordHash: FIXTURE_HASH, displayName });
  if (!user.ok) throw new Error(`createUser failed: ${user.error.code}`);
  const token = newToken();
  const issuedAt = Date.now();
  const created = repo.createAuthSession(
    { userId: user.value.id, tokenHash: sha256hex(token), expiresAt: new Date(issuedAt + 30 * DAY_MS).toISOString() },
    issuedAt,
  );
  if (!created.ok) throw new Error(`createAuthSession failed: ${created.error.code}`);
  return {
    id: user.value.id,
    ownerKey: user.value.ownerKey,
    email: user.value.email,
    displayName: user.value.displayName,
    token,
    authSessionId: created.value.id,
  };
}

function jar(entries: Record<string, string>): FakeCookieStore {
  const store = new FakeCookieStore();
  for (const [k, v] of Object.entries(entries)) store.jar.set(k, v);
  return store;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (isRedirectError(error)) return getURLFromRedirectError(error);
    throw error;
  }
  throw new Error("expected a redirect");
}

async function renderPage(searchParams: Record<string, string> = {}) {
  return Page({ searchParams: Promise.resolve(searchParams) });
}

function expectNoCookieWrites(store: FakeCookieStore): void {
  expect(store.set).not.toHaveBeenCalled();
  expect(store.delete).not.toHaveBeenCalled();
  expect(getOrCreateSpy).not.toHaveBeenCalled();
  expect(rotateSpy).not.toHaveBeenCalled();
}

let userA: Fixture;
let userB: Fixture;
let revoked: Fixture;
let expired: { token: string };
let deleted: Fixture;

beforeAll(() => {
  closeDatabase();
  getDatabase();
  userA = createFixture("alpha", "Alpha Person");
  userB = createFixture("bravo", "Bravo Person");
  revoked = createFixture("revoked", "Revoked Person");
  getAuthService().signOut(revoked.token);
  deleted = createFixture("deleted", "Deleted Person");
  getDatabase().query("DELETE FROM users WHERE id = ?").run(deleted.id);

  const repo = createAuthRepository(getDatabase());
  const extra = createFixture("expired", "Expired Person");
  const token = newToken();
  const issuedAt = Date.now() - 40 * DAY_MS;
  const s = repo.createAuthSession(
    { userId: extra.id, tokenHash: sha256hex(token), expiresAt: new Date(issuedAt + 30 * DAY_MS).toISOString() },
    issuedAt,
  );
  if (!s.ok) throw new Error("expired session fixture failed");
  expired = { token };
});

afterEach(() => {
  cleanup();
  getOrCreateSpy.mockClear();
  rotateSpy.mockClear();
  readSessionIdSpy.mockClear();
});

afterAll(() => {
  readSessionIdSpy.mockRestore();
  getOrCreateSpy.mockRestore();
  rotateSpy.mockRestore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

// ---------------------------------------------------------------------------
// Criterion 1: guests are redirected, never 404, never see user data
// ---------------------------------------------------------------------------

describe("guest -> sign-in redirect (criterion 1)", () => {
  const cases: [string, () => Record<string, string>][] = [
    ["no cookies", () => ({})],
    ["guest sf_session only", () => ({ [SESSION_COOKIE_NAME]: GUEST })],
    ["garbage sf_auth", () => ({ [AUTH_COOKIE_NAME]: "garbage<script>", [SESSION_COOKIE_NAME]: GUEST })],
    ["well-formed unknown sf_auth", () => ({ [AUTH_COOKIE_NAME]: newToken() })],
    ["revoked sf_auth", () => ({ [AUTH_COOKIE_NAME]: revoked.token })],
    ["expired sf_auth", () => ({ [AUTH_COOKIE_NAME]: expired.token })],
    ["sf_auth of a deleted user", () => ({ [AUTH_COOKIE_NAME]: deleted.token })],
    ["guest sf_session equal to a user's owner key (R-1)", () => ({ [SESSION_COOKIE_NAME]: userA.ownerKey })],
  ];

  for (const [name, cookies] of cases) {
    test(`${name}: redirects to ${SIGN_IN_REDIRECT}, writes no cookie, reads only the auth cookies`, async () => {
      fakeStore = jar(cookies());
      expect(await redirectOf(() => renderPage())).toBe(SIGN_IN_REDIRECT);
      expectNoCookieWrites(fakeStore);
      expect(readSessionIdSpy).not.toHaveBeenCalled();
      for (const read of fakeStore.reads) expect([AUTH_COOKIE_NAME, SESSION_COOKIE_NAME]).toContain(read);
    });
  }

  test("the redirect also wins over search params (no data rendered)", async () => {
    fakeStore = jar({});
    expect(await redirectOf(() => renderPage({ sessions: "error" }))).toBe(SIGN_IN_REDIRECT);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 + 4: signed-in render shows only the caller, leaks nothing
// ---------------------------------------------------------------------------

describe("signed-in render (criteria 2 and 4)", () => {
  test("user A sees one h1, the breadcrumb, the four sections and their own name/email", async () => {
    fakeStore = jar({ [AUTH_COOKIE_NAME]: userA.token, [SESSION_COOKIE_NAME]: GUEST });
    render(await renderPage());
    expectNoCookieWrites(fakeStore);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Login & security");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Profile",
      "Password",
      "Sessions",
      "Delete account",
    ]);
    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(crumbs).getByRole("link", { name: "Your Account" })).toHaveAttribute("href", "/account");
    expect(crumbs).toHaveTextContent("Login & security");
    expect(screen.getByTestId("profile-email")).toHaveTextContent(userA.email);
    expect(screen.getByRole("textbox", { name: /display name/i })).toHaveValue("Alpha Person");
    expect(screen.getByRole("button", { name: "Sign out of all devices" })).toHaveAttribute("type", "submit");
    expect(document.body.textContent).not.toContain(userB.email);
  });

  test("two users: each render contains only the caller's email and name", async () => {
    fakeStore = jar({ [AUTH_COOKIE_NAME]: userA.token });
    const htmlA = renderToStaticMarkup(await renderPage());
    fakeStore = jar({ [AUTH_COOKIE_NAME]: userB.token });
    const htmlB = renderToStaticMarkup(await renderPage());
    expectNoCookieWrites(fakeStore);

    expect(htmlA).toContain(userA.email);
    expect(htmlA).toContain("Alpha Person");
    expect(htmlA).not.toContain(userB.email);
    expect(htmlA).not.toContain("Bravo Person");

    expect(htmlB).toContain(userB.email);
    expect(htmlB).toContain("Bravo Person");
    expect(htmlB).not.toContain(userA.email);
    expect(htmlB).not.toContain("Alpha Person");
  });

  test("markup contains no UUID, id, owner key, token, token hash, session id or password hash; email once, never in an attribute", async () => {
    for (const user of [userA, userB]) {
      fakeStore = jar({ [AUTH_COOKIE_NAME]: user.token, [SESSION_COOKIE_NAME]: GUEST });
      const html = renderToStaticMarkup(await renderPage({ sessions: "error" }));
      expect(html).not.toMatch(UUID_RE);
      for (const secret of [user.id, user.ownerKey, user.token, sha256hex(user.token), user.authSessionId, GUEST, FIXTURE_HASH]) {
        expect(html).not.toContain(secret);
      }
      expect(html).not.toContain("$argon2");
      expect(html.split(user.email)).toHaveLength(2);
      const doc = new DOMParser().parseFromString(html, "text/html");
      for (const el of Array.from(doc.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) expect(attr.value).not.toContain(user.email);
      }
      for (const input of Array.from(doc.querySelectorAll('input[type="password"]'))) {
        expect(input.getAttribute("value") ?? "").toBe("");
      }
    }
  });

  test("forms: four, none nested, contract field names, no hidden identity fields", async () => {
    fakeStore = jar({ [AUTH_COOKIE_NAME]: userA.token });
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(await renderPage()), "text/html");
    expect(doc.querySelectorAll("form")).toHaveLength(4);
    expect(doc.querySelectorAll("form form")).toHaveLength(0);
    const names = Array.from(doc.querySelectorAll("form input, form textarea, form select"))
      .map((el) => el.getAttribute("name") ?? "")
      .filter((n) => n !== "");
    expect(names.sort()).toEqual(["confirm", "confirmPassword", "currentPassword", "displayName", "newPassword", "password"]);
    for (const banned of ["userId", "ownerKey", "sessionId", "email", "token"]) expect(names).not.toContain(banned);
  });

  test("every href passes isAllowedInternalHref", async () => {
    fakeStore = jar({ [AUTH_COOKIE_NAME]: userA.token });
    render(await renderPage());
    const hrefs = Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(isAllowedInternalHref(href)).toBe(true);
  });

  test("?sessions=error shows the sessions error notice", async () => {
    fakeStore = jar({ [AUTH_COOKIE_NAME]: userA.token });
    render(await renderPage({ sessions: "error" }));
    expect(screen.getByRole("alert")).toHaveTextContent("We could not sign you out of all devices.");
  });
});

describe("metadata (criteria 2 and 4)", () => {
  test("noindex, title and canonical; carries no user data", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe("Login & security");
    expect(String(metadata.alternates?.canonical ?? "")).toEndWith("/account/settings");
    const json = JSON.stringify(metadata);
    expect(json).not.toMatch(UUID_RE);
    for (const value of [userA.email, userA.displayName, userA.token, userA.ownerKey]) expect(json).not.toContain(value);
  });
});

// ---------------------------------------------------------------------------
// "Sign out of all devices" adapter (wired to the real action)
// ---------------------------------------------------------------------------

describe("signOutEverywhereFromSettings", () => {
  test("'use server' module exports only async functions", () => {
    expect(Object.keys(formActions)).toEqual(["signOutEverywhereFromSettings"]);
    for (const value of Object.values(formActions)) expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
  });

  test("unauthenticated post -> sign-in redirect, no cookie write", async () => {
    fakeStore = jar({ [AUTH_COOKIE_NAME]: newToken() });
    expect(await redirectOf(() => formActions.signOutEverywhereFromSettings(new FormData()))).toBe(SIGN_IN_REDIRECT);
    expect(fakeStore.set).not.toHaveBeenCalled();
    expect(fakeStore.delete).not.toHaveBeenCalled();
  });

  test("signed-in post revokes every session of the caller only and redirects to /", async () => {
    const caller = createFixture("charlie", "Charlie Person");
    const other = createFixture("delta", "Delta Person");
    fakeStore = jar({ [AUTH_COOKIE_NAME]: caller.token, [SESSION_COOKIE_NAME]: GUEST });
    const posted = new FormData();
    posted.set("userId", other.id);
    expect(await redirectOf(() => formActions.signOutEverywhereFromSettings(posted))).toBe("/");
    expect(getAuthService().resolveToken(caller.token)).toBeNull();
    expect(getAuthService().resolveToken(other.token)).not.toBeNull();
    const authWrites = [
      ...fakeStore.set.mock.calls.filter((c) => c[0] === AUTH_COOKIE_NAME),
      ...fakeStore.delete.mock.calls.filter((c) => c[0] === AUTH_COOKIE_NAME),
    ];
    expect(authWrites.length).toBeGreaterThan(0);
  });
});
