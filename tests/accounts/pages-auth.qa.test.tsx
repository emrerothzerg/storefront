import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { getURLFromRedirectError, redirect as realRedirect } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { unstable_rethrow as realRethrow } from "next/dist/client/components/unstable-rethrow";

// ---------------------------------------------------------------------------
// T129a QA: /signin, /signup (T127) and /account/settings (T128) pages, and
// the T120/T121 actions as posted by their forms.
//
// next/* mocks are process-wide in bun test, so they are registered before
// any app import. next/navigation is pinned to Next's REAL redirect /
// unstable_rethrow (imported from next/dist so another file's sentinel mock
// cannot leak in): redirects are real NEXT_REDIRECT errors.
//
// App DB = `getDatabase()` on DATABASE_PATH=":memory:"; the app-wide auth /
// account services are swapped for ones using the QA fast hasher (no argon2
// cost), exactly as tests/accounts/actions.qa.test.ts does.
// ---------------------------------------------------------------------------

import { QaCookieStore } from "./_fixtures";

let store = new QaCookieStore();
const navigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({
  cookies: async (): Promise<QaCookieStore> => store,
  headers: async (): Promise<Headers> => new Headers({ "user-agent": "qa-pages/1.0" }),
}));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
mock.module("next/navigation", () => ({ ...navigation, redirect: realRedirect, unstable_rethrow: realRethrow }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
closeDatabase();
const { seedDatabase } = await import("@/server/db/seed");
const { createAuthService, getAuthService } = await import("@/server/auth/auth-service");
const { createAuthRepository } = await import("@/server/auth/auth-repository");
const { createAccountService } = await import("@/server/auth/account-service");
const { validatePassword } = await import("@/server/auth/password-policy");
const { getRateLimiter } = await import("@/server/security/rate-limiter");
const session = await import("@/server/session/session");
const authActions = await import("@/app/actions/auth");
const accountActions = await import("@/app/actions/account");
const settingsFormActions = await import("@/app/account/settings/_lib/settings-form-actions");
const { isAllowedInternalHref } = await import("@/content/routes");
const { buildSiteSitemap } = await import("@/lib/seo/sitemap");
const { policyFor } = await import("@/lib/seo/routes");
const { SignInForm } = await import("@/components/molecules/SignInForm");
const { SignUpForm } = await import("@/components/molecules/SignUpForm");
const { AUTH_FORM_MESSAGES } = await import("@/components/molecules/SignInForm/auth-form-helpers");
const signinPage = await import("@/app/signin/page");
const signupPage = await import("@/app/signup/page");
const settingsPage = await import("@/app/account/settings/page");
const fx = await import("./_fixtures");
const { PASSWORD, SecretRegistry, consoleCapture, fastHasher, form, sha256hex, uuid, T0, MIN } = fx;

const { AUTH_COOKIE_NAME: AUTH, SESSION_COOKIE_NAME: GUEST_COOKIE } = session;
const SETTINGS_REDIRECT = "/signin?next=%2Faccount%2Fsettings";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DAY = 24 * 60 * 60 * 1000;
const WRONG_PW = "Wr0ng-Passw0rd-qa!";
const HOSTILE_NAME = '<img src=x onerror="alert(1)">';
const RTL_50 = "אבגדה".repeat(10);
const BIDI_NAME = "Eve‮live‬";

type AnyPage = (props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) => Promise<ReactElement>;
const SignInPage = signinPage.default as AnyPage;
const SignUpPage = signupPage.default as AnyPage;
const SettingsPage = settingsPage.default as AnyPage;
type AuthState = import("@/components/molecules/_contracts/auth-actions").AuthActionState;

// ---------------------------------------------------------------------------
// App + identities
// ---------------------------------------------------------------------------

const hasher = fastHasher();
const secrets = new SecretRegistry();
secrets.add(PASSWORD, WRONG_PW);
const seededIds = new Set<string>();
const capture = consoleCapture();
const htmlLog: string[] = [];

const g = globalThis as typeof globalThis & {
  __storefrontAuthService?: { db: unknown; service: unknown };
  __storefrontAccountService?: { db: unknown; service: unknown };
};

function harvest(): void {
  try {
    secrets.harvest(getDatabase());
    for (const r of getDatabase().query("SELECT id FROM users").all() as { id: string }[]) seededIds.add(r.id);
    for (const r of getDatabase().query("SELECT id FROM auth_sessions").all() as { id: string }[]) seededIds.add(r.id);
  } catch {
    /* closed */
  }
}

function resetApp(): void {
  harvest();
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

interface Identity {
  readonly id: string;
  readonly ownerKey: string;
  readonly email: string;
  readonly displayName: string;
  readonly token: string;
  readonly authSessionId: string;
}

function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** Users through createAuthRepository with a fast-hasher hash (no argon2 cost). Non-hex tags only. */
async function makeUser(email: string, displayName: string, opts: { expired?: boolean; revoked?: boolean } = {}): Promise<Identity> {
  const repo = createAuthRepository(getDatabase());
  const created = repo.createUser({ email, passwordHash: await hasher.hash(PASSWORD), displayName });
  if (!created.ok) throw new Error(`createUser ${email}: ${created.error.code}`);
  const token = newToken();
  const issuedAt = opts.expired ? Date.now() - 40 * DAY : Date.now();
  const s = repo.createAuthSession(
    { userId: created.value.id, tokenHash: sha256hex(token), expiresAt: new Date(issuedAt + 30 * DAY).toISOString() },
    issuedAt,
  );
  if (!s.ok) throw new Error(`createAuthSession: ${s.error.code}`);
  if (opts.revoked) repo.revokeAuthSession(s.value.id);
  secrets.add(token, sha256hex(token));
  secrets.addOwnerKey(created.value.ownerKey);
  seededIds.add(created.value.id);
  seededIds.add(s.value.id);
  return {
    id: created.value.id,
    ownerKey: created.value.ownerKey,
    email: created.value.email,
    displayName: created.value.displayName,
    token,
    authSessionId: s.value.id,
  };
}

function browser(cookies: Readonly<Record<string, string | undefined>> = {}): QaCookieStore {
  store = new QaCookieStore(cookies);
  for (const v of Object.values(cookies)) if (v !== undefined && UUID_RE.test(v)) seededIds.add(v);
  return store;
}

function expectNoCookieWrites(s: QaCookieStore = store): void {
  expect(s.setCalls).toEqual([]);
  expect(s.deleteCalls).toEqual([]);
}

async function html(page: AnyPage, search: Record<string, string | string[] | undefined> = {}): Promise<string> {
  const out = renderToStaticMarkup(await page({ searchParams: Promise.resolve(search) }));
  htmlLog.push(out);
  return out;
}

/**
 * Target URL of a redirect error, or null when `error` is not a redirect.
 * Accepts Next's real redirect error AND any sentinel whose message starts with
 * `NEXT_REDIRECT` (T173 addendum): when this file shares a process with
 * `src/app/signin/page.test.tsx`, that file's `next/navigation` mock (message
 * "NEXT_REDIRECT /account (test sentinel)") may be the one the page module
 * bound first. A `url` property wins; otherwise the first path-like token of
 * the message is used.
 */
function redirectTarget(error: unknown): string | null {
  if (isRedirectError(error)) return getURLFromRedirectError(error);
  if (!(error instanceof Error) || !error.message.startsWith("NEXT_REDIRECT")) return null;
  const url: unknown = (error as Error & { url?: unknown }).url;
  if (typeof url === "string") return url;
  const token = error.message.split(/\s+/).find((t) => t.startsWith("/"));
  return token ?? null;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const target = redirectTarget(error);
    if (target !== null) return target;
    throw error;
  }
  throw new Error("expected a redirect");
}

/** Resolves to `{ redirect }` or the returned state. */
async function act(run: Promise<AuthState | unknown>): Promise<{ redirect: string } | AuthState> {
  try {
    return (await run) as AuthState;
  } catch (error) {
    const target = redirectTarget(error);
    if (target !== null) return { redirect: target };
    throw error;
  }
}

function parse(markup: string): Document {
  return new DOMParser().parseFromString(markup, "text/html");
}

/**
 * Short string for a DOM node (or null). Assertions compare these instead of
 * the nodes: a FAILING `expect(node)` makes bun serialise the whole happy-dom
 * object graph (window, document) — multi-GB in a shared process (TEST-MEM).
 */
function tagOf(node: Element | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  const testId = node.getAttribute("data-testid");
  return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${testId ? `[data-testid=${testId}]` : ""} ${node.outerHTML.slice(0, 120)}`;
}

/** Focus check as strings (see tagOf). */
function expectFocused(node: Element | null | undefined): void {
  expect(tagOf(document.activeElement)).toBe(tagOf(node));
}

function hiddenNext(doc: Document): string | null {
  return doc.querySelector('input[type="hidden"][name="next"]')?.getAttribute("value") ?? null;
}

function hrefs(doc: Document): string[] {
  return Array.from(doc.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
}

function expectHrefsAllowed(doc: Document): void {
  for (const href of hrefs(doc)) {
    if (href.startsWith("#")) {
      expect(doc.getElementById(href.slice(1))).not.toBeNull();
      continue;
    }
    expect([href, isAllowedInternalHref(href)]).toEqual([href, true]);
  }
}

function headingLevels(doc: Document): number[] {
  return Array.from(doc.querySelectorAll("h1, h2, h3, h4, h5, h6")).map((h) => Number(h.tagName.slice(1)));
}

function expectHeadingOutline(doc: Document): void {
  const levels = headingLevels(doc);
  expect(levels.filter((l) => l === 1)).toHaveLength(1);
  expect(levels[0]).toBe(1);
  for (let i = 1; i < levels.length; i++) expect((levels[i] ?? 0) - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
}

function duplicateIds(doc: Document): string[] {
  const seen = new Map<string, number>();
  for (const el of Array.from(doc.querySelectorAll("[id]"))) seen.set(el.id, (seen.get(el.id) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id);
}

function danglingRefs(doc: Document): string[] {
  const out: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("[for], [aria-describedby], [aria-labelledby], [aria-controls]"))) {
    for (const attr of ["for", "aria-describedby", "aria-labelledby", "aria-controls"]) {
      for (const ref of (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean)) {
        if (doc.querySelectorAll(`[id="${ref}"]`).length !== 1) out.push(`${attr}->${ref}`);
      }
    }
  }
  return out;
}

function narrowViewportOffenders(doc: Document): string[] {
  const out: string[] = [];
  for (const el of Array.from(doc.querySelectorAll("[class]"))) {
    for (const cls of (el.getAttribute("class") ?? "").split(/\s+/)) {
      if (cls.includes(":")) continue;
      const fixed = /^(w|min-w)-(\d+)$/.exec(cls);
      if (fixed && Number(fixed[2]) * 4 > 280) out.push(cls);
      if (cls === "whitespace-nowrap" || cls === "w-screen") out.push(cls);
    }
  }
  return out;
}

/**
 * Gives a real exported action the `$$FORM_ACTION` hook a Next server
 * reference exposes to React SSR (same shape as the molecules' fixture), so
 * the page markup shows whether the page passes the action UNWRAPPED (real
 * POST form) or wraps it (javascript: action). Restored by the returned fn.
 */
function tagServerReference(fn: object): () => void {
  const formFields = () => ({ name: "$ACTION_REF_QA", action: "", encType: "multipart/form-data", method: "POST", data: null });
  Object.defineProperty(fn, "$$FORM_ACTION", { value: formFields, configurable: true });
  Object.defineProperty(fn, "bind", {
    value: () => Object.assign(async () => null, { $$FORM_ACTION: formFields }),
    configurable: true,
  });
  return () => {
    Reflect.deleteProperty(fn, "$$FORM_ACTION");
    Reflect.deleteProperty(fn, "bind");
  };
}

afterEach(() => {
  setSystemTime();
});

afterAll(() => {
  setSystemTime();
  capture.restore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

beforeEach(() => {
  setSystemTime(); // never inherit a frozen clock from an earlier file
  hasher.reset();
});

// ---------------------------------------------------------------------------
// Criterion 1 (pages): no-JS shape with the real exported actions
// ---------------------------------------------------------------------------

describe("criterion 1: page-level no-JS shape (real actions tagged as server references)", () => {
  test("/signin and /signup: one POST multipart form each, contract names only, no identity fields", async () => {
    resetApp();
    browser();
    const restore = [tagServerReference(authActions.signIn), tagServerReference(authActions.signUp)];
    try {
      for (const [page, expected] of [
        [SignInPage, ["email", "next", "password"]],
        [SignUpPage, ["displayName", "email", "next", "password"]],
      ] as const) {
        const doc = parse(await html(page, { next: "/orders" }));
        const forms = doc.querySelectorAll("form");
        expect(forms).toHaveLength(1);
        const f = forms[0] as HTMLFormElement;
        expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
        expect(f.getAttribute("enctype")).toBe("multipart/form-data");
        expect(f.getAttribute("action") ?? "").not.toContain("javascript:");
        const names = Array.from(f.querySelectorAll("[name]"))
          .map((el) => el.getAttribute("name") ?? "")
          .filter((n) => !n.startsWith("$ACTION"));
        expect(names.sort()).toEqual([...expected]);
        expect(f.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
        for (const pw of Array.from(f.querySelectorAll('input[type="password"]'))) expect(pw.hasAttribute("value")).toBe(false);
      }
    } finally {
      for (const r of restore) r();
    }
    expectNoCookieWrites();
  }, 30_000);

  test("/account/settings: four POST multipart forms (profile, password, sign-out-everywhere, delete); no identity fields", async () => {
    resetApp();
    const user = await makeUser("qa-kilo@example.test", "Kilo Person");
    browser({ [AUTH]: user.token });
    const restore = [
      tagServerReference(accountActions.updateProfile),
      tagServerReference(accountActions.changePassword),
      tagServerReference(accountActions.deleteAccount),
      tagServerReference(settingsFormActions.signOutEverywhereFromSettings),
    ];
    try {
      const markup = await html(SettingsPage);
      const doc = parse(markup);
      const forms = Array.from(doc.querySelectorAll("form"));
      expect(forms).toHaveLength(4);
      for (const f of forms) {
        expect([f.id, f.getAttribute("method")?.toLowerCase()]).toEqual([f.id, "post"]);
        expect([f.id, f.getAttribute("enctype")]).toEqual([f.id, "multipart/form-data"]);
        expect(f.querySelectorAll('button[type="submit"]')).toHaveLength(1);
        expect(f.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(false);
        for (const hidden of Array.from(f.querySelectorAll('input[type="hidden"]'))) {
          expect(hidden.getAttribute("name") ?? "").toMatch(/^\$ACTION/);
        }
      }
      expect(markup).not.toContain("javascript:");
      const sessions = forms.find((f) => f.getAttribute("aria-labelledby") === "settings-sessions-heading");
      expect(sessions).toBeDefined();
      expect(Array.from(sessions?.querySelectorAll("[name]") ?? []).filter((e) => !(e.getAttribute("name") ?? "").startsWith("$ACTION"))).toEqual([]);
      for (const banned of ["userId", "ownerKey", "sessionId", "email", "token"]) expect(tagOf(doc.querySelector(`form [name="${banned}"]`))).toBeNull();
      const ac = (name: string) => Array.from(doc.querySelectorAll(`[name="${name}"]`)).map((e) => e.getAttribute("autocomplete"));
      expect(ac("currentPassword")).toEqual(["current-password"]);
      expect(ac("newPassword")).toEqual(["new-password"]);
      expect(ac("confirmPassword")).toEqual(["new-password"]);
      expect(ac("password")).toEqual(["current-password"]);
      for (const input of Array.from(doc.querySelectorAll("form input:not([type=hidden])"))) {
        expect([input.getAttribute("name"), doc.querySelector(`label[for="${input.id}"]`) !== null]).toEqual([input.getAttribute("name"), true]);
      }
      for (const pw of Array.from(doc.querySelectorAll('input[type="password"]'))) expect(pw.hasAttribute("value")).toBe(false);
    } finally {
      for (const r of restore) r();
    }
    expectNoCookieWrites();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Criterion 2: open-redirect matrix on the pages and through the actions
// ---------------------------------------------------------------------------

const HOSTILE: readonly (string | string[])[] = [
  "//evil.com",
  "https://evil.com",
  "http:/evil.com",
  "///evil.com",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,x",
  "/\\evil.com",
  "\\\\evil.com",
  "/%5Cevil.com",
  "%2F%2Fevil.com",
  "/%2F/evil.com",
  "/%2f%2fevil.com",
  "/\t/evil.com",
  "/\n/evil.com",
  "/orders\u0000",
  "/orders%00",
  "/orders%0d%0aSet-Cookie",
  " //evil.com",
  "evil.com",
  "",
  `/${"a".repeat(2047)}`,
  "/signin",
  "/signup",
  "/signin?next=/orders",
  "/signup#top",
  ["/orders", "/cart"],
  ["//evil.com", "/orders"],
];

const SAFE: readonly [string, string][] = [
  ["/orders", "%2Forders"],
  ["/orders?page=2", "%2Forders%3Fpage%3D2"],
  ["/account/settings", "%2Faccount%2Fsettings"],
  ["/products/canvas-tote-bag#reviews", "%2Fproducts%2Fcanvas-tote-bag%23reviews"],
];

describe("criterion 2: open redirect via next", () => {
  test("guest render of /signin and /signup: every hostile next dropped (no hidden next, plain cross-link, no evil/javascript)", async () => {
    resetApp();
    for (const [page, cross] of [
      [SignInPage, "/signup"],
      [SignUpPage, "/signin"],
    ] as const) {
      for (const raw of HOSTILE) {
        browser({ [GUEST_COOKIE]: uuid() });
        const markup = await html(page, { next: raw });
        const doc = parse(markup);
        expect([raw, hiddenNext(doc)]).toEqual([raw, null]);
        expect(hrefs(doc).filter((h) => h.startsWith(cross))).toEqual([cross]);
        expect(markup.toLowerCase()).not.toContain("evil");
        // (bun has no server-reference compiler: the untagged real action renders React's
        // javascript: placeholder as the FORM action; criterion 1 covers that with tagging.)
        for (const el of Array.from(doc.querySelectorAll("[href], input"))) {
          expect(`${el.getAttribute("href") ?? ""} ${el.getAttribute("value") ?? ""}`.toLowerCase()).not.toContain("javascript:");
        }
        expectHrefsAllowed(doc);
        expectNoCookieWrites();
      }
    }
  }, 30_000);

  test("guest render: safe next kept in the hidden input and percent-encoded in the cross-link", async () => {
    resetApp();
    for (const [page, cross] of [
      [SignInPage, "/signup"],
      [SignUpPage, "/signin"],
    ] as const) {
      for (const [raw, encoded] of SAFE) {
        browser();
        const doc = parse(await html(page, { next: raw }));
        expect(hiddenNext(doc)).toBe(raw);
        expect(hrefs(doc)).toContain(`${cross}?next=${encoded}`);
        expectHrefsAllowed(doc);
      }
    }
  }, 30_000);

  test("signed-in visitor: hostile next -> /account, safe next kept, loop guard (/signin, /signup) -> /account; no cookie writes", async () => {
    resetApp();
    const user = await makeUser("qa-lima@example.test", "Lima Person");
    for (const page of [SignInPage, SignUpPage]) {
      for (const raw of HOSTILE) {
        browser({ [AUTH]: user.token });
        expect([raw, await redirectOf(() => page({ searchParams: Promise.resolve({ next: raw }) }))]).toEqual([raw, "/account"]);
        expectNoCookieWrites();
      }
      for (const [raw] of SAFE) {
        browser({ [AUTH]: user.token });
        expect(await redirectOf(() => page({ searchParams: Promise.resolve({ next: raw }) }))).toBe(raw);
      }
    }
  }, 30_000);

  test("settings round trip: guest redirect -> /signin?next=%2Faccount%2Fsettings -> hidden next /account/settings -> sign-in through that form lands on /account/settings", async () => {
    resetApp();
    const user = await makeUser("qa-mike@example.test", "Mike Person");
    browser();
    const target = await redirectOf(() => SettingsPage({ searchParams: Promise.resolve({}) }));
    expect(target).toBe(SETTINGS_REDIRECT);
    const next = new URL(target, "http://x.test").searchParams.get("next") ?? "";
    expect(next).toBe("/account/settings");
    const doc = parse(await html(SignInPage, { next }));
    expect(hiddenNext(doc)).toBe("/account/settings");
    expect(hrefs(doc)).toContain("/signup?next=%2Faccount%2Fsettings");
    browser({ [GUEST_COOKIE]: uuid() });
    const r = await act(authActions.signIn(null, form({ email: user.email, password: PASSWORD, next: hiddenNext(doc) ?? "" })));
    expect(r).toEqual({ redirect: "/account/settings" });
    for (const c of store.setsOf(AUTH)) secrets.add(c.value);
  }, 30_000);

  test("through the actions as posted by the forms: hostile next (posted raw, as a forged field) -> /account; safe kept", async () => {
    resetApp();
    const user = await makeUser("qa-oscar@example.test", "Oscar Person");
    const values = ["//evil.com", "https://evil.com", "javascript:alert(1)", "/\\evil.com", "%2F%2Fevil.com", `/${"a".repeat(2047)}`, "/orders\u0000"];
    for (const raw of values) {
      browser({ [GUEST_COOKIE]: uuid() });
      const r = await act(authActions.signIn(null, form({ email: user.email, password: PASSWORD, next: raw })));
      expect([raw, r]).toEqual([raw, { redirect: "/account" }]);
      for (const c of store.setsOf(AUTH)) secrets.add(c.value);
    }
    // Duplicated next keys: the first wins (contract), and a hostile first value is still rejected.
    browser({ [GUEST_COOKIE]: uuid() });
    const dup = await act(
      authActions.signIn(null, form([["email", user.email], ["password", PASSWORD], ["next", "//evil.com"], ["next", "/orders"]])),
    );
    expect(dup).toEqual({ redirect: "/account" });
    for (const c of store.setsOf(AUTH)) secrets.add(c.value);
    // sign-up through the action with a hostile next
    browser({ [GUEST_COOKIE]: uuid() });
    const su = await act(authActions.signUp(null, form({ email: "qa-papa@example.test", password: PASSWORD, displayName: "Papa", next: "https://evil.com" })));
    expect(su).toEqual({ redirect: "/account" });
    for (const c of store.setsOf(AUTH)) secrets.add(c.value);
    // A posted next of /signin is not loop-guarded by the action, but the signed-in /signin page then sends to /account (2 hops, no loop).
    browser({ [GUEST_COOKIE]: uuid() });
    const loop = await act(authActions.signIn(null, form({ email: user.email, password: PASSWORD, next: "/signin" })));
    expect(loop).toEqual({ redirect: "/signin" });
    const token = store.setsOf(AUTH)[0]?.value ?? "";
    secrets.add(token);
    browser({ [AUTH]: token });
    expect(await redirectOf(() => SignInPage({ searchParams: Promise.resolve({}) }))).toBe("/account");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Criterion 3: R-10 through the real SignInForm + signIn action
// ---------------------------------------------------------------------------

type AuthFn = typeof authActions.signIn;

/** Resolves (inside act) to the first scripted state; the replay action never stays pending. */
function replay(state: AuthState): AuthFn {
  return async () => state;
}

/**
 * "Through the form" without running the real action inside React (TEST-MEM:
 * real actions dispatched by React under happy-dom starved the event loop and
 * grew memory past GBs): 1) render the form, fill it, build the FormData the
 * browser would post (`new FormData(form)`), call the REAL action directly;
 * 2) re-render the form with an action that returns that exact state, submit,
 * and return the settled form markup.
 */
async function postThroughForm(
  kind: "signin" | "signup",
  real: AuthFn,
  values: Record<string, string>,
): Promise<{ state: AuthState; html: string; posted: string[] }> {
  const Form = kind === "signin" ? SignInForm : SignUpForm;
  const formId = `${kind}-form`;
  const fill = () => {
    for (const [field, value] of Object.entries(values)) {
      const id = field === "displayName" ? "signup-display-name" : `${kind}-${field}`;
      fireEvent.change(document.getElementById(id) as HTMLInputElement, { target: { value } });
    }
  };
  const first = render(<Form action={replay(null)} />);
  fill();
  const fd = new FormData(document.getElementById(formId) as HTMLFormElement);
  const posted: string[] = [];
  fd.forEach((_v, k) => posted.push(k));
  first.unmount();
  const result = await act(real(null, fd));
  if (result !== null && "redirect" in result) throw new Error(`unexpected redirect ${result.redirect}`);
  const state = result as AuthState;

  const view = render(<Form action={replay(state)} />);
  fill();
  fireEvent.submit(document.getElementById(formId) as HTMLFormElement);
  const summary = await screen.findByTestId(`${kind}-error-summary`, undefined, { timeout: 2_000 });
  await waitFor(() => expectFocused(summary), { timeout: 2_000 });
  expect((document.getElementById(`${kind}-password`) as HTMLInputElement).value).toBe("");
  const out = (document.getElementById(formId) as HTMLFormElement).outerHTML;
  view.unmount();
  return { state, html: out, posted };
}

async function signInViaForm(email: string, password: string): Promise<string> {
  const { html: out, posted } = await postThroughForm("signin", authActions.signIn, { email, password });
  expect(posted.sort()).toEqual(["email", "password"]);
  expect(store.setsOf(AUTH)).toEqual([]);
  expect(parse(out).querySelector<HTMLInputElement>("#signin-email")?.value ?? parse(out).querySelector("#signin-email")?.getAttribute("value")).toBe(email);
  return out;
}

describe("criterion 3: R-10 uniform responses through the real form", () => {
  test("sign-up with an existing email (AR2: sign-up may reveal it) through the form: summary + sign-in link, password cleared, rate-limited at the 6th", async () => {
    resetApp();
    const user = await makeUser("qa-uniform@example.test", "Uniform Person");
    const guest = uuid();
    secrets.add("An0ther-Str0ng-pw");
    const values = { displayName: "Someone", email: user.email, password: "An0ther-Str0ng-pw" };
    browser({ [GUEST_COOKIE]: guest });
    const first = await postThroughForm("signup", authActions.signUp, values);
    expect(first.posted.sort()).toEqual(["displayName", "email", "password"]);
    const doc = parse(first.html);
    expect(doc.querySelector('[data-testid="signup-error-summary"]')?.textContent).toContain(AUTH_FORM_MESSAGES.emailTaken);
    expect(doc.querySelector('[data-testid="signup-error-summary"] a[href="/signin"]')).not.toBeNull();
    expect(first.html).not.toContain("An0ther-Str0ng-pw");
    // attempts 2..5 directly (same browser), the 6th through the form again
    for (let i = 2; i <= 5; i++) {
      browser({ [GUEST_COOKIE]: guest });
      await act(authActions.signUp(null, form(values)));
    }
    browser({ [GUEST_COOKIE]: guest });
    const sixth = await postThroughForm("signup", authActions.signUp, values);
    expect(parse(sixth.html).querySelector('[data-testid="signup-error-summary"]')?.textContent).toMatch(/Too many attempts\. Try again in \d+ minutes?\./);
    expect(store.setsOf(AUTH)).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Criterion 4: hostile display name and email on the pages
// ---------------------------------------------------------------------------

describe("criterion 4: hostile display name / email", () => {
  test("sign-up echo through the real action: hostile name escaped; 1 MB name/email come back capped (50 / 254) and never outside value", async () => {
    resetApp();
    for (const name of [HOSTILE_NAME, RTL_50, BIDI_NAME, "N".repeat(1024 * 1024)]) {
      browser({ [GUEST_COOKIE]: uuid() });
      // Direct call with the posted shape (1 MB through happy-dom inputs is avoided on purpose).
      const fd = form({ displayName: name, email: `${"e".repeat(1024 * 1024)}@x`, password: PASSWORD });
      const state = (await act(authActions.signUp(null, fd))) as Exclude<AuthState, null>;
      expect(state.ok).toBe(false);
      expect((state.values.displayName ?? "").length).toBeLessThanOrEqual(50);
      expect((state.values.email ?? "").length).toBeLessThanOrEqual(254);
      expect(JSON.stringify(state)).not.toContain(PASSWORD);
      const view = render(<SignUpForm action={replay(state)} />);
      fireEvent.submit(document.getElementById("signup-form") as HTMLFormElement);
      await screen.findByTestId("signup-error-summary", undefined, { timeout: 2_000 });
      const nameInput = document.getElementById("signup-display-name") as HTMLInputElement;
      expect(nameInput.value).toBe(state.values.displayName ?? "");
      expect(tagOf(view.container.querySelector("img"))).toBeNull();
      expect(tagOf(view.container.querySelector("[onerror]"))).toBeNull();
      for (const el of Array.from(view.container.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name === "value") continue;
          expect(attr.value.includes("onerror")).toBe(false);
        }
      }
      expect(store.setsOf(AUTH)).toEqual([]);
      view.unmount();
    }
  }, 30_000);

  test("/account/settings: hostile stored names render as text inside value only; email exactly once, as text", async () => {
    resetApp();
    const users = [
      await makeUser("qa-victor@example.test", HOSTILE_NAME),
      await makeUser("qa-whiskey@example.test", RTL_50),
      await makeUser("qa-xray@example.test", BIDI_NAME),
    ];
    for (const user of users) {
      browser({ [AUTH]: user.token });
      const markup = await html(SettingsPage);
      const doc = parse(markup);
      expect(tagOf(doc.querySelector("main img, form img, img[onerror]"))).toBeNull();
      expect(tagOf(doc.querySelector("[onerror]"))).toBeNull();
      expect(doc.querySelector('input[name="displayName"]')?.getAttribute("value")).toBe(user.displayName);
      for (const el of Array.from(doc.querySelectorAll("*"))) {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name === "value") continue;
          expect([attr.name, attr.value.includes(user.displayName)]).toEqual([attr.name, false]);
          expect([attr.name, attr.value.includes(user.email)]).toEqual([attr.name, false]);
        }
      }
      expect(markup.split(user.email)).toHaveLength(2);
      expectNoCookieWrites();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Criterion 5: secrets never in markup/metadata/console; two-user isolation
// ---------------------------------------------------------------------------

describe("criterion 5: secrets and cross-user data", () => {
  test("two users on /account/settings: each sees only their own email (once) and name; no UUID, token, hash or owner key in markup", async () => {
    resetApp();
    const a = await makeUser("qa-yankee@example.test", "Yankee Person");
    const b = await makeUser("qa-zulu@example.test", "Zulu Person");
    const guest = uuid();
    harvest();
    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      browser({ [AUTH]: me.token, [GUEST_COOKIE]: guest });
      const markup = await html(SettingsPage, { sessions: "error" });
      expect(markup.split(me.email)).toHaveLength(2);
      expect(markup).toContain(me.displayName);
      expect(markup).not.toContain(other.email);
      expect(markup).not.toContain(other.displayName);
      expect(markup).not.toMatch(UUID_RE);
      expect(secrets.find(markup, true)).toEqual([]);
      for (const v of [me.id, me.ownerKey, me.token, me.authSessionId, guest, other.token]) expect(markup).not.toContain(v);
      expectNoCookieWrites();
    }
  }, 30_000);

  test("signed-in user's guest-page renders are impossible (redirect) and guest renders of /signin, /signup carry no cookie value", async () => {
    resetApp();
    const revoked = await makeUser("qa-quebec@example.test", "Quebec Person", { revoked: true });
    const guest = uuid();
    for (const page of [SignInPage, SignUpPage]) {
      browser({ [AUTH]: revoked.token, [GUEST_COOKIE]: guest });
      const markup = await html(page, { next: "/orders" });
      expect(markup).not.toContain(revoked.token);
      expect(markup).not.toContain(guest);
      expect(markup).not.toContain(revoked.email);
      expect(markup).not.toMatch(UUID_RE);
      expectNoCookieWrites();
    }
  }, 30_000);

  test("static metadata of the three pages carries no user data, is noindex, and has the right titles", () => {
    const meta = [signinPage.metadata, signupPage.metadata, settingsPage.metadata];
    for (const m of meta) {
      const json = JSON.stringify(m);
      expect(json).not.toMatch(UUID_RE);
      expect(secrets.find(json, true)).toEqual([]);
      expect(m.robots).toMatchObject({ index: false });
    }
    expect(signinPage.metadata.title).toBe("Sign in");
    expect(signupPage.metadata.title).toBe("Create account");
  });
});

// ---------------------------------------------------------------------------
// Criterion 6: guest / garbage cookies, noindex, sitemap, hrefs
// ---------------------------------------------------------------------------

describe("criterion 6: cookie states", () => {
  test("/account/settings redirects to the sign-in page for 8+ guest/garbage cookie states, writing no cookie", async () => {
    resetApp();
    const live = await makeUser("qa-golf@example.test", "Golf Person");
    const revoked = await makeUser("qa-hotel@example.test", "Hotel Person", { revoked: true });
    const expired = await makeUser("qa-india@example.test", "India Person", { expired: true });
    const deleted = await makeUser("qa-juliet@example.test", "Juliet Person");
    getDatabase().query("DELETE FROM users WHERE id = ?").run(deleted.id);
    const states: [string, Record<string, string>][] = [
      ["no cookies", {}],
      ["guest sf_session only", { [GUEST_COOKIE]: uuid() }],
      ["garbage sf_auth with markup", { [AUTH]: "garbage<script>x", [GUEST_COOKIE]: uuid() }],
      ["well-formed unknown token", { [AUTH]: newToken() }],
      ["revoked session", { [AUTH]: revoked.token }],
      ["expired session", { [AUTH]: expired.token }],
      ["deleted user", { [AUTH]: deleted.token }],
      ["R-1: guest cookie equal to an owner key", { [GUEST_COOKIE]: live.ownerKey }],
      ["token HASH presented as the token", { [AUTH]: sha256hex(live.token) }],
      ["4 KiB sf_auth", { [AUTH]: "A".repeat(4096) }],
      ["empty sf_auth", { [AUTH]: "" }],
      ["owner key presented as sf_auth", { [AUTH]: live.ownerKey }],
    ];
    for (const [name, cookies] of states) {
      browser(cookies);
      expect([name, await redirectOf(() => SettingsPage({ searchParams: Promise.resolve({}) }))]).toEqual([name, SETTINGS_REDIRECT]);
      expect([name, store.setCalls, store.deleteCalls]).toEqual([name, [], []]);
    }
  }, 30_000);

  test("/signin and /signup render the form for the same guest/garbage states (no throw, no alert, no writes) and redirect a valid session", async () => {
    resetApp();
    const live = await makeUser("qa-echo@example.test", "Echo Person");
    const revoked = await makeUser("qa-foxtrot@example.test", "Foxtrot Person", { revoked: true });
    const states: Record<string, string>[] = [
      {},
      { [GUEST_COOKIE]: uuid() },
      { [AUTH]: "garbage<script>x" },
      { [AUTH]: newToken() },
      { [AUTH]: revoked.token },
      { [GUEST_COOKIE]: live.ownerKey },
      { [AUTH]: sha256hex(live.token) },
      { [AUTH]: "A".repeat(4096) },
    ];
    for (const page of [SignInPage, SignUpPage]) {
      for (const cookies of states) {
        browser(cookies);
        const doc = parse(await html(page));
        expect(doc.querySelectorAll("form")).toHaveLength(1);
        expect(tagOf(doc.querySelector('[role="alert"]'))).toBeNull();
        expectNoCookieWrites();
      }
      browser({ [AUTH]: live.token });
      expect(await redirectOf(() => page({ searchParams: Promise.resolve({}) }))).toBe("/account");
      expectNoCookieWrites();
    }
  }, 30_000);

  test("noindex + absent from the sitemap; robots policy keeps /signin, /signup crawlable (noindex must be seen)", () => {
    const urls = buildSiteSitemap({ products: [], categories: [], brands: [], helpTopics: [] }).map((e) => new URL(e.url).pathname);
    for (const path of ["/signin", "/signup", "/account/settings"]) {
      expect(urls.some((u) => u === path || u.startsWith(`${path}/`) || u.startsWith(`${path}?`))).toBe(false);
      expect(policyFor(path)?.sitemap).toBe(false);
      expect(policyFor(path)?.indexing).not.toBe("indexable");
    }
    expect(policyFor("/signin")?.robotsDisallowed).toBe(false);
    expect(policyFor("/signup")?.robotsDisallowed).toBe(false);
  });

  test("every href on the three pages passes isAllowedInternalHref (fragments resolve to an element)", async () => {
    resetApp();
    const user = await makeUser("qa-delta@example.test", "Delta Person");
    browser();
    for (const page of [SignInPage, SignUpPage]) expectHrefsAllowed(parse(await html(page, { next: "/orders?page=2" })));
    browser({ [AUTH]: user.token });
    expectHrefsAllowed(parse(await html(SettingsPage, { sessions: "error" })));
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Criterion 7 (pages): headings, ids, 320px
// ---------------------------------------------------------------------------

describe("criterion 7: page structure", () => {
  test("one h1 and no skipped heading levels; ids unique; IDREFs resolve; no 320px-breaking classes", async () => {
    resetApp();
    const user = await makeUser("qa-charlie@example.test", "Charlie Person");
    const docs: [string, Document][] = [];
    browser();
    docs.push(["/signin", parse(await html(SignInPage, { next: "/orders" }))]);
    docs.push(["/signup", parse(await html(SignUpPage, { next: "/orders" }))]);
    browser({ [AUTH]: user.token });
    docs.push(["/account/settings", parse(await html(SettingsPage, { sessions: "error" }))]);
    for (const [name, doc] of docs) {
      expectHeadingOutline(doc);
      expect([name, duplicateIds(doc)]).toEqual([name, []]);
      expect([name, danglingRefs(doc)]).toEqual([name, []]);
      expect([name, narrowViewportOffenders(doc)]).toEqual([name, []]);
    }
    const settings = docs[2]?.[1] as Document;
    expect(headingLevels(settings)).toEqual([1, 2, 2, 2, 2]);
    expect(settings.querySelector("h1")?.textContent).toBe("Login & security");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Criterion 3 (clocked): these freeze Date with setSystemTime, which disturbs
// happy-dom/React scheduling for later renders in the same file, so they run
// after every other render test.
// ---------------------------------------------------------------------------

describe("criterion 3: R-10 uniform responses through the real form (frozen clock)", () => {
  test("known vs unknown email: attempts 1, 10 (lock) and 11 (limit) render byte-identical markup at a non-aligned clock; lock == limit", async () => {
    const EMAIL = "qa-romeo@example.test";
    const runOne = async (known: boolean): Promise<Record<number, string>> => {
      resetApp();
      setSystemTime(new Date(T0 + 7 * MIN + 13_000));
      if (known) await makeUser(EMAIL, "Romeo Person");
      const out: Record<number, string> = {};
      for (let i = 1; i <= 11; i++) {
        browser({ [GUEST_COOKIE]: uuid() });
        if (i === 1 || i === 10 || i === 11) out[i] = await signInViaForm(EMAIL, WRONG_PW);
        else await act(authActions.signIn(null, form({ email: EMAIL, password: WRONG_PW })));
      }
      if (known) {
        browser({ [GUEST_COOKIE]: uuid() });
        out[12] = await signInViaForm(EMAIL, PASSWORD); // correct password while locked
      }
      return out;
    };
    const known = await runOne(true);
    const unknown = await runOne(false);
    for (const i of [1, 10, 11]) expect([i, known[i]]).toEqual([i, unknown[i]]);
    expect(known[1]).toContain(AUTH_FORM_MESSAGES.invalidCredentials);
    expect(known[10]).toMatch(/Too many attempts\. Try again in \d+ minutes?\./);
    expect(known[10]).toBe(known[11]);
    expect(known[12]).toBe(known[11]);
    for (const m of Object.values(known)) {
      expect(m).not.toContain(WRONG_PW);
      expect(m).not.toContain(PASSWORD);
      expect(m.toLowerCase()).not.toContain("locked");
    }
  }, 60_000);

  test("per-browser limit (10 different emails) renders the same too-many summary text family as the per-email lock", async () => {
    resetApp();
    setSystemTime(new Date(T0));
    const user = await makeUser("qa-sierra@example.test", "Sierra Person");
    browser({ [GUEST_COOKIE]: uuid() });
    const guest = store.jar.get(GUEST_COOKIE) ?? "";
    for (let i = 0; i < 10; i++) {
      browser({ [GUEST_COOKIE]: guest });
      await act(authActions.signIn(null, form({ email: `qa-tango${"x".repeat(i)}@example.test`, password: WRONG_PW })));
    }
    browser({ [GUEST_COOKIE]: guest });
    const limited = await signInViaForm(user.email, PASSWORD);
    expect(limited).toContain("Too many attempts. Try again in 15 minutes.");
    expect(limited).not.toContain(AUTH_FORM_MESSAGES.invalidCredentials);
  }, 30_000);

});

// ---------------------------------------------------------------------------
// Criterion 5 (last): console across every render and action in this file
// ---------------------------------------------------------------------------

describe("criterion 5: console output (runs last)", () => {
  test("no password, hash, token, token hash, owner key, user/session id or seeded guest UUID in console; no UUID in any rendered page", () => {
    harvest();
    const joined = capture.lines.join("\n");
    expect(secrets.find(joined, true)).toEqual([]);
    for (const id of seededIds) expect(joined.includes(id)).toBe(false);
    for (const markup of htmlLog) {
      expect(markup).not.toMatch(UUID_RE);
      expect(secrets.find(markup, true)).toEqual([]);
    }
    expect(htmlLog.length).toBeGreaterThan(30);
  });
});


