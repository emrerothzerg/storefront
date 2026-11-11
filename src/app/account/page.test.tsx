import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// next/* mocks: registered before the page is imported; delegate to per-test state.
class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: string[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string): void {
    this.setCalls.push(name);
  }
  delete(name: string): void {
    this.setCalls.push(`delete:${name}`);
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
  notFound: (): never => {
    throw new Error("unexpected notFound");
  },
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const dbClient = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const { isAllowedInternalHref } = await import("@/content/routes");
const { GUEST_NOTICE_TEXT } = await import("@/components/organisms/AccountHub");
const fx = await import("./_lib/test-fixtures");
const { default: Page, generateMetadata } = await import("./page");

const getDatabaseSpy = spyOn(dbClient, "getDatabase");
const getOrCreateSpy = spyOn(session, "getOrCreateSessionId");

let a: import("./_lib/test-fixtures").SeededOwner;
let b: import("./_lib/test-fixtures").SeededOwner;
let user: import("./_lib/test-fixtures").SignedInFixture;

function setCookies(cookies: { guest?: string; auth?: string } = {}): void {
  fakeStore = new FakeCookieStore();
  if (cookies.guest !== undefined) fakeStore.jar.set(session.SESSION_COOKIE_NAME, cookies.guest);
  if (cookies.auth !== undefined) fakeStore.jar.set(session.AUTH_COOKIE_NAME, cookies.auth);
}

async function renderPage() {
  return render(await Page());
}

function forbidden(): string[] {
  return [fx.OWNER_A, fx.OWNER_B, user.ownerKey, user.token, a.email, b.email, a.fullName, b.fullName];
}

beforeAll(() => {
  dbClient.closeDatabase();
  const db = dbClient.getDatabase();
  seedDatabase(db);
  a = fx.seedOwner(db, fx.OWNER_A, fx.SPEC_A);
  b = fx.seedOwner(db, fx.OWNER_B, fx.SPEC_B);
  user = fx.createSignedInUser(db, "Grace Hopper");
});

afterEach(() => {
  setCookies();
  getDatabaseSpy.mockClear();
  getOrCreateSpy.mockClear();
});

afterAll(() => {
  getDatabaseSpy.mockRestore();
  getOrCreateSpy.mockRestore();
  dbClient.closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/account hub", () => {
  test("metadata: Your Account, noindex", async () => {
    const m = await generateMetadata();
    expect(m.title).toBe("Your Account");
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  test("no cookie: guest hub (200), one h1, breadcrumb, no DB read, no session minted", async () => {
    getDatabaseSpy.mockClear();
    const { container } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your Account");
    expect(screen.getByText(GUEST_NOTICE_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/signup");
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(crumb).getByText("Your Account")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(getDatabaseSpy).not.toHaveBeenCalled();
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(fakeStore.setCalls).toEqual([]);
    expect(fx.markupViolations(container, { forbidden: forbidden() }, isAllowedInternalHref)).toEqual([]);
  });

  test("garbage cookies: guest hub, never 404, no cookie write", async () => {
    setCookies({ guest: "not-a-session", auth: "garbage" });
    await renderPage();
    expect(screen.getByText(GUEST_NOTICE_TEXT)).toBeInTheDocument();
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("guest owner A: A's counts and back-in-stock acknowledge form, nothing of B's", async () => {
    setCookies({ guest: fx.OWNER_A });
    const { container } = await renderPage();
    expect(screen.getByText(GUEST_NOTICE_TEXT)).toBeInTheDocument();
    expect(screen.getByText("2 alerts")).toBeInTheDocument();
    expect(screen.getByText("1 saved address")).toBeInTheDocument();
    expect(screen.getByText("1 review, 1 question")).toBeInTheDocument();
    expect(screen.getByText("1 message")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Walnut Standing Desk" })).toHaveAttribute("href", "/products/walnut-desk");
    const alertInputs = [...container.querySelectorAll<HTMLInputElement>('input[name="alertId"]')].map((i) => i.value);
    expect(alertInputs).toEqual([a.restockedAlertId]);
    expect(container.innerHTML).not.toContain(b.restockedAlertId);
    expect(screen.queryByText(/Amber & Oud Reed Diffuser/)).toBeNull();
    expect(fakeStore.setCalls).toEqual([]);
    expect(
      fx.markupViolations(container, { forbidden: forbidden(), allowedIds: [a.restockedAlertId] }, isAllowedInternalHref),
    ).toEqual([]);
  });

  test("guest owner B sees only B's back-in-stock item", async () => {
    setCookies({ guest: fx.OWNER_B });
    const { container } = await renderPage();
    expect(screen.getByRole("link", { name: "Amber & Oud Reed Diffuser" })).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(a.restockedAlertId);
  });

  test("signed in: greeting + email as text, sign-out form, owner-key data, no owner key in markup", async () => {
    setCookies({ auth: user.token });
    const { container } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Hello, Grace Hopper")).toBeInTheDocument();
    expect(screen.getByText(user.email)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByText(GUEST_NOTICE_TEXT)).toBeNull();
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(fakeStore.setCalls).toEqual([]);
    expect(
      fx.markupViolations(
        container,
        { forbidden: [fx.OWNER_A, fx.OWNER_B, user.ownerKey, user.token, a.email] },
        isAllowedInternalHref,
      ),
    ).toEqual([]);
  });
});
