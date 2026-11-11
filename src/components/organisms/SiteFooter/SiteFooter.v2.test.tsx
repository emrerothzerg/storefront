import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { FOOTER_COLUMNS } from "@/content/navigation";
import { isAllowedInternalHref } from "@/content/routes";
import { SITE_NAME } from "@/lib/seo/site";
import { SiteFooter } from "./SiteFooter";
import { FOOTER_QUICK_LINKS } from "./footer-links";
import type { FooterColumn } from "./SiteFooter";

const warnSpies: Array<{ mockRestore: () => void }> = [];
function spyWarn() {
  const spy = spyOn(console, "warn").mockImplementation(() => {});
  warnSpies.push(spy);
  return spy;
}
afterEach(() => {
  while (warnSpies.length > 0) warnSpies.pop()?.mockRestore();
});

// v3 (T150): back to top, columns-as-named-navs, allowlist and dedupe rules
// carried over from v2; the inverse band and legal paragraph became a light
// footer with a Legal column (see SiteFooter.v3.test.tsx for the new layout).
const NOW = Date.UTC(2026, 3, 15);

function renderV2(extra: Partial<Parameters<typeof SiteFooter>[0]> = {}) {
  return render(<SiteFooter now={NOW} storeName={SITE_NAME} columns={FOOTER_COLUMNS} {...extra} />);
}

/** Hrefs already rendered by the quick-links row; columns drop them as duplicates. */
const QUICK_HREFS = new Set(FOOTER_QUICK_LINKS.map((l) => l.href));

function expectedColumnLinks(column: FooterColumn, seen: Set<string>) {
  return column.links.filter((l) => {
    if (seen.has(l.href)) return false;
    seen.add(l.href);
    return true;
  });
}

describe("SiteFooter v2: back to top (criterion 1)", () => {
  test("is a plain in-page anchor to #main with an arrow-up icon, first in the footer", () => {
    spyWarn();
    renderV2();
    const link = screen.getByRole("link", { name: "Back to top" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "#main");
    expect(link).toHaveClass("min-h-touch", "text-text-secondary", "w-full");
    expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("contentinfo").firstElementChild?.contains(link)).toBe(true);
  });

  test("works without JS: present in static server markup", () => {
    spyWarn();
    const html = renderToStaticMarkup(<SiteFooter now={NOW} columns={FOOTER_COLUMNS} />);
    expect(html).toContain('href="#main"');
    expect(html).toContain("Back to top");
    expect(html).not.toContain("<script");
  });

  test("custom fragment target is honoured; non-fragment falls back to #main with a warning", () => {
    const { unmount } = render(<SiteFooter now={NOW} backToTopHref="#top" />);
    expect(screen.getByRole("link", { name: "Back to top" })).toHaveAttribute("href", "#top");
    unmount();
    const warn = spyWarn();
    render(<SiteFooter now={NOW} backToTopHref="javascript:alert(1)" />);
    expect(screen.getByRole("link", { name: "Back to top" })).toHaveAttribute("href", "#main");
    expect(warn).toHaveBeenCalled();
  });
});

