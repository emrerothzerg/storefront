// QA (T163, Phase 3 wave B1): SiteHeader v3 + HeaderShell (T148) against BACKLOG-phase3 T148 AC1–6
// and tests/redesign/CONTRACTS.md G-1, G-2, G-5, G-8 … G-13, G-20.
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { expectNotNull, expectNull } from "@/test/dom-assertions";

// ---- process-wide mocks (registered before anything imports next/headers) ----
class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly writes: string[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  getAll(): Array<{ name: string; value: string }> {
    return [...this.jar].map(([name, value]) => ({ name, value }));
  }
  has(name: string): boolean {
    return this.jar.has(name);
  }
  set(name: string): void {
    this.writes.push(`set:${name}`);
  }
  delete(name: string): void {
    this.writes.push(`delete:${name}`);
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
const { getAuthService } = await import("@/server/auth/auth-service");
const { AUTH_COOKIE_NAME, SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { getShippingService } = await import("@/server/pricing/shipping-service");
const { getListingService } = await import("@/server/catalog/listing-service");
const { getCouponService } = await import("@/server/pricing/coupon-service");
const { isAllowedInternalHref } = await import("@/content/routes");
const { DEPARTMENT_NAV } = await import("@/content/navigation");
const { HEADER_BENEFITS } = await import("@/content/header-benefits");
const { SiteHeader } = await import("@/components/organisms/SiteHeader");
const { HeaderShell, HEADER_CATEGORY_LEADING, HEADER_UTILITY_LINKS } = await import("@/app/_layout/HeaderShell");
const { loadHeaderData, resetHeaderDataLogState } = await import("@/app/_layout/header-data");
const { buildHeaderBenefits, HEADER_BENEFITS_FALLBACK } = await import("@/app/_layout/header-benefits");

type HeaderProps = Parameters<typeof SiteHeader>[0];
type DepartmentInput = NonNullable<HeaderProps["departments"]>[number];
type ShippingQuoteList = ReturnType<ReturnType<typeof getShippingService>["listMethods"]>;

const SESSION = "55555555-5555-4555-8555-555555555555";
const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; ‮rtl`;
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex="0"]';
// Retailer / payment names and theme strings are built at runtime (never literals in the repo).
const BRAND_WORDS = [["k", "mart"], ["one", "pass"], ["after", "pay"], ["zip", " pay"], ["app", " store"], ["google", " play"]].map((p) =>
  p.join(""),
);
const THEME_NAME = new RegExp(["the", "me|da", "rk mode|li", "ght mode"].join(""), "i");
const DARK_VARIANT = ["da", "rk:"].join("");
const DATA_THEME = ["data-", "theme"].join("");

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
  resetHeaderDataLogState();
});
const restorers: Array<() => void> = [];
afterEach(() => {
  while (restorers.length > 0) restorers.pop()?.();
});
afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

function serverLike<F extends (...args: never[]) => unknown>(fn: F): F {
  const formFields = () => ({ name: "$ACTION_REF_1", action: "", encType: "multipart/form-data", method: "POST", data: null });
  return Object.assign(fn, {
    $$FORM_ACTION: formFields,
    bind(): unknown {
      return Object.assign(async () => null, { $$FORM_ACTION: formFields });
    },
  });
}
const signOut = serverLike(async (): Promise<void> => undefined);

function cat(slug: string, name: string, parentId: string | null, sortOrder = 0) {
  return { id: `c_${slug}`, slug, name, description: "", parentId, sortOrder, imageUrl: null };
}
const DEPTS: DepartmentInput[] = [
  { ...cat("electronics", "Electronics", null, 1), children: [cat("audio", "Audio", "c_electronics")] },
  { ...cat("home-kitchen", "Home & Kitchen", null, 2), children: [] },
];

function v3Props(over: Partial<HeaderProps> = {}): HeaderProps {
  return {
    cartCount: 3,
    storeName: "Northwind Goods",
    departments: DEPTS,
    popularSearches: ["Electronics"],
    account: { status: "guest" },
    utilityLinks: HEADER_UTILITY_LINKS,
    categoryNav: DEPARTMENT_NAV,
    categoryNavLeading: HEADER_CATEGORY_LEADING,
    benefits: buildHeaderBenefits({
      freeShippingThresholdCents: 3500,
      currency: "USD",
      coupon: { code: "WELCOME10", description: "10% off" },
    }),
    ...over,
  };
}

async function shellHtml(): Promise<string> {
  return renderToStaticMarkup(await HeaderShell());
}

/** Replace the shipping reader the shell uses (`getShippingService().listMethods`) for one test. */
function stubShippingMethods(build: () => ShippingQuoteList): void {
  const fixed = build(); // built before the spy so quote() reads the real service
  const impl = (): ShippingQuoteList => fixed;
  const spy = spyOn(getShippingService(), "listMethods").mockImplementation(impl);
  restorers.push(() => spy.mockRestore());
}
function quote(freeOverCents: number | null, isActive = true): ShippingQuoteList[number] {
  const [base] = getShippingService().listMethods(0);
  if (base === undefined) throw new Error("seed has no shipping method");
  return { ...base, method: { ...base.method, freeOverCents, isActive } };
}
function silenceErrors(): ReturnType<typeof spyOn> {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  restorers.push(() => spy.mockRestore());
  return spy;
}

function benefitTexts(doc: Document): string[] {
  const strip = doc.querySelector('[data-testid="header-benefits"]');
  return [...(strip?.querySelectorAll("li") ?? [])].map((li) => (li.textContent ?? "").trim());
}

async function signIn(displayName: string): Promise<void> {
  const issued = await getAuthService().signUp(
    { email: "qa.t163@example.com", password: "correct horse battery staple", displayName },
    { sessionKey: SESSION },
  );
  if (!issued.ok) throw new Error(`signUp failed: ${issued.error.code}`);
  fakeStore.jar.set(AUTH_COOKIE_NAME, issued.value.token);
  fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
}

// --------------------------------------------------------------------------------------------
describe("T148 AC1 / G-1, G-2, G-5: rows and landmarks (HeaderShell, real services)", () => {
  test("one <header> banner; skip link (#main, 'Skip to content') is the first focusable element and sits outside it", async () => {
    const doc = parse(await shellHtml());
    expect(doc.querySelectorAll("header")).toHaveLength(1);
    const first = doc.querySelector(FOCUSABLE);
    expect(first?.getAttribute("href")).toBe("#main");
    expect(first?.textContent).toBe("Skip to content");
    expect(doc.querySelector("header")?.contains(first ?? null)).toBe(false);
  });

  test("landmarks (rendered): banner x1, nav names = ['Primary'] (drawer closed), search 'Site search'; no Main/Shop", async () => {
    render(await HeaderShell());
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"))).toEqual(["Primary"]);
    const search = within(screen.getByRole("banner")).getByRole("search");
    expect(search).toHaveAccessibleName("Site search");
    expect(screen.getAllByRole("search")).toHaveLength(1);
  });

  test("opening the 'All' drawer adds 'Departments'; every nav name stays unique", async () => {
    render(await HeaderShell());
    const trigger = within(screen.getByTestId("header-menu")).getByRole("button", { name: /All/ });
    act(() => {
      fireEvent.click(trigger);
    });
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label") ?? "");
    expect(names).toContain("Primary");
    expect(names).toContain("Departments");
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.trim() !== "")).toBe(true);
  });

  test("row order: wordmark, search, actions, menu; then the Primary row, then benefits", async () => {
    const doc = parse(await shellHtml());
    const header = doc.querySelector("header");
    const row = header?.firstElementChild;
    expect([...(row?.children ?? [])].map((el) => el.getAttribute("data-testid"))).toEqual([
      "header-wordmark",
      "header-search",
      "header-actions",
      "header-menu",
    ]);
    expect([...(header?.children ?? [])].slice(1).map((el) => el.getAttribute("data-testid"))).toEqual([
      "header-category-row",
      "header-benefits",
    ]);
    // header-actions is a plain list, not a nav landmark.
    expect(doc.querySelector('[data-testid="header-actions"]')?.tagName).toBe("UL");
    expect(doc.querySelector('[data-testid="header-actions"]')?.closest("nav")).toBeNull();
  });

  test("G-8 wordmark: text link 'Northwind Goods' to '/', no image", async () => {
    render(await HeaderShell());
    const link = within(screen.getByRole("banner")).getByRole("link", { name: /Northwind Goods/ });
    expect(link.getAttribute("href")).toBe("/");
    expect(link.querySelector("img, svg")).toBeNull();
    expect(link.textContent).toBe("Northwind Goods");
  });
});

// --------------------------------------------------------------------------------------------
describe("G-9 header search: GET /search, q only (no dept field / select)", () => {
  test("shell markup: one search form, GET, action /search, q maxlength 100, labelled, pill placeholder", async () => {
    const doc = parse(await shellHtml());
    const forms = [...doc.querySelectorAll("header form")].filter((f) => f.getAttribute("action") === "/search");
    expect(forms).toHaveLength(1);
    const form = forms[0] as HTMLFormElement;
    expect((form.getAttribute("method") ?? "get").toLowerCase()).toBe("get");
    const q = form.querySelector('input[name="q"]');
    expect(q?.getAttribute("maxlength")).toBe("100");
    expect(q?.getAttribute("placeholder")).toBe("Search products, categories and more");
    const id = q?.getAttribute("id") ?? "";
    const label = q?.getAttribute("aria-label") ?? doc.querySelector(`label[for="${id}"]`)?.textContent ?? "";
    expect(label.trim()).not.toBe("");
  });

  test("no `dept` field anywhere in the banner: no select, no [name=dept], no input with form= pointing at the search", async () => {
    const doc = parse(await shellHtml());
    const header = doc.querySelector("header");
    expect(header?.querySelectorAll("select")).toHaveLength(0);
    expect(header?.querySelectorAll('[name="dept"]')).toHaveLength(0);
    const form = [...(header?.querySelectorAll("form") ?? [])].find((f) => f.getAttribute("action") === "/search");
    const formId = form?.getAttribute("id");
    if (formId) expect(doc.querySelectorAll(`[form="${formId}"]`)).toHaveLength(0);
    // Named controls in the search form: q only (submit buttons carry no name).
    const named = [...(form?.querySelectorAll("[name]") ?? [])].map((el) => el.getAttribute("name"));
    expect(named).toEqual(["q"]);
  });
});

// --------------------------------------------------------------------------------------------
describe("T148 AC2 / G-10: cart count", () => {
  for (const [count, name, badge] of [
    [0, "Cart, 0 items", "0"],
    [1, "Cart, 1 item", "1"],
    [99, "Cart, 99 items", "99"],
    [100, "Cart, 100 items", "99+"],
    [12345, "Cart, 12345 items", "99+"],
  ] as const) {
    test(`count ${count}: name "${name}", visible badge "${badge}" (aria-hidden), full count in sr-only text`, () => {
      render(<SiteHeader {...v3Props({ cartCount: count })} />);
      const link = within(screen.getByTestId("header-actions")).getByRole("link", { name });
      expect(link.getAttribute("href")).toBe("/cart");
      const badgeEl = within(link).getByTestId("cart-count");
      expect(badgeEl.textContent).toBe(badge);
      expect(badgeEl.getAttribute("aria-hidden")).toBe("true");
      const srOnly = [...link.querySelectorAll(".sr-only")].map((el) => el.textContent ?? "");
      expect(srOnly).toContain(name);
    });
  }

  test("guest cart session through the shell: count from the cart service, session id never in markup, no cookie writes", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const { getCartService } = await import("@/server/cart/cart-service");
    expect(getCartService().addItem(SESSION, "prod_canvas-tote-bag", 3).ok).toBe(true);
    const html = await shellHtml();
    expect(html).toContain("Cart, 3 items");
    expect(html).not.toContain(SESSION);
    expect(fakeStore.writes).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------
describe("T148 AC3 / G-11: signed-out and signed-in states without JS", () => {
  test("guest (shell, static HTML): 'Hello, Sign in' -> /signin; phone icon 'Sign in' -> /signin; no sign-out form", async () => {
    const doc = parse(await shellHtml());
    const actions = doc.querySelector('[data-testid="header-actions"]');
    const first = actions?.querySelector("a");
    expect(first?.getAttribute("href")).toBe("/signin");
    expect(first?.textContent).toContain("Sign in");
    const phone = doc.querySelector('[data-testid="header-mobile-account"] a');
    expect(phone?.getAttribute("href")).toBe("/signin");
    expect(phone?.textContent?.trim()).toBe("Sign in");
    expect(doc.querySelector("header form[method='post'], header form[method='POST']")).toBeNull();
    expect([...doc.querySelectorAll("header button")].map((b) => b.textContent)).not.toContain("Sign out");
  });

  test("guest rendered: two 'Sign in' links (flyout + phone icon) both go to /signin when scoped", async () => {
    render(await HeaderShell());
    const phone = within(screen.getByTestId("header-mobile-account")).getByRole("link", { name: "Sign in" });
    expect(phone.getAttribute("href")).toBe("/signin");
    const menu = screen.getByTestId("account-menu");
    for (const a of within(menu).getAllByRole("link", { name: /Sign in/ })) expect(a.getAttribute("href")).toMatch(/^\/signin/);
  });

  test("signed in (shell): greeting -> /account; phone icon 'Your account' -> /account; Sign out form present; no PII", async () => {
    await signIn("Grace Hopper");
    render(await HeaderShell());
    const actions = screen.getByTestId("header-actions");
    expect(within(actions).getByRole("link", { name: "Hello, Grace Hopper, Account & Lists" }).getAttribute("href")).toBe("/account");
    expect(within(screen.getByTestId("header-mobile-account")).getByRole("link", { name: "Your account" }).getAttribute("href")).toBe(
      "/account",
    );
    const menu = screen.getByTestId("account-menu");
    expect(within(menu).getByRole("button", { name: "Sign out" }).closest("form")).not.toBeNull();
    expect(screen.getByRole("banner").innerHTML).not.toContain("qa.t163@example.com");
    expect(fakeStore.writes).toEqual([]);
  });

  test("sign-out without JS (server action stand-in): POST multipart form with a submit 'Sign out', inside the closed <details>", () => {
    const doc = parse(
      renderToStaticMarkup(<SiteHeader {...v3Props({ account: { status: "signed-in", displayName: "Ada", signOutAction: signOut } })} />),
    );
    const menu = doc.querySelector('[data-testid="account-menu"]');
    expect(menu?.tagName).toBe("DETAILS");
    expect(menu?.hasAttribute("open")).toBe(false);
    const forms = menu?.querySelectorAll("form") ?? [];
    expect(forms).toHaveLength(1);
    expect(forms[0]?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(forms[0]?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(forms[0]?.getAttribute("action") ?? "").not.toMatch(/^javascript:/i);
    expect(forms[0]?.querySelector('button[type="submit"]')?.textContent).toBe("Sign out");
  });
});

// --------------------------------------------------------------------------------------------
describe("T148 follow-up: mobile account icon link", () => {
  test("44px (min-h-touch + min-w-touch), md:hidden, icon decorative, name from sr-only text", () => {
    render(<SiteHeader {...v3Props()} />);
    const li = screen.getByTestId("header-mobile-account");
    expect(li.className).toContain("md:hidden");
    const link = within(li).getByRole("link", { name: "Sign in" });
    expect(link.className).toContain("min-h-touch");
    expect(link.className).toContain("min-w-touch");
    for (const svg of link.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  test("not rendered without an account block or without departments (no drawer)", () => {
    const { unmount } = render(<SiteHeader {...v3Props({ account: undefined })} />);
    expectNull(screen.queryByTestId("header-mobile-account"));
    unmount();
    render(<SiteHeader {...v3Props({ departments: undefined })} />);
    expectNull(screen.queryByTestId("header-mobile-account"));
  });

  test("below md the desktop account block and Lists are hidden (drawer carries them); cart stays", () => {
    render(<SiteHeader {...v3Props()} />);
    const items = [...screen.getByTestId("header-actions").children];
    const hidden = items.filter((li) => li.className.includes("hidden md:block"));
    expect(hidden).toHaveLength(2); // account block + Lists
    const cartLi = items.find((li) => li.querySelector('a[href="/cart"]') !== null);
    expect(cartLi?.className ?? "").not.toContain("hidden");
  });
});

// --------------------------------------------------------------------------------------------
describe("G-13 Primary row: Deals leading link, then DEPARTMENT_NAV", () => {
  test("shell: first link Deals -> /deals, then one /category/<slug> per DEPARTMENT_NAV entry, none aria-current", async () => {
    render(await HeaderShell());
    const primary = screen.getByRole("navigation", { name: "Primary" });
    const links = within(primary).getAllByRole("link");
    expect(links[0]?.textContent).toBe("Deals");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/deals", ...DEPARTMENT_NAV.map((d) => `/category/${d.slug}`)]);
    expect(links.filter((a) => a.hasAttribute("aria-current"))).toHaveLength(0);
  });

  test("hostile leading link (javascript:, external, protocol-relative) is dropped; departments stay", () => {
    for (const href of ["javascript:alert(1)", "https://evil.example/deals", "//evil.example"]) {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const { unmount } = render(<SiteHeader {...v3Props({ categoryNavLeading: { label: "Deals", href } })} />);
      const primary = screen.getByRole("navigation", { name: "Primary" });
      const hrefs = within(primary).getAllByRole("link").map((a) => a.getAttribute("href"));
      expect(hrefs).not.toContain(href);
      expect(hrefs[0]).toBe(`/category/${DEPARTMENT_NAV[0]?.slug}`);
      unmount();
      warn.mockRestore();
    }
  });
});

// --------------------------------------------------------------------------------------------
describe("T148 AC5 / G-12: benefits strip from content, threshold from shipping data (reader stubbed)", () => {
  test("seeded data: strip label from content; 3–4 items; free shipping names $35 (seed standard freeOverCents 3500)", async () => {
    render(await HeaderShell());
    const list = within(screen.getByTestId("header-benefits")).getByRole("list", { name: HEADER_BENEFITS.label });
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.length).toBeLessThanOrEqual(4);
    expect(items[0]?.textContent).toContain("$35");
    for (const a of list.querySelectorAll("a")) {
      expect(["/shipping", "/orders", "/returns", "/help"]).toContain(a.getAttribute("href") ?? "");
    }
  });

  test("stubbed reader 5000 -> '$50'; 4250 -> '$42.50'; text changes with the data (never hardcoded)", async () => {
    stubShippingMethods(() => [quote(5000), quote(null)]);
    const fifty = benefitTexts(parse(await shellHtml()));
    expect(fifty[0]).toBe("Free standard shipping on orders of $50 or more");
    expect(fifty.join("|")).not.toContain("$35");
    restorers.pop()?.();
    stubShippingMethods(() => [quote(9000), quote(4250)]);
    const lowest = benefitTexts(parse(await shellHtml()));
    expect(lowest[0]).toBe("Free standard shipping on orders of $42.50 or more");
  });

  test("inactive / zero / negative / fractional / null thresholds are ignored -> no free-shipping item", async () => {
    stubShippingMethods(() => [quote(1000, false), quote(0), quote(-5), quote(12.5), quote(null)]);
    const texts = benefitTexts(parse(await shellHtml()));
    expect(texts.some((t) => t.startsWith("Free standard shipping on orders"))).toBe(false);
    // The always-true items stay.
    expect(texts).toContain("Track your order");
    expect(texts).toContain("Returns and refunds");
  });

  test("DB-level change (no stub): raising standard free_over_cents to 7500 moves the text to $75", async () => {
    getDatabase().run("UPDATE shipping_methods SET free_over_cents = 7500 WHERE id = 'standard'");
    expect(benefitTexts(parse(await shellHtml()))[0]).toBe("Free standard shipping on orders of $75 or more");
  });

  test("coupon item: text only (no link), from the first promoted coupon", async () => {
    const doc = parse(await shellHtml());
    const items = [...(doc.querySelector('[data-testid="header-benefits"]')?.querySelectorAll("li") ?? [])];
    const coupon = items.find((li) => (li.textContent ?? "").startsWith("Use code"));
    expect(coupon).toBeDefined();
    expect(coupon?.querySelector("a")).toBeNull();
  });

  test("content absent (null) -> hardcoded fallback copy; malformed template -> fallback template", () => {
    const absent = buildHeaderBenefits({ freeShippingThresholdCents: 3500, currency: "USD", coupon: null, content: null });
    expect(absent.label).toBe(HEADER_BENEFITS_FALLBACK.label);
    expect(absent.items.map((i) => i.label)).toEqual([
      "Free standard shipping on orders of $35 or more",
      ...HEADER_BENEFITS_FALLBACK.items.map((i) => i.label),
    ]);
    const malformed = buildHeaderBenefits({
      freeShippingThresholdCents: 3500,
      currency: "USD",
      coupon: null,
      content: {
        ...HEADER_BENEFITS,
        label: "   ",
        freeShipping: { ...HEADER_BENEFITS.freeShipping, template: "Free shipping always", href: "https://evil.example" },
        items: [{ id: "x", label: "  ", icon: "package", href: "/orders" }],
      },
    });
    expect(malformed.label).toBe(HEADER_BENEFITS_FALLBACK.label);
    expect(malformed.items[0]?.label).toBe("Free standard shipping on orders of $35 or more");
    expect(malformed.items[0]?.href).toBe("/shipping");
    expect(malformed.items.slice(1).map((i) => i.href)).toEqual(HEADER_BENEFITS_FALLBACK.items.map((i) => i.href));
  });

  test("hostile benefit label renders as text; no element/attribute injected", () => {
    const { container } = render(
      <SiteHeader {...v3Props({ benefits: { label: HOSTILE, items: [{ id: "h", label: HOSTILE, href: "/orders" }] } })} />,
    );
    expect(screen.getByTestId("header-benefits").textContent).toContain(HOSTILE);
    expectNull(container.querySelector("script"));
    for (const el of container.querySelectorAll("*")) expect(el.hasAttribute("onerror")).toBe(false);
  });
});

// --------------------------------------------------------------------------------------------
describe("Fail-open reads: one failing reader never takes the header down", () => {
  test("shipping reader throws -> header renders, no free-shipping item, logged once across two requests", async () => {
    const errors = silenceErrors();
    const spy = spyOn(getShippingService(), "listMethods").mockImplementation(() => {
      throw new Error("SQLITE_ERROR: no such table: shipping_methods");
    });
    restorers.push(() => spy.mockRestore());
    const first = parse(await shellHtml());
    const second = parse(await shellHtml());
    for (const doc of [first, second]) {
      expect(doc.querySelectorAll("header")).toHaveLength(1);
      expect(benefitTexts(doc).some((t) => t.startsWith("Free standard shipping on orders"))).toBe(false);
      expect(benefitTexts(doc)).toContain("Track your order");
    }
    const shippingLogs = (errors.mock.calls as unknown[][]).filter((c) => String(c[0]).includes("shipping"));
    expect(shippingLogs).toHaveLength(1);
  });

  test("categoryTree throws -> header renders with search, Primary row (static nav) and cart; no drawer departments", async () => {
    silenceErrors();
    const spy = spyOn(getListingService(), "categoryTree").mockImplementation(() => {
      throw new Error("boom");
    });
    restorers.push(() => spy.mockRestore());
    render(await HeaderShell());
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getByRole("search", { name: "Site search" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cart, 0 items" })).toBeInTheDocument();
  });

  test("listPromoted throws -> no coupon item, rest of the strip intact", async () => {
    silenceErrors();
    const spy = spyOn(getCouponService(), "listPromoted").mockImplementation(() => {
      throw new Error("boom");
    });
    restorers.push(() => spy.mockRestore());
    const texts = benefitTexts(parse(await shellHtml()));
    expect(texts.some((t) => t.startsWith("Use code"))).toBe(false);
    expect(texts[0]).toContain("$35");
  });

  test("loadHeaderData: every reader throws -> guest data with nulls/empties, never throws", async () => {
    silenceErrors();
    const boom = () => {
      throw new Error("boom");
    };
    const data = await loadHeaderData({
      readSessionId: async () => boom(),
      readCurrentUser: async () => boom(),
      getCartTotals: boom,
      categoryTree: boom,
      listPromoted: boom,
      listShippingMethods: boom,
    });
    expect(data).toEqual({
      cartCount: 0,
      user: null,
      departments: [],
      popularSearches: [],
      promoCoupon: null,
      freeShippingThresholdCents: null,
    });
  });
});

// --------------------------------------------------------------------------------------------
describe("T148 AC6 / G-20 and cross-cutting: no theme toggle, hrefs, 44px, light-only, brand-free", () => {
  test("no theme toggle: no element named after a colour theme; no theme attribute; no dark-variant classes (guest + signed in)", async () => {
    for (const signedIn of [false, true]) {
      if (signedIn) await signIn("Ada");
      const { container, unmount } = render(await HeaderShell());
      const named = [...container.querySelectorAll("a, button, summary, input, select, [role]")].filter((el) =>
        THEME_NAME.test(`${el.textContent ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`),
      );
      expect(named.map((el) => el.outerHTML.slice(0, 80))).toEqual([]);
      expect(container.querySelectorAll(`[${DATA_THEME}]`)).toHaveLength(0);
      expect(container.innerHTML).not.toContain(DARK_VARIANT);
      unmount();
    }
  });

  test("every href (guest and signed in, drawer open) passes isAllowedInternalHref", async () => {
    for (const signedIn of [false, true]) {
      if (signedIn) await signIn("Ada");
      const { container, unmount } = render(await HeaderShell());
      act(() => {
        fireEvent.click(within(screen.getByTestId("header-menu")).getByRole("button", { name: /All/ }));
      });
      const hrefs = [...container.querySelectorAll("[href]")].map((a) => a.getAttribute("href") ?? "");
      expect(hrefs.length).toBeGreaterThan(10);
      const bad = hrefs.filter((h) => h !== "#main" && !isAllowedInternalHref(h));
      expect(bad).toEqual([]);
      unmount();
    }
  });

  test("44px: every link/button/summary in the banner row 1 and Primary row carries a touch-size class", async () => {
    const doc = parse(await shellHtml());
    const header = doc.querySelector("header");
    const targets = [...(header?.querySelectorAll("a[href], button, summary") ?? [])].filter(
      // Links inside the closed flyout / drawer panels are checked by their molecule QA (T147).
      (el) => el.closest("details") === null || el.tagName === "SUMMARY",
    );
    expect(targets.length).toBeGreaterThan(5);
    const small = targets.filter((el) => !/(^|\s)(min-h-touch|size-touch|h-touch)(\s|$)/.test(el.getAttribute("class") ?? ""));
    expect(small.map((el) => el.outerHTML.slice(0, 120))).toEqual([]);
  });

  test("no arbitrary or palette classes, no inline styles or handlers in the shell markup", async () => {
    const html = await shellHtml();
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle="/);
    const classes = [...parse(html).querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(classes.filter((c) => /(^|:)(bg|text|border|ring)-(gray|slate|red|blue|green|yellow|white|black)(-\d+)?$/.test(c))).toEqual([]);
  });

  test("brand-free: no retailer/payment names in the header markup; store name is the placeholder brand", async () => {
    const html = (await shellHtml()).toLowerCase();
    for (const word of BRAND_WORDS) expect({ word, found: html.includes(word) }).toEqual({ word, found: false });
    expect(html).toContain("northwind goods");
  });

  test("hostile display name and store name render as text (no script, no onerror)", () => {
    const { container } = render(
      <SiteHeader
        {...v3Props({ storeName: HOSTILE, account: { status: "signed-in", displayName: HOSTILE, signOutAction: signOut } })}
      />,
    );
    expectNotNull(screen.getByTestId("header-wordmark"));
    expect(screen.getByTestId("header-wordmark").textContent).toBe(HOSTILE);
    expectNull(container.querySelector("script"));
    for (const el of container.querySelectorAll("*")) expect(el.hasAttribute("onerror")).toBe(false);
  });

  test("ids in the shell markup are unique (guest and signed in)", async () => {
    for (const signedIn of [false, true]) {
      if (signedIn) await signIn("Ada");
      const ids = [...parse(await shellHtml()).querySelectorAll("[id]")].map((el) => el.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
