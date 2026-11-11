import { describe, expect, test } from "bun:test";
import { SEED_DEPARTMENTS } from "@/server/db/seed-data/taxonomy";
import {
  ACCOUNT_NAV,
  AUTH_NAV,
  DEPARTMENT_NAV,
  FOOTER_COLUMNS,
  FOOTER_QUICK_LINKS,
  LEGAL_LINKS,
  PRIMARY_NAV,
  type NavLink,
} from "./navigation";
import { PLANNED_ROUTES, isAllowedInternalHref } from "./routes";

const allLinks: readonly NavLink[] = [
  ...PRIMARY_NAV,
  ...ACCOUNT_NAV,
  ...AUTH_NAV,
  ...FOOTER_QUICK_LINKS,
  ...FOOTER_COLUMNS.flatMap((column) => column.links),
];

const footerLinks: readonly NavLink[] = [...FOOTER_QUICK_LINKS, ...FOOTER_COLUMNS.flatMap((column) => column.links)];

/** True when the href's path matches a planned route pattern (`[x]` = one segment). */
function routeExists(href: string): boolean {
  const cut = href.search(/[?#]/);
  const path = cut === -1 ? href : href.slice(0, cut);
  return PLANNED_ROUTES.some((route) => new RegExp(`^${route.replace(/\[[^\]]+\]/g, "[^/]+")}$`).test(path));
}

describe("navigation maps", () => {
  test("primary nav has the agreed items in order", () => {
    expect(PRIMARY_NAV.map((link) => link.label)).toEqual([
      "Deals",
      "Best Sellers",
      "New Arrivals",
      "Lists",
      "Orders",
      "Help",
    ]);
  });

  test("footer has the four v3 link columns (T150); the footer adds Get the app", () => {
    expect(FOOTER_COLUMNS.map((column) => column.heading)).toEqual(["Help", "Orders & delivery", "About", "Legal"]);
    for (const column of FOOTER_COLUMNS) expect(column.links.length).toBeGreaterThan(0);
    expect(FOOTER_COLUMNS.at(-1)?.links).toBe(LEGAL_LINKS);
  });

  test("footer quick links: Track order and Contact us, no catalogue link", () => {
    expect(FOOTER_QUICK_LINKS).toEqual([
      { label: "Track order", href: "/orders" },
      { label: "Contact us", href: "/contact" },
    ]);
    for (const link of footerLinks) expect(/catalog/i.test(link.label), link.label).toBe(false);
  });

  test("every footer href is allow-listed and its route exists", () => {
    for (const link of footerLinks) {
      expect(isAllowedInternalHref(link.href), link.href).toBe(true);
      expect(routeExists(link.href), link.href).toBe(true);
    }
  });

  test("no duplicate hrefs across footer quick links and columns", () => {
    const hrefs = footerLinks.map((link) => link.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("every href is an allowed internal route and every label is non-empty", () => {
    for (const link of allLinks) {
      expect(isAllowedInternalHref(link.href), link.href).toBe(true);
      expect(link.label.trim().length).toBeGreaterThan(0);
    }
  });

  test("no duplicate hrefs within one menu", () => {
    const menus: readonly (readonly NavLink[])[] = [PRIMARY_NAV, ACCOUNT_NAV, AUTH_NAV, ...FOOTER_COLUMNS.map((c) => c.links)];
    for (const menu of menus) {
      const hrefs = menu.map((link) => link.href);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
  });

  test("auth links: header sign in / create account, settings in account nav and footer", () => {
    expect(AUTH_NAV).toEqual([
      { label: "Sign in", href: "/signin" },
      { label: "Create account", href: "/signup" },
    ]);
    expect(ACCOUNT_NAV).toContainEqual({ label: "Settings", href: "/account/settings" });
    const helpColumn = FOOTER_COLUMNS.find((column) => column.heading === "Help");
    const hrefs = helpColumn?.links.map((link) => link.href) ?? [];
    expect(hrefs).toContain("/signin");
    expect(hrefs).toContain("/account/settings");
  });

  test("footer (quick links + columns) links every policy page and the help pages", () => {
    const hrefs = new Set(footerLinks.map((link) => link.href));
    for (const href of ["/about", "/shipping", "/returns", "/privacy", "/terms", "/accessibility", "/help", "/faq", "/contact"]) {
      expect(hrefs.has(href), href).toBe(true);
    }
  });
});

describe("DEPARTMENT_NAV (CONS-B1 item ax)", () => {
  test("matches the taxonomy seed departments: same slugs, names and order", () => {
    expect(DEPARTMENT_NAV.map((d) => ({ slug: d.slug, label: d.label }))).toEqual(
      SEED_DEPARTMENTS.map((d) => ({ slug: d.slug, label: d.name })),
    );
  });

  test("every department page href is allowed and slugs are unique", () => {
    expect(new Set(DEPARTMENT_NAV.map((d) => d.slug)).size).toBe(DEPARTMENT_NAV.length);
    for (const d of DEPARTMENT_NAV) {
      expect(d.slug).toMatch(/^[a-z0-9-]+$/);
      expect(d.label).toBe(d.label.trim());
      expect(isAllowedInternalHref(`/category/${d.slug}`)).toBe(true);
    }
  });
});
