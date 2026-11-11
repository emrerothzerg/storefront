// T150 SiteFooter v3: quick links, five columns (four link navs + "Get the
// app"), payment-marks row, light bottom bar, injectable clock.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { STORE_BADGE_DEFAULT_LABEL } from "@/components/atoms/StoreBadge";
import { TRADEMARK_RE, scanFolders } from "@/components/atoms/StoreBadge/trademark-scan";
import { FOOTER_COLUMNS } from "@/content/navigation";
import { isAllowedInternalHref } from "@/content/routes";
import { SITE_NAME } from "@/lib/seo/site";
import { SiteFooter, footerYear } from "./SiteFooter";
import type { FooterColumn } from "./SiteFooter";
import {
  FOOTER_APP_HEADING,
  FOOTER_PAYMENT_HEADING,
  FOOTER_PAYMENT_LABELS,
  FOOTER_QUICK_LINKS,
  SITE_FOOTER_COLUMNS,
} from "./footer-links";

const NOW = Date.UTC(2029, 0, 1, 12);
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

const restores: Array<{ mockRestore: () => void }> = [];
function spyWarn() {
  const spy = spyOn(console, "warn").mockImplementation(() => {});
  restores.push(spy);
  return spy;
}
afterEach(() => {
  while (restores.length > 0) restores.pop()?.mockRestore();
});

function footer(): HTMLElement {
  return screen.getByRole("contentinfo");
}

