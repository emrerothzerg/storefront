// QA (T163, Phase 3 wave B1): SiteFooter v3 (T150) against BACKLOG-phase3 T150 AC1–6, T163 AC1–2 and
// tests/redesign/CONTRACTS.md G-4, G-5, G-14, G-15, G-16.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { SiteFooter, footerYear } from "@/components/organisms/SiteFooter";
import { FOOTER_COLUMNS, FOOTER_QUICK_LINKS, LEGAL_LINKS } from "@/content/navigation";
import { PLANNED_ROUTES, isAllowedInternalHref } from "@/content/routes";

const APP = join(import.meta.dir, "../../../src/app");
const SRC = join(import.meta.dir, "../../../src/components/organisms/SiteFooter/SiteFooter.tsx");
const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp;`;
const PLACEHOLDERS = ["Mobile app coming soon", "Card", "Gift card", "Pay later: coming soon"];
const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
// Trademark / retailer / social names are assembled at runtime (never literals in the repo).
const TRADEMARKS = [
  ["vi", "sa"],
  ["master", "card"],
  ["pay", "pal"],
  ["apple", " pay"],
  ["google", " pay"],
  ["am", "ex"],
  ["after", "pay"],
  ["zip", " pay"],
  ["k", "mart"],
  ["one", "pass"],
  ["app", " store"],
  ["google", " play"],
].map((p) => p.join(""));
const SOCIAL = [["face", "book"], ["insta", "gram"], ["tik", "tok"], ["you", "tube"], ["twit", "ter"], ["pin", "terest"]].map((p) => p.join(""));
const DARK_VARIANT = ["da", "rk:"].join("");
const FIXED_NOW = Date.UTC(2031, 5, 15, 12, 0, 0);

let restore: Array<() => void> = [];
afterEach(() => {
  for (const r of restore) r();
  restore = [];
});
function silenceWarn(): ReturnType<typeof spyOn> {
  const spy = spyOn(console, "warn").mockImplementation(() => {});
  restore.push(() => spy.mockRestore());
  return spy;
}

/** The layout's footer (`layout.tsx` passes storeName + FOOTER_COLUMNS) with a fixed clock. */
const layoutFooter = () => <SiteFooter storeName="Northwind Goods" columns={FOOTER_COLUMNS} now={FIXED_NOW} />;

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
const ROUTES = appRoutes();
function pageExists(href: string): boolean {
  const segs = (href.split(/[?#]/)[0] ?? "").split("/").filter(Boolean);
  return ROUTES.some((route) => {
    const r = route.split("/").filter(Boolean);
    return r.length === segs.length && r.every((s, i) => s.startsWith("[") || s === segs[i]);
  });
}
function plannedPattern(href: string): boolean {
  const segs = href.split("/").filter(Boolean);
  return (PLANNED_ROUTES as readonly string[]).some((route) => {
    const r = route.split("/").filter(Boolean);
    return r.length === segs.length && r.every((s, i) => s.startsWith("[") || s === segs[i]);
  });
}

// --------------------------------------------------------------------------------------------
describe("T150 AC1 / G-14 / T163 AC1: every link resolves; no duplicates", () => {
  test("every href passes isAllowedInternalHref, matches a routes.ts pattern and an existing page.tsx", () => {
    for (const el of [layoutFooter(), <SiteFooter key="d" now={FIXED_NOW} />]) {
      const { container, unmount } = render(el);
      const hrefs = [...container.querySelectorAll("footer a[href]")].map((a) => a.getAttribute("href") ?? "");
      expect(hrefs.length).toBeGreaterThan(20);
      for (const h of hrefs) {
        if (h === "#main") continue;
        expect({ h, allowed: isAllowedInternalHref(h), planned: plannedPattern(h), page: pageExists(h) }).toEqual({
          h,
          allowed: true,
          planned: true,
          page: true,
        });
      }
      unmount();
    }
  });

  test("no duplicate href footer-wide (hence none within a column) and no dead '#' / empty hrefs", () => {
    const { container } = render(layoutFooter());
    const hrefs = [...container.querySelectorAll("footer a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.filter((h, i) => hrefs.indexOf(h) !== i)).toEqual([]);
    expect(hrefs.filter((h) => h === "" || h === "#")).toEqual([]);
  });

  test("quick links row: Track order -> /orders, Contact us -> /contact", () => {
    render(layoutFooter());
    const quick = screen.getByRole("navigation", { name: "Footer: Quick links" });
    expect(within(quick).getAllByRole("link").map((a) => [a.textContent?.trim(), a.getAttribute("href")])).toEqual(
      FOOTER_QUICK_LINKS.map((l) => [l.label, l.href]),
    );
    expect(FOOTER_QUICK_LINKS.map((l) => l.href)).toEqual(["/orders", "/contact"]);
  });

  test("legal links present exactly once; given columns that omit them still get a Legal column", () => {
    silenceWarn();
    const { container } = render(<SiteFooter now={FIXED_NOW} columns={[{ heading: "Shop", links: [{ label: "Deals", href: "/deals" }] }]} />);
    for (const l of LEGAL_LINKS) expect(container.querySelectorAll(`footer a[href="${l.href}"]`)).toHaveLength(1);
    expect(screen.getByRole("navigation", { name: "Footer: Legal" })).toBeInTheDocument();
  });

  test("hostile hrefs are dropped (never rendered), with a dev warning", () => {
    const warn = silenceWarn();
    const { container } = render(
      <SiteFooter
        now={FIXED_NOW}
        columns={[
          {
            heading: "Bad",
            links: [
              { label: "js", href: "javascript:alert(1)" },
              { label: "ext", href: "https://evil.example" },
              { label: "proto", href: "//evil.example" },
              { label: "ok", href: "/faq" },
            ],
          },
        ]}
      />,
    );
    const html = container.innerHTML;
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("evil.example");
    expect(warn.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});

// --------------------------------------------------------------------------------------------
describe("T150 AC5 / G-4 / G-5: landmarks", () => {
  test("exactly one contentinfo FOOTER; every nav named, names unique, all start with 'Footer: '", () => {
    render(layoutFooter());
    const footers = screen.getAllByRole("contentinfo");
    expect(footers).toHaveLength(1);
    expect(footers[0]?.tagName).toBe("FOOTER");
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label") ?? "");
    expect(names.length).toBeGreaterThanOrEqual(5);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith("Footer: ") && n.length > "Footer: ".length)).toBe(true);
  });

  test("two columns with the same heading still get unique nav names", () => {
    render(
      <SiteFooter
        now={FIXED_NOW}
        columns={[
          { heading: "Help", links: [{ label: "FAQ", href: "/faq" }] },
          { heading: "Help", links: [{ label: "Help", href: "/help" }] },
        ]}
      />,
    );
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });

  test("column headings are h2, 4 link columns + 'Get the app' in the columns grid", () => {
    const { container } = render(layoutFooter());
    const grid = container.querySelector("[data-footer-columns]") as HTMLElement;
    const headings = [...grid.querySelectorAll("h1, h2, h3, h4, h5, h6")];
    expect(headings.every((h) => h.tagName === "H2")).toBe(true);
    expect(headings.map((h) => h.textContent)).toEqual([...FOOTER_COLUMNS.map((c) => c.heading), "Get the app"]);
  });
});

// --------------------------------------------------------------------------------------------
describe("T150 AC3 / G-15 / T163 AC2: placeholders are non-interactive and brand-free", () => {
  for (const text of PLACEHOLDERS) {
    test(`"${text}": present as text, no a/button ancestor, no tabindex >= 0, no img`, () => {
      const { container } = render(layoutFooter());
      const footer = container.querySelector("footer") as HTMLElement;
      const hits = [...footer.querySelectorAll("*")].filter(
        (el) => [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() === text),
      );
      expect(hits.length).toBeGreaterThanOrEqual(1);
      for (const el of hits) {
        let node: Element | null = el;
        while (node !== null && node !== footer) {
          expect({ text, tag: node.tagName }).not.toEqual({ text, tag: "A" });
          expect({ text, tag: node.tagName }).not.toEqual({ text, tag: "BUTTON" });
          const ti = node.getAttribute("tabindex");
          expect({ text, ti: ti !== null && Number(ti) >= 0 }).toEqual({ text, ti: false });
          node = node.parentElement;
        }
        expect(el.querySelectorAll("img")).toHaveLength(0);
      }
    });
  }

  test("tab order: no focusable element inside the app/payment placeholder areas", () => {
    const { container } = render(layoutFooter());
    for (const sel of ["[data-footer-app]", "[data-footer-payments]"]) {
      const area = container.querySelector(sel);
      expect({ sel, found: area !== null }).toEqual({ sel, found: true });
      expect({ sel, n: area?.querySelectorAll(FOCUSABLE).length }).toEqual({ sel, n: 0 });
      expect({ sel, img: area?.querySelectorAll("img").length }).toEqual({ sel, img: 0 });
    }
  });

  test("placeholders say 'coming soon' for things that do not exist (app, pay later)", () => {
    const { container } = render(layoutFooter());
    expect(container.querySelector("[data-footer-app]")?.textContent).toContain("coming soon");
    expect(container.querySelector("[data-footer-payments]")?.textContent).toContain("Pay later: coming soon");
  });

  test("no trademark, retailer, payment-brand or store-badge text anywhere in the footer", () => {
    const text = renderToStaticMarkup(layoutFooter()).toLowerCase();
    for (const word of TRADEMARKS) expect({ word, found: new RegExp(`\\b${word}\\b`).test(text) }).toEqual({ word, found: false });
  });
});

// --------------------------------------------------------------------------------------------
describe("T150 AC4 / G-16: light bottom bar, injected clock, brand, no social", () => {
  test("bottom bar and footer use light surfaces (no inverse band, no dark-variant classes)", () => {
    const { container } = render(layoutFooter());
    const footer = container.querySelector("footer") as HTMLElement;
    const bar = footer.querySelector("[data-footer-bottom-bar]") as HTMLElement;
    expect(bar).not.toBeNull();
    expect(/(^|\s)bg-surface-(page|sunken|raised)(\s|$)/.test(bar.className)).toBe(true);
    expect(footer.innerHTML).not.toContain("inverse");
    expect(footer.className).not.toContain("inverse");
    expect(footer.outerHTML).not.toContain(DARK_VARIANT);
  });

  test("copyright year comes from the injected clock (UTC), brand 'Northwind Goods', Date.now not consulted", () => {
    const nowSpy = spyOn(Date, "now");
    restore.push(() => nowSpy.mockRestore());
    render(layoutFooter());
    expect(screen.getByRole("contentinfo").textContent).toContain("© 2031 Northwind Goods. All rights reserved.");
    expect(nowSpy).not.toHaveBeenCalled();
  });

  test("year boundary is UTC: 2030-12-31T23:30-05:00 (= 2031-01-01 04:30Z) -> 2031; Date input works too", () => {
    expect(footerYear(Date.parse("2030-12-31T23:30:00-05:00"))).toBe(2031);
    expect(footerYear(new Date(Date.UTC(1999, 11, 31, 23, 59)))).toBe(1999);
    expect(footerYear(Number.NaN, undefined)).toBe(new Date().getUTCFullYear());
    expect(footerYear(FIXED_NOW, 2040)).toBe(2040);
  });

  test("wordmark text in the bottom bar, not an image; no 'Catalogue' link; no social links or icons", () => {
    const { container } = render(layoutFooter());
    const footer = container.querySelector("footer") as HTMLElement;
    const wordmark = footer.querySelector("[data-footer-wordmark]");
    expect(wordmark?.textContent).toBe("Northwind Goods");
    expect(footer.querySelectorAll("img")).toHaveLength(0);
    const names = [...footer.querySelectorAll("a")].map((a) => (a.textContent ?? "").toLowerCase());
    expect(names.filter((n) => n.includes("catalogue"))).toEqual([]);
    const html = footer.outerHTML.toLowerCase();
    for (const s of SOCIAL) expect({ s, found: html.includes(s) }).toEqual({ s, found: false });
    expect([...footer.querySelectorAll("a")].filter((a) => /^https?:/i.test(a.getAttribute("href") ?? ""))).toHaveLength(0);
  });

  test("source: no social/icon brand imports, no `use client`, no any/ts-ignore, no dark-variant classes", () => {
    const src = readFileSync(SRC, "utf8");
    expect(/^["']use client["']/m.test(src)).toBe(false);
    expect(/:\s*any\b|as any\b|<any>|@ts-ignore|@ts-expect-error/.test(src)).toBe(false);
    expect(src).not.toContain(DARK_VARIANT);
    for (const s of SOCIAL) expect(src.toLowerCase()).not.toContain(s);
  });
});

// --------------------------------------------------------------------------------------------
describe("T150 AC2: 320px and 44px", () => {
  test("columns grid: 1 column base, 2 from sm, 5 from lg; no fixed widths without a breakpoint; no arbitrary classes", () => {
    const { container } = render(layoutFooter());
    const grid = container.querySelector("[data-footer-columns]") as HTMLElement;
    for (const c of ["grid-cols-1", "sm:grid-cols-2", "lg:grid-cols-5"]) expect({ c, has: grid.classList.contains(c) }).toEqual({ c, has: true });
    const classes = [...container.querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(classes.filter((c) => /^(min-)?w-([1-9]\d*|screen)$/.test(c))).toEqual([]);
    expect(classes.filter((c) => /(^|:)(bg|text|border|ring)-(gray|slate|red|blue|green|yellow|white|black)(-\d+)?$/.test(c))).toEqual([]);
  });

  test("every link is >= 44px (min-h-touch) and has no tabindex", () => {
    const { container } = render(layoutFooter());
    const links = [...container.querySelectorAll("footer a")];
    const small = links.filter((a) => !a.classList.contains("min-h-touch") || a.hasAttribute("tabindex"));
    expect(small.map((a) => a.outerHTML.slice(0, 100))).toEqual([]);
  });

  test("Back to top is the first focusable element in the footer and targets #main", () => {
    const { container } = render(layoutFooter());
    const first = container.querySelector("footer")?.querySelector(FOCUSABLE);
    expect(first?.getAttribute("href")).toBe("#main");
    expect(first?.textContent).toContain("Back to top");
  });
});

// --------------------------------------------------------------------------------------------
describe("Hostile input", () => {
  test("hostile storeName and labels render as text", () => {
    silenceWarn();
    const { container } = render(
      <SiteFooter now={FIXED_NOW} storeName={HOSTILE} columns={[{ heading: HOSTILE, links: [{ label: HOSTILE, href: "/faq" }] }]} />,
    );
    const footer = container.querySelector("footer") as HTMLElement;
    expect(footer.querySelector("script, img")).toBeNull();
    for (const el of footer.querySelectorAll("*")) expect(el.hasAttribute("onerror")).toBe(false);
    expect(footer.querySelector("[data-footer-wordmark]")?.textContent).toBe(HOSTILE);
  });

  test("static markup: no script, no inline handlers or styles", () => {
    const html = renderToStaticMarkup(layoutFooter());
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/\sstyle="/);
  });
});
