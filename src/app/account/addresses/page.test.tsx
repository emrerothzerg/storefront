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
const fx = await import("../_lib/test-fixtures");
const { default: Page, generateMetadata } = await import("./page");
const { GUEST_NOTICE_TEXT } = await import("@/components/organisms/AccountHub");
const { GUEST_STATE_LABEL } = await import("../_lib/guest-state");


const HOSTILE_NAME = `Tote ${fx.HOSTILE}`;
let userData: import("../_lib/test-fixtures").SeededOwner;

const getDatabaseSpy = spyOn(dbClient, "getDatabase");
const getOrCreateSpy = spyOn(session, "getOrCreateSessionId");

let a: import("../_lib/test-fixtures").SeededOwner;
let b: import("../_lib/test-fixtures").SeededOwner;
let user: import("../_lib/test-fixtures").SignedInFixture;

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
  userData = fx.seedOwner(db, user.ownerKey, {
    tag: "Grace",
    productId: "prod_lambswool-crew-jumper",
    waitingProductId: "prod_thinking-in-systems-field-guide",
    restockedProductId: "prod_canvas-tote-bag",
  });
  db.run("UPDATE products SET stock = 42 WHERE id = ?", ["prod_canvas-tote-bag"]);
  db.run("UPDATE products SET name = ? WHERE id = ?", [HOSTILE_NAME, fx.SPEC_A.productId]);
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


function expectChrome(crumbLabel: string, h1: string | RegExp): void {
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(h1);
  const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(within(crumb).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
  expect(within(crumb).getByRole("link", { name: "Your Account" })).toHaveAttribute("href", "/account");
  expect(within(crumb).getByText(crumbLabel)).toBeInTheDocument();
}

function expectNoWrites(): void {
  expect(getOrCreateSpy).not.toHaveBeenCalled();
  expect(fakeStore.setCalls).toEqual([]);
}

describe("/account/addresses", () => {
  test("metadata: noindex", async () => {
    const m = await generateMetadata();
    expect(m.title).toBe("Your Addresses");
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  test("no cookie: empty address book (200), one h1, breadcrumb, no DB read, no session", async () => {
    getDatabaseSpy.mockClear();
    const { container } = await renderPage();
    expectChrome("Your Addresses", "Your addresses");
    expect(screen.getByText("You haven't saved any addresses yet.")).toBeInTheDocument();
    expect(getDatabaseSpy).not.toHaveBeenCalled();
    expectNoWrites();
    expect(fx.markupViolations(container, { forbidden: forbidden() }, isAllowedInternalHref)).toEqual([]);
  });

  test("garbage / unknown cookie: empty state, never 404", async () => {
    setCookies({ guest: "garbage" });
    await renderPage();
    expect(screen.getByText("You haven't saved any addresses yet.")).toBeInTheDocument();
    setCookies({ guest: fx.UNKNOWN_OWNER });
    await renderPage();
    expect(screen.getAllByText("You haven't saved any addresses yet.").length).toBeGreaterThan(0);
    expectNoWrites();
  });

  test("owner A sees only A's address; B only B's (criterion 2)", async () => {
    setCookies({ guest: fx.OWNER_A });
    const first = await renderPage();
    expectChrome("Your Addresses", "Your addresses");
    expect(first.container.textContent).toContain(a.fullName);
    expect(first.container.textContent).not.toContain(b.fullName);
    expect(first.container.innerHTML).toContain(a.addressId);
    expect(first.container.innerHTML).not.toContain(b.addressId);
    expect(
      fx.markupViolations(first.container, { forbidden: [fx.OWNER_A, fx.OWNER_B, b.fullName], allowedIds: [a.addressId] }, isAllowedInternalHref),
    ).toEqual([]);
    first.unmount();
    setCookies({ guest: fx.OWNER_B });
    const second = await renderPage();
    expect(second.container.textContent).toContain(b.fullName);
    expect(second.container.textContent).not.toContain(a.fullName);
    expectNoWrites();
  });

  test("signed in: reads through the user's owner key", async () => {
    setCookies({ auth: user.token });
    const { container } = await renderPage();
    expect(container.textContent).toContain(userData.fullName);
    expect(container.textContent).not.toContain(a.fullName);
    expect(container.innerHTML).not.toContain(user.ownerKey);
    expectNoWrites();
  });

  describe("guest sign-in invitation (D-T98-1)", () => {
    const next = encodeURIComponent("/account/addresses");

    function invitation(container: HTMLElement): HTMLElement {
      const group = within(container).getByRole("group", { name: GUEST_STATE_LABEL });
      expect(group).toHaveTextContent(GUEST_NOTICE_TEXT);
      expect(within(group).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", `/signin?next=${next}`);
      expect(within(group).getByRole("link", { name: "Create account" })).toHaveAttribute("href", `/signup?next=${next}`);
      return group;
    }

    test("no cookie: invitation above the still-rendered empty state; one h1, no DB read, no cookie writes", async () => {
      getDatabaseSpy.mockClear();
      const { container } = await renderPage();
      const group = invitation(container);
      const empty = within(container).getByText("You haven't saved any addresses yet.", { exact: false });
      expect(group.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(within(container).getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(within(group).queryByRole("heading")).toBeNull();
      expect(getDatabaseSpy).not.toHaveBeenCalled();
      expectNoWrites();
    });

    test("garbage cookie and a guest cookie with data: invitation shown, no cookie writes", async () => {
      for (const guest of ["garbage", fx.OWNER_A]) {
        setCookies({ guest });
        const { container, unmount } = await renderPage();
        invitation(container);
        expectNoWrites();
        unmount();
      }
    });

    test("signed in: no invitation and no device-bound notice", async () => {
      setCookies({ auth: user.token });
      const { container } = await renderPage();
      expect(within(container).queryByRole("group", { name: GUEST_STATE_LABEL })).toBeNull();
      expect(container.textContent).not.toContain(GUEST_NOTICE_TEXT);
      expectNoWrites();
    });
  });
});
