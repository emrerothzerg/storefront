import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// next/* mocks. mock.module is process-wide in bun test, so they are
// registered before `./page` is imported and delegate to per-test state. The
// cookie jar's `set`/`delete` are spies (SR10: render never writes cookies).
// next/navigation keeps the real exports (unstable_rethrow) and swaps
// `redirect` for a sentinel throw.
// ---------------------------------------------------------------------------

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly set = mock((name: string, value?: string) => void [name, value]);
  readonly delete = mock((name: string) => void name);
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  has(name: string): boolean {
    return this.jar.has(name);
  }
}

let fakeStore = new FakeCookieStore();
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
mock.module("next/navigation", () => ({
  ...realNavigation,
  redirect: (url: string): never => {
    throw new RedirectSentinel(url);
  },
  notFound: (): never => {
    throw new Error("unexpected notFound");
  },
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { createAuthRepository } = await import("@/server/auth/auth-repository");
const session = await import("@/server/session/session");
const { isAllowedInternalHref } = await import("@/content/routes");
const { buildSitemapEntries } = await import("@/lib/seo/sitemap");
const { default: robots } = await import("@/app/robots");
const { PASSWORD_RESET_NOTICE } = await import("@/components/molecules/SignInForm");
const { default: Page, metadata } = await import("./page");

const DAY_MS = 24 * 60 * 60 * 1000;
const GUEST = "6a1f0c2e-3b4d-4c5e-9f60-718293a4b5c6";

const readSessionIdSpy = spyOn(session, "readSessionId");
const getOrCreateSpy = spyOn(session, "getOrCreateSessionId");
const readGuestSpy = spyOn(session, "readGuestSessionId");
const rotateSpy = spyOn(session, "rotateGuestSession");

function sha256hex(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function newToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

let counter = 0;
function signedInFixture(options: { revoked?: boolean; expired?: boolean } = {}): { token: string; email: string } {
  const repo = createAuthRepository(getDatabase());
  counter += 1;
  const email = `signin-page-${counter}-${crypto.randomUUID()}@example.test`;
  const user = repo.createUser({ email, passwordHash: "$argon2id$v=19$fixture-hash", displayName: `Page ${counter}` });
  if (!user.ok) throw new Error(`createUser failed: ${user.error.code}`);
  const token = newToken();
  const issuedAt = options.expired ? Date.now() - 40 * DAY_MS : Date.now();
  const s = repo.createAuthSession(
    { userId: user.value.id, tokenHash: sha256hex(token), expiresAt: new Date(issuedAt + 30 * DAY_MS).toISOString() },
    issuedAt,
  );
  if (!s.ok) throw new Error(`createAuthSession failed: ${s.error.code}`);
  if (options.revoked) repo.revokeAuthSession(s.value.id);
  return { token, email };
}

function setCookies(auth: string | null, guest: string | null = null): void {
  fakeStore = new FakeCookieStore();
  if (auth !== null) fakeStore.jar.set(session.AUTH_COOKIE_NAME, auth);
  if (guest !== null) fakeStore.jar.set(session.SESSION_COOKIE_NAME, guest);
}

async function renderPage(search: Record<string, string | string[] | undefined> = {}) {
  return render(await Page({ searchParams: Promise.resolve(search) }));
}

async function redirectOf(search: Record<string, string | string[] | undefined> = {}): Promise<string> {
  try {
    await Page({ searchParams: Promise.resolve(search) });
  } catch (e) {
    // Duck-typed: another test file's next/navigation mock may be the live one.
    if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT") && "url" in e && typeof e.url === "string") return e.url;
    throw e;
  }
  throw new Error("expected a redirect");
}

function expectNoCookieWrites(): void {
  expect(fakeStore.set).not.toHaveBeenCalled();
  expect(fakeStore.delete).not.toHaveBeenCalled();
}

function expectNoSessionResolution(): void {
  expect(readSessionIdSpy).not.toHaveBeenCalled();
  expect(getOrCreateSpy).not.toHaveBeenCalled();
  expect(readGuestSpy).not.toHaveBeenCalled();
  expect(rotateSpy).not.toHaveBeenCalled();
}

function hiddenNext(container: HTMLElement): string | null {
  return container.querySelector<HTMLInputElement>('input[type="hidden"][name="next"]')?.value ?? null;
}

function signUpLink(): HTMLElement {
  return screen.getByRole("link", { name: /create account/i });
}

beforeAll(() => {
  closeDatabase();
  getDatabase();
});

beforeEach(() => {
  setCookies(null);
  for (const spy of [readSessionIdSpy, getOrCreateSpy, readGuestSpy, rotateSpy]) spy.mockClear();
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  for (const spy of [readSessionIdSpy, getOrCreateSpy, readGuestSpy, rotateSpy]) spy.mockRestore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/signin metadata (criteria 1, 6)", () => {
  test("title via buildMetadata, noindex + nofollow", () => {
    expect(metadata.title).toBe("Sign in");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(typeof metadata.description).toBe("string");
  });

  test("absent from the sitemap and not disallowed in robots.txt (crawlers must see the noindex)", () => {
    const urls = buildSitemapEntries([{ slug: "walnut-desk" }]).map((e) => new URL(e.url).pathname);
    expect(urls).not.toContain("/signin");
    expect(urls.some((u) => u.startsWith("/signin"))).toBe(false);
    const disallow = robots().rules;
    const list = Array.isArray(disallow) ? disallow.flatMap((r) => r.disallow ?? []) : [disallow.disallow ?? []].flat();
    expect(list).not.toContain("/signin");
  });
});

describe("/signin guest render (criteria 1, 5)", () => {
  test("one h1, breadcrumb Home > Sign in, the form, reset notice + contact link, safe hrefs", async () => {
    const { container } = await renderPage();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Sign in");

    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(crumbs).getByText("Sign in")).toHaveAttribute("aria-current", "page");

    const form = screen.getByRole("form", { name: "Sign in" });
    expect(form.querySelector('input[name="email"]')).not.toBeNull();
    expect(form.querySelector('input[name="password"]')).not.toBeNull();
    expect(hiddenNext(container)).toBeNull();

    expect(container.textContent).toContain(PASSWORD_RESET_NOTICE);
    expect(screen.getByRole("link", { name: /contact customer service/i })).toHaveAttribute("href", "/contact");
    expect(signUpLink()).toHaveAttribute("href", "/signup");

    const anchors = Array.from(container.querySelectorAll("a[href]"));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) continue;
      expect(isAllowedInternalHref(href)).toBe(true);
    }
    expectNoCookieWrites();
    expectNoSessionResolution();
  });

  test("a guest sf_session cookie alone is not touched or resolved", async () => {
    setCookies(null, GUEST);
    await renderPage();
    expect(screen.getByRole("form", { name: "Sign in" })).toBeInTheDocument();
    expectNoCookieWrites();
    expectNoSessionResolution();
  });
});

describe("/signin next handling (criterion 3)", () => {
  test("next=/orders is kept in the hidden field and the sign-up cross-link", async () => {
    const { container } = await renderPage({ next: "/orders" });
    expect(hiddenNext(container)).toBe("/orders");
    expect(signUpLink()).toHaveAttribute("href", "/signup?next=%2Forders");
  });

  test.each([
    ["//evil.com"],
    ["https://evil.com"],
    ["javascript:alert(1)"],
    ["/\\evil"],
    ["%2F%2Fevil"],
    ["/%2F%2Fevil.com"],
    ["/signup"],
  ])("next=%p is dropped everywhere", async (raw) => {
    const { container } = await renderPage({ next: raw });
    expect(hiddenNext(container)).toBeNull();
    expect(signUpLink()).toHaveAttribute("href", "/signup");
    expect(container.innerHTML).not.toContain("evil");
    for (const el of Array.from(container.querySelectorAll("[href], input[name='next']"))) {
      expect(`${el.getAttribute("href") ?? ""}${el.getAttribute("value") ?? ""}`).not.toContain("javascript:");
    }
  });

  test("array next is ignored", async () => {
    const { container } = await renderPage({ next: ["/orders", "/cart"] });
    expect(hiddenNext(container)).toBeNull();
  });
});

describe("/signin signed-in visitor (criterion 2)", () => {
  test("redirects to the sanitised next, never renders", async () => {
    const { token } = signedInFixture();
    setCookies(token);
    expect(await redirectOf({ next: "/orders" })).toBe("/orders");
    expectNoCookieWrites();
  });

  test("redirects to /account without next or with an unsafe next", async () => {
    const { token } = signedInFixture();
    for (const search of [{}, { next: "//evil.com" }, { next: "https://evil.com" }, { next: ["/orders"] }]) {
      setCookies(token);
      expect(await redirectOf(search)).toBe("/account");
      expectNoCookieWrites();
    }
  });

  test.each([
    ["garbage", () => "garbage"],
    ["well-formed unknown token", () => newToken()],
    ["revoked session", () => signedInFixture({ revoked: true }).token],
    ["expired session", () => signedInFixture({ expired: true }).token],
  ])("%s sf_auth renders the form with no error and no cookie writes", async (_name, token) => {
    setCookies(token(), GUEST);
    const { container } = await renderPage({ next: "/orders" });
    expect(screen.getByRole("form", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(hiddenNext(container)).toBe("/orders");
    expectNoCookieWrites();
    expectNoSessionResolution();
  });

  test("no user data or token in the guest markup", async () => {
    const { token, email } = signedInFixture({ revoked: true });
    setCookies(token);
    const { container } = await renderPage();
    expect(container.innerHTML).not.toContain(token);
    expect(container.innerHTML).not.toContain(email);
  });
});

describe("/signin database access (criterion 4)", () => {
  test("only the auth lookup touches the database", async () => {
    const { token } = signedInFixture();
    const revoked = signedInFixture({ revoked: true }).token;
    const db = getDatabase();
    const sql: string[] = [];
    const originalQuery = db.query.bind(db);
    const querySpy = spyOn(db, "query").mockImplementation(((source: string) => {
      sql.push(source);
      return originalQuery(source);
    }) as typeof db.query);
    const prepareSpy = spyOn(db, "prepare");
    const runSpy = spyOn(db, "run");
    try {
      setCookies(revoked, GUEST);
      await renderPage({ next: "/orders" });
      setCookies(token, GUEST);
      expect(await redirectOf({ next: "/orders" })).toBe("/orders");
      setCookies(null, GUEST);
      cleanup();
      await renderPage();
    } finally {
      querySpy.mockRestore();
      prepareSpy.mockRestore();
      runSpy.mockRestore();
    }
    expect(sql.length).toBeGreaterThan(0);
    for (const statement of sql) expect(statement).toMatch(/\b(auth_sessions|users)\b/);
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    expectNoSessionResolution();
  });
});
