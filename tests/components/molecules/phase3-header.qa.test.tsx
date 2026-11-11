// QA (T147, Phase 3 wave A): header molecules (T143) — SearchBox pill, CategoryNav, DepartmentMenu —
// against BACKLOG-phase3 T143 AC1-AC6 and CONTRACTS G-5, G-9, G-13.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  CATEGORY_NAV_DEFAULT_MAX_VISIBLE,
  CategoryNav,
  buildCategoryNavModel,
  categoryNavHref,
  normalizeMaxVisible,
  type CategoryNavItem,
} from "@/components/molecules/CategoryNav";
import { DEPARTMENT_MENU_NAV_LABEL, DepartmentMenu } from "@/components/molecules/DepartmentMenu";
import { SEARCH_BOX_PLACEHOLDER, SearchBox } from "@/components/molecules/SearchBox";
import { isAllowedInternalHref } from "@/content/routes";
import type { Category } from "@/lib/types";

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>&amp; ‮evil`;

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}
const cls = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

const depts = (n: number): CategoryNavItem[] =>
  Array.from({ length: n }, (_, i) => ({ slug: `dept-${i + 1}`, label: `Dept ${i + 1}` }));

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

// ============================================================ CategoryNav
describe("T143 AC3/AC4 + G-13: CategoryNav", () => {
  test("nav[aria-label=Primary], one link per department in order, hrefs /category/<slug>", () => {
    const doc = parse(renderToStaticMarkup(<CategoryNav departments={depts(4)} />));
    const nav = doc.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Primary");
    expect([...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(depts(4).map((d) => `/category/${d.slug}`));
    expect(doc.querySelector("details")).toBeNull();
  });

  test("default N=9: 12 departments -> 9 direct links + <details><summary>More</summary> holding the other 3", () => {
    expect(CATEGORY_NAV_DEFAULT_MAX_VISIBLE).toBe(9);
    const doc = parse(renderToStaticMarkup(<CategoryNav departments={depts(12)} />));
    const direct = [...doc.querySelectorAll("nav a")].filter((a) => a.closest("details") === null);
    expect(direct).toHaveLength(9);
    const details = doc.querySelector("nav details");
    expect(details?.querySelector("summary")?.textContent?.trim()).toBe("More");
    expect([...(details?.querySelectorAll("a") ?? [])].map((a) => a.textContent)).toEqual(["Dept 10", "Dept 11", "Dept 12"]);
    expect(details?.hasAttribute("open")).toBe(false);
  });

  test("exactly N departments -> no More; N + 1 -> one link in More", () => {
    expect(parse(renderToStaticMarkup(<CategoryNav departments={depts(9)} />)).querySelector("details")).toBeNull();
    const doc = parse(renderToStaticMarkup(<CategoryNav departments={depts(10)} />));
    expect(doc.querySelectorAll("details a")).toHaveLength(1);
  });

  test("maxVisible: 0, -1, NaN, Infinity, '3' fall back to 9; 2.7 floors to 2", () => {
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "3" as unknown as number]) {
      expect({ v: String(v), n: normalizeMaxVisible(v) }).toEqual({ v: String(v), n: 9 });
    }
    expect(normalizeMaxVisible(2.7)).toBe(2);
    const doc = parse(renderToStaticMarkup(<CategoryNav departments={depts(5)} maxVisible={2.7} />));
    expect([...doc.querySelectorAll("nav a")].filter((a) => a.closest("details") === null)).toHaveLength(2);
  });

  test("current department gets aria-current=page, also when it sits inside the closed More", () => {
    const doc = parse(renderToStaticMarkup(<CategoryNav departments={depts(12)} currentSlug="dept-11" />));
    const current = [...doc.querySelectorAll('[aria-current="page"]')];
    expect(current.map((a) => a.textContent)).toEqual(["Dept 11"]);
    expect(current[0]?.closest("details")?.hasAttribute("open")).toBe(false);
  });

  test("reserved-character slugs are encoded and then rejected by the allow-list; labels render as text; one warning", () => {
    expect(categoryNavHref("a/b?c#d")).toBe("/category/a%2Fb%3Fc%23d");
    const items: CategoryNavItem[] = [
      { slug: "a/b?c#d", label: "Reserved" },
      { slug: "hostile", label: HOSTILE },
      { slug: "..", label: "Dots" },
      { slug: "toys", label: "Toys" },
      { slug: "toys", label: "Toys again" },
      { slug: "   ", label: "Blank slug" },
      { slug: "x", label: "   " },
    ];
    const { container } = render(<CategoryNav departments={items} />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toEqual(["/category/hostile", "/category/toys"]);
    for (const h of hrefs) expect(isAllowedInternalHref(h)).toBe(true);
    expect(container.querySelectorAll("script, img, [onerror]").length).toBe(0);
    expect(container.querySelector("a")?.textContent).toBe(HOSTILE.trim());
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("no departments survive -> renders nothing", () => {
    expect(renderToStaticMarkup(<CategoryNav departments={[]} />)).toBe("");
    expect(renderToStaticMarkup(<CategoryNav departments={[{ slug: "..", label: "x" }]} />)).toBe("");
    expect(buildCategoryNavModel({ departments: null }).visible).toEqual([]);
  });

  test("T143 AC5: row never wraps and scrolls inside itself; every link and the summary are >= 44px", () => {
    const doc = parse(renderToStaticMarkup(<CategoryNav departments={depts(12)} />));
    const row = doc.querySelector("nav > ul");
    expect(cls(row)).toEqual(expect.arrayContaining(["flex-nowrap", "overflow-x-auto", "whitespace-nowrap", "min-w-0"]));
    for (const a of doc.querySelectorAll("nav a")) expect(cls(a)).toContain("min-h-touch");
    expect(cls(doc.querySelector("summary"))).toContain("min-h-touch");
  });

  test("no-JS: server markup has no script and the overflow is a native <details>", () => {
    const html = renderToStaticMarkup(<CategoryNav departments={depts(12)} />);
    expect(html).not.toContain("<script");
    expect(html).toContain("<details");
  });

  // PIN: D-T143-1 (fixed: py-1 added) — CategoryNav's scroll row (`ul.overflow-x-auto`) has no padding. overflow-x:auto
  // forces overflow-y to clip as well, so the 2px focus outline + 2px offset of the 44px-high links is
  // cut off at the top and bottom of the row. BenefitsStrip (`p-1`), ChipRow (`p-1`) and the gallery strip
  // (`p-1`) leave room for it; CategoryNav does not. Flip to `test` when the row gets p-1 (or py-1).
  test("D-T143-1 (fixed): the scrolling row leaves room for the focus outline (p-1 / py-1 like BenefitsStrip)", () => {
    const row = parse(renderToStaticMarkup(<CategoryNav departments={depts(4)} />)).querySelector("nav > ul");
    expect(cls(row).some((c) => /^(p|py)-(1|2)$/.test(c))).toBe(true);
  });
});

// ============================================================ SearchBox
describe("T143 AC1/AC2 + G-9: SearchBox pill (no-JS GET)", () => {
  const ssr = (el: React.ReactElement) => parse(renderToStaticMarkup(el));

  test("GET form to /search with name=q, maxlength 100, placeholder, visually hidden label bound to the input", () => {
    const doc = ssr(<SearchBox />);
    const form = doc.querySelector("form");
    expect(form?.getAttribute("action")).toBe("/search");
    expect((form?.getAttribute("method") ?? "get").toLowerCase()).toBe("get");
    expect(form?.getAttribute("role")).toBe("search");
    const input = form?.querySelector('input[name="q"]');
    expect(input?.getAttribute("maxlength") ?? input?.getAttribute("maxLength")).toBe("100");
    expect(input?.getAttribute("placeholder")).toBe(SEARCH_BOX_PLACEHOLDER);
    expect(SEARCH_BOX_PLACEHOLDER).toBe("Search products, categories and more");
    const label = doc.querySelector(`label[for="${input?.getAttribute("id")}"]`);
    expect(label?.textContent).toBe("Search products");
    expect(cls(label)).toContain("sr-only");
    const submit = form?.querySelector('button[type="submit"]');
    expect(submit?.getAttribute("aria-label")).toBe("Submit search");
    expect(cls(submit)).toEqual(expect.arrayContaining(["min-h-touch", "min-w-touch"]));
  });

  test("AC2: empty / whitespace query is allowed (no `required`, no pattern) so it reaches browse-all", () => {
    const input = ssr(<SearchBox />).querySelector('input[name="q"]');
    expect(input?.hasAttribute("required")).toBe(false);
    expect(input?.hasAttribute("pattern")).toBe(false);
    expect(input?.hasAttribute("minlength")).toBe(false);
  });

  test("T148 ruling: no departments prop -> no select and no dept field; with departments the select joins the form", () => {
    expect(ssr(<SearchBox />).querySelector('select, [name="dept"]')).toBeNull();
    const doc = ssr(<SearchBox departments={[{ slug: "toys", name: "Toys" }]} />);
    const select = doc.querySelector('select[name="dept"]');
    expect(select?.getAttribute("form")).toBe(doc.querySelector("form")?.getAttribute("id"));
    expect(select?.getAttribute("aria-label")).toBe("Search in department");
  });

  test("hostile defaultQuery is a value attribute only, never markup", () => {
    const doc = ssr(<SearchBox defaultQuery={HOSTILE} />);
    expect(doc.querySelectorAll("script, img, [onerror]").length).toBe(0);
    expect(doc.querySelector('input[name="q"]')?.getAttribute("value")).toBe(HOSTILE);
  });

  test("pill look from tokens only: rounded-full 48px field", () => {
    const input = ssr(<SearchBox />).querySelector('input[name="q"]');
    expect(cls(input)).toEqual(expect.arrayContaining(["rounded-full", "min-h-12"]));
    expect(cls(input).filter((c) => /\[|^dark:/.test(c))).toEqual([]);
  });
});

// ============================================================ DepartmentMenu + landmark names
const cat = (slug: string, name: string): Category => ({
  id: `c-${slug}`,
  slug,
  name,
  description: "",
  parentId: null,
  sortOrder: 0,
  imageUrl: null,
});

describe("T143 AC4/AC6 + G-5: DepartmentMenu and unique nav names", () => {
  test("no-JS: the trigger is a 44px pill link to /products named 'All products'", () => {
    const doc = parse(renderToStaticMarkup(<DepartmentMenu departments={[{ ...cat("toys", "Toys"), children: [] }]} />));
    const a = doc.querySelector("a");
    expect(a?.getAttribute("href")).toBe("/products");
    expect(a?.textContent?.replace(/\s+/g, " ").trim()).toBe("All products");
    expect(cls(a)).toEqual(expect.arrayContaining(["rounded-full", "min-h-touch"]));
    expect(doc.querySelector("nav, button, dialog")).toBeNull();
  });

  test("hydrated + opened: departments nav is named 'Departments'; with CategoryNav and SearchBox every landmark name is unique", () => {
    render(
      <>
        <SearchBox />
        <CategoryNav departments={depts(3)} />
        <DepartmentMenu departments={[{ ...cat("toys", "Toys"), children: [cat("lego", "Lego")] }]} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open menu/ }));
    expect(DEPARTMENT_MENU_NAV_LABEL).toBe("Departments");
    const navNames = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label") ?? n.getAttribute("aria-labelledby") ?? "");
    expect(navNames).toContain("Primary");
    expect(navNames).toContain("Departments");
    expect(new Set(navNames).size).toBe(navNames.length);
    expect(navNames.every((n) => n !== "")).toBe(true);
    expect(screen.getByRole("search").getAttribute("aria-label")).toBe("Site search");
  });

  test("CategoryNav and DepartmentMenu never share a landmark name (constants)", () => {
    const nav = parse(renderToStaticMarkup(<CategoryNav departments={depts(1)} />)).querySelector("nav");
    expect(nav?.getAttribute("aria-label")).not.toBe(DEPARTMENT_MENU_NAV_LABEL);
  });
});
