// QA (QA-W4-organisms-E / T90): T80 SiteHeader v2 + AccountMenu + header-model, src/app/_layout
// (HeaderShell, header-data, header-actions, header-sign-out-core) and src/app/layout.tsx.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expectFocused } from "@/test/dom-assertions";

// ---- process-wide mocks (before importing anything that touches next/headers or next/font) ----
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
mock.module("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-sans" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { getAuthService } = await import("@/server/auth/auth-service");
const { AUTH_COOKIE_NAME, SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { getCartService } = await import("@/server/cart/cart-service");
const { isAllowedInternalHref } = await import("@/content/routes");
const { ACCOUNT_NAV, AUTH_NAV, PRIMARY_NAV } = await import("@/content/navigation");
const {
  SiteHeader,
  SKIP_LINK_LABEL,
  cleanDisplayName,
  truncateDisplayName,
  couponPromoParts,
  visibleCartCount,
  cartAccessibleName,
} = await import("@/components/organisms/SiteHeader");
const { HeaderShell, HEADER_UTILITY_LINKS } = await import("@/app/_layout/HeaderShell");
const { loadHeaderData, resetHeaderDataLogState } = await import("@/app/_layout/header-data");
const { runHeaderSignOut } = await import("@/app/_layout/header-sign-out-core");
const { ProductGrid } = await import("@/components/organisms/ProductGrid");
const { AddressBook } = await import("@/components/organisms/AddressBook");
const layoutModule = await import("@/app/layout");

type HeaderDataDeps = Parameters<typeof loadHeaderData>[0];
type DepartmentInput = NonNullable<Parameters<typeof SiteHeader>[0]["departments"]>[number];

const ROOT = join(import.meta.dir, "../../..");
const APP = join(ROOT, "src/app");
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp;`;
const SESSION = "77777777-7777-4777-8777-777777777777";

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
  resetHeaderDataLogState();
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

function cat(slug: string, name: string, parentId: string | null, sortOrder = 0) {
  return { id: `c_${slug}`, slug, name, description: "", parentId, sortOrder, imageUrl: null };
}
const DEPTS: DepartmentInput[] = [
  { ...cat("electronics", "Electronics", null, 1), children: [cat("audio", "Audio", "c_electronics")] },
  { ...cat("home", "Home & Kitchen", null, 2), children: [] },
];

const signOut = serverLike(async (): Promise<void> => undefined);

function v2Props(over: Partial<Parameters<typeof SiteHeader>[0]> = {}): Parameters<typeof SiteHeader>[0] {
  return {
    cartCount: 3,
    storeName: "Northwind Goods",
    departments: DEPTS,
    account: { status: "signed-in", displayName: "Ada Lovelace", signOutAction: signOut },
    utilityLinks: HEADER_UTILITY_LINKS,
    primaryNav: PRIMARY_NAV,
    promo: { message: "Free shipping on orders of $35 or more", coupon: { code: "WELCOME10", description: "10% off" } },
    ...over,
  };
}

/** All page.tsx route patterns under src/app (e.g. "/account/addresses", "/products/[slug]"). */
function appRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "page.tsx") {
        const rel = relative(APP, dir).split("/").filter((s) => s !== "" && !s.startsWith("(") && !s.startsWith("_"));
        out.push(`/${rel.join("/")}`);
      }
    }
  };
  walk(APP);
  return out;
}
function routeExists(href: string): boolean {
  const path = href.split(/[?#]/)[0] ?? "";
  const segs = path.split("/").filter(Boolean);
  return appRoutes().some((route) => {
    const r = route.split("/").filter(Boolean);
    return r.length === segs.length && r.every((s, i) => s.startsWith("[") || s === segs[i]);
  });
}

// --------------------------------------------------------------------------------------------
describe("T80 criterion 1: MVP header shape with only cartCount", () => {
  // T163 pin move (T148): the MVP row-1 links are a plain `ul` in the banner (no "Main" nav landmark).
  test("skip link first with unchanged text; sticky top-0; row-1 list = Catalog + Cart (no nav); no search/menu/forms", () => {
    const html = renderToStaticMarkup(<SiteHeader cartCount={3} />);
    const doc = parse(html);
    const first = doc.body.firstElementChild;
    expect(first?.tagName).toBe("A");
    expect(first?.getAttribute("href")).toBe("#main");
    expect(first?.textContent).toBe("Skip to content");
    expect(SKIP_LINK_LABEL).toBe("Skip to content");
    const header = doc.querySelector("header");
    expect(header?.classList.contains("sticky")).toBe(true);
    expect(header?.classList.contains("top-0")).toBe(true);
    expect(header?.className).not.toContain("lg:sticky");
    expect(doc.querySelectorAll("nav")).toHaveLength(0);
    expect(doc.querySelectorAll("header ul")).toHaveLength(1);
    expect([...doc.querySelectorAll("header ul a")].map((a) => a.getAttribute("href"))).toEqual(["/", "/cart"]);
    expect(doc.querySelectorAll("form, details, input, select")).toHaveLength(0);
    expect(doc.querySelector('[data-testid="promo-strip"]')).toBeNull();
  });

  test('cart names: 0/1/3 items; badge caps at "99+" above 99; invalid counts -> 0', () => {
    for (const [count, name, badge] of [
      [0, "Cart, 0 items", "0"],
      [1, "Cart, 1 item", "1"],
      [3, "Cart, 3 items", "3"],
      [99, "Cart, 99 items", "99"],
      [100, "Cart, 100 items", "99+"],
      [-4, "Cart, 0 items", "0"],
      [Number.NaN, "Cart, 0 items", "0"],
      [2.5, "Cart, 0 items", "0"],
    ] as const) {
      const { unmount } = render(<SiteHeader cartCount={count} />);
      const link = screen.getByRole("link", { name });
      expect(link.getAttribute("href")).toBe("/cart");
      expect(within(link).getByTestId("cart-count").textContent).toBe(badge);
      unmount();
    }
    expect(visibleCartCount(1000)).toBe("99+");
    expect(cartAccessibleName(1)).toBe("Cart, 1 item");
  });
});

// --------------------------------------------------------------------------------------------
describe("T80 v2 structure", () => {
  // T163 pin move (T148): no "Main" nav; "Primary" (CategoryNav) only when `categoryNav` is passed,
  // the legacy "Shop" nav only with `primaryNav`.
  test("skip link stays first in v2; banner, Primary and Shop landmarks are unique", () => {
    const { container } = render(<SiteHeader {...v2Props()} />);
    const firstFocusable = container.querySelector("a, button, input, select, summary, textarea");
    expect(firstFocusable?.textContent).toBe("Skip to content");
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    const navs = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(new Set(navs).size).toBe(navs.length);
    expect(navs).not.toContain("Main");
    expect(navs).not.toContain("Primary");
    expect(navs).toContain("Shop");
    cleanup();
    render(<SiteHeader {...v2Props({ categoryNav: [{ slug: "electronics", label: "Electronics" }] })} />);
    const withPrimary = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(new Set(withPrimary).size).toBe(withPrimary.length);
    expect(withPrimary).toContain("Primary");
    expect(withPrimary).toContain("Shop");
    expect(withPrimary).not.toContain("Main");
    cleanup();
    render(<SiteHeader {...v2Props({ primaryNav: undefined })} />);
    expect(screen.queryAllByRole("navigation").map((n) => n.getAttribute("aria-label"))).not.toContain("Shop");
  });

  test("departments omitted -> no All menu, no SearchBox; departments=[] -> both present", () => {
    const { container, unmount } = render(<SiteHeader {...v2Props({ departments: undefined })} />);
    expect(container.querySelector("form[action='/search']")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^All/ })).toBeNull();
    unmount();
    const html = renderToStaticMarkup(<SiteHeader {...v2Props({ departments: [] })} />);
    const doc = parse(html);
    expect(doc.querySelector("form[action='/search']")).not.toBeNull();
    expect(html).toMatch(/>All</);
  });

  test("header search is a GET form to /search with field q (maxlength 100), labelled", () => {
    const doc = parse(renderToStaticMarkup(<SiteHeader {...v2Props()} />));
    const forms = [...doc.querySelectorAll("form")].filter((f) => f.getAttribute("action") === "/search");
    expect(forms).toHaveLength(1);
    const form = forms[0] as HTMLFormElement;
    expect((form.getAttribute("method") ?? "get").toLowerCase()).toBe("get");
    const q = doc.querySelector('input[name="q"]');
    expect(q).not.toBeNull();
    expect(q?.getAttribute("maxlength") ?? q?.getAttribute("maxLength")).toBe("100");
    // q belongs to the search form (inside it or via form=)
    expect(form.contains(q) || q?.getAttribute("form") === form.getAttribute("id")).toBe(true);
    // accessible label
    const id = q?.getAttribute("id");
    const labelled = q?.getAttribute("aria-label") ?? (id ? doc.querySelector(`label[for="${id}"]`)?.textContent : null) ?? q?.getAttribute("aria-labelledby");
    expect(labelled ?? "").not.toBe("");
  });

  // T163 pin move (T148): row 1 is `ul[data-testid="header-actions"]` = account block, Lists, the
  // phone-only account icon link (/account signed in), Cart. "Returns & Orders" left row 1.
  test("header-actions order: account block, Lists, phone account icon, Cart", () => {
    render(<SiteHeader {...v2Props()} />);
    const main = screen.getByTestId("header-actions");
    // Row-1 links only (the AccountMenu flyout panel inside <details> is excluded).
    const names = within(main)
      .getAllByRole("link")
      .filter((a) => a.closest("details") === null)
      .map((a) => a.getAttribute("href"));
    expect(names).toEqual(["/account", "/lists", "/account", "/cart"]);
    // Scoped: the flyout panel also has a "Your account" link (same href).
    expect(within(screen.getByTestId("header-mobile-account")).getByRole("link", { name: "Your account" }).getAttribute("href")).toBe("/account");
    expect(within(main).getByRole("link", { name: "Cart, 3 items" })).toBeInTheDocument();
    cleanup();
    render(<SiteHeader {...v2Props({ account: { status: "guest" } })} />);
    const guestNames = within(screen.getByTestId("header-actions"))
      .getAllByRole("link")
      .filter((a) => a.closest("details") === null)
      .map((a) => a.getAttribute("href"));
    expect(guestNames).toEqual(["/signin", "/lists", "/signin", "/cart"]);
  });

  test("Shop row skips hrefs already in row 1: no duplicate hrefs across header-actions + Shop", () => {
    render(<SiteHeader {...v2Props()} />);
    const main = screen.getByTestId("header-actions"); // T163 pin move (T148)
    const shop = screen.getByRole("navigation", { name: "Shop" });
    const mainHrefs = within(main)
      .getAllByRole("link")
      .filter((a) => a.closest("details") === null)
      .map((a) => a.getAttribute("href"));
    const shopHrefs = within(shop).getAllByRole("link").map((a) => a.getAttribute("href"));
    // T163 pin move (T148): /orders left row 1 (utility links = Lists only), so the Shop row keeps it.
    expect(shopHrefs).toEqual(["/deals", "/best-sellers", "/new-arrivals", "/orders", "/help"]);
    expect(shopHrefs).toEqual(PRIMARY_NAV.map((l) => l.href).filter((h) => !mainHrefs.includes(h)));
    // The phone-only account icon repeats the account block's /account by design (one is md:hidden,
    // the other hidden below md), so compare unique row-1 hrefs against the Shop row.
    const all = [...new Set(mainHrefs), ...shopHrefs];
    expect(new Set(all).size).toBe(all.length);
  });

  test("promo strip is text only (no links/forms); hostile coupon text is text; bad code drops the coupon", () => {
    const { container } = render(
      <SiteHeader {...v2Props({ promo: { message: HOSTILE, coupon: { code: "SAVE5", description: HOSTILE } } })} />,
    );
    const strip = screen.getByTestId("promo-strip");
    expect(strip.querySelectorAll("a, form, button, input")).toHaveLength(0);
    expect(strip.textContent).toContain(HOSTILE);
    expect(container.querySelector("script")).toBeNull();
    for (const el of container.querySelectorAll("*")) expect(el.hasAttribute("onerror")).toBe(false);
    for (const code of ["lower", "HAS SPACE", "<B>", "X".repeat(33), ""]) {
      expect(couponPromoParts({ code, description: "10% off" })).toBeNull();
    }
    expect(couponPromoParts({ code: "SHIPFREE", description: "Free shipping on orders of $20.00 or more" })?.tail).toBe(
      " for free shipping on orders of $20.00 or more",
    );
  });

  test("v2 header sticks only from lg (T177/U02: row 1 only; the header box is lg:contents)", () => {
    const doc = parse(renderToStaticMarkup(<SiteHeader {...v2Props()} />));
    const header = doc.querySelector("header");
    const cls = header?.classList;
    expect(cls?.contains("lg:contents")).toBe(true);
    expect(cls?.contains("sticky")).toBe(false);
    const row = header?.firstElementChild?.classList;
    expect(row?.contains("lg:sticky")).toBe(true);
    expect(row?.contains("sticky")).toBe(false);
  });

  test("every href passes isAllowedInternalHref and maps to a real src/app page (criterion 4)", () => {
    for (const account of [
      { status: "guest" } as const,
      { status: "signed-in", displayName: "Ada", signOutAction: signOut } as const,
    ]) {
      const doc = parse(renderToStaticMarkup(<SiteHeader {...v2Props({ account })} />));
      const hrefs = [...doc.querySelectorAll("[href]")].map((a) => a.getAttribute("href") ?? "");
      expect(hrefs.length).toBeGreaterThan(5);
      for (const href of hrefs) {
        if (href === "#main") continue;
        expect({ href, allowed: isAllowedInternalHref(href), exists: routeExists(href) }).toEqual({ href, allowed: true, exists: true });
      }
    }
    for (const link of [...PRIMARY_NAV, ...ACCOUNT_NAV, ...AUTH_NAV, ...HEADER_UTILITY_LINKS]) {
      expect({ href: link.href, exists: routeExists(link.href) }).toEqual({ href: link.href, exists: true });
    }
  });

  test("no inline handlers, no inline style, no arbitrary/palette classes in v2 markup", () => {
    const html = renderToStaticMarkup(<SiteHeader {...v2Props()} />);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle="/);
    const classes = [...parse(html).querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(classes.filter((c) => /(^|:)(bg|text|border|ring)-(gray|slate|red|blue|green|yellow|white|black)(-\d+)?$/.test(c))).toEqual([]);
  });

  test("ids in the v2 header markup are unique", () => {
    const doc = parse(renderToStaticMarkup(<SiteHeader {...v2Props()} />));
    const ids = [...doc.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// --------------------------------------------------------------------------------------------
describe("T80 criterion 3/7: AccountMenu", () => {
  test("guest: 'Hello, Sign in' -> /signin; AUTH_NAV links; no Sign out form; details closed in SSR", () => {
    const html = renderToStaticMarkup(<SiteHeader {...v2Props({ account: { status: "guest" } })} />);
    const doc = parse(html);
    const menu = doc.querySelector('[data-testid="account-menu"]');
    expect(menu?.tagName).toBe("DETAILS");
    expect(menu?.hasAttribute("open")).toBe(false);
    expect([...(menu?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual(AUTH_NAV.map((l) => l.href));
    expect(menu?.querySelector("form")).toBeNull();
    const main = doc.querySelector('[data-testid="header-actions"]'); // T163 pin move (T148)
    expect(main?.querySelector("a")?.getAttribute("href")).toBe("/signin");
    expect(main?.querySelector("a")?.textContent).toContain("Hello, Sign in");
  });

  test("signed in: link -> /account; ACCOUNT_NAV links; Sign out is a POST multipart form (no JS)", () => {
    const doc = parse(renderToStaticMarkup(<SiteHeader {...v2Props()} />));
    const menu = doc.querySelector('[data-testid="account-menu"]');
    expect(menu?.hasAttribute("open")).toBe(false);
    expect([...(menu?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"))).toEqual(ACCOUNT_NAV.map((l) => l.href));
    const forms = menu?.querySelectorAll("form") ?? [];
    expect(forms).toHaveLength(1);
    expect(forms[0]?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(forms[0]?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(forms[0]?.querySelector("button[type=submit]")?.textContent).toBe("Sign out");
    expect(doc.querySelector('[data-testid="header-actions"] a')?.getAttribute("href")).toBe("/account"); // T163 pin move (T148)
  });

  test("display name: truncated to 20 code points + '…' visibly, full name in the accessible name", () => {
    const name = "Bartholomew Montgomery-Smythe";
    render(<SiteHeader {...v2Props({ account: { status: "signed-in", displayName: name, signOutAction: signOut } })} />);
    const link = screen.getByRole("link", { name: `Hello, ${name}, Account & Lists` });
    expect(link.getAttribute("href")).toBe("/account");
    expect(link.textContent).toContain(`Hello, ${Array.from(name).slice(0, 20).join("").trimEnd()}…`);
  });

  test("truncation counts code points (emoji never split); 20 exactly is not truncated", () => {
    const emoji = "😀".repeat(25);
    const out = truncateDisplayName(emoji);
    expect(Array.from(out)).toHaveLength(21);
    expect(out.endsWith("…")).toBe(true);
    expect(/[\uD800-\uDBFF]…$/.test(out)).toBe(false);
    expect(truncateDisplayName("a".repeat(20))).toBe("a".repeat(20));
  });

  test("C0 control characters are stripped from the display name", () => {
    expect(cleanDisplayName("Ada\u0000\u0007\u001b[31mLove\u007flace")).toBe("Ada [31mLove lace");
    expect(cleanDisplayName("\t\n Ada \r\n")).toBe("Ada");
    expect(cleanDisplayName(42)).toBe("");
  });

  test("D-T80-1 (fixed): C1 controls (U+0080-U+009F) and bidi overrides never survive cleanDisplayName", () => {
    // header-model.ts cleanDisplayName strips [\p{Cc}\p{Cf}\s]; \p{Cc} covers U+0080-U+009F, \p{Cf} the bidi controls.
    expect(cleanDisplayName("Ada\u0085\u009bLovelace")).not.toMatch(/[\u0080-\u009f]/);
    expect(cleanDisplayName("Ada‮ecalevoL")).not.toMatch(/‮/);
  });

  test("hostile display name renders as text in the link and the department drawer", () => {
    const { container } = render(
      <SiteHeader {...v2Props({ account: { status: "signed-in", displayName: HOSTILE, signOutAction: signOut } })} />,
    );
    expect(container.querySelector("script")).toBeNull();
    for (const el of container.querySelectorAll("*")) expect(el.hasAttribute("onerror")).toBe(false);
    for (const img of container.querySelectorAll("img")) expect(img.getAttribute("src")).not.toBe("x");
    expect(screen.getByRole("link", { name: `Hello, ${cleanDisplayName(HOSTILE)}, Account & Lists` })).toBeInTheDocument();
    // name never lands in an attribute
    for (const el of container.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) expect(el.getAttribute(attr) ?? "").not.toContain("onerror=");
    }
  });

  test("blank display name greets 'there' (signed in) and still links to /account", () => {
    render(<SiteHeader {...v2Props({ account: { status: "signed-in", displayName: " \u0000 ", signOutAction: signOut } })} />);
    expect(screen.getByRole("link", { name: "Hello, there, Account & Lists" }).getAttribute("href")).toBe("/account");
  });

  function openMenu(container: HTMLElement): HTMLDetailsElement {
    const details = container.querySelector('[data-testid="account-menu"]') as HTMLDetailsElement;
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
    });
    expect(details.open).toBe(true);
    return details;
  }

  test("keyboard: summary is focusable and named 'Account menu'; Escape closes and returns focus to the summary", () => {
    const { container } = render(<SiteHeader {...v2Props()} />);
    const details = openMenu(container);
    const summary = details.querySelector("summary") as HTMLElement;
    expect(summary.textContent).toContain("Account menu");
    const firstLink = within(details).getAllByRole("link")[0] as HTMLElement;
    firstLink.focus();
    act(() => {
      fireEvent.keyDown(firstLink, { key: "Escape" });
    });
    expect(details.open).toBe(false);
    expectFocused(summary);
  });

  test("outside pointer press closes; inside press keeps it open; link click closes", () => {
    const { container } = render(
      <>
        <SiteHeader {...v2Props()} />
        <button type="button">Elsewhere</button>
      </>,
    );
    const details = openMenu(container);
    act(() => {
      fireEvent.pointerDown(within(details).getAllByRole("link")[1] as HTMLElement);
    });
    expect(details.open).toBe(true);
    act(() => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    });
    expect(details.open).toBe(false);
    openMenu(container);
    const link = within(details).getAllByRole("link")[0] as HTMLElement;
    link.addEventListener("click", (e) => e.preventDefault(), { once: true });
    act(() => {
      fireEvent.click(link);
    });
    expect(details.open).toBe(false);
  });

  test("account menu summary and Sign out button meet the touch-target classes", () => {
    const { container } = render(<SiteHeader {...v2Props()} />);
    const summary = container.querySelector('[data-testid="account-menu"] summary');
    expect(`${summary?.className} ${summary?.parentElement?.className}`).toMatch(/touch/);
    const signOutButton = within(container.querySelector('[data-testid="account-menu"]') as HTMLElement).getByRole("button", {
      name: "Sign out",
      hidden: true,
    });
    expect(signOutButton.className).toContain("min-h-touch");
  });
});

// --------------------------------------------------------------------------------------------
describe("T80 loadHeaderData(deps)", () => {
  const USER_ID = "3f2c1a9e-7b6d-4c5e-8a1f-0d9e8c7b6a51";
  const OWNER_KEY = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

  function deps(over: Partial<HeaderDataDeps> = {}) {
    const calls: string[] = [];
    const errors: unknown[][] = [];
    const d: HeaderDataDeps = {
      readSessionId: async () => {
        calls.push("session");
        return SESSION;
      },
      readCurrentUser: async () => {
        calls.push("user");
        return null;
      },
      getCartTotals: () => {
        calls.push("cart");
        return { itemCount: 2 };
      },
      categoryTree: () => {
        calls.push("categories");
        return DEPTS;
      },
      listPromoted: () => {
        calls.push("coupons");
        return [{ code: "WELCOME10", description: "10% off" }];
      },
      logger: { error: (...args: unknown[]) => void errors.push(args) },
      ...over,
    };
    return { d, calls, errors };
  }

  test("session and user are read first, in parallel (both started before either resolves)", async () => {
    const started: string[] = [];
    let releaseSession: (v: string | null) => void = () => undefined;
    let releaseUser: (v: null) => void = () => undefined;
    const { d, calls } = deps({
      readSessionId: () => {
        started.push("session");
        return new Promise((r) => (releaseSession = r));
      },
      readCurrentUser: () => {
        started.push("user");
        return new Promise((r) => (releaseUser = r));
      },
    });
    const pending = loadHeaderData(d);
    await Promise.resolve();
    expect(started.sort()).toEqual(["session", "user"]);
    expect(calls).toEqual([]); // no DB reader before the request-scoped reads settle
    releaseSession(SESSION);
    releaseUser(null);
    const data = await pending;
    expect(calls).toEqual(["cart", "categories", "coupons"]);
    expect(data.cartCount).toBe(2);
  });

  test("no session -> cart never read, count 0", async () => {
    const { d, calls } = deps({ readSessionId: async () => null });
    const data = await loadHeaderData(d);
    expect(calls).not.toContain("cart");
    expect(data.cartCount).toBe(0);
  });

  test("returns only displayName for the user (no id/email/owner key) — object and rendered markup", async () => {
    const { d } = deps({
      readCurrentUser: async () =>
        ({ id: USER_ID, email: "ada@example.com", displayName: "Ada", ownerKey: OWNER_KEY }) as unknown as { displayName: string },
    });
    const data = await loadHeaderData(d);
    expect(Object.keys(data.user ?? {})).toEqual(["displayName"]);
    const json = JSON.stringify(data);
    expect(json).not.toMatch(UUID_RE);
    expect(json).not.toContain("ada@example.com");
    // T163 pin move (T148): `freeShippingThresholdCents` (a number or null, never user data) joined the keys.
    expect(Object.keys(data).sort()).toEqual([
      "cartCount",
      "departments",
      "freeShippingThresholdCents",
      "popularSearches",
      "promoCoupon",
      "user",
    ]);
    const html = renderToStaticMarkup(
      <SiteHeader
        cartCount={data.cartCount}
        departments={data.departments}
        account={{ status: "signed-in", displayName: data.user?.displayName ?? "", signOutAction: signOut }}
        promo={{ coupon: data.promoCoupon }}
      />,
    );
    expect(html).not.toMatch(UUID_RE);
    expect(html).not.toContain("ada@example.com");
  });

  for (const reader of ["getCartTotals", "categoryTree", "listPromoted"] as const) {
    test(`${reader} throwing -> fallback, logged once across two requests, others unaffected`, async () => {
      const { d, errors } = deps({
        [reader]: () => {
          throw new Error("SQLITE_ERROR: no such table");
        },
      });
      const first = await loadHeaderData(d);
      const second = await loadHeaderData(d);
      expect(errors).toHaveLength(1);
      for (const data of [first, second]) {
        if (reader === "getCartTotals") expect(data.cartCount).toBe(0);
        else expect(data.cartCount).toBe(2);
        if (reader === "categoryTree") expect(data.departments).toEqual([]);
        else expect(data.departments).toHaveLength(2);
        if (reader === "listPromoted") expect(data.promoCoupon).toBeNull();
        else expect(data.promoCoupon?.code).toBe("WELCOME10");
      }
    });

    test(`${reader} throwing a NEXT_REDIRECT-digest error -> rethrown, not logged`, async () => {
      const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/signin;307;" });
      const { d, errors } = deps({
        [reader]: () => {
          throw redirect;
        },
      });
      await expect(loadHeaderData(d)).rejects.toBe(redirect);
      expect(errors).toHaveLength(0);
    });
  }

  test("source: header-data/HeaderShell never write cookies or mint sessions (SR10)", () => {
    for (const f of ["src/app/_layout/header-data.ts", "src/app/_layout/HeaderShell.tsx"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src).not.toMatch(/getOrCreateSessionId|\.set\(|cookies\(\)|next\/headers|requireUser/);
    }
  });
});

// --------------------------------------------------------------------------------------------
describe("T80 HeaderShell integration (real services, fake cookie jar)", () => {
  test("signed-in render: display name only — no UUIDs, email, token in markup; no cookie writes", async () => {
    const issued = await getAuthService().signUp(
      { email: "qa.header@example.com", password: "correct horse battery staple", displayName: "Grace & Co" },
      { sessionKey: SESSION },
    );
    if (!issued.ok) throw new Error(`signUp failed: ${issued.error.code}`);
    fakeStore.jar.set(AUTH_COOKIE_NAME, issued.value.token);
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const html = renderToStaticMarkup(await HeaderShell());
    const withoutSkip = html;
    expect(withoutSkip).not.toMatch(UUID_RE);
    expect(html).not.toContain("qa.header@example.com");
    expect(html).not.toContain(issued.value.token);
    // Only React's own form-replay bootstrap may appear (emitted because a plain function stands in
    // for the server reference under bun); no user-derived script.
    const scripts = [...parse(html).querySelectorAll("script")].map((s) => s.textContent ?? "");
    for (const s of scripts) expect(s).toContain("$$reactFormReplay");
    expect(fakeStore.writes).toEqual([]);
    expect(parse(html).querySelector('[data-testid="header-actions"] a')?.getAttribute("href")).toBe("/account"); // T163 pin move (T148)
    expect(html).toContain("Hello, Grace &amp; Co");
  });

  test("guest with a cart session: count rendered, session id never in markup, no cookie writes", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    expect(getCartService().addItem(SESSION, "prod_canvas-tote-bag", 2).ok).toBe(true);
    const html = renderToStaticMarkup(await HeaderShell());
    expect(html).toContain("Cart, 2 items");
    expect(html).not.toContain(SESSION);
    expect(fakeStore.writes).toEqual([]);
    expect(parse(html).querySelector('[data-testid="header-actions"] a')?.getAttribute("href")).toBe("/signin"); // T163 pin move (T148)
  });

  test("garbage session cookie: no throw, 0 items, no cookie writes", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, "not-a-uuid'; DROP TABLE carts;--");
    fakeStore.jar.set(AUTH_COOKIE_NAME, "x".repeat(5000));
    const html = renderToStaticMarkup(await HeaderShell());
    expect(html).toContain("Cart, 0 items");
    expect(fakeStore.writes).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------
describe("T80 header sign-out wrapper", () => {
  test("header-actions.ts is 'use server' and exports only async functions; auth is imported lazily", () => {
    const actions = readFileSync(join(ROOT, "src/app/_layout/header-actions.ts"), "utf8");
    expect(actions.trimStart().startsWith('"use server"')).toBe(true);
    expect(actions).not.toMatch(/export (const|let|class|default|type|interface)/);
    const core = readFileSync(join(ROOT, "src/app/_layout/header-sign-out-core.ts"), "utf8");
    expect(core).not.toMatch(/^import .*@\/app\/actions\/auth/m);
    expect(core).toMatch(/import\("@\/app\/actions\/auth"\)/);
  });

  test("runHeaderSignOut loads signOut at call time, passes the form data, propagates the redirect", async () => {
    let loads = 0;
    const seen: FormData[] = [];
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/;303;" });
    const load = async () => {
      loads += 1;
      return {
        signOut: async (_prev: unknown, fd: FormData) => {
          seen.push(fd);
          throw redirect;
        },
      };
    };
    const fd = new FormData();
    expect(loads).toBe(0);
    await expect(runHeaderSignOut(fd, load as unknown as Parameters<typeof runHeaderSignOut>[1])).rejects.toBe(redirect);
    expect(loads).toBe(1);
    expect(seen[0]).toBe(fd);
  });

  test("a failing lazy import propagates (never silently 'signed out')", async () => {
    const boom = new Error("module failed");
    await expect(runHeaderSignOut(new FormData(), async () => Promise.reject(boom))).rejects.toBe(boom);
  });
});

// --------------------------------------------------------------------------------------------
describe("T80 layout.tsx (criteria 2, 5, 6)", () => {
  function walk(node: ReactNode, visit: (el: ReactElement<Record<string, unknown>>) => void): void {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit);
      return;
    }
    if (!isValidElement(node)) return;
    const el = node as ReactElement<Record<string, unknown>>;
    visit(el);
    walk(el.props.children as ReactNode, visit);
  }
  const typeName = (el: ReactElement): string =>
    typeof el.type === "string" ? el.type : ((el.type as { name?: string; displayName?: string }).displayName ?? (el.type as { name?: string }).name ?? "?");

  function tree() {
    const RootLayout = layoutModule.default as unknown as (p: { children: ReactNode }) => ReactElement;
    const out = RootLayout({ children: <p>page</p> });
    const nodes: ReactElement<Record<string, unknown>>[] = [];
    walk(out, (el) => nodes.push(el));
    return nodes;
  }

  test("ToastProvider wraps HeaderShell, <main id='main' tabIndex={-1}> and SiteFooter (storeName + columns)", () => {
    const nodes = tree();
    const toast = nodes.find((n) => typeName(n) === "ToastProvider");
    expect(toast).toBeDefined();
    const inside: string[] = [];
    walk(toast?.props.children as ReactNode, (el) => inside.push(typeName(el)));
    expect(inside).toContain("HeaderShell");
    expect(inside).toContain("main");
    expect(inside).toContain("SiteFooter");
    const main = nodes.filter((n) => n.type === "main");
    expect(main).toHaveLength(1);
    expect(main[0]?.props.id).toBe("main");
    expect(main[0]?.props.tabIndex).toBe(-1);
    const footer = nodes.find((n) => typeName(n) === "SiteFooter");
    expect(typeof footer?.props.storeName).toBe("string");
    expect(Array.isArray(footer?.props.columns)).toBe(true);
    expect((footer?.props.columns as unknown[]).length).toBeGreaterThan(0);
  });

  test("JsonLd emitted exactly once with Organization + WebSite (SearchAction)", () => {
    const jsonLd = tree().filter((n) => typeName(n) === "JsonLd");
    expect(jsonLd).toHaveLength(1);
    const data = jsonLd[0]?.props.data as Array<Record<string, unknown>>;
    expect(data.map((d) => d["@type"])).toEqual(["Organization", "WebSite"]);
    expect(JSON.stringify(data[1])).toContain("SearchAction");
  });

  test("no Suspense around the header, no root/route loading.tsx (SR8)", () => {
    const nodes = tree();
    expect(nodes.some((n) => typeName(n) === "Suspense" || String(n.type) === "Symbol(react.suspense)")).toBe(false);
    const src = readFileSync(join(APP, "layout.tsx"), "utf8");
    expect(src).not.toMatch(/<Suspense|import[^;]*\bSuspense\b/);
    const loadings: string[] = [];
    const scan = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) scan(full);
        else if (/^loading\.(t|j)sx?$/.test(e)) loadings.push(relative(ROOT, full));
      }
    };
    scan(APP);
    expect(loadings).toEqual([]);
  });

  test("metadata: title template, description, OG defaults", () => {
    const md = layoutModule.metadata as { title?: { template?: string; default?: string }; description?: string; openGraph?: Record<string, unknown> };
    expect(md.title?.template).toMatch(/^%s \| /);
    expect(typeof md.description).toBe("string");
    expect(md.openGraph?.type).toBe("website");
    expect(md.openGraph?.siteName).toBe(md.title?.default);
  });
});

// --------------------------------------------------------------------------------------------
describe("Cross-cutting: header + grid + address book on one page", () => {
  test("landmarks unique by (role, name); ids unique; one banner", () => {
    const noop = async () => null;
    const { container } = render(
      <>
        <SiteHeader {...v2Props()} />
        <main id="main" tabIndex={-1}>
          <ProductGrid products={[{ id: "p1", slug: "p1", name: "P1", description: "", priceCents: 100, currency: "USD", imageUrl: "", stock: 1 }]} />
          <AddressBook addresses={[]} actions={{ save: noop, delete: noop, setDefault: noop }} headingLevel={2} />
        </main>
      </>,
    );
    const landmarkRoles = ["banner", "navigation", "main", "region", "contentinfo", "search", "complementary"];
    const pairs: string[] = [];
    for (const role of landmarkRoles) {
      for (const el of screen.queryAllByRole(role)) {
        const label = el.getAttribute("aria-label") ?? (el.getAttribute("aria-labelledby") ? document.getElementById(el.getAttribute("aria-labelledby") ?? "")?.textContent : "") ?? "";
        pairs.push(`${role}:${label}`);
      }
    }
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  test("source hygiene for T80 files", () => {
    const files = [
      "src/components/organisms/SiteHeader/SiteHeader.tsx",
      "src/components/organisms/SiteHeader/AccountMenu.tsx",
      "src/components/organisms/SiteHeader/header-model.ts",
      "src/app/_layout/HeaderShell.tsx",
      "src/app/_layout/header-data.ts",
      "src/app/_layout/header-actions.ts",
      "src/app/_layout/header-sign-out-core.ts",
      "src/app/layout.tsx",
    ];
    for (const f of files) {
      expect(existsSync(join(ROOT, f))).toBe(true);
      const src = readFileSync(join(ROOT, f), "utf8");
      expect({ f, bad: /:\s*any\b|as any\b|@ts-ignore|@ts-expect-error|eslint-disable|dangerouslySetInnerHTML|\sstyle=\{/.test(src) }).toEqual({ f, bad: false });
    }
    // Components never import server code at runtime.
    for (const f of files.filter((x) => x.includes("components/"))) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const line of src.split("\n").filter((l) => /from "@\/server\//.test(l))) expect(line).toMatch(/^import type /);
    }
  });
});
