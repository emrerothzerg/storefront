import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Category } from "@/lib/types";
import { DEPARTMENT_MENU_FALLBACK_HREF, DEPARTMENT_MENU_NAV_LABEL, DepartmentMenu, buildMenuModel, categoryHref } from "./index";
import type { DepartmentInput } from "./index";
import { expectFocused } from "@/test/dom-assertions";

function cat(id: string, slug: string, name: string, parentId: string | null, sortOrder = 0): Category {
  return { id, slug, name, description: "", parentId, sortOrder, imageUrl: null };
}

const grandchild = cat("g1", "deep", "Too deep", "c1");

const departments: DepartmentInput[] = [
  {
    ...cat("d2", "home-kitchen", "Home & Kitchen", null, 2),
    children: [cat("c3", "cookware", "Cookware", "d2", 1)],
  },
  {
    ...cat("d1", "electronics", "Electronics", null, 1),
    children: [
      // A grandchild smuggled in at runtime must not create a third level.
      Object.assign(cat("c1", "laptops", "Laptops", "d1", 1), { children: [grandchild] }),
      cat("c2", "audio", "Audio", "d1", 2),
    ],
  },
];

const getDialog = () => document.querySelector("dialog") as HTMLDialogElement;
const trigger = () => screen.getByRole("button", { name: "Open menu, All" });

