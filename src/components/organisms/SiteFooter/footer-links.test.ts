import { describe, expect, test } from "bun:test";
import { PLANNED_ROUTES, isAllowedInternalHref } from "@/content/routes";
import {
  FOOTER_PAYMENT_LABELS,
  FOOTER_QUICK_LINKS,
  LEGAL_HEADING,
  LEGAL_LINKS,
  SITE_FOOTER_COLUMNS,
} from "./footer-links";

const ALL = [...FOOTER_QUICK_LINKS, ...SITE_FOOTER_COLUMNS.flatMap((c) => c.links)];

/** Turns a planned route pattern into a regex for one concrete href. */
function routeMatches(href: string): boolean {
  return PLANNED_ROUTES.some((route) => new RegExp(`^${route.replace(/\[[^\]]+\]/g, "[^/]+")}$`).test(href));
}

describe("footer link data", () => {
  test("every href passes isAllowedInternalHref and maps to a planned route", () => {
    expect(ALL.length).toBeGreaterThan(20);
    for (const link of ALL) {
      expect([link.href, isAllowedInternalHref(link.href)]).toEqual([link.href, true]);
      expect([link.href, routeMatches(link.href)]).toEqual([link.href, true]);
    }
  });

  test("no duplicate hrefs or labels across quick links and columns", () => {
    const hrefs = ALL.map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const column of SITE_FOOTER_COLUMNS) {
      const labels = column.links.map((l) => l.label);
      expect(new Set(labels).size).toBe(labels.length);
      expect(column.links.length).toBeGreaterThan(0);
    }
  });

  test("columns, quick links and legal links", () => {
    expect(SITE_FOOTER_COLUMNS.map((c) => c.heading)).toEqual(["Help", "Orders & delivery", "About", LEGAL_HEADING]);
    expect(FOOTER_QUICK_LINKS).toEqual([
      { label: "Track order", href: "/orders" },
      { label: "Contact us", href: "/contact" },
    ]);
    expect(SITE_FOOTER_COLUMNS.at(-1)?.links).toBe(LEGAL_LINKS);
    expect(LEGAL_LINKS.map((l) => l.href)).toEqual(["/privacy", "/terms", "/accessibility"]);
  });

  test("no catalogue link and no off-site link", () => {
    for (const link of ALL) {
      expect(/catalog/i.test(link.label)).toBe(false);
      expect(link.href.startsWith("/")).toBe(true);
      expect(link.href.startsWith("//")).toBe(false);
    }
  });

  test("payment labels are generic, non-empty and mark pay later as coming soon", () => {
    expect(FOOTER_PAYMENT_LABELS).toEqual(["Card", "Gift card", "Pay later: coming soon"]);
    for (const label of FOOTER_PAYMENT_LABELS) expect(label.trim()).toBe(label);
  });
});
