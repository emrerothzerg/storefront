/**
 * T102 criterion 3: every footer link (FOOTER_QUICK_LINKS, FOOTER_COLUMNS plus
 * the legal row /privacy, /terms, /accessibility) resolves to an existing
 * `src/app/**\/page.tsx`. Dynamic segments match any `[param]` directory;
 * query strings and `#` fragments are ignored. Routes whose page has not
 * landed yet are listed as `test.todo` with the owning task; once the page
 * exists the todo turns into a real assertion automatically.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { FOOTER_COLUMNS, FOOTER_QUICK_LINKS } from "@/content/navigation";
import { isAllowedInternalHref } from "@/content/routes";

const APP_DIR = join(import.meta.dir, "..");

const LEGAL_ROW: readonly string[] = ["/privacy", "/terms", "/accessibility"];

/** Pages still owned by in-flight tasks (BACKLOG-phase2.md / STATE.md). */
const PENDING_OWNERS: Readonly<Record<string, string>> = {
  "/products": "T107",
  "/deals": "T107",
  "/best-sellers": "T107",
  "/new-arrivals": "T107",
  "/brands": "T106",
  "/compare": "T100",
  "/account": "T98",
  "/account/history": "T98",
  "/orders": "T110",
  "/lists": "T99",
  "/signin": "T127",
  "/account/settings": "T128",
};

function pathOf(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

function isDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** Route groups `(x)` are transparent; private `_x` folders never route. */
function childDirs(dir: string): string[] {
  return readdirSync(dir).filter((name) => !name.startsWith("_") && isDir(join(dir, name)));
}

/** True when some `page.tsx` under `dir` serves `segments`. */
function resolves(dir: string, segments: readonly string[]): boolean {
  const children = childDirs(dir);
  for (const group of children.filter((name) => name.startsWith("(") && name.endsWith(")"))) {
    if (resolves(join(dir, group), segments)) return true;
  }
  if (segments.length === 0) return existsSync(join(dir, "page.tsx"));
  const [head, ...rest] = segments;
  if (head === undefined) return false;
  if (children.includes(head) && resolves(join(dir, head), rest)) return true;
  return children
    .filter((name) => /^\[[^.\]]+\]$/.test(name))
    .some((name) => resolves(join(dir, name), rest));
}

function hrefResolvesToPage(href: string): boolean {
  const path = pathOf(href);
  const segments = path === "/" ? [] : path.slice(1).split("/");
  return resolves(APP_DIR, segments);
}

const footerHrefs = [
  ...new Set([
    ...FOOTER_QUICK_LINKS.map((l) => l.href),
    ...FOOTER_COLUMNS.flatMap((c) => c.links.map((l) => l.href)),
    ...LEGAL_ROW,
  ]),
];

describe("resolver", () => {
  test("maps static, dynamic and fragment hrefs", () => {
    expect(hrefResolvesToPage("/")).toBe(true);
    expect(hrefResolvesToPage("/help/shipping")).toBe(true);
    expect(hrefResolvesToPage("/help/shipping?open=x#x")).toBe(true);
    expect(hrefResolvesToPage("/privacy#what-we-store")).toBe(true);
    expect(hrefResolvesToPage("/products/anything")).toBe(true);
    expect(hrefResolvesToPage("/definitely-not-a-route")).toBe(false);
    expect(hrefResolvesToPage("/_lib")).toBe(false);
  });
});

describe("footer links resolve to pages (T102 criterion 3)", () => {
  test("footer includes the quick links, the legal row and help links", () => {
    for (const href of [...LEGAL_ROW, "/orders", "/help", "/faq", "/contact", "/shipping", "/returns", "/about"]) {
      expect(footerHrefs).toContain(href);
    }
  });

  for (const href of footerHrefs) {
    const owner = PENDING_OWNERS[href];
    if (hrefResolvesToPage(href)) {
      test(`${href} resolves to a page and passes the allowlist`, () => {
        expect(isAllowedInternalHref(href)).toBe(true);
        expect(hrefResolvesToPage(href)).toBe(true);
      });
    } else if (owner !== undefined) {
      test.todo(`${href} (page pending: ${owner})`);
    } else {
      test(`${href} resolves to a page`, () => {
        expect(hrefResolvesToPage(href)).toBe(true);
      });
    }
  }
});