function hrefsIn(root: Element): string[] {
  return Array.from(root.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

describe("structure", () => {
  test("order: back to top, quick links, columns grid, payments row, bottom bar", () => {
    render(<SiteFooter now={NOW} />);
    const children = Array.from(footer().children);
    expect(children).toHaveLength(3);
    expect(children[0]?.textContent).toBe("Back to top");
    const body = children[1] as HTMLElement;
    const parts = Array.from(body.children);
    expect(parts.map((el) => el.tagName)).toEqual(["NAV", "DIV", "DIV"]);
    expect(parts[0]).toHaveAttribute("aria-label", "Footer: Quick links");
    expect(parts[1]).toHaveAttribute("data-footer-columns");
    expect(parts[2]).toHaveAttribute("data-footer-payments");
    expect(children[2]).toHaveAttribute("data-footer-bottom-bar");
  });

  test("quick links row: Track order -> /orders, Contact us -> /contact; no catalogue link", () => {
    render(<SiteFooter now={NOW} />);
    const nav = screen.getByRole("navigation", { name: "Footer: Quick links" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Track order", "/orders"],
      ["Contact us", "/contact"],
    ]);
    for (const a of links) {
      expect(a).toHaveClass("min-h-touch");
      expect(a.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    }
    expect(screen.queryByRole("link", { name: /catalog/i })).toBeNull();
  });

  test("five columns: Help, Orders & delivery, About, Legal navs plus the Get the app column", () => {
    const { container } = render(<SiteFooter now={NOW} />);
    const grid = container.querySelector("[data-footer-columns]") as HTMLElement;
    const columns = Array.from(grid.children);
    expect(columns).toHaveLength(5);
    expect(columns.map((c) => c.querySelector("h2")?.textContent)).toEqual([
      "Help",
      "Orders & delivery",
      "About",
      "Legal",
      "Get the app",
    ]);
    expect(columns.slice(0, 4).map((c) => c.tagName)).toEqual(["NAV", "NAV", "NAV", "NAV"]);
    expect(columns[4]?.tagName).toBe("DIV");
    expect(columns[4]?.querySelector("a, button")).toBeNull();
    expect(SITE_FOOTER_COLUMNS.map((c) => c.heading)).toEqual(["Help", "Orders & delivery", "About", "Legal"]);
    expect(FOOTER_APP_HEADING).toBe("Get the app");
  });

  test("every footer heading is an h2 styled small/semibold", () => {
    render(<SiteFooter now={NOW} />);
    const headings = within(footer()).getAllByRole("heading");
    expect(headings.map((h) => h.textContent)).toEqual([
      "Help",
      "Orders & delivery",
      "About",
      "Legal",
      FOOTER_APP_HEADING,
      FOOTER_PAYMENT_HEADING,
    ]);
    for (const h of headings) {
      expect(h.tagName).toBe("H2");
      expect(h).toHaveClass("text-small", "font-semibold");
    }
  });

  test("no social links or icons", () => {
    const { container } = render(<SiteFooter now={NOW} />);
    const text = (footer().textContent ?? "").toLowerCase();
    for (const word of ["social", "follow us", "facebook", "instagram", "tiktok", "youtube", "pinterest"]) {
      expect(text.includes(word)).toBe(false);
    }
    for (const href of hrefsIn(container)) expect(href.startsWith("http")).toBe(false);
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("criterion 1: links resolve, no duplicates or dead links", () => {
  test("every href is an allowlisted route or the #main fragment", () => {
    const { container } = render(<SiteFooter now={NOW} />);
    const hrefs = hrefsIn(container);
    expect(hrefs.length).toBeGreaterThan(20);
    for (const href of hrefs) {
      if (href.startsWith("#")) expect(href).toBe("#main");
      else expect([href, isAllowedInternalHref(href)]).toEqual([href, true]);
    }
  });

  test("no href appears twice anywhere in the footer", () => {
    const { container } = render(<SiteFooter now={NOW} />);
    const hrefs = hrefsIn(container);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("duplicates in given columns are dropped footer-wide (first wins) with a dev warning", () => {
    const warn = spyWarn();
    const columns: FooterColumn[] = [
      { heading: "One", links: [{ label: "Deals", href: "/deals" }, { label: "Deals again", href: "/deals" }] },
      { heading: "Two", links: [{ label: "Deals 3", href: "/deals" }, { label: "Orders", href: "/orders" }] },
    ];
    render(<SiteFooter now={NOW} columns={columns} />);
    expect(within(screen.getByRole("navigation", { name: "Footer: One" })).getAllByRole("link")).toHaveLength(1);
    // "Two" lost both links (/deals seen in One, /orders in the quick links): the column is removed.
    expect(screen.queryByRole("navigation", { name: "Footer: Two" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain("duplicate");
  });
});

describe("criterion 2: 320px and 44px targets", () => {
  test("columns collapse to one column below sm; no fixed widths or arbitrary values", () => {
    const { container } = render(<SiteFooter now={NOW} />);
    const grid = container.querySelector("[data-footer-columns]");
    expect(grid).toHaveClass("grid", "grid-cols-1", "sm:grid-cols-2", "lg:grid-cols-5", "min-w-0");
    const classes = [footer(), ...footer().querySelectorAll("*")].flatMap((el) =>
      (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
    );
    expect(classes.filter((c) => /^grid-cols-(?!1$)/.test(c))).toEqual([]);
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(classes.filter((c) => /^w-(\d{2,}|screen)$/.test(c))).toEqual([]);
    expect(classes.filter((c) => c.includes("!"))).toEqual([]);
  });

  test("placeholder lists and the quick links row wrap", () => {
    const { container } = render(<SiteFooter now={NOW} />);
    for (const ul of container.querySelectorAll("[data-footer-app] ul, [data-footer-payments] ul")) {
      expect(ul).toHaveClass("flex", "flex-wrap", "min-w-0");
    }
    const quick = within(screen.getByRole("navigation", { name: "Footer: Quick links" })).getByRole("list");
    expect(quick).toHaveClass("flex-wrap", "min-w-0");
  });

  test("every link has a 44px minimum target", () => {
    const { container } = render(<SiteFooter now={NOW} />);
    for (const a of container.querySelectorAll("a")) expect(a).toHaveClass("min-h-touch");
  });
});

describe("criterion 3: placeholders non-interactive and out of the tab order", () => {
  const PLACEHOLDER_TEXTS = [STORE_BADGE_DEFAULT_LABEL, ...FOOTER_PAYMENT_LABELS];

  test("texts are present, say coming soon where a service does not exist", () => {
    render(<SiteFooter now={NOW} />);
    expect(STORE_BADGE_DEFAULT_LABEL).toBe("Mobile app coming soon");
    expect(FOOTER_PAYMENT_LABELS).toEqual(["Card", "Gift card", "Pay later: coming soon"]);
    for (const text of PLACEHOLDER_TEXTS) expect(within(footer()).getByText(text)).toBeInTheDocument();
  });

  test("no link/button ancestor up to the footer, no tabindex, no img, nothing focusable", () => {
    const { container } = render(<SiteFooter now={NOW} />);
    const f = footer();
    for (const text of PLACEHOLDER_TEXTS) {
      let el: HTMLElement | null = within(f).getByText(text);
      while (el !== null && el !== f) {
        expect(["A", "BUTTON"].includes(el.tagName)).toBe(false);
        expect(el.getAttribute("tabindex")).toBeNull();
        el = el.parentElement;
      }
    }
    for (const sel of ["[data-footer-app]", "[data-footer-payments]"]) {
      const region = container.querySelector(sel) as HTMLElement;
      expect(region.querySelector(FOCUSABLE)).toBeNull();
      expect(region.querySelector("img")).toBeNull();
    }
  });

  test("payments row lists exactly the three generic marks, in order", () => {
    const { container } = render(<SiteFooter now={NOW} />);
    const items = Array.from(container.querySelectorAll("[data-footer-payments] li")).map((li) => li.textContent);
    expect(items).toEqual(["Card", "Gift card", "Pay later: coming soon"]);
  });

  test("no store or payment trademark in the rendered footer or the SiteFooter sources", () => {
    const html = renderToStaticMarkup(<SiteFooter now={NOW} />);
    expect(TRADEMARK_RE.test(html)).toBe(false);
    const scan = scanFolders([join(import.meta.dir)]);
    expect(scan.files).toBeGreaterThanOrEqual(4);
    expect(scan.hits).toEqual([]);
  });
});

describe("criterion 4: light bottom bar and clock", () => {
  test("bottom bar is a light surface with the wordmark and copyright; nothing inverse anywhere", () => {
    const { container } = render(<SiteFooter now={NOW} />);
    const bar = container.querySelector("[data-footer-bottom-bar]") as HTMLElement;
    expect(bar).toHaveClass("bg-surface-sunken");
    const wordmark = bar.querySelector("[data-footer-wordmark]");
    expect(wordmark?.textContent).toBe(SITE_NAME);
    expect(wordmark).toHaveClass("text-accent", "font-bold");
    expect(wordmark?.closest("a")).toBeNull();
    expect(within(bar).getByText(`© 2029 ${SITE_NAME}. All rights reserved.`)).toHaveClass("text-text-primary");
    expect(footer().outerHTML).not.toMatch(/inverse/);
  });

  test("year comes from the injected clock (number or Date), in UTC", () => {
    const { unmount } = render(<SiteFooter now={Date.UTC(2041, 11, 31, 23, 59)} />);
    expect(within(footer()).getByText(`© 2041 ${SITE_NAME}. All rights reserved.`)).toBeInTheDocument();
    unmount();
    render(<SiteFooter now={new Date(Date.UTC(2035, 0, 1, 0, 0))} storeName="Acme" />);
    expect(within(footer()).getByText("© 2035 Acme. All rights reserved.")).toBeInTheDocument();
  });

  test("default clock: Date.now() is read exactly once per render", () => {
    const spy = spyOn(Date, "now").mockImplementation(() => Date.UTC(2033, 4, 4));
    restores.push(spy);
    const html = renderToStaticMarkup(<SiteFooter />);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(html).toContain(`© 2033 ${SITE_NAME}. All rights reserved.`);
  });

  test("footerYear: explicit year wins; invalid clock values fall back to Date.now()", () => {
    expect(footerYear(Date.UTC(2030, 0, 1), 1999)).toBe(1999);
    expect(footerYear(Date.UTC(2030, 0, 1))).toBe(2030);
    const spy = spyOn(Date, "now").mockImplementation(() => Date.UTC(2044, 1, 1));
    restores.push(spy);
    expect(footerYear(Number.NaN)).toBe(2044);
    expect(footerYear(new Date("not a date"))).toBe(2044);
    expect(footerYear(undefined, 20.5)).toBe(2044);
  });
});

describe("layout wiring", () => {
  test("the layout's props (SITE_NAME + content FOOTER_COLUMNS) render the v3 footer without warnings", () => {
    const warn = spyWarn();
    expect(SITE_FOOTER_COLUMNS).toBe(FOOTER_COLUMNS);
    const { container } = render(<SiteFooter storeName={SITE_NAME} columns={FOOTER_COLUMNS} now={NOW} />);
    expect(screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"))).toEqual([
      "Footer: Quick links",
      "Footer: Help",
      "Footer: Orders & delivery",
      "Footer: About",
      "Footer: Legal",
    ]);
    expect(container.querySelector("[data-footer-columns]")?.children).toHaveLength(5);
    const rendered = hrefsIn(container).filter((h) => !h.startsWith("#"));
    const expected = [...FOOTER_QUICK_LINKS, ...FOOTER_COLUMNS.flatMap((c) => c.links)].map((l) => l.href);
    expect(rendered).toEqual(expected);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("criterion 5: unique nav names", () => {
  test("default footer: every nav is named 'Footer: <heading>' and names are unique", () => {
    render(<SiteFooter now={NOW} />);
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(names).toEqual([
      "Footer: Quick links",
      "Footer: Help",
      "Footer: Orders & delivery",
      "Footer: About",
      "Footer: Legal",
    ]);
  });

  test("repeated headings (and a heading named Quick links) still get unique names", () => {
    const columns: FooterColumn[] = [
      { heading: "Shop", links: [{ label: "Deals", href: "/deals" }] },
      { heading: "Shop", links: [{ label: "Brands", href: "/brands" }] },
      { heading: "Quick links", links: [{ label: "FAQ", href: "/faq" }] },
      { heading: "Legal", links: [{ label: "Privacy", href: "/privacy" }] },
    ];
    render(<SiteFooter now={NOW} columns={columns} />);
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(names).toEqual([
      "Footer: Quick links",
      "Footer: Shop",
      "Footer: Shop 2",
      "Footer: Quick links 2",
      "Footer: Legal",
      "Footer: Legal 2",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("server component, no JS", () => {
  test("static markup: one footer, no script, no inline handlers", () => {
    const html = renderToStaticMarkup(<SiteFooter now={NOW} />);
    expect(html.match(/<footer/g)).toHaveLength(1);
    expect(html).not.toContain("<script");
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
  });

  test("no client directive, any, or ts-ignore in the sources", async () => {
    for (const file of ["SiteFooter.tsx", "footer-links.ts"]) {
      const src = await Bun.file(join(import.meta.dir, file)).text();
      expect(src).not.toMatch(/^\s*["']use client["']/m);
      expect(/:\s*any\b|as any\b|<any>|@ts-ignore|@ts-expect-error/.test(src)).toBe(false);
    }
  });

  test("the first focusable element in the footer is the back-to-top link", () => {
    render(<SiteFooter now={NOW} />);
    expect(footer().querySelector(FOCUSABLE)?.textContent).toBe("Back to top");
    expect(FOOTER_QUICK_LINKS.map((l) => l.href)).toEqual(["/orders", "/contact"]);
  });
});
