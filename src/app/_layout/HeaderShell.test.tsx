import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

// next/headers mock (process-wide in bun test): registered before the shell is
// imported; delegates to per-test state. The shell must only READ cookies.
class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly writes: string[] = [];

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string): void {
    this.writes.push(name);
  }

  delete(name: string): void {
    this.writes.push(name);
  }
}

let fakeStore = new FakeCookieStore();

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { getCartService } = await import("@/server/cart/cart-service");
const { getAuthService } = await import("@/server/auth/auth-service");
const { AUTH_COOKIE_NAME, SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { isAllowedInternalHref } = await import("@/content/routes");
const { HeaderShell, HEADER_UTILITY_LINKS } = await import("./HeaderShell");
const { DEPARTMENT_NAV } = await import("@/content/navigation");

const SESSION = "66666666-6666-4666-8666-666666666666";
const TOTE = "prod_canvas-tote-bag";

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

async function renderShell() {
  return render(await HeaderShell());
}

describe("HeaderShell (server component data flow)", () => {
  // T148: the "departments in the search select" pin moved to the CategoryNav row and the
  // drawer (the department select is being dropped from the header per the T143 ruling).
  test("guest without cookies: 'Cart, 0 items', 'Hello, Sign in', wordmark, search, CategoryNav, no cookie writes", async () => {
    await renderShell();
    expect(screen.getByRole("link", { name: "Cart, 0 items" })).toHaveAttribute("href", "/cart");
    expect(screen.getByRole("link", { name: "Hello, Sign in, Account & Lists" })).toHaveAttribute("href", "/signin");
    expect(screen.getByRole("link", { name: "Northwind Goods" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("search", { name: "Site search" })).toBeInTheDocument();
    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(within(primary).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "/deals",
      ...DEPARTMENT_NAV.map((d) => `/category/${d.slug}`),
    ]);
    // T148 ruling: no department select in the header search (pin flipped from "select present").
    expect(screen.queryByRole("combobox", { name: "Search in department" })).toBeNull();
    expect(screen.getByRole("banner").querySelector('select, [name="dept"]')).toBeNull();
    // Phone-only account icon link (no JS needed).
    expect(within(screen.getByTestId("header-mobile-account")).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
    expect(within(primary).getAllByRole("link").some((a) => a.hasAttribute("aria-current"))).toBe(false);
    expect(fakeStore.writes).toEqual([]);
  });

  test("landmarks: one banner; navs Primary (+ Departments when the drawer opens), unique", async () => {
    await renderShell();
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"))).toEqual(["Primary"]);
    act(() => {
      fireEvent.click(within(screen.getByTestId("header-menu")).getByRole("button", { name: /All/ }));
    });
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(names).toContain("Departments");
    expect(new Set(names).size).toBe(names.length);
    // The drawer lists the seeded departments (categoryTree).
    const drawerNav = screen.getByRole("navigation", { name: "Departments" });
    expect(within(drawerNav).getByText("Electronics")).toBeInTheDocument();
  });

  test("guest with a cart: the count comes from the session's cart", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const added = getCartService().addItem(SESSION, TOTE, 3);
    expect(added.ok).toBe(true);
    await renderShell();
    expect(screen.getByRole("link", { name: "Cart, 3 items" })).toBeInTheDocument();
    expect(fakeStore.writes).toEqual([]);
  });

  test("signed in: 'Hello, <display name>' links to /account and the flyout has Sign out", async () => {
    const issued = await getAuthService().signUp(
      { email: "ada@header.test", password: "correct horse battery staple", displayName: "Ada Lovelace" },
      { sessionKey: SESSION },
    );
    if (!issued.ok) throw new Error(`signUp failed: ${issued.error.code}`);
    fakeStore.jar.set(AUTH_COOKIE_NAME, issued.value.token);
    const { container } = await renderShell();
    expect(screen.getByRole("link", { name: "Hello, Ada Lovelace, Account & Lists" })).toHaveAttribute("href", "/account");
    expect(within(screen.getByTestId("header-mobile-account")).getByRole("link", { name: "Your account" })).toHaveAttribute("href", "/account");
    const menu = screen.getByTestId("account-menu");
    expect(within(menu).getByRole("button", { name: "Sign out", hidden: true }).closest("form")).not.toBeNull();
    // The email and owner key never reach the markup.
    expect(container.innerHTML).not.toContain("ada@header.test");
    expect(container.innerHTML).not.toContain(issued.value.user.ownerKey);
    expect(fakeStore.writes).toEqual([]);
  });

  // T148: the Shop row, "Returns & Orders" link and promo strip were replaced by the
  // Lists link and the benefits strip (free shipping from the shipping methods + coupon).
  test("Lists link and the benefits strip (threshold from seeded shipping data, track order, returns, coupon)", async () => {
    await renderShell();
    expect(screen.queryByRole("navigation", { name: "Shop" })).toBeNull();
    expect(screen.queryByTestId("promo-strip")).toBeNull();
    expect(screen.queryByRole("link", { name: "Returns & Orders" })).toBeNull();
    expect(screen.getByRole("link", { name: "Lists" })).toHaveAttribute("href", "/lists");
    const list = screen.getByRole("list", { name: "Store benefits" });
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(4);
    expect(within(list).getByRole("link", { name: "Free standard shipping on orders of $35 or more" })).toHaveAttribute("href", "/shipping");
    expect(within(list).getByRole("link", { name: "Track your order" })).toHaveAttribute("href", "/orders");
    expect(within(list).getByRole("link", { name: "Returns and refunds" })).toHaveAttribute("href", "/returns");
    expect(list).toHaveTextContent(/Use code [A-Z0-9_-]+ for /);
  });

  test("contract G-12: a different threshold in the shipping data changes the text", async () => {
    getDatabase().exec("UPDATE shipping_methods SET free_over_cents = 5000 WHERE free_over_cents IS NOT NULL");
    await renderShell();
    const list = screen.getByRole("list", { name: "Store benefits" });
    expect(list).toHaveTextContent("Free standard shipping on orders of $50 or more");
    expect(list).not.toHaveTextContent("$35");
  });

  test("no free shipping method -> the free-shipping benefit is omitted (never a hardcoded amount)", async () => {
    getDatabase().exec("UPDATE shipping_methods SET free_over_cents = NULL");
    await renderShell();
    const list = screen.getByRole("list", { name: "Store benefits" });
    expect(list).not.toHaveTextContent(/Free (standard )?shipping/);
    expect(within(list).getByRole("link", { name: "Track your order" })).toBeInTheDocument();
  });

  test("every href rendered by the shell is an allowed internal route (or #main)", async () => {
    const { container } = await renderShell();
    for (const a of container.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      if (href === "#main") continue;
      expect({ href, ok: isAllowedInternalHref(href) }).toEqual({ href, ok: true });
    }
    for (const link of HEADER_UTILITY_LINKS) expect(isAllowedInternalHref(link.href)).toBe(true);
  });

  test("a broken database does not take the header down", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const errors = mock(() => {});
    const originalError = console.error;
    console.error = errors;
    try {
      getDatabase().exec("DROP TABLE cart_items; DROP TABLE coupons;");
      await renderShell();
    } finally {
      console.error = originalError;
    }
    expect(screen.getByRole("link", { name: "Cart, 0 items" })).toBeInTheDocument();
    expect(screen.queryByText(/Use code/)).toBeNull();
    expect(screen.getByRole("list", { name: "Store benefits" })).toHaveTextContent("Free standard shipping on orders of $35 or more");
  });

  test("a missing shipping table only drops the free-shipping benefit", async () => {
    const errors = mock(() => {});
    const originalError = console.error;
    console.error = errors;
    try {
      getDatabase().exec("PRAGMA foreign_keys = OFF; DROP TABLE shipping_methods;");
      await renderShell();
    } finally {
      console.error = originalError;
    }
    expect(screen.getByRole("link", { name: "Northwind Goods" })).toHaveAttribute("href", "/");
    const list = screen.getByRole("list", { name: "Store benefits" });
    expect(list).not.toHaveTextContent(/Free (standard )?shipping/);
    expect(errors).toHaveBeenCalled();
  });
});
