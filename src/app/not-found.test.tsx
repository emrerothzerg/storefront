import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { SearchBox } from "@/components/molecules/SearchBox";
import { DEPARTMENT_NAV } from "@/content/navigation";
import { isAllowedInternalHref } from "@/content/routes";

import NotFound, {
  metadata,
  NOT_FOUND_LINK_HREFS,
  NOT_FOUND_SEARCH_LABEL,
  notFoundDepartments,
  notFoundLinks,
} from "./not-found";

const APP_DIR = import.meta.dir;

function staticDoc(): Document {
  const html = renderToStaticMarkup(<NotFound />);
  const doc = document.implementation.createHTMLDocument("not-found");
  doc.body.innerHTML = html;
  return doc;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("not-found (MVP assertions)", () => {
  test('metadata: "Page not found", noindex, no canonical', () => {
    expect(metadata.title).toBe("Page not found");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.alternates).toBeUndefined();
  });

  test("renders unchanged: one h1 and a link home, no structured data", () => {
    const { container } = render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Page not found");
    expect(screen.getByRole("link", { name: "Back to the catalog" })).toHaveAttribute("href", "/");
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("not-found v2 static markup (T103)", () => {
  test("exactly one h1 and a short apology", () => {
    const doc = staticDoc();
    const h1s = doc.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0]?.textContent).toBe("Page not found");
    expect(doc.body.textContent).toContain("Sorry, we couldn't find that page.");
  });

  test("exactly one form: GET to /search with a q field (works without JS)", () => {
    const doc = staticDoc();
    const forms = doc.querySelectorAll("form");
    expect(forms.length).toBe(1);
    const form = forms[0];
    if (form === undefined) throw new Error("no form");
    expect(form.getAttribute("method")?.toLowerCase()).toBe("get");
    expect(form.getAttribute("action")).toBe("/search");
    const q = form.querySelector('input[name="q"]');
    expect(q).not.toBeNull();
    expect(q?.getAttribute("maxlength")).toMatch(/^\d+$/);
    // A plain submit button inside the form so Enter/click submit natively.
    expect(form.querySelector('button[type="submit"], input[type="submit"]')).not.toBeNull();
    // The department select joins the same form through the form attribute.
    const dept = doc.querySelector('select[name="dept"]');
    expect(dept?.getAttribute("form")).toBe(form.getAttribute("id"));
    // No hidden server-action fields: this is a plain navigation form.
    expect(doc.querySelector('input[name^="$ACTION"]')).toBeNull();
  });

  test("no <script> and no inline styles", () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("style=");
  });

  test("every href passes isAllowedInternalHref", () => {
    const anchors = [...staticDoc().querySelectorAll("a")];
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      const href = a.getAttribute("href") ?? "";
      expect({ href, ok: isAllowedInternalHref(href) }).toEqual({ href, ok: true });
    }
  });

  test("links to /products, /deals, /best-sellers, /new-arrivals and /help with content labels", () => {
    const doc = staticDoc();
    const nav = doc.querySelector('nav[aria-labelledby="not-found-links-heading"]');
    if (nav === null) throw new Error("no helpful links nav");
    const hrefs = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/products", "/deals", "/best-sellers", "/new-arrivals", "/help"]);
    expect(notFoundLinks().map((l) => l.label)).toEqual([
      "All products",
      "Deals",
      "Best Sellers",
      "New Arrivals",
      "Help",
    ]);
    expect(NOT_FOUND_LINK_HREFS.length).toBe(5);
  });

  test("links every department to /category/<slug> from static content", () => {
    const doc = staticDoc();
    const nav = doc.querySelector('nav[aria-labelledby="not-found-departments-heading"]');
    if (nav === null) throw new Error("no departments nav");
    const hrefs = [...nav.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(DEPARTMENT_NAV.map((d) => `/category/${encodeURIComponent(d.slug)}`));
    expect(notFoundDepartments()).toEqual(DEPARTMENT_NAV.map((d) => ({ slug: d.slug, name: d.label })));
    // The search department select offers the same departments plus "All departments".
    const options = [...doc.querySelectorAll('select[name="dept"] option')].map((o) => o.getAttribute("value"));
    expect(options).toEqual(["", ...DEPARTMENT_NAV.map((d) => d.slug)]);
  });

  test("the search field has its own label, distinct from the header's (CONS-B1 item ay)", () => {
    render(<NotFound />);
    expect(NOT_FOUND_SEARCH_LABEL).not.toBe("Search products");
    expect(screen.getByRole("combobox", { name: NOT_FOUND_SEARCH_LABEL })).toHaveAttribute("name", "q");
    expect(screen.queryByRole("combobox", { name: "Search products" })).toBeNull();
  });

  test("landmark labels on the page are unique and do not collide with header/footer navs", () => {
    const doc = staticDoc();
    const ids = [...doc.querySelectorAll("nav")].map((n) => n.getAttribute("aria-labelledby"));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const label = doc.getElementById(id ?? "")?.textContent;
      expect(["Main", "Shop", "Footer"]).not.toContain(label);
    }
  });

  test("the page's search landmark has its own name, distinct from the header's (D-T113-2 follow-up)", () => {
    // The header renders SearchBox with no landmarkLabel; mirror that next to the page.
    render(
      <>
        <SearchBox departments={notFoundDepartments()} />
        <NotFound />
      </>,
    );
    const names = screen.getAllByRole("search").map((form) => form.getAttribute("aria-label"));
    expect(names).toEqual(["Site search", NOT_FOUND_SEARCH_LABEL]);
    expect(new Set(names).size).toBe(names.length);
    expect(screen.getByRole("search", { name: "Search the store" })).toBeTruthy();
  });

  test("server markup names the page's search landmark (no JS)", () => {
    const form = staticDoc().querySelector("form");
    expect(form?.getAttribute("role")).toBe("search");
    expect(form?.getAttribute("aria-label")).toBe("Search the store");
  });

  test("renders deterministically (no clock, no random values in markup)", () => {
    expect(renderToStaticMarkup(<NotFound />)).toBe(renderToStaticMarkup(<NotFound />));
  });
});

