import { describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEPARTMENT_NAV } from "@/content/navigation";
import { isAllowedInternalHref } from "@/content/routes";
import {
  CATEGORY_NAV_DEFAULT_MAX_VISIBLE,
  CategoryNav,
  buildCategoryNavModel,
  categoryNavHref,
  normalizeMaxVisible,
} from "./index";
import type { CategoryNavItem } from "./index";

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function ssr(node: ReactElement): Document {
  return parse(renderToStaticMarkup(node));
}

const TWELVE: CategoryNavItem[] = Array.from({ length: 12 }, (_, i) => ({ slug: `dept-${i + 1}`, label: `Dept ${i + 1}` }));

function directLinks(doc: Document | HTMLElement): HTMLAnchorElement[] {
  const nav = doc.querySelector('nav[aria-label="Primary"]');
  return Array.from(nav?.querySelectorAll(":scope > ul > li > a") ?? []);
}

function overflowLinks(doc: Document | HTMLElement): HTMLAnchorElement[] {
  const nav = doc.querySelector('nav[aria-label="Primary"]');
  return Array.from(nav?.querySelectorAll("details a") ?? []);
}

function withSilencedWarn<T>(run: () => T): { result: T; calls: unknown[][] } {
  const warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
  try {
    const result = run();
    return { result, calls: warn.mock.calls.map((c) => [...c]) };
  } finally {
    warn.mockRestore();
  }
}

describe("buildCategoryNavModel", () => {
  test("builds /category/<slug> hrefs in the given order and splits after maxVisible", () => {
    const model = buildCategoryNavModel({ departments: TWELVE, maxVisible: 4 });
    expect(model.visible.map((l) => l.href)).toEqual(["/category/dept-1", "/category/dept-2", "/category/dept-3", "/category/dept-4"]);
    expect(model.overflow).toHaveLength(8);
    expect(model.overflow[0]?.label).toBe("Dept 5");
    expect(model.rejected).toEqual([]);
  });

  test("default N is 9; invalid maxVisible falls back to 9; fractions are floored", () => {
    expect(CATEGORY_NAV_DEFAULT_MAX_VISIBLE).toBe(9);
    expect(buildCategoryNavModel({ departments: TWELVE }).visible).toHaveLength(9);
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(normalizeMaxVisible(bad)).toBe(9);
    }
    expect(normalizeMaxVisible(3.9)).toBe(3);
    expect(normalizeMaxVisible("4")).toBe(9);
  });

  test("blank, duplicate and path-changing slugs are dropped; slugs are encoded", () => {
    expect(categoryNavHref("a?b#c")).toBe("/category/a%3Fb%23c");
    const model = buildCategoryNavModel({
      departments: [
        { slug: "books", label: "Books" },
        { slug: "books", label: "Books again" },
        { slug: "", label: "No slug" },
        { slug: "office", label: "   " },
        { slug: "..", label: "Dots" },
        { slug: "a/b", label: "Slash" },
        { slug: " toys-games ", label: " Toys & Games " },
      ],
    });
    expect(model.visible.map((l) => [l.label, l.href])).toEqual([
      ["Books", "/category/books"],
      ["Toys & Games", "/category/toys-games"],
    ]);
    expect(model.rejected).toEqual(["/category/..", "/category/a%2Fb"]);
  });

  test("null/undefined input and junk entries never throw", () => {
    expect(buildCategoryNavModel({ departments: null }).visible).toEqual([]);
    expect(buildCategoryNavModel({ departments: undefined }).visible).toEqual([]);
    const junk = [null, { slug: 1, label: "x" }, { slug: "ok", label: "OK" }] as unknown as CategoryNavItem[];
    expect(buildCategoryNavModel({ departments: junk }).visible.map((l) => l.slug)).toEqual(["ok"]);
  });

  test("current flag only on the matching slug (trimmed); blank currentSlug marks nothing", () => {
    const model = buildCategoryNavModel({ departments: TWELVE, currentSlug: " dept-2 " });
    expect(model.visible.filter((l) => l.current).map((l) => l.slug)).toEqual(["dept-2"]);
    expect(buildCategoryNavModel({ departments: TWELVE, currentSlug: "  " }).visible.some((l) => l.current)).toBe(false);
  });
});

