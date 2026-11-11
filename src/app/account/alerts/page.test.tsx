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

describe("/account/alerts", () => {
  test("metadata: noindex", async () => {
    const m = await generateMetadata();
    expect(m.title).toBe("Stock Alerts");
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  test("no cookie: empty state, one h1, breadcrumb, no DB read, no session", async () => {
    getDatabaseSpy.mockClear();
    const { container } = await renderPage();
    expectChrome("Stock Alerts", "Your stock alerts");
    expect(screen.getByText(/You're not watching any products/)).toBeInTheDocument();
    expect(container.querySelector("form")).toBeNull();
    expect(getDatabaseSpy).not.toHaveBeenCalled();
    expectNoWrites();
  });

  test("owner A: Watching + Back in stock with acknowledge form (criterion 4), stop-watching forms", async () => {
    setCookies({ guest: fx.OWNER_A });
    const { container } = await renderPage();
    expectChrome("Stock Alerts", "Your stock alerts");
    const list = screen.getByRole("list", { name: "Watched products" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Watching")).toBeInTheDocument();
    expect(within(list).getAllByText("Back in stock").length).toBeGreaterThan(0);
    const ack = screen.getByRole("button", { name: "Acknowledge back-in-stock alert for Walnut Standing Desk" });
    expect(ack.closest("form")?.querySelector('input[name="alertId"]')).toHaveAttribute("value", a.restockedAlertId);
    expect(ack.closest("form")?.querySelector('input[name="productSlug"]')).toHaveAttribute("value", "walnut-desk");
    expect(screen.getAllByRole("button", { name: /^Stop watching/ })).toHaveLength(2);
    expect(screen.getByRole("link", { name: "High-Density Foam Roller" })).toHaveAttribute("href", "/products/foam-roller");
    expect(container.innerHTML).not.toContain(b.waitingAlertId);
    expect(container.textContent).not.toContain("Amber & Oud");
    expectNoWrites();
    expect(
      fx.markupViolations(
        container,
        { forbidden: forbidden(), allowedIds: [a.waitingAlertId, a.restockedAlertId] },
        isAllowedInternalHref,
      ),
    ).toEqual([]);
  });

  test("acknowledged back-in-stock alert keeps its status but loses the acknowledge form", async () => {
    dbClient.getDatabase().run("UPDATE stock_alerts SET acknowledged_at = ? WHERE id = ?", [new Date().toISOString(), b.restockedAlertId]);
    setCookies({ guest: fx.OWNER_B });
    const { container } = await renderPage();
    expect(screen.getByText("Back in stock")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Acknowledge/ })).toBeNull();
    expect(container.innerHTML).not.toContain(a.restockedAlertId);
  });

  test("D-T98-4: an unpublished (future-dated) product is text + 'No longer available', no link, forms keep working", async () => {
    const db = dbClient.getDatabase();
    const saved = db.query("SELECT published_at FROM products WHERE id = 'prod_walnut-desk'").get() as { published_at: string };
    db.run("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = 'prod_walnut-desk'");
    try {
      setCookies({ guest: fx.OWNER_A });
      const { container } = await renderPage();
      const hrefs = [...container.querySelectorAll("a[href]")].map((el) => el.getAttribute("href"));
      expect(hrefs).not.toContain("/products/walnut-desk");
      expect(hrefs).toContain("/products/foam-roller");
      const list = screen.getByRole("list", { name: "Watched products" });
      const gone = within(list)
        .getAllByRole("listitem")
        .find((li) => li.textContent?.includes("Walnut Standing Desk"));
      expect(gone?.textContent).toContain("No longer available");
      expect(gone?.textContent).not.toContain("is available again");
      const forms = [...(gone?.querySelectorAll("form") ?? [])];
      expect(forms).toHaveLength(2);
      for (const f of forms) {
        expect(f.querySelector('input[name="alertId"]')).toHaveAttribute("value", a.restockedAlertId);
        expect(f.querySelector('input[name="productSlug"]')).toBeNull();
      }
      expect(container.innerHTML).not.toContain('value="walnut-desk"');
      expectNoWrites();
    } finally {
      db.run("UPDATE products SET published_at = ? WHERE id = 'prod_walnut-desk'", [saved.published_at]);
    }
  });

  test("signed in: the user's alerts only", async () => {
    setCookies({ auth: user.token });
    const { container } = await renderPage();
    expect(container.innerHTML).toContain(userData.waitingAlertId);
    expect(container.innerHTML).not.toContain(a.waitingAlertId);
    expect(container.innerHTML).not.toContain(user.ownerKey);
    expectNoWrites();
  });

  describe("guest sign-in invitation (D-T98-1)", () => {
    const next = encodeURIComponent("/account/alerts");

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
      const empty = within(container).getByText("You're not watching any products", { exact: false });
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
