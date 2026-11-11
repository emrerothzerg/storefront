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

describe("/account/messages", () => {
  test("metadata: noindex", async () => {
    const m = await generateMetadata();
    expect(m.title).toBe("Messages");
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  test("no cookie: empty state, one h1, breadcrumb, no DB read, no session", async () => {
    getDatabaseSpy.mockClear();
    const { container } = await renderPage();
    expectChrome("Messages", "Your messages");
    expect(screen.getByText("You haven't sent us any messages.")).toBeInTheDocument();
    expect(getDatabaseSpy).not.toHaveBeenCalled();
    expectNoWrites();
    expect(fx.markupViolations(container, { forbidden: forbidden() }, isAllowedInternalHref)).toEqual([]);
  });

  test("owner A: reference, topic, date, status and own excerpt as text; no name/email; nothing of B's", async () => {
    setCookies({ guest: fx.OWNER_A });
    const { container } = await renderPage();
    expectChrome("Messages", "Your messages");
    const list = screen.getByRole("list", { name: "Sent messages" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText(a.reference)).toBeInTheDocument();
    expect(within(list).getByText("Shipping and delivery")).toBeInTheDocument();
    expect(within(list).getByText("Received")).toBeInTheDocument();
    expect(container.textContent).toContain(`Alpha message ${fx.HOSTILE}`);
    expect(container.textContent).not.toContain(b.reference);
    expectNoWrites();
    expect(fx.markupViolations(container, { forbidden: forbidden() }, isAllowedInternalHref)).toEqual([]);
  });

  test("owner B sees only B's message", async () => {
    setCookies({ guest: fx.OWNER_B });
    const { container } = await renderPage();
    expect(container.textContent).toContain(b.reference);
    expect(container.textContent).not.toContain(a.reference);
  });

  test("signed in: the user's messages only", async () => {
    setCookies({ auth: user.token });
    const { container } = await renderPage();
    expect(container.textContent).toContain(userData.reference);
    expect(container.textContent).not.toContain(a.reference);
    expectNoWrites();
  });

  describe("guest sign-in invitation (D-T98-1)", () => {
    const next = encodeURIComponent("/account/messages");

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
      const empty = within(container).getByText("You haven't sent us any messages.", { exact: false });
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