describe("CategoryNav server markup (no JS)", () => {
  test("nav[aria-label=Primary] with one link per department from DEPARTMENT_NAV, no overflow at 8 <= 9, no button/script/dialog", () => {
    const html = renderToStaticMarkup(<CategoryNav departments={DEPARTMENT_NAV} />);
    expect(html).not.toMatch(/<(button|dialog|script|form)\b/);
    const doc = parse(html);
    const navs = doc.querySelectorAll("nav");
    expect(navs).toHaveLength(1);
    expect(navs[0]?.getAttribute("aria-label")).toBe("Primary");
    expect(directLinks(doc).map((a) => [a.textContent, a.getAttribute("href")])).toEqual(
      DEPARTMENT_NAV.map((d) => [d.label, `/category/${d.slug}`]),
    );
    expect(doc.querySelector("details")).toBeNull();
  });

  test("overflow: more than N renders the rest inside details > summary 'More' (closed, works without JS)", () => {
    const doc = ssr(<CategoryNav departments={TWELVE} />);
    expect(directLinks(doc)).toHaveLength(9);
    const details = doc.querySelector('nav[aria-label="Primary"] details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.querySelector("summary")?.textContent?.trim()).toBe("More");
    expect(overflowLinks(doc).map((a) => a.textContent)).toEqual(["Dept 10", "Dept 11", "Dept 12"]);
    // The overflow sits outside the scrolling list, so its panel is not clipped.
    expect(doc.querySelector("nav > ul details")).toBeNull();
  });

  test("custom maxVisible prop; exactly N items has no More", () => {
    const doc = ssr(<CategoryNav departments={TWELVE} maxVisible={3} />);
    expect(directLinks(doc)).toHaveLength(3);
    expect(overflowLinks(doc)).toHaveLength(9);
    const exact = ssr(<CategoryNav departments={TWELVE.slice(0, 9)} />);
    expect(directLinks(exact)).toHaveLength(9);
    expect(exact.querySelector("details")).toBeNull();
  });

  test("aria-current='page' on the current department only (row and overflow)", () => {
    const row = ssr(<CategoryNav departments={DEPARTMENT_NAV} currentSlug="books" />);
    const current = row.querySelectorAll('[aria-current]');
    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute("aria-current")).toBe("page");
    expect(current[0]?.getAttribute("href")).toBe("/category/books");

    const over = ssr(<CategoryNav departments={TWELVE} currentSlug="dept-11" />);
    const inOverflow = over.querySelectorAll('[aria-current="page"]');
    expect(inOverflow).toHaveLength(1);
    expect(inOverflow[0]?.closest("details")).not.toBeNull();
    expect(inOverflow[0]?.textContent).toBe("Dept 11");

    expect(ssr(<CategoryNav departments={DEPARTMENT_NAV} currentSlug="nope" />).querySelector("[aria-current]")).toBeNull();
  });

  test("hostile labels render as text; hostile slugs are encoded or dropped; every href passes isAllowedInternalHref", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { result: html, calls } = withSilencedWarn(() =>
      renderToStaticMarkup(
        <CategoryNav
          departments={[
            { slug: "electronics", label: hostile },
            { slug: "javascript:alert(1)", label: "JS" },
            { slug: "//evil.example", label: "Proto" },
            { slug: "..", label: "Dots" },
            { slug: "x?y#z", label: "Query" },
            ...TWELVE,
          ]}
          maxVisible={2}
        />,
      ),
    );
    const doc = parse(html);
    expect(doc.querySelector("img, script")).toBeNull();
    expect(directLinks(doc)[0]?.textContent).toBe(hostile);
    const hrefs = Array.from(doc.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      expect(isAllowedInternalHref(href)).toBe(true);
      expect(href.startsWith("/category/")).toBe(true);
    }
    expect(hrefs).not.toContain("//evil.example");
    // Rejected hrefs produce a single development warning naming them.
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("/category/..");
  });

  test("renders nothing when no department survives (header still renders without it)", () => {
    expect(renderToStaticMarkup(<CategoryNav departments={[]} />)).toBe("");
    const { result } = withSilencedWarn(() =>
      renderToStaticMarkup(<CategoryNav departments={[{ slug: "..", label: "Dots" }, { slug: "x", label: "" }]} />),
    );
    expect(result).toBe("");
  });

  test("320px: the row scrolls instead of wrapping; every link and the summary is a 44px target", () => {
    const doc = ssr(<CategoryNav departments={TWELVE} />);
    const list = doc.querySelector('nav[aria-label="Primary"] > ul');
    expect(list?.className).toMatch(/\boverflow-x-auto\b/);
    expect(list?.className).toMatch(/\bflex-nowrap\b/);
    expect(list?.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(list?.className).not.toMatch(/\bflex-wrap\b/);
    for (const el of Array.from(doc.querySelectorAll("a, summary"))) {
      expect(`${el.tagName} ${el.className}`).toMatch(/min-h-touch|size-touch/);
    }
  });
});