describe("SiteFooter v2: columns, landmarks, allowlist (criterion 2)", () => {
  test("exactly one footer landmark; quick links plus one named nav per column", () => {
    spyWarn();
    const { container } = renderV2();
    expect(container.querySelectorAll("footer")).toHaveLength(1);
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(names).toEqual(["Footer: Quick links", ...FOOTER_COLUMNS.map((c) => `Footer: ${c.heading}`)]);
  });

  test("each column is a heading followed by a list of its links, in content order (quick-link hrefs deduped)", () => {
    spyWarn();
    renderV2();
    const seen = new Set(QUICK_HREFS);
    for (const column of FOOTER_COLUMNS) {
      const nav = screen.getByRole("navigation", { name: `Footer: ${column.heading}` });
      const heading = within(nav).getByRole("heading", { level: 2 });
      expect(heading.textContent).toBe(column.heading);
      expect(heading).toHaveClass("text-small", "font-semibold");
      const list = heading.nextElementSibling;
      expect(list?.tagName).toBe("UL");
      const expected = expectedColumnLinks(column, seen);
      const links = within(list as HTMLElement).getAllByRole("link");
      expect(links.map((l) => l.textContent)).toEqual(expected.map((l) => l.label));
      expect(links.map((l) => l.getAttribute("href"))).toEqual(expected.map((l) => l.href));
    }
  });

  test("columns stack at 320px: 1 col, 2 from sm, 5 from lg", () => {
    spyWarn();
    const { container } = renderV2();
    const grid = container.querySelector("[data-footer-columns]");
    expect(grid).toHaveClass("grid", "grid-cols-1", "sm:grid-cols-2", "lg:grid-cols-5", "min-w-0");
  });

  test("every rendered href (quick links, columns, back to top) is allowlisted", () => {
    spyWarn();
    const { container } = renderV2();
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(20);
    for (const href of hrefs) {
      if (href.startsWith("#")) {
        expect(href).toMatch(/^#[A-Za-z][\w-]*$/);
      } else {
        expect([href, isAllowedInternalHref(href)]).toEqual([href, true]);
      }
    }
    for (const legal of ["/privacy", "/terms", "/accessibility"]) expect(hrefs).toContain(legal);
  });

  test("disallowed hrefs are dropped with a dev warning; emptied columns disappear", () => {
    const warn = spyWarn();
    const columns: FooterColumn[] = [
      {
        heading: "Mixed",
        links: [
          { label: "Deals", href: "/deals" },
          { label: "Evil", href: "javascript:alert(1)" },
          { label: "Offsite", href: "https://evil.example" },
          { label: "Protocol relative", href: "//evil.example" },
          { label: "Nope", href: "/definitely-not-a-route" },
        ],
      },
      { heading: "All bad", links: [{ label: "Bad", href: "/../etc" }] },
    ];
    render(<SiteFooter now={NOW} columns={columns} />);
    const nav = screen.getByRole("navigation", { name: "Footer: Mixed" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Deals"]);
    expect(screen.queryByRole("navigation", { name: "Footer: All bad" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "All bad" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(5);
  });

  test("columns take precedence over links; empty columns leave quick links and a Legal column", () => {
    spyWarn();
    const { unmount } = render(
      <SiteFooter now={NOW} columns={FOOTER_COLUMNS} links={[{ href: "/cart", label: "Flat cart" }]} />,
    );
    expect(screen.queryByRole("link", { name: "Flat cart" })).toBeNull();
    unmount();
    render(<SiteFooter now={NOW} columns={[]} />);
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(names).toEqual(["Footer: Quick links", "Footer: Legal"]);
    expect(screen.getByRole("link", { name: "Privacy notice" })).toHaveAttribute("href", "/privacy");
  });

  test("flat links mode also drops disallowed internal hrefs and non-http external ones", () => {
    const warn = spyWarn();
    render(
      <SiteFooter
        now={NOW}
        links={[
          { href: "/cart", label: "Cart" },
          { href: "/nowhere-at-all", label: "Nowhere" },
          { href: "javascript:alert(1)", label: "Script", external: true },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Footer: Links" });
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Cart"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("SiteFooter v2: legal links and tokens (criterion 3)", () => {
  test("copyright, demo notice and legal links (in the given columns or an appended Legal column)", () => {
    spyWarn();
    const first = renderV2();
    expect(screen.getByText(`© 2026 ${SITE_NAME}. All rights reserved.`).tagName).toBe("P");
    expect(screen.getByText("This is a demo store; policies are sample text.")).toHaveClass("text-text-secondary");
    const hrefs = Array.from(screen.getByRole("contentinfo").querySelectorAll("a")).map((a) => a.getAttribute("href"));
    for (const legal of ["/privacy", "/terms", "/accessibility"]) {
      expect(hrefs.filter((h) => h === legal)).toHaveLength(1);
    }
    first.unmount();
    render(<SiteFooter now={NOW} columns={[{ heading: "Shop", links: [{ label: "Deals", href: "/deals" }] }]} />);
    const legalNav = screen.getByRole("navigation", { name: "Footer: Legal" });
    expect(within(legalNav).getAllByRole("link").map((l) => l.getAttribute("href"))).toEqual([
      "/privacy",
      "/terms",
      "/accessibility",
    ]);
  });

  test("every link uses the default tone with a 44px target and no ! classes", () => {
    spyWarn();
    const { container } = renderV2();
    const footer = screen.getByRole("contentinfo");
    expect(footer).toHaveClass("bg-surface-page", "text-text-primary");
    expect(footer).not.toHaveClass("bg-surface-inverse");
    for (const link of Array.from(container.querySelectorAll("a"))) {
      expect(link).toHaveClass("min-h-touch");
      expect(link).not.toHaveClass("text-text-inverse");
    }
    const allClasses = Array.from(container.querySelectorAll("[class]")).flatMap((el) =>
      (el.getAttribute("class") ?? "").split(/\s+/),
    );
    expect(allClasses.filter((c) => c.includes("!"))).toEqual([]);
  });

  test("renderToStaticMarkup produces one footer with all column headings", () => {
    spyWarn();
    const html = renderToStaticMarkup(<SiteFooter now={NOW} storeName={SITE_NAME} columns={FOOTER_COLUMNS} />);
    expect(html.match(/<footer/g)).toHaveLength(1);
    for (const column of FOOTER_COLUMNS) expect(html).toContain(column.heading.replace(/&/g, "&amp;"));
    expect(html).toContain(`© 2026 ${SITE_NAME}. All rights reserved.`);
  });

  test("source has no 'use client' directive", async () => {
    const src = await Bun.file(new URL("./SiteFooter.tsx", import.meta.url)).text();
    expect(src).not.toMatch(/^\s*["']use client["']/m);
  });
});