// happy-dom does not turn Escape into `cancel`; dispatch it like the Drawer tests do.
function pressEscape(dialog: HTMLDialogElement) {
  act(() => {
    dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
}

afterEach(() => {
  document.body.style.overflow = "";
});

describe("buildMenuModel", () => {
  test("sorts, keeps two levels and validates every href", () => {
    const model = buildMenuModel({
      departments,
      primaryNav: [
        { label: "Deals", href: "/deals" },
        { label: "Evil", href: "javascript:alert(1)" },
        { label: "Proto", href: "//evil.example" },
        { label: "Nowhere", href: "/not-a-route" },
      ],
      accountNav: [{ label: "Sign in", href: "/signin" }, { label: "Ext", href: "https://evil.example" }],
    });
    expect(model.departments.map((d) => d.name)).toEqual(["Electronics", "Home & Kitchen"]);
    expect(model.departments[0]?.allHref).toBe("/category/electronics");
    expect(model.departments[0]?.children).toEqual([
      { label: "Laptops", href: "/category/laptops" },
      { label: "Audio", href: "/category/audio" },
    ]);
    expect(model.primary).toEqual([{ label: "Deals", href: "/deals" }]);
    expect(model.account).toEqual([{ label: "Sign in", href: "/signin" }]);
    expect(model.rejected).toEqual(["javascript:alert(1)", "//evil.example", "/not-a-route", "https://evil.example"]);
  });

  test("slugs are encoded so they cannot change the path; bad slugs dropped", () => {
    expect(categoryHref("a/b?c")).toBe("/category/a%2Fb%3Fc");
    const model = buildMenuModel({
      departments: [{ ...cat("d", "..", "Dots", null), children: [cat("c", "a/b", "Slash", "d"), cat("e", "", "Empty", "d")] }],
      primaryNav: [],
      accountNav: [],
    });
    expect(model.departments).toEqual([]);
    expect(model.rejected).toEqual(["/category/..", "/category/a%2Fb"]);
  });
});

describe("DepartmentMenu server markup (no JS)", () => {
  test("trigger is a plain link to the catalog; no dialog, no button", () => {
    const html = renderToStaticMarkup(<DepartmentMenu departments={departments} />);
    expect(html).toMatch(new RegExp(`<a[^>]*href="${DEPARTMENT_MENU_FALLBACK_HREF}"`));
    expect(html).toContain(">All</span>");
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain("<button");
  });
});

describe("DepartmentMenu with JS", () => {
  test("trigger is a native button with visible 'All' text and the menu icon", () => {
    render(<DepartmentMenu departments={departments} />);
    const button = trigger();
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveClass("min-h-touch");
    expect(button.querySelector('[data-icon="menu"]')).not.toBeNull();
    expect(within(button).getByText("All")).toBeInTheDocument();
  });

  test("keyboard: focus trigger, activate opens the drawer, Escape closes, focus returns, scroll lock", () => {
    render(<DepartmentMenu departments={departments} />);
    const button = trigger();
    button.focus();
    expectFocused(button);
    // Enter on a native <button> fires click in browsers.
    fireEvent.click(button);
    const dialog = getDialog();
    expect(dialog.open).toBe(true);
    expect(screen.getByRole("dialog", { name: "Shop by department" })).toBe(dialog);
    expect(document.body.style.overflow).toBe("hidden");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    pressEscape(dialog);
    expect(dialog.open).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expectFocused(button);
  });

  test("drawer lists departments as disclosures with two levels only", () => {
    render(<DepartmentMenu departments={departments} />);
    fireEvent.click(trigger());
    const dialog = getDialog();
    // Phase 3 (T143): the departments list sits in a nav landmark named "Departments" (unique; CategoryNav is "Primary").
    const nav = within(dialog).getByRole("navigation", { name: DEPARTMENT_MENU_NAV_LABEL, hidden: true });
    expect(DEPARTMENT_MENU_NAV_LABEL).toBe("Departments");
    const list = nav.querySelector(":scope > ul") as HTMLUListElement;
    const details = list.querySelectorAll(":scope > li > details");
    expect(details).toHaveLength(2);
    expect(details[0]?.querySelector("summary")?.textContent).toContain("Electronics");
    const links = Array.from(details[0]?.querySelectorAll("a") ?? []).map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([
      ["All Electronics", "/category/electronics"],
      ["Laptops", "/category/laptops"],
      ["Audio", "/category/audio"],
    ]);
    expect(dialog.querySelectorAll("details details")).toHaveLength(0);
    expect(dialog.textContent).not.toContain("Too deep");
  });

  test("primary nav and sign-in links when signed out", () => {
    render(<DepartmentMenu departments={departments} />);
    fireEvent.click(trigger());
    const dialog = getDialog();
    expect(within(dialog).getByRole("link", { name: "Deals" })).toHaveAttribute("href", "/deals");
    expect(within(dialog).getByRole("heading", { name: "Your account" })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/signin");
    expect(within(dialog).queryByRole("link", { name: "Your orders" })).toBeNull();
  });

  test("greets the signed-in user (as text) and shows account links", () => {
    render(<DepartmentMenu departments={departments} signedInName="<b>Ada</b>" />);
    fireEvent.click(trigger());
    const dialog = getDialog();
    const heading = within(dialog).getByRole("heading", { name: "Hello, <b>Ada</b>" });
    expect(heading.querySelector("b")).toBeNull();
    expect(within(dialog).getByRole("link", { name: "Your orders" })).toHaveAttribute("href", "/orders");
    expect(within(dialog).queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  test("long display name: greeting visibly truncated to 20 code points (same helper as the header), full name in the accessible name", () => {
    const name = "Bartholomew Montgomery-Smythe";
    render(<DepartmentMenu departments={departments} signedInName={name} />);
    fireEvent.click(trigger());
    const heading = within(getDialog()).getByRole("heading", { name: `Hello, ${name}` });
    const visible = heading.querySelector('[aria-hidden="true"]');
    expect(visible?.textContent).toBe(`Hello, ${Array.from(name).slice(0, 20).join("").trimEnd()}…`);
  });

  test("display name of exactly 20 code points is not truncated and not duplicated", () => {
    const name = "a".repeat(20);
    render(<DepartmentMenu departments={departments} signedInName={name} />);
    fireEvent.click(trigger());
    const heading = within(getDialog()).getByRole("heading", { name: `Hello, ${name}` });
    expect(heading.textContent).toBe(`Hello, ${name}`);
    expect(heading.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  test("truncation never splits an emoji surrogate pair", () => {
    render(<DepartmentMenu departments={departments} signedInName={"😀".repeat(25)} />);
    fireEvent.click(trigger());
    const visible = getDialog().querySelector('h3 [aria-hidden="true"]')?.textContent ?? "";
    expect(Array.from(visible.replace("Hello, ", ""))).toHaveLength(21);
    expect(/[\uD800-\uDBFF]…$/.test(visible)).toBe(false);
  });

  test("control and bidi characters are cleaned from the greeting", () => {
    render(<DepartmentMenu departments={departments} signedInName={"Ada\u202e\u0085Love"} />);
    fireEvent.click(trigger());
    expect(within(getDialog()).getByRole("heading", { name: "Hello, Ada Love" })).toBeInTheDocument();
  });

  test("a name made only of control characters is treated as signed out", () => {
    render(<DepartmentMenu departments={departments} signedInName={"\u0000\u202e "} />);
    fireEvent.click(trigger());
    expect(within(getDialog()).getByRole("heading", { name: "Your account" })).toBeInTheDocument();
  });

  test("activating a link closes the drawer", () => {
    render(<DepartmentMenu departments={departments} />);
    fireEvent.click(trigger());
    const dialog = getDialog();
    const link = within(dialog).getByRole("link", { name: "Deals" });
    // Prevent happy-dom from following the href; the click handler still runs.
    link.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(link);
    expect(dialog.open).toBe(false);
    expect(document.body.style.overflow).toBe("");
  });

  test("disallowed hrefs are omitted with a development warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
    try {
      render(
        <DepartmentMenu
          departments={departments}
          primaryNav={[
            { label: "Deals", href: "/deals" },
            { label: "Evil", href: "javascript:alert(1)" },
          ]}
        />,
      );
      fireEvent.click(trigger());
      expect(within(getDialog()).queryByRole("link", { name: "Evil" })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("javascript:alert(1)");
    } finally {
      warn.mockRestore();
    }
  });

  test("custom label; no departments falls back to a catalog link inside the drawer", () => {
    render(<DepartmentMenu departments={[]} label="Menu" />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu, Menu" }));
    expect(within(getDialog()).getByRole("link", { name: "All products" })).toHaveAttribute("href", "/products");
  });
});

describe("DepartmentMenu Phase 3 (T143)", () => {
  test("no JS: pill trigger link to /products, 44px, no nav landmark before hydration", () => {
    const html = renderToStaticMarkup(<DepartmentMenu departments={departments} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const a = doc.querySelector("a");
    expect(a?.getAttribute("href")).toBe("/products");
    expect(a?.className).toMatch(/\bmin-h-touch\b/);
    expect(a?.className).toMatch(/\brounded-full\b/);
    expect(doc.querySelector("nav")).toBeNull();
  });

  test("exactly one Departments nav in the open drawer; never named Primary", () => {
    render(<DepartmentMenu departments={departments} />);
    fireEvent.click(trigger());
    const navs = Array.from(getDialog().querySelectorAll("nav"));
    expect(navs.map((n) => n.getAttribute("aria-label"))).toEqual(["Departments"]);
    expect(getDialog().querySelector('nav[aria-label="Primary"]')).toBeNull();
  });

  test("no departments: no Departments nav, the catalog fallback link instead", () => {
    render(<DepartmentMenu departments={[]} />);
    fireEvent.click(trigger());
    expect(getDialog().querySelector("nav")).toBeNull();
    expect(within(getDialog()).getByRole("link", { name: "All products" })).toHaveAttribute("href", "/products");
  });
});