describe("CategoryNav in the DOM", () => {
  test("landmark is reachable by role and name; links by name", () => {
    render(<CategoryNav departments={TWELVE} currentSlug="dept-1" />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Dept 1" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getAllByRole("link")).toHaveLength(12);
  });
});

describe("CategoryNav leading link (T148: Deals first in the Primary nav)", () => {
  test("rendered first, inside the Primary nav, not counted toward maxVisible", () => {
    render(<CategoryNav departments={TWELVE} maxVisible={3} leading={{ label: "Deals", href: "/deals" }} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const rowLinks = [...nav.querySelectorAll("ul")[0]!.querySelectorAll(":scope > li > a")];
    expect(rowLinks.map((a) => a.getAttribute("href"))).toEqual(["/deals", "/category/dept-1", "/category/dept-2", "/category/dept-3"]);
    expect(rowLinks[0]).toHaveTextContent("Deals");
    expect(rowLinks[0]).toHaveClass("min-h-touch");
  });

  test("model: leading validated separately; overflow unchanged", () => {
    const model = buildCategoryNavModel({ departments: TWELVE, maxVisible: 9, leading: { label: " Deals ", href: "/deals" } });
    expect(model.leading).toEqual({ label: "Deals", href: "/deals" });
    expect(model.visible).toHaveLength(9);
    expect(model.overflow).toHaveLength(3);
    expect(buildCategoryNavModel({ departments: TWELVE }).leading).toBeNull();
  });

  test("disallowed or blank leading links are dropped (and reported as rejected)", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const leading of [
        { label: "Evil", href: "https://evil.example" },
        { label: "Js", href: "javascript:alert(1)" },
        { label: "Ghost", href: "/not-a-route" },
        { label: "  ", href: "/deals" },
        { label: "Deals", href: " " },
      ]) {
        const { container, unmount } = render(<CategoryNav departments={DEPARTMENT_NAV} leading={leading} />);
        const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
        expect(hrefs.every((h) => h.startsWith("/category/"))).toBe(true);
        unmount();
      }
      expect(buildCategoryNavModel({ departments: [], leading: { label: "Evil", href: "//evil.example" } }).rejected).toEqual(["//evil.example"]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a valid leading link alone still renders the nav; nothing valid renders nothing", () => {
    const { unmount } = render(<CategoryNav departments={[]} leading={{ label: "Deals", href: "/deals" }} />);
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Deals" })).toHaveAttribute("href", "/deals");
    unmount();
    const empty = renderToStaticMarkup(<CategoryNav departments={[]} leading={null} />);
    expect(empty).toBe("");
  });

  test("the leading link is never aria-current (department current state unchanged)", () => {
    render(<CategoryNav departments={DEPARTMENT_NAV} currentSlug="books" leading={{ label: "Deals", href: "/deals" }} />);
    expect(screen.getByRole("link", { name: "Deals" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Books" })).toHaveAttribute("aria-current", "page");
  });
});