describe("not-found source rules (T103 criteria 2-3)", () => {
  const source = readFileSync(join(APP_DIR, "not-found.tsx"), "utf8");

  test("reads no cookies/headers, touches no database, no clock, no Suspense", () => {
    expect(source).not.toMatch(/next\/headers|@\/server\/session|getDatabase|@\/server\/db\/client/);
    expect(source).not.toMatch(/listing-service|getListingService/);
    expect(source).not.toMatch(/Date\.now|new Date\(|Math\.random/);
    expect(source).not.toMatch(/<Suspense|import[^;]*\bSuspense\b|"use client"|async function/);
  });

  test("no server imports at all: departments come from the navigation content (CONS-B1 item ax)", () => {
    expect(source).not.toMatch(/from "@\/server\//);
    expect(source).toContain("DEPARTMENT_NAV");
  });

  test("no loading.tsx anywhere in the app tree (soft-404 lesson) and no global-not-found", () => {
    const files = walk(APP_DIR).map((f) => relative(APP_DIR, f));
    expect(files.filter((f) => /(^|\/)loading\.(t|j)sx?$/.test(f))).toEqual([]);
    expect(files.filter((f) => /(^|\/)global-not-found\.(t|j)sx?$/.test(f))).toEqual([]);
  });

  test("dynamic routes calling notFound() fall through to this root not-found", () => {
    const files = walk(APP_DIR).map((f) => relative(APP_DIR, f));
    // No segment-level not-found file shadows the root one.
    expect(files.filter((f) => /(^|\/)not-found\.(t|j)sx?$/.test(f))).toEqual(["not-found.tsx"]);
    const callSites = files.filter(
      (f) => /\[[^\]]+\]\/(.+\/)?page\.tsx$/.test(f) && readFileSync(join(APP_DIR, f), "utf8").includes("notFound("),
    );
    expect(callSites.length).toBeGreaterThan(0);
    for (const f of callSites) {
      const text = readFileSync(join(APP_DIR, f), "utf8");
      expect({ f, imports: /import\s*\{[^}]*\bnotFound\b[^}]*\}\s*from\s*"next\/navigation"/.test(text) }).toEqual({
        f,
        imports: true,
      });
    }
  });
});
