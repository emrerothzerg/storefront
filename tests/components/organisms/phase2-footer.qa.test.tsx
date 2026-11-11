// QA (QA-W4-organisms-A / T90): T81 SiteFooter v2.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteFooter, FOOTER_QUICK_LINKS, LEGAL_LINKS, type FooterColumn } from "@/components/organisms/SiteFooter";
import { SiteHeader } from "@/components/organisms/SiteHeader";
import { FOOTER_COLUMNS } from "@/content/navigation";
import { PLANNED_ROUTES, isAllowedInternalHref } from "@/content/routes";
import { isHelpTopicSlug } from "@/content/help-topics";

const DIR = join(import.meta.dir, "../../../src/components/organisms/SiteFooter");
const FRAGMENT = /^#[A-Za-z][\w-]*$/;
const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

let warnSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

function v2(over: Partial<Parameters<typeof SiteFooter>[0]> = {}) {
  return <SiteFooter year={2031} storeName="Northwind QA" columns={FOOTER_COLUMNS} {...over} />;
}

function allClasses(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
}

describe("T81.1 back to top", () => {
  for (const [name, el] of [
    ["v2 columns", v2()],
    ["MVP defaults", <SiteFooter key="d" year={2031} />],
  ] as const) {
    test(`${name}: plain <a href="#main"> and the first focusable element in the footer`, () => {
      render(el);
      const footer = screen.getByRole("contentinfo");
      const first = footer.querySelector(FOCUSABLE);
      expect(first?.tagName).toBe("A");
      expect(first?.getAttribute("href")).toBe("#main");
      expect(first?.textContent).toContain("Back to top");
      expect(first?.getAttribute("target")).toBeNull();
      expect(first?.getAttribute("role")).toBeNull();
      // T163 pin move (T150): light footer, so the back-to-top link uses the default tone.
      expect(first).toHaveClass("min-h-touch", "text-text-secondary");
      expect(first?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    });
  }

  test("works without JS: static markup starts the footer with the #main anchor, no inline handlers", () => {
    const html = renderToStaticMarkup(v2());
    const doc = new DOMParser().parseFromString(html, "text/html");
    const first = doc.querySelector("footer a");
    expect(first?.getAttribute("href")).toBe("#main");
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
    expect(html.includes("<script")).toBe(false);
  });

  test("hostile backToTopHref values fall back to #main with a dev warning", () => {
    for (const bad of ["javascript:alert(1)", "https://evil.example/", "//evil.example", "#", "#1top", "/cart", "#a b"]) {
      const { container, unmount } = render(v2({ backToTopHref: bad }));
      expect(container.querySelector("footer a")?.getAttribute("href")).toBe("#main");
      unmount();
    }
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(7);
  });

  test("valid custom fragment is kept", () => {
    const { container } = render(v2({ backToTopHref: "#top" }));
    expect(container.querySelector("footer a")?.getAttribute("href")).toBe("#top");
  });
});

describe("T81.2 columns, landmarks, allowlist", () => {
  // T163 pin move (T150): one nav per column ("Footer: <heading>") after "Footer: Quick links"; names unique.
  test("exactly one <footer>/contentinfo; navs = Quick links + one named nav per column", () => {
    const { container } = render(v2());
    expect(container.querySelectorAll("footer")).toHaveLength(1);
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(names).toEqual(["Footer: Quick links", ...FOOTER_COLUMNS.map((c) => `Footer: ${c.heading}`)]);
    expect(new Set(names).size).toBe(names.length);
  });

  // T163 pin move (T150): each column is looked up by its own nav; quick-link hrefs (/orders, /contact)
  // never repeat inside a column.
  test("each FOOTER_COLUMNS column renders as a heading followed by a list of its links, in order", () => {
    render(v2());
    const quickHrefs = new Set(FOOTER_QUICK_LINKS.map((l) => l.href));
    FOOTER_COLUMNS.forEach((col) => {
      const nav = screen.getByRole("navigation", { name: `Footer: ${col.heading}` });
      const headings = within(nav).getAllByRole("heading");
      expect(headings.map((h) => h.textContent)).toEqual([col.heading]);
      const lists = within(nav).getAllByRole("list");
      expect(lists).toHaveLength(1);
      const ul = lists[0] as HTMLElement;
      expect(headings[0]?.nextElementSibling === ul).toBe(true);
      const expected = col.links.filter((l) => !quickHrefs.has(l.href)).map((l) => [l.label, l.href]);
      const links = within(ul).getAllByRole("link");
      expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual(expected);
      expect(within(ul).getAllByRole("listitem")).toHaveLength(expected.length);
    });
    const quick = screen.getByRole("navigation", { name: "Footer: Quick links" });
    expect(within(quick).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/orders", "/contact"]);
  });

  test("column headings are h2 and the page outline stays valid under an h1 in main", () => {
    render(
      <>
        <SiteHeader cartCount={0} />
        <main id="main" tabIndex={-1}>
          <h1>Page</h1>
        </main>
        {v2()}
      </>,
    );
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const footerHeadings = within(screen.getByRole("contentinfo")).getAllByRole("heading");
    for (const h of footerHeadings) expect(h.tagName).toBe("H2");
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
    const navNames = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(new Set(navNames).size).toBe(navNames.length);
    expect(document.getElementById("main")).not.toBeNull();
  });

  test("every rendered href passes isAllowedInternalHref (fragments match #id and target an existing id when composed)", () => {
    const { container } = render(
      <>
        <main id="main" />
        {v2()}
      </>,
    );
    const hrefs = [...container.querySelectorAll("footer a")].map((a) => a.getAttribute("href") ?? "");
    // T163 pin move (T150): back to top + quick links + footer-wide de-duplicated column links (legal is a column).
    const columnHrefs = new Set(FOOTER_COLUMNS.flatMap((c) => c.links.map((l) => l.href)));
    for (const q of FOOTER_QUICK_LINKS) columnHrefs.delete(q.href);
    expect(hrefs.length).toBe(1 + FOOTER_QUICK_LINKS.length + columnHrefs.size);
    for (const href of hrefs) {
      if (href.startsWith("#")) {
        expect(href).toMatch(FRAGMENT);
        expect(document.getElementById(href.slice(1))).not.toBeNull();
      } else {
        expect(isAllowedInternalHref(href)).toBe(true);
      }
    }
  });

  test("T90.3: every footer href maps to a route in PLANNED_ROUTES (pages may still be planned)", () => {
    const html = renderToStaticMarkup(v2());
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? "").filter((h) => !h.startsWith("#"));
    // T163 pin move (T150): /help/<topic> links match the dynamic /help/[topic] route; the topic must exist.
    const planned = new Set<string>(PLANNED_ROUTES);
    for (const h of hrefs) {
      const topic = /^\/help\/([^/]+)$/.exec(h)?.[1];
      const ok = planned.has(h) || (topic !== undefined && planned.has("/help/[topic]") && isHelpTopicSlug(topic));
      expect({ h, ok }).toEqual({ h, ok: true });
    }
  });

  test("hostile hrefs are dropped with a dev warning; emptied columns are removed", () => {
    const columns: FooterColumn[] = [
      {
        heading: "Bad only",
        links: [
          { label: "js", href: "javascript:alert(1)" },
          { label: "proto-rel", href: "//evil.example/x" },
          { label: "abs", href: "https://evil.example/" },
          { label: "unknown", href: "/admin" },
          { label: "trailing", href: "/cart/" },
          { label: "traversal", href: "/orders/%2e%2e" },
          { label: "relative", href: "cart" },
          { label: "data", href: "data:text/html,hi" },
          { label: "empty", href: "" },
        ],
      },
      { heading: "Mixed", links: [{ label: "Cart", href: "/cart" }, { label: "Evil", href: "javascript:void(0)" }] },
    ];
    const { container } = render(v2({ columns }));
    // T163 pin move (T150): the surviving column has its own nav "Footer: Mixed"; "Bad only" is removed.
    expect(screen.queryByRole("navigation", { name: "Footer: Bad only" })).toBeNull();
    const nav = screen.getByRole("navigation", { name: "Footer: Mixed" });
    expect(within(nav).getAllByRole("heading").map((h) => h.textContent)).toEqual(["Mixed"]);
    expect(within(nav).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/cart"]);
    expect(container.innerHTML.includes("javascript:")).toBe(false);
    expect(container.innerHTML.includes("evil.example")).toBe(false);
    expect(warnSpy.mock.calls.length).toBe(10);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("SiteFooter");
  });

  // T163 pin move (T150): no column nav from the given columns; only Quick links + the always-present Legal.
  test("all columns empty or bad: no column nav, legal links and back-to-top remain", () => {
    for (const columns of [[], [{ heading: "Bad", links: [{ label: "x", href: "javascript:x" }] }]] as FooterColumn[][]) {
      const { unmount } = render(v2({ columns }));
      expect(screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"))).toEqual([
        "Footer: Quick links",
        "Footer: Legal",
      ]);
      expect(screen.getByRole("link", { name: "Back to top" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Privacy notice" })).toHaveAttribute("href", "/privacy");
      unmount();
    }
  });

  test("hostile column heading and link labels render as text", () => {
    const columns: FooterColumn[] = [
      { heading: "<script>window.__qaFooter=1</script>", links: [{ label: "<img src=x onerror=alert(1)>", href: "/cart" }] },
    ];
    const { container } = render(v2({ columns, storeName: "<b>Evil</b>" }));
    const footer = container.querySelector("footer");
    expect(footer?.querySelector("script, img, b")).toBeNull();
    expect(footer?.textContent).toContain("<script>window.__qaFooter=1</script>");
    expect(footer?.textContent).toContain("© 2031 <b>Evil</b>. All rights reserved.");
  });

  test("max: many columns and links still render one nav and one list per column", () => {
    const columns: FooterColumn[] = Array.from({ length: 8 }, (_, i) => ({
      heading: `Col ${i}`,
      links: Array.from({ length: 12 }, (_, j) => ({ label: `L${i}-${j}`, href: j % 2 ? "/cart" : `/products/p-${i}-${j}` })),
    }));
    render(v2({ columns }));
    // T163 pin move (T150): one nav + one list per column; duplicate hrefs are removed footer-wide, so
    // /cart (odd j in every column) renders once: 8 x 6 product links + 1 cart, not 96.
    for (let i = 0; i < 8; i++) {
      const nav = screen.getByRole("navigation", { name: `Footer: Col ${i}` });
      expect(within(nav).getAllByRole("list")).toHaveLength(1);
    }
    const columnLinks = [...document.querySelectorAll('nav[aria-label^="Footer: Col "] a')];
    expect(columnLinks).toHaveLength(8 * 6 + 1);
    expect(columnLinks.filter((a) => a.getAttribute("href") === "/cart")).toHaveLength(1);
  });
});

describe("legal row", () => {
  test("copyright with year + storeName, demo notice, privacy/terms/accessibility links", () => {
    render(v2());
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByText("© 2031 Northwind QA. All rights reserved.")).toBeInTheDocument();
    expect(within(footer).getByText("This is a demo store; policies are sample text.")).toBeInTheDocument();
    // T163 pin move (T150): legal links live in the "Legal" column; each legal href appears once in the footer.
    const legal = screen.getByRole("navigation", { name: "Footer: Legal" });
    const links = within(legal).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/privacy", "/terms", "/accessibility"]);
    expect(links.map((a) => a.textContent)).toEqual(["Privacy notice", "Terms of use", "Accessibility"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(LEGAL_LINKS.map((l) => l.href));
    for (const href of ["/privacy", "/terms", "/accessibility"]) {
      expect({ href, n: footer.querySelectorAll(`a[href="${href}"]`).length }).toEqual({ href, n: 1 });
    }
  });
});

describe("T81.3 Link tone=inverse, no ! classes, 320px, MVP compatibility", () => {
  // T163 pin move (T150): light footer. Intent kept: one consistent link tone, 44px, no tabindex, no !.
  test("every footer link: 44px target (min-h-touch), never the inverse tone, no tabindex, no !", () => {
    const { container } = render(v2());
    const links = [...container.querySelectorAll("footer a")];
    expect(links.length).toBeGreaterThan(20);
    for (const a of links) {
      expect(a.classList.contains("min-h-touch")).toBe(true);
      expect(a.classList.contains("text-text-inverse")).toBe(false);
      expect(a.getAttribute("tabindex")).toBeNull();
    }
    expect(allClasses(container.querySelector("footer") as Element).filter((c) => c.includes("!"))).toEqual([]);
  });

  test("source: every <Link> passes tone=\"inverse\"; no ! classes; no use client; no any/ts-ignore; no server imports", () => {
    const src = readFileSync(join(DIR, "SiteFooter.tsx"), "utf8");
    const linkTags = src.match(/<Link\b[\s\S]*?>/g) ?? [];
    expect(linkTags.length).toBeGreaterThan(0);
    // T163 pin move (T150): light footer, every Link passes tone="default".
    for (const tag of linkTags) expect(tag).toContain('tone="default"');
    expect(/className="[^"]*!/.test(src)).toBe(false);
    expect(/^["']use client["']/m.test(src)).toBe(false);
    expect(/:\s*any\b|as any\b|<any>|@ts-ignore|@ts-expect-error/.test(src)).toBe(false);
    expect(/from\s+["']@\/server\//.test(src)).toBe(false);
    expect(src.includes("dangerouslySetInnerHTML")).toBe(false);
  });

  // T163 pin move (T150): light surface; five columns from lg (4 link columns + "Get the app").
  test("320px class audit: 1 col, sm 2, lg 5; no fixed widths without breakpoint; light surface", () => {
    const { container } = render(v2());
    const footer = container.querySelector("footer") as HTMLElement;
    for (const c of ["bg-surface-page", "text-text-primary"]) expect(footer.classList.contains(c)).toBe(true);
    expect(footer.className).not.toContain("inverse");
    const grid = footer.querySelector("[data-footer-columns]");
    for (const c of ["grid-cols-1", "sm:grid-cols-2", "lg:grid-cols-5", "min-w-0"]) {
      expect({ c, has: grid?.classList.contains(c) ?? false }).toEqual({ c, has: true });
    }
    const classes = allClasses(footer);
    expect(classes.filter((c) => /^grid-cols-(?!1$)/.test(c))).toEqual([]);
    expect(classes.filter((c) => /^(w|min-w|max-w)-\[|^w-(\d{2,}|screen)$/.test(c))).toEqual([]);
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
  });

  // T163 pin move (T150): T150 AC6 updated the MVP file, so the mtime check is dropped; the count stays.
  test("MVP test file still has 9 tests", () => {
    expect(statSync(join(DIR, "SiteFooter.test.tsx")).isFile()).toBe(true);
    const src = readFileSync(join(DIR, "SiteFooter.test.tsx"), "utf8");
    expect(src.match(/\btest\(/g)?.length).toBe(9);
  });

  // T163 pin move (T150): the default footer is v3 (Northwind Goods, SITE_FOOTER_COLUMNS); the MVP
  // Catalog + Cart pair is still reachable through the deprecated `links` prop as "Footer: Links".
  test("defaults are v3; MVP flat links render as the 'Footer: Links' column", () => {
    const { unmount } = render(<SiteFooter year={2031} />);
    expect(screen.getByText("© 2031 Northwind Goods. All rights reserved.")).toBeInTheDocument();
    expect(screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"))).toEqual([
      "Footer: Quick links",
      ...FOOTER_COLUMNS.map((c) => `Footer: ${c.heading}`),
    ]);
    unmount();
    render(<SiteFooter year={2031} storeName="Storefront" links={[{ href: "/", label: "Catalog" }, { href: "/cart", label: "Cart" }]} />);
    const nav = screen.getByRole("navigation", { name: "Footer: Links" });
    expect(within(nav).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/", "/cart"]);
    expect(within(nav).getAllByRole("list")).toHaveLength(1);
    expect(screen.getByText("© 2031 Storefront. All rights reserved.")).toBeInTheDocument();
  });

  test("renderToStaticMarkup works with defaults and with columns; exactly one footer each", () => {
    for (const el of [<SiteFooter key="a" />, v2()]) {
      const html = renderToStaticMarkup(el);
      expect(html.match(/<footer/g)?.length).toBe(1);
      expect(html).toContain('href="#main"');
    }
  });
});
