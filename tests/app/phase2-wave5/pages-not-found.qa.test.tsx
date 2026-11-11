/**
 * T104a — QA wave 5, page-level: root not-found (T103) + route-level checks
 * shared by the five pages (no `loading.tsx`, dynamic rendering). QA-owned.
 * Criteria: T104 1, 7 (+ T103 2–4).
 */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  duplicateFormNames,
  duplicateIds,
  harness,
  headingViolations,
  hrefViolations,
  installNextMocks,
  parseHtml,
  resetCookies,
  smallSubmitButtons,
} from "./_harness";

installNextMocks();

const dbClient = await import("@/server/db/client");
const session = await import("@/server/session/session");
const currentUser = await import("@/server/session/current-user");
const { isAllowedInternalHref } = await import("@/content/routes");
const { default: NotFound, metadata } = await import("@/app/not-found");

const APP_DIR = join(import.meta.dir, "..", "..", "..", "src", "app");

const spies = {
  getDatabase: spyOn(dbClient, "getDatabase"),
  readSessionId: spyOn(session, "readSessionId"),
  getOrCreateSessionId: spyOn(session, "getOrCreateSessionId"),
  readCurrentUser: spyOn(currentUser, "readCurrentUser"),
};

afterEach(() => {
  for (const spy of Object.values(spies)) spy.mockClear();
});

afterAll(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
});

function render(): { html: string; doc: Document } {
  const html = renderToStaticMarkup(<NotFound />);
  return { html, doc: parseHtml(html) };
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

describe("not-found — structure (T103, T104-7)", () => {
  test("one h1, no skipped heading levels, unique ids, labelled landmarks with unique names", () => {
    const { doc } = render();
    expect(headingViolations(doc)).toEqual([]);
    expect(doc.querySelector("h1")?.textContent).toBe("Page not found");
    expect(duplicateIds(doc)).toEqual([]);
    expect(duplicateFormNames(doc)).toEqual([]);
    const navNames = [...doc.querySelectorAll("nav")].map((n) => {
      const by = n.getAttribute("aria-labelledby");
      return n.getAttribute("aria-label") ?? (by === null ? "" : (doc.getElementById(by)?.textContent ?? ""));
    });
    expect(navNames.length).toBeGreaterThan(0);
    expect(navNames.every((n) => n.trim() !== "")).toBe(true);
    expect(new Set(navNames).size).toBe(navNames.length);
    expect(doc.querySelector("main")).toBeNull();
  });

  test("search form: GET to /search with a q field (maxlength set); no POST form at all", () => {
    const { doc } = render();
    const forms = [...doc.querySelectorAll("form")];
    expect(forms.length).toBeGreaterThan(0);
    for (const form of forms) {
      expect((form.getAttribute("method") ?? "get").toLowerCase()).toBe("get");
      expect(form.getAttribute("action")).toBe("/search");
    }
    const q = doc.querySelector<HTMLInputElement>("form[action='/search'] input[name='q']");
    expect(q).not.toBeNull();
    expect(Number(q?.getAttribute("maxlength") ?? q?.getAttribute("maxLength") ?? "0")).toBeGreaterThan(0);
    const labelled =
      (q?.getAttribute("aria-label") ?? "") !== "" ||
      (q?.id !== undefined && q.id !== "" && doc.querySelector(`label[for="${q.id}"]`) !== null) ||
      (q?.getAttribute("aria-labelledby") ?? "") !== "";
    expect(labelled).toBe(true);
    expect(smallSubmitButtons(doc)).toEqual([]);
  });

  test("every link passes isAllowedInternalHref (search + category links present)", () => {
    const { doc } = render();
    expect(hrefViolations(doc, isAllowedInternalHref)).toEqual([]);
    const hrefs = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs).toContain("/");
    expect(hrefs.some((h) => h.startsWith("/category/"))).toBe(true);
  });

  test("metadata noindex, no canonical", () => {
    expect(metadata.robots).toMatchObject({ index: false });
    expect(metadata.alternates?.canonical).toBeUndefined();
  });
});

describe("not-found — no DB, cookie or clock access; deterministic (T103-2)", () => {
  test("no getDatabase, no cookie reads, no session/user lookups, no writes", () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: "garbage", [session.AUTH_COOKIE_NAME]: "z".repeat(43) });
    render();
    expect(spies.getDatabase).not.toHaveBeenCalled();
    expect(spies.readSessionId).not.toHaveBeenCalled();
    expect(spies.getOrCreateSessionId).not.toHaveBeenCalled();
    expect(spies.readCurrentUser).not.toHaveBeenCalled();
    expect(harness.cookieReads).toBe(0);
    expect(harness.store.writes).toEqual([]);
  });

  test("never reads the clock (Date.now, new Date(), performance.now)", () => {
    const RealDate = globalThis.Date;
    let reads = 0;
    class CountingDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        super(...args);
        const argc: number = args.length;
        if (argc === 0) reads += 1;
      }
      static override now(): number {
        reads += 1;
        return RealDate.now();
      }
    }
    const perf = spyOn(performance, "now");
    globalThis.Date = CountingDate as DateConstructor;
    let html = "";
    try {
      html = render().html;
    } finally {
      globalThis.Date = RealDate;
      perf.mockRestore();
    }
    expect(html.length).toBeGreaterThan(0);
    expect(reads).toBe(0);
    expect(perf).not.toHaveBeenCalled();
  });

  test("output is byte-identical across renders and cookie states", () => {
    resetCookies();
    const first = render().html;
    resetCookies({ [session.SESSION_COOKIE_NAME]: "a1a1a1a1-4444-4444-8444-00000000000a" });
    const second = render().html;
    expect(second).toBe(first);
    expect(first).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  test("the component is synchronous (no Suspense/async boundary that could soft-404)", () => {
    const result: unknown = NotFound();
    expect(result instanceof Promise).toBe(false);
  });
});

describe("routes — no loading.tsx, all five pages dynamic (T104-1, SR8)", () => {
  test("no loading.tsx / loading.jsx / loading.js anywhere under src/app (root included)", () => {
    const loading = walk(APP_DIR).filter((f) => /[/\\]loading\.(t|j)sx?$/.test(f));
    expect(loading).toEqual([]);
  });

  const pages: Array<[string, RegExp]> = [
    ["page.tsx", /await connection\(\)/],
    ["products/[slug]/page.tsx", /await connection\(\)/],
    ["compare/page.tsx", /await connection\(\)/],
    ["lists/page.tsx", /await searchParams|readSessionId\(\)/],
    ["lists/[id]/page.tsx", /await searchParams|readSessionId\(\)/],
    ["lists/shared/[token]/page.tsx", /await searchParams/],
  ];

  test.each(pages)("%s uses a request-time API and never opts into static rendering", (file, dynamicApi) => {
    const src = readFileSync(join(APP_DIR, file), "utf8");
    expect(src).toMatch(dynamicApi);
    expect(src).not.toMatch(/export\s+const\s+(dynamic\s*=\s*["']force-static|revalidate\s*=)/);
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+generateStaticParams/);
    expect(src).not.toMatch(/["']use cache["']/);
  });
});
